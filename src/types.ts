
export enum SelectionState {
  UNMARKED = 'UNMARKED',
  PICKED = 'PICKED',
  REJECTED = 'REJECTED'
}

export enum GroupStatus {
  COMPLETE = 'COMPLETE',
  JPG_ONLY = 'JPG_ONLY',
  RAW_ONLY = 'RAW_ONLY'
}

export interface ExifData {
  shutterSpeed?: string;
  aperture?: string;
  iso?: string;
  focalLength?: string;
  dateTime?: string;
  model?: string;
  lens?: string;
  orientation?: number;
}

export type PhotoRating = 0 | 1 | 2 | 3 | 4 | 5;

export interface PhotoFile {
  name: string;
  extension: string;
  file: File;
  previewUrl: string;
  size: number;
  modifiedMs?: number;
  path?: string; // File path for Tauri backend
}

export interface PhotoGroup {
  id: string; // Base filename
  jpg?: PhotoFile;
  raw?: PhotoFile;
  status: GroupStatus;
  selection: SelectionState;
  rating: PhotoRating;
  exif?: ExifData;
  ai?: AiAnalysis;
}

export type AiIssueCode = 'OUT_OF_FOCUS' | 'UNDER_EXPOSED' | 'OVER_EXPOSED' | 'EYES_CLOSED';
export type AiAnalysisStatus = 'PENDING' | 'ANALYZING' | 'DONE' | 'ERROR' | 'SKIPPED';
export type AiSensitivity = 'weak' | 'standard' | 'strong';
export type DuplicateSensitivity = 'off' | 'loose' | 'standard' | 'strict';
export type AiFaceModelStatus = 'UNUSED' | 'READY' | 'UNAVAILABLE';
export type AiFocusMode = 'FACE_ROI' | 'NO_FACE_TEXTURED' | 'NO_FACE_UNRELIABLE';
export type AiIssueLevel = 'ISSUE' | 'REVIEW_HINT';
export type AiSubjectRole = 'PRIMARY' | 'SECONDARY' | 'BACKGROUND' | 'OCCLUDER';
export type AiSubjectConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
export type AiPhotoKind = 'STANDARD' | 'GROUP_PORTRAIT';

export interface AiIssue {
  code: AiIssueCode;
  level: AiIssueLevel;
  confidence: number;
  score: number;
  threshold: number;
  message: string;
}

export interface AiMetrics {
  sharpness?: number;
  meanLuma?: number;
  subjectMeanLuma?: number;
  subjectReliable?: boolean;
  darkClipRatio?: number;
  highlightClipRatio?: number;
  subjectDarkClipRatio?: number;
  subjectHighlightClipRatio?: number;
  shadowRatio?: number;
  highlightRatio?: number;
  midtoneMeanLuma?: number;
  p10Luma?: number;
  p50Luma?: number;
  p90Luma?: number;
  faceCount?: number;
  eyeClosedScore?: number;
  tenengrad?: number;
  edgeDensity?: number;
  focusTextureScore?: number;
  focusPeakSharpness?: number;
  focusPeakTenengrad?: number;
  focusPeakTextureScore?: number;
  focusTileCount?: number;
  focusReliable?: boolean;
  focusReliabilityScore?: number;
  focusMode?: AiFocusMode;
  eyeClosedFaceCount?: number;
  eyeReviewFaceCount?: number;
  eyeReviewScore?: number;
  faceCandidateCount?: number;
  landmarkedFaceCount?: number;
  enhancedFaceDetectionPasses?: number;
  faceQualityScore?: number;
  eyeReliability?: number;
  poseReliability?: number;
  subjectExposureScore?: number;
  primarySubjectCount?: number;
  subjectConfidenceScore?: number;
  subjectConfidence?: AiSubjectConfidence;
  groupFaceCount?: number;
  groupEyeClosedFaceCount?: number;
  groupEyeReviewFaceCount?: number;
  groupPortraitScore?: number;
}

export type AiPhotoScoreGrade = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'REVIEW';

export type AiPhotoScoreComponentKey =
  | 'TECHNICAL_QUALITY'
  | 'AESTHETIC_QUALITY'
  | 'SCENE_FIT'
  | 'EXPOSURE_LATITUDE'
  | 'AI_RISK';

