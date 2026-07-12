import { describe, expect, it } from 'vitest';
import { createFaceConfirmationCrop } from './people-split-crop-confirmation';

describe('people split crop confirmation', () => {
  it('creates a square expanded crop and maps the candidate into crop coordinates', () => {
    const result = createFaceConfirmationCrop(
      { x: 0.4, y: 0.4, width: 0.2, height: 0.1 },
      1000,
      1000,
      1.8,
    );

    expect(result.crop.x).toBeCloseTo(0.32);
    expect(result.crop.y).toBeCloseTo(0.27);
    expect(result.crop.width).toBeCloseTo(0.36);
    expect(result.crop.height).toBeCloseTo(0.36);
    expect(result.candidateInCrop).toMatchObject({
      x: expect.closeTo(2 / 9),
      y: expect.closeTo(13 / 36),
      width: expect.closeTo(5 / 9),
      height: expect.closeTo(5 / 18),
    });
  });

  it('shifts an edge crop inside the image without shrinking it', () => {
    const result = createFaceConfirmationCrop(
      { x: 0.02, y: 0.02, width: 0.1, height: 0.1 },
      1000,
      1000,
      2,
    );

    expect(result.crop).toEqual({ x: 0, y: 0, width: 0.2, height: 0.2 });
    expect(result.candidateInCrop).toMatchObject({
      x: expect.closeTo(0.1),
      y: expect.closeTo(0.1),
      width: expect.closeTo(0.5),
      height: expect.closeTo(0.5),
    });
  });

  it('keeps the crop square in pixels for a non-square image', () => {
    const result = createFaceConfirmationCrop(
      { x: 0.4, y: 0.4, width: 0.1, height: 0.1 },
      1200,
      800,
      2,
    );

    expect(result.crop.width).toBeCloseTo(0.2);
    expect(result.crop.height).toBeCloseTo(0.3);
    expect(result.crop.width * 1200).toBeCloseTo(result.crop.height * 800);
  });
});
