import { describe, expect, it } from 'vitest';
import { buildImportStageModel, getNotificationEnterDelay } from './reactBitsPilot';

describe('React Bits UI pilot presentation', () => {
  it('marks earlier import stages done and the current stage active', () => {
    expect(buildImportStageModel('metadata')).toEqual({
      railProgress: 66.666,
      states: ['done', 'done', 'active', 'waiting'],
    });
  });

  it('marks every import stage done when import completes', () => {
    expect(buildImportStageModel('done')).toEqual({
      railProgress: 100,
      states: ['done', 'done', 'done', 'done'],
    });
  });

  it('fails closed by showing every stage as error', () => {
    expect(buildImportStageModel('error').states).toEqual(['error', 'error', 'error', 'error']);
  });

  it('caps notification staggering after the fifth visible item', () => {
    expect(getNotificationEnterDelay(0)).toBe('0ms');
    expect(getNotificationEnterDelay(3)).toBe('135ms');
    expect(getNotificationEnterDelay(9)).toBe('180ms');
  });
});
