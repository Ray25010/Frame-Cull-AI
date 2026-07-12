import { describe, expect, it } from 'vitest';
import { matchFaceDetectorBoxes } from './people-split-detector-confirmation';

describe('people split detector confirmation', () => {
  it('confirms a candidate with the highest-overlap detector box', () => {
    const [result] = matchFaceDetectorBoxes(
      [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      [
        { x: 0.12, y: 0.12, width: 0.2, height: 0.2 },
        { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      ],
      0.18,
    );

    expect(result).toEqual({
      candidateIndex: 0,
      confirmingBoxIndex: 1,
      confirmed: true,
      bestIoU: 1,
      reason: 'CONFIRMED',
    });
  });

  it('keeps a candidate unconfirmed when overlap is below the threshold', () => {
    const [result] = matchFaceDetectorBoxes(
      [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      [{ x: 0.28, y: 0.28, width: 0.2, height: 0.2 }],
      0.18,
    );

    expect(result).toMatchObject({
      candidateIndex: 0,
      confirmingBoxIndex: 0,
      confirmed: false,
      reason: 'LOW_IOU',
    });
    expect(result.bestIoU).toBeGreaterThan(0);
    expect(result.bestIoU).toBeLessThan(0.18);
  });

  it('reports the absence of confirming detector boxes', () => {
    const [result] = matchFaceDetectorBoxes(
      [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      [],
      0.18,
    );

    expect(result).toEqual({
      candidateIndex: 0,
      confirmed: false,
      bestIoU: 0,
      reason: 'NO_CONFIRMING_BOX',
    });
  });
});
