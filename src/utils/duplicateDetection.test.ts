import { describe, expect, it } from 'vitest';
import { GroupStatus, SelectionState, type AiDuplicateSignature, type PhotoGroup, type PhotoRating } from '../types';
import {
  buildDuplicateSignature,
  classifyDuplicateGroups,
  compactDuplicateBuckets,
  duplicatePairSimilarities,
  duplicatePhotoIds,
  duplicateSimilarity,
  DUPLICATE_SIGNATURE_VERSION,
} from './duplicateDetection';

const baseSignature: AiDuplicateSignature = {
  version: DUPLICATE_SIGNATURE_VERSION,
  width: 1600,
  height: 1067,
  aspectRatio: 1600 / 1067,
  lumaHash: '0000000000000000',
  structureHash: '0000000000000000',
  colorHistogram: [0.5, 0.25, 0.25, ...new Array(21).fill(0)],
  lumaHistogram: [0.1, 0.2, 0.4, 0.2, 0.1, ...new Array(11).fill(0)],
  meanLuma: 110,
};

function signature(overrides: Partial<AiDuplicateSignature> = {}): AiDuplicateSignature {
  return {
    ...baseSignature,
    ...overrides,
  };
}

function photo(
  id: string,
  duplicateSignature: AiDuplicateSignature,
  overrides: Partial<PhotoGroup> = {},
): PhotoGroup {
  return {
    id,
    status: GroupStatus.COMPLETE,
    selection: SelectionState.UNMARKED,
    rating: 0,
    jpg: {
      name: `${id}.JPG`,
      extension: 'JPG',
      file: null as unknown as File,
      previewUrl: `asset://${id}.JPG`,
      size: 2048,
      modifiedMs: 1710000000000 + Number(id.replace(/\D+/g, '') || 0) * 1000,
      path: `C:/photos/${id}.JPG`,
    },
    ai: {
      status: 'DONE',
      issues: [],
      confidence: 0.82,
      preset: 'standard',
      reviewed: false,
      modelVersion: 'test-model',
      duplicateSignature,
      photoScore: {
        version: 'test-score',
        overall: 78,
        grade: 'GOOD',
        summary: 'Good',
        components: [
          { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 74, weight: 35 },
          { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 76, weight: 25 },
          { key: 'SCENE_FIT', label: 'Scene', score: 76, weight: 15 },
          { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 78, weight: 15 },
          { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
        ],
        gates: {
          aiPickedEligible: true,
          technicalPass: true,
          duplicateBestPass: true,
          reasons: [],
        },
      },
    },
    ...overrides,
  };
}

describe('duplicate signatures', () => {
  it('builds a stable lightweight signature from analysis image data', () => {
    const imageData = makeImageData(16, 12, (x, y) => {
      const value = (x * 12 + y * 5) % 255;
      return [value, 180 - value / 2, 80 + y * 6, 255];
    });

    const result = buildDuplicateSignature(imageData as ImageData);

    expect(result.version).toBe(DUPLICATE_SIGNATURE_VERSION);
    expect(result.width).toBe(16);
    expect(result.height).toBe(12);
    expect(result.lumaHash).toHaveLength(16);
    expect(result.structureHash).toHaveLength(16);
    expect(result.colorHistogram).toHaveLength(24);
    expect(result.lumaHistogram).toHaveLength(16);
  });

  it('scores identical signatures as the same frame', () => {
    expect(duplicateSimilarity(baseSignature, signature())).toBe(1);
  });
});

describe('duplicate grouping', () => {
  it('skips grouping when duplicate detection is off', () => {
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature()),
      photo('IMG_0002', signature()),
    ], 'off', true);

    expect(groups).toEqual([]);
  });

  it('groups near-identical frames and exposes duplicate photo ids', () => {
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature()),
      photo('IMG_0002', signature({
        lumaHash: '0000000000000001',
        structureHash: '0000000000000001',
      })),
      photo('IMG_0099', signature({
        lumaHash: 'ffffffffffffffff',
        structureHash: 'ffffffffffffffff',
        colorHistogram: new Array(24).fill(0).map((_, index) => (index === 7 || index === 15 || index === 23 ? 1 : 0)),
        lumaHistogram: new Array(16).fill(0).map((_, index) => (index === 15 ? 1 : 0)),
        meanLuma: 240,
      })),
    ], 'standard', true);

    expect(groups).toHaveLength(1);
    expect(groups[0].photoIds).toEqual(['IMG_0001', 'IMG_0002']);
    expect(duplicatePhotoIds(groups)).toEqual(new Set(['IMG_0001', 'IMG_0002']));
  });

  it('uses sensitivity thresholds for standard versus strict matching', () => {
    const nearFrame = signature({
      lumaHash: '0000000000000fff',
      structureHash: '0000000000000fff',
    });
    const photos = [
      photo('IMG_0001', signature()),
      photo('IMG_0002', nearFrame),
    ];

    expect(classifyDuplicateGroups(photos, 'standard', true)).toHaveLength(1);
    expect(classifyDuplicateGroups(photos, 'strict', true)).toHaveLength(0);
  });

  it('does not chain-merge frames that are not mutually similar', () => {
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature({
        lumaHash: hashWithLeadingOnes(0),
        structureHash: hashWithLeadingOnes(0),
      })),
      photo('IMG_0002', signature({
        lumaHash: hashWithLeadingOnes(10),
        structureHash: hashWithLeadingOnes(10),
      })),
      photo('IMG_0003', signature({
        lumaHash: hashWithLeadingOnes(20),
        structureHash: hashWithLeadingOnes(20),
      })),
    ], 'standard', true);

    expect(groups).toHaveLength(1);
    expect(groups[0].photoIds).toEqual(['IMG_0001', 'IMG_0002']);
    expect(groups[0].photoIds).not.toContain('IMG_0003');
  });

  it('exposes candidate pair similarities for lab tuning', () => {
    const pairs = duplicatePairSimilarities([
      photo('IMG_0001', signature()),
      photo('IMG_0002', signature({
        lumaHash: '0000000000000001',
        structureHash: '0000000000000001',
      })),
      photo('IMG_0100', signature({
        lumaHash: 'ffffffffffffffff',
        structureHash: 'ffffffffffffffff',
      })),
    ], 'standard');

    expect(pairs.some(pair => pair.leftId === 'IMG_0001' && pair.rightId === 'IMG_0002' && pair.candidate)).toBe(true);
    expect(pairs.find(pair => pair.leftId === 'IMG_0001' && pair.rightId === 'IMG_0002')?.numericGap).toBe(1);
  });

  it('uses capture time to find renamed near-duplicate candidates', () => {
    const pairs = duplicatePairSimilarities([
      photo('renamed-select-a', signature(), {
        exif: { dateTime: '2026:06:17 10:00:00' },
      }),
      photo('client-favorite-final', signature({
        lumaHash: '0000000000000001',
        structureHash: '0000000000000001',
      }), {
        exif: { dateTime: '2026:06:17 10:00:05' },
      }),
    ], 'standard');

    const pair = pairs.find(item => item.leftId === 'renamed-select-a' && item.rightId === 'client-favorite-final');
    expect(pair?.candidate).toBe(true);
    expect(pair?.timeGapMs).toBe(5000);
    expect(pair?.numericGap).toBeUndefined();
  });

  it('does not treat nearby filename suffixes as duplicate candidates when capture times are far apart', () => {
    const groups = classifyDuplicateGroups([
      photo('IMG_7000', signature(), {
        exif: { dateTime: '2026:06:17 10:00:00' },
      }),
      photo('IMG_7001', signature({
        lumaHash: '0000000000000001',
        structureHash: '0000000000000001',
      }), {
        exif: { dateTime: '2026:06:17 12:30:00' },
      }),
    ], 'standard', true);

    expect(groups).toHaveLength(0);
  });

  it('splits oversized compact duplicate buckets for representative tuning', () => {
    const photos = Array.from({ length: 7 }, (_, index) => photo(`IMG_100${index}`, signature()));
    const buckets = compactDuplicateBuckets(photos, 'standard', { maxGroupSize: 3 });

    expect(buckets.map(bucket => bucket.photoIds.length)).toEqual([3, 3]);
  });

  it('prefers manual picks and ratings for the trophy recommendation', () => {
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature(), {
        rating: 1 as PhotoRating,
      }),
      photo('IMG_0002', signature(), {
        selection: SelectionState.PICKED,
        rating: 5 as PhotoRating,
      }),
    ], 'standard', true);

    expect(groups[0].bestPhotoId).toBe('IMG_0002');
    expect(groups[0].matches.find(match => match.photoId === 'IMG_0002')?.reason).toBe('manual-pick');
  });

  it('can leave a group without a forced best recommendation', () => {
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature()),
      photo('IMG_0002', signature()),
    ], 'standard', false);

    expect(groups[0].bestPhotoId).toBeUndefined();
    expect(groups[0].matches.every(match => !match.isBest)).toBe(true);
  });

  it('does not recommend a technically weak duplicate as best', () => {
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature(), {
        ai: {
          ...photo('IMG_0001', signature()).ai!,
          photoScore: {
            version: 'test-score',
            overall: 82,
            grade: 'GOOD',
            summary: 'Sharp',
            components: [
              { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 82, weight: 35 },
              { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 76, weight: 25 },
              { key: 'SCENE_FIT', label: 'Scene', score: 80, weight: 15 },
              { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 78, weight: 15 },
              { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
            ],
          },
        },
      }),
      photo('IMG_0002', signature(), {
        ai: {
          ...photo('IMG_0002', signature()).ai!,
          photoScore: {
            version: 'test-score',
            overall: 84,
            grade: 'GOOD',
            summary: 'Pretty but blurry',
            components: [
              { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 42, weight: 35 },
              { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 94, weight: 25 },
              { key: 'SCENE_FIT', label: 'Scene', score: 90, weight: 15 },
              { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 88, weight: 15 },
              { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
            ],
          },
        },
      }),
    ], 'standard', true);

    expect(groups[0].bestPhotoId).toBe('IMG_0001');
  });

  it('does not recommend a duplicate with hard AI issues as best', () => {
    const hardIssue = {
      code: 'OUT_OF_FOCUS' as const,
      level: 'ISSUE' as const,
      confidence: 0.9,
      score: 18,
      threshold: 35,
      message: 'Soft focus',
    };
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature(), {
        ai: {
          ...photo('IMG_0001', signature()).ai!,
          issues: [hardIssue],
          photoScore: {
            version: 'test-score',
            overall: 95,
            grade: 'EXCELLENT',
            summary: 'High score but issue',
            components: [
              { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 90, weight: 35 },
              { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 94, weight: 25 },
              { key: 'SCENE_FIT', label: 'Scene', score: 90, weight: 15 },
              { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 88, weight: 15 },
              { key: 'AI_RISK', label: 'Risk', score: 20, weight: 10 },
            ],
          },
        },
      }),
      photo('IMG_0002', signature(), {
        ai: {
          ...photo('IMG_0002', signature()).ai!,
          photoScore: {
            version: 'test-score',
            overall: 76,
            grade: 'GOOD',
            summary: 'Usable',
            components: [
              { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 74, weight: 35 },
              { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 72, weight: 25 },
              { key: 'SCENE_FIT', label: 'Scene', score: 75, weight: 15 },
              { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 80, weight: 15 },
              { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
            ],
          },
        },
      }),
    ], 'standard', true);

    expect(groups[0].bestPhotoId).toBe('IMG_0002');
  });

  it('does not recommend a duplicate with AI review hints as best', () => {
    const reviewHint = {
      code: 'OUT_OF_FOCUS' as const,
      level: 'REVIEW_HINT' as const,
      confidence: 0.72,
      score: 30,
      threshold: 35,
      message: 'Possible soft focus',
    };
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature(), {
        ai: {
          ...photo('IMG_0001', signature()).ai!,
          issues: [reviewHint],
          photoScore: {
            version: 'test-score',
            overall: 92,
            grade: 'EXCELLENT',
            summary: 'High score but review hint',
            components: [
              { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 88, weight: 35 },
              { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 90, weight: 25 },
              { key: 'SCENE_FIT', label: 'Scene', score: 90, weight: 15 },
              { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 88, weight: 15 },
              { key: 'AI_RISK', label: 'Risk', score: 80, weight: 10 },
            ],
          },
        },
      }),
      photo('IMG_0002', signature(), {
        ai: {
          ...photo('IMG_0002', signature()).ai!,
          photoScore: {
            version: 'test-score',
            overall: 76,
            grade: 'GOOD',
            summary: 'Usable',
            components: [
              { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 74, weight: 35 },
              { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 72, weight: 25 },
              { key: 'SCENE_FIT', label: 'Scene', score: 75, weight: 15 },
              { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 80, weight: 15 },
              { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
            ],
          },
        },
      }),
    ], 'standard', true);

    expect(groups[0].bestPhotoId).toBe('IMG_0002');
  });

  it('leaves best empty when every duplicate frame has hard issues', () => {
    const hardIssue = {
      code: 'OUT_OF_FOCUS' as const,
      level: 'ISSUE' as const,
      confidence: 0.9,
      score: 18,
      threshold: 35,
      message: 'Soft focus',
    };
    const groups = classifyDuplicateGroups([
      photo('IMG_0001', signature(), { ai: { ...photo('IMG_0001', signature()).ai!, issues: [hardIssue] } }),
      photo('IMG_0002', signature(), { ai: { ...photo('IMG_0002', signature()).ai!, issues: [hardIssue] } }),
    ], 'standard', true);

    expect(groups[0].bestPhotoId).toBeUndefined();
  });
});

function makeImageData(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = a;
    }
  }
  return { width, height, data };
}

function hashWithLeadingOnes(count: number) {
  const bits = `${'1'.repeat(count)}${'0'.repeat(Math.max(0, 64 - count))}`;
  let hex = '';
  for (let index = 0; index < bits.length; index += 4) {
    hex += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
  }
  return hex;
}
