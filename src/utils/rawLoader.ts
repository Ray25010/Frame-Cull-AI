import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { PhotoGroup, RawDecodeProgress, RawPreviewInfo } from '../types';
import { getRawPreloadWindowPaths, normalizeExifOrientation } from './rawPreload';
import { hasTauriRuntime } from './tauriRuntime';

import RawDecoderWorker from '../workers/rawDecoder.worker.ts?worker';

export type DecodePriority = 'high' | 'low';

export type DecodeOptions = {
  priority?: DecodePriority;
  silent?: boolean;
  allowEmbeddedPreview?: boolean;
  fallbackToWorker?: boolean;
  bypassCache?: boolean;
};

type EmbeddedPreviewRequest = {
  filePath: string;
  priority: DecodePriority;
  silent: boolean;
  visibleStarted: boolean;
  resolve: (value: string | null) => void;
  reject: (reason: unknown) => void;
};

type PendingRequest = {
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  filePath: string;
  thumbnail: boolean;
  id: string;
  priority: DecodePriority;
  silent: boolean;
};

const CPU_CORES = navigator.hardwareConcurrency || 4;
const MAX_CACHE_SIZE = 100;
const MAX_THUMBNAIL_CACHE_SIZE = 400;
const MAX_WORKERS = Math.min(8, Math.max(4, Math.floor(CPU_CORES * 0.75)));
const RESERVED_HIGH_PRIORITY_WORKERS = MAX_WORKERS > 1 ? 1 : 0;
const MAX_PRELOAD_CONCURRENCY = Math.min(3, Math.max(2, MAX_WORKERS - 2));
const MAX_EMBEDDED_PREVIEW_CONCURRENCY = Math.min(6, Math.max(4, Math.floor(CPU_CORES / 2)));
const DEFAULT_PRELOAD_AHEAD = 30;
const DEFAULT_PRELOAD_BEHIND = 15;
const RAW_PROGRESS_IDLE: RawDecodeProgress = {
  total: 0,
  processed: 0,
  queued: 0,
  active: 0,
  running: false,
};

const rawImageCache = new Map<string, string>();
const thumbnailCache = new Map<string, string>();
const cacheAccessOrder: string[] = [];
const thumbnailAccessOrder: string[] = [];
const ongoingDecodes = new Map<string, Promise<string>>();
const workerPool: Worker[] = [];
const availableWorkers: Worker[] = [];
const pendingRequests: PendingRequest[] = [];
const pendingEmbeddedPreviewRequests: EmbeddedPreviewRequest[] = [];
const activeRequests = new Map<string, string>();
const progressListeners = new Set<(progress: RawDecodeProgress) => void>();
const ongoingEmbeddedPreviews = new Map<string, Promise<string | null>>();
const MAX_ONGOING_DECODES = 100;
const MAX_ONGOING_PREVIEWS = 50;

let rawProgress: RawDecodeProgress = { ...RAW_PROGRESS_IDLE };
let preloadGeneration = 0;
let activePreloads = 0;
let activeEmbeddedPreviews = 0;
let activeLowPriorityEmbeddedPreviews = 0;
let visibleEmbeddedPreviews = 0;
let preloadQueue: Array<{ filePath: string; generation: number }> = [];
let preloadPumpScheduled = false;

function initWorkerPool() {
  if (workerPool.length > 0) return;

  console.log(`[RAW Worker] Initializing worker pool with ${MAX_WORKERS} workers`);
  for (let i = 0; i < MAX_WORKERS; i += 1) {
    const worker = new RawDecoderWorker();
    workerPool.push(worker);
    availableWorkers.push(worker);
  }
}

function formatDecodeLabel(filePath: string, thumbnail: boolean) {
  const parts = filePath.split(/[\\/]/);
  const name = parts[parts.length - 1] || filePath;
  return thumbnail ? `${name} thumb` : name;
}

