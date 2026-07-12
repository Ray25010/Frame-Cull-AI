import { FaceDetector, FaceLandmarker, FilesetResolver, type Detection } from '@mediapipe/tasks-vision';
import PeopleSplitWorker from '/src/workers/peopleSplit.worker.ts?worker';
import type { AiModelAssets, PeopleFaceBox, PersonCluster, PersonFaceEmbedding } from '/src/types';
import {
  clusterPeopleFaces,
  cosineDistance,
  normalizeEmbedding,
  PEOPLE_CLUSTER_SECONDARY_THRESHOLD,
  PEOPLE_CLUSTER_THRESHOLD,
  PEOPLE_SPLIT_MODEL_VERSION,
} from '/src/utils/peopleSplit';
import {
  faceStructureQualityFromNormalizedLandmarks,
  measureFaceContentQuality,
  shouldKeepLandmarkedFaceByContent,
} from '/src/utils/faceContentValidation';
import type { FaceBox } from '/src/utils/faceDetectionGeometry';
import {
  matchFaceDetectorBoxes,
  type FaceDetectorConfirmationReason,
} from './people-split-detector-confirmation';
import { createFaceConfirmationCrop } from './people-split-crop-confirmation';
import {
  decidePeopleFaceConfirmation,
  PEOPLE_FACE_CROP_LANDMARKER_MIN_IOU,
  PEOPLE_FACE_CROP_LANDMARKER_MIN_SKIN,
  PEOPLE_FACE_FULL_RANGE_MIN_IOU,
  type PeopleFaceConfirmationReason,
} from './people-split-confirmation-policy';
import {
  summarizePeopleSplitPrecisionRun,
  type PeopleSplitAdmission,
} from './people-split-precision-summary';

type RunnerOptions = {
  concurrency?: number;
  limit?: number;
  maxEdge?: number;
  photoTimeoutMs?: number;
};

type PeopleWorkerResponse = {
  type: 'result' | 'error' | 'progress';
  id: string;
  faces?: PersonFaceEmbedding[];
  error?: string;
  stage?: string;
};

type DetectorCheckedFace = PersonFaceEmbedding & {
  workerEligibleForCluster: boolean;
  detectorConfirmed: boolean;
  detectorConfirmationIoU: number;
  detectorConfirmationReason: PeopleFaceConfirmationReason;
  fullRangeDetectorConfirmed: boolean;
  fullRangeDetectorIoU: number;
  fullRangeDetectorReason: FaceDetectorConfirmationReason;
  confirmingDetectorBoxIndex?: number;
  cropDetectorConfirmed: boolean;
  cropDetectorIoU: number;
  cropDetectorConfidence: number;
  cropLandmarkerConfirmed: boolean;
  cropLandmarkerIoU: number;
  cropLandmarkCount: number;
  cropLandmarkerContentPlausible: boolean;
  cropLandmarkerStructureQuality: number;
  cropLandmarkerSkinScore: number;
  cropLandmarkerWheelLikeScore: number;
  cropLandmarkerMonochromeScore: number;
};

type FaceDiagnostic = DetectorCheckedFace & {
  admission: PeopleSplitAdmission;
  assignedClusterId?: string;
  nearestClusterId?: string;
  nearestDistance?: number;
  secondNearestDistance?: number;
  ambiguityMargin?: number;
};

type MediaPipeFaceBox = PeopleFaceBox & {
  confidence: number;
};

type MediaPipePhotoResult = {
  boxes: MediaPipeFaceBox[];
  elapsedMs: number;
  error?: string;
};

type CandidateCropFaceResult = {
  cropDetectorConfirmed: boolean;
  cropDetectorIoU: number;
  cropDetectorConfidence: number;
  cropLandmarkerConfirmed: boolean;
  cropLandmarkerIoU: number;
  cropLandmarkCount: number;
  cropLandmarkerContentPlausible: boolean;
  cropLandmarkerStructureQuality: number;
  cropLandmarkerSkinScore: number;
  cropLandmarkerWheelLikeScore: number;
  cropLandmarkerMonochromeScore: number;
};

