import {
  FaceDetector,
  FaceLandmarker,
  type Detection,
  type FaceDetectorResult,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import * as ort from 'onnxruntime-web/wasm';
import type {
  AiAnalysis,
  AiAestheticScore,
  AiDiagnostics,
  AiFaceDiagnostic,
  AiFocusMode,
  AiMetrics,
  AiModelAssets,
  AiPhotoKind,
  AiRegion,
  AiSettings,
} from '../types';
import { classifyAiIssues, shouldDetectFacesForAi, thresholdsForIssue } from '../utils/aiCore';
import { AI_MODEL_VERSION, highestIssueConfidence } from '../utils/aiLabels';
import { buildDuplicateSignature } from '../utils/duplicateDetection';
import { detectGroupPortrait } from '../utils/groupPortrait';
import { buildPhotoScore } from '../utils/photoScoring';
import {
  clampFaceBox,
  createEnhancedFaceDetectionRegions,
  expandFaceBox,
  faceSizeRatio,
  intersectionOverUnion,
  mapFaceBoxFromRegion,
  mergeFaceBoxes,
  shouldRunEnhancedFaceDetection,
  type DetectionRegion,
  type FaceBox,
  type FaceBoxSource,
} from '../utils/faceDetectionGeometry';
import { shouldKeepFaceByContent, shouldKeepLandmarkedFaceByContent } from '../utils/faceContentValidation';
import { bilateralBlinkClosedScore, bilateralEarClosedScore } from '../utils/eyeScoring';
import { decodeYuNetOutputs, type YuNetOutputMap } from '../utils/yunetPostprocess';
import { rankSubjects, type SubjectRankInput } from '../utils/subjectRanker';

type OnnxBackend = NonNullable<AiModelAssets['onnxBackend']>;
const ENABLE_EXPERIMENTAL_ONNX_WEBGPU = import.meta.env.VITE_FRAMECULL_ENABLE_WEBGPU === '1';

interface AnalyzeRequest {
  type: 'analyze';
  id: string;
  imageData: ImageData;
  settings: AiSettings;
  modelAssets?: AiModelAssets;
}

interface AnalyzeResponse {
  type: 'result' | 'error';
  id: string;
  analysis?: AiAnalysis;
  error?: string;
}

type VisionWasmFileset = {
  wasmLoaderPath: string;
  wasmBinaryPath: string;
  assetLoaderPath?: string;
  assetBinaryPath?: string;
};

type FaceLoaderResult = {
  landmarker?: FaceLandmarker;
  error?: string;
  wasmBase?: string;
  modelAssetPath?: string;
};

type FaceDetectorLoaderResult = {
  detector?: FaceDetector;
  error?: string;
  wasmBase?: string;
  modelAssetPath?: string;
};

type YuNetLoaderResult = {
  session?: ort.InferenceSession;
  error?: string;
  modelAssetPath?: string;
  wasmBase?: string;
  backend?: OnnxBackend;
};

type AestheticLoaderResult = {
  session?: ort.InferenceSession;
  error?: string;
  modelAssetPath?: string;
  wasmBase?: string;
  backend?: OnnxBackend;
};

type FaceCandidateResult = {
  boxes: FaceBox[];
  enhancedPasses: number;
  status: AiAnalysis['faceModelStatus'];
  error?: string;
  wasmBase?: string;
  modelAssetPath?: string;
  detectorName?: string;
};

type WasmMode = 'module' | 'classic' | 'nosimd';

type WasmCandidate = {
  wasmMode: WasmMode;
  wasmLoaderPath: string;
  wasmBinaryPath: string;
  preloadModule: boolean;
};

type MediaPipeWorkerGlobal = typeof globalThis & {
  Module?: unknown;
  ModuleFactory?: unknown;
};

type FaceCandidate = WasmCandidate & {
  modelAssetPath: string;
};

type FocusMetrics = {
  sharpness: number;
  tenengrad: number;
  edgeDensity: number;
  focusTextureScore: number;
};

type FaceFocusAnalysis = {
  index: number;
  face: LandmarkedFace & { landmarks: NormalizedLandmark[] };
  focusRoi: Roi;
  faceRoi: Roi;
  focus: FocusMetrics;
  focusPeaks: {
    peakSharpness: number;
    peakTenengrad: number;
    peakTextureScore: number;
    tileCount: number;
  };
  focusDecision: ReturnType<typeof decideFocusReliability>;
};

type LandmarkedFace = {
  candidate: FaceBox;
  landmarks?: NormalizedLandmark[];
  blendshapes?: FaceLandmarkerResult['faceBlendshapes'][number];
  status: 'OK' | 'FAILED' | 'SKIPPED';
  skippedReason?: string;
};

type FaceCrop = {
  bitmap: ImageBitmap;
  roi: Roi;
  outputWidth: number;
  outputHeight: number;
  scaleX: number;
  scaleY: number;
};

type FaceCascadeAnalysis = {
  faceCandidates: FaceBox[];
  faces: LandmarkedFace[];
  faceDiagnostics: AiFaceDiagnostic[];
  faceDetectorStatus: AiAnalysis['faceModelStatus'];
  faceModelStatus: AiAnalysis['faceModelStatus'];
  faceDetectorError?: string;
  landmarkerError?: string;
  faceDetectorWasmBase?: string;
  faceDetectorAssetPath?: string;
  faceDetectorName?: string;
  landmarkerWasmBase?: string;
  landmarkerAssetPath?: string;
  enhancedPasses: number;
};

let faceLandmarkerPromise: Promise<FaceLoaderResult> | null = null;
let faceLandmarkerKey = '';
let faceDetectorPromise: Promise<FaceDetectorLoaderResult> | null = null;
let faceDetectorKey = '';
let yunetPromise: Promise<YuNetLoaderResult> | null = null;
let yunetKey = '';
let aestheticPromise: Promise<AestheticLoaderResult> | null = null;
let aestheticKey = '';
// Group photos can yield dozens of face boxes; only the strongest candidates need expensive landmarks.
const MAX_LANDMARKER_FACE_CANDIDATES = 8;

self.onmessage = async (event: MessageEvent<AnalyzeRequest>) => {
  const request = event.data;
  if (request.type !== 'analyze') return;

  try {
    const analysis = await analyzeImage(request.imageData, request.settings, request.modelAssets);
    const response: AnalyzeResponse = { type: 'result', id: request.id, analysis };
    self.postMessage(response);
  } catch (error) {
    const response: AnalyzeResponse = {
      type: 'error',
      id: request.id,
      error: error instanceof Error ? error.message : 'Unknown AI analysis error',
    };
    self.postMessage(response);
  }
};

async function analyzeImage(imageData: ImageData, settings: AiSettings, modelAssets?: AiModelAssets): Promise<AiAnalysis> {
  const luma = buildLuma(imageData);
  const aestheticPromise = analyzeAestheticScore(imageData, modelAssets);
  const faceCascadePromise = analyzeFacesWithCascade(imageData, settings, modelAssets);
  const duplicateSignature = settings.duplicateSensitivity !== 'off'
    ? buildDuplicateSignature(imageData)
    : undefined;
  const [aesthetic, faceCascade] = await Promise.all([aestheticPromise, faceCascadePromise]);
  const landmarkedFaces = faceCascade.faces.filter(
    (face): face is LandmarkedFace & { landmarks: NormalizedLandmark[] } => Boolean(face.landmarks)
  );
  const faceCount = landmarkedFaces.length;
  const faceModelStatus = faceCascade.faceModelStatus;
  const rankedSubjects = rankSubjects(buildSubjectRankInputs(
    faceCascade.faces,
    faceCascade.faceDiagnostics,
    luma.values,
    imageData.width,
    imageData.height
  ));
  const rankedByIndex = new Map(rankedSubjects.faces.map(face => [face.index, face]));
  const rankedEyeDiagnostics = faceCascade.faceDiagnostics.map(face => ({
    ...face,
    ...rankedByIndex.get(face.index),
  }));
  const primaryFaceIndices = new Set(rankedSubjects.primaryFaceIndices);
  const groupPortrait = detectGroupPortrait(rankedEyeDiagnostics);
  const formalFaceIndices = new Set(
    groupPortrait.photoKind === 'GROUP_PORTRAIT'
      ? groupPortrait.groupFaceIndices
      : rankedSubjects.primaryFaceIndices
  );
  const eyeDiagnostics = classifyWorkerFaceEyes(rankedEyeDiagnostics, settings, formalFaceIndices);
  const closedEyeFaces = eyeDiagnostics.filter(face => face.closed);
  const reviewEyeFaces = eyeDiagnostics.filter(face => face.reviewHint === true);
  const formalEyeDiagnostics = eyeDiagnostics.filter(face => formalFaceIndices.has(face.index));
  const groupFaceIndexSet = new Set(groupPortrait.groupFaceIndices);
  const eyeClosedScore = closedEyeFaces.length > 0
    ? maxEyeClosedScore(closedEyeFaces)
    : maxEyeClosedScore(formalEyeDiagnostics);
  const eyeReviewScore = reviewEyeFaces.length > 0
    ? maxEyeClosedScore(reviewEyeFaces)
    : maxEyeClosedScore(formalEyeDiagnostics);
  const primaryEyeDiagnostics = eyeDiagnostics.filter(face => primaryFaceIndices.has(face.index));
  const primaryFaces = faceCascade.faces
    .map((face, index) => ({ face, index }))
    .filter((item): item is { face: LandmarkedFace & { landmarks: NormalizedLandmark[] }; index: number } => (
      primaryFaceIndices.has(item.index) && Boolean(item.face.landmarks)
    ));
  const primaryFocusAnalyses = primaryFaces.map(item => analyzePrimaryFaceFocus(
    item.face,
    item.index,
    luma.values,
    imageData.width,
    imageData.height,
    faceModelStatus,
    settings
  ));
  const selectedFocusAnalysis = selectFocusAnalysis(primaryFocusAnalyses);
  const focusRoi = selectedFocusAnalysis?.focusRoi ?? centerRoi(imageData.width, imageData.height);
  const focus = selectedFocusAnalysis?.focus ?? focusMetrics(luma.values, imageData.width, imageData.height, focusRoi);
  const focusPeaks = selectedFocusAnalysis?.focusPeaks ?? {
    peakSharpness: focus.sharpness,
    peakTenengrad: focus.tenengrad,
    peakTextureScore: focus.focusTextureScore,
    tileCount: 0,
  };
  const focusDecision = selectedFocusAnalysis?.focusDecision ?? focusDecisionWithoutPrimarySubject(
    faceModelStatus,
    faceCount,
    settings,
    rankedSubjects.subjectDecision
  );
  const subjectRoi = primaryFocusAnalyses.length > 0
    ? expandedUnionRoi(primaryFocusAnalyses.map(item => item.faceRoi), imageData.width, imageData.height)
    : centerRoi(imageData.width, imageData.height);
  const subjectLuma = summarizeRoiLuma(luma.values, imageData.width, imageData.height, subjectRoi);
  const primaryFaceDiagnostic = primaryEyeDiagnostics[0];

  const metrics: AiMetrics = {
    sharpness: focus.sharpness,
    tenengrad: focus.tenengrad,
    edgeDensity: focus.edgeDensity,
    focusTextureScore: focus.focusTextureScore,
    focusPeakSharpness: focusPeaks.peakSharpness,
    focusPeakTenengrad: focusPeaks.peakTenengrad,
    focusPeakTextureScore: focusPeaks.peakTextureScore,
    focusTileCount: focusPeaks.tileCount,
    meanLuma: luma.mean,
    subjectMeanLuma: subjectLuma.mean,
    darkClipRatio: luma.darkClipRatio,
    highlightClipRatio: luma.highlightClipRatio,
    shadowRatio: luma.shadowRatio,
    highlightRatio: luma.highlightRatio,
    midtoneMeanLuma: luma.midtoneMean,
    p10Luma: luma.p10,
    p50Luma: luma.p50,
    p90Luma: luma.p90,
    subjectDarkClipRatio: subjectLuma.darkClipRatio,
    subjectHighlightClipRatio: subjectLuma.highlightClipRatio,
    subjectReliable: rankedSubjects.primarySubjectCount > 0,
    faceCount,
    faceCandidateCount: faceCascade.faceCandidates.length,
    landmarkedFaceCount: landmarkedFaces.length,
    enhancedFaceDetectionPasses: faceCascade.enhancedPasses,
    focusMode: focusDecision.focusMode,
    focusReliable: focusDecision.focusReliable,
    focusReliabilityScore: focusDecision.focusReliable ? 1 : 0.48,
    faceQualityScore: primaryFaceDiagnostic?.faceQualityScore,
    eyeReliability: primaryFaceDiagnostic?.eyeReliability,
    poseReliability: primaryFaceDiagnostic?.poseReliability,
    subjectExposureScore: subjectLuma.mean / 255,
    primarySubjectCount: rankedSubjects.primarySubjectCount,
    subjectConfidenceScore: primaryFaceDiagnostic?.subjectScore,
    subjectConfidence: rankedSubjects.subjectConfidence,
    eyeClosedScore: eyeClosedScore > 0 ? eyeClosedScore : undefined,
    eyeReviewScore: eyeReviewScore > 0 ? eyeReviewScore : undefined,
    eyeClosedFaceCount: closedEyeFaces.length,
    eyeReviewFaceCount: reviewEyeFaces.length,
    groupFaceCount: groupPortrait.photoKind === 'GROUP_PORTRAIT'
      ? groupPortrait.groupFaceCount
      : undefined,
    groupEyeClosedFaceCount: groupPortrait.photoKind === 'GROUP_PORTRAIT'
      ? closedEyeFaces.filter(face => groupFaceIndexSet.has(face.index)).length
      : undefined,
    groupEyeReviewFaceCount: groupPortrait.photoKind === 'GROUP_PORTRAIT'
      ? reviewEyeFaces.filter(face => groupFaceIndexSet.has(face.index)).length
      : undefined,
    groupPortraitScore: groupPortrait.groupPortraitScore,
  };

  const diagnostics: AiDiagnostics = {
    focusMode: focusDecision.focusMode,
    focusReliable: focusDecision.focusReliable,
    focusSkipReason: focusDecision.focusSkipReason,
    eyeSkipReason: buildWorkerEyeSkipReason(
      groupPortrait.photoKind,
      groupPortrait.groupPortraitReason,
      rankedSubjects.subjectDecision,
      formalEyeDiagnostics,
      closedEyeFaces,
      reviewEyeFaces,
      formalFaceIndices
    ),
    modelLoadError: faceCascade.landmarkerError,
    wasmBase: faceCascade.landmarkerWasmBase,
    modelAssetPath: faceCascade.landmarkerAssetPath,
    faceDetectorStatus: faceCascade.faceDetectorStatus,
    faceDetectorError: faceCascade.faceDetectorError,
    faceDetectorAssetPath: faceCascade.faceDetectorAssetPath,
    faceDetectorName: faceCascade.faceDetectorName,
    landmarkerSuccessCount: landmarkedFaces.length,
    faceDiagnostics: eyeDiagnostics,
    primaryFaceIndices: rankedSubjects.primaryFaceIndices,
    primarySubjectCount: rankedSubjects.primarySubjectCount,
    subjectConfidence: rankedSubjects.subjectConfidence,
    subjectDecision: rankedSubjects.subjectDecision,
    photoKind: groupPortrait.photoKind,
    groupFaceIndices: groupPortrait.groupFaceIndices,
    groupPortraitReason: groupPortrait.groupPortraitReason,
  };
  const regions = [
    ...faceCascade.faces.map((face, index) => normalizeRegion(
      face.landmarks ? faceBounds(face.landmarks, imageData.width, imageData.height) : faceBoxToRoi(face.candidate),
      imageData.width,
      imageData.height,
      'detector',
      faceRegionLabel(eyeDiagnostics.find(item => item.index === index), index, groupFaceIndexSet.has(index))
    )),
    ...(focusDecision.focusReliable || rankedSubjects.primarySubjectCount > 0
      ? [normalizeRegion(
        focusRoi,
        imageData.width,
        imageData.height,
        rankedSubjects.primarySubjectCount > 0 ? 'face' : 'center',
        rankedSubjects.primarySubjectCount > 0 ? 'Primary subject focus ROI' : 'High-texture non-face ROI'
      )]
      : []),
    ...(rankedSubjects.primarySubjectCount > 0
      ? [normalizeRegion(subjectRoi, imageData.width, imageData.height, 'face', 'Primary subject exposure ROI')]
      : []),
  ];
  const issues = classifyAiIssues(metrics, settings);
  const photoScore = buildPhotoScore({
    metrics,
    diagnostics,
    issues,
    aesthetic,
  });

  return {
    status: 'DONE',
    issues,
    confidence: highestIssueConfidence(issues),
    preset: settings.sensitivity,
    reviewed: false,
    modelVersion: AI_MODEL_VERSION,
    analyzedAt: Date.now(),
    error: faceCascade.landmarkerError,
    faceModelStatus,
    metrics,
    regions,
    diagnostics,
    duplicateSignature,
    photoScore,
  };
}

function buildLuma(imageData: ImageData) {
  const { data, width, height } = imageData;
  const values = new Float32Array(width * height);
  let sum = 0;
  let dark = 0;
  let shadow = 0;
  let midtoneSum = 0;
  let midtoneCount = 0;
  let bright = 0;
  let highlight = 0;
  const histogram = new Uint32Array(256);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    values[p] = y;
    sum += y;
    const bucket = y >= 255 ? 255 : y <= 0 ? 0 : (y + 0.5) | 0;
    histogram[bucket] += 1;
    if (y <= 18) dark += 1;
    if (y <= 88) shadow += 1;
    if (y >= 64 && y <= 192) {
      midtoneSum += y;
      midtoneCount += 1;
    }
    if (y >= 210) bright += 1;
    if (y >= 245) highlight += 1;
  }

  const total = width * height || 1;
  return {
    values,
    mean: sum / total,
    darkClipRatio: dark / total,
    highlightClipRatio: highlight / total,
    shadowRatio: shadow / total,
    highlightRatio: bright / total,
    midtoneMean: midtoneCount > 0 ? midtoneSum / midtoneCount : sum / total,
    p10: percentileFromHistogram(histogram, total, 0.1),
    p50: percentileFromHistogram(histogram, total, 0.5),
    p90: percentileFromHistogram(histogram, total, 0.9),
  };
}

