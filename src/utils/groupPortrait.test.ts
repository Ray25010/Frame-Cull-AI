import { describe, expect, it } from 'vitest';
import type { AiFaceDiagnostic } from '../types';
import { detectGroupPortrait } from './groupPortrait';

function face(index: number, overrides: Partial<AiFaceDiagnostic> = {}): AiFaceDiagnostic {
  return {
    index,
    x: 0.1 + index * 0.16,
    y: 0.26,
    width: 0.11,
    height: 0.14,
    faceSizeRatio: 0.14,
    faceQualityScore: 0.82,
    eyeReliability: 0.82,
    poseReliability: 0.82,
    landmarkerStatus: 'OK',
    closed: false,
    ...overrides,
  };
}

describe('detectGroupPortrait', () => {
  it('does not classify a compact three-person row as a group portrait anymore', () => {
    const result = detectGroupPortrait([
      face(0, { x: 0.16, y: 0.28 }),
      face(1, { x: 0.43, y: 0.27, width: 0.105, height: 0.135, faceSizeRatio: 0.135 }),
      face(2, { x: 0.68, y: 0.29, width: 0.108, height: 0.138, faceSizeRatio: 0.138 }),
    ]);

    expect(result.photoKind).toBe('STANDARD');
    expect(result.groupFaceIndices).toEqual([]);
    expect(result.groupFaceCount).toBe(0);
    expect(result.groupPortraitReason).toContain('Fewer than five');
  });

  it('classifies a tidy five-person single-row lineup as a group portrait', () => {
    const result = detectGroupPortrait([
      face(0, { x: 0.08, y: 0.24, width: 0.092, height: 0.118, faceSizeRatio: 0.118 }),
      face(1, { x: 0.24, y: 0.245, width: 0.093, height: 0.119, faceSizeRatio: 0.119 }),
      face(2, { x: 0.4, y: 0.238, width: 0.094, height: 0.12, faceSizeRatio: 0.12 }),
      face(3, { x: 0.56, y: 0.243, width: 0.091, height: 0.117, faceSizeRatio: 0.117 }),
      face(4, { x: 0.72, y: 0.24, width: 0.093, height: 0.118, faceSizeRatio: 0.118 }),
    ]);

    expect(result.photoKind).toBe('GROUP_PORTRAIT');
    expect(result.groupFaceCount).toBe(5);
    expect(result.groupPortraitReason).toContain('compact row');
  });

  it('classifies a larger group without any upper-count cap', () => {
    const result = detectGroupPortrait([
      face(0, { x: 0.05, y: 0.24, width: 0.07, height: 0.09, faceSizeRatio: 0.09 }),
      face(1, { x: 0.13, y: 0.23, width: 0.072, height: 0.092, faceSizeRatio: 0.092 }),
      face(2, { x: 0.21, y: 0.25, width: 0.071, height: 0.091, faceSizeRatio: 0.091 }),
      face(3, { x: 0.29, y: 0.24, width: 0.07, height: 0.09, faceSizeRatio: 0.09 }),
      face(4, { x: 0.37, y: 0.23, width: 0.073, height: 0.093, faceSizeRatio: 0.093 }),
      face(5, { x: 0.45, y: 0.24, width: 0.072, height: 0.094, faceSizeRatio: 0.094 }),
      face(6, { x: 0.53, y: 0.25, width: 0.071, height: 0.091, faceSizeRatio: 0.091 }),
      face(7, { x: 0.61, y: 0.24, width: 0.07, height: 0.09, faceSizeRatio: 0.09 }),
      face(8, { x: 0.69, y: 0.23, width: 0.072, height: 0.093, faceSizeRatio: 0.093 }),
      face(9, { x: 0.77, y: 0.24, width: 0.071, height: 0.092, faceSizeRatio: 0.092 }),
      face(10, { x: 0.85, y: 0.25, width: 0.07, height: 0.09, faceSizeRatio: 0.09 }),
      face(11, { x: 0.25, y: 0.39, width: 0.068, height: 0.088, faceSizeRatio: 0.088 }),
      face(12, { x: 0.37, y: 0.38, width: 0.07, height: 0.09, faceSizeRatio: 0.09 }),
    ]);

    expect(result.photoKind).toBe('GROUP_PORTRAIT');
    expect(result.groupFaceCount).toBe(13);
    expect(result.groupFaceIndices).toHaveLength(13);
  });

  it('keeps a normal multi-person shot as standard when one subject is much larger', () => {
    const result = detectGroupPortrait([
      face(0, { x: 0.08, y: 0.12, width: 0.23, height: 0.31, faceSizeRatio: 0.31 }),
      face(1, { x: 0.52, y: 0.29, width: 0.075, height: 0.095, faceSizeRatio: 0.095 }),
      face(2, { x: 0.7, y: 0.31, width: 0.07, height: 0.092, faceSizeRatio: 0.092 }),
      face(3, { x: 0.8, y: 0.28, width: 0.072, height: 0.094, faceSizeRatio: 0.094 }),
      face(4, { x: 0.6, y: 0.42, width: 0.068, height: 0.09, faceSizeRatio: 0.09 }),
    ]);

    expect(result.photoKind).toBe('STANDARD');
    expect(result.groupFaceIndices).toEqual([]);
    expect(result.groupPortraitReason).toContain('larger');
  });

  it('keeps loosely spaced passerby faces as standard', () => {
    const result = detectGroupPortrait([
      face(0, { x: 0.08, y: 0.12 }),
      face(1, { x: 0.46, y: 0.48 }),
      face(2, { x: 0.8, y: 0.2 }),
      face(3, { x: 0.62, y: 0.7 }),
      face(4, { x: 0.18, y: 0.62 }),
    ]);

    expect(result.photoKind).toBe('STANDARD');
    expect(result.groupPortraitReason).toContain('aligned');
  });

  it('ignores cropped edge faces when deciding group portraits', () => {
    const result = detectGroupPortrait([
      face(0, { x: 0.0, y: 0.22, width: 0.14, height: 0.18, faceSizeRatio: 0.18, poseReliability: 0.12 }),
      face(1, { x: 0.34, y: 0.28 }),
      face(2, { x: 0.53, y: 0.29 }),
      face(3, { x: 0.72, y: 0.28 }),
      face(4, { x: 0.18, y: 0.27 }),
      face(5, { x: 0.86, y: 0.27 }),
    ]);

    expect(result.photoKind).toBe('GROUP_PORTRAIT');
    expect(result.groupFaceIndices).toEqual([1, 2, 3, 4, 5]);
  });
});
