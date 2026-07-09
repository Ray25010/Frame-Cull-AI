import { describe, expect, it } from 'vitest';
import { bilateralBlinkClosedScore, bilateralEarClosedScore } from './eyeScoring';

describe('eye scoring helpers', () => {
  it('requires bilateral blink evidence instead of treating a one-eye blink as closed eyes', () => {
    const oneEyeBlink = bilateralBlinkClosedScore(0.96, 0.08, 0.9);
    const bothEyesBlink = bilateralBlinkClosedScore(0.86, 0.82, 0.9);

    expect(oneEyeBlink).toBeLessThan(0.3);
    expect(bothEyesBlink).toBeGreaterThan(0.82);
  });

  it('scores EAR fallback from both eyes in the same direction as blink scores', () => {
    const oneEyeClosed = bilateralEarClosedScore(0.14, 0.34, 0.9);
    const bothEyesClosed = bilateralEarClosedScore(0.15, 0.16, 0.9);

    expect(oneEyeClosed).toBe(0);
    expect(bothEyesClosed).toBeGreaterThan(0.9);
  });

  it('keeps low-pose-reliability eye evidence more conservative', () => {
    const reliable = bilateralEarClosedScore(0.15, 0.16, 0.9);
    const unreliable = bilateralEarClosedScore(0.15, 0.16, 0.2);

    expect(unreliable).toBeLessThan(reliable);
    expect(unreliable).toBeGreaterThan(0);
  });
});
