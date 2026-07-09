import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type {
  AiAnalysis,
  AiModelAssets,
  AiProgress,
  AiSettings,
  DuplicateGroup,
  DuplicateReviewStatus,
  PhotoGroup,
  ProBatchResponse,
  ProHeadScores,
  ProInferCapabilities,
} from '../types';
import { AI_MODEL_VERSION, DEFAULT_AI_SETTINGS } from '../utils/aiLabels';
import { buildAiCacheKey, normalizeAiSettings } from '../utils/aiCore';
import { prepareAnalysisImage } from '../utils/aiImage';
import { chooseAiCullingConcurrency, chooseAiPreparationConcurrency } from '../utils/concurrency';
import { classifyDuplicateGroups, duplicatePhotoIds } from '../utils/duplicateDetection';
import { readStorage } from '../utils/storage';
import AiAnalyzerWorker from '../workers/aiAnalyzer.worker.ts?worker';
import { IS_PRO_EDITION } from '../utils/appInfo';
import { ensureProInfer, getProInferManifestPath, proInferBatch } from '../utils/proInfer';
import { rebuildPhotoScoreWithNativeAesthetic } from '../utils/photoScoring';

const SETTINGS_KEY = 'framecull-ai-settings';
const CACHE_KEY = 'framecull-ai-cache-v2';
const MAX_CACHE_ENTRIES = 1200;
const MAX_CACHE_CHARS = 3_000_000;
const AI_PROGRESS_INTERVAL_MS = 120;
const AI_CACHE_SAVE_BATCH_SIZE = 12;
const PRO_NATIVE_ACCELERATED_BATCH_SIZE = 8;
const PRO_NATIVE_CPU_BATCH_SIZE = 1;
const PRO_NATIVE_BATCH_FLUSH_MS = 60;
const PRO_NATIVE_BATCH_TIMEOUT_MS = 30_000;
const PRO_NATIVE_DRAIN_TIMEOUT_MS = 30_000;

type WorkerResponse = {
  type: 'result' | 'error';
  id: string;
  analysis?: AiAnalysis;
  error?: string;
};

