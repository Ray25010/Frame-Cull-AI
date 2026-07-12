import { describe, expect, it } from 'vitest';
import { shouldKeepFaceByContent } from './faceContentValidation';
import type { FaceBox } from './faceDetectionGeometry';

function makeImageData(width: number, height: number, painter: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = painter(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  return { data, width, height } as ImageData;
}

function faceBox(): FaceBox {
  return {
    x: 0,
    y: 0,
    width: 80,
    height: 80,
    confidence: 0.82,
    source: 'full',
    detector: 'yunet',
  };
}

describe('face content validation', () => {
  it('rejects wheel-like circular dark ring candidates', () => {
    const imageData = makeImageData(80, 80, (x, y) => {
      const dx = (x - 40) / 40;
      const dy = (y - 40) / 40;
      const radius = Math.hypot(dx, dy);
      if (radius < 0.24) return [30, 31, 32];
      if (radius > 0.31 && radius < 0.52) {
        const spoke = Math.abs(Math.sin(Math.atan2(dy, dx) * 6)) > 0.78;
        return spoke ? [175, 175, 172] : [36, 37, 38];
      }
      return [92, 93, 92];
    });

    expect(shouldKeepFaceByContent(imageData, faceBox(), {
      detectorOnly: true,
      structureScore: 0.58,
    })).toBe(false);
  });

  it('keeps a plausible warm non-ring face patch', () => {
    const imageData = makeImageData(80, 80, (x, y) => {
      const dx = (x - 40) / 40;
      const dy = (y - 40) / 40;
      const shade = Math.max(0, 1 - Math.hypot(dx, dy) * 0.22);
      const eye = (Math.abs(y - 31) < 3 && (Math.abs(x - 28) < 5 || Math.abs(x - 52) < 5));
      if (eye) return [70, 45, 36];
      return [
        Math.round(190 * shade),
        Math.round(126 * shade),
        Math.round(92 * shade),
      ];
    });

    expect(shouldKeepFaceByContent(imageData, faceBox(), {
      hasConfirmedLandmarks: true,
      structureScore: 0.74,
    })).toBe(true);
  });
});