function focusMetrics(luma: Float32Array, width: number, height: number, roi: Roi): FocusMetrics {
  const x0 = Math.max(1, Math.floor(roi.x));
  const y0 = Math.max(1, Math.floor(roi.y));
  const x1 = Math.min(width - 1, Math.ceil(roi.x + roi.width));
  const y1 = Math.min(height - 1, Math.ceil(roi.y + roi.height));
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let sobelEnergy = 0;
  let texturedPixels = 0;
  const stride = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 900));

  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const idx = y * width + x;
      const value = (
        -4 * luma[idx] +
        luma[idx - 1] +
        luma[idx + 1] +
        luma[idx - width] +
        luma[idx + width]
      );
      sum += value;
      sumSq += value * value;
      const gx = (
        -luma[idx - width - 1] -
        2 * luma[idx - 1] -
        luma[idx + width - 1] +
        luma[idx - width + 1] +
        2 * luma[idx + 1] +
        luma[idx + width + 1]
      );
      const gy = (
        -luma[idx - width - 1] -
        2 * luma[idx - width] -
        luma[idx - width + 1] +
        luma[idx + width - 1] +
        2 * luma[idx + width] +
        luma[idx + width + 1]
      );
      const sobelMagnitude = Math.hypot(gx, gy);
      sobelEnergy += sobelMagnitude * sobelMagnitude;
      if (sobelMagnitude > 22) texturedPixels += 1;
      count += 1;
    }
  }

  if (count === 0) {
    return {
      sharpness: 0,
      tenengrad: 0,
      edgeDensity: 0,
      focusTextureScore: 0,
    };
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  const sharpness = clamp100(Math.sqrt(Math.max(0, variance)) * 2.2);
  const tenengrad = clamp100(Math.sqrt(sobelEnergy / count) / 5.5);
  const edgeDensity = texturedPixels / count;

  return {
    sharpness,
    tenengrad,
    edgeDensity,
    focusTextureScore: Math.min(sharpness, tenengrad),
  };
}

function summarizeRoiLuma(luma: Float32Array, width: number, height: number, roi: Roi) {
  const x0 = Math.max(0, Math.floor(roi.x));
  const y0 = Math.max(0, Math.floor(roi.y));
  const x1 = Math.min(width, Math.ceil(roi.x + roi.width));
  const y1 = Math.min(height, Math.ceil(roi.y + roi.height));
  let count = 0;
  let sum = 0;
  let dark = 0;
  let highlight = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = luma[y * width + x] ?? 0;
      sum += value;
      if (value <= 18) dark += 1;
      if (value >= 245) highlight += 1;
      count += 1;
    }
  }

  const total = count || 1;
  return {
    mean: sum / total,
    darkClipRatio: dark / total,
    highlightClipRatio: highlight / total,
  };
}