function emitRawProgress() {
  progressListeners.forEach(listener => listener(rawProgress));
}

function updateRawProgress() {
  const activeLabels = Array.from(activeRequests.values());
  const visiblePendingRequests = pendingRequests.filter(request => !request.silent).length;
  const visibleEmbeddedPending = pendingEmbeddedPreviewRequests.filter(request => !request.silent).length;
  const visibleQueued = visiblePendingRequests + visibleEmbeddedPending;
  const visibleActive = activeLabels.length + visibleEmbeddedPreviews;
  const hasVisibleWork = visibleQueued > 0 || visibleActive > 0;

  rawProgress = {
    total: rawProgress.total,
    processed: rawProgress.processed,
    queued: visibleQueued,
    active: visibleActive,
    current: activeLabels[0],
    running: hasVisibleWork,
  };

  if (!rawProgress.running) {
    rawProgress = { ...RAW_PROGRESS_IDLE };
  }

  emitRawProgress();
}

function markRawQueueStart(silent = false) {
  if (silent) return;
  rawProgress = {
    ...rawProgress,
    total: rawProgress.total + 1,
    running: true,
  };
  updateRawProgress();
}

function markRawWorkerStart(id: string, label: string, silent = false) {
  if (silent) return;
  activeRequests.set(id, label);
  updateRawProgress();
}

function markRawFinished(id: string, silent = false) {
  if (silent) return;
  activeRequests.delete(id);
  rawProgress = {
    ...rawProgress,
    processed: rawProgress.processed + 1,
  };
  updateRawProgress();
}

export function subscribeRawDecodeProgress(listener: (progress: RawDecodeProgress) => void) {
  progressListeners.add(listener);
  listener(rawProgress);
  return () => {
    progressListeners.delete(listener);
  };
}

function trimOngoingDecodes() {
  if (ongoingDecodes.size <= MAX_ONGOING_DECODES) return;

  // 删除已经settled的Promise（如果有的话），否则删除最旧的
  const toDelete: string[] = [];
  for (const [key, promise] of ongoingDecodes.entries()) {
    // 尝试检查Promise状态，如果已完成则标记删除
    Promise.race([promise, Promise.resolve(null)]).then(() => {
      // Promise已settled，可以安全删除
      ongoingDecodes.delete(key);
    }).catch(() => {
      // Promise已rejected，也可以删除
      ongoingDecodes.delete(key);
    });

    if (toDelete.length >= Math.floor(ongoingDecodes.size * 0.2)) break;
  }
}

function trimOngoingPreviews() {
  if (ongoingEmbeddedPreviews.size <= MAX_ONGOING_PREVIEWS) return;

  // 删除超出限制的最旧条目（20%）
  const toDelete = Math.floor(ongoingEmbeddedPreviews.size * 0.2);
  const keys = Array.from(ongoingEmbeddedPreviews.keys());
  for (let i = 0; i < toDelete && i < keys.length; i += 1) {
    ongoingEmbeddedPreviews.delete(keys[i]);
  }
}

function getEmbeddedPreviewUrl(filePath: string, priority: DecodePriority, silent: boolean): Promise<string | null> {
  if (!hasTauriRuntime()) return Promise.resolve(null);

  const ongoing = ongoingEmbeddedPreviews.get(filePath);
  if (ongoing) {
    if (priority === 'high' || !silent) promotePendingEmbeddedPreview(filePath, silent);
    return ongoing;
  }

  // 检查并清理过多的ongoing任务
  trimOngoingPreviews();

  const promise = new Promise<string | null>((resolve, reject) => {
    const request: EmbeddedPreviewRequest = { filePath, priority, silent, visibleStarted: false, resolve, reject };
    if (priority === 'high') {
      pendingEmbeddedPreviewRequests.unshift(request);
    } else {
      pendingEmbeddedPreviewRequests.push(request);
    }
    markRawQueueStart(silent);
    processEmbeddedPreviewQueue();
  }).finally(() => {
    ongoingEmbeddedPreviews.delete(filePath);
  });

  ongoingEmbeddedPreviews.set(filePath, promise);
  return promise;
}

