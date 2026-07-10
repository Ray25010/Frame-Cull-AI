import { describe, expect, it } from 'vitest';
import { decidePeopleFaceConfirmation } from './people-split-confirmation-policy';

describe('people split confirmation policy', () => {
  it('accepts a strong full-range overlap', () => {
    expect(decidePeopleFaceConfirmation({
      fullRangeIoU: 0.5,
      cropLandmarkerIoU: 0,
      cropLandmarkerSkinScore: 0,
    })).toEqual({ confirmed: true, reason: 'FULL_RANGE' });
  });

  it('accepts a well-overlapped landmarked crop with plausible skin content', () => {
    expect(decidePeopleFaceConfirmation({
      fullRangeIoU: 0,
      cropLandmarkerIoU: 0.5,
      cropLandmarkerSkinScore: 0.1,
    })).toEqual({ confirmed: true, reason: 'CROP_LANDMARKER' });
  });

  it('rejects a low-skin printed face even with strong landmark overlap', () => {
    expect(decidePeopleFaceConfirmation({
      fullRangeIoU: 0,
      cropLandmarkerIoU: 0.73,
      cropLandmarkerSkinScore: 0.003,
    })).toEqual({ confirmed: false, reason: 'UNCONFIRMED' });
  });

  it('rejects weak overlap from both confirmation paths', () => {
    expect(decidePeopleFaceConfirmation({
      fullRangeIoU: 0.49,
      cropLandmarkerIoU: 0.49,
      cropLandmarkerSkinScore: 0.9,
    })).toEqual({ confirmed: false, reason: 'UNCONFIRMED' });
  });
});
