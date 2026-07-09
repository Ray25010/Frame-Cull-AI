export type FaceBoxSource = 'full' | 'tile' | 'center' | 'landmarker';
export type FaceBoxDetector = 'mediapipe' | 'yunet' | 'landmarker';

export type FaceBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  source: FaceBoxSource;
  detector?: FaceBoxDetector;
  keypoints?: Array<{ x: number; y: number }>;
};

export type DetectionRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  source: Exclude<FaceBoxSource, 'full' | 'landmarker'>;
};

export function mergeFaceBoxes(boxes: FaceBox[], iouThreshold = 0.35, maxFaces = Number.POSITIVE_INFINITY) {
  const sorted = [...boxes]
    .filter(box => box.width > 0 && box.height > 0)
    .sort((a, b) => b.confidence - a.confidence);
  const merged: FaceBox[] = [];

  sorted.forEach(box => {
    if (Number.isFinite(maxFaces) && merged.length >= maxFaces) return;
    if (merged.some(existing => intersectionOverUnion(existing, box) > iouThreshold)) return;
    merged.push(box);
  });

  return merged.sort((a, b) => b.width * b.height - a.width * a.height);
}

export function intersectionOverUnion(a: FaceBox, b: FaceBox) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export function createEnhancedFaceDetectionRegions(imageWidth: number, imageHeight: number) {
  const tileWidth = Math.max(1, Math.round(imageWidth * 0.62));
  const tileHeight = Math.max(1, Math.round(imageHeight * 0.62));
  const regions: DetectionRegion[] = [];

  [0, Math.max(0, imageWidth - tileWidth)].forEach(x => {
    [0, Math.max(0, imageHeight - tileHeight)].forEach(y => {
      regions.push({ x, y, width: tileWidth, height: tileHeight, source: 'tile' });
    });
  });

  const centerWidth = Math.max(1, Math.round(imageWidth * 0.72));
  const centerHeight = Math.max(1, Math.round(imageHeight * 0.72));
  regions.push({
    x: Math.max(0, Math.round((imageWidth - centerWidth) / 2)),
    y: Math.max(0, Math.round((imageHeight - centerHeight) / 2)),
    width: centerWidth,
    height: centerHeight,
    source: 'center',
  });

  const seen = new Set<string>();
  return regions.filter(region => {
    const key = `${region.x}|${region.y}|${region.width}|${region.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function shouldRunEnhancedFaceDetection(boxes: FaceBox[], imageWidth: number, imageHeight: number) {
  if (boxes.length === 0) return true;
  const shortEdge = Math.max(1, Math.min(imageWidth, imageHeight));
  const maxFaceHeight = Math.max(...boxes.map(box => box.height));
  return maxFaceHeight < shortEdge * 0.07;
}

export function mapFaceBoxFromRegion(
  box: FaceBox,
  region: DetectionRegion,
  detectionWidth: number,
  detectionHeight: number,
  imageWidth: number,
  imageHeight: number
): FaceBox {
  const scaleX = region.width / Math.max(1, detectionWidth);
  const scaleY = region.height / Math.max(1, detectionHeight);
  return clampFaceBox({
    x: region.x + box.x * scaleX,
    y: region.y + box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
    confidence: box.confidence,
    source: region.source,
    detector: box.detector,
    keypoints: box.keypoints?.map(point => ({
      x: region.x + point.x * scaleX,
      y: region.y + point.y * scaleY,
    })),
  }, imageWidth, imageHeight);
}

export function expandFaceBox(box: FaceBox, imageWidth: number, imageHeight: number, scale = 2) {
  const nextWidth = box.width * scale;
  const nextHeight = box.height * scale;
  return clampFaceBox({
    ...box,
    x: box.x + box.width / 2 - nextWidth / 2,
    y: box.y + box.height / 2 - nextHeight / 2,
    width: nextWidth,
    height: nextHeight,
  }, imageWidth, imageHeight);
}

export function faceSizeRatio(box: FaceBox, imageWidth: number, imageHeight: number) {
  return box.height / Math.max(1, Math.min(imageWidth, imageHeight));
}

export function clampFaceBox(box: FaceBox, imageWidth: number, imageHeight: number): FaceBox {
  const x = Math.max(0, Math.min(imageWidth - 1, box.x));
  const y = Math.max(0, Math.min(imageHeight - 1, box.y));
  const width = Math.max(1, Math.min(imageWidth - x, box.width));
  const height = Math.max(1, Math.min(imageHeight - y, box.height));
  return { ...box, x, y, width, height };
}
