import * as ort from 'onnxruntime-web/wasm';
import type { AiModelAssets, AiSubjectRole, PeopleFaceBox, PersonFaceEmbedding } from '../types';
import { clampFaceBox, createEnhancedFaceDetectionRegions, intersectionOverUnion, mapFaceBoxFromRegion, mergeFaceBoxes, shouldRunEnhancedFaceDetection, type DetectionRegion, type FaceBox } from '../utils/faceDetectionGeometry';
import { faceStructureQualityFromBoxKeypoints, shouldKeepFaceByContent } from '../utils/faceContentValidation';
import { rgbaToSfaceChw } from '../utils/sfacePreprocess';
import { decodeYuNetOutputs, type YuNetOutputMap } from '../utils/yunetPostprocess';
import { clusterPeopleFaces, faceQualityFromBox, isUsablePeopleFace } from '../utils/peopleSplit';

type OnnxBackend = NonNullable<AiModelAssets['onnxBackend']>;
const ENABLE_EXPERIMENTAL_ONNX_WEBGPU = import.meta.env.VITE_FRAMECULL_ENABLE_WEBGPU === '1';
const MAX_PEOPLE_SPLIT_ENHANCED_REGIONS = 2;
type InitialFaceGuidance = PeopleFaceBox & {
  confidence?: number;
  landmarkerStatus?: 'OK' | 'FAILED' | 'SKIPPED';
};

interface AnalyzePeopleRequest {
  type: 'analyze';
  id: string;
  imageData?: ImageData;
  imageUrl?: string;
  imageBlob?: Blob;
  maxEdge?: number;
  modelAssets?: AiModelAssets;
  photoId: string;
  subjectRoles?: Array<AiSubjectRole | undefined>;
  initialFaceBoxes?: InitialFaceGuidance[];
  preferInitialFaceBoxes?: boolean;
  disableSFace?: boolean;
}

interface ClusterPeopleRequest {
  type: 'cluster';
  id: string;
  faces: PersonFaceEmbedding[];
  threshold?: number;
  minQuality?: number;
}

interface AnalyzePeopleResponse {
  type: 'result' | 'error' | 'progress';
  id: string;
  faces?: WorkerFaceEmbedding[];
  error?: string;
  stage?: string;
}

interface ClusterPeopleResponse {
  type: 'cluster_result' | 'cluster_error' | 'cluster_progress';
  id: string;
  result?: ReturnType<typeof clusterPeopleFaces>;
  error?: string;
  stage?: string;
}

export interface WorkerFaceEmbedding {
  key: string;
  photoId: string;
  faceIndex: number;
  embedding: number[];
  boundingBox: PeopleFaceBox;
  confidence: number;
  quality: number;
  source: 'SFACE' | 'FALLBACK';
  subjectRole?: AiSubjectRole;
  isPrimaryCandidate?: boolean;
  eligibleForCluster: boolean;
  reason?: string;
  thumbnail: string;
  visualQuality?: number;
  structureQuality?: number;
  hasFaceKeypoints?: boolean;
  landmarkerStatus?: InitialFaceGuidance['landmarkerStatus'];
  landmarkerOverlap?: number;
}

type YuNetLoaderResult = {
  session?: ort.InferenceSession;
  error?: string;
  modelAssetPath?: string;
  wasmBase?: string;
  backend?: OnnxBackend;
};

type SFaceLoaderResult = {
  session?: ort.InferenceSession;
  error?: string;
  modelAssetPath?: string;
  wasmBase?: string;
  backend?: OnnxBackend;
};

let yunetPromise: Promise<YuNetLoaderResult> | null = null;
let yunetKey = '';
let sfacePromise: Promise<SFaceLoaderResult> | null = null;
let sfaceKey = '';

