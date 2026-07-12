export const PEOPLE_FACE_FULL_RANGE_MIN_IOU = 0.5;
export const PEOPLE_FACE_CROP_LANDMARKER_MIN_IOU = 0.5;
export const PEOPLE_FACE_CROP_LANDMARKER_MIN_SKIN = 0.1;

export type PeopleFaceConfirmationReason = 'FULL_RANGE' | 'CROP_LANDMARKER' | 'UNCONFIRMED';

export function decidePeopleFaceConfirmation(evidence: {
  fullRangeIoU: number;
  cropLandmarkerIoU: number;
  cropLandmarkerSkinScore: number;
}): { confirmed: boolean; reason: PeopleFaceConfirmationReason } {
  if (evidence.fullRangeIoU >= PEOPLE_FACE_FULL_RANGE_MIN_IOU) {
    return { confirmed: true, reason: 'FULL_RANGE' };
  }
  if (
    evidence.cropLandmarkerIoU >= PEOPLE_FACE_CROP_LANDMARKER_MIN_IOU
    && evidence.cropLandmarkerSkinScore >= PEOPLE_FACE_CROP_LANDMARKER_MIN_SKIN
  ) {
    return { confirmed: true, reason: 'CROP_LANDMARKER' };
  }
  return { confirmed: false, reason: 'UNCONFIRMED' };
}
