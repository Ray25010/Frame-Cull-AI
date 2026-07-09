import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import type { ExportStreamEvent, PeopleExportClusterInput, PeopleSplitState, PersonCluster, PersonFaceEmbedding, PhotoGroup } from '../types';
import { prepareAnalysisImage } from '../utils/aiImage';
import { choosePeopleSplitConcurrency, choosePeopleSplitPreparationConcurrency } from '../utils/concurrency';
import { clusterPeopleFaces, createClusterFromFace, mergePeopleClusters, moveFaceToCluster, nextPersonClusterId, PEOPLE_SPLIT_MODEL_VERSION } from '../utils/peopleSplit';
import { hasTauriRuntime } from '../utils/tauriRuntime';
import PeopleSplitWorker from '../workers/peopleSplit.worker.ts?worker';

const PEOPLE_SPLIT_ANALYSIS_MAX_EDGE = 1280;
const PEOPLE_SPLIT_CACHE_LIMIT = 1600;
const PEOPLE_SPLIT_PROGRESS_INTERVAL_MS = 120;
const PEOPLE_SPLIT_PHOTO_TIMEOUT_MS = 30000;
const PEOPLE_SPLIT_PREPARE_TIMEOUT_MS = 15000;
const PEOPLE_SPLIT_FEATURE_STALL_TIMEOUT_MS = 15000;
const PEOPLE_SPLIT_DEFAULT_WORKER_RECYCLE_PHOTOS = 96;

type WorkerResponse = {
  type: 'result' | 'error' | 'progress';
  id: string;
  faces?: PersonFaceEmbedding[];
  error?: string;
  stage?: string;
};

type PeopleSplitAnalysisOptions = {
  disableSFace?: boolean;
};

type InitialPeopleFaceBox = PersonFaceEmbedding['boundingBox'] & {
  confidence?: number;
  landmarkerStatus?: PersonFaceEmbedding['landmarkerStatus'];
};

type ActivePeopleTask = {
  file: string;
  stage: string;
  startedAt: number;
  updatedAt: number;
};

const IDLE_STATE: PeopleSplitState = {
  status: 'IDLE',
  processedPhotos: 0,
  totalPhotos: 0,
  clusters: [],
  faces: [],
  unassignedFaces: [],
  selectedClusterIds: [],
  modelVersion: PEOPLE_SPLIT_MODEL_VERSION,
};

