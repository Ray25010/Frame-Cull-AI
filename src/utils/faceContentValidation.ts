import type { FaceBox } from './faceDetectionGeometry';

export type FaceLikePoint = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type FaceContentQuality = {
  skinScore: number;
  radialSymmetryScore: number;
  darkRingScore: number;
  edgeRingScore: number;
  centerDarknessScore: number;
  monochromeScore: number;
  wheelLikeScore: number;
};

const LEFT_EYE_LANDMARKS = [33, 133, 159, 145, 160, 158, 153, 144];
const RIGHT_EYE_LANDMARKS = [362, 263, 386, 374, 385, 387, 373, 380];

export function shouldKeepFaceByContent(
  imageData: ImageData,
  box: FaceBox,
  options: {
    structureScore?: number;
    hasConfirmedLandmarks?: boolean;
    detectorOnly?: boolean;
  } = {},
) {
  const content = measureFaceContentQuality(imageData, box);
  return isPlausibleHumanFaceContent(box, imageData.width, imageData.height, content, options);
}

export function shouldKeepLandmarkedFaceByContent(
  imageData: ImageData,
  box: FaceBox,
  landmarks?: FaceLikePoint[],
) {
  if (!landmarks || landmarks.length === 0) {
    return shouldKeepFaceByContent(imageData, box, { detectorOnly: true });
  }
  const structureScore = faceStructureQualityFromNormalizedLandmarks(
    box,
    landmarks,
    imageData.width,
    imageData.height,
  );
  return shouldKeepFaceByContent(imageData, box, {
    structureScore,
    hasConfirmedLandmarks: true,
  });
}

export function faceStructureQualityFromNormalizedLandmarks(
  box: FaceBox,
  landmarks: FaceLikePoint[],
  imageWidth: number,
  imageHeight: number,
) {
  const leftEye = averageLandmarks(landmarks, LEFT_EYE_LANDMARKS, imageWidth, imageHeight);
  const rightEye = averageLandmarks(landmarks, RIGHT_EYE_LANDMARKS, imageWidth, imageHeight);
  const nose = landmarkPoint(landmarks, 1, imageWidth, imageHeight);
  const leftMouth = landmarkPoint(landmarks, 61, imageWidth, imageHeight);
  const rightMouth = landmarkPoint(landmarks, 291, imageWidth, imageHeight);
  if (!leftEye || !rightEye || !nose || !leftMouth || !rightMouth) return 0;

  const eyeDistance = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
  const mouthDistance = Math.hypot(leftMouth.x - rightMouth.x, leftMouth.y - rightMouth.y);
  const eyeRatio = eyeDistance / Math.max(1, box.width);
  const mouthRatio = mouthDistance / Math.max(1, box.width);
  const eyeY = ((leftEye.y + rightEye.y) / 2 - box.y) / Math.max(1, box.height);
  const noseY = (nose.y - box.y) / Math.max(1, box.height);
  const mouthY = ((leftMouth.y + rightMouth.y) / 2 - box.y) / Math.max(1, box.height);
  const verticalOrder = eyeY < noseY && noseY < mouthY ? 1 : 0;
  const eyeLevelScore = clamp01(1 - Math.abs(leftEye.y - rightEye.y) / Math.max(1, box.height * 0.18));

  return clamp01(
    scoreRange(eyeRatio, 0.18, 0.68) * 0.22 +
    scoreRange(mouthRatio, 0.10, 0.62) * 0.16 +
    scoreRange(eyeY, 0.16, 0.58) * 0.18 +
    scoreRange(noseY, 0.30, 0.78) * 0.16 +
    scoreRange(mouthY, 0.45, 0.96) * 0.16 +
    eyeLevelScore * 0.06 +
    verticalOrder * 0.06,
  );
}