export function useAiCulling(
  photos: PhotoGroup[],
  onAnalysis: (photoId: string, analysis: AiAnalysis) => void,
) {
  const [settings, setSettingsState] = useState<AiSettings>(() => loadSettings());
  const [progress, setProgress] = useState<AiProgress>({
    total: 0,
    processed: 0,
    running: false,
    paused: false,
  });
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [duplicateStatus, setDuplicateStatus] = useState<DuplicateReviewStatus>('IDLE');

  const workersRef = useRef<Worker[]>([]);
  const abortRef = useRef(false);
  const pausedRef = useRef(false);
  const startedAtRef = useRef<number | undefined>(undefined);
  const pauseStartedAtRef = useRef<number | undefined>(undefined);
  const pausedTotalMsRef = useRef(0);
  const modelAssetsRef = useRef<AiModelAssets | null>(null);
  const modelAssetsPromiseRef = useRef<Promise<AiModelAssets> | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      terminateWorkers(workersRef.current);
      workersRef.current = [];
      revokeObjectUrls(objectUrlsRef.current);
      objectUrlsRef.current = [];
      modelAssetsRef.current = null;
      modelAssetsPromiseRef.current = null;
    };
  }, []);

  const setSettings = useCallback((next: AiSettings) => {
    const normalized = normalizeAiSettings(next);
    setSettingsState(normalized);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  }, []);

  const start = useCallback(async () => {
    if (progress.running || photos.length === 0) return;

    abortRef.current = false;
    pausedRef.current = false;
    setDuplicateGroups([]);
    setDuplicateStatus(runDuplicateDetectionEnabled(settings) ? 'ANALYZING' : 'DISABLED');
    pausedTotalMsRef.current = 0;
    pauseStartedAtRef.current = undefined;
    startedAtRef.current = Date.now();
    setProgress({
      total: photos.length,
      processed: 0,
      running: true,
      paused: false,
      phase: 'AI_ENGINE_INIT',
      startedAt: startedAtRef.current,
      elapsedMs: 0,
      pausedTotalMs: 0,
    });

    const runPhotos = [...photos];
    const runSettings = settings;
    const cache = loadCache();
    const modelAssets = await ensureModelAssets(modelAssetsRef, modelAssetsPromiseRef, objectUrlsRef);
    // Pro edition only: warm up the native ONNX inference layer so the aesthetic
    // head comes from the native session instead of wasm NIMA. Flash never
    // touches this; the wasm worker path is unchanged either way.
    const proInferCapabilities = IS_PRO_EDITION ? await ensureProInfer() : null;
    const nativeProScoreQueue = proInferCapabilities
      ? createNativeProScoreQueue(proInferCapabilities)
      : null;
    const proScoreTasks: Promise<void>[] = [];
    const runStartedAt = startedAtRef.current;
    const isCurrentRunActive = () => startedAtRef.current === runStartedAt && !abortRef.current;
    setProgress(prev => ({
      ...prev,
      phase: 'AI_ANALYSIS',
      elapsedMs: computeElapsedMs(startedAtRef.current, pausedTotalMsRef.current),
      pausedTotalMs: pausedTotalMsRef.current,
    }));
    const workers = getWorkerPool(workersRef, Math.min(runPhotos.length, chooseAiCullingConcurrency()));
    const prepareGate = createAsyncGate(chooseAiPreparationConcurrency());
    const activeIds: string[] = [];
    let nextIndex = 0;
    let processed = 0;
    let cacheDirtyCount = 0;
    let lastProgressAt = 0;

    const publishProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt < AI_PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      setProgress(prev => ({
        ...prev,
        total: runPhotos.length,
        processed,
        activeId: activeIds[activeIds.length - 1],
        paused: pausedRef.current,
        elapsedMs: computeElapsedMs(startedAtRef.current, pausedTotalMsRef.current),
        pausedTotalMs: pausedTotalMsRef.current,
      }));
    };

    const saveDirtyCache = (force = false) => {
      if (cacheDirtyCount <= 0) return;
      if (!force && cacheDirtyCount < AI_CACHE_SAVE_BATCH_SIZE) return;
      saveCache(cache);
      cacheDirtyCount = 0;
    };

    const waitIfPaused = async () => {
      while (pausedRef.current && !abortRef.current) {
        publishProgress(true);
        await wait(150);
      }
    };

    const runWorker = async (worker: Worker) => {
      while (!abortRef.current) {
        await waitIfPaused();
        if (abortRef.current) return;

        const index = nextIndex;
        nextIndex += 1;
        if (index >= runPhotos.length) return;

        const group = runPhotos[index];
        const cacheKey = buildAiCacheKey(group, runSettings);
        const cached = cache[cacheKey];
        activeIds.push(group.id);
        publishProgress();

        try {
          if (cached) {
            onAnalysis(group.id, { ...cached, reviewed: group.ai?.reviewed ?? false });
            continue;
          }

          onAnalysis(group.id, {
            status: 'ANALYZING',
            issues: [],
            confidence: 0,
            preset: runSettings.sensitivity,
            reviewed: group.ai?.reviewed ?? false,
            modelVersion: AI_MODEL_VERSION,
          });

          const imageData = await prepareGate(() => prepareAnalysisImage(group));
          if (abortRef.current) return;
          const analysis = await analyzeWithWorker(worker, group.id, imageData, runSettings, modelAssets);
          const baseAnalysis: AiAnalysis = {
            ...analysis,
            reviewed: group.ai?.reviewed ?? false,
          };
          onAnalysis(group.id, baseAnalysis);
          cache[cacheKey] = { ...baseAnalysis, reviewed: false };
          cacheDirtyCount += 1;
          saveDirtyCache();

          // Pro edition: enqueue native ONNX scoring without blocking the wasm
          // worker lane. The final pick still waits for this queue before
          // duplicate grouping, but workers can keep analyzing the next photo.
          if (nativeProScoreQueue && analysis.status === 'DONE') {
            const proScoreTask = nativeProScoreQueue.score(group)
              .then(nativeScores => {
                if (!nativeScores || !isCurrentRunActive()) return;
                const mergedAnalysis: AiAnalysis = {
                  ...baseAnalysis,
                  proScores: nativeScores,
                  photoScore: typeof nativeScores.aesthetic === 'number'
                    ? rebuildPhotoScoreWithNativeAesthetic(analysis, nativeScores.aesthetic)
                    : baseAnalysis.photoScore,
                };
                onAnalysis(group.id, mergedAnalysis);
                cache[cacheKey] = { ...mergedAnalysis, reviewed: false };
                cacheDirtyCount += 1;
                saveDirtyCache();
              })
              .catch(() => undefined);
            proScoreTasks.push(proScoreTask);
          }
        } catch (error) {
          onAnalysis(group.id, {
            status: 'ERROR',
            issues: [],
            confidence: 0,
            preset: runSettings.sensitivity,
            reviewed: group.ai?.reviewed ?? false,
            modelVersion: AI_MODEL_VERSION,
            analyzedAt: Date.now(),
            error: error instanceof Error ? error.message : 'AI analysis failed.',
          });
        } finally {
          const activeIndex = activeIds.indexOf(group.id);
          if (activeIndex >= 0) activeIds.splice(activeIndex, 1);
          processed += 1;
          publishProgress(processed === runPhotos.length);
        }
      }
    };

    await Promise.all(workers.map(worker => runWorker(worker)));

    if (!abortRef.current && proScoreTasks.length > 0) {
      setProgress(prev => ({
        ...prev,
        phase: 'PRO_MODEL_SCORING',
        activeId: undefined,
        elapsedMs: computeElapsedMs(startedAtRef.current, pausedTotalMsRef.current),
        pausedTotalMs: pausedTotalMsRef.current,
      }));
      const drained = await withTimeout(
        (async () => {
          await nativeProScoreQueue?.drain();
          await Promise.allSettled(proScoreTasks);
          return true;
        })(),
        PRO_NATIVE_DRAIN_TIMEOUT_MS,
      );
      if (!drained) {
        nativeProScoreQueue?.cancelPending();
      }
    }
    saveDirtyCache(true);

    if (!abortRef.current && runDuplicateDetectionEnabled(runSettings)) {
      setProgress(prev => ({
        ...prev,
        phase: 'DUPLICATE_GROUPING',
        activeId: undefined,
      }));
      await wait(0);
      const analysisById = new Map<string, AiAnalysis>();
      runPhotos.forEach(photo => {
        const cacheKey = buildAiCacheKey(photo, runSettings);
        const analysis = cache[cacheKey] ?? photo.ai;
        if (analysis) analysisById.set(photo.id, analysis);
      });
      const analyzedPhotos = runPhotos.map(photo => ({
        ...photo,
        ai: analysisById.get(photo.id) ?? photo.ai,
      }));
      const groups = classifyDuplicateGroups(
        analyzedPhotos,
        runSettings.duplicateSensitivity,
        runSettings.duplicateAlwaysRecommendOne,
      );
      setDuplicateGroups(groups);
      setDuplicateStatus('READY');
    } else if (runSettings.duplicateSensitivity === 'off') {
      setDuplicateGroups([]);
      setDuplicateStatus('DISABLED');
    } else if (abortRef.current) {
      setDuplicateGroups([]);
      setDuplicateStatus('IDLE');
    }

    setProgress(prev => ({
      ...prev,
      running: false,
      paused: false,
      activeId: undefined,
      phase: undefined,
      processed,
      elapsedMs: computeElapsedMs(startedAtRef.current, pausedTotalMsRef.current),
      pausedTotalMs: pausedTotalMsRef.current,
    }));
    pausedRef.current = false;
    abortRef.current = false;
    startedAtRef.current = undefined;
    pauseStartedAtRef.current = undefined;
  }, [onAnalysis, photos, progress.running, settings]);

  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    pauseStartedAtRef.current = Date.now();
    setProgress(prev => ({
      ...prev,
      paused: true,
      elapsedMs: computeElapsedMs(startedAtRef.current, pausedTotalMsRef.current),
      pausedTotalMs: pausedTotalMsRef.current,
    }));
  }, []);

  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    if (pauseStartedAtRef.current !== undefined) {
      pausedTotalMsRef.current += Date.now() - pauseStartedAtRef.current;
    }
    pauseStartedAtRef.current = undefined;
    pausedRef.current = false;
    setProgress(prev => ({
      ...prev,
      paused: false,
      elapsedMs: computeElapsedMs(startedAtRef.current, pausedTotalMsRef.current),
      pausedTotalMs: pausedTotalMsRef.current,
    }));
  }, []);

  const stop = useCallback(() => {
    abortRef.current = true;
    if (pausedRef.current && pauseStartedAtRef.current !== undefined) {
      pausedTotalMsRef.current += Date.now() - pauseStartedAtRef.current;
    }
    pausedRef.current = false;
    pauseStartedAtRef.current = undefined;
    setProgress(prev => ({
      ...prev,
      running: false,
      paused: false,
      activeId: undefined,
      phase: undefined,
      elapsedMs: computeElapsedMs(startedAtRef.current, pausedTotalMsRef.current),
      pausedTotalMs: pausedTotalMsRef.current,
    }));
    setDuplicateGroups([]);
    setDuplicateStatus(runDuplicateDetectionEnabled(settings) ? 'IDLE' : 'DISABLED');
    startedAtRef.current = undefined;
  }, [settings]);

  const reviewCount = useMemo(
    () => photos.filter(photo => (photo.ai?.issues.length ?? 0) > 0 && !photo.ai?.reviewed).length,
    [photos],
  );
  const duplicateIdSet = useMemo(() => duplicatePhotoIds(duplicateGroups), [duplicateGroups]);

  return {
    settings,
    setSettings,
    progress,
    reviewCount,
    duplicateGroups,
    duplicateStatus,
    duplicatePhotoIds: duplicateIdSet,
    start,
    pause,
    resume,
    stop,
  };
}