export function usePeopleSplit(
  photos: PhotoGroup[],
  options: { aiCullingRunning?: boolean } = {},
) {
  const [state, setState] = useState<PeopleSplitState>(IDLE_STATE);
  const workersRef = useRef<Worker[]>([]);
  const cacheRef = useRef(new Map<string, PersonFaceEmbedding[]>());
  const abortRef = useRef(false);
  const runningRef = useRef(false);
  const aiCullingRunningRef = useRef(Boolean(options.aiCullingRunning));

  useEffect(() => {
    aiCullingRunningRef.current = Boolean(options.aiCullingRunning);
  }, [options.aiCullingRunning]);

  useEffect(() => {
    return () => {
      terminateWorkers(workersRef.current);
      workersRef.current = [];
    };
  }, []);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    if (photos.length === 0) {
      setState(prev => ({
        ...prev,
        status: 'ERROR',
        error: 'No photos imported.',
      }));
      return;
    }

    runningRef.current = true;
    abortRef.current = false;

    try {
      const startedAt = Date.now();
      setState(prev => ({
        ...prev,
        status: 'RUNNING',
        processedPhotos: 0,
        totalPhotos: photos.length,
        error: undefined,
        faces: [],
        clusters: [],
        unassignedFaces: [],
        currentPhotoId: undefined,
        currentFile: undefined,
        currentStage: undefined,
        startedAt,
        elapsedMs: 0,
        lastRunAt: Date.now(),
        modelVersion: PEOPLE_SPLIT_MODEL_VERSION,
      }));

      const runPhotos = [...photos];
      const workload = summarizePeopleSplitWorkload(runPhotos);
      const workers = getWorkerPool(
        workersRef,
        choosePeopleSplitConcurrency(aiCullingRunningRef.current),
      );
      const prepareGate = createAsyncGate(Math.min(
        choosePeopleSplitPreparationConcurrency(aiCullingRunningRef.current),
        workload.prepareCap,
      ));
      const allFaces: PersonFaceEmbedding[] = [];
      const failures: string[] = [];
      const activeTasks = new Map<string, ActivePeopleTask>();
      let nextIndex = 0;
      let completedPhotos = 0;
      let lastProgressAt = 0;

      const reportProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < PEOPLE_SPLIT_PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        const activeTask = selectVisibleActiveTask(activeTasks);
        setState(prev => ({
          ...prev,
          processedPhotos: completedPhotos,
          currentPhotoId: activeTask?.id,
          currentFile: activeTask?.task.file,
          currentStage: activeTask?.task.stage,
          elapsedMs: Math.max(0, now - startedAt),
        }));
      };

      const progressTimer = window.setInterval(() => reportProgress(true), 1000);
      const setActiveStage = (photoId: string, stage: string) => {
        const task = activeTasks.get(photoId);
        if (!task) return;
        activeTasks.set(photoId, {
          ...task,
          stage,
          updatedAt: Date.now(),
        });
        reportProgress(true);
      };

      const runWorker = async (initialWorker: Worker) => {
        let worker = initialWorker;
        let processedByWorker = 0;
        while (!abortRef.current) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= runPhotos.length) return;

          const photo = runPhotos[index];
          const fileLabel = peoplePhotoLabel(photo);
          activeTasks.set(photo.id, {
            file: fileLabel,
            stage: '读取图片',
            startedAt: Date.now(),
            updatedAt: Date.now(),
          });
          reportProgress(true);
          try {
            const faces = await analyzePhotoWithCache(worker, photo, cacheRef.current, prepareGate, stage => {
              setActiveStage(photo.id, stage);
            });
            setActiveStage(photo.id, `写入结果 ${faces.length} 张人脸`);
            await appendPeopleFaces(allFaces, faces);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isPeopleSplitWorkerTimeout(error)) {
              const replacement = new PeopleSplitWorker();
              const poolIndex = workersRef.current.indexOf(worker);
              if (poolIndex >= 0) {
                workersRef.current[poolIndex] = replacement;
              }
              worker.terminate();
              worker = replacement;
              try {
                setActiveStage(photo.id, '特征兜底重试');
                const retryFaces = await analyzePhotoWithCache(worker, photo, cacheRef.current, prepareGate, stage => {
                  setActiveStage(photo.id, `兜底 ${stage}`);
                }, { disableSFace: true });
                setActiveStage(photo.id, `写入结果 ${retryFaces.length} 张人脸`);
                await appendPeopleFaces(allFaces, retryFaces);
              } catch (retryError) {
                const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                failures.push(`${fileLabel}: ${firstLine(message)}；兜底重试失败：${firstLine(retryMessage)}`);
                console.warn(`People split fallback retry failed for ${fileLabel}:`, retryError);
              }
            } else {
              failures.push(`${fileLabel}: ${firstLine(message)}`);
              console.warn(`People split analysis failed for ${fileLabel}:`, error);
            }
          } finally {
            activeTasks.delete(photo.id);
            completedPhotos += 1;
            processedByWorker += 1;
            reportProgress(completedPhotos === runPhotos.length);
            if (completedPhotos % 4 === 0) await waitForUi();
            if (
              !abortRef.current
              && processedByWorker >= workload.recyclePhotos
              && nextIndex < runPhotos.length
            ) {
              const replacement = new PeopleSplitWorker();
              const poolIndex = workersRef.current.indexOf(worker);
              if (poolIndex >= 0) {
                workersRef.current[poolIndex] = replacement;
              }
              worker.terminate();
              worker = replacement;
              processedByWorker = 0;
              await waitForUi();
            }
          }
        }
      };

      try {
        await Promise.all(workers.map(worker => runWorker(worker)));
        reportProgress(true);
      } finally {
        window.clearInterval(progressTimer);
      }

      if (abortRef.current) {
        setState(prev => ({
          ...prev,
          status: 'STOPPED',
          processedPhotos: completedPhotos,
          currentPhotoId: undefined,
          currentFile: undefined,
          currentStage: undefined,
          faces: allFaces,
          elapsedMs: Math.max(0, Date.now() - startedAt),
        }));
        return;
      }

      setState(prev => ({
        ...prev,
        processedPhotos: completedPhotos,
        currentPhotoId: undefined,
        currentFile: undefined,
        currentStage: '生成分组',
        elapsedMs: Math.max(0, Date.now() - startedAt),
      }));
      await waitForUi();

      const clustered = await clusterPeopleFacesInWorker(workers[0], allFaces, (stage) => {
        setState(prev => ({
          ...prev,
          currentStage: stage,
          elapsedMs: Math.max(0, Date.now() - startedAt),
        }));
      });
      const summaryError = failures.length > 0
        ? `有 ${failures.length} 张照片分析失败，请重试或查看失败项：${failures.slice(0, 3).join(' / ')}`
        : undefined;

      setState(prev => ({
        ...prev,
        status: allFaces.length === 0 && failures.length > 0 ? 'ERROR' : 'DONE',
        processedPhotos: runPhotos.length,
        totalPhotos: runPhotos.length,
        faces: clustered.faces,
        clusters: clustered.clusters,
        unassignedFaces: clustered.unassignedFaces,
        selectedClusterIds: clustered.clusters.slice(0, 1).map(cluster => cluster.id),
        currentPhotoId: undefined,
        currentFile: undefined,
        currentStage: undefined,
        error: summaryError,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        lastRunAt: Date.now(),
        modelVersion: PEOPLE_SPLIT_MODEL_VERSION,
      }));
      trimPeopleSplitCache(cacheRef.current);
    } finally {
      runningRef.current = false;
    }
  }, [photos]);

  const stop = useCallback(() => {
    abortRef.current = true;
  }, []);

  const renameCluster = useCallback((clusterId: string, displayName: string) => {
    const nextName = displayName.trim();
    if (!nextName) return;
    setState(prev => ({
      ...prev,
      clusters: prev.clusters.map(cluster => (
        cluster.id === clusterId
          ? { ...cluster, displayName: nextName, status: cluster.status === 'AUTO' ? 'RENAMED' : cluster.status }
          : cluster
      )),
    }));
  }, []);

  const mergeClusters = useCallback((sourceIds: string[], targetId: string) => {
    setState(prev => ({
      ...prev,
      clusters: mergePeopleClusters(prev.clusters, sourceIds, targetId, prev.faces),
      selectedClusterIds: [targetId],
    }));
  }, []);

  const moveFace = useCallback((faceKey: string, targetClusterId: string | 'UNASSIGNED') => {
    setState(prev => {
      const nextClusters = moveFaceToCluster(prev.clusters, faceKey, targetClusterId, prev.faces);
      const assignedKeys = new Set(nextClusters.flatMap(cluster => cluster.memberFaceKeys));
      const unassignedFaces = prev.faces.filter(face => !assignedKeys.has(face.key));
      return {
        ...prev,
        clusters: nextClusters,
        unassignedFaces,
      };
    });
  }, []);

  const createPersonFromFace = useCallback((faceKey: string) => {
    const targetFace = state.faces.find(face => face.key === faceKey);
    if (!targetFace) return undefined;
    const createdClusterId = nextPersonClusterId(state.clusters);
    setState(prev => {
      const nextClusters = createClusterFromFace(prev.clusters, faceKey, prev.faces);
      const assignedKeys = new Set(nextClusters.flatMap(cluster => cluster.memberFaceKeys));
      return {
        ...prev,
        clusters: nextClusters,
        unassignedFaces: prev.faces.filter(face => !assignedKeys.has(face.key)),
        selectedClusterIds: createdClusterId ? [createdClusterId] : prev.selectedClusterIds,
      };
    });
    return createdClusterId;
  }, [state.clusters, state.faces]);

  const toggleClusterSelection = useCallback((clusterId: string) => {
    setState(prev => {
      const exists = prev.selectedClusterIds.includes(clusterId);
      return {
        ...prev,
        selectedClusterIds: exists
          ? prev.selectedClusterIds.filter(id => id !== clusterId)
          : [...prev.selectedClusterIds, clusterId],
      };
    });
  }, []);

  const setSelectedClusterIds = useCallback((clusterIds: string[]) => {
    setState(prev => ({
      ...prev,
      selectedClusterIds: clusterIds,
    }));
  }, []);

  const reset = useCallback(() => {
    setState(IDLE_STATE);
  }, []);

  const exportClusters = useCallback(async (
    clusters: PersonCluster[],
    destinationFolder: string,
    onEvent?: Channel<ExportStreamEvent>,
  ) => {
    if (!hasTauriRuntime()) {
      throw new Error('People export is only available in the desktop app.');
    }
    const payload: PeopleExportClusterInput[] = clusters.map(cluster => ({
      id: cluster.id,
      displayName: cluster.displayName,
      photoPaths: cluster.photoIds.map(photoId => {
        const group = photos.find(item => item.id === photoId);
        return group?.jpg?.path ?? '';
      }).filter(Boolean),
    }));
    return invoke<string[]>('export_people_clusters_stream', {
      clusters: payload,
      destinationFolder,
      onEvent,
    });
  }, [photos]);

  const selectedClusters = useMemo(
    () => state.clusters.filter(cluster => state.selectedClusterIds.includes(cluster.id)),
    [state.clusters, state.selectedClusterIds],
  );

  return {
    state,
    selectedClusters,
    start,
    stop,
    reset,
    renameCluster,
    mergeClusters,
    moveFace,
    createPersonFromFace,
    toggleClusterSelection,
    setSelectedClusterIds,
    exportClusters,
  };
}