function decideFocusReliability(
  faceModelStatus: AiAnalysis['faceModelStatus'],
  faceCount: number,
  primaryFaceLandmarks: NormalizedLandmark[] | undefined,
  width: number,
  height: number,
  settings: AiSettings
): { focusMode: AiFocusMode; focusReliable: boolean; focusSkipReason?: string } {
  if (!settings.enabledChecks.OUT_OF_FOCUS) {
    return {
      focusMode: 'NO_FACE_UNRELIABLE',
      focusReliable: false,
      focusSkipReason: '\u5931\u7126\u68c0\u6d4b\u672a\u542f\u7528\u3002',
    };
  }

  if (faceModelStatus === 'UNAVAILABLE') {
    return {
      focusMode: 'NO_FACE_UNRELIABLE',
      focusReliable: false,
      focusSkipReason: '\u4eba\u8138\u6a21\u578b\u4e0d\u53ef\u7528\uff0c\u8df3\u8fc7\u5931\u7126\u5224\u65ad\u4ee5\u907f\u514d\u8bef\u5224\u3002',
    };
  }

  if (faceModelStatus === 'UNUSED') {
    return {
      focusMode: 'NO_FACE_UNRELIABLE',
      focusReliable: false,
      focusSkipReason: '\u672a\u542f\u7528\u4eba\u8138\u6a21\u578b\uff0c\u8df3\u8fc7\u5931\u7126\u5224\u65ad\u3002',
    };
  }

  if (primaryFaceLandmarks) {
    const geometrySkipReason = faceFocusSkipReason(primaryFaceLandmarks, width, height);
    if (geometrySkipReason) {
      return {
        focusMode: 'FACE_ROI',
        focusReliable: false,
        focusSkipReason: geometrySkipReason,
      };
    }

    return {
      focusMode: 'FACE_ROI',
      focusReliable: true,
    };
  }

  if (faceCount > 0) {
    return {
      focusMode: 'NO_FACE_UNRELIABLE',
      focusReliable: false,
      focusSkipReason: '\u68c0\u6d4b\u5230\u4eba\u8138\uff0c\u4f46\u89d2\u5ea6\u6216\u906e\u6321\u5bfc\u81f4\u5931\u7126\u5224\u65ad\u4e0d\u53ef\u9760\u3002',
    };
  }

  return {
    focusMode: 'NO_FACE_UNRELIABLE',
    focusReliable: false,
    focusSkipReason: '\u672a\u68c0\u6d4b\u5230\u4eba\u8138\uff0c\u8df3\u8fc7\u4eba\u50cf\u5931\u7126\u5224\u65ad\u3002',
  };
}

async function analyzeFacesWithCascade(
  imageData: ImageData,
  settings: AiSettings,
  modelAssets?: AiModelAssets
): Promise<FaceCascadeAnalysis> {
  if (!shouldDetectFacesForAi(settings)) {
    return {
      faceCandidates: [],
      faces: [],
      faceDiagnostics: [],
      faceDetectorStatus: 'UNUSED',
      faceModelStatus: 'UNUSED',
      enhancedPasses: 0,
    };
  }

  const detectorResult = await detectFaceCandidates(imageData, modelAssets);
  const landmarkerLoader = await getFaceLandmarker(modelAssets);
  const faceModelStatus: AiAnalysis['faceModelStatus'] = landmarkerLoader.landmarker ? 'READY' : 'UNAVAILABLE';
  let faceCandidates = detectorResult.boxes;
  let faces: LandmarkedFace[] = [];
  let landmarkerError = landmarkerLoader.error;

  if (landmarkerLoader.landmarker && faceCandidates.length > 0) {
    faces = await detectLandmarksOnCandidates(
      imageData,
      limitFaceCandidatesForLandmarker(faceCandidates),
      landmarkerLoader.landmarker
    );
  } else if (landmarkerLoader.landmarker && detectorResult.status === 'UNAVAILABLE') {
    const fallback = await detectFullImageLandmarks(imageData, landmarkerLoader.landmarker);
    faces = fallback.faces;
    faceCandidates = mergeFaceBoxes(
      [...faceCandidates, ...fallback.faces.map(face => face.candidate)],
      0.35
    );
    landmarkerError = fallback.error ?? landmarkerError;
  } else if (!landmarkerLoader.landmarker && faceCandidates.length > 0) {
    faces = faceCandidates.map(candidate => ({
      candidate,
      status: 'SKIPPED',
      skippedReason: landmarkerLoader.error
        ? `Face landmarker unavailable; skipped eye/focus hard checks: ${firstLine(landmarkerLoader.error)}`
        : 'Face landmarker unavailable; skipped eye/focus hard checks.',
    }));
  }

  faces = filterNonHumanLandmarkedFaces(faces, imageData);
  faceCandidates = faceCandidates.filter(candidate => faces.some(face => intersectionOverUnion(face.candidate, candidate) > 0.12));
  const faceDiagnostics = analyzeLandmarkedFacesForEyes(faces, imageData.width, imageData.height);

  return {
    faceCandidates,
    faces,
    faceDiagnostics,
    faceDetectorStatus: detectorResult.status,
    faceModelStatus,
    faceDetectorError: detectorResult.error,
    landmarkerError,
    faceDetectorWasmBase: detectorResult.wasmBase,
    faceDetectorAssetPath: detectorResult.modelAssetPath,
    faceDetectorName: detectorResult.detectorName,
    landmarkerWasmBase: landmarkerLoader.wasmBase,
    landmarkerAssetPath: landmarkerLoader.modelAssetPath,
    enhancedPasses: detectorResult.enhancedPasses,
  };
}

async function detectFaceCandidates(imageData: ImageData, modelAssets?: AiModelAssets): Promise<FaceCandidateResult> {
  const yunetLoader = await getYuNetDetector(modelAssets);
  if (yunetLoader.session) {
    try {
      const yunetBoxes = await detectYuNetCandidates(imageData, yunetLoader.session);
      if (yunetBoxes.length > 0) {
        return {
          boxes: filterFaceCandidatesForLandmarker(
            mergeFaceBoxes(yunetBoxes, 0.28),
            imageData.width,
            imageData.height
          ),
          enhancedPasses: yunetBoxes.some(box => box.source !== 'full') ? 1 : 0,
          status: 'READY',
          wasmBase: yunetLoader.wasmBase,
          modelAssetPath: yunetLoader.modelAssetPath,
          detectorName: 'YuNet',
        };
      }
    } catch (error) {
      const fallback = await detectMediaPipeFaceCandidates(imageData, modelAssets);
      return {
        ...fallback,
        error: [
          error instanceof Error ? `YuNet failed: ${error.message}` : 'YuNet failed.',
          fallback.error,
        ].filter(Boolean).join('\n'),
      };
    }
  }

  const fallback = await detectMediaPipeFaceCandidates(imageData, modelAssets);
  if (!fallback.error && yunetLoader.error) {
    return {
      ...fallback,
      error: `YuNet unavailable; MediaPipe fallback used.\n${yunetLoader.error}`,
    };
  }
  return fallback;
}

async function detectMediaPipeFaceCandidates(imageData: ImageData, modelAssets?: AiModelAssets): Promise<FaceCandidateResult> {
  const loader = await getFaceDetector(modelAssets);
  if (!loader.detector) {
    return {
      boxes: [],
      enhancedPasses: 0,
      status: 'UNAVAILABLE',
      error: loader.error || 'Face detector is unavailable.',
      wasmBase: loader.wasmBase,
      modelAssetPath: loader.modelAssetPath,
      detectorName: 'MediaPipe FaceDetector',
    };
  }

  const boxes: FaceBox[] = [];
  let enhancedPasses = 0;
  let bitmap: ImageBitmap | null = null;

  try {
    bitmap = await createImageBitmap(imageData);
    boxes.push(...runFaceDetector(loader.detector, bitmap, 'full', imageData.width, imageData.height));
  } catch (error) {
    return {
      boxes: [],
      enhancedPasses: 0,
      status: 'UNAVAILABLE',
      error: error instanceof Error ? `Face detector failed on full image: ${error.message}` : 'Face detector failed on full image.',
      wasmBase: loader.wasmBase,
      modelAssetPath: loader.modelAssetPath,
      detectorName: 'MediaPipe FaceDetector',
    };
  } finally {
    bitmap?.close();
  }

  if (shouldRunEnhancedFaceDetection(boxes, imageData.width, imageData.height)) {
    const regions = createEnhancedFaceDetectionRegions(imageData.width, imageData.height);
    for (const region of regions) {
      let regionBitmap: ImageBitmap | null = null;
      try {
        regionBitmap = await cropImageDataToBitmap(imageData, region);
        const regionBoxes = runFaceDetector(loader.detector, regionBitmap, region.source, region.width, region.height);
        boxes.push(...regionBoxes.map(box => mapFaceBoxFromRegion(
          box,
          region,
          region.width,
          region.height,
          imageData.width,
          imageData.height
        )));
        enhancedPasses += 1;
      } catch {
        // Tile detection is a best-effort enhancement; the full-image detector result remains valid.
      } finally {
        regionBitmap?.close();
      }
    }
  }

  return {
    boxes: filterFaceCandidatesForLandmarker(
      mergeFaceBoxes(boxes, 0.35),
      imageData.width,
      imageData.height
    ),
    enhancedPasses,
    status: 'READY',
    wasmBase: loader.wasmBase,
    modelAssetPath: loader.modelAssetPath,
    detectorName: 'MediaPipe FaceDetector',
  };
}

function runFaceDetector(
  detector: FaceDetector,
  bitmap: ImageBitmap,
  source: FaceBoxSource,
  imageWidth: number,
  imageHeight: number
) {
  const result: FaceDetectorResult = detector.detect(bitmap);
  return result.detections
    .map(detection => detectionToFaceBox(detection, source, imageWidth, imageHeight))
    .filter((box): box is FaceBox => Boolean(box));
}

async function detectYuNetCandidates(imageData: ImageData, session: ort.InferenceSession): Promise<FaceBox[]> {
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
        // YuNet crop enhancement is best-effort; full-frame results remain usable.
      }
    }
  }

  return boxes;
}