function runDuplicateDetectionEnabled(settings: AiSettings) {
  return settings.duplicateSensitivity !== 'off';
}

type NativeProScoreRequest = {
  path: string;
  resolve: (scores: NonNullable<AiAnalysis['proScores']> | null) => void;
};

function createNativeProScoreQueue(capabilities: ProInferCapabilities) {
  const batchSize = capabilities.activeEp === 'cpu'
    ? PRO_NATIVE_CPU_BATCH_SIZE
    : PRO_NATIVE_ACCELERATED_BATCH_SIZE;
  let pending: NativeProScoreRequest[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushChain = Promise.resolve();
  let cancelled = false;

  const clearScheduledFlush = () => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, PRO_NATIVE_BATCH_FLUSH_MS);
  };

  const flush = async () => {
    if (pending.length === 0) {
      await flushChain;
      return;
    }
    const items = pending.splice(0, batchSize);
    flushChain = flushChain.then(() => (
      cancelled ? resolveNativeProScoreBatchAsNull(items) : runNativeProScoreBatch(items, batchSize)
    ));
    await flushChain;
    if (!cancelled && pending.length > 0) scheduleFlush();
  };

  return {
    async score(group: PhotoGroup): Promise<NonNullable<AiAnalysis['proScores']> | null> {
      const path = group.jpg?.path ?? group.raw?.path;
      if (!path || cancelled) return null;
      return new Promise(resolve => {
        pending.push({ path, resolve });
        if (pending.length >= batchSize) {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
          }
          void flush();
        } else {
          scheduleFlush();
        }
      });
    },
    async drain() {
      clearScheduledFlush();
      while (pending.length > 0) {
        clearScheduledFlush();
        await flush();
      }
      clearScheduledFlush();
      await flushChain;
    },
    cancelPending() {
      cancelled = true;
      clearScheduledFlush();
      resolveNativeProScoreBatchAsNull(pending.splice(0));
    },
  };
}