function promotePendingEmbeddedPreview(filePath: string, silent: boolean) {
  const index = pendingEmbeddedPreviewRequests.findIndex(request => request.filePath === filePath);
  if (index < 0) return;

  const [request] = pendingEmbeddedPreviewRequests.splice(index, 1);
  if (!request) return;

  request.priority = 'high';
  if (request.silent && !silent) {
    request.silent = false;
    markRawQueueStart(false);
  }
  pendingEmbeddedPreviewRequests.unshift(request);
  processEmbeddedPreviewQueue();
}

function processEmbeddedPreviewQueue() {
  while (activeEmbeddedPreviews < MAX_EMBEDDED_PREVIEW_CONCURRENCY && pendingEmbeddedPreviewRequests.length > 0) {
    const request = takeNextEmbeddedPreviewRequest();
    if (!request) break;

    activeEmbeddedPreviews += 1;
    if (request.priority === 'low') activeLowPriorityEmbeddedPreviews += 1;
    if (!request.silent) {
      request.visibleStarted = true;
      visibleEmbeddedPreviews += 1;
      updateRawProgress();
    }

    void invoke<RawPreviewInfo | null>('extract_raw_embedded_preview', { filePath: request.filePath })
      .then(preview => {
        request.resolve(preview?.cachePath ? convertFileSrc(preview.cachePath) : null);
      })
      .catch(error => {
        console.warn('[RAW Preview] Embedded preview extraction failed:', error);
        request.resolve(null);
      })
      .finally(() => {
        if (request.visibleStarted) {
          visibleEmbeddedPreviews = Math.max(0, visibleEmbeddedPreviews - 1);
          rawProgress = {
            ...rawProgress,
            processed: rawProgress.processed + 1,
          };
          updateRawProgress();
        }
        activeEmbeddedPreviews = Math.max(0, activeEmbeddedPreviews - 1);
        if (request.priority === 'low') {
          activeLowPriorityEmbeddedPreviews = Math.max(0, activeLowPriorityEmbeddedPreviews - 1);
        }
        processEmbeddedPreviewQueue();
      });
  }
}

function takeNextEmbeddedPreviewRequest() {
  const highIndex = pendingEmbeddedPreviewRequests.findIndex(request => request.priority === 'high');
  if (highIndex >= 0) {
    const [request] = pendingEmbeddedPreviewRequests.splice(highIndex, 1);
    return request ?? null;
  }

  const shouldReserveHighPrioritySlot =
    MAX_EMBEDDED_PREVIEW_CONCURRENCY > 1 &&
    activeEmbeddedPreviews >= MAX_EMBEDDED_PREVIEW_CONCURRENCY - 1 &&
    activeLowPriorityEmbeddedPreviews > 0;
  if (shouldReserveHighPrioritySlot) return null;

  return pendingEmbeddedPreviewRequests.shift() ?? null;
}

async function readRawOrientation(filePath: string): Promise<number> {
  if (!hasTauriRuntime()) return 1;

  try {
    const exif = await invoke<{ orientation?: number }>('read_exif', { filePath });
    return normalizeExifOrientation(exif?.orientation);
  } catch {
    return 1;
  }
}

function needsCanvasOrientation(orientation: number) {
  return orientation >= 2 && orientation <= 8;
}

