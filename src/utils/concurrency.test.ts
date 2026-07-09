import { describe, expect, it } from 'vitest';
import {
  chooseAiCullingConcurrency,
  chooseAiPreparationConcurrency,
  choosePeopleSplitConcurrency,
  choosePeopleSplitPreparationConcurrency,
} from './concurrency';

describe('concurrency strategy', () => {
  it('uses six AI workers on high-thread machines when frame gaps stay controlled', () => {
    expect(chooseAiCullingConcurrency({ logicalCores: 20 })).toBe(6);
    expect(chooseAiCullingConcurrency({ logicalCores: 16 })).toBe(6);
  });

  it('keeps mid-range AI worker counts conservative', () => {
    expect(chooseAiCullingConcurrency({ logicalCores: 12 })).toBe(5);
    expect(chooseAiCullingConcurrency({ logicalCores: 8 })).toBe(4);
    expect(chooseAiCullingConcurrency({ logicalCores: 6 })).toBe(3);
    expect(chooseAiCullingConcurrency({ logicalCores: 4 })).toBe(2);
  });

  it('caps AI workers on low-memory browsers', () => {
    expect(chooseAiCullingConcurrency({ logicalCores: 20, deviceMemoryGb: 4 })).toBe(3);
  });

  it('keeps AI image preparation conservative to preserve viewer latency', () => {
    expect(chooseAiPreparationConcurrency({ logicalCores: 20 })).toBe(4);
    expect(chooseAiPreparationConcurrency({ logicalCores: 16 })).toBe(4);
    expect(chooseAiPreparationConcurrency({ logicalCores: 12 })).toBe(3);
    expect(chooseAiPreparationConcurrency({ logicalCores: 8 })).toBe(2);
    expect(chooseAiPreparationConcurrency({ logicalCores: 4 })).toBe(1);
    expect(chooseAiPreparationConcurrency({ logicalCores: 20, deviceMemoryGb: 4 })).toBe(3);
  });

  it('keeps people split more conservative while AI culling is running', () => {
    expect(choosePeopleSplitConcurrency(true, { logicalCores: 20 })).toBe(3);
    expect(choosePeopleSplitConcurrency(true, { logicalCores: 12 })).toBe(2);
    expect(choosePeopleSplitConcurrency(true, { logicalCores: 8 })).toBe(1);
  });

  it('uses higher people split concurrency when AI culling is idle', () => {
    expect(choosePeopleSplitConcurrency(false, { logicalCores: 20 })).toBe(5);
    expect(choosePeopleSplitConcurrency(false, { logicalCores: 12 })).toBe(4);
    expect(choosePeopleSplitConcurrency(false, { logicalCores: 8 })).toBe(3);
  });

  it('keeps people split image preparation on a small main-thread budget', () => {
    expect(choosePeopleSplitPreparationConcurrency(false, { logicalCores: 20 })).toBe(2);
    expect(choosePeopleSplitPreparationConcurrency(false, { logicalCores: 12 })).toBe(2);
    expect(choosePeopleSplitPreparationConcurrency(false, { logicalCores: 8 })).toBe(1);
    expect(choosePeopleSplitPreparationConcurrency(true, { logicalCores: 20 })).toBe(1);
    expect(choosePeopleSplitPreparationConcurrency(false, { logicalCores: 20, deviceMemoryGb: 4 })).toBe(2);
  });
});
