import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { hasTauriRuntime } from './tauriRuntime';

type JpegThumbnailInfo = {
  cachePath: string;
  fromCache: boolean;
  width: number;
  height: number;
};

type ThumbnailRequest = {
  filePath: string;
  maxEdge: number;
  priority: ThumbnailPriority;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
};

type ThumbnailPriority = 'high' | 'low';

const thumbnailCache = new Map<string, string>();
const pendingThumbnails = new Map<string, Promise<string>>();
const thumbnailQueue: ThumbnailRequest[] = [];
const MAX_PARALLEL_THUMBNAILS = 2;

let activeThumbnailCount = 0;

export function getCachedJpegThumbnail(filePath: string, maxEdge = 360) {
  return thumbnailCache.get(cacheKey(filePath, maxEdge)) ?? null;
}

export function loadJpegThumbnail(
  filePath: string,
  fallbackUrl: string,
  maxEdge = 360,
  priority: ThumbnailPriority = 'low',
): Promise<string> {
  if (!hasTauriRuntime()) return Promise.resolve(fallbackUrl);

  const key = cacheKey(filePath, maxEdge);
  const cached = thumbnailCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = pendingThumbnails.get(key);
  if (pending) return pending;

  const promise = new Promise<string>((resolve, reject) => {
    const request = { filePath, maxEdge, priority, resolve, reject };
    if (priority === 'high') {
      thumbnailQueue.unshift(request);
    } else {
      thumbnailQueue.push(request);
    }
    pumpThumbnailQueue();
  }).catch(error => {
    console.warn('[JPEG Thumbnail] Falling back to source image:', error);
    return fallbackUrl;
  }).finally(() => {
    pendingThumbnails.delete(key);
  });

  pendingThumbnails.set(key, promise);
  return promise;
}

export function preloadJpegThumbnail(
  filePath: string,
  fallbackUrl: string,
  maxEdge = 360,
  priority: ThumbnailPriority = 'low',
) {
  void loadJpegThumbnail(filePath, fallbackUrl, maxEdge, priority).catch(() => undefined);
}

export function clearJpegThumbnailMemoryCache() {
  thumbnailCache.clear();
  pendingThumbnails.clear();
  thumbnailQueue.length = 0;
  activeThumbnailCount = 0;
}

function pumpThumbnailQueue() {
  while (activeThumbnailCount < MAX_PARALLEL_THUMBNAILS && thumbnailQueue.length > 0) {
    const request = thumbnailQueue.shift();
    if (!request) continue;

    const key = cacheKey(request.filePath, request.maxEdge);
    const cached = thumbnailCache.get(key);
    if (cached) {
      request.resolve(cached);
      continue;
    }

    activeThumbnailCount += 1;
    void invoke<JpegThumbnailInfo>('get_jpeg_thumbnail', {
      filePath: request.filePath,
      maxEdge: request.maxEdge,
    })
      .then(info => {
        const url = convertFileSrc(info.cachePath);
        thumbnailCache.set(key, url);
        request.resolve(url);
      })
      .catch(request.reject)
      .finally(() => {
        activeThumbnailCount = Math.max(0, activeThumbnailCount - 1);
        pumpThumbnailQueue();
      });
  }
}

function cacheKey(filePath: string, maxEdge: number) {
  return `${maxEdge}:${filePath}`;
}
