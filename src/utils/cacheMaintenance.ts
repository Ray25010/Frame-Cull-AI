import { invoke } from '@tauri-apps/api/core';
import { clearImagePreloadCache } from './imagePreloader';
import { clearJpegThumbnailMemoryCache } from './jpegThumbnailLoader';
import { clearPhotoStateCache } from './photoStateCache';
import { clearRawCache } from './rawLoader';
import { hasTauriRuntime } from './tauriRuntime';

const AI_CACHE_KEY = 'framecull-ai-cache-v2';
const PHOTO_STATE_CACHE_KEY = 'framecull-photo-state-cache-v1';
const PERSISTENT_CACHE_KEYS = [AI_CACHE_KEY, PHOTO_STATE_CACHE_KEY] as const;

export type AppDiskCacheUsage = {
  diskBytes: number;
  rawPreviewBytes: number;
  jpegThumbnailBytes: number;
  rawMonitorBytes: number;
};

export type AppCacheUsage = AppDiskCacheUsage & {
  persistentBytes: number;
  persistentEntries: number;
  totalBytes: number;
  diskAvailable: boolean;
};

export async function getAppCacheUsage(): Promise<AppCacheUsage> {
  const persistent = getPersistentCacheUsage();
  const disk = await getDiskCacheUsage();

  return {
    ...disk,
    ...persistent,
    totalBytes: persistent.persistentBytes + disk.diskBytes,
  };
}

export async function clearAppCaches() {
  let clearedPersistent = 0;

  if (removeStorageItem(AI_CACHE_KEY)) clearedPersistent += 1;
  if (clearPhotoStateCache()) clearedPersistent += 1;
  const clearedDiskBytes = await clearDiskPreviewCaches();

  clearRawCache();
  clearImagePreloadCache();
  clearJpegThumbnailMemoryCache();

  return {
    clearedPersistent,
    clearedDiskBytes,
    clearedMemory: true,
  };
}

function getPersistentCacheUsage() {
  let persistentBytes = 0;
  let persistentEntries = 0;

  PERSISTENT_CACHE_KEYS.forEach(key => {
    const value = readStorageItem(key);
    if (value === null) return;
    persistentEntries += 1;
    persistentBytes += byteLength(key) + byteLength(value);
  });

  return { persistentBytes, persistentEntries };
}

async function getDiskCacheUsage(): Promise<AppDiskCacheUsage & { diskAvailable: boolean }> {
  if (!hasTauriRuntime()) {
    return emptyDiskCacheUsage(false);
  }

  try {
    const usage = await invoke<AppDiskCacheUsage>('get_app_cache_usage');
    return {
      diskBytes: normalizeBytes(usage.diskBytes),
      rawPreviewBytes: normalizeBytes(usage.rawPreviewBytes),
      jpegThumbnailBytes: normalizeBytes(usage.jpegThumbnailBytes),
      rawMonitorBytes: normalizeBytes(usage.rawMonitorBytes),
      diskAvailable: true,
    };
  } catch (error) {
    console.warn('Failed to read app cache usage:', error);
    return emptyDiskCacheUsage(false);
  }
}

async function clearDiskPreviewCaches() {
  if (!hasTauriRuntime()) return 0;
  try {
    return normalizeBytes(await invoke<number>('clear_app_preview_caches'));
  } catch (error) {
    console.warn('Failed to clear preview cache files:', error);
    return 0;
  }
}

function emptyDiskCacheUsage(diskAvailable: boolean) {
  return {
    diskBytes: 0,
    rawPreviewBytes: 0,
    jpegThumbnailBytes: 0,
    rawMonitorBytes: 0,
    diskAvailable,
  };
}

function readStorageItem(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeStorageItem(key: string) {
  try {
    const existed = localStorage.getItem(key) !== null;
    localStorage.removeItem(key);
    return existed;
  } catch {
    return false;
  }
}

function byteLength(value: string) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return value.length * 2;
}

function normalizeBytes(value: unknown) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : 0;
}
