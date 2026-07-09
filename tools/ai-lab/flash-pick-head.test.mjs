import { describe, expect, it } from 'vitest';
import {
  assertNoForbiddenFeatureLeakage,
  featureVectorFromRecord,
  FLASH_PICK_HEAD_FEATURES,
  scoreLinearHead,
  selectAiPicksForRecords,
} from './flash-pick-head.mjs';

function makeRecord(id, overrides = {}) {
  return {
    id,
    fileName: `${id}.JPG`,
    sourceName: `C:\\photos\\${id}.JPG`,
    sourceFolder: 'photos',
    numericId: Number(id.match(/(\d+)/)?.[1] ?? 0),
    status: 'DONE',
    hardIssueCodes: [],
    reviewHintCodes: [],
    issueCodes: [],
    exclusionReasons: [],
    overall: 72,
    technical: 72,
    aesthetic: 72,
    scene: 72,
    focusTexture: 70,
    focusPeakTexture: 74,
    focusReliability: 0.72,
    focusReliable: true,
    ...overrides,
  };
}

function makeHead(weightByFeature) {
  return {
    name: 'test-head',
    features: FLASH_PICK_HEAD_FEATURES,
    means: Array(FLASH_PICK_HEAD_FEATURES.length).fill(0),
    scales: Array(FLASH_PICK_HEAD_FEATURES.length).fill(1),
    weights: FLASH_PICK_HEAD_FEATURES.map(feature => weightByFeature[feature] ?? 0),
    bias: 0,
  };
}

describe('Flash tiny pick head helpers', () => {
  it('keeps rank features free of labels, paths, names, and manual state', () => {
    expect(() => assertNoForbiddenFeatureLeakage(FLASH_PICK_HEAD_FEATURES)).not.toThrow();
    expect(() => assertNoForbiddenFeatureLeakage(['overall', 'rating'])).toThrow(/feature leakage/i);
    expect(() => assertNoForbiddenFeatureLeakage(['technical', 'sourcePath'])).toThrow(/feature leakage/i);
  });

  it('builds deterministic feature vectors without label or filename fields', () => {
    const record = makeRecord('IMG_1001', {
      rating: 5,
      sourceName: 'C:\\secret\\IMG_1001.JPG',
      trainingLabel: { positive: true, rating: 5 },
    });
    const first = featureVectorFromRecord(record);
    const second = featureVectorFromRecord({ ...record, rating: 0, sourceName: 'D:\\other\\renamed.JPG' });

    expect(first).toEqual(second);
    expect(first).toHaveLength(FLASH_PICK_HEAD_FEATURES.length);
  });

  it('lets scene and aesthetic lift a scenic frame without portrait-only features', () => {
    const head = makeHead({
      scene: 1,
      aesthetic: 0.8,
      technical: 0.2,
      focusReliability: 4,
    });
    const scenic = makeRecord('IMG_1001', {
      technical: 44,
      aesthetic: 88,
      scene: 90,
      focusTexture: 28,
      focusPeakTexture: 72,
      focusReliability: 0.5,
    });
    const plain = makeRecord('IMG_1002', {
      technical: 70,
      aesthetic: 58,
      scene: 56,
      focusReliability: 0.7,
    });

    expect(scoreLinearHead(scenic, head)).toBeGreaterThan(scoreLinearHead(plain, head));
  });

  it('does not allow a high head score to rescue hard issues', () => {
    const head = makeHead({ aesthetic: 10, scene: 10, overall: 10 });
    const hardIssue = makeRecord('IMG_1001', {
      hardIssueCodes: ['OUT_OF_FOCUS'],
      aesthetic: 100,
      scene: 100,
      overall: 100,
    });
    const usable = makeRecord('IMG_1002', {
      aesthetic: 40,
      scene: 40,
      overall: 45,
      technical: 45,
    });
    const picked = selectAiPicksForRecords([hardIssue, usable], {
      groups: [],
      pairSimilarityMap: new Map(),
    }, record => scoreLinearHead(record, head), 1);

    expect(picked).toEqual(new Set(['IMG_1002']));
  });
});