export interface AiAestheticScore {
  status: 'READY' | 'UNAVAILABLE' | 'ERROR';
  score?: number;
  modelVersion?: string;
  error?: string;
}

export interface AiPhotoScoreGates {
  aiPickedEligible: boolean;
  technicalPass: boolean;
  duplicateBestPass: boolean;
  reasons: string[];
}

export interface AiPhotoScoreComponent {
  key: AiPhotoScoreComponentKey;
  label: string;
  score: number;
  weight: number;
  detail?: string;
}

export interface AiPhotoScore {
  version: string;
  overall: number;
  grade: AiPhotoScoreGrade;
  components: AiPhotoScoreComponent[];
  summary: string;
  aesthetic?: AiAestheticScore;
  gates?: AiPhotoScoreGates;
}

export interface AiRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  source: 'face' | 'center' | 'detector';
  label: string;
}

export interface AiFaceDiagnostic {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  leftBlink?: number;
  rightBlink?: number;
  leftEar?: number;
  rightEar?: number;
  eyeClosedScore?: number;
  detectorConfidence?: number;
  detectorSource?: string;
  detectorName?: string;
  faceSizeRatio?: number;
  faceQualityScore?: number;
  eyeReliability?: number;
  poseReliability?: number;
  subjectRole?: AiSubjectRole;
  subjectScore?: number;
  subjectRank?: number;
  lookAtCameraScore?: number;
  centerScore?: number;
  sizeScore?: number;
  sharpnessScore?: number;
  cropSafetyScore?: number;
  eligibleAsPrimary?: boolean;
  subjectReason?: string;
  landmarkerStatus?: 'OK' | 'FAILED' | 'SKIPPED';
  closed: boolean;
  reviewHint?: boolean;
  skippedReason?: string;
}

export interface AiDiagnostics {
  focusMode?: AiFocusMode;
  focusReliable?: boolean;
  focusSkipReason?: string;
  eyeSkipReason?: string;
  modelLoadError?: string;
  wasmBase?: string;
  modelAssetPath?: string;
  faceDetectorStatus?: AiFaceModelStatus;
  faceDetectorAssetPath?: string;
  faceDetectorError?: string;
  faceDetectorName?: string;
  landmarkerSuccessCount?: number;
  faceDiagnostics?: AiFaceDiagnostic[];
  primaryFaceIndices?: number[];
  primarySubjectCount?: number;
  subjectConfidence?: AiSubjectConfidence;
  subjectDecision?: string;
  photoKind?: AiPhotoKind;
  groupFaceIndices?: number[];
  groupPortraitReason?: string;
}

export interface AiDuplicateSignature {
  version: string;
  width: number;
  height: number;
  aspectRatio: number;
  lumaHash: string;
  structureHash: string;
  colorHistogram: number[];
  lumaHistogram: number[];
  meanLuma: number;
}

export interface AiAnalysis {
  status: AiAnalysisStatus;
  issues: AiIssue[];
  confidence: number;
  preset: AiSensitivity;
  reviewed: boolean;
  modelVersion: string;
  analyzedAt?: number;
  error?: string;
  faceModelStatus?: AiFaceModelStatus;
  metrics?: AiMetrics;
  regions?: AiRegion[];
  diagnostics?: AiDiagnostics;
  duplicateSignature?: AiDuplicateSignature;
  photoScore?: AiPhotoScore;
  proScores?: {
    manifestPath?: string;
    activeEp?: string;
    elapsedMs?: number;
    aesthetic?: number; // 0..1 native Pro head output
    sceneLabel?: string;
    sceneConfidence?: number;
    personaScore?: number; // 0..1 native Pro head output
    semanticKeepScore?: number;
    faceValidityScore?: number;
    compositionScore?: number;
    momentScore?: number;
    lightingMoodScore?: number;
    falseFaceRisk?: number;
  };
}