export function faceStructureQualityFromBoxKeypoints(box: FaceBox) {
  const keypoints = box.keypoints;
  if (!keypoints || keypoints.length < 5) return undefined;
  const [leftEye, rightEye, nose, leftMouth, rightMouth] = keypoints;
  if (![leftEye, rightEye, nose, leftMouth, rightMouth].every(point => pointInsideExpandedBox(point, box))) {
    return 0;
  }
  const eyeDistance = distance(leftEye, rightEye);
  const mouthDistance = distance(leftMouth, rightMouth);
  const eyeRatio = eyeDistance / Math.max(1, box.width);
  const mouthRatio = mouthDistance / Math.max(1, box.width);
  const eyeLevelScore = clamp01(1 - Math.abs(leftEye.y - rightEye.y) / Math.max(1, box.height * 0.18));
  const eyeSpacingScore = scoreRange(eyeRatio, 0.20, 0.62);
  const mouthSpacingScore = scoreRange(mouthRatio, 0.13, 0.56);
  const noseBelowEyesScore = nose.y > Math.max(leftEye.y, rightEye.y) ? 1 : 0;
  const mouthBelowNoseScore = Math.min(leftMouth.y, rightMouth.y) > nose.y ? 1 : 0;
  const verticalOrderScore = (noseBelowEyesScore + mouthBelowNoseScore) / 2;
  const eyeY = ((leftEye.y + rightEye.y) / 2 - box.y) / Math.max(1, box.height);
  const noseY = (nose.y - box.y) / Math.max(1, box.height);
  const mouthY = ((leftMouth.y + rightMouth.y) / 2 - box.y) / Math.max(1, box.height);
  const layoutScore = (
    scoreRange(eyeY, 0.18, 0.55) +
    scoreRange(noseY, 0.34, 0.76) +
    scoreRange(mouthY, 0.48, 0.95)
  ) / 3;

  return clamp01(
    eyeSpacingScore * 0.24 +
    eyeLevelScore * 0.18 +
    mouthSpacingScore * 0.14 +
    verticalOrderScore * 0.24 +
    layoutScore * 0.20,
  );
}

export function measureFaceContentQuality(imageData: ImageData, box: FaceBox): FaceContentQuality {
  const { data, width, height } = imageData;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 42));
  let count = 0;
  let skin = 0;
  let monochrome = 0;
  let centerDark = 0;
  let ringDark = 0;
  let ringCount = 0;
  let centerCount = 0;
  let horizontalMirrorDiff = 0;
  let verticalMirrorDiff = 0;
  let mirrorSamples = 0;
  let ringEdge = 0;

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const index = (y * width + x) * 4;
      const r = data[index] ?? 0;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b));
      const nx = ((x - box.x) / Math.max(1, box.width)) - 0.5;
      const ny = ((y - box.y) / Math.max(1, box.height)) - 0.5;
      const radius = Math.hypot(nx, ny);
      count += 1;
      if (isSkinLikePixel(r, g, b)) skin += 1;
      if (saturation < 0.18) monochrome += 1;
      if (radius < 0.24) {
        centerCount += 1;
        if (luma < 86) centerDark += 1;
      }
      if (radius > 0.31 && radius < 0.52) {
        ringCount += 1;
        if (luma < 96) ringDark += 1;
        if (localEdgeMagnitude(data, width, height, x, y) > 36) ringEdge += 1;
      }

      const mirrorX = Math.max(x0, Math.min(x1 - 1, Math.round(box.x + box.width - (x - box.x))));
      const mirrorY = Math.max(y0, Math.min(y1 - 1, Math.round(box.y + box.height - (y - box.y))));
      horizontalMirrorDiff += Math.abs(luma - pixelLuma(data, width, mirrorX, y));
      verticalMirrorDiff += Math.abs(luma - pixelLuma(data, width, x, mirrorY));
      mirrorSamples += 2;
    }
  }

  const mirrorDiff = (horizontalMirrorDiff + verticalMirrorDiff) / Math.max(1, mirrorSamples);
  const roundedness = Math.min(box.width, box.height) / Math.max(1, Math.max(box.width, box.height));
  const skinScore = skin / Math.max(1, count);
  const radialSymmetryScore = clamp01(1 - mirrorDiff / 52);
  const darkRingScore = ringDark / Math.max(1, ringCount);
  const edgeRingScore = ringEdge / Math.max(1, ringCount);
  const centerDarknessScore = centerDark / Math.max(1, centerCount);
  const monochromeScore = monochrome / Math.max(1, count);
  const lowSkinScore = clamp01((0.14 - skinScore) / 0.14);
  const wheelLikeScore = clamp01(
    radialSymmetryScore * 0.18 +
    darkRingScore * 0.17 +
    edgeRingScore * 0.20 +
    centerDarknessScore * 0.12 +
    monochromeScore * 0.16 +
    clamp01((roundedness - 0.68) / 0.25) * 0.08 +
    lowSkinScore * 0.09,
  );

  return {
    skinScore,
    radialSymmetryScore,
    darkRingScore,
    edgeRingScore,
    centerDarknessScore,
    monochromeScore,
    wheelLikeScore,
  };
}

