import { clearImagePreloadCache } from './imagePreloader';
import { clearJpegThumbnailMemoryCache } from './jpegThumbnailLoader';
import { clearPhotoStateCache } from './photoStateCache';
import { clearRawCache } from './rawLoader';

const AI_CACHE_KEY = 'framecull-ai-cache-v2';

export function clearAppCaches() {
  let clearedPersistent = 0;

  if (removeStorageItem(AI_CACHE_KEY)) clearedPersistent += 1;
  if (clearPhotoStateCache()) clearedPersistent += 1;

  clearRawCache();
  clearImagePreloadCache();
  clearJpegThumbnailMemoryCache();

  return {
    clearedPersistent,
    clearedMemory: true,
  };
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