self.onmessage = async (event: MessageEvent<AnalyzePeopleRequest | ClusterPeopleRequest>) => {
  if (event.data.type === 'analyze') {
    try {
      const faces = await analyzePeople(event.data);
      const response: AnalyzePeopleResponse = { type: 'result', id: event.data.id, faces };
      self.postMessage(response);
    } catch (error) {
      const response: AnalyzePeopleResponse = {
        type: 'error',
        id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    }
  } else if (event.data.type === 'cluster') {
    try {
      postClusterProgress(event.data.id, '开始聚类分析');
      const result = clusterPeopleFaces(event.data.faces, {
        threshold: event.data.threshold,
        minQuality: event.data.minQuality,
      });
      const response: ClusterPeopleResponse = { type: 'cluster_result', id: event.data.id, result };
      self.postMessage(response);
    } catch (error) {
      const response: ClusterPeopleResponse = {
        type: 'cluster_error',
        id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    }
  }
};

async function analyzePeople(request: AnalyzePeopleRequest) {
  postProgress(request.id, '准备图片');
  const imageData = request.imageData ?? await prepareImageDataFromSource(request.imageBlob ?? request.imageUrl, request.maxEdge);
  postProgress(request.id, '检测人脸');
  const boxes = await detectFaces(
    imageData,
    request.modelAssets,
    request.initialFaceBoxes,
    request.preferInitialFaceBoxes,
  );
  if (boxes.length === 0) return [];
  postProgress(request.id, `检测到 ${boxes.length} 张候选脸`);
  postProgress(request.id, request.disableSFace ? `轻量特征 0/${boxes.length}` : '加载识别模型');
  const sface = request.disableSFace ? undefined : await getSFaceDetector(request.modelAssets);
  const faces: WorkerFaceEmbedding[] = [];
  const sourceBitmap = await createImageBitmap(imageData);

  try {
    for (const [faceIndex, box] of boxes.entries()) {
      postProgress(request.id, `${request.disableSFace ? '轻量特征' : '提取特征'} ${faceIndex + 1}/${boxes.length}`);
      const bounded = clampFaceBox(box, imageData.width, imageData.height);
      const subjectRole = request.subjectRoles?.[faceIndex];
      const primary = subjectRole === 'PRIMARY' || subjectRole === 'SECONDARY';
      const structureQuality = faceStructureQuality(bounded);
      const hasFaceKeypoints = Boolean(bounded.keypoints && bounded.keypoints.length >= 5);
      if (!shouldKeepFaceByContent(imageData, bounded, {
        structureScore: structureQuality,
        hasConfirmedLandmarks: hasFaceKeypoints,
        detectorOnly: !hasFaceKeypoints,
      })) {
        continue;
      }
      const faceBitmap = await createRecognitionFaceBitmap(sourceBitmap, imageData.width, imageData.height, bounded);
      let avatarBitmap: ImageBitmap | null = null;
      try {
        const visualQuality = measureFaceVisualQuality(faceBitmap);
        const guidance = bestInitialGuidance(bounded, request.initialFaceBoxes, imageData.width, imageData.height);
        const quality = combineFaceQuality(
          faceQualityFromBox(bounded, bounded.confidence, imageData.width, imageData.height),
          visualQuality,
          structureQuality,
          hasFaceKeypoints,
        );
        const usability = isUsablePeopleFace(bounded, bounded.confidence, imageData.width, imageData.height);
        if (!usability.displayable || visualQuality < 0.18 || (typeof structureQuality === 'number' && structureQuality < 0.28)) {
          continue;
        }
        avatarBitmap = await createAvatarFaceBitmap(sourceBitmap, imageData.width, imageData.height, bounded);
        const thumbnail = await faceBitmapToDataUrl(avatarBitmap, 192);
        const embedding = sface?.session
          ? await inferSFaceEmbedding(sface.session, faceBitmap)
          : fallbackEmbedding(faceBitmap);

        faces.push({
          key: `${request.photoId}:${faceIndex}`,
          photoId: request.photoId,
          faceIndex,
          embedding,
          boundingBox: {
            x: bounded.x / imageData.width,
            y: bounded.y / imageData.height,
            width: bounded.width / imageData.width,
            height: bounded.height / imageData.height,
          },
          confidence: bounded.confidence,
          quality,
          source: sface?.session ? 'SFACE' : 'FALLBACK',
          subjectRole,
          isPrimaryCandidate: primary,
          eligibleForCluster: usability.eligible
            && visualQuality >= 0.30
            && (structureQuality === undefined || structureQuality >= 0.46)
            && hasFaceKeypoints
            && bounded.confidence >= 0.56,
          visualQuality,
          structureQuality,
          hasFaceKeypoints,
          landmarkerStatus: guidance?.landmarkerStatus,
          landmarkerOverlap: guidance?.overlap,
          reason: usability.reason,
          thumbnail,
        });
      } finally {
        avatarBitmap?.close();
        faceBitmap.close();
      }
    }
  } finally {
    sourceBitmap.close();
  }

  return faces;
}

function postProgress(id: string, stage: string) {
  const response: AnalyzePeopleResponse = { type: 'progress', id, stage };
  self.postMessage(response);
}

function postClusterProgress(id: string, stage: string) {
  const response: ClusterPeopleResponse = { type: 'cluster_progress', id, stage };
  self.postMessage(response);
}

async function prepareImageDataFromSource(source: Blob | string | undefined, maxEdge = 1280) {
  if (!source) throw new Error('People split worker did not receive image data or an image source.');
  const blob = typeof source === 'string'
    ? await fetchImageBlob(source)
    : source;
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('OffscreenCanvas is unavailable for people split image preparation.');
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return context.getImageData(0, 0, width, height);
}

async function fetchImageBlob(imageUrl: string) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to load people split image: ${response.status}`);
  return response.blob();
}

function fitWithin(width: number, height: number, maxEdge: number) {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return { width, height };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function detectFaces(
  imageData: ImageData,
  modelAssets?: AiModelAssets,
  initialFaceBoxes: InitialFaceGuidance[] = [],
  preferInitialFaceBoxes = false,
): Promise<FaceBox[]> {
  const fallbackBoxes = initialFaceBoxes
    .filter(box => box.landmarkerStatus === 'OK' || box.landmarkerStatus === undefined)
    .map(box => clampFaceBox({
      x: box.x * imageData.width,
      y: box.y * imageData.height,
      width: box.width * imageData.width,
      height: box.height * imageData.height,
      confidence: box.confidence ?? 0.62,
      source: 'landmarker',
      detector: 'landmarker',
    }, imageData.width, imageData.height));
  const trustedFallbackBoxes = fallbackBoxes.filter(box => (
    box.width >= 18 &&
    box.height >= 18 &&
    box.confidence >= 0.42
  ));
  const hasTrustedInitialGuidance = trustedFallbackBoxes.length > 0;
  const shouldRestrictToInitialGuidance = preferInitialFaceBoxes && hasTrustedInitialGuidance;
  const loader = await getYuNetDetector(modelAssets);
  if (!loader.session) {
    if (trustedFallbackBoxes.length > 0) return trustedFallbackBoxes;
    if (loader.error) throw new Error(loader.error);
    return trustedFallbackBoxes;
  }
  const boxes: FaceBox[] = [];
  boxes.push(...await runYuNetOnImageData(imageData, loader.session, 'full'));
  trustedFallbackBoxes.forEach(fallbackBox => {
    const overlapsKeypointBox = boxes.some(box => (
      box.keypoints &&
      box.keypoints.length >= 5 &&
      intersectionOverUnion(box, fallbackBox) > 0.18
    ));
    if (!overlapsKeypointBox) boxes.push(fallbackBox);
  });

  let yunetBoxes = suppressNearDuplicateFaces(mergeFaceBoxes(boxes, 0.24));
  if (shouldRestrictToInitialGuidance) {
    yunetBoxes = keepBoxesMatchingGuidance(yunetBoxes, trustedFallbackBoxes);
  }
  if (!hasTrustedInitialGuidance && shouldRunEnhancedFaceDetection(yunetBoxes, imageData.width, imageData.height)) {
    const regions = prioritizePeopleSplitRegions(createEnhancedFaceDetectionRegions(imageData.width, imageData.height))
      .slice(0, MAX_PEOPLE_SPLIT_ENHANCED_REGIONS);
    for (const region of regions) {
      try {
        const regionImage = cropImageData(imageData, region);
        const regionBoxes = await runYuNetOnImageData(regionImage, loader.session, region.source);
        boxes.push(...regionBoxes.map(box => mapFaceBoxFromRegion(
          box,
          region,
          region.width,
          region.height,
          imageData.width,
          imageData.height,
        )));
      } catch {
        // Best-effort face enhancement only.
      }
    }
    yunetBoxes = suppressNearDuplicateFaces(mergeFaceBoxes(boxes, 0.24));
  }

  return suppressNearDuplicateFaces(mergeFaceBoxes(yunetBoxes, 0.24)).filter(box => (
    box.width >= 18 &&
    box.height >= 18 &&
    box.confidence >= 0.4
  ));
}

function prioritizePeopleSplitRegions(regions: DetectionRegion[]) {
  return [...regions].sort((left, right) => regionPriority(right) - regionPriority(left));
}

function regionPriority(region: DetectionRegion) {
  return region.source === 'center' ? 2 : 1;
}

function getYuNetDetector(modelAssets?: AiModelAssets) {
  const candidates = buildModelCandidates(
    modelAssets?.yunetAssetCandidates,
    [
      './models/opencv/yunet/face_detection_yunet_2023mar.onnx',
      '/models/opencv/yunet/face_detection_yunet_2023mar.onnx',
    ],
    modelAssets?.onnxWasmBaseCandidates,
  );
  const backend = modelAssets?.onnxBackend === 'webgpu' ? 'webgpu' : 'wasm';
  const key = JSON.stringify({ candidates, backend });
  if (!yunetPromise || yunetKey !== key) {
    yunetKey = key;
    yunetPromise = loadOrtModel(candidates.modelPaths, candidates.wasmBasePaths, 'face_detection_yunet_2023mar.onnx', backend);
  }
  return yunetPromise;
}

function getSFaceDetector(modelAssets?: AiModelAssets) {
  const candidates = buildModelCandidates(
    undefined,
    [
      './models/opencv/sface/face_recognition_sface_2021dec.onnx',
      '/models/opencv/sface/face_recognition_sface_2021dec.onnx',
    ],
    modelAssets?.onnxWasmBaseCandidates,
  );
  const backend = modelAssets?.onnxBackend === 'webgpu' ? 'webgpu' : 'wasm';
  const key = JSON.stringify({ candidates, backend });
  if (!sfacePromise || sfaceKey !== key) {
    sfaceKey = key;
    sfacePromise = loadOrtModel(candidates.modelPaths, candidates.wasmBasePaths, 'face_recognition_sface_2021dec.onnx', backend);
  }
  return sfacePromise;
}

async function loadOrtModel(modelPaths: string[], wasmBasePaths: string[], label: string, backend: OnnxBackend) {
  const failures: string[] = [];
  for (const wasmBasePath of wasmBasePaths) {
    for (const modelPath of modelPaths) {
      try {
        const wasmBase = ensureTrailingSlash(wasmBasePath);
        const ortRuntime = await prepareOrtRuntime(backend, wasmBase);
        const modelBuffer = await fetchBytes(modelPath, label);
        const session = await ortRuntime.InferenceSession.create(modelBuffer, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
        });
        return { session, modelAssetPath: modelPath, wasmBase, backend };
      } catch (error) {
        failures.push(`${label} backend=${backend} model=${modelPath} wasm=${wasmBasePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    error: failures.length > 0 ? failures.join('\n') : `${label} unavailable.`,
  };
}

async function prepareOrtRuntime(backend: OnnxBackend, wasmBase: string): Promise<typeof ort> {
  const runtime = backend === 'webgpu' && ENABLE_EXPERIMENTAL_ONNX_WEBGPU
    ? await import('onnxruntime-web/webgpu')
    : ort;
  if (backend === 'webgpu' && !ENABLE_EXPERIMENTAL_ONNX_WEBGPU) {
    throw new Error('ONNX WebGPU backend is disabled. Start Vite with VITE_FRAMECULL_ENABLE_WEBGPU=1 for lab benchmarks.');
  }
  const loaderName = backend === 'webgpu' ? 'ort-wasm-simd-threaded.jsep' : 'ort-wasm-simd-threaded';
  await fetchOk(`${wasmBase}${loaderName}.mjs`, `ONNX Runtime ${backend} loader`);
  await fetchOk(`${wasmBase}${loaderName}.wasm`, `ONNX Runtime ${backend} binary`);
  runtime.env.wasm.wasmPaths = wasmBase;
  runtime.env.wasm.numThreads = 1;
  if (backend === 'webgpu') {
    runtime.env.webgpu.powerPreference = 'high-performance';
  }
  return runtime;
}

function buildModelCandidates(
  modelCandidates: string[] | undefined,
  defaults: string[],
  wasmCandidates: string[] | undefined,
) {
  const origin = safeOrigin();
  const modelPaths = unique([
    ...(modelCandidates ?? []),
    ...defaults,
    ...defaults.map(path => origin && path.startsWith('/') ? `${origin}${path}` : ''),
  ].map(resolvePublicAssetUrl));
  const wasmDefaults = ['./models/onnxruntime/', '/models/onnxruntime/'];
  const wasmBasePaths = unique([
    ...(wasmCandidates ?? []),
    ...wasmDefaults,
    ...wasmDefaults.map(path => origin && path.startsWith('/') ? `${origin}${path}` : ''),
  ].map(resolvePublicAssetUrl));
  return { modelPaths, wasmBasePaths };
}

async function runYuNetOnImageData(
  imageData: ImageData,
  session: ort.InferenceSession,
  source: FaceBox['source'],
): Promise<FaceBox[]> {
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
  }, source === 'full' ? 0.48 : 0.52).map(box => ({
    ...clampFaceBox(box, imageData.width, imageData.height),
    source,
    detector: 'yunet',
  }));
}