async function normalizeImageSourceForOrientation(sourceUrl: string, orientation: number): Promise<string> {
  const normalizedOrientation = normalizeExifOrientation(orientation);
  if (!needsCanvasOrientation(normalizedOrientation)) return sourceUrl;

  const img = await loadImage(sourceUrl);
  const swap = normalizedOrientation >= 5 && normalizedOrientation <= 8;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? img.naturalHeight : img.naturalWidth;
  canvas.height = swap ? img.naturalWidth : img.naturalHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return sourceUrl;

  switch (normalizedOrientation) {
    case 2:
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      break;
    case 3:
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(Math.PI);
      break;
    case 4:
      ctx.translate(0, canvas.height);
      ctx.scale(1, -1);
      break;
    case 5:
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      break;
    case 6:
      ctx.translate(canvas.width, 0);
      ctx.rotate(0.5 * Math.PI);
      break;
    case 7:
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(-1, 1);
      break;
    case 8:
      ctx.translate(0, canvas.height);
      ctx.rotate(-0.5 * Math.PI);
      break;
  }

  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const decoded = typeof img.decode === 'function'
        ? img.decode().catch(() => undefined)
        : Promise.resolve();
      void decoded.then(() => resolve(img));
    };
    img.onerror = () => reject(new Error('Failed to load RAW preview image'));
    img.decoding = 'async';
    img.src = src;
  });
}

