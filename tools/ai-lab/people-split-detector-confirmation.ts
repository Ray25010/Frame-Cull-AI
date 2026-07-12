import type { PeopleFaceBox } from '../../src/types';

export type FaceDetectorConfirmationReason = 'CONFIRMED' | 'LOW_IOU' | 'NO_CONFIRMING_BOX';

export type FaceDetectorConfirmation = {
  candidateIndex: number;
  confirmingBoxIndex?: number;
  confirmed: boolean;
  bestIoU: number;
  reason: FaceDetectorConfirmationReason;
};

export function matchFaceDetectorBoxes(
  candidateBoxes: PeopleFaceBox[],
  confirmingBoxes: PeopleFaceBox[],
  minimumIoU: number,
): FaceDetectorConfirmation[] {
  return candidateBoxes.map((candidateBox, candidateIndex) => {
    if (confirmingBoxes.length === 0) {
      return {
        candidateIndex,
        confirmed: false,
        bestIoU: 0,
        reason: 'NO_CONFIRMING_BOX',
      };
    }

    let confirmingBoxIndex = 0;
    let bestIoU = intersectionOverUnion(candidateBox, confirmingBoxes[0]);
    confirmingBoxes.slice(1).forEach((confirmingBox, offset) => {
      const overlap = intersectionOverUnion(candidateBox, confirmingBox);
      if (overlap > bestIoU) {
        bestIoU = overlap;
        confirmingBoxIndex = offset + 1;
      }
    });
    const confirmed = bestIoU >= minimumIoU;

    return {
      candidateIndex,
      confirmingBoxIndex,
      confirmed,
      bestIoU,
      reason: confirmed ? 'CONFIRMED' : 'LOW_IOU',
    };
  });
}

function intersectionOverUnion(left: PeopleFaceBox, right: PeopleFaceBox) {
  const intersectionLeft = Math.max(left.x, right.x);
  const intersectionTop = Math.max(left.y, right.y);
  const intersectionRight = Math.min(left.x + left.width, right.x + right.width);
  const intersectionBottom = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, intersectionRight - intersectionLeft)
    * Math.max(0, intersectionBottom - intersectionTop);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? Math.max(0, Math.min(1, intersection / union)) : 0;
}