async function runYuNetOnImageData(
  imageData: ImageData,
  session: ort.InferenceSession,
  source: FaceBoxSource
): Promise<FaceBox[]> {
  const input = prepareYuNetInput(imageData);
  const tensor = new ort.Tensor('float32', input.data, [1, 3, input.inputSize, input.inputSize]);
  const outputs = await session.run({ input: tensor });
  const decoded = decodeYuNetOutputs(outputs as YuNetOutputMap, {
    sourceWidth: imageData.width,
    sourceHeight: imageData.height,
    inputSize: input.inputSize,
    scale: input.scale,
    offsetX: input.offsetX,
    offsetY: input.offsetY,
  }, 0.38);
  return decoded.map(box => ({
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
    data[pixel] = resized[src + 2]; // B
    data[planeSize + pixel] = resized[src + 1]; // G
    data[planeSize * 2 + pixel] = resized[src]; // R
  }

  return {
    data,
    inputSize,
    scale,
    offsetX,
    offsetY,
  };
}

function cropImageData(imageData: ImageData, region: DetectionRegion) {
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(region.width)), Math.max(1, Math.round(region.height)));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas crop context is unavailable for YuNet.');
  const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('OffscreenCanvas source context is unavailable for YuNet crop.');
  sourceContext.putImageData(imageData, 0, 0);
  context.drawImage(
    sourceCanvas,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function detectionToFaceBox(
  detection: Detection,
  source: FaceBoxSource,
  imageWidth: number,
  imageHeight: number
): FaceBox | null {
  const boundingBox = detection.boundingBox;
  if (!boundingBox || boundingBox.width <= 0 || boundingBox.height <= 0) return null;
  const confidence = detection.categories?.[0]?.score ?? 0;
  return clampFaceBox({
    x: boundingBox.originX,
    y: boundingBox.originY,
    width: boundingBox.width,
    height: boundingBox.height,
    confidence,
    source,
    detector: 'mediapipe',
  }, imageWidth, imageHeight);
}

function filterFaceCandidatesForLandmarker(boxes: FaceBox[], imageWidth: number, imageHeight: number) {
  const imageArea = Math.max(1, imageWidth * imageHeight);
  return boxes
    .filter(box => {
      const confidenceFloor = box.detector === 'yunet'
        ? (box.source === 'full' ? 0.34 : 0.38)
        : (box.source === 'full' ? 0.28 : 0.3);
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
    .sort((a, b) => {
      const sourceBoost = sourceRank(b.source) - sourceRank(a.source);
      if (sourceBoost !== 0) return sourceBoost;
      return b.confidence - a.confidence;
    });
}

function limitFaceCandidatesForLandmarker(boxes: FaceBox[]) {
  if (boxes.length <= MAX_LANDMARKER_FACE_CANDIDATES) return boxes;
  return boxes
    .slice()
    .sort((left, right) => faceLandmarkerPriority(right) - faceLandmarkerPriority(left))
    .slice(0, MAX_LANDMARKER_FACE_CANDIDATES);
}

function faceLandmarkerPriority(box: FaceBox) {
  const area = box.width * box.height;
  const sourceBoost = box.source === 'full' ? 1.2 : box.source === 'center' ? 1.08 : 1;
  return area * sourceBoost * Math.max(0.1, box.confidence);
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
  const eyesAboveMouth = eyeY < mouthY;
  const noseBetween = nose.y > eyeY - box.height * 0.08 && nose.y < mouthY + box.height * 0.18;

  return (
    eyeRatio >= 0.18 &&
    eyeRatio <= 0.72 &&
    mouthRatio >= 0.12 &&
    mouthRatio <= 0.72 &&
    noseYRatio >= 0.2 &&
    noseYRatio <= 0.78 &&
    eyesAboveMouth &&
    noseBetween
  );
}

function filterNonHumanLandmarkedFaces(faces: LandmarkedFace[], imageData: ImageData) {
  return faces.filter(face => {
    if (face.status === 'OK' && face.landmarks) {
      return shouldKeepLandmarkedFaceByContent(imageData, face.candidate, face.landmarks);
    }
    if (face.status === 'SKIPPED') {
      return shouldKeepFaceByContent(imageData, face.candidate, { detectorOnly: true });
    }
    return false;
  });
}

function sourceRank(source: FaceBoxSource) {
  if (source === 'full') return 3;
  if (source === 'tile' || source === 'center') return 2;
  return 1;
}

async function detectLandmarksOnCandidates(
  imageData: ImageData,
  faceCandidates: FaceBox[],
  landmarker: FaceLandmarker
) {
  const faces: LandmarkedFace[] = [];
  for (const candidate of faceCandidates) {
    faces.push(await landmarkFaceCandidate(imageData, candidate, landmarker));
  }
  return mergeLandmarkedFaces(faces, imageData.width, imageData.height);
}

async function landmarkFaceCandidate(
  imageData: ImageData,
  candidate: FaceBox,
  landmarker: FaceLandmarker
): Promise<LandmarkedFace> {
  let crop: FaceCrop | null = null;
  try {
    const expanded = expandFaceBox(candidate, imageData.width, imageData.height, 2);
    crop = await cropFaceForLandmarker(imageData, expanded);
    const result = landmarker.detect(crop.bitmap);
    const faceIndex = selectPrimaryFaceIndex(result, crop.outputWidth, crop.outputHeight);
    const landmarks = faceIndex >= 0 ? result.faceLandmarks?.[faceIndex] : undefined;
    if (!landmarks) {
      return {
        candidate,
        status: 'FAILED',
        skippedReason: 'Face detector found a box, but the landmarker could not locate eyes in the upsampled crop.',
      };
    }

    const mappedLandmarks = mapLandmarksFromCrop(landmarks, crop, imageData.width, imageData.height);
    const verifiedCandidate = verifiedCandidateFromLandmarks(mappedLandmarks, candidate, imageData.width, imageData.height);

    return {
      candidate: verifiedCandidate,
      landmarks: mappedLandmarks,
      blendshapes: result.faceBlendshapes?.[faceIndex],
      status: 'OK',
    };
  } catch (error) {
    return {
      candidate,
      status: 'FAILED',
      skippedReason: error instanceof Error
        ? `Landmarker crop detection failed: ${error.message}`
        : 'Landmarker crop detection failed.',
    };
  } finally {
    crop?.bitmap.close();
  }
}

async function detectFullImageLandmarks(
  imageData: ImageData,
  landmarker: FaceLandmarker
): Promise<{ faces: LandmarkedFace[]; error?: string }> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(imageData);
    const result = landmarker.detect(bitmap);
    const faces = (result.faceLandmarks ?? []).map((landmarks, index) => ({
      candidate: faceBoxFromLandmarks(landmarks, imageData.width, imageData.height),
      landmarks,
      blendshapes: result.faceBlendshapes?.[index],
      status: 'OK' as const,
    }));
    return { faces };
  } catch (error) {
    return {
      faces: [],
      error: error instanceof Error ? `Face landmarker fallback failed: ${error.message}` : 'Face landmarker fallback failed.',
    };
  } finally {
    bitmap?.close();
  }
}

function faceBoxFromLandmarks(landmarks: NormalizedLandmark[], width: number, height: number): FaceBox {
  const roi = faceBounds(landmarks, width, height);
  return clampFaceBox({
    ...roi,
    confidence: 1,
    source: 'landmarker',
    detector: 'landmarker',
  }, width, height);
}

function verifiedCandidateFromLandmarks(
  landmarks: NormalizedLandmark[],
  originalCandidate: FaceBox,
  width: number,
  height: number
): FaceBox {
  const roi = faceBounds(landmarks, width, height);
  return clampFaceBox({
    ...roi,
    confidence: originalCandidate.confidence,
    source: originalCandidate.source,
    detector: originalCandidate.detector,
    keypoints: originalCandidate.keypoints,
  }, width, height);
}

function mergeLandmarkedFaces(faces: LandmarkedFace[], width: number, height: number): LandmarkedFace[] {
  const confirmed = faces
    .filter((face): face is LandmarkedFace & { landmarks: NormalizedLandmark[] } => Boolean(face.landmarks))
    .sort((a, b) => b.candidate.confidence - a.candidate.confidence);
  const failed = faces.filter(face => !face.landmarks);
  const merged: LandmarkedFace[] = [];

  confirmed.forEach(face => {
    const duplicateIndex = merged.findIndex(existing => {
      if (!existing.landmarks) return false;
      return facesDescribeSameLandmarks(face.landmarks, existing.landmarks, width, height);
    });

    if (duplicateIndex >= 0) {
      const existing = merged[duplicateIndex];
      if (face.candidate.confidence > existing.candidate.confidence) {
        merged[duplicateIndex] = face;
      }
      return;
    }

    merged.push(face);
  });

  return [...merged, ...failed];
}

function facesDescribeSameLandmarks(
  a: NormalizedLandmark[],
  b: NormalizedLandmark[],
  width: number,
  height: number
) {
  const aBox = faceBounds(a, width, height);
  const bBox = faceBounds(b, width, height);
  const aCenter = { x: aBox.x + aBox.width / 2, y: aBox.y + aBox.height / 2 };
  const bCenter = { x: bBox.x + bBox.width / 2, y: bBox.y + bBox.height / 2 };
  const centerDistance = Math.hypot(aCenter.x - bCenter.x, aCenter.y - bCenter.y);
  const size = Math.max(24, Math.min(aBox.width, aBox.height, bBox.width, bBox.height));
  return centerDistance < size * 0.55 || roiOverlapOverSmaller(aBox, bBox) > 0.58;
}

function roiOverlapOverSmaller(a: Roi, b: Roi) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
  return smallerArea <= 0 ? 0 : intersection / smallerArea;
}

async function cropImageDataToBitmap(imageData: ImageData, region: DetectionRegion) {
  const cropCanvas = new OffscreenCanvas(Math.max(1, Math.round(region.width)), Math.max(1, Math.round(region.height)));
  const cropContext = cropCanvas.getContext('2d');
  if (!cropContext) throw new Error('OffscreenCanvas 2D context is unavailable.');

  const sourceBitmap = await createImageBitmap(imageData);
  try {
    cropContext.drawImage(
      sourceBitmap,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      cropCanvas.width,
      cropCanvas.height
    );
    return await createImageBitmap(cropCanvas);
  } finally {
    sourceBitmap.close();
  }
}

async function cropFaceForLandmarker(imageData: ImageData, roi: Roi): Promise<FaceCrop> {
  const sourceWidth = Math.max(1, Math.round(roi.width));
  const sourceHeight = Math.max(1, Math.round(roi.height));
  const scale = Math.max(1, 512 / Math.max(sourceWidth, sourceHeight));
  const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
  const outputHeight = Math.max(1, Math.round(sourceHeight * scale));
  const cropCanvas = new OffscreenCanvas(outputWidth, outputHeight);
  const cropContext = cropCanvas.getContext('2d');
  if (!cropContext) throw new Error('OffscreenCanvas 2D context is unavailable.');

  const sourceBitmap = await createImageBitmap(imageData);
  try {
    cropContext.drawImage(
      sourceBitmap,
      roi.x,
      roi.y,
      roi.width,
      roi.height,
      0,
      0,
      outputWidth,
      outputHeight
    );
    return {
      bitmap: await createImageBitmap(cropCanvas),
      roi,
      outputWidth,
      outputHeight,
      scaleX: roi.width / outputWidth,
      scaleY: roi.height / outputHeight,
    };
  } finally {
    sourceBitmap.close();
  }
}

function mapLandmarksFromCrop(
  landmarks: NormalizedLandmark[],
  crop: FaceCrop,
  imageWidth: number,
  imageHeight: number
): NormalizedLandmark[] {
  return landmarks.map(point => ({
    x: clamp((crop.roi.x + point.x * crop.outputWidth * crop.scaleX) / Math.max(1, imageWidth)),
    y: clamp((crop.roi.y + point.y * crop.outputHeight * crop.scaleY) / Math.max(1, imageHeight)),
    z: point.z,
    visibility: point.visibility,
  }));
}

function buildSubjectRankInputs(
  faces: LandmarkedFace[],
  diagnostics: AiFaceDiagnostic[],
  luma: Float32Array,
  width: number,
  height: number
): SubjectRankInput[] {
  return diagnostics.map(diagnostic => {
    const face = faces[diagnostic.index];
    const sharpnessScore = face?.landmarks
      ? subjectSharpnessScore(face.landmarks, luma, width, height)
      : 0;
    return {
      index: diagnostic.index,
      x: diagnostic.x,
      y: diagnostic.y,
      width: diagnostic.width,
      height: diagnostic.height,
      faceSizeRatio: diagnostic.faceSizeRatio,
      faceQualityScore: diagnostic.faceQualityScore,
      eyeReliability: diagnostic.eyeReliability,
      poseReliability: diagnostic.poseReliability,
      sharpnessScore,
      landmarkerStatus: diagnostic.landmarkerStatus,
    };
  });
}

function analyzePrimaryFaceFocus(
  face: LandmarkedFace & { landmarks: NormalizedLandmark[] },
  index: number,
  luma: Float32Array,
  width: number,
  height: number,
  faceModelStatus: AiAnalysis['faceModelStatus'],
  settings: AiSettings
): FaceFocusAnalysis {
  const focusRoi = eyeFocusRoi(face.landmarks, width, height);
  const faceRoi = faceBounds(face.landmarks, width, height);
  const focus = focusMetrics(luma, width, height, focusRoi);
  const focusPeaks = collectFaceFocusPeaks(luma, width, height, face.landmarks, focusRoi, focus);
  const focusDecision = decideFocusReliability(faceModelStatus, 1, face.landmarks, width, height, settings);
  return {
    index,
    face,
    focusRoi,
    faceRoi,
    focus,
    focusPeaks,
    focusDecision,
  };
}

function selectFocusAnalysis(items: FaceFocusAnalysis[]) {
  const candidates = items.filter(item => item.focusDecision.focusReliable);
  const pool = candidates.length > 0 ? candidates : items;
  return pool
    .slice()
    .sort((a, b) => focusComposite(a) - focusComposite(b))[0];
}

function focusDecisionWithoutPrimarySubject(
  faceModelStatus: AiAnalysis['faceModelStatus'],
  faceCount: number,
  settings: AiSettings,
  subjectDecision: string
): ReturnType<typeof decideFocusReliability> {
  if (!settings.enabledChecks.OUT_OF_FOCUS) {
    return {
      focusMode: 'NO_FACE_UNRELIABLE',
      focusReliable: false,
      focusSkipReason: '\u5931\u7126\u68c0\u6d4b\u672a\u542f\u7528\u3002',
    };
  }
  if (faceModelStatus === 'UNAVAILABLE') {
    return {
      focusMode: 'NO_FACE_UNRELIABLE',
      focusReliable: false,
      focusSkipReason: '\u4eba\u8138\u6a21\u578b\u4e0d\u53ef\u7528\uff0c\u8df3\u8fc7\u5931\u7126\u5224\u65ad\u4ee5\u907f\u514d\u8bef\u5224\u3002',
    };
  }
  if (faceModelStatus === 'UNUSED') {
    return {
      focusMode: 'NO_FACE_UNRELIABLE',
      focusReliable: false,
      focusSkipReason: '\u672a\u542f\u7528\u4eba\u8138\u6a21\u578b\uff0c\u8df3\u8fc7\u5931\u7126\u5224\u65ad\u3002',
    };
  }
  if (faceCount > 0) {
    return {
      focusMode: 'NO_FACE_UNRELIABLE',
      focusReliable: false,
      focusSkipReason: subjectDecision,
    };
  }
  return {
    focusMode: 'NO_FACE_UNRELIABLE',
    focusReliable: false,
    focusSkipReason: '\u672a\u68c0\u6d4b\u5230\u4eba\u8138\uff0c\u8df3\u8fc7\u4eba\u50cf\u5931\u7126\u5224\u65ad\u3002',
  };
}

function expandedUnionRoi(rois: Roi[], width: number, height: number): Roi {
  if (rois.length === 0) return centerRoi(width, height);
  const left = Math.min(...rois.map(roi => roi.x));
  const top = Math.min(...rois.map(roi => roi.y));
  const right = Math.max(...rois.map(roi => roi.x + roi.width));
  const bottom = Math.max(...rois.map(roi => roi.y + roi.height));
  const union = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
  return clampRoi({
    x: union.x - Math.max(24, union.width * 0.55),
    y: union.y - Math.max(18, union.height * 0.35),
    width: union.width + Math.max(48, union.width * 1.1),
    height: union.height + Math.max(72, union.height * 1.25),
  }, width, height);
}

function faceRegionLabel(face: AiFaceDiagnostic | undefined, index: number, isGroupFace = false) {
  const role = face?.subjectRole ?? 'BACKGROUND';
  const score = typeof face?.subjectScore === 'number' ? ` ${Math.round(face.subjectScore * 100)}%` : '';
  const eyeState = face?.closed ? ' EYE_CLOSED' : face?.reviewHint ? ' EYE_REVIEW' : '';
  const groupState = isGroupFace ? ' GROUP_FACE' : '';
  return `${role} ${index + 1}${score}${eyeState}${groupState}`;
}

function classifyWorkerFaceEyes(
  faces: AiFaceDiagnostic[],
  settings: AiSettings,
  formalFaceIndices: ReadonlySet<number>
) {
  const threshold = thresholdsForIssue(settings, 'EYES_CLOSED').eyeClosedScore;
  return faces.map(face => {
    const isFormalFace = formalFaceIndices.has(face.index);
    const reliableForReview = (face.eyeReliability ?? 0) >= 0.28;
    const closed = isFormalFace && typeof face.eyeClosedScore === 'number' && face.eyeClosedScore >= threshold;
    const reviewHint = isFormalFace
      && !closed
      && typeof face.eyeClosedScore === 'number'
      && face.eyeClosedScore >= threshold * 0.72
      && reliableForReview;
    return {
      ...face,
      closed,
      reviewHint,
      skippedReason: closed
        ? undefined
        : reviewHint
          ? 'Eye metrics are close to the closed-eye threshold; review manually.'
          : typeof face.eyeClosedScore === 'number'
            ? 'Eye metrics are below the closed-eye threshold.'
            : face.skippedReason,
    };
  });
}

function maxEyeClosedScore(faces: AiFaceDiagnostic[]) {
  return faces.reduce((max, face) => (
    typeof face.eyeClosedScore === 'number' ? Math.max(max, face.eyeClosedScore) : max
  ), 0);
}

function buildWorkerEyeSkipReason(
  photoKind: AiPhotoKind,
  groupPortraitReason: string,
  subjectDecision: string,
  formalFaces: AiFaceDiagnostic[],
  closedEyeFaces: AiFaceDiagnostic[],
  reviewEyeFaces: AiFaceDiagnostic[],
  formalFaceIndices: ReadonlySet<number>
) {
  if (formalFaces.length === 0) {
    return photoKind === 'GROUP_PORTRAIT'
      ? groupPortraitReason
      : subjectDecision || 'Subject unclear; only review hints are allowed.';
  }
  if (closedEyeFaces.some(face => formalFaceIndices.has(face.index))) return undefined;
  if (reviewEyeFaces.some(face => formalFaceIndices.has(face.index))) {
    return 'At least one face is close to the closed-eye threshold; review manually.';
  }
  return 'All formal faces are below the closed-eye threshold.';
}

function subjectSharpnessScore(landmarks: NormalizedLandmark[], luma: Float32Array, width: number, height: number) {
  const focusRoi = eyeFocusRoi(landmarks, width, height);
  const face = faceBounds(landmarks, width, height);
  const focus = focusMetrics(luma, width, height, focusRoi);
  const peaks = collectFaceFocusPeaks(luma, width, height, landmarks, focusRoi, focus);
  const faceCenter = focusMetrics(luma, width, height, faceCenterRoi(face, width, height));
  return clamp(Math.max(focus.focusTextureScore, peaks.peakTextureScore, faceCenter.focusTextureScore) / 80);
}

function focusComposite(item: FaceFocusAnalysis) {
  return Math.min(
    item.focus.sharpness,
    item.focus.tenengrad,
    item.focus.focusTextureScore,
    item.focusPeaks.peakTextureScore
  );
}

function faceBoxToRoi(box: FaceBox): Roi {
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  };
}

