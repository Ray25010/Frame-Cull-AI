import { describe, expect, it } from 'vitest';
import { cacheReadyLabel } from './useRawMonitorViewerFrame.pro';

describe('RAW monitor fallback notices', () => {
  it('explains decoder fallback in Chinese', () => {
    expect(cacheReadyLabel('zh', true, 'decodeFailure')).toBe(
      'RAW 解码器无法读取，已使用相机内嵌预览',
    );
  });

  it('explains invalid engine output in English', () => {
    expect(cacheReadyLabel('en', true, 'invalidOutput')).toBe(
      'Invalid RAW engine output; using embedded camera preview',
    );
  });

  it('keeps the normal cache label for successful RAW development', () => {
    expect(cacheReadyLabel('zh', false)).toBe('RAW 监看缓存');
  });
});