async function analyzePhotoWithCache(
  worker: Worker,
  photo: PhotoGroup,
  cache: Map<string, PersonFaceEmbedding[]>,
  prepareGate: <T>(task: () => Promise<T>) => Promise<T>,
  onStage?: (stage: string) => void,
  options: PeopleSplitAnalysisOptions = {},
) {
  const cacheKey = buildPeopleSplitCacheKey(photo);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const faceDiagnostics = photo.ai?.diagnostics?.faceDiagnostics ?? [];
  onStage?.('读取图片');
  const imageSource = await buildPeopleSplitImageSource(photo, prepareGate);
  onStage?.('识别人脸');
  const faces = await analyzePhoto(worker, {
    photoId: photo.id,
    ...imageSource,
    subjectRoles: faceDiagnostics.map(face => face.subjectRole),
    initialFaceBoxes: faceDiagnostics.map(face => ({
      x: face.x,
      y: face.y,
      width: face.width,
      height: face.height,
      confidence: Math.max(0.52, face.detectorConfidence ?? face.faceQualityScore ?? 0.62),
      landmarkerStatus: face.landmarkerStatus,
    })),
    // People split needs all visible faces, while the culling AI diagnostics often focus on
    // primary subjects. Use those boxes as hints, but never restrict the full face search to them.
    preferInitialFaceBoxes: false,
    disableSFace: options.disableSFace,
  }, onStage);
  cache.set(cacheKey, faces);
  onStage?.('等待写入结果');
  return faces;
}

