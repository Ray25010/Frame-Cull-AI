import { PhotoGroup } from '../types';
import { getImageFromCache, getThumbnailFromCache } from './rawLoader';

const loadedUrls = new Set<string>();
const pendingLoads = new Map<string, Promise<string>>();
const queuedPreloadUrls = new Set<string>();
const preloadQueue: string[] = [];
const MAX_PARALLEL_PRELOADS = 1;
const MAX_LOADED_URLS_CACHE = 500; // 限制已加载URL缓存大小
let activePreloadCount = 0;
let preloadPumpScheduled = false;

export function getDisplayPreviewUrl(group: PhotoGroup): string | null {
  if (group.jpg?.previewUrl) return group.jpg.previewUrl;
  if (!group.raw?.path) return null;
  return getImageFromCache(group.raw.path) || getThumbnailFromCache(group.raw.path);
}

export function loadDisplayImage(url: string): Promise<string> {
  if (loadedUrls.has(url)) return Promise.resolve(url);
  const pending = pendingLoads.get(url);
  if (pending) return pending;

  const promise = new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const decode = typeof image.decode === 'function'
        ? image.decode().catch(() => undefined)
        : Promise.resolve();
      void decode.then(() => {
        loadedUrls.add(url);
        trimLoadedUrlsCache();
        resolve(url);
      });
    };
    image.onerror = () => reject(new Error('Failed to preload image'));
    image.decoding = 'async';
    image.src = url;
  }).finally(() => {
    pendingLoads.delete(url);
  });

  pendingLoads.set(url, promise);
  return promise;
}

function trimLoadedUrlsCache() {
  if (loadedUrls.size <= MAX_LOADED_URLS_CACHE) return;

  // 删除最旧的25%条目
  const toDelete = Math.floor(loadedUrls.size * 0.25);
  const iterator = loadedUrls.values();
  for (let i = 0; i < toDelete; i += 1) {
    const value = iterator.next().value;
    if (value) loadedUrls.delete(value);
  }
}

export function preloadDisplayWindow(
  photos: PhotoGroup[],
  currentIndex: number | null,
  options: { ahead?: number; behind?: number; includeCurrent?: boolean } = {},
) {
  if (currentIndex === null || currentIndex < 0 || photos.length === 0) return;
  const ahead = options.ahead ?? 8;
  const behind = options.behind ?? 4;

  for (const index of getPreloadOrder(currentIndex, photos.length, ahead, behind)) {
    if (options.includeCurrent === false && index === currentIndex) continue;
    const url = getDisplayPreviewUrl(photos[index]);
    if (!url) continue;
    enqueuePreload(url);
  }
}

export function clearImagePreloadCache() {
  loadedUrls.clear();
  pendingLoads.clear();
  queuedPreloadUrls.clear();
  preloadQueue.length = 0;
  activePreloadCount = 0;
  preloadPumpScheduled = false;
}

function getPreloadOrder(currentIndex: number, total: number, ahead: number, behind: number) {
  const order: number[] = [];
  const maxOffset = Math.max(ahead, behind);

  for (let offset = 0; offset <= maxOffset; offset += 1) {
    if (offset <= ahead) {
      const forward = currentIndex + offset;
      if (forward >= 0 && forward < total) order.push(forward);
    }

    if (offset > 0 && offset <= behind) {
      const backward = currentIndex - offset;
      if (backward >= 0 && backward < total) order.push(backward);
    }
  }

  return order;
}

function enqueuePreload(url: string) {
  if (loadedUrls.has(url) || pendingLoads.has(url) || queuedPreloadUrls.has(url)) return;

  queuedPreloadUrls.add(url);
  preloadQueue.push(url);
  schedulePreloadPump();
}

function schedulePreloadPump() {
  if (preloadPumpScheduled) return;
  preloadPumpScheduled = true;

  const schedule = typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (callback: () => void) => (window as Window & { requestIdleCallback: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback(callback, { timeout: 180 })
    : (callback: () => void) => setTimeout(callback, 80);

  schedule(() => {
    preloadPumpScheduled = false;
    pumpPreloadQueue();
  });
}

function pumpPreloadQueue() {
  while (activePreloadCount < MAX_PARALLEL_PRELOADS && preloadQueue.length > 0) {
    const url = preloadQueue.shift();
    if (!url) continue;
    queuedPreloadUrls.delete(url);

    if (loadedUrls.has(url) || pendingLoads.has(url)) continue;

    activePreloadCount += 1;
    void loadDisplayImage(url)
      .catch(() => {
        // Preloading is opportunistic; display code handles real errors.
      })
      .finally(() => {
        activePreloadCount = Math.max(0, activePreloadCount - 1);
        if (preloadQueue.length > 0) schedulePreloadPump();
      });
  }
}
