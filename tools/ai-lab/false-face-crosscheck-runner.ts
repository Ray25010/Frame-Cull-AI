import * as ort from '../../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs';
import {
  clampFaceBox,
  createEnhancedFaceDetectionRegions,
  mapFaceBoxFromRegion,
  mergeFaceBoxes,
  shouldRunEnhancedFaceDetection,
  type DetectionRegion,
  type FaceBox,
  type FaceBoxSource,
} from '../../src/utils/faceDetectionGeometry';
import { decodeYuNetOutputs, type YuNetOutputMap } from '../../src/utils/yunetPostprocess';

type CrosscheckResult = {
  backend: string;
  model: string;
  wasmBase: string;
  totalMs: number;
  results: Array<{
    fileName: string;
    photoId: string;
    width: number;
    height: number;
    maxFacePresence: number;
    reliableFacePresence: number;
    faceCount: number;
    reliableFaceCount: number;
    enhancedPasses: number;
    elapsedMs: number;
    boxes: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      confidence: number;
      source: FaceBoxSource;
    }>;
    error?: string;
  }>;
};

declare global {
  interface Window {
    __FRAMECULL_FALSE_FACE_READY?: boolean;
    runFrameCullFalseFaceCrosscheck?: () => Promise<CrosscheckResult>;
  }
}

const statusEl = document.querySelector<HTMLPreElement>('#status');
const fileInput = document.querySelector<HTMLInputElement>('#files');
const MODEL_PATH = '/models/opencv/yunet/face_detection_yunet_2023mar.onnx';
const WASM_BASE = '/node_modules/onnxruntime-web/dist/';

let sessionPromise: Promise<ort.InferenceSession> | null = null;

window.runFrameCullFalseFaceCrosscheck = async () => {
  if (!fileInput) throw new Error('missing #files input');
  const files = Array.from(fileInput.files ?? []);
  if (files.length === 0) throw new Error('no files selected');
  const session = await getYuNetSession();
  const start = performance.now();
  const results: CrosscheckResult['results'] = [];
  for (const file of files) {
    const itemStart = performance.now();
    try {
      setStatus(`running ${file.name}`);
      const imageData = await readImageData(file);
      const boxes = await detectYuNetCandidates(imageData, session);
      const merged = mergeFaceBoxes(boxes, 0.35);
      const reliable = filterReliableFaces(merged, imageData.width, imageData.height);
      results.push({
        fileName: file.name,
        photoId: file.name.replace(/\.[^.]+$/, ''),
        width: imageData.width,
        height: imageData.height,
        maxFacePresence: maxConfidence(merged),
        reliableFacePresence: maxConfidence(reliable),
        faceCount: merged.length,
        reliableFaceCount: reliable.length,
        enhancedPasses: boxes.filter(box => box.source !== 'full').length,
        elapsedMs: performance.now() - itemStart,
        boxes: reliable.slice(0, 8).map(box => ({
          x: round4(box.x),
          y: round4(box.y),
          width: round4(box.width),
          height: round4(box.height),
          confidence: round4(box.confidence),
          source: box.source,
        })),
      });
    } catch (error) {
      results.push({
        fileName: file.name,
        photoId: file.name.replace(/\.[^.]+$/, ''),
        width: 0,
        height: 0,
        maxFacePresence: 0,
        reliableFacePresence: 0,
        faceCount: 0,
        reliableFaceCount: 0,
        enhancedPasses: 0,
        elapsedMs: performance.now() - itemStart,
        boxes: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const payload = {
    backend: 'onnxruntime-web/wasm',
    model: MODEL_PATH,
    wasmBase: WASM_BASE,
    totalMs: performance.now() - start,
    results,
  };
  setStatus(`done ${results.length}`);
  return payload;
};

window.__FRAMECULL_FALSE_FACE_READY = true;
setStatus('ready');

async function getYuNetSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      ort.env.wasm.wasmPaths = WASM_BASE;
      ort.env.wasm.numThreads = 1;
      return ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })();
  }
  return sessionPromise;
}