async function processNextRequest() {
  if (pendingRequests.length === 0 || availableWorkers.length === 0) {
    return;
  }

  const request = takeNextDecodeRequest();
  if (!request) return;

  const worker = availableWorkers.shift();
  if (!worker) return;

  const requestId = request.id;
  markRawWorkerStart(requestId, formatDecodeLabel(request.filePath, request.thumbnail), request.silent);

  const handleMessage = async (event: MessageEvent) => {
    const { type, id, dataUrl, error, timing } = event.data;
    if (id !== requestId) return;

    worker.removeEventListener('message', handleMessage);
    worker.removeEventListener('error', handleError);

    try {
      if (type === 'success' && dataUrl) {
        if (timing?.total) {
          console.log(`[RAW Worker] Decode success for ${id} in ${timing.total.toFixed(1)}ms`);
        }
        const orientation = await readRawOrientation(request.filePath);
        request.resolve(await normalizeImageSourceForOrientation(dataUrl, orientation));
      } else if (type === 'error') {
        request.reject(new Error(error || 'Unknown worker error'));
      }
    } catch (normalizationError) {
      request.reject(normalizationError);
    } finally {
      markRawFinished(requestId, request.silent);
      availableWorkers.push(worker);
      void processNextRequest();
    }
  };

  const handleError = (error: ErrorEvent) => {
    worker.removeEventListener('message', handleMessage);
    worker.removeEventListener('error', handleError);
    request.reject(error.error || new Error(error.message));
    markRawFinished(requestId, request.silent);
    availableWorkers.push(worker);
    void processNextRequest();
  };

  worker.addEventListener('message', handleMessage);
  worker.addEventListener('error', handleError, { once: true });

  try {
    const t1 = performance.now();
    const fileBuffer = await readFile(request.filePath);
    console.log(`[RAW] File read: ${(performance.now() - t1).toFixed(1)}ms (${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
    const sourceBuffer = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength,
    );

    worker.postMessage({
      type: 'decode',
      id: requestId,
      fileBuffer: sourceBuffer,
      thumbnail: request.thumbnail,
    }, [sourceBuffer]);
  } catch (error) {
    worker.removeEventListener('message', handleMessage);
    worker.removeEventListener('error', handleError);
    request.reject(error instanceof Error ? error : new Error(String(error)));
    markRawFinished(requestId, request.silent);
    availableWorkers.push(worker);
    void processNextRequest();
  }
}

function takeNextDecodeRequest() {
  const highIndex = pendingRequests.findIndex(request => request.priority === 'high');
  if (highIndex >= 0) {
    const [request] = pendingRequests.splice(highIndex, 1);
    return request ?? null;
  }

  if (RESERVED_HIGH_PRIORITY_WORKERS > 0 && availableWorkers.length <= RESERVED_HIGH_PRIORITY_WORKERS) {
    return null;
  }

  return pendingRequests.shift() ?? null;
}

function decodeWithWorker(filePath: string, thumbnail: boolean, priority: DecodePriority, silent: boolean): Promise<string> {
  initWorkerPool();
  return new Promise((resolve, reject) => {
    if (!rawProgress.running) {
      rawProgress = { ...RAW_PROGRESS_IDLE };
    }
    const id = `${thumbnail ? 'thumb' : 'full'}:${filePath}`;
    const request: PendingRequest = {
      resolve,
      reject,
      filePath,
      thumbnail,
      id,
      priority,
      silent,
    };

    if (priority === 'high') {
      pendingRequests.unshift(request);
    } else {
      pendingRequests.push(request);
    }

    markRawQueueStart(silent);
    void processNextRequest();
  });
}

function promotePendingDecode(id: string) {
  const index = pendingRequests.findIndex(request => request.id === id);
  if (index < 0) return;

  const [request] = pendingRequests.splice(index, 1);
  if (!request) return;

  request.priority = 'high';
  pendingRequests.unshift(request);
  void processNextRequest();
}

function storeRawImage(filePath: string, url: string) {
  evictLRUCache();
  rawImageCache.set(filePath, url);
  touchCache(filePath, false);
}

function storeRawThumbnail(filePath: string, url: string) {
  evictThumbnailCache();
  thumbnailCache.set(filePath, url);
  touchCache(filePath, true);
}

function evictLRUCache() {
  while (rawImageCache.size >= MAX_CACHE_SIZE && cacheAccessOrder.length > 0) {
    const oldestKey = cacheAccessOrder.shift();
    if (oldestKey) rawImageCache.delete(oldestKey);
  }
}

function evictThumbnailCache() {
  while (thumbnailCache.size >= MAX_THUMBNAIL_CACHE_SIZE && thumbnailAccessOrder.length > 0) {
    const oldestKey = thumbnailAccessOrder.shift();
    if (oldestKey) thumbnailCache.delete(oldestKey);
  }
}

function touchCache(filePath: string, isThumbnail = false) {
  const orderList = isThumbnail ? thumbnailAccessOrder : cacheAccessOrder;
  const idx = orderList.indexOf(filePath);
  if (idx > -1) orderList.splice(idx, 1);
  orderList.push(filePath);
}

export function getThumbnailFromCache(filePath: string): string | null {
  if (!thumbnailCache.has(filePath)) return null;
  touchCache(filePath, true);
  return thumbnailCache.get(filePath)!;
}

export function getImageFromCache(filePath: string): string | null {
  if (!rawImageCache.has(filePath)) return null;
  touchCache(filePath, false);
  return rawImageCache.get(filePath)!;
}

export function isDecoding(filePath: string): boolean {
  return ongoingDecodes.has(`full:${filePath}`) ||
    ongoingDecodes.has(`thumb:${filePath}`) ||
    ongoingDecodes.has(`embedded-full:${filePath}`) ||
    ongoingDecodes.has(`embedded-thumb:${filePath}`);
}

export function preloadRawFile(filePath: string, priority: DecodePriority = 'low'): void {
  if (rawImageCache.has(filePath)) {
    return;
  }

  if (
    (ongoingDecodes.has(`full:${filePath}`) || ongoingDecodes.has(`embedded-full:${filePath}`)) &&
    priority !== 'high'
  ) {
    return;
  }

  decodeRawFile(filePath, false, { priority, silent: true, fallbackToWorker: false }).catch(() => {
    // Preload errors should not interrupt culling.
  });
}

export function preloadRawWindow(
  photos: PhotoGroup[],
  currentIndex: number | null,
  options: { ahead?: number; behind?: number; includeCurrent?: boolean } = {},
) {
  if (currentIndex === null || currentIndex < 0 || photos.length === 0) return;

  preloadGeneration += 1;
  const generation = preloadGeneration;
  const ahead = options.ahead ?? DEFAULT_PRELOAD_AHEAD;
  const behind = options.behind ?? DEFAULT_PRELOAD_BEHIND;
  const currentPath = photos[currentIndex]?.raw?.path;
  const paths = getRawPreloadPaths(photos, currentIndex, ahead, behind)
    .filter(path => options.includeCurrent !== false || path !== currentPath);

  preloadQueue = paths.map(filePath => ({ filePath, generation }));
  updateRawProgress();
  schedulePreloadQueue();
}

export function cancelRawPreloads() {
  preloadGeneration += 1;
  preloadQueue = [];
  preloadPumpScheduled = false;
  updateRawProgress();
}

export function getRawPreloadPaths(
  photos: PhotoGroup[],
  currentIndex: number,
  ahead = DEFAULT_PRELOAD_AHEAD,
  behind = DEFAULT_PRELOAD_BEHIND,
) {
  return getRawPreloadWindowPaths(photos, currentIndex, ahead, behind, path => rawImageCache.has(path));
}

function processPreloadQueue() {
  while (activePreloads < MAX_PRELOAD_CONCURRENCY && preloadQueue.length > 0) {
    const request = preloadQueue.shift();
    if (!request) continue;
    if (request.generation !== preloadGeneration) continue;
    if (rawImageCache.has(request.filePath) || ongoingDecodes.has(`full:${request.filePath}`)) continue;

    activePreloads += 1;
    updateRawProgress();
    decodeRawFile(request.filePath, false, { priority: 'low', silent: true, fallbackToWorker: false })
      .catch(() => {
        // Preload errors should stay silent.
      })
      .finally(() => {
        activePreloads = Math.max(0, activePreloads - 1);
        updateRawProgress();
        schedulePreloadQueue();
      });
  }
}

function schedulePreloadQueue() {
  if (preloadPumpScheduled || preloadQueue.length === 0) return;
  preloadPumpScheduled = true;

  const schedule = typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (callback: () => void) => (window as Window & { requestIdleCallback: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback(callback, { timeout: 220 })
    : (callback: () => void) => setTimeout(callback, 100);

  schedule(() => {
    preloadPumpScheduled = false;
    processPreloadQueue();
  });
}

export async function decodeRawFile(
  filePath: string,
  thumbnail = false,
  options: DecodeOptions = {},
): Promise<string> {
  const startTime = performance.now();
  const priority = options.priority ?? 'high';
  const silent = options.silent ?? false;
  const allowEmbeddedPreview = options.allowEmbeddedPreview ?? true;
  const fallbackToWorker = options.fallbackToWorker ?? true;
  const bypassCache = options.bypassCache ?? false;
  const modeKey = fallbackToWorker
    ? `${thumbnail ? 'thumb' : 'full'}:${filePath}`
    : `embedded-${thumbnail ? 'thumb' : 'full'}:${filePath}`;
  const fullKey = `full:${filePath}`;

  if (!bypassCache && thumbnail && thumbnailCache.has(filePath)) {
    touchCache(filePath, true);
    return thumbnailCache.get(filePath)!;
  }

  if (!bypassCache && rawImageCache.has(filePath)) {
    const cachedUrl = rawImageCache.get(filePath)!;
    touchCache(filePath, false);

    if (thumbnail) {
      evictThumbnailCache();
      thumbnailCache.set(filePath, cachedUrl);
      touchCache(filePath, true);
      return cachedUrl;
    }

    return cachedUrl;
  }

  if (!bypassCache && ongoingDecodes.has(modeKey)) {
    if (priority === 'high') promotePendingDecode(modeKey);
    return ongoingDecodes.get(modeKey)!;
  }

  if (!bypassCache && thumbnail && ongoingDecodes.has(fullKey)) {
    if (priority === 'high') promotePendingDecode(fullKey);
    const fullUrl = await ongoingDecodes.get(fullKey)!;
    const thumbnailUrl = await createThumbnailFromImageUrl(fullUrl);
    evictThumbnailCache();
    thumbnailCache.set(filePath, thumbnailUrl);
    touchCache(filePath, true);
    return thumbnailUrl;
  }

  const decodePromise = (async () => {
    try {
      // 检查并清理过多的ongoing任务
      trimOngoingDecodes();

      const embeddedPreviewUrl = allowEmbeddedPreview
        ? await getEmbeddedPreviewUrl(filePath, priority, silent)
        : null;
      if (embeddedPreviewUrl) {
        try {
          await loadImage(embeddedPreviewUrl);

          if (thumbnail) {
            storeRawThumbnail(filePath, embeddedPreviewUrl);
            storeRawImage(filePath, embeddedPreviewUrl);
            return embeddedPreviewUrl;
          }

          storeRawImage(filePath, embeddedPreviewUrl);
          storeRawThumbnail(filePath, embeddedPreviewUrl);
          console.log(`[RAW Preview] Embedded JPEG ready in ${(performance.now() - startTime).toFixed(1)}ms`);
          return embeddedPreviewUrl;
        } catch (previewError) {
          if (!silent) {
            console.warn('[RAW Preview] Embedded preview could not be displayed; falling back to RAW worker:', previewError);
          }
        }
      }

      if (!fallbackToWorker) {
        throw new Error('No displayable embedded RAW preview was found.');
      }

      const t2 = performance.now();
      const dataUrl = await decodeWithWorker(filePath, thumbnail, priority, silent);
      console.log(`[RAW Worker] Total decode time: ${(performance.now() - t2).toFixed(1)}ms`);

      if (thumbnail) {
        storeRawThumbnail(filePath, dataUrl);
      } else {
        storeRawImage(filePath, dataUrl);
      }

      return dataUrl;
    } catch (error) {
      if (!silent) console.error('Failed to decode RAW file:', error);
      throw error;
    } finally {
      ongoingDecodes.delete(modeKey);
    }
  })();

  ongoingDecodes.set(modeKey, decodePromise);
  return decodePromise;
}

async function createThumbnailFromImageUrl(imageUrl: string): Promise<string> {
  const img = await loadImage(imageUrl);
  const maxWidth = 320;
  let width = img.naturalWidth;
  let height = img.naturalHeight;

  if (width > maxWidth) {
    const scale = maxWidth / width;
    width = maxWidth;
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

export function clearRawCache() {
  rawImageCache.clear();
  thumbnailCache.clear();
  cacheAccessOrder.length = 0;
  thumbnailAccessOrder.length = 0;
  ongoingDecodes.clear();
  ongoingEmbeddedPreviews.clear();
  preloadQueue = [];
  activePreloads = 0;
  activeEmbeddedPreviews = 0;
  activeLowPriorityEmbeddedPreviews = 0;
  visibleEmbeddedPreviews = 0;
  preloadGeneration += 1;
  rawProgress = { ...RAW_PROGRESS_IDLE };
  emitRawProgress();
}

export function getCacheStats() {
  return {
    fullImageCount: rawImageCache.size,
    thumbnailCount: thumbnailCache.size,
    ongoingDecodes: ongoingDecodes.size,
    workers: workerPool.length,
    availableWorkers: availableWorkers.length,
    pendingRequests: pendingRequests.length,
    activeRequests: activeRequests.size,
    pendingEmbeddedPreviewRequests: pendingEmbeddedPreviewRequests.length,
    activeEmbeddedPreviews,
    activeLowPriorityEmbeddedPreviews,
    visibleEmbeddedPreviews,
    preloadQueue: preloadQueue.length,
    activePreloads,
  };
}

export function isRawExtension(extension: string): boolean {
  const rawExts = ['ARW', 'CR2', 'CR3', 'NEF', 'NRW', 'DNG', 'ORF', 'RAF', 'RW2', 'SRW', 'SRF', 'SR2'];
  return rawExts.includes(extension.toUpperCase());
}