export interface AiSettings {
  enabledChecks: Record<AiIssueCode, boolean>;
  sensitivity: AiSensitivity;
  sensitivityByCheck: Record<AiIssueCode, AiSensitivity>;
  duplicateSensitivity: DuplicateSensitivity;
  duplicateAlwaysRecommendOne: boolean;
  aiPickTargetRatio: number;
  proPersonaRanking: {
    enabled: boolean;
  };
  flashPersonaRanking?: {
    enabled: boolean;
    useWasmModel?: boolean; // 当ONNX模型可用时启用
  };
}

export interface AiProgress {
  total: number;
  processed: number;
  activeId?: string;
  running: boolean;
  paused: boolean;
  phase?: 'AI_ENGINE_INIT' | 'AI_ANALYSIS' | 'PRO_MODEL_SCORING' | 'DUPLICATE_GROUPING';
  startedAt?: number;
  elapsedMs?: number;
  pausedTotalMs?: number;
}

export type DuplicateReviewStatus = 'IDLE' | 'ANALYZING' | 'READY' | 'DISABLED';

export interface DuplicatePhotoMatch {
  photoId: string;
  similarity: number;
  qualityScore: number;
  isBest: boolean;
  reason?: string;
}

export interface DuplicateGroup {
  id: string;
  photoIds: string[];
  bestPhotoId?: string;
  similarity: number;
  sensitivity: Exclude<DuplicateSensitivity, 'off'>;
  createdAt: number;
  matches: DuplicatePhotoMatch[];
}

export interface AiModelAssets {
  wasmBaseCandidates: string[];
  wasmModuleLoaderCandidates?: string[];
  wasmModuleBinaryCandidates?: string[];
  wasmLoaderCandidates?: string[];
  wasmBinaryCandidates?: string[];
  wasmNoSimdLoaderCandidates?: string[];
  wasmNoSimdBinaryCandidates?: string[];
  modelAssetCandidates: string[];
  faceDetectorAssetCandidates?: string[];
  yunetAssetCandidates?: string[];
  aestheticModelAssetCandidates?: string[];
  onnxWasmBaseCandidates?: string[];
  onnxBackend?: 'wasm' | 'webgpu';
}

// Pro native ONNX Runtime inference layer (PRO_MODEL_ARCHITECTURE.md §10.5).
// These shapes map one-to-one to the Rust serde structs in
// `src-tauri/src/pro_infer/types.rs`. Field names must stay in lockstep with
// the camelCase serde rename there. Flash builds never invoke these commands.
export interface ProInferCapabilities {
  activeEp: 'cuda' | 'directml' | 'coreml' | 'cpu';
  epFallbackChain: string[];
  backboneVersion: string;
  loadedHeads: string[];
  inputResolution: number; // must === 384
  warmupMs: number;
}

export interface ProBatchRequest {
  imagePaths: string[];
  batchSize?: number;
  heads?: string[];
}

export interface ProHeadScores {
  imagePath: string;
  aesthetic?: number; // 0..1, feeds calibratedAestheticModelScore
  sceneLabel?: string;
  sceneConfidence?: number;
  personaScore?: number;
  semanticKeepScore?: number;
  faceValidityScore?: number;
  compositionScore?: number;
  momentScore?: number;
  lightingMoodScore?: number;
  falseFaceRisk?: number;
  error?: string;
}

export interface ProBatchResponse {
  results: ProHeadScores[];
  ep: string;
  elapsedMs: number;
}

export type ImportProgressPhase = 'idle' | 'scan' | 'pair' | 'metadata' | 'preload' | 'done' | 'error';

