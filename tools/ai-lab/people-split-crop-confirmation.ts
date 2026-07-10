import type { PeopleFaceBox } from '../../src/types';

export type FaceConfirmationCrop = {
  crop: PeopleFaceBox;
  candidateInCrop: PeopleFaceBox;
};

export function createFaceConfirmationCrop(
  candidate: PeopleFaceBox,
  imageWidth: number,
  imageHeight: number,
  scale: number,
): FaceConfirmationCrop {
  const safeWidth = Math.max(1, imageWidth);
  const safeHeight = Math.max(1, imageHeight);
  const candidatePixels = {
    x: candidate.x * safeWidth,
    y: candidate.y * safeHeight,
    width: candidate.width * safeWidth,
    height: candidate.height * safeHeight,
  };
  const size = Math.min(
    Math.min(safeWidth, safeHeight),
    Math.max(candidatePixels.width, candidatePixels.height) * Math.max(1, scale),
  );
  const centerX = candidatePixels.x + candidatePixels.width / 2;
  const centerY = candidatePixels.y + candidatePixels.height / 2;
  const cropPixels = {
    x: clamp(centerX - size / 2, 0, safeWidth - size),
    y: clamp(centerY - size / 2, 0, safeHeight - size),
    width: size,
    height: size,
  };
  const crop: PeopleFaceBox = {
    x: cropPixels.x / safeWidth,
    y: cropPixels.y / safeHeight,
    width: cropPixels.width / safeWidth,
    height: cropPixels.height / safeHeight,
  };
  return {
    crop,
    candidateInCrop: {
      x: (candidatePixels.x - cropPixels.x) / cropPixels.width,
      y: (candidatePixels.y - cropPixels.y) / cropPixels.height,
      width: candidatePixels.width / cropPixels.width,
      height: candidatePixels.height / cropPixels.height,
    },
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