function resolveNativeProScoreBatchAsNull(items: NativeProScoreRequest[]) {
  items.forEach(item => item.resolve(null));
}

async function runNativeProScoreBatch(items: NativeProScoreRequest[], batchSize: number) {
  try {
    const response = await withTimeout(
      proInferBatch(items.map(item => item.path), batchSize),
      PRO_NATIVE_BATCH_TIMEOUT_MS,
    );
    const rowsByPath = new Map<string, ProHeadScores>();
    response?.results?.forEach(row => rowsByPath.set(row.imagePath, row));
    items.forEach((item, index) => {
      const row = rowsByPath.get(item.path) ?? response?.results?.[index];
      item.resolve(nativeRowToProScores(row, response));
    });
  } catch {
    items.forEach(item => item.resolve(null));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function nativeRowToProScores(
  row: ProHeadScores | undefined,
  response: ProBatchResponse | null,
): NonNullable<AiAnalysis['proScores']> | null {
  if (!row || row.error) return null;
  return {
    manifestPath: getProInferManifestPath() ?? undefined,
    activeEp: response?.ep,
    elapsedMs: response?.elapsedMs,
    aesthetic: typeof row.aesthetic === 'number' ? row.aesthetic : undefined,
    sceneLabel: row.sceneLabel,
    sceneConfidence: typeof row.sceneConfidence === 'number' ? row.sceneConfidence : undefined,
    personaScore: typeof row.personaScore === 'number' ? row.personaScore : undefined,
    semanticKeepScore: typeof row.semanticKeepScore === 'number' ? row.semanticKeepScore : undefined,
    faceValidityScore: typeof row.faceValidityScore === 'number' ? row.faceValidityScore : undefined,
    compositionScore: typeof row.compositionScore === 'number' ? row.compositionScore : undefined,
    momentScore: typeof row.momentScore === 'number' ? row.momentScore : undefined,
    lightingMoodScore: typeof row.lightingMoodScore === 'number' ? row.lightingMoodScore : undefined,
    falseFaceRisk: typeof row.falseFaceRisk === 'number' ? row.falseFaceRisk : undefined,
  };
}

function computeElapsedMs(startedAt: number | undefined, pausedTotalMs: number) {
  if (startedAt === undefined) return 0;
  return Math.max(0, Date.now() - startedAt - pausedTotalMs);
}

function getWorkerPool(workersRef: MutableRefObject<Worker[]>, count: number) {
  while (workersRef.current.length < count) {
    workersRef.current.push(new AiAnalyzerWorker());
  }
  while (workersRef.current.length > count) {
    workersRef.current.pop()?.terminate();
  }
  return workersRef.current;
}

function terminateWorkers(workers: Worker[]) {
  workers.forEach(worker => worker.terminate());
}

function createAsyncGate(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const maxActive = Math.max(1, Math.floor(limit));

  const release = () => {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  };

  return async function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxActive) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function analyzeWithWorker(
  worker: Worker,
  photoId: string,
  imageData: ImageData,
  settings: AiSettings,
  modelAssets: AiModelAssets
): Promise<AiAnalysis> {
  const requestId = `${photoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== requestId) return;
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);

      if (event.data.type === 'result' && event.data.analysis) {
        resolve(event.data.analysis);
      } else {
        reject(new Error(event.data.error || 'AI worker failed.'));
      }
    };

    const handleError = (error: ErrorEvent) => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(error.error || new Error(error.message));
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError, { once: true });
    worker.postMessage({ type: 'analyze', id: requestId, imageData, settings, modelAssets }, [imageData.data.buffer]);
  });
}

async function ensureModelAssets(
  modelAssetsRef: MutableRefObject<AiModelAssets | null>,
  modelAssetsPromiseRef: MutableRefObject<Promise<AiModelAssets> | null>,
  objectUrlsRef: MutableRefObject<string[]>
) {
  if (modelAssetsRef.current) return modelAssetsRef.current;
  if (!modelAssetsPromiseRef.current) {
    modelAssetsPromiseRef.current = buildModelAssets(objectUrlsRef).then(assets => {
      modelAssetsRef.current = assets;
      return assets;
    });
  }
  return modelAssetsPromiseRef.current;
}

async function buildModelAssets(objectUrlsRef: MutableRefObject<string[]>) {
  const candidates = {
    wasmBaseCandidates: collectCandidateUrls([
      './models/mediapipe/wasm',
      '/models/mediapipe/wasm',
    ]),
    wasmModuleLoaderCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_module_internal.js',
      '/models/mediapipe/wasm/vision_wasm_module_internal.js',
    ]),
    wasmModuleBinaryCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_module_internal.wasm',
      '/models/mediapipe/wasm/vision_wasm_module_internal.wasm',
    ]),
    wasmLoaderCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_internal.js',
      '/models/mediapipe/wasm/vision_wasm_internal.js',
    ]),
    wasmBinaryCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_internal.wasm',
      '/models/mediapipe/wasm/vision_wasm_internal.wasm',
    ]),
    wasmNoSimdLoaderCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_nosimd_internal.js',
      '/models/mediapipe/wasm/vision_wasm_nosimd_internal.js',
    ]),
    wasmNoSimdBinaryCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
      '/models/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
    ]),
    modelAssetCandidates: collectCandidateUrls([
      './models/mediapipe/face_landmarker/face_landmarker.task',
      '/models/mediapipe/face_landmarker/face_landmarker.task',
    ]),
    faceDetectorAssetCandidates: collectCandidateUrls([
      './models/mediapipe/face_detector/blaze_face_short_range.tflite',
      '/models/mediapipe/face_detector/blaze_face_short_range.tflite',
    ]),
    yunetAssetCandidates: collectCandidateUrls([
      './models/opencv/yunet/face_detection_yunet_2023mar.onnx',
      '/models/opencv/yunet/face_detection_yunet_2023mar.onnx',
    ]),
    aestheticModelAssetCandidates: collectCandidateUrls([
      './models/aesthetic/nima_mobilenet.onnx',
      '/models/aesthetic/nima_mobilenet.onnx',
    ]),
    onnxWasmBaseCandidates: collectCandidateUrls([
      './models/onnxruntime/',
      '/models/onnxruntime/',
    ]),
  };

  const [wasmModuleLoaderBlob, wasmModuleBinaryBlob, modelBlob, faceDetectorBlob, yunetBlob, aestheticBlob] = await Promise.all([
    fetchBlobCandidate(candidates.wasmModuleLoaderCandidates, 'text/javascript', objectUrlsRef),
    fetchBlobCandidate(candidates.wasmModuleBinaryCandidates, 'application/wasm', objectUrlsRef),
    fetchBlobCandidate(candidates.modelAssetCandidates, 'application/octet-stream', objectUrlsRef),
    fetchBlobCandidate(candidates.faceDetectorAssetCandidates, 'application/octet-stream', objectUrlsRef),
    fetchBlobCandidate(candidates.yunetAssetCandidates, 'application/octet-stream', objectUrlsRef),
    fetchBlobCandidate(candidates.aestheticModelAssetCandidates, 'application/octet-stream', objectUrlsRef),
  ]);

  return {
    wasmBaseCandidates: candidates.wasmBaseCandidates,
    wasmModuleLoaderCandidates: wasmModuleLoaderBlob
      ? [...candidates.wasmModuleLoaderCandidates, wasmModuleLoaderBlob]
      : candidates.wasmModuleLoaderCandidates,
    wasmModuleBinaryCandidates: wasmModuleBinaryBlob
      ? [...candidates.wasmModuleBinaryCandidates, wasmModuleBinaryBlob]
      : candidates.wasmModuleBinaryCandidates,
    wasmLoaderCandidates: candidates.wasmLoaderCandidates,
    wasmBinaryCandidates: candidates.wasmBinaryCandidates,
    wasmNoSimdLoaderCandidates: candidates.wasmNoSimdLoaderCandidates,
    wasmNoSimdBinaryCandidates: candidates.wasmNoSimdBinaryCandidates,
    modelAssetCandidates: modelBlob ? [modelBlob, ...candidates.modelAssetCandidates] : candidates.modelAssetCandidates,
    faceDetectorAssetCandidates: faceDetectorBlob
      ? [faceDetectorBlob, ...candidates.faceDetectorAssetCandidates]
      : candidates.faceDetectorAssetCandidates,
    yunetAssetCandidates: yunetBlob
      ? [yunetBlob, ...candidates.yunetAssetCandidates]
      : candidates.yunetAssetCandidates,
    aestheticModelAssetCandidates: aestheticBlob
      ? [aestheticBlob, ...candidates.aestheticModelAssetCandidates]
      : candidates.aestheticModelAssetCandidates,
    onnxWasmBaseCandidates: candidates.onnxWasmBaseCandidates,
  } satisfies AiModelAssets;
}

function collectCandidateUrls(paths: string[]) {
  const urls = paths.flatMap(path => {
    const values = [path];
    try {
      values.push(new URL(path, window.location.href).toString());
    } catch {
      // ignore URL construction errors and keep the raw path candidate
    }
    return values;
  });
  return Array.from(new Set(urls.filter(Boolean)));
}

async function fetchBlobCandidate(
  candidates: string[],
  mimeType: string,
  objectUrlsRef: MutableRefObject<string[]>
) {
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);
      if (!response.ok) continue;
      const bytes = await response.arrayBuffer();
      const blob = new Blob([bytes], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      objectUrlsRef.current.push(objectUrl);
      return objectUrl;
    } catch {
      // keep trying additional candidates
    }
  }
  return null;
}

function revokeObjectUrls(urls: string[]) {
  urls.forEach(url => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  });
}

function loadSettings(): AiSettings {
  try {
    const raw = readStorage(SETTINGS_KEY);
    if (!raw) return DEFAULT_AI_SETTINGS;
    return normalizeAiSettings(JSON.parse(raw) as Partial<AiSettings>);
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

function loadCache(): Record<string, AiAnalysis> {
  try {
    return JSON.parse(readStorage(CACHE_KEY) || '{}') as Record<string, AiAnalysis>;
  } catch {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // ignore cache cleanup errors
    }
    return {};
  }
}

function saveCache(cache: Record<string, AiAnalysis>) {
  let entries = Object.entries(cache).slice(-MAX_CACHE_ENTRIES);

  while (entries.length > 0) {
    const compacted = Object.fromEntries(entries);
    const serialized = JSON.stringify(compacted);
    if (serialized.length <= MAX_CACHE_CHARS) {
      try {
        localStorage.setItem(CACHE_KEY, serialized);
        return;
      } catch (error) {
        if (!isStorageQuotaError(error)) return;
      }
    }
    entries = entries.slice(Math.max(1, Math.ceil(entries.length * 0.25)));
  }

  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore cache cleanup errors
  }
}

function isStorageQuotaError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
