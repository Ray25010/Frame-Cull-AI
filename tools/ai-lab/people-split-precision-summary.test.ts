import { describe, expect, it } from 'vitest';
import { summarizePeopleSplitPrecisionRun } from './people-split-precision-summary';

describe('people split precision summary', () => {
  it('reports complete processing, candidate tiers, clusters, and distance quantiles', () => {
    const summary = summarizePeopleSplitPrecisionRun({
      totalMs: 900,
      results: [
        {
          fileName: 'a.jpg',
          elapsedMs: 300,
          faces: [
            {
              key: 'a:0',
              admission: 'AUTO_ELIGIBLE',
              detectorConfirmed: true,
              fullRangeDetectorConfirmed: true,
              cropDetectorConfirmed: true,
              cropLandmarkerConfirmed: true,
              cropLandmarkerContentPlausible: true,
              nearestDistance: 0.12,
            },
            {
              key: 'a:1',
              admission: 'REVIEW_ONLY',
              detectorConfirmed: false,
              fullRangeDetectorConfirmed: false,
              cropDetectorConfirmed: true,
              cropLandmarkerConfirmed: false,
              nearestDistance: 0.44,
            },
          ],
        },
        {
          fileName: 'b.jpg',
          elapsedMs: 400,
          faces: [{ key: 'b:0', admission: 'REJECTED', detectorConfirmed: false }],
          confirmationError: 'MediaPipe unavailable',
          cropConfirmationError: 'Landmarker unavailable',
        },
        {
          fileName: 'c.jpg',
          elapsedMs: 200,
          faces: [],
          error: 'decode failed',
        },
      ],
      clusters: [
        { id: 'person-1', memberFaceKeys: ['a:0'] },
        { id: 'person-2', memberFaceKeys: ['b:0', 'c:0'] },
      ],
      unassignedFaceKeys: ['a:1'],
    });

    expect(summary).toMatchObject({
      photos: 3,
      processedPhotos: 2,
      failedPhotos: 1,
      detectedFaces: 3,
      autoEligibleFaces: 1,
      reviewOnlyFaces: 1,
      rejectedFaces: 1,
      detectorConfirmedFaces: 1,
      detectorUnconfirmedFaces: 2,
      fullRangeDetectorConfirmedFaces: 1,
      confirmationFailedPhotos: 1,
      cropDetectorConfirmedFaces: 2,
      cropLandmarkerConfirmedFaces: 1,
      cropLandmarkerContentPlausibleFaces: 1,
      cropConfirmationFailedPhotos: 1,
      clusters: 2,
      clusteredFaces: 3,
      unassignedFaces: 1,
      totalMs: 900,
    });
    expect(summary.distanceQuantiles).toEqual({ p10: 0.12, p50: 0.12, p90: 0.44 });
  });
});