function getYuNetDetector(modelAssets?: AiModelAssets) {
  const candidates = buildYuNetCandidates(modelAssets);
  const backend = modelAssets?.onnxBackend === 'webgpu' ? 'webgpu' : 'wasm';
  const key = JSON.stringify({ candidates, backend });
  if (!yunetPromise || yunetKey !== key) {
    yunetKey = key;
    yunetPromise = loadYuNetDetector(candidates, backend);
  }
  return yunetPromise;
}

function getAestheticModel(modelAssets?: AiModelAssets) {
  const candidates = buildAestheticCandidates(modelAssets);
  const backend = modelAssets?.onnxBackend === 'webgpu' ? 'webgpu' : 'wasm';
  const key = JSON.stringify({ candidates, backend });
  if (!aestheticPromise || aestheticKey !== key) {
    aestheticKey = key;
    aestheticPromise = loadAestheticModel(candidates, backend);
  }
  return aestheticPromise;
}

async function loadYuNetDetector(candidates: Array<{ modelAssetPath: string; wasmBasePath: string }>, backend: OnnxBackend): Promise<YuNetLoaderResult> {
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const wasmBase = ensureTrailingSlash(candidate.wasmBasePath);
      const ortRuntime = await prepareOrtRuntime(backend, wasmBase);
      const modelBuffer = await fetchBytes(candidate.modelAssetPath, 'face_detection_yunet_2023mar.onnx');
      const session = await ortRuntime.InferenceSession.create(modelBuffer, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      });

      return {
        session,
        modelAssetPath: candidate.modelAssetPath,
        wasmBase,
        backend,
      };
    } catch (error) {
      failures.push(`YuNet candidate backend=${backend} model=${candidate.modelAssetPath} wasm=${candidate.wasmBasePath}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }

  return {
    error: failures.length > 0
      ? formatLoaderFailures(failures)
      : 'YuNet unavailable: no local model or ONNX Runtime wasm candidates were provided.',
  };
}

async function loadAestheticModel(candidates: Array<{ modelAssetPath: string; wasmBasePath: string }>, backend: OnnxBackend): Promise<AestheticLoaderResult> {
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const wasmBase = ensureTrailingSlash(candidate.wasmBasePath);
      const ortRuntime = await prepareOrtRuntime(backend, wasmBase);
      const modelBuffer = await fetchBytes(candidate.modelAssetPath, 'nima_mobilenet.onnx');
      const session = await ortRuntime.InferenceSession.create(modelBuffer, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      });

      return {
        session,
        modelAssetPath: candidate.modelAssetPath,
        wasmBase,
        backend,
      };
    } catch (error) {
      failures.push(`NIMA candidate backend=${backend} model=${candidate.modelAssetPath} wasm=${candidate.wasmBasePath}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }

  return {
    error: failures.length > 0
      ? formatLoaderFailures(failures)
      : 'NIMA unavailable: no local aesthetic model or ONNX Runtime wasm candidates were provided.',
  };
}

