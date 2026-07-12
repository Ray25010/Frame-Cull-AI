import type { FaceBox } from './faceDetectionGeometry';

export type YuNetOutputMap = Record<string, { data: Float32Array | number[]; dims?: readonly number[] }>;

export type YuNetTransform = {
  sourceWidth: number;
  sourceHeight: number;
  inputSize?: number;
  offsetX?: number;
  offsetY?: number;
  scale?: number;
};

export function decodeYuNetOutputs(
  outputs: YuNetOutputMap,
  transform: YuNetTransform,
  scoreThreshold = 0.42
): FaceBox[] {
  const inputSize = transform.inputSize ?? 640;
  const scale = transform.scale ?? Math.min(inputSize / Math.max(1, transform.sourceWidth), inputSize / Math.max(1, transform.sourceHeight));
  const offsetX = transform.offsetX ?? (inputSize - transform.sourceWidth * scale) / 2;
  const offsetY = transform.offsetY ?? (inputSize - transform.sourceHeight * scale) / 2;
  const boxes: FaceBox[] = [];

  [8, 16, 32].forEach(stride => {
    const cls = tensorData(outputs[`cls_${stride}`]);
    const obj = tensorData(outputs[`obj_${stride}`]);
    const bbox = tensorData(outputs[`bbox_${stride}`]);
    const kps = tensorData(outputs[`kps_${stride}`]);
    const cols = inputSize / stride;
    const rows = inputSize / stride;

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        const score = Math.sqrt(clamp01(cls[index] ?? 0) * clamp01(obj[index] ?? 0));
        if (score < scoreThreshold) continue;

        const cx = (col + (bbox[index * 4] ?? 0)) * stride;
        const cy = (row + (bbox[index * 4 + 1] ?? 0)) * stride;
        const width = Math.exp(bbox[index * 4 + 2] ?? 0) * stride;
        const height = Math.exp(bbox[index * 4 + 3] ?? 0) * stride;
        const x = (cx - width / 2 - offsetX) / Math.max(scale, 0.0001);
        const y = (cy - height / 2 - offsetY) / Math.max(scale, 0.0001);

        const keypoints = Array.from({ length: 5 }, (_, pointIndex) => ({
          x: ((kps[index * 10 + pointIndex * 2] ?? 0) + col) * stride,
          y: ((kps[index * 10 + pointIndex * 2 + 1] ?? 0) + row) * stride,
        })).map(point => ({
          x: (point.x - offsetX) / Math.max(scale, 0.0001),
          y: (point.y - offsetY) / Math.max(scale, 0.0001),
        }));

        boxes.push({
          x,
          y,
          width: width / Math.max(scale, 0.0001),
          height: height / Math.max(scale, 0.0001),
          confidence: score,
          source: 'full',
          detector: 'yunet',
          keypoints,
        });
      }
    }
  });

  return boxes.filter(box => boxIntersectsImage(box, transform.sourceWidth, transform.sourceHeight));
}

function tensorData(tensor: YuNetOutputMap[string] | undefined) {
  if (!tensor) return new Float32Array();
  return tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function boxIntersectsImage(box: FaceBox, width: number, height: number) {
  return (
    box.x + box.width > 0 &&
    box.y + box.height > 0 &&
    box.x < width &&
    box.y < height
  );
}