function prepareYuNetInput(imageData: ImageData) {
  const inputSize = 640;
  const canvas = new OffscreenCanvas(inputSize, inputSize);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas 2D context is unavailable for YuNet.');
  const scale = Math.min(inputSize / Math.max(1, imageData.width), inputSize / Math.max(1, imageData.height));
  const drawWidth = Math.max(1, Math.round(imageData.width * scale));
  const drawHeight = Math.max(1, Math.round(imageData.height * scale));
  const offsetX = Math.round((inputSize - drawWidth) / 2);
  const offsetY = Math.round((inputSize - drawHeight) / 2);
  const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('OffscreenCanvas source context is unavailable for YuNet.');
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
  if (!context) throw new Error('OffscreenCanvas crop context is unavailable.');
  const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('OffscreenCanvas source context is unavailable.');
  sourceContext.putImageData(imageData, 0, 0);
  context.drawImage(sourceCanvas, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function cropFaceBitmap(sourceBitmap: ImageBitmap, imageWidth: number, imageHeight: number, box: FaceBox) {
  const marginX = box.width * 0.2;
  const marginY = box.height * 0.24;
  const x = Math.max(0, Math.floor(box.x - marginX));
  const y = Math.max(0, Math.floor(box.y - marginY));
  const width = Math.max(1, Math.min(imageWidth - x, Math.ceil(box.width + marginX * 2)));
  const height = Math.max(1, Math.min(imageHeight - y, Math.ceil(box.height + marginY * 2)));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas face context is unavailable.');
  context.drawImage(sourceBitmap, x, y, width, height, 0, 0, width, height);
  return canvas.transferToImageBitmap();
}

async function createAvatarFaceBitmap(sourceBitmap: ImageBitmap, imageWidth: number, imageHeight: number, box: FaceBox) {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const side = Math.max(box.width * 1.52, box.height * 1.68, 1);
  const x = Math.max(0, Math.floor(centerX - side / 2));
  const y = Math.max(0, Math.floor(centerY - side * 0.46));
  const width = Math.max(1, Math.min(imageWidth - x, Math.ceil(side)));
  const height = Math.max(1, Math.min(imageHeight - y, Math.ceil(side)));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas avatar context is unavailable.');
  context.drawImage(sourceBitmap, x, y, width, height, 0, 0, width, height);
  return canvas.transferToImageBitmap();
}

async function createRecognitionFaceBitmap(sourceBitmap: ImageBitmap, imageWidth: number, imageHeight: number, box: FaceBox) {
  if (box.keypoints && box.keypoints.length >= 5) {
    try {
      return alignFaceBitmap(sourceBitmap, box.keypoints);
    } catch {
      // Alignment improves SFace identity quality, but cropped input is still usable.
    }
  }
  return cropFaceBitmap(sourceBitmap, imageWidth, imageHeight, box);
}

function alignFaceBitmap(sourceBitmap: ImageBitmap, keypoints: Array<{ x: number; y: number }>) {
  const size = 112;
  const target = [
    { x: 38.2946, y: 51.6963 },
    { x: 73.5318, y: 51.5014 },
    { x: 56.0252, y: 71.7366 },
    { x: 41.5493, y: 92.3655 },
    { x: 70.7299, y: 92.2041 },
  ];
  const transform = estimateSimilarityTransform(keypoints.slice(0, 5), target);
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas aligned face context is unavailable.');
  context.fillStyle = 'rgb(0, 0, 0)';
  context.fillRect(0, 0, size, size);
  context.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  context.drawImage(sourceBitmap, 0, 0);
  context.resetTransform();
  return canvas.transferToImageBitmap();
}

function estimateSimilarityTransform(
  source: Array<{ x: number; y: number }>,
  target: Array<{ x: number; y: number }>,
) {
  const count = Math.min(source.length, target.length);
  if (count < 2) throw new Error('Not enough face keypoints for alignment.');

  const sourceMean = source.slice(0, count).reduce((sum, point) => ({
    x: sum.x + point.x / count,
    y: sum.y + point.y / count,
  }), { x: 0, y: 0 });
  const targetMean = target.slice(0, count).reduce((sum, point) => ({
    x: sum.x + point.x / count,
    y: sum.y + point.y / count,
  }), { x: 0, y: 0 });

  let sourceVariance = 0;
  let aNumerator = 0;
  let bNumerator = 0;

  for (let index = 0; index < count; index += 1) {
    const sx = source[index].x - sourceMean.x;
    const sy = source[index].y - sourceMean.y;
    const tx = target[index].x - targetMean.x;
    const ty = target[index].y - targetMean.y;
    sourceVariance += sx * sx + sy * sy;
    aNumerator += sx * tx + sy * ty;
    bNumerator += sx * ty - sy * tx;
  }

  if (sourceVariance <= 0) throw new Error('Degenerate face keypoints for alignment.');

  const a = aNumerator / sourceVariance;
  const b = bNumerator / sourceVariance;
  return {
    a,
    b,
    c: -b,
    d: a,
    e: targetMean.x - (a * sourceMean.x - b * sourceMean.y),
    f: targetMean.y - (b * sourceMean.x + a * sourceMean.y),
  };
}

async function inferSFaceEmbedding(session: ort.InferenceSession, bitmap: ImageBitmap) {
  const tensor = bitmapToSFaceTensor(bitmap, 112);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const result = await session.run({ [inputName]: tensor });
  const output = result[outputName];
  return Array.from(output.data as Float32Array);
}

function bitmapToSFaceTensor(bitmap: ImageBitmap, size: number) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas tensor context is unavailable.');
  context.drawImage(bitmap, 0, 0, size, size);
  const image = context.getImageData(0, 0, size, size).data;
  const plane = size * size;
  const data = rgbaToSfaceChw(image, plane);
  return new ort.Tensor('float32', data, [1, 3, size, size]);
}

function fallbackEmbedding(bitmap: ImageBitmap) {
  const size = 28;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas fallback context is unavailable.');
  context.drawImage(bitmap, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  const histogram = new Array(128).fill(0);
  for (let index = 0; index < data.length; index += 4) {
    const luma = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    const bucket = Math.min(127, Math.floor(luma / 2));
    histogram[bucket] += 1;
  }
  return histogram;
}

async function faceBitmapToDataUrl(bitmap: ImageBitmap, maxEdge: number) {
  const scale = Math.min(2.2, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas thumbnail context is unavailable.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return await blobToDataUrl(blob);
}

function combineFaceQuality(baseQuality: number, visualQuality: number, structureQuality: number | undefined, hasFaceKeypoints: boolean) {
  const structure = typeof structureQuality === 'number'
    ? structureQuality
    : hasFaceKeypoints ? 0.4 : 0.48;
  return clamp01(baseQuality * 0.52 + visualQuality * 0.28 + structure * 0.2);
}

function measureFaceVisualQuality(bitmap: ImageBitmap) {
  const size = 48;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return 0;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  const luma = new Float32Array(size * size);
  let sum = 0;
  let min = 255;
  let max = 0;
  for (let pixel = 0, src = 0; pixel < luma.length; pixel += 1, src += 4) {
    const value = 0.2126 * data[src] + 0.7152 * data[src + 1] + 0.0722 * data[src + 2];
    luma[pixel] = value;
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const mean = sum / Math.max(1, luma.length);
  let variance = 0;
  let gradientSum = 0;
  let gradientCount = 0;
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const index = y * size + x;
      const value = luma[index];
      variance += (value - mean) * (value - mean);
      const dx = Math.abs(luma[index + 1] - luma[index - 1]);
      const dy = Math.abs(luma[index + size] - luma[index - size]);
      gradientSum += dx + dy;
      gradientCount += 1;
    }
  }
  const deviation = Math.sqrt(variance / Math.max(1, gradientCount));
  const edgeScore = clamp01((gradientSum / Math.max(1, gradientCount) - 3.4) / 18);
  const contrastScore = clamp01((deviation - 10) / 42);
  const rangeScore = clamp01((max - min - 28) / 130);
  const exposureScore = clamp01(1 - Math.abs(mean - 122) / 126);
  return clamp01(edgeScore * 0.42 + contrastScore * 0.28 + rangeScore * 0.18 + exposureScore * 0.12);
}

function faceStructureQuality(box: FaceBox) {
  return faceStructureQualityFromBoxKeypoints(box);
}

function bestInitialGuidance(
  box: FaceBox,
  initialFaceBoxes: InitialFaceGuidance[] | undefined,
  imageWidth: number,
  imageHeight: number,
) {
  if (!initialFaceBoxes || initialFaceBoxes.length === 0) return undefined;
  let best: { landmarkerStatus?: InitialFaceGuidance['landmarkerStatus']; overlap: number } | undefined;
  initialFaceBoxes.forEach(face => {
    const candidate: FaceBox = {
      x: face.x * imageWidth,
      y: face.y * imageHeight,
      width: face.width * imageWidth,
      height: face.height * imageHeight,
      confidence: face.confidence ?? 0.62,
      source: 'landmarker',
      detector: 'landmarker',
    };
    const overlap = intersectionOverUnion(box, candidate);
    if (!best || overlap > best.overlap) {
      best = { landmarkerStatus: face.landmarkerStatus, overlap };
    }
  });
  return best;
}

function keepBoxesMatchingGuidance(boxes: FaceBox[], guidanceBoxes: FaceBox[]) {
  if (guidanceBoxes.length === 0) return boxes;
  const matched = boxes.filter(box => guidanceBoxes.some(guidance => isSameGuidedFace(box, guidance)));
  const missingGuidance = guidanceBoxes.filter(guidance => (
    !matched.some(box => isSameGuidedFace(box, guidance))
  ));
  return [...matched, ...missingGuidance];
}

function isSameGuidedFace(box: FaceBox, guidance: FaceBox) {
  const overlap = intersectionOverUnion(box, guidance);
  if (overlap >= 0.08) return true;
  const boxCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const guidanceCenter = { x: guidance.x + guidance.width / 2, y: guidance.y + guidance.height / 2 };
  const centerDistance = distance(boxCenter, guidanceCenter);
  const referenceEdge = Math.max(1, Math.max(box.width, box.height, guidance.width, guidance.height));
  return centerDistance / referenceEdge < 0.42;
}

function suppressNearDuplicateFaces(boxes: FaceBox[]) {
  const accepted: FaceBox[] = [];
  [...boxes]
    .sort((a, b) => b.confidence - a.confidence || b.width * b.height - a.width * a.height)
    .forEach(box => {
      const duplicate = accepted.some(existing => isNearDuplicateFace(box, existing));
      if (!duplicate) accepted.push(box);
    });
  return accepted.sort((a, b) => b.width * b.height - a.width * a.height);
}

function isNearDuplicateFace(a: FaceBox, b: FaceBox) {
  const iou = intersectionOverUnion(a, b);
  if (iou >= 0.18) return true;
  const overlap = intersectionArea(a, b) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  const centerDistance = distance(
    { x: a.x + a.width / 2, y: a.y + a.height / 2 },
    { x: b.x + b.width / 2, y: b.y + b.height / 2 },
  );
  const maxFaceEdge = Math.max(a.width, a.height, b.width, b.height, 1);
  return overlap >= 0.42 && centerDistance / maxFaceEdge < 0.42;
}

function intersectionArea(a: FaceBox, b: FaceBox) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read thumbnail blob.'));
    reader.readAsDataURL(blob);
  });
}

async function fetchBytes(url: string, label: string) {
  const response = await fetchResponse(url, label);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchOk(url: string, label: string) {
  await fetchResponse(url, label);
}

async function fetchResponse(url: string, label: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${label} HTTP ${response.status} ${response.statusText || ''}`.trim());
    return response;
  } catch (error) {
    throw new Error(`${label} fetch failed at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolvePublicAssetUrl(path: string) {
  if (!path) return path;
  if (/^(https?:|blob:|data:|file:|asset:|tauri:)/i.test(path)) return path;
  const origin = safeOrigin();
  const publicPath = path.startsWith('./') ? path.slice(1) : path;
  if (origin && publicPath.startsWith('/')) return `${origin}${publicPath}`;
  try {
    return new URL(publicPath, origin ? `${origin}/` : self.location.href).toString();
  } catch {
    return path;
  }
}

function safeOrigin() {
  try {
    const origin = self.location?.origin;
    return origin && origin !== 'null' ? origin : '';
  } catch {
    return '';
  }
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}