async function analyzeAestheticScore(imageData: ImageData, modelAssets?: AiModelAssets): Promise<AiAestheticScore> {
  const loader = await getAestheticModel(modelAssets);
  if (!loader.session) {
    return {
      status: 'UNAVAILABLE',
      modelVersion: 'nima-mobilenet',
      error: loader.error,
    };
  }

  try {
    const inputInfo = getNimaInputInfo(loader.session);
    const input = prepareNimaInput(imageData, inputInfo.layout);
    const inputName = loader.session.inputNames[0] ?? 'input';
    const outputName = loader.session.outputNames[0];
    const outputs = await loader.session.run({ [inputName]: new ort.Tensor('float32', input, inputInfo.dims) });
    const output = outputName ? outputs[outputName] : Object.values(outputs)[0];
    const score = nimaScoreFromOutput(Array.from(output.data as Float32Array | number[]));
    return {
      status: 'READY',
      score,
      modelVersion: 'nima-mobilenet',
    };
  } catch (error) {
    return {
      status: 'ERROR',
      modelVersion: 'nima-mobilenet',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getNimaInputInfo(session: ort.InferenceSession) {
  const metadata = session.inputMetadata?.[0];
  const shape = metadata && 'shape' in metadata && Array.isArray(metadata.shape)
    ? metadata.shape.map((dim: unknown) => typeof dim === 'number' ? dim : 1)
    : [1, 224, 224, 3];
  const dims = shape.length === 4 ? shape : [1, 224, 224, 3];
  const channelIndex = dims.findIndex((dim: number) => dim === 3);
  const layout = channelIndex === 1 ? 'NCHW' : 'NHWC';
  return {
    dims,
    layout,
  } as const;
}

function prepareNimaInput(imageData: ImageData, layout: 'NCHW' | 'NHWC') {
  const inputSize = 224;
  const canvas = new OffscreenCanvas(inputSize, inputSize);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('OffscreenCanvas 2D context is unavailable for NIMA.');
  const scale = Math.max(inputSize / Math.max(1, imageData.width), inputSize / Math.max(1, imageData.height));
  const drawWidth = Math.max(1, Math.round(imageData.width * scale));
  const drawHeight = Math.max(1, Math.round(imageData.height * scale));
  const offsetX = Math.round((inputSize - drawWidth) / 2);
  const offsetY = Math.round((inputSize - drawHeight) / 2);
  const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('OffscreenCanvas source context is unavailable for NIMA.');
  sourceContext.putImageData(imageData, 0, 0);
  context.drawImage(sourceCanvas, 0, 0, imageData.width, imageData.height, offsetX, offsetY, drawWidth, drawHeight);
  const pixels = context.getImageData(0, 0, inputSize, inputSize).data;
  const data = new Float32Array(inputSize * inputSize * 3);
  const planeSize = inputSize * inputSize;

  for (let pixel = 0, src = 0; pixel < planeSize; pixel += 1, src += 4) {
    const r = pixels[src] / 127.5 - 1;
    const g = pixels[src + 1] / 127.5 - 1;
    const b = pixels[src + 2] / 127.5 - 1;
    if (layout === 'NCHW') {
      data[pixel] = r;
      data[planeSize + pixel] = g;
      data[planeSize * 2 + pixel] = b;
    } else {
      const offset = pixel * 3;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
    }
  }

  return data;
}

function nimaScoreFromOutput(values: number[]) {
  if (values.length === 0) return 0;
  const raw = values.length >= 10 ? values.slice(0, 10) : values;
  const probabilitySum = raw.reduce((sum, value) => sum + value, 0);
  const alreadyProbabilities = raw.every(value => value >= 0 && value <= 1) && probabilitySum > 0.98 && probabilitySum < 1.02;
  const distribution = alreadyProbabilities ? raw : softmax(raw);
  const mean = distribution.reduce((sum, probability, index) => sum + probability * (index + 1), 0);
  return Math.round((mean / Math.max(1, distribution.length)) * 100);
}

function softmax(values: number[]) {
  const max = Math.max(...values);
  const exps = values.map(value => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map(value => value / total);
}

async function prepareOrtRuntime(backend: OnnxBackend, wasmBase: string): Promise<typeof ort> {
  if (backend === 'webgpu') {
    if (!ENABLE_EXPERIMENTAL_ONNX_WEBGPU) {
      throw new Error('ONNX WebGPU backend is disabled. Start Vite with VITE_FRAMECULL_ENABLE_WEBGPU=1 for lab benchmarks.');
    }
    throw new Error('ONNX WebGPU backend is reserved for lab benchmarks and is not bundled in release builds yet.');
  }
  const loaderName = 'ort-wasm-simd-threaded';
  await fetchOk(`${wasmBase}${loaderName}.mjs`, `ONNX Runtime ${backend} loader`);
  await fetchOk(`${wasmBase}${loaderName}.wasm`, `ONNX Runtime ${backend} binary`);
  ort.env.wasm.wasmPaths = wasmBase;
  ort.env.wasm.numThreads = 1;
  return ort;
}

function getFaceDetector(modelAssets?: AiModelAssets) {
  const candidates = buildFaceDetectorCandidates(modelAssets);
  const key = JSON.stringify(candidates);
  if (!faceDetectorPromise || faceDetectorKey !== key) {
    faceDetectorKey = key;
    faceDetectorPromise = loadFaceDetector(candidates);
  }
  return faceDetectorPromise;
}

async function loadFaceDetector(candidates: FaceCandidate[]): Promise<FaceDetectorLoaderResult> {
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      resetMediaPipeGlobals();
      const modelBuffer = await fetchBytes(candidate.modelAssetPath, 'blaze_face_short_range.tflite');
      const vision = await createVisionFileset(candidate);
      const detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetBuffer: modelBuffer,
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.25,
        minSuppressionThreshold: 0.3,
      });

      return {
        detector,
        wasmBase: describeWasmCandidate(candidate),
        modelAssetPath: candidate.modelAssetPath,
      };
    } catch (error) {
      resetMediaPipeGlobals();
      failures.push(formatCandidateFailure(candidate, error));
    }
  }

  return {
    error: failures.length > 0
      ? formatLoaderFailures(failures)
      : 'Face detector unavailable: no detector model or wasm candidates were provided.',
  };
}


function getFaceLandmarker(modelAssets?: AiModelAssets) {
  const candidates = buildFaceCandidates(modelAssets);
  const key = JSON.stringify(candidates);
  if (!faceLandmarkerPromise || faceLandmarkerKey !== key) {
    faceLandmarkerKey = key;
    faceLandmarkerPromise = loadFaceLandmarker(candidates);
  }
  return faceLandmarkerPromise;
}

async function loadFaceLandmarker(candidates: FaceCandidate[]): Promise<FaceLoaderResult> {
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      resetMediaPipeGlobals();
      const modelBuffer = await fetchBytes(candidate.modelAssetPath, 'face_landmarker.task');
      const vision = await createVisionFileset(candidate);
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetBuffer: modelBuffer,
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        numFaces: 10,
        outputFaceBlendshapes: true,
      });

      return {
        landmarker,
        wasmBase: describeWasmCandidate(candidate),
        modelAssetPath: candidate.modelAssetPath,
      };
    } catch (error) {
      resetMediaPipeGlobals();
      failures.push(formatCandidateFailure(candidate, error));
    }
  }

  return {
    error: failures.length > 0
      ? formatLoaderFailures(failures)
      : 'Face model unavailable: no model or wasm candidates were provided.',
  };
}

async function createVisionFileset(candidate: WasmCandidate): Promise<VisionWasmFileset> {
  await fetchOk(candidate.wasmLoaderPath, `vision wasm loader (${candidate.wasmMode})`);
  await fetchOk(candidate.wasmBinaryPath, `vision wasm binary (${candidate.wasmMode})`);

  if (candidate.preloadModule) {
    await preloadModuleFactory(candidate.wasmLoaderPath);
    return {
      wasmLoaderPath: '',
      wasmBinaryPath: candidate.wasmBinaryPath,
    };
  }

  return {
    wasmLoaderPath: candidate.wasmLoaderPath,
    wasmBinaryPath: candidate.wasmBinaryPath,
  };
}

function buildFaceDetectorCandidates(modelAssets?: AiModelAssets): FaceCandidate[] {
  const origin = safeOrigin();
  const wasmCandidates = buildWasmCandidates(modelAssets);
  const modelAssetCandidates = unique([
    ...(modelAssets?.faceDetectorAssetCandidates ?? []),
    origin ? `${origin}/models/mediapipe/face_detector/blaze_face_short_range.tflite` : '',
    './models/mediapipe/face_detector/blaze_face_short_range.tflite',
    '/models/mediapipe/face_detector/blaze_face_short_range.tflite',
  ].map(resolvePublicAssetUrl));

  const candidates: FaceCandidate[] = [];
  modelAssetCandidates.forEach(modelAssetPath => {
    wasmCandidates.forEach(wasmCandidate => {
      candidates.push({
        ...wasmCandidate,
        modelAssetPath,
      });
    });
  });

  return candidates;
}

