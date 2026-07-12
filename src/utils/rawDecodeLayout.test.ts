import { describe, expect, it } from 'vitest';
import { collectDimensionCandidates, extractPixelData, resolveImageLayout, writeRgba } from './rawDecodeLayout';

describe('raw decode layout helpers', () => {
  it('keeps typed-array image data instead of accidentally unwrapping to ArrayBuffer', () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const extracted = extractPixelData(pixels);

    expect(extracted).toBeInstanceOf(Uint8Array);
    expect(Array.from(extracted as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('unwraps typed data from a buffer-backed object and resolves the layout', () => {
    const pixels = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const extracted = extractPixelData({
      data: pixels,
      length: pixels.length,
      buffer: pixels.buffer,
      byteOffset: 0,
      byteLength: pixels.byteLength,
    });

    const layout = resolveImageLayout(extracted, { width: 1, height: 2 }, { width: 1, height: 2 });
    expect(layout).toEqual({ width: 1, height: 2, channels: 3 });
  });

  it('produces rgba output for single-channel data', () => {
    const rgba = new Uint8ClampedArray(8);
    writeRgba(new Uint8Array([12, 34]), rgba, 2, 1);
    expect(Array.from(rgba)).toEqual([12, 12, 12, 255, 34, 34, 34, 255]);
  });

  it('collects width and half-size candidates', () => {
    const candidates = collectDimensionCandidates(
      { width: 4000, height: 3000, sizes: { raw_width: 4000, raw_height: 3000 } },
      { width: 2000, height: 1500 },
    );

    expect(candidates).toEqual(expect.arrayContaining([
      { width: 4000, height: 3000 },
      { width: 2000, height: 1500 },
    ]));
  });
});