function analyzePhoto(
  worker: Worker,
  request: {
    photoId: string;
    imageData?: ImageData;
    imageUrl?: string;
    imageBlob?: Blob;
    maxEdge?: number;
    subjectRoles?: Array<PersonFaceEmbedding['subjectRole']>;
    initialFaceBoxes?: InitialPeopleFaceBox[];
    preferInitialFaceBoxes?: boolean;
    disableSFace?: boolean;
  },
  onStage?: (stage: string) => void,
) {
  const requestId = `${request.photoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<PersonFaceEmbedding[]>((resolve, reject) => {
    let settled = false;
    let timeoutId: number | undefined;
    let stallTimerId: number | undefined;
    let lastWorkerProgressAt = Date.now();
    let lastWorkerStage = '';

    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (stallTimerId !== undefined) window.clearInterval(stallTimerId);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };

    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== requestId) return;
      if (event.data.type === 'progress') {
        if (event.data.stage) {
          lastWorkerStage = event.data.stage;
          lastWorkerProgressAt = Date.now();
          onStage?.(event.data.stage);
        }
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (event.data.type === 'result') {
        resolve(event.data.faces ?? []);
      } else {
        reject(new Error(event.data.error || 'People split worker failed.'));
      }
    };

    const handleError = (error: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error.error || new Error(error.message));
    };

    timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      reject(new Error(`People split analysis timed out after ${Math.round(PEOPLE_SPLIT_PHOTO_TIMEOUT_MS / 1000)}s.`));
    }, PEOPLE_SPLIT_PHOTO_TIMEOUT_MS);

    stallTimerId = window.setInterval(() => {
      if (settled) return;
      if (!isPeopleSplitFeatureStage(lastWorkerStage)) return;
      const stalledMs = Date.now() - lastWorkerProgressAt;
      if (stalledMs < PEOPLE_SPLIT_FEATURE_STALL_TIMEOUT_MS) return;
      settled = true;
      cleanup();
      worker.terminate();
      reject(new Error(`People split worker stalled at "${lastWorkerStage}" for ${Math.round(stalledMs / 1000)}s.`));
    }, 1000);

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError, { once: true });
    const transfer = request.imageData ? [request.imageData.data.buffer] : [];
    try {
      worker.postMessage({
        type: 'analyze',
        id: requestId,
        photoId: request.photoId,
        imageData: request.imageData,
        imageUrl: request.imageUrl,
        imageBlob: request.imageBlob,
        maxEdge: request.maxEdge,
        subjectRoles: request.subjectRoles,
        initialFaceBoxes: request.initialFaceBoxes,
        preferInitialFaceBoxes: request.preferInitialFaceBoxes,
        disableSFace: request.disableSFace,
      }, transfer);
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function getWorkerPool(workersRef: MutableRefObject<Worker[]>, count: number) {
  while (workersRef.current.length < count) {
    workersRef.current.push(new PeopleSplitWorker());
  }
  while (workersRef.current.length > count) {
    workersRef.current.pop()?.terminate();
  }
  return workersRef.current;
}

function terminateWorkers(workers: Worker[]) {
  workers.forEach(worker => worker.terminate());
}

async function buildPeopleSplitImageSource(
  photo: PhotoGroup,
  prepareGate: <T>(task: () => Promise<T>) => Promise<T>,
) {
  if (photo.jpg?.previewUrl || (photo.jpg?.path && hasTauriRuntime())) {
    return {
      imageBlob: await prepareGate(() =>
        withTimeout(
          loadPeopleSplitJpegBlob(photo),
          PEOPLE_SPLIT_PREPARE_TIMEOUT_MS,
          `People split image loading timed out after ${Math.round(PEOPLE_SPLIT_PREPARE_TIMEOUT_MS / 1000)}s.`,
        )
      ),
      maxEdge: PEOPLE_SPLIT_ANALYSIS_MAX_EDGE,
    };
  }

  return {
    imageData: await prepareGate(() =>
      withTimeout(
        prepareAnalysisImage(photo, { maxEdge: PEOPLE_SPLIT_ANALYSIS_MAX_EDGE }),
        PEOPLE_SPLIT_PREPARE_TIMEOUT_MS,
        `People split image preparation timed out after ${Math.round(PEOPLE_SPLIT_PREPARE_TIMEOUT_MS / 1000)}s.`,
      )
    ),
  };
}

async function loadPeopleSplitJpegBlob(photo: PhotoGroup) {
  if (photo.jpg?.path && hasTauriRuntime()) {
    try {
      const bytes = await readFile(photo.jpg.path);
      return new Blob([bytes], { type: mimeTypeForExtension(photo.jpg.extension) });
    } catch (error) {
      if (!photo.jpg.previewUrl) throw error;
      console.warn(`People split failed to read JPG directly, falling back to preview URL for ${photo.jpg.name}:`, error);
    }
  }

  return fetchPeopleSplitImageBlob(photo.jpg?.previewUrl);
}

async function fetchPeopleSplitImageBlob(previewUrl: string | undefined) {
  if (!previewUrl) throw new Error('No JPG preview URL available for people split.');
  const response = await fetch(previewUrl);
  if (!response.ok) throw new Error(`Failed to load people split preview: ${response.status}`);
  return response.blob();
}

function mimeTypeForExtension(extension: string | undefined) {
  const value = extension?.toLowerCase();
  if (value === 'jpg' || value === 'jpeg') return 'image/jpeg';
  if (value === 'png') return 'image/png';
  if (value === 'webp') return 'image/webp';
  return 'application/octet-stream';
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function waitForUi() {
  return new Promise<void>(resolve => window.setTimeout(resolve, 0));
}

async function appendPeopleFaces(target: PersonFaceEmbedding[], faces: PersonFaceEmbedding[]) {
  const chunkSize = 64;
  for (let index = 0; index < faces.length; index += chunkSize) {
    target.push(...faces.slice(index, index + chunkSize));
    if (faces.length > chunkSize) await waitForUi();
  }
}

function buildPeopleSplitCacheKey(photo: PhotoGroup) {
  const source = photo.jpg ?? photo.raw;
  return [
    PEOPLE_SPLIT_MODEL_VERSION,
    photo.id,
    source?.path ?? source?.name ?? '',
    source?.size ?? 0,
    source?.modifiedMs ?? 0,
    photo.ai?.modelVersion ?? '',
    photo.ai?.analyzedAt ?? 0,
  ].join('|');
}

function trimPeopleSplitCache(cache: Map<string, PersonFaceEmbedding[]>) {
  while (cache.size > PEOPLE_SPLIT_CACHE_LIMIT) {
    const first = cache.keys().next().value;
    if (!first) return;
    cache.delete(first);
  }
}

function firstLine(value: string) {
  return value.split(/\r?\n/)[0] || value;
}

function isPeopleSplitWorkerTimeout(error: unknown) {
  return error instanceof Error && (
    error.message.includes('People split analysis timed out')
    || error.message.includes('People split worker stalled')
  );
}

function isPeopleSplitFeatureStage(stage: string) {
  return stage.includes('检测人脸')
    || stage.includes('加载识别模型')
    || stage.includes('提取特征')
    || stage.includes('轻量特征');
}

function summarizePeopleSplitWorkload(photos: PhotoGroup[]) {
  const jpgSizes = photos
    .map(photo => photo.jpg?.size ?? 0)
    .filter(size => Number.isFinite(size) && size > 0);
  if (jpgSizes.length === 0) {
    return {
      prepareCap: 1,
      recyclePhotos: PEOPLE_SPLIT_DEFAULT_WORKER_RECYCLE_PHOTOS,
    };
  }

  const averageSize = jpgSizes.reduce((sum, size) => sum + size, 0) / jpgSizes.length;
  const maxSize = Math.max(...jpgSizes);
  const averageMb = averageSize / (1024 * 1024);
  const maxMb = maxSize / (1024 * 1024);

  if (averageMb >= 14 || maxMb >= 22) {
    return {
      prepareCap: 1,
      recyclePhotos: PEOPLE_SPLIT_DEFAULT_WORKER_RECYCLE_PHOTOS,
    };
  }

  if (averageMb >= 8 || maxMb >= 16) {
    return {
      prepareCap: 1,
      recyclePhotos: PEOPLE_SPLIT_DEFAULT_WORKER_RECYCLE_PHOTOS,
    };
  }

  return {
    prepareCap: Number.POSITIVE_INFINITY,
    recyclePhotos: PEOPLE_SPLIT_DEFAULT_WORKER_RECYCLE_PHOTOS,
  };
}

function peoplePhotoLabel(photo: PhotoGroup) {
  return photo.jpg?.name || photo.raw?.name || photo.id;
}

function selectVisibleActiveTask(activeTasks: Map<string, ActivePeopleTask>) {
  const entries = Array.from(activeTasks.entries()).map(([id, task]) => ({ id, task }));
  if (entries.length === 0) return undefined;
  const running = entries.filter(entry => !entry.task.stage.startsWith('完成'));
  const candidates = running.length > 0 ? running : entries;
  return candidates.sort((left, right) => (
    left.task.updatedAt - right.task.updatedAt
    || left.task.startedAt - right.task.startedAt
  ))[0];
}

function clusterPeopleFacesInWorker(
  worker: Worker,
  faces: PersonFaceEmbedding[],
  onStage?: (stage: string) => void,
) {
  const requestId = `cluster-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<ReturnType<typeof clusterPeopleFaces>>((resolve, reject) => {
    let settled = false;
    const timeoutMs = 120000; // 2 minutes for clustering
    let timeoutId: number | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type: string; id: string; result?: any; error?: string; stage?: string };
      if (data.id !== requestId) return;

      if (data.type === 'cluster_progress') {
        onStage?.(data.stage ?? '聚类中');
        return;
      }

      if (data.type === 'cluster_result') {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(data.result);
        return;
      }

      if (data.type === 'cluster_error') {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(data.error || 'Clustering failed in worker'));
      }
    };

    const handleError = (error: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Worker error during clustering: ${error.message}`));
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Clustering timed out after 2 minutes'));
    }, timeoutMs);

    worker.postMessage({
      type: 'cluster',
      id: requestId,
      faces,
    });
  });
}
