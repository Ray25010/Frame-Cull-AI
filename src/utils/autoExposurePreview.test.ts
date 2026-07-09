import { describe, expect, it } from 'vitest';
import {
  computeAutoExposureAdjustment,
  computeLumaStatsFromRgba,
} from './autoExposurePreview';

function solidRgba(width: number, height: number, gray: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = gray;
    data[index + 1] = gray;
    data[index + 2] = gray;
    data[index + 3] = 255;
  }
  return data;
}

describe('auto exposure preview', () => {
  it('brightens underexposed previews conservatively', () => {
    const stats = computeLumaStatsFromRgba(solidRgba(64, 64, 74), 64, 64);
    const adjustment = computeAutoExposureAdjustment(stats);

    expect(adjustment.ev).toBeGreaterThan(0.25);
    expect(adjustment.brightness).toBeGreaterThan(1);
    expect(adjustment.reason).toBe('median-target');
  });

  it('does not turn dark mood frames into daylight', () => {
    const stats = computeLumaStatsFromRgba(solidRgba(64, 64, 28), 64, 64);
    const adjustment = computeAutoExposureAdjustment(stats);

    expect(adjustment.ev).toBeGreaterThan(0);
    expect(adjustment.ev).toBeLessThanOrEqual(0.65);
    expect(adjustment.reason).toBe('dark-scene-conservative');
  });

  it('protects clipped highlights instead of blindly brightening', () => {
    const data = solidRgba(64, 64, 90);
    for (let index = 0; index < data.length / 4; index += 3) {
      const offset = index * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
    }

    const stats = computeLumaStatsFromRgba(data, 64, 64);
    const adjustment = computeAutoExposureAdjustment(stats);

    expect(stats.clippedHighlightRatio).toBeGreaterThan(0.04);
    expect(adjustment.ev).toBeLessThanOrEqual(0);
    expect(adjustment.reason).toBe('heavy-clipping-protected');
  });

  it('returns a neutral low-confidence adjustment for empty samples', () => {
    const stats = computeLumaStatsFromRgba(new Uint8ClampedArray(), 0, 0);
    const adjustment = computeAutoExposureAdjustment(stats);

    expect(adjustment.ev).toBe(0);
    expect(adjustment.brightness).toBe(1);
    expect(adjustment.confidence).toBe('low');
  });
});