function isPlausibleHumanFaceContent(
  box: FaceBox,
  imageWidth: number,
  imageHeight: number,
  content: FaceContentQuality,
  options: {
    structureScore?: number;
    hasConfirmedLandmarks?: boolean;
    detectorOnly?: boolean;
  },
) {
  const shortEdge = Math.max(1, Math.min(imageWidth, imageHeight));
  const faceRatio = Math.max(box.width, box.height) / shortEdge;
  const roundedness = Math.min(box.width, box.height) / Math.max(1, Math.max(box.width, box.height));
  const structureScore = options.structureScore;
  const hasStrongStructure = typeof structureScore === 'number' && structureScore >= 0.68;
  const hasAcceptableStructure = typeof structureScore === 'number' && structureScore >= 0.50;
  const veryWheelLike = roundedness > 0.72 && content.wheelLikeScore >= 0.64 && content.skinScore < 0.12;
  const obviousWheelLike = roundedness > 0.78 && content.wheelLikeScore >= 0.56 && content.skinScore < 0.08;

  if (faceRatio < 0.024 && box.confidence < 0.7) return false;

  if (options.hasConfirmedLandmarks) {
    if (!hasAcceptableStructure && content.wheelLikeScore >= 0.42) return false;
    if (
      content.wheelLikeScore >= 0.72 &&
      content.skinScore < 0.08 &&
      (content.darkRingScore > 0.30 || content.edgeRingScore > 0.42)
    ) {
      return false;
    }
    if (
      content.wheelLikeScore >= 0.64 &&
      content.skinScore < 0.06 &&
      !hasStrongStructure
    ) {
      return false;
    }
    if (veryWheelLike && !hasStrongStructure) return false;
    if (
      obviousWheelLike &&
      content.monochromeScore > 0.72 &&
      (content.darkRingScore > 0.30 || content.edgeRingScore > 0.42)
    ) {
      return false;
    }
    return hasAcceptableStructure || box.confidence >= 0.72;
  }

  if (veryWheelLike) return false;
  if (
    obviousWheelLike &&
    (options.detectorOnly || box.confidence < 0.78) &&
    (content.darkRingScore > 0.34 || content.edgeRingScore > 0.46)
  ) {
    return false;
  }
  return true;
}

function isSkinLikePixel(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (
    r > 55 &&
    g > 32 &&
    b > 20 &&
    max - min > 10 &&
    r > g * 0.88 &&
    g > b * 0.68 &&
    r > b * 1.02
  );
}

function localEdgeMagnitude(data: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const left = pixelLuma(data, width, Math.max(0, x - 1), y);
  const right = pixelLuma(data, width, Math.min(width - 1, x + 1), y);
  const top = pixelLuma(data, width, x, Math.max(0, y - 1));
  const bottom = pixelLuma(data, width, x, Math.min(height - 1, y + 1));
  return Math.abs(right - left) + Math.abs(bottom - top);
}

function pixelLuma(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const index = (y * width + x) * 4;
  return 0.2126 * (data[index] ?? 0) + 0.7152 * (data[index + 1] ?? 0) + 0.0722 * (data[index + 2] ?? 0);
}

function averageLandmarks(
  landmarks: FaceLikePoint[],
  indexes: number[],
  imageWidth: number,
  imageHeight: number,
) {
  const points = indexes
    .map(index => landmarkPoint(landmarks, index, imageWidth, imageHeight))
    .filter((point): point is { x: number; y: number } => Boolean(point));
  if (points.length < Math.min(4, indexes.length)) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function landmarkPoint(
  landmarks: FaceLikePoint[],
  index: number,
  imageWidth: number,
  imageHeight: number,
) {
  const point = landmarks[index];
  if (!point) return null;
  return {
    x: point.x * imageWidth,
    y: point.y * imageHeight,
  };
}

function pointInsideExpandedBox(point: { x: number; y: number }, box: FaceBox) {
  const marginX = box.width * 0.16;
  const marginY = box.height * 0.18;
  return (
    point.x >= box.x - marginX &&
    point.x <= box.x + box.width + marginX &&
    point.y >= box.y - marginY &&
    point.y <= box.y + box.height + marginY
  );
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function scoreRange(value: number, min: number, max: number) {
  if (!Number.isFinite(value) || max <= min) return 0;
  if (value >= min && value <= max) return 1;
  const center = (min + max) / 2;
  const halfRange = (max - min) / 2;
  return clamp01(1 - Math.abs(value - center) / Math.max(halfRange, 0.0001));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