export interface RawPreviewInfo {
  cachePath: string;
  byteLength: number;
  offset: number;
  orientation?: number;
  fromCache: boolean;
  source: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface AutoExposurePreviewAdjustment {
  ev: number;
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  elapsedMs?: number;
  stats: {
    sampleWidth: number;
    sampleHeight: number;
    samplePixels: number;
    p10Luma: number;
    p50Luma: number;
    p90Luma: number;
    p98Luma: number;
    meanLuma: number;
    shadowRatio: number;
    highlightRatio: number;
    clippedHighlightRatio: number;
  };
}

export interface ImportStreamEvent {
  kind: 'started' | 'progress' | 'groups' | 'metadata' | 'done' | 'error';
  phase?: ImportProgressPhase | 'final';
  processed?: number;
  total?: number;
  current?: string;
  groups?: unknown[];
  error?: string;
}

export interface ImportProgress {
  phase: ImportProgressPhase;
  total: number;
  processed: number;
  current?: string;
  running: boolean;
}

export interface RawDecodeProgress {
  total: number;
  processed: number;
  queued: number;
  active: number;
  current?: string;
  running: boolean;
}

export type RawEngineKind = 'RAWTHERAPEE';
export type RawEngineStatus = 'idle' | 'detected' | 'manual' | 'valid' | 'invalid' | 'missing' | 'error';
export type RawEngineSource = 'BUNDLED' | 'MANUAL' | 'SYSTEM';
export type RawMonitorProfileId = 'FrameCull_Monitor_Balanced_v1' | 'FrameCull_Monitor_AutoExposure_v1';

export interface RawMonitorProfileReadyState {
  signature: string;
  total: number;
  completedAt: number;
}

export interface RawEngineSettings {
  engineKind: RawEngineKind;
  enginePath: string;
  status: RawEngineStatus;
  engineSource?: RawEngineSource;
  lastDetectedAt?: number;
  version?: string;
  bundledEngineVersion?: string;
  message?: string;
}

export interface RawEngineValidationResult {
  ok: boolean;
  engineKind: RawEngineKind;
  enginePath?: string;
  version?: string;
  engineSource?: RawEngineSource;
  bundledEngineVersion?: string;
  message?: string;
}

export interface RawMonitorSettings {
  settingsVersion: number;
  enabled: boolean;
  autoExposureEnabled: boolean;
  engineKind: RawEngineKind;
  enginePath: string;
  engineVersion?: string;
  engineSource?: RawEngineSource;
  bundledEngineVersion?: string;
  profileId: RawMonitorProfileId;
  lutEnabled: boolean;
  lutPath?: string;
  lutName?: string;
  lutStrength: number;
  cacheVersion: number;
  cacheReadyProfiles?: Partial<Record<RawMonitorProfileId, RawMonitorProfileReadyState>>;
}

export interface RawMonitorCacheEntry {
  rawPath: string;
  profileId?: RawMonitorProfileId;
  cachePath?: string;
  fromCache: boolean;
  fallback?: boolean;
  cacheSource?: 'rawtherapee' | 'embeddedFallback';
  fallbackReason?: RawMonitorFallbackReason;
  recentFailure?: boolean;
  missingReason?: string;
}

export interface RawMonitorCacheEvent {
  kind: 'started' | 'progress' | 'cached' | 'skipped' | 'error' | 'cancelled' | 'done';
  processed?: number;
  total?: number;
  current?: string;
  rawPath?: string;
  profileId?: RawMonitorProfileId;
  cachePath?: string;
  fallback?: boolean;
  cacheSource?: 'rawtherapee' | 'embeddedFallback';
  fallbackReason?: RawMonitorFallbackReason;
  skippedReason?: string;
  engineVersion?: string;
  errors?: string[];
  error?: string;
}

export type RawMonitorFallbackReason = 'decodeFailure' | 'engineError' | 'missingOutput' | 'invalidOutput';

export type RawMonitorCachePhase = 'idle' | 'checking' | 'rendering' | 'done' | 'error' | 'cancelled';

export interface RawMonitorCacheProgress {
  phase: RawMonitorCachePhase;
  total: number;
  processed: number;
  current?: string;
  profileId?: RawMonitorProfileId;
  running: boolean;
  errors?: string[];
}

export interface CubeLut3D {
  title?: string;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  data: Float32Array;
}

export type PhotoFilter =
  | 'ALL'
  | 'PICKED'
  | 'REJECTED'
  | 'UNMARKED'
  | 'ORPHANS'
  | 'AI_REVIEW'
  | 'AI_NORMAL'
  | 'AI_PICKED'
  | 'GROUP_PHOTO'
  | 'DUPLICATES';
export type PhotoRatingFilter =
  | 'RATING_ALL'
  | 'RATING_NONE'
  | 'RATING_1_PLUS'
  | 'RATING_2_PLUS'
  | 'RATING_3_PLUS'
  | 'RATING_4_PLUS'
  | 'RATING_5';
export type ExportMode = 'RAW' | 'JPG' | 'BOTH' | 'RENDER_JPG' | 'RENDER_TIFF' | 'RENDER_PNG';
export type ExportOperation = 'COPY' | 'MOVE';
export type ExportIntent = 'RENDER_COPY' | 'MOVE_ORIGINALS' | 'LIGHTROOM_IMPORT';
export type ExportColorSpace = 'SRGB' | 'ADOBE_RGB';
export type ExportMetadataMode = 'NONE' | 'RATING_ONLY' | 'CAPTURE_INFO_AND_RATING' | 'ALL';
export type ExportTarget = 'FOLDER' | 'LIGHTROOM_CLASSIC';
export type LightroomHandoffMode = 'SOURCE_FOLDER';

export interface ExportOptions {
  intent: ExportIntent;
  mode: ExportMode;
  operation: ExportOperation;
  destinationFolder: string;
  exportTarget?: ExportTarget;
  lightroomMode?: LightroomHandoffMode;
  launchLightroom?: boolean;
  lightroomExecutablePath?: string;
  jpegQuality?: number;
  colorSpace?: ExportColorSpace;
  metadataMode?: ExportMetadataMode;
  renameEnabled?: boolean;
  renameBaseName?: string;
  includeRawSidecars?: boolean;
}

export type ExportProgressPhase =
  | 'idle'
  | 'preparing'
  | 'rendering'
  | 'copying'
  | 'moving'
  | 'writing'
  | 'done'
  | 'error';

export interface ExportProgress {
  phase: ExportProgressPhase;
  total: number;
  processed: number;
  current?: string;
  destinationFolder?: string;
  exportTarget?: ExportTarget;
  lightroomMode?: LightroomHandoffMode;
  lightroomLaunchStatus?: 'NOT_REQUESTED' | 'LAUNCHED' | 'NOT_FOUND' | 'ERROR';
  lightroomExecutablePath?: string;
  lightroomMessage?: string;
  running: boolean;
  files?: string[];
  error?: string;
}

export interface ExportStreamEvent {
  kind: 'progress' | 'done' | 'error';
  phase?: Extract<ExportProgressPhase, 'copying' | 'moving' | 'writing'>;
  processed?: number;
  total?: number;
  current?: string;
  files?: string[];
  error?: string;
}

export interface LightroomImportResult {
  files: string[];
  launched: boolean;
  executablePath?: string;
  warnings?: string[];
}

export interface LightroomSourceFolderResult {
  sourceFolder: string;
  files: string[];
  launched: boolean;
  executablePath?: string;
  warnings?: string[];
}

export type PeopleSplitStatus = 'IDLE' | 'RUNNING' | 'DONE' | 'ERROR' | 'STOPPED';
export type PersonClusterStatus = 'AUTO' | 'RENAMED' | 'MERGED' | 'SPLIT';

export interface PeopleFaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PersonFaceEmbedding {
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
  visualQuality?: number;
  structureQuality?: number;
  hasFaceKeypoints?: boolean;
  landmarkerStatus?: AiFaceDiagnostic['landmarkerStatus'];
  landmarkerOverlap?: number;
  reason?: string;
  thumbnail?: string;
}

export interface PersonCluster {
  id: string;
  displayName: string;
  coverPhotoId: string;
  coverFaceKey?: string;
  memberFaceKeys: string[];
  photoIds: string[];
  faceCount: number;
  photoCount: number;
  status: PersonClusterStatus;
}

export interface PeopleSplitProgress {
  totalPhotos: number;
  processedPhotos: number;
  currentPhotoId?: string;
  currentFile?: string;
  currentStage?: string;
}

export interface PeopleSplitState {
  status: PeopleSplitStatus;
  processedPhotos: number;
  totalPhotos: number;
  currentPhotoId?: string;
  currentFile?: string;
  currentStage?: string;
  clusters: PersonCluster[];
  faces: PersonFaceEmbedding[];
  unassignedFaces: PersonFaceEmbedding[];
  selectedClusterIds: string[];
  startedAt?: number;
  elapsedMs?: number;
  lastRunAt?: number;
  modelVersion: string;
  error?: string;
}

export interface PeopleExportClusterInput {
  id: string;
  displayName: string;
  photoPaths: string[];
}
