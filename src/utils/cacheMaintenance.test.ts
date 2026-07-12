import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAppCaches, getAppCacheUsage } from './cacheMaintenance';

vi.mock('./rawLoader', () => ({
  clearRawCache: vi.fn(),
}));

vi.mock('./imagePreloader', () => ({
  clearImagePreloadCache: vi.fn(),
}));

vi.mock('./jpegThumbnailLoader', () => ({
  clearJpegThumbnailMemoryCache: vi.fn(),
}));

describe('cache maintenance', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
    });
  });

  it('clears analysis and photo state caches but keeps preferences', async () => {
    localStorage.setItem('framecull-ai-cache-v2', '{}');
    localStorage.setItem('framecull-photo-state-cache-v1', '{}');
    localStorage.setItem('framecull-language', 'zh');
    localStorage.setItem('framecull-ai-settings', '{"sensitivity":"standard"}');

    const result = await clearAppCaches();

    expect(result.clearedPersistent).toBe(2);
    expect(result.clearedDiskBytes).toBe(0);
    expect(localStorage.getItem('framecull-ai-cache-v2')).toBeNull();
    expect(localStorage.getItem('framecull-photo-state-cache-v1')).toBeNull();
    expect(localStorage.getItem('framecull-language')).toBe('zh');
    expect(localStorage.getItem('framecull-ai-settings')).toBe('{"sensitivity":"standard"}');
  });

  it('reports persistent cache usage without Tauri disk cache access', async () => {
    localStorage.setItem('framecull-ai-cache-v2', 'abc');
    localStorage.setItem('framecull-photo-state-cache-v1', '12345');

    const usage = await getAppCacheUsage();

    expect(usage.persistentEntries).toBe(2);
    expect(usage.persistentBytes).toBeGreaterThan(8);
    expect(usage.diskBytes).toBe(0);
    expect(usage.diskAvailable).toBe(false);
    expect(usage.totalBytes).toBe(usage.persistentBytes);
  });
});