type CandidateCropPhotoResult = {
  faces: CandidateCropFaceResult[];
  elapsedMs: number;
  error?: string;
};

type PhotoResult = {
  fileName: string;
  photoId: string;
  fileSize: number;
  elapsedMs: number;
  faces: FaceDiagnostic[];
  mediaPipeBoxes: MediaPipeFaceBox[];
  mediaPipeElapsedMs: number;
  cropConfirmationElapsedMs: number;
  confirmationError?: string;
  cropConfirmationError?: string;
  error?: string;
};

type PeopleSplitPrecisionResult = {
  schemaVersion: string;
  generatedAt: string;
  algorithm: {
    modelVersion: string;
    clusterThreshold: number;
    secondaryThreshold: number;
    preprocessing: string;
    detectorConfirmation: {
      detector: string;
      model: string;
      minimumIoU: number;
      cropDetectorModel: string;
      cropLandmarkerModel: string;
      cropScale: number;
      cropMinimumIoU: number;
      policy: string;
      policyFullRangeMinIoU: number;
      policyCropLandmarkerMinIoU: number;
      policyCropLandmarkerMinSkin: number;
    };
  };
  options: Required<RunnerOptions>;
  totalMs: number;
  results: PhotoResult[];
  clusters: PersonCluster[];
  unassignedFaceKeys: string[];
  summary: ReturnType<typeof summarizePeopleSplitPrecisionRun>;
};

declare global {
  interface Window {
    __FRAMECULL_PEOPLE_SPLIT_READY?: boolean;
    __FRAMECULL_PEOPLE_SPLIT_STATUS?: string;
    runFrameCullPeopleSplitPrecision?: (options?: RunnerOptions) => Promise<PeopleSplitPrecisionResult>;
  }
}

const fileInput = document.querySelector<HTMLInputElement>('#files');
const statusElement = document.querySelector<HTMLPreElement>('#status');
const DEFAULT_OPTIONS: Required<RunnerOptions> = {
  concurrency: 1,
  limit: Number.POSITIVE_INFINITY,
  maxEdge: 1280,
  photoTimeoutMs: 90_000,
};
const MEDIAPIPE_WASM_BASE = '/models/mediapipe/wasm';
const MEDIAPIPE_FACE_DETECTOR_MODEL = '/models/mediapipe/face_detector/blaze_face_full_range.tflite';
const MEDIAPIPE_CROP_FACE_DETECTOR_MODEL = '/models/mediapipe/face_detector/blaze_face_short_range.tflite';
const MEDIAPIPE_FACE_LANDMARKER_MODEL = '/models/mediapipe/face_landmarker/face_landmarker.task';
const DETECTOR_CONFIRMATION_MIN_IOU = 0.18;
const CROP_CONFIRMATION_MIN_IOU = 0.18;
const CROP_LANDMARKER_MIN_IOU = 0.08;
const CROP_CONFIRMATION_SCALE = 1.8;
const CROP_CONFIRMATION_SIZE = 256;

let mediaPipeVisionFilesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;
let mediaPipeFaceDetectorPromise: Promise<FaceDetector> | null = null;
let mediaPipeCropFaceDetectorPromise: Promise<FaceDetector> | null = null;
let mediaPipeFaceLandmarkerPromise: Promise<FaceLandmarker> | null = null;

