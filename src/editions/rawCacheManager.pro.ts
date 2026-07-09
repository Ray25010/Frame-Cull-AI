import { invoke } from '@tauri-apps/api/core';

/**
 * Get the current size of the RAW monitor cache in bytes
 */
export async function getRawMonitorCacheSize(): Promise<number> {
  try {
    return await invoke<number>('get_raw_monitor_cache_size');
  } catch (error) {
    console.error('Failed to get RAW monitor cache size:', error);
    return 0;
  }
}

/**
 * Clear the entire RAW monitor cache
 */
export async function clearRawMonitorCache(): Promise<void> {
  try {
    await invoke('clear_raw_monitor_cache');
  } catch (error) {
    console.error('Failed to clear RAW monitor cache:', error);
  }
}

/**
 * Cleanup RAW monitor cache using LRU strategy if it exceeds 10GB
 * Returns the number of bytes freed
 */
export async function cleanupRawMonitorCacheLRU(): Promise<number> {
  try {
    return await invoke<number>('cleanup_raw_monitor_cache_lru');
  } catch (error) {
    console.error('Failed to cleanup RAW monitor cache:', error);
    return 0;
  }
}

/**
 * Format bytes to human-readable string
 */
export function formatCacheSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