function buildYuNetCandidates(modelAssets?: AiModelAssets) {
  const origin = safeOrigin();
  const modelAssetCandidates = unique([
    ...(modelAssets?.yunetAssetCandidates ?? []),
    origin ? `${origin}/models/opencv/yunet/face_detection_yunet_2023mar.onnx` : '',
    './models/opencv/yunet/face_detection_yunet_2023mar.onnx',
    '/models/opencv/yunet/face_detection_yunet_2023mar.onnx',
  ].map(resolvePublicAssetUrl));
  const wasmBaseCandidates = unique([
    ...(modelAssets?.onnxWasmBaseCandidates ?? []),
    origin ? `${origin}/models/onnxruntime/` : '',
    './models/onnxruntime/',
    '/models/onnxruntime/',
  ].map(resolvePublicAssetUrl));

  const candidates: Array<{ modelAssetPath: string; wasmBasePath: string }> = [];
  modelAssetCandidates.forEach(modelAssetPath => {
    wasmBaseCandidates.forEach(wasmBasePath => {
      candidates.push({ modelAssetPath, wasmBasePath });
    });
  });

  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = `${candidate.modelAssetPath}|${candidate.wasmBasePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildAestheticCandidates(modelAssets?: AiModelAssets) {
  const origin = safeOrigin();
  const modelAssetCandidates = unique([
    ...(modelAssets?.aestheticModelAssetCandidates ?? []),
    origin ? `${origin}/models/aesthetic/nima_mobilenet.onnx` : '',
    './models/aesthetic/nima_mobilenet.onnx',
    '/models/aesthetic/nima_mobilenet.onnx',
  ].map(resolvePublicAssetUrl));
  const wasmBaseCandidates = unique([
    ...(modelAssets?.onnxWasmBaseCandidates ?? []),
    origin ? `${origin}/models/onnxruntime/` : '',
    './models/onnxruntime/',
    '/models/onnxruntime/',
  ].map(resolvePublicAssetUrl));

  const candidates: Array<{ modelAssetPath: string; wasmBasePath: string }> = [];
  modelAssetCandidates.forEach(modelAssetPath => {
    wasmBaseCandidates.forEach(wasmBasePath => {
      candidates.push({ modelAssetPath, wasmBasePath });
    });
  });

  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = `${candidate.modelAssetPath}|${candidate.wasmBasePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFaceCandidates(modelAssets?: AiModelAssets): FaceCandidate[] {
  const origin = safeOrigin();
  const wasmCandidates = buildWasmCandidates(modelAssets);
  const modelAssetCandidates = unique([
    origin ? `${origin}/models/mediapipe/face_landmarker/face_landmarker.task` : '',
    './models/mediapipe/face_landmarker/face_landmarker.task',
    '/models/mediapipe/face_landmarker/face_landmarker.task',
    ...(modelAssets?.modelAssetCandidates ?? []),
  ].map(resolvePublicAssetUrl));
  const candidates: FaceCandidate[] = [];
  modelAssetCandidates.forEach(modelAssetPath => {
    wasmCandidates.forEach(wasmCandidate => {
      candidates.push({
        ...wasmCandidate,
        modelAssetPath,
      });
    });
  });

  return candidates;
}

function buildWasmCandidates(modelAssets?: AiModelAssets) {
  const origin = safeOrigin();
  const wasmBaseCandidates = unique([
    origin ? `${origin}/models/mediapipe/wasm` : '',
    './models/mediapipe/wasm',
    '/models/mediapipe/wasm',
    ...(modelAssets?.wasmBaseCandidates ?? []),
  ].map(resolvePublicAssetUrl));
  const wasmCandidates = uniqueWasmCandidates([
    ...wasmBaseCandidates.map(wasmBase => wasmCandidateFromBase(wasmBase, 'module')),
    ...pairWasmCandidates(
      modelAssets?.wasmModuleLoaderCandidates,
      modelAssets?.wasmModuleBinaryCandidates,
      'module'
    ),
    ...wasmBaseCandidates.map(wasmBase => wasmCandidateFromBase(wasmBase, 'classic')),
    ...pairWasmCandidates(
      modelAssets?.wasmLoaderCandidates,
      modelAssets?.wasmBinaryCandidates,
      'classic'
    ),
    ...wasmBaseCandidates.map(wasmBase => wasmCandidateFromBase(wasmBase, 'nosimd')),
    ...pairWasmCandidates(
      modelAssets?.wasmNoSimdLoaderCandidates,
      modelAssets?.wasmNoSimdBinaryCandidates,
      'nosimd'
    ),
  ]);

  return wasmCandidates;
}

function wasmCandidateFromBase(wasmBase: string, wasmMode: WasmMode): WasmCandidate {
  const base = trimTrailingSlash(resolvePublicAssetUrl(wasmBase));
  const suffix = wasmMode === 'module'
    ? 'wasm_module'
    : wasmMode === 'nosimd'
      ? 'wasm_nosimd'
      : 'wasm';
  return {
    wasmMode,
    wasmLoaderPath: `${base}/vision_${suffix}_internal.js`,
    wasmBinaryPath: `${base}/vision_${suffix}_internal.wasm`,
    preloadModule: wasmMode === 'module',
  };
}

function pairWasmCandidates(
  loaderCandidates: string[] | undefined,
  binaryCandidates: string[] | undefined,
  wasmMode: WasmMode
): WasmCandidate[] {
  const loaders = unique((loaderCandidates ?? []).map(resolvePublicAssetUrl));
  const binaries = unique((binaryCandidates ?? []).map(resolvePublicAssetUrl));
  if (loaders.length === 0 || binaries.length === 0) return [];

  const paired: WasmCandidate[] = [];
  const count = Math.min(loaders.length, binaries.length);
  for (let index = 0; index < count; index += 1) {
    paired.push({
      wasmMode,
      wasmLoaderPath: loaders[index],
      wasmBinaryPath: binaries[index],
      preloadModule: wasmMode === 'module',
    });
  }
  return paired;
}

function uniqueWasmCandidates(candidates: WasmCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = `${candidate.wasmMode}|${candidate.wasmLoaderPath}|${candidate.wasmBinaryPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function preloadModuleFactory(wasmLoaderPath: string) {
  resetMediaPipeGlobals();

  try {
    const workerGlobal = globalThis as MediaPipeWorkerGlobal;
    const loaderModule = await import(/* @vite-ignore */ wasmLoaderPath) as { default?: unknown };
    const moduleFactory = loaderModule.default ?? workerGlobal.ModuleFactory;
    if (typeof moduleFactory !== 'function') {
      throw new Error('vision_wasm_module_internal.js did not export ModuleFactory.');
    }
    workerGlobal.ModuleFactory = moduleFactory;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`vision wasm module import failed at ${wasmLoaderPath}: ${message}`);
  }
}

function resetMediaPipeGlobals() {
  const workerGlobal = globalThis as MediaPipeWorkerGlobal;
  workerGlobal.Module = undefined;
  workerGlobal.ModuleFactory = undefined;
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
    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status} ${response.statusText || ''}`.trim());
    }
    return response;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${label} fetch failed at ${url}: ${error.message}`);
    }
    throw new Error(`${label} fetch failed at ${url}`);
  }
}

function analyzeLandmarkedFacesForEyes(
  faces: LandmarkedFace[],
  width: number,
  height: number,
): AiFaceDiagnostic[] {
  return faces.map((face, index) => {
    const bounds = face.landmarks
      ? faceBounds(face.landmarks, width, height)
      : faceBoxToRoi(face.candidate);
    const normalized = normalizeBox(bounds, width, height);
    const base = {
      index,
      ...normalized,
      detectorConfidence: face.candidate.confidence,
      detectorSource: face.candidate.source,
      detectorName: face.candidate.detector,
      faceSizeRatio: faceSizeRatio(face.candidate, width, height),
      faceQualityScore: faceQualityScore(face.candidate, width, height),
      eyeReliability: face.landmarks ? eyeReliabilityScore(face.landmarks, width, height) : 0,
      poseReliability: face.landmarks ? poseReliabilityScore(face.landmarks, width, height) : 0,
      landmarkerStatus: face.status,
    } satisfies Omit<AiFaceDiagnostic, 'closed'>;

    if (!face.landmarks) {
      return {
        ...base,
        closed: false,
        skippedReason: face.skippedReason ?? 'Face landmarks unavailable; skipped eye detection.',
      };
    }

    const classification = face.blendshapes;
    const leftBlink = classification?.categories.find(category => category.categoryName === 'eyeBlinkLeft')?.score;
    const rightBlink = classification?.categories.find(category => category.categoryName === 'eyeBlinkRight')?.score;

    if (typeof leftBlink === 'number' && typeof rightBlink === 'number') {
      const eyeClosedScore = bilateralBlinkClosedScore(leftBlink, rightBlink, base.poseReliability);
      return {
        ...base,
        leftBlink,
        rightBlink,
        eyeClosedScore,
        closed: false,
        reviewHint: false,
        skippedReason: 'Blink scores recorded; worker thresholding will classify closed or review.',
      };
    }

    const faceArea = normalized.width * normalized.height;
    if (faceArea < 0.004) {
      return {
        ...base,
        closed: false,
        skippedReason: '\u4eba\u8138\u533a\u57df\u8fc7\u5c0f\uff0c\u8df3\u8fc7 EAR \u95ed\u773c\u5224\u65ad\u3002',
      };
    }

    const leftEar = eyeAspectRatio(face.landmarks, [33, 160, 158, 133, 153, 144]);
    const rightEar = eyeAspectRatio(face.landmarks, [362, 385, 387, 263, 373, 380]);
    const eyeClosedScore = bilateralEarClosedScore(leftEar, rightEar, base.poseReliability);

    return {
      ...base,
      leftEar,
      rightEar,
      eyeClosedScore,
      closed: false,
      reviewHint: false,
      skippedReason: 'EAR scores recorded; worker thresholding will classify closed or review.',
    };
  });
}

function selectPrimaryFaceIndex(result: FaceLandmarkerResult | undefined, width: number, height: number) {
  const faces = result?.faceLandmarks ?? [];
  if (faces.length === 0) return -1;

  let bestIndex = 0;
  let bestArea = -1;
  faces.forEach((landmarks, index) => {
    const bounds = faceBounds(landmarks, width, height);
    const area = bounds.width * bounds.height;
    if (area > bestArea) {
      bestIndex = index;
      bestArea = area;
    }
  });

  return bestIndex;
}

function faceFocusSkipReason(landmarks: NormalizedLandmark[], width: number, height: number) {
  const face = faceBounds(landmarks, width, height);
  const faceAreaRatio = (face.width * face.height) / Math.max(1, width * height);
  if (faceAreaRatio < 0.006) {
    return '\u4eba\u8138\u533a\u57df\u8f83\u5c0f\uff0c\u4ec5\u4f5c\u7591\u4f3c\u5931\u7126\u590d\u67e5\u7ebf\u7d22\u3002';
  }

  const eyeSummary = summarizeEyeGeometry(landmarks, width, height, face);
  if (!eyeSummary) {
    return '\u773c\u90e8\u5173\u952e\u70b9\u4e0d\u8db3\uff0c\u4ec5\u4f5c\u7591\u4f3c\u5931\u7126\u590d\u67e5\u7ebf\u7d22\u3002';
  }

  if (eyeSummary.eyeSeparationRatio < 0.18) {
    return '\u4fa7\u8138\u3001\u4f4e\u5934\u6216\u906e\u6321\u8f83\u91cd\uff0c\u4ec5\u4f5c\u7591\u4f3c\u5931\u7126\u590d\u67e5\u7ebf\u7d22\u3002';
  }

  if (eyeSummary.eyeBoxWidthRatio < 0.16 || eyeSummary.eyeBoxHeightRatio < 0.045) {
    return '\u773c\u90e8 ROI \u8f83\u7a84\uff0c\u4ec5\u4f5c\u7591\u4f3c\u5931\u7126\u590d\u67e5\u7ebf\u7d22\u3002';
  }

  if (touchesImageBoundary(face, width, height, 8)) {
    return '\u4eba\u8138\u8d34\u8fd1\u753b\u9762\u8fb9\u7f18\uff0c\u5931\u7126\u5224\u65ad\u4e0d\u53ef\u9760\u3002';
  }

  return undefined;
}

function faceQualityScore(box: FaceBox, width: number, height: number) {
  const size = clamp(faceSizeRatio(box, width, height) / 0.16);
  const confidence = clamp((box.confidence - 0.3) / 0.55);
  const keypoint = box.keypoints ? (faceBoxHasPlausibleKeypoints(box) ? 1 : 0.25) : 0.72;
  return clamp(size * 0.35 + confidence * 0.4 + keypoint * 0.25);
}

function eyeReliabilityScore(landmarks: NormalizedLandmark[], width: number, height: number) {
  const face = faceBounds(landmarks, width, height);
  const summary = summarizeEyeGeometry(landmarks, width, height, face);
  if (!summary) return 0;
  return clamp(
    summary.eyeSeparationRatio / 0.34 * 0.45 +
    summary.eyeBoxWidthRatio / 0.34 * 0.35 +
    summary.eyeBoxHeightRatio / 0.1 * 0.2
  );
}

function poseReliabilityScore(landmarks: NormalizedLandmark[], width: number, height: number) {
  const face = faceBounds(landmarks, width, height);
  const summary = summarizeEyeGeometry(landmarks, width, height, face);
  if (!summary) return 0;
  const boundaryPenalty = touchesImageBoundary(face, width, height, 8) ? 0.72 : 1;
  return clamp(summary.eyeSeparationRatio / 0.42) * boundaryPenalty;
}

function collectFaceFocusPeaks(
  luma: Float32Array,
  width: number,
  height: number,
  landmarks: NormalizedLandmark[],
  focusRoi: Roi,
  focus: FocusMetrics
) {
  const face = faceBounds(landmarks, width, height);
  const eyeDetail = eyeDetailRoi(landmarks, width, height);
  const faceCenter = faceCenterRoi(face, width, height);
  const eyeMetrics = focusMetrics(luma, width, height, eyeDetail);
  const centerMetrics = focusMetrics(luma, width, height, faceCenter);
  const tilePeak = focusTilePeakMetrics(luma, width, height, focusRoi);

  return {
    peakSharpness: Math.max(focus.sharpness, eyeMetrics.sharpness, centerMetrics.sharpness, tilePeak.sharpness),
    peakTenengrad: Math.max(focus.tenengrad, eyeMetrics.tenengrad, centerMetrics.tenengrad, tilePeak.tenengrad),
    peakTextureScore: Math.max(focus.focusTextureScore, eyeMetrics.focusTextureScore, centerMetrics.focusTextureScore, tilePeak.focusTextureScore),
    tileCount: tilePeak.tileCount,
  };
}

function focusTilePeakMetrics(luma: Float32Array, width: number, height: number, roi: Roi) {
  const minTileSize = 48;
  const columns = Math.max(2, Math.min(3, Math.floor(roi.width / minTileSize)));
  const rows = Math.max(2, Math.min(3, Math.floor(roi.height / minTileSize)));
  let peakSharpness = 0;
  let peakTenengrad = 0;
  let peakTextureScore = 0;
  let tileCount = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const tile = clampRoi({
        x: roi.x + (roi.width / columns) * column,
        y: roi.y + (roi.height / rows) * row,
        width: roi.width / columns,
        height: roi.height / rows,
      }, width, height);
      if (tile.width < minTileSize * 0.75 || tile.height < minTileSize * 0.75) continue;

      const metrics = focusMetrics(luma, width, height, tile);
      peakSharpness = Math.max(peakSharpness, metrics.sharpness);
      peakTenengrad = Math.max(peakTenengrad, metrics.tenengrad);
      peakTextureScore = Math.max(peakTextureScore, metrics.focusTextureScore);
      tileCount += 1;
    }
  }

  return {
    sharpness: peakSharpness,
    tenengrad: peakTenengrad,
    focusTextureScore: peakTextureScore,
    tileCount,
  };
}

function summarizeEyeGeometry(landmarks: NormalizedLandmark[], width: number, height: number, face: Roi) {
  const leftEyePoints = [33, 133, 159, 145, 160, 158, 153, 144]
    .map(index => landmarks[index])
    .filter((point): point is NormalizedLandmark => Boolean(point));
  const rightEyePoints = [362, 263, 386, 374, 385, 387, 373, 380]
    .map(index => landmarks[index])
    .filter((point): point is NormalizedLandmark => Boolean(point));

  if (leftEyePoints.length < 4 || rightEyePoints.length < 4) {
    return null;
  }

  const leftCenter = averagePoint(leftEyePoints);
  const rightCenter = averagePoint(rightEyePoints);
  const allPoints = [...leftEyePoints, ...rightEyePoints];
  const eyeBox = boundsFromPoints(allPoints, width, height);

  return {
    eyeSeparationRatio: (distance(leftCenter, rightCenter) * width) / Math.max(face.width, 1),
    eyeBoxWidthRatio: eyeBox.width / Math.max(face.width, 1),
    eyeBoxHeightRatio: eyeBox.height / Math.max(face.height, 1),
  };
}

function averagePoint(points: NormalizedLandmark[]): NormalizedLandmark {
  const totals = points.reduce((acc, point) => ({
    x: acc.x + point.x,
    y: acc.y + point.y,
    z: acc.z + (point.z ?? 0),
    visibility: acc.visibility + (point.visibility ?? 0),
  }), { x: 0, y: 0, z: 0, visibility: 0 });
  return {
    x: totals.x / points.length,
    y: totals.y / points.length,
    z: totals.z / points.length,
    visibility: totals.visibility / points.length,
  };
}

function boundsFromPoints(points: NormalizedLandmark[], width: number, height: number): Roi {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  points.forEach(point => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });
  return clampRoi({
    x: minX * width,
    y: minY * height,
    width: Math.max(8, (maxX - minX) * width),
    height: Math.max(8, (maxY - minY) * height),
  }, width, height);
}

function touchesImageBoundary(roi: Roi, width: number, height: number, thresholdPx: number) {
  return (
    roi.x <= thresholdPx ||
    roi.y <= thresholdPx ||
    roi.x + roi.width >= width - thresholdPx ||
    roi.y + roi.height >= height - thresholdPx
  );
}

function eyeAspectRatio(landmarks: NormalizedLandmark[], indexes: number[]) {
  const [outer, top1, top2, inner, bottom1, bottom2] = indexes.map(index => landmarks[index]);
  if (!outer || !top1 || !top2 || !inner || !bottom1 || !bottom2) return 1;
  const vertical = distance(top1, bottom2) + distance(top2, bottom1);
  const horizontal = Math.max(distance(outer, inner), 0.0001);
  return vertical / (2 * horizontal);
}

function faceBounds(landmarks: NormalizedLandmark[], width: number, height: number): Roi {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  landmarks.forEach(point => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });

  const x = minX * width;
  const y = minY * height;
  const boxWidth = Math.max(32, (maxX - minX) * width);
  const boxHeight = Math.max(32, (maxY - minY) * height);
  const padX = boxWidth * 0.14;
  const padY = boxHeight * 0.14;

  return clampRoi({
    x: Math.max(0, x - padX),
    y: Math.max(0, y - padY),
    width: Math.min(width, boxWidth + padX * 2),
    height: Math.min(height, boxHeight + padY * 2),
  }, width, height);
}

function eyeFocusRoi(landmarks: NormalizedLandmark[], width: number, height: number): Roi {
  const eyeIndexes = [
    33, 133, 159, 145, 160, 158, 153, 144,
    362, 263, 386, 374, 385, 387, 373, 380,
    70, 105, 336, 300,
  ];
  const points = eyeIndexes
    .map(index => landmarks[index])
    .filter((point): point is NormalizedLandmark => Boolean(point));
  const face = faceBounds(landmarks, width, height);

  if (points.length < 8) {
    return clampRoi({
      x: face.x + face.width * 0.08,
      y: face.y + face.height * 0.12,
      width: face.width * 0.84,
      height: face.height * 0.4,
    }, width, height);
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  points.forEach(point => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });

  const x = minX * width;
  const y = minY * height;
  const boxWidth = Math.max(32, (maxX - minX) * width);
  const boxHeight = Math.max(24, (maxY - minY) * height);
  const padX = Math.max(boxWidth * 0.9, face.width * 0.12);
  const padY = Math.max(boxHeight * 1.35, face.height * 0.08);

  return clampRoi({
    x: x - padX,
    y: y - padY,
    width: boxWidth + padX * 2,
    height: boxHeight + padY * 2,
  }, width, height);
}

function eyeDetailRoi(landmarks: NormalizedLandmark[], width: number, height: number): Roi {
  const eyeIndexes = [
    33, 133, 159, 145, 160, 158, 153, 144,
    362, 263, 386, 374, 385, 387, 373, 380,
  ];
  const points = eyeIndexes
    .map(index => landmarks[index])
    .filter((point): point is NormalizedLandmark => Boolean(point));
  const face = faceBounds(landmarks, width, height);

  if (points.length < 8) {
    return clampRoi({
      x: face.x + face.width * 0.18,
      y: face.y + face.height * 0.16,
      width: face.width * 0.64,
      height: face.height * 0.22,
    }, width, height);
  }

  const eyeBox = boundsFromPoints(points, width, height);
  const padX = Math.max(eyeBox.width * 0.25, face.width * 0.06);
  const padY = Math.max(eyeBox.height * 0.45, face.height * 0.05);

  return clampRoi({
    x: eyeBox.x - padX,
    y: eyeBox.y - padY,
    width: eyeBox.width + padX * 2,
    height: eyeBox.height + padY * 2,
  }, width, height);
}

function faceCenterRoi(face: Roi, width: number, height: number): Roi {
  return clampRoi({
    x: face.x + face.width * 0.16,
    y: face.y + face.height * 0.16,
    width: face.width * 0.68,
    height: face.height * 0.56,
  }, width, height);
}

function centerRoi(width: number, height: number): Roi {
  const roiWidth = width * 0.64;
  const roiHeight = height * 0.64;
  return clampRoi({
    x: (width - roiWidth) / 2,
    y: (height - roiHeight) / 2,
    width: roiWidth,
    height: roiHeight,
  }, width, height);
}

type Roi = { x: number; y: number; width: number; height: number };
type RoiSource = 'face' | 'center' | 'detector';

function clampRoi(roi: Roi, imageWidth: number, imageHeight: number): Roi {
  const x = Math.max(0, Math.min(imageWidth - 1, roi.x));
  const y = Math.max(0, Math.min(imageHeight - 1, roi.y));
  const width = Math.max(1, Math.min(imageWidth - x, roi.width));
  const height = Math.max(1, Math.min(imageHeight - y, roi.height));
  return { x, y, width, height };
}

function normalizeRegion(
  roi: Roi,
  imageWidth: number,
  imageHeight: number,
  source: RoiSource,
  label?: string
): AiRegion {
  return {
    x: clamp(roi.x / Math.max(1, imageWidth)),
    y: clamp(roi.y / Math.max(1, imageHeight)),
    width: clamp(roi.width / Math.max(1, imageWidth)),
    height: clamp(roi.height / Math.max(1, imageHeight)),
    source,
    label: label ?? (source === 'face' ? 'Primary face ROI' : 'Center-weighted ROI'),
  };
}

function normalizeBox(roi: Roi, imageWidth: number, imageHeight: number) {
  return {
    x: clamp(roi.x / Math.max(1, imageWidth)),
    y: clamp(roi.y / Math.max(1, imageHeight)),
    width: clamp(roi.width / Math.max(1, imageWidth)),
    height: clamp(roi.height / Math.max(1, imageHeight)),
  };
}

function distance(a: NormalizedLandmark, b: NormalizedLandmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function formatCandidateFailure(candidate: FaceCandidate, error: unknown) {
  const wasm = describeWasmCandidate(candidate);
  const message = error instanceof Error ? error.message : String(error);
  return `model=${candidate.modelAssetPath}; wasm=${wasm}; ${message}`;
}

function describeWasmCandidate(candidate: WasmCandidate) {
  return `mode=${candidate.wasmMode}; loader=${candidate.wasmLoaderPath}; binary=${candidate.wasmBinaryPath}`;
}

function formatLoaderFailures(failures: string[]) {
  const limit = 8;
  const visible = failures.slice(0, limit);
  const remaining = failures.length - visible.length;
  return remaining > 0
    ? `${visible.join('\n')}\n... ${remaining} more MediaPipe loader candidates failed.`
    : visible.join('\n');
}

function firstLine(value: string) {
  return value.split(/\r?\n/)[0] || value;
}

function resolvePublicAssetUrl(value: string) {
  if (!value) return value;
  if (/^(blob:|data:|https?:|file:|asset:|tauri:)/i.test(value)) {
    return value;
  }

  const origin = safeOrigin();
  const publicPath = value.startsWith('./') ? value.slice(1) : value;
  if (origin && publicPath.startsWith('/')) {
    return `${origin}${publicPath}`;
  }

  try {
    return new URL(publicPath, origin ? `${origin}/` : self.location.href).toString();
  } catch {
    return value;
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

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function percentileFromHistogram(histogram: Uint32Array, count: number, percentile: number) {
  const target = Math.max(1, Math.ceil(count * percentile));
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index];
    if (cumulative >= target) return index;
  }
  return 255;
}

function clamp100(value: number) {
  return Math.max(0, Math.min(100, value));
}
