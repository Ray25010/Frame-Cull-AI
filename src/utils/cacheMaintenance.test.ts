import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAppCaches } from './cacheMaintenance';

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

  it('clears analysis and photo state caches but keeps preferences', () => {
    localStorage.setItem('framecull-ai-cache-v2', '{}');
    localStorage.setItem('framecull-photo-state-cache-v1', '{}');
    localStorage.setItem('framecull-language', 'zh');
    localStorage.setItem('framecull-ai-settings', '{"sensitivity":"standard"}');

    const result = clearAppCaches();

    expect(result.clearedPersistent).toBe(2);
    expect(localStorage.getItem('framecull-ai-cache-v2')).toBeNull();
    expect(localStorage.getItem('framecull-photo-state-cache-v1')).toBeNull();
    expect(localStorage.getItem('framecull-language')).toBe('zh');
    expect(localStorage.getItem('framecull-ai-settings')).toBe('{"sensitivity":"standard"}');
  });
});