async function readImageData(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function detectYuNetCandidates(imageData: ImageData, session: ort.InferenceSession) {
  const boxes: FaceBox[] = [];
  const full = await runYuNetOnImageData(imageData, session, 'full');
  boxes.push(...full);

  if (shouldRunEnhancedFaceDetection(boxes, imageData.width, imageData.height)) {
    const regions = createEnhancedFaceDetectionRegions(imageData.width, imageData.height);
    for (const region of regions) {
      try {
        const regionImageData = cropImageData(imageData, region);
        const regionBoxes = await runYuNetOnImageData(regionImageData, session, region.source);
        boxes.push(...regionBoxes.map(box => mapFaceBoxFromRegion(
          box,
          region,
          region.width,
          region.height,
          imageData.width,
          imageData.height
        )));
      } catch {
        // Best-effort; full-frame detection remains the base signal.
      }
    }
  }
  return boxes;
}

async function runYuNetOnImageData(
  imageData: ImageData,
  session: ort.InferenceSession,
  source: FaceBoxSource
) {
  const input = prepareYuNetInput(imageData);
  const tensor = new ort.Tensor('float32', input.data, [1, 3, input.inputSize, input.inputSize]);
  const outputs = await session.run({ input: tensor });
  return decodeYuNetOutputs(outputs as YuNetOutputMap, {
    sourceWidth: imageData.width,
    sourceHeight: imageData.height,
    inputSize: input.inputSize,
    scale: input.scale,
    offsetX: input.offsetX,
    offsetY: input.offsetY,
  }, 0.08).map(box => ({
    ...clampFaceBox(box, imageData.width, imageData.height),
    source,
    detector: 'yunet' as const,
  }));
}

function prepareYuNetInput(imageData: ImageData) {
  const inputSize = 640;
  const canvas = new OffscreenCanvas(inputSize, inputSize);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas 2D context unavailable for YuNet');
  const scale = Math.min(inputSize / Math.max(1, imageData.width), inputSize / Math.max(1, imageData.height));
  const drawWidth = Math.max(1, Math.round(imageData.width * scale));
  const drawHeight = Math.max(1, Math.round(imageData.height * scale));
  const offsetX = Math.round((inputSize - drawWidth) / 2);
  const offsetY = Math.round((inputSize - drawHeight) / 2);
  const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('OffscreenCanvas source context unavailable for YuNet');
  sourceContext.putImageData(imageData, 0, 0);
  context.fillStyle = 'rgb(0, 0, 0)';
  context.fillRect(0, 0, inputSize, inputSize);
  context.drawImage(sourceCanvas, 0, 0, imageData.width, imageData.height, offsetX, offsetY, drawWidth, drawHeight);
  const resized = context.getImageData(0, 0, inputSize, inputSize).data;
  const data = new Float32Array(3 * inputSize * inputSize);
  const planeSize = inputSize * inputSize;
  for (let pixel = 0, src = 0; pixel < planeSize; pixel += 1, src += 4) {
    data[pixel] = resized[src + 2];
    data[planeSize + pixel] = resized[src + 1];
    data[planeSize * 2 + pixel] = resized[src];
  }
  return { data, inputSize, scale, offsetX, offsetY };
}

function cropImageData(imageData: ImageData, region: DetectionRegion) {
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(region.width)), Math.max(1, Math.round(region.height)));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas crop context unavailable');
  const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('OffscreenCanvas source context unavailable for crop');
  sourceContext.putImageData(imageData, 0, 0);
  context.drawImage(sourceCanvas, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function filterReliableFaces(boxes: FaceBox[], imageWidth: number, imageHeight: number) {
  const imageArea = Math.max(1, imageWidth * imageHeight);
  return boxes
    .filter(box => {
      const confidenceFloor = box.source === 'full' ? 0.34 : 0.38;
      const aspectRatio = box.width / Math.max(1, box.height);
      const areaRatio = (box.width * box.height) / imageArea;
      const heightRatio = box.height / Math.max(1, imageHeight);
      return (
        box.confidence >= confidenceFloor &&
        aspectRatio >= 0.42 &&
        aspectRatio <= 1.85 &&
        areaRatio <= 0.24 &&
        heightRatio <= 0.62 &&
        box.width >= 14 &&
        box.height >= 14 &&
        faceBoxHasPlausibleKeypoints(box)
      );
    })
    .sort((a, b) => b.confidence - a.confidence);
}

function faceBoxHasPlausibleKeypoints(box: FaceBox) {
  if (!box.keypoints || box.keypoints.length < 5) return true;
  const [rightEye, leftEye, nose, rightMouth, leftMouth] = box.keypoints;
  const insideCount = box.keypoints.filter(point => (
    point.x >= box.x - box.width * 0.08 &&
    point.x <= box.x + box.width * 1.08 &&
    point.y >= box.y - box.height * 0.08 &&
    point.y <= box.y + box.height * 1.08
  )).length;
  if (insideCount < 4) return false;

  const eyeDistance = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
  const mouthDistance = Math.hypot(leftMouth.x - rightMouth.x, leftMouth.y - rightMouth.y);
  const eyeRatio = eyeDistance / Math.max(1, box.width);
  const mouthRatio = mouthDistance / Math.max(1, box.width);
  const eyeY = (leftEye.y + rightEye.y) / 2;
  const mouthY = (leftMouth.y + rightMouth.y) / 2;
  const noseYRatio = (nose.y - box.y) / Math.max(1, box.height);
  return (
    eyeRatio >= 0.18 &&
    eyeRatio <= 0.72 &&
    mouthRatio >= 0.12 &&
    mouthRatio <= 0.72 &&
    noseYRatio >= 0.2 &&
    noseYRatio <= 0.78 &&
    eyeY < mouthY &&
    nose.y > eyeY - box.height * 0.08 &&
    nose.y < mouthY + box.height * 0.18
  );
}

function maxConfidence(boxes: FaceBox[]) {
  return boxes.reduce((best, box) => Math.max(best, box.confidence), 0);
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
}