window.runFrameCullPeopleSplitPrecision = async (options = {}) => {
  if (!fileInput) throw new Error('missing #files input');
  const resolvedOptions = resolveOptions(options);
  const files = Array.from(fileInput.files ?? [])
    .sort((left, right) => naturalCompare(left.name, right.name))
    .slice(0, resolvedOptions.limit);
  if (files.length === 0) throw new Error('no files selected');

  const started = performance.now();
  const results = new Array<PhotoResult>(files.length);
  const allFaces: DetectorCheckedFace[] = [];
  let nextIndex = 0;
  let completed = 0;
  const modelAssets = buildModelAssets();

  const runLane = async () => {
    let worker = new PeopleSplitWorker();
    try {
      while (nextIndex < files.length) {
        const index = nextIndex;
        nextIndex += 1;
        const file = files[index];
        const photoId = `${String(index).padStart(4, '0')}:${file.name.replace(/\.[^.]+$/, '')}`;
        const itemStarted = performance.now();
        try {
          setStatus(`analyzing ${completed}/${files.length}: ${file.name}`);
          const [faces, mediaPipe] = await Promise.all([
            withTimeout(
              analyzePeopleWithWorker(worker, photoId, file, resolvedOptions.maxEdge, modelAssets),
              resolvedOptions.photoTimeoutMs,
              `${file.name}: people split worker timed out`,
            ),
            detectMediaPipeFaces(file, resolvedOptions.maxEdge),
          ]);
          setStatus(`${photoId}: confirming ${faces.length} candidate crops`);
          const cropConfirmation = await detectCandidateCropConfirmations(
            file,
            resolvedOptions.maxEdge,
            faces,
          );
          const checkedFaces = applyDetectorConfirmation(faces, mediaPipe.boxes, cropConfirmation.faces);
          allFaces.push(...checkedFaces);
          results[index] = {
            fileName: file.name,
            photoId,
            fileSize: file.size,
            elapsedMs: performance.now() - itemStarted,
            faces: checkedFaces.map(face => ({ ...face, admission: admissionForFace(face, false) })),
            mediaPipeBoxes: mediaPipe.boxes,
            mediaPipeElapsedMs: mediaPipe.elapsedMs,
            cropConfirmationElapsedMs: cropConfirmation.elapsedMs,
            confirmationError: mediaPipe.error,
            cropConfirmationError: cropConfirmation.error,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results[index] = {
            fileName: file.name,
            photoId,
            fileSize: file.size,
            elapsedMs: performance.now() - itemStarted,
            faces: [],
            mediaPipeBoxes: [],
            mediaPipeElapsedMs: 0,
            cropConfirmationElapsedMs: 0,
            error: message,
          };
          if (message.includes('timed out')) {
            worker.terminate();
            worker = new PeopleSplitWorker();
          }
        } finally {
          completed += 1;
          setStatus(`processed ${completed}/${files.length}`);
        }
      }
    } finally {
      worker.terminate();
    }
  };

  await Promise.all(Array.from({ length: resolvedOptions.concurrency }, () => runLane()));
  setStatus(`clustering ${allFaces.length} faces`);
  const clustered = clusterPeopleFaces(allFaces);
  const diagnostics = buildFaceDiagnostics(allFaces, clustered.clusters, clustered.unassignedFaces);
  const diagnosticsByKey = new Map(diagnostics.map(face => [face.key, face]));
  const finalResults = results.map(result => ({
    ...result,
    faces: result.faces.map(face => diagnosticsByKey.get(face.key) ?? face),
  }));
  const totalMs = performance.now() - started;
  const unassignedFaceKeys = clustered.unassignedFaces.map(face => face.key);
  const summary = summarizePeopleSplitPrecisionRun({
    totalMs,
    results: finalResults,
    clusters: clustered.clusters,
    unassignedFaceKeys,
  });
  const payload: PeopleSplitPrecisionResult = {
    schemaVersion: 'framecull-people-split-precision-v3',
    generatedAt: new Date().toISOString(),
    algorithm: {
      modelVersion: PEOPLE_SPLIT_MODEL_VERSION,
      clusterThreshold: PEOPLE_CLUSTER_THRESHOLD,
      secondaryThreshold: PEOPLE_CLUSTER_SECONDARY_THRESHOLD,
      preprocessing: 'current-production',
      detectorConfirmation: {
        detector: 'MediaPipe FaceDetector',
        model: MEDIAPIPE_FACE_DETECTOR_MODEL,
        minimumIoU: DETECTOR_CONFIRMATION_MIN_IOU,
        cropDetectorModel: MEDIAPIPE_CROP_FACE_DETECTOR_MODEL,
        cropLandmarkerModel: MEDIAPIPE_FACE_LANDMARKER_MODEL,
        cropScale: CROP_CONFIRMATION_SCALE,
        cropMinimumIoU: CROP_CONFIRMATION_MIN_IOU,
        policy: 'full-range-or-crop-landmarker-with-skin',
        policyFullRangeMinIoU: PEOPLE_FACE_FULL_RANGE_MIN_IOU,
        policyCropLandmarkerMinIoU: PEOPLE_FACE_CROP_LANDMARKER_MIN_IOU,
        policyCropLandmarkerMinSkin: PEOPLE_FACE_CROP_LANDMARKER_MIN_SKIN,
      },
    },
    options: resolvedOptions,
    totalMs,
    results: finalResults,
    clusters: clustered.clusters,
    unassignedFaceKeys,
    summary,
  };
  setStatus(`done ${summary.processedPhotos}/${summary.photos}; errors=${summary.failedPhotos}`);
  return payload;
};

window.__FRAMECULL_PEOPLE_SPLIT_READY = true;
setStatus('ready');

function resolveOptions(options: RunnerOptions): Required<RunnerOptions> {
  const limit = Number.isFinite(options.limit) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : DEFAULT_OPTIONS.limit;
  return {
    concurrency: Math.max(1, Math.min(4, Math.floor(options.concurrency ?? DEFAULT_OPTIONS.concurrency))),
    limit,
    maxEdge: Math.max(640, Math.min(2400, Math.floor(options.maxEdge ?? DEFAULT_OPTIONS.maxEdge))),
    photoTimeoutMs: Math.max(10_000, Math.floor(options.photoTimeoutMs ?? DEFAULT_OPTIONS.photoTimeoutMs)),
  };
}

function buildModelAssets(): AiModelAssets {
  return {
    wasmBaseCandidates: ['/models/mediapipe/wasm'],
    modelAssetCandidates: ['/models/mediapipe/face_landmarker/face_landmarker.task'],
    yunetAssetCandidates: ['/models/opencv/yunet/face_detection_yunet_2023mar.onnx'],
    onnxWasmBaseCandidates: ['/models/onnxruntime/'],
    onnxBackend: 'wasm',
  };
}

function applyDetectorConfirmation(
  faces: PersonFaceEmbedding[],
  confirmingBoxes: MediaPipeFaceBox[],
  cropConfirmations: CandidateCropFaceResult[],
): DetectorCheckedFace[] {
  const confirmations = matchFaceDetectorBoxes(
    faces.map(face => face.boundingBox),
    confirmingBoxes,
    DETECTOR_CONFIRMATION_MIN_IOU,
  );
  return faces.map((face, index) => {
    const confirmation = confirmations[index];
    const cropConfirmation = cropConfirmations[index] ?? emptyCandidateCropFaceResult();
    const fullRangeDetectorIoU = round6(confirmation?.bestIoU ?? 0);
    const decision = decidePeopleFaceConfirmation({
      fullRangeIoU: fullRangeDetectorIoU,
      cropLandmarkerIoU: cropConfirmation.cropLandmarkerIoU,
      cropLandmarkerSkinScore: cropConfirmation.cropLandmarkerSkinScore,
    });
    const detectorConfirmationIoU = decision.reason === 'FULL_RANGE'
      ? fullRangeDetectorIoU
      : decision.reason === 'CROP_LANDMARKER'
        ? cropConfirmation.cropLandmarkerIoU
        : Math.max(fullRangeDetectorIoU, cropConfirmation.cropLandmarkerIoU);
    return {
      ...face,
      workerEligibleForCluster: face.eligibleForCluster,
      eligibleForCluster: face.eligibleForCluster && decision.confirmed,
      detectorConfirmed: decision.confirmed,
      detectorConfirmationIoU: round6(detectorConfirmationIoU),
      detectorConfirmationReason: decision.reason,
      fullRangeDetectorConfirmed: confirmation?.confirmed ?? false,
      fullRangeDetectorIoU,
      fullRangeDetectorReason: confirmation?.reason ?? 'NO_CONFIRMING_BOX',
      confirmingDetectorBoxIndex: confirmation?.confirmingBoxIndex,
      ...cropConfirmation,
    };
  });
}

async function detectMediaPipeFaces(file: File, maxEdge: number): Promise<MediaPipePhotoResult> {
  const started = performance.now();
  let bitmap: ImageBitmap | null = null;
  try {
    const prepared = await createMediaPipeInputBitmap(file, maxEdge);
    bitmap = prepared.bitmap;
    const detector = await getMediaPipeFaceDetector();
    const boxes = detector.detect(bitmap).detections
      .map(detection => mediaPipeDetectionToBox(detection, prepared.width, prepared.height))
      .filter((box): box is MediaPipeFaceBox => Boolean(box))
      .sort((left, right) => right.confidence - left.confidence);
    return {
      boxes,
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    return {
      boxes: [],
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    bitmap?.close();
  }
}

async function detectCandidateCropConfirmations(
  file: File,
  maxEdge: number,
  faces: PersonFaceEmbedding[],
): Promise<CandidateCropPhotoResult> {
  const started = performance.now();
  if (faces.length === 0) return { faces: [], elapsedMs: 0 };

  let sourceBitmap: ImageBitmap | null = null;
  try {
    const prepared = await createMediaPipeInputBitmap(file, maxEdge);
    sourceBitmap = prepared.bitmap;
    const cropDetector = await getMediaPipeCropFaceDetector();
    const faceLandmarker = await getMediaPipeFaceLandmarker();
    const results: CandidateCropFaceResult[] = [];
    const failures: string[] = [];

    for (const face of faces) {
      let cropBitmap: ImageBitmap | null = null;
      try {
        const confirmationCrop = createFaceConfirmationCrop(
          face.boundingBox,
          prepared.width,
          prepared.height,
          CROP_CONFIRMATION_SCALE,
        );
        const cropInput = await createCandidateCropBitmap(
          sourceBitmap,
          prepared.width,
          prepared.height,
          confirmationCrop.crop,
        );
        cropBitmap = cropInput.bitmap;
        const detectorBoxes = cropDetector.detect(cropBitmap).detections
          .map(detection => mediaPipeDetectionToBox(
            detection,
            CROP_CONFIRMATION_SIZE,
            CROP_CONFIRMATION_SIZE,
          ))
          .filter((box): box is MediaPipeFaceBox => Boolean(box));
        const detectorMatch = matchFaceDetectorBoxes(
          [confirmationCrop.candidateInCrop],
          detectorBoxes,
          CROP_CONFIRMATION_MIN_IOU,
        )[0];
        const landmarkResult = faceLandmarker.detect(cropBitmap);
        const landmarkCandidates = landmarkResult.faceLandmarks
          .map(landmarks => ({ landmarks, box: landmarksToFaceBox(landmarks) }))
          .filter((candidate): candidate is { landmarks: typeof landmarkResult.faceLandmarks[number]; box: PeopleFaceBox } => (
            Boolean(candidate.box)
          ));
        const landmarkerMatch = matchFaceDetectorBoxes(
          [confirmationCrop.candidateInCrop],
          landmarkCandidates.map(candidate => candidate.box),
          CROP_LANDMARKER_MIN_IOU,
        )[0];
        const matchedLandmarkCandidate = landmarkerMatch?.confirmingBoxIndex === undefined
          ? undefined
          : landmarkCandidates[landmarkerMatch.confirmingBoxIndex];
        const matchedLandmarkPixelBox: FaceBox | undefined = matchedLandmarkCandidate
          ? {
              x: matchedLandmarkCandidate.box.x * CROP_CONFIRMATION_SIZE,
              y: matchedLandmarkCandidate.box.y * CROP_CONFIRMATION_SIZE,
              width: matchedLandmarkCandidate.box.width * CROP_CONFIRMATION_SIZE,
              height: matchedLandmarkCandidate.box.height * CROP_CONFIRMATION_SIZE,
              confidence: face.confidence,
              source: 'full',
              detector: 'mediapipe',
            }
          : undefined;
        const landmarkerContent = matchedLandmarkPixelBox
          ? measureFaceContentQuality(cropInput.imageData, matchedLandmarkPixelBox)
          : undefined;
        const landmarkerStructureQuality = matchedLandmarkPixelBox && matchedLandmarkCandidate
          ? faceStructureQualityFromNormalizedLandmarks(
              matchedLandmarkPixelBox,
              matchedLandmarkCandidate.landmarks,
              CROP_CONFIRMATION_SIZE,
              CROP_CONFIRMATION_SIZE,
            )
          : 0;
        const landmarkerContentPlausible = Boolean(
          landmarkerMatch?.confirmed
          && matchedLandmarkPixelBox
          && matchedLandmarkCandidate
          && shouldKeepLandmarkedFaceByContent(
            cropInput.imageData,
            matchedLandmarkPixelBox,
            matchedLandmarkCandidate.landmarks,
          ),
        );
        results.push({
          cropDetectorConfirmed: detectorMatch?.confirmed ?? false,
          cropDetectorIoU: round6(detectorMatch?.bestIoU ?? 0),
          cropDetectorConfidence: round6(
            detectorMatch?.confirmingBoxIndex === undefined
              ? 0
              : detectorBoxes[detectorMatch.confirmingBoxIndex]?.confidence ?? 0,
          ),
          cropLandmarkerConfirmed: landmarkerMatch?.confirmed ?? false,
          cropLandmarkerIoU: round6(landmarkerMatch?.bestIoU ?? 0),
          cropLandmarkCount: matchedLandmarkCandidate?.landmarks.length ?? 0,
          cropLandmarkerContentPlausible: landmarkerContentPlausible,
          cropLandmarkerStructureQuality: round6(landmarkerStructureQuality),
          cropLandmarkerSkinScore: round6(landmarkerContent?.skinScore ?? 0),
          cropLandmarkerWheelLikeScore: round6(landmarkerContent?.wheelLikeScore ?? 0),
          cropLandmarkerMonochromeScore: round6(landmarkerContent?.monochromeScore ?? 0),
        });
      } catch (error) {
        results.push(emptyCandidateCropFaceResult());
        failures.push(`${face.key}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        cropBitmap?.close();
      }
    }

    return {
      faces: results,
      elapsedMs: performance.now() - started,
      error: failures.length > 0 ? failures.slice(0, 3).join('\n') : undefined,
    };
  } catch (error) {
    return {
      faces: faces.map(() => emptyCandidateCropFaceResult()),
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    sourceBitmap?.close();
  }
}

async function createCandidateCropBitmap(
  sourceBitmap: ImageBitmap,
  imageWidth: number,
  imageHeight: number,
  crop: PeopleFaceBox,
) {
  const canvas = new OffscreenCanvas(CROP_CONFIRMATION_SIZE, CROP_CONFIRMATION_SIZE);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas is unavailable for candidate crop confirmation.');
  context.drawImage(
    sourceBitmap,
    crop.x * imageWidth,
    crop.y * imageHeight,
    crop.width * imageWidth,
    crop.height * imageHeight,
    0,
    0,
    CROP_CONFIRMATION_SIZE,
    CROP_CONFIRMATION_SIZE,
  );
  return {
    bitmap: await createImageBitmap(canvas),
    imageData: context.getImageData(0, 0, CROP_CONFIRMATION_SIZE, CROP_CONFIRMATION_SIZE),
  };
}

function landmarksToFaceBox(landmarks: Array<{ x: number; y: number }>): PeopleFaceBox | null {
  if (landmarks.length === 0) return null;
  const xValues = landmarks.map(point => point.x).filter(Number.isFinite);
  const yValues = landmarks.map(point => point.y).filter(Number.isFinite);
  if (xValues.length === 0 || yValues.length === 0) return null;
  const left = Math.max(0, Math.min(1, Math.min(...xValues)));
  const top = Math.max(0, Math.min(1, Math.min(...yValues)));
  const right = Math.max(left, Math.min(1, Math.max(...xValues)));
  const bottom = Math.max(top, Math.min(1, Math.max(...yValues)));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function emptyCandidateCropFaceResult(): CandidateCropFaceResult {
  return {
    cropDetectorConfirmed: false,
    cropDetectorIoU: 0,
    cropDetectorConfidence: 0,
    cropLandmarkerConfirmed: false,
    cropLandmarkerIoU: 0,
    cropLandmarkCount: 0,
    cropLandmarkerContentPlausible: false,
    cropLandmarkerStructureQuality: 0,
    cropLandmarkerSkinScore: 0,
    cropLandmarkerWheelLikeScore: 0,
    cropLandmarkerMonochromeScore: 0,
  };
}

function getMediaPipeFaceDetector() {
  if (!mediaPipeFaceDetectorPromise) {
    mediaPipeFaceDetectorPromise = (async () => {
      const vision = await getMediaPipeVisionFileset();
      return FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MEDIAPIPE_FACE_DETECTOR_MODEL,
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.25,
        minSuppressionThreshold: 0.3,
      });
    })();
  }
  return mediaPipeFaceDetectorPromise;
}

function getMediaPipeCropFaceDetector() {
  if (!mediaPipeCropFaceDetectorPromise) {
    mediaPipeCropFaceDetectorPromise = (async () => {
      const vision = await getMediaPipeVisionFileset();
      return FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MEDIAPIPE_CROP_FACE_DETECTOR_MODEL,
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.2,
        minSuppressionThreshold: 0.3,
      });
    })();
  }
  return mediaPipeCropFaceDetectorPromise;
}

function getMediaPipeFaceLandmarker() {
  if (!mediaPipeFaceLandmarkerPromise) {
    mediaPipeFaceLandmarkerPromise = (async () => {
      const vision = await getMediaPipeVisionFileset();
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MEDIAPIPE_FACE_LANDMARKER_MODEL,
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        numFaces: 1,
        minFaceDetectionConfidence: 0.2,
        minFacePresenceConfidence: 0.2,
        minTrackingConfidence: 0.2,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    })();
  }
  return mediaPipeFaceLandmarkerPromise;
}

function getMediaPipeVisionFileset() {
  if (!mediaPipeVisionFilesetPromise) {
    mediaPipeVisionFilesetPromise = FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
  }
  return mediaPipeVisionFilesetPromise;
}

async function createMediaPipeInputBitmap(file: File, maxEdge: number) {
  const sourceBitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const dimensions = fitWithin(sourceBitmap.width, sourceBitmap.height, maxEdge);
  if (dimensions.width === sourceBitmap.width && dimensions.height === sourceBitmap.height) {
    return { bitmap: sourceBitmap, ...dimensions };
  }

  try {
    const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OffscreenCanvas is unavailable for MediaPipe image preparation.');
    context.drawImage(sourceBitmap, 0, 0, dimensions.width, dimensions.height);
    const bitmap = await createImageBitmap(canvas);
    return { bitmap, ...dimensions };
  } finally {
    sourceBitmap.close();
  }
}

function mediaPipeDetectionToBox(
  detection: Detection,
  imageWidth: number,
  imageHeight: number,
): MediaPipeFaceBox | null {
  const box = detection.boundingBox;
  if (!box || box.width <= 0 || box.height <= 0) return null;
  const left = Math.max(0, Math.min(imageWidth, box.originX));
  const top = Math.max(0, Math.min(imageHeight, box.originY));
  const right = Math.max(left, Math.min(imageWidth, box.originX + box.width));
  const bottom = Math.max(top, Math.min(imageHeight, box.originY + box.height));
  if (right <= left || bottom <= top) return null;
  return {
    x: left / Math.max(1, imageWidth),
    y: top / Math.max(1, imageHeight),
    width: (right - left) / Math.max(1, imageWidth),
    height: (bottom - top) / Math.max(1, imageHeight),
    confidence: round6(detection.categories?.[0]?.score ?? 0),
  };
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

function analyzePeopleWithWorker(
  worker: Worker,
  photoId: string,
  imageBlob: Blob,
  maxEdge: number,
  modelAssets: AiModelAssets,
) {
  const requestId = `${photoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<PersonFaceEmbedding[]>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    };
    const handleMessage = (event: MessageEvent<PeopleWorkerResponse>) => {
      if (event.data.id !== requestId) return;
      if (event.data.type === 'progress') {
        if (event.data.stage) setStatus(`${photoId}: ${event.data.stage}`);
        return;
      }
      cleanup();
      if (event.data.type === 'result') resolve(event.data.faces ?? []);
      else reject(new Error(event.data.error || 'People split worker failed'));
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error || new Error(event.message));
    };
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError, { once: true });
    worker.postMessage({
      type: 'analyze',
      id: requestId,
      photoId,
      imageBlob,
      maxEdge,
      modelAssets,
      preferInitialFaceBoxes: false,
    });
  });
}

function buildFaceDiagnostics(
  faces: DetectorCheckedFace[],
  clusters: PersonCluster[],
  unassignedFaces: PersonFaceEmbedding[],
) {
  const reviewedByKey = new Map(faces.map(face => [face.key, face]));
  unassignedFaces.forEach(face => {
    if (!reviewedByKey.has(face.key)) reviewedByKey.set(face.key, face as DetectorCheckedFace);
  });
  const clusterByFaceKey = new Map<string, string>();
  clusters.forEach(cluster => cluster.memberFaceKeys.forEach(key => clusterByFaceKey.set(key, cluster.id)));
  const centroids = clusters.map(cluster => ({
    clusterId: cluster.id,
    embedding: weightedCentroid(cluster.memberFaceKeys
      .map(key => reviewedByKey.get(key))
      .filter((face): face is PersonFaceEmbedding => Boolean(face))),
  })).filter(cluster => cluster.embedding.length > 0);

  return Array.from(reviewedByKey.values()).map(face => {
    const assignedClusterId = clusterByFaceKey.get(face.key);
    const distances = centroids
      .map(cluster => ({
        clusterId: cluster.clusterId,
        distance: cosineDistance(normalizeEmbedding(face.embedding), cluster.embedding),
      }))
      .sort((left, right) => left.distance - right.distance);
    const nearest = distances[0];
    const second = distances[1];
    return {
      ...face,
      admission: admissionForFace(face, Boolean(assignedClusterId)),
      assignedClusterId,
      nearestClusterId: nearest?.clusterId,
      nearestDistance: nearest ? round6(nearest.distance) : undefined,
      secondNearestDistance: second ? round6(second.distance) : undefined,
      ambiguityMargin: nearest && second ? round6(second.distance - nearest.distance) : undefined,
    } satisfies FaceDiagnostic;
  });
}

function weightedCentroid(faces: PersonFaceEmbedding[]) {
  const length = faces[0]?.embedding.length ?? 0;
  if (length === 0) return [];
  const values = new Array(length).fill(0);
  let totalWeight = 0;
  faces.forEach(face => {
    const weight = Math.max(0.01, face.quality);
    const embedding = normalizeEmbedding(face.embedding);
    totalWeight += weight;
    for (let index = 0; index < length; index += 1) {
      values[index] += (embedding[index] ?? 0) * weight;
    }
  });
  return normalizeEmbedding(values.map(value => value / Math.max(0.01, totalWeight)));
}

function admissionForFace(face: DetectorCheckedFace, assigned: boolean): PeopleSplitAdmission {
  if (assigned) return 'AUTO_ELIGIBLE';
  return face.workerEligibleForCluster ? 'REVIEW_ONLY' : 'REJECTED';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId: number | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function setStatus(status: string) {
  window.__FRAMECULL_PEOPLE_SPLIT_STATUS = status;
  if (statusElement) statusElement.textContent = status;
}
