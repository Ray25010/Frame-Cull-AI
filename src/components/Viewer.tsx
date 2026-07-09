import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Aperture,
  CalendarClock,
  Camera,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  EyeOff,
  Flag,
  Focus,
  Gauge,
  HardDrive,
  MonitorCog,
  RotateCcw,
  RotateCw,
  ScanSearch,
  SunMedium,
  Timer,
  Trash2,
  UsersRound,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AiAnalysis, AiFaceDiagnostic, AiIssueCode, AiMetrics, AiRegion, type AiAestheticScore, type AiPhotoScoreComponentKey, type AiSubjectConfidence, type AiSubjectRole, type CubeLut3D, type RawMonitorCacheProgress, type RawMonitorProfileId, GroupStatus, PhotoGroup, PhotoRating, SelectionState } from '../types';
import { formatSize } from '../utils/fileHelpers';
import { decodeRawFile, getImageFromCache, getThumbnailFromCache } from '../utils/rawLoader';
import { getTranslations, Language } from '../i18n';
import { useShortcuts } from '../contexts/ShortcutsContext';
import { aiIssueIcon, aiIssueLabel, aiSensitivityLabel, formatConfidence } from '../utils/aiLabels';
import { AppIcon } from './ui/AppIcon';
import { chromeSolid, glassPopover, photoOverlay } from './ui/chrome';
import { useRawMonitorViewerFrame } from '@edition/useRawMonitorViewerFrame';
import { useMonitorLut } from '@edition/useMonitorLut';
import {
  buildAutoExposureCssFilter,
  computeAutoExposurePreviewFromImage,
  type AutoExposurePreviewAdjustment,
} from '../utils/autoExposurePreview';

interface ViewerProps {
  group: PhotoGroup;
  animationClass: string;
  onUpdateSelection?: (state: SelectionState) => void;
  onAiReview?: (state: SelectionState) => void;
  onUpdateRating?: (rating: PhotoRating) => void;
  theme: 'light' | 'dark';
  language?: Language;
  aiViewMode: ViewerAiMode;
  onAiViewModeChange: (mode: ViewerAiMode) => void;
  isAiReviewMode?: boolean;
  rawMonitorPreview?: {
    enabled: boolean;
    autoExposureEnabled?: boolean;
    rawCacheReady?: boolean;
    autoExposureCacheReady?: boolean;
    profileId?: RawMonitorProfileId;
    engineVersion?: string;
    cacheVersion: number;
    progress?: RawMonitorCacheProgress;
    lutEnabled?: boolean;
    lutPath?: string;
    lutName?: string;
    lutStrength?: number;
    autoExposureAdjustment?: AutoExposurePreviewAdjustment | null;
    onEnabledChange?: (enabled: boolean) => void;
    onAutoExposureChange?: (enabled: boolean) => void;
    onLutEnabledChange?: (enabled: boolean) => void;
    onChooseLut?: () => void | Promise<void>;
    onRemoveLut?: () => void;
    onLutStrengthChange?: (strength: number) => void;
    onGenerateCache?: () => void | Promise<void>;
    onCancelCache?: () => void | Promise<void>;
    labels?: {
      title: string;
      raw: string;
      auto: string;
      lut: string;
      chooseLut: string;
      changeLut: string;
      removeLut: string;
      strength: string;
      checking: string;
      missing: string;
      cacheBalanced: string;
      cacheAuto: string;
      close: string;
      autoApplied?: string;
      autoPreparing?: string;
      generateCache?: string;
      stopCache?: string;
      cacheActionHint?: string;
      cacheNotReady?: string;
      autoCacheNotReady?: string;
      cacheReady?: string;
    };
  };
}

export type ViewerAiMode = 'ORIGINAL' | 'AI';

type DisplayFrame = {
  groupId: string;
  url: string;
  alt: string;
  ai?: AiAnalysis;
};

const previewImageClassName = 'max-w-full max-h-[calc(100vh-6.5rem)] w-auto h-auto object-contain shadow-[0_0_72px_rgba(0,0,0,0.46)] rounded-sm select-none transition-opacity duration-200';
const RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID: RawMonitorProfileId = 'FrameCull_Monitor_AutoExposure_v1';

const copy = {
  zh: {
    aiReview: '\u603b\u89c8',
    metadata: '\u5224\u636e',
    aiClear: '\u672a\u53d1\u73b0\u786c\u4f24',
    aiAnalyzing: 'AI\u5206\u6790\u4e2d',
    aiWaiting: '\u5c1a\u672a\u5206\u6790',
    reviewed: '\u5df2\u590d\u67e5',
    keep: '\u4fdd\u7559',
    reject: '\u5f03\u7528',
    undecided: '\u6682\u4e0d\u5224\u65ad',
    issues: '\u590d\u67e5\u7ebf\u7d22',
    metrics: '\u5173\u952e\u6307\u6807',
    model: '\u6a21\u578b',
    preset: '\u654f\u611f\u5ea6',
    confidence: '\u7f6e\u4fe1\u5ea6',
    faceCount: '\u4eba\u8138',
    faceCandidates: '\u4eba\u8138\u5019\u9009',
    landmarkedFaces: '\u5173\u952e\u70b9\u6210\u529f',
    enhancedPasses: '\u5c0f\u8138\u589e\u5f3a',
    sharpness: '\u6e05\u6670\u5ea6',
    meanLuma: '\u5e73\u5747\u4eae\u5ea6',
    subjectLuma: '\u4e3b\u4f53\u4eae\u5ea6',
    darkClip: '\u6697\u90e8\u7ec6\u8282\u4e22\u5931',
    highlightClip: '\u4eae\u90e8\u7ec6\u8282\u4e22\u5931',
    subjectDarkClip: '\u4e3b\u4f53\u6697\u90e8\u7ec6\u8282\u4e22\u5931',
    subjectHighlightClip: '\u4e3b\u4f53\u4eae\u90e8\u7ec6\u8282\u4e22\u5931',
    eyeClosed: '\u95ed\u773c\u5206\u6570',
    tenengrad: 'Tenengrad',
    edgeDensity: '\u8fb9\u7f18\u5bc6\u5ea6',
    focusTexture: '\u7ec6\u8282\u5206\u6570',
    focusPeakSharpness: '\u5c40\u90e8\u6e05\u6670\u5cf0\u503c',
    focusPeakTenengrad: '\u5c40\u90e8 Tenengrad',
    focusPeakTexture: '\u5c40\u90e8\u7ec6\u8282\u5cf0\u503c',
    focusTileCount: '\u6e05\u6670\u5ea6\u5206\u5757',
    focusReliability: '\u805a\u7126\u53ef\u4fe1\u5ea6',
    faceQuality: '\u4eba\u8138\u8d28\u91cf',
    eyeReliability: '\u773c\u90e8\u53ef\u4fe1\u5ea6',
    poseReliability: '\u59ff\u6001\u53ef\u4fe1\u5ea6',
    subjectExposure: '\u4e3b\u4f53\u66dd\u5149\u5206',
    subjectRole: '\u4e3b\u4f53\u89d2\u8272',
    subjectScore: '\u4e3b\u4f53\u5206',
    subjectRank: '\u4e3b\u4f53\u6392\u540d',
    subjectConfidence: '\u4e3b\u4f53\u7f6e\u4fe1',
    subjectDecision: '\u4e3b\u4f53\u5224\u65ad',
    primarySubjects: '\u4e3b\u4f53\u4eba\u6570',
    photoKind: '\u7167\u7247\u7c7b\u578b',
    groupPortrait: '\u5408\u7167',
    standardPhoto: '\u666e\u901a',
    groupFaces: '\u5408\u7167\u4eba\u6570',
    groupClosedFaces: '\u5408\u7167\u95ed\u773c',
    centerScore: '\u5c45\u4e2d\u5206',
    lookAtCamera: '\u770b\u955c\u5934',
    cropSafety: '\u88c1\u5207\u5b89\u5168',
    subjectSharpness: '\u4e3b\u4f53\u6e05\u6670',
    eligibleSubject: '\u4e3b\u4f53\u5019\u9009',
    faceModelStatus: '\u4eba\u8138\u6a21\u578b',
    faceModelReady: '\u5df2\u5c31\u7eea',
    faceModelUnavailable: '\u4e0d\u53ef\u7528',
    faceModelUnused: '\u672a\u542f\u7528',
    diagnostics: '\u8bca\u65ad',
    focusMode: '\u805a\u7126\u6a21\u5f0f',
    focusReliable: '\u53ef\u9760\u805a\u7126',
    yes: '\u662f',
    no: '\u5426',
    focusSkip: '\u5931\u7126\u8df3\u8fc7',
    eyeSkip: '\u95ed\u773c\u8df3\u8fc7',
    modelLoadError: '\u6a21\u578b\u9519\u8bef',
    wasmPath: 'WASM',
    modelPath: '\u6a21\u578b\u8def\u5f84',
    faceDetectorStatus: '\u68c0\u6d4b\u5668\u72b6\u6001',
    faceDetectorName: '\u68c0\u6d4b\u5668',
    faceDetectorAsset: '\u68c0\u6d4b\u5668\u6a21\u578b',
    faceDetectorError: '\u68c0\u6d4b\u5668\u9519\u8bef',
    landmarkerSuccess: '\u5173\u952e\u70b9\u6210\u529f',
    faceDiagnostics: '\u4eba\u8138\u6307\u6807',
    faceIndex: '\u4eba\u8138',
    detectorRegion: '\u4eba\u8138\u68c0\u6d4b\u6846',
    detectorConfidence: '\u68c0\u6d4b\u7f6e\u4fe1\u5ea6',
    detectorSource: '\u68c0\u6d4b\u6765\u6e90',
    detectorName: '\u68c0\u6d4b\u5668',
    faceSize: '\u4eba\u8138\u5360\u6bd4',
    landmarkerStatus: '\u5173\u952e\u70b9',
    closed: '\u95ed\u773c',
    suspected: '\u7591\u4f3c',
    open: '\u672a\u95ed',
    skipped: '\u8df3\u8fc7',
    closedFaces: '\u95ed\u773c\u4eba\u8138',
    reviewFaces: '\u7591\u4f3c\u590d\u67e5',
    fileBundle: '\u5305\u542b\u6587\u4ef6',
    regions: '\u68c0\u6d4b\u533a\u57df',
    faceRegion: '\u4eba\u8138\u533a\u57df',
    centerRegion: '\u4e2d\u5fc3\u52a0\u6743\u533a\u57df',
    starRating: '\u661f\u7ea7\u8bc4\u5206',
    clearStars: '\u6e05\u9664\u661f\u7ea7',
    quickClassify: '\u5feb\u901f\u5206\u7c7b',
    pick: '\u4fdd\u7559',
    unmark: '\u672a\u6807\u8bb0',
    originalView: '\u539f\u56fe',
    aiBoxView: 'AI\u6846',
    viewMode: '\u89c2\u770b\u6a21\u5f0f',
    toggleViewMode: '\u5207\u6362\u539f\u56fe/AI\u6846',
    summary: '\u603b\u89c8',
    details: '\u5224\u636e',
    aiPanelTitle: 'AI\u4fe1\u606f',
    luminanceCurve: '\u76f4\u65b9\u56fe',
    luminanceLuma: '\u4eae\u5ea6',
    luminanceShadows: '\u6697\u90e8',
    luminanceMidtones: '\u4e2d\u95f4\u8c03',
    luminanceHighlights: '\u4eae\u90e8',
    photoScoreLabel: 'AI SCORE',
    photoScoreTitle: '\u7167\u7247\u8bc4\u5206',
    photoScorePending: '\u5f85\u5206\u6790',
    photoScoreDetails: '\u8bc4\u5206\u6784\u6210',
    gradeExcellent: '\u4f18\u79c0',
    gradeGood: '\u826f\u597d',
    gradeFair: '\u53ef\u7528',
    gradeReview: '\u590d\u67e5',
    scoreTechnicalQuality: '\u6280\u672f\u8d28\u91cf',
    scoreAestheticQuality: '\u753b\u9762\u89c2\u611f',
    scoreSceneFit: '\u573a\u666f\u9002\u914d',
    scoreExposureLatitude: '\u66dd\u5149\u4f59\u91cf',
    scoreAiRisk: 'AI \u98ce\u9669',
    scoreTechnicalHint: '\u4e3b\u4f53\u7ec6\u8282\u3001\u5bf9\u7126\u53ef\u9760\u6027\u548c\u5c40\u90e8\u6e05\u6670\u5ea6\u3002',
    scoreAestheticHint: 'NIMA \u7f8e\u5b66\u6a21\u578b\u5206\uff1b\u6a21\u578b\u4e0d\u53ef\u7528\u65f6\u4f7f\u7528\u672c\u5730\u753b\u9762\u7279\u5f81\u56de\u9000\u3002',
    scoreSceneHint: '\u6b63\u8138\u4eba\u50cf\u770b\u4e3b\u4f53\u72b6\u6001\uff0c\u80cc\u5f71\u3001\u4fa7\u8138\u548c\u7a7a\u955c\u770b\u573a\u666f\u7ed3\u6784\u4e0e\u53ef\u7528\u6027\u3002',
    scoreExposureHint: '\u4e3b\u4f53\u4eae\u5ea6\u4ee5\u53ca\u6697\u90e8/\u4eae\u90e8\u7ec6\u8282\u4fdd\u7559\u3002',
    scoreRiskHint: '\u786c\u4f24\u548c\u590d\u67e5\u7ebf\u7d22\u4f1a\u964d\u4f4e\u5206\u6570\u3002',
    aestheticModelStatus: '\u7f8e\u5b66\u6a21\u578b',
    aestheticModelReady: '\u5df2\u542f\u7528',
    aestheticModelUnavailable: '\u4e0d\u53ef\u7528',
    aestheticModelError: '\u52a0\u8f7d\u5931\u8d25',
    aestheticScore: '\u753b\u9762\u89c2\u611f\u5206',
    photoInfo: '\u7167\u7247\u4fe1\u606f',
    needsReview: '\u9700\u8981\u4eba\u5de5\u590d\u67e5',
    passedInitialScreen: 'AI\u521d\u7b5b\u6b63\u5e38',
    noDecisionYet: '\u6682\u65e0AI\u5224\u51b3',
    reviewDecisionDetail: '\u53d1\u73b0\u9700\u8981\u4eba\u5de5\u786e\u8ba4\u7684\u7b5b\u56fe\u7ebf\u7d22',
    clearDecisionDetail: 'AI\u5206\u6790\u5df2\u5b8c\u6210\uff0c\u672a\u53d1\u73b0\u660e\u663e\u786c\u4f24',
    analyzingDecisionDetail: '\u6b63\u5728\u5206\u6790\u5f53\u524d\u7167\u7247',
    waitingDecisionDetail: '\u5f53\u524d\u7167\u7247\u5c1a\u672a\u8fdb\u884c AI \u5206\u6790',
    errorDecisionDetail: 'AI\u5206\u6790\u5931\u8d25\uff0c\u53ef\u5728\u5224\u636e\u9875\u67e5\u770b\u9519\u8bef',
    aiError: 'AI\u9519\u8bef',
    detailsEmpty: '\u6682\u65e0\u8be6\u7ec6\u5224\u636e',
    summaryChecks: '\u7b5b\u56fe\u68c0\u67e5',
    issueConfidence: '\u95ee\u9898\u7f6e\u4fe1\u5ea6',
    regionsSummary: '\u68c0\u6d4b\u533a\u57df',
    diagnosticsSummary: '\u8bca\u65ad\u72b6\u6001',
    faceFocusCheck: '\u4eba\u8138\u5bf9\u7126',
    closedEyesCheck: '\u95ed\u773c\u68c0\u6d4b',
    exposureCheck: '\u66dd\u5149',
    highlightClipping: '\u4eae\u90e8\u7ec6\u8282\u4e22\u5931',
    shadowClipping: '\u6697\u90e8\u7ec6\u8282\u4e22\u5931',
    modelCheck: '\u4eba\u8138\u6a21\u578b',
    pendingValue: '\u7b49\u5f85',
    goodValue: '\u6b63\u5e38',
    noValue: '\u5426',
    reviewValue: '\u590d\u67e5',
    unavailableValue: '\u4e0d\u53ef\u7528',
    skippedValue: '\u8df3\u8fc7',
    analyzingValue: '\u5206\u6790\u4e2d',
    clearValue: '\u6b63\u5e38',
    limitedValue: '\u6709\u9650',
    noRegions: '\u6682\u65e0',
    regionUnit: '\u4e2a\u533a\u57df',
  },
  en: {
    aiReview: 'Overview',
    metadata: 'Evidence',
    aiClear: 'No hard faults found',
    aiAnalyzing: 'AI analyzing',
    aiWaiting: 'Not analyzed',
    reviewed: 'Reviewed',
    keep: 'Keep',
    reject: 'Reject',
    undecided: 'Undecided',
    issues: 'Review Flags',
    metrics: 'Key Metrics',
    model: 'Model',
    preset: 'Sensitivity',
    confidence: 'Confidence',
    faceCount: 'Faces',
    faceCandidates: 'Face candidates',
    landmarkedFaces: 'Landmarked faces',
    enhancedPasses: 'Small-face passes',
    sharpness: 'Sharpness',
    meanLuma: 'Mean luma',
    subjectLuma: 'Subject luma',
    darkClip: 'Shadow detail loss',
    highlightClip: 'Highlight detail loss',
    subjectDarkClip: 'Subject shadow detail loss',
    subjectHighlightClip: 'Subject highlight detail loss',
    eyeClosed: 'Eye score',
    tenengrad: 'Tenengrad',
    edgeDensity: 'Edge density',
    focusTexture: 'Detail score',
    focusPeakSharpness: 'Local sharpness peak',
    focusPeakTenengrad: 'Local Tenengrad peak',
    focusPeakTexture: 'Local detail peak',
    focusTileCount: 'Focus tiles',
    focusReliability: 'Focus reliability',
    faceQuality: 'Face quality',
    eyeReliability: 'Eye reliability',
    poseReliability: 'Pose reliability',
    subjectExposure: 'Subject exposure',
    subjectRole: 'Subject role',
    subjectScore: 'Subject score',
    subjectRank: 'Subject rank',
    subjectConfidence: 'Subject confidence',
    subjectDecision: 'Subject decision',
    primarySubjects: 'Primary subjects',
    photoKind: 'Photo type',
    groupPortrait: 'Group portrait',
    standardPhoto: 'Standard',
    groupFaces: 'Group faces',
    groupClosedFaces: 'Group closed eyes',
    centerScore: 'Center score',
    lookAtCamera: 'Looking camera',
    cropSafety: 'Crop safety',
    subjectSharpness: 'Subject sharpness',
    eligibleSubject: 'Primary eligible',
    faceModelStatus: 'Face model',
    faceModelReady: 'Ready',
    faceModelUnavailable: 'Unavailable',
    faceModelUnused: 'Unused',
    diagnostics: 'Diagnostics',
    focusMode: 'Focus mode',
    focusReliable: 'Reliable focus',
    yes: 'Yes',
    no: 'No',
    focusSkip: 'Focus skipped',
    eyeSkip: 'Eye skipped',
    modelLoadError: 'Model error',
    wasmPath: 'WASM',
    modelPath: 'Model path',
    faceDetectorStatus: 'Detector status',
    faceDetectorName: 'Detector',
    faceDetectorAsset: 'Detector model',
    faceDetectorError: 'Detector error',
    landmarkerSuccess: 'Landmarker success',
    faceDiagnostics: 'Face metrics',
    faceIndex: 'Face',
    detectorRegion: 'Face detector box',
    detectorConfidence: 'Detector confidence',
    detectorSource: 'Detector source',
    detectorName: 'Detector',
    faceSize: 'Face size',
    landmarkerStatus: 'Landmarker',
    closed: 'Closed',
    suspected: 'Possible',
    open: 'Open',
    skipped: 'Skipped',
    closedFaces: 'Closed faces',
    reviewFaces: 'Review hints',
    fileBundle: 'Bundle Files',
    regions: 'Detection Regions',
    faceRegion: 'Face region',
    centerRegion: 'Center-weighted region',
    starRating: 'Star Rating',
    clearStars: 'Clear rating',
    quickClassify: 'Quick Classify',
    pick: 'Pick',
    unmark: 'Unmarked',
    originalView: 'Original',
    aiBoxView: 'AI boxes',
    viewMode: 'View mode',
    toggleViewMode: 'Toggle original/AI boxes',
    summary: 'Summary',
    details: 'Evidence',
    aiPanelTitle: 'AI Info',
    luminanceCurve: 'Histogram',
    luminanceLuma: 'Luma',
    luminanceShadows: 'Shadows',
    luminanceMidtones: 'Midtones',
    luminanceHighlights: 'Highlights',
    photoScoreLabel: 'AI SCORE',
    photoScoreTitle: 'Photo score',
    photoScorePending: 'Pending',
    photoScoreDetails: 'Score breakdown',
    gradeExcellent: 'Excellent',
    gradeGood: 'Good',
    gradeFair: 'Fair',
    gradeReview: 'Review',
    scoreTechnicalQuality: 'Technical quality',
    scoreAestheticQuality: 'Aesthetic quality',
    scoreSceneFit: 'Scene fit',
    scoreExposureLatitude: 'Exposure latitude',
    scoreAiRisk: 'AI risk',
    scoreTechnicalHint: 'Subject detail, focus reliability, and local sharpness.',
    scoreAestheticHint: 'NIMA aesthetic model score, with local visual-feature fallback if the model is unavailable.',
    scoreSceneHint: 'Front portraits use subject readiness; back-view, side-view, and empty scenes use scene structure and usability.',
    scoreExposureHint: 'Subject brightness plus highlight and shadow detail reserve.',
    scoreRiskHint: 'Hard issues and review hints reduce the score.',
    aestheticModelStatus: 'Aesthetic model',
    aestheticModelReady: 'Enabled',
    aestheticModelUnavailable: 'Unavailable',
    aestheticModelError: 'Load failed',
    aestheticScore: 'Aesthetic score',
    photoInfo: 'Photo info',
    needsReview: 'Needs review',
    passedInitialScreen: 'AI clear',
    noDecisionYet: 'No AI decision',
    reviewDecisionDetail: 'Review-worthy culling hints were found',
    clearDecisionDetail: 'AI analysis is complete; no obvious hard faults found',
    analyzingDecisionDetail: 'Analyzing the current photo',
    waitingDecisionDetail: 'Current photo has not been analyzed yet',
    errorDecisionDetail: 'AI analysis failed; check Evidence for the error',
    aiError: 'AI error',
    detailsEmpty: 'No detailed evidence',
    summaryChecks: 'Culling Checks',
    issueConfidence: 'Issue confidence',
    regionsSummary: 'Detection regions',
    diagnosticsSummary: 'Diagnostics',
    faceFocusCheck: 'Face focus',
    closedEyesCheck: 'Closed eyes',
    exposureCheck: 'Exposure',
    highlightClipping: 'Highlight detail loss',
    shadowClipping: 'Shadow detail loss',
    modelCheck: 'Face model',
    pendingValue: 'Pending',
    goodValue: 'Good',
    noValue: 'No',
    reviewValue: 'Review',
    unavailableValue: 'Unavailable',
    skippedValue: 'Skipped',
    analyzingValue: 'Analyzing',
    clearValue: 'Clear',
    limitedValue: 'Limited',
    noRegions: 'None',
    regionUnit: 'regions',
  },
};

const Viewer: React.FC<ViewerProps> = ({
  group,
  animationClass,
  onUpdateSelection,
  onAiReview,
  onUpdateRating,
  theme,
  language = 'zh',
  aiViewMode,
  onAiViewModeChange,
  isAiReviewMode = false,
  rawMonitorPreview,
}) => {
  const t = getTranslations(language);
  const text = copy[language];
  const { getKeyByAction } = useShortcuts();
  const overlayShortcut = getKeyByAction('toggle_ai_overlay')?.displayKey || '/';
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [displayFrame, setDisplayFrame] = useState<DisplayFrame | null>(null);
  const [isLoadingRaw, setIsLoadingRaw] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);
  const [sidePanelTab, setSidePanelTab] = useState<'ai' | 'metadata'>('ai');
  const [monitorPanelOpen, setMonitorPanelOpen] = useState(false);
  const currentGroupId = useRef<string | null>(null);
  const rawMonitor = useRawMonitorViewerFrame({
    group,
    language,
    preview: rawMonitorPreview,
    currentGroupId,
  });
  const rawMonitorProgress = rawMonitorPreview?.progress;
  const rawMonitorIsGenerating = Boolean(
    rawMonitorProgress?.running
      && rawMonitorProgress.profileId === rawMonitorPreview?.profileId
      && (rawMonitorProgress.phase === 'checking' || rawMonitorProgress.phase === 'rendering')
  );
  const lutPreview = useMonitorLut({
    enabled: rawMonitorPreview?.lutEnabled,
    path: rawMonitorPreview?.lutPath,
    name: rawMonitorPreview?.lutName,
    language,
  });
  const rawMonitorOwnsCurrent = Boolean(rawMonitor.active && group.raw?.path);
  const currentRawMonitorFrame = rawMonitor.frame?.groupId === group.id ? rawMonitor.frame : null;
  const fallbackFrame = displayFrame;
  const effectiveFrame = currentRawMonitorFrame ?? fallbackFrame;
  const displayUrl = effectiveFrame?.url ?? null;
  const displayAi = effectiveFrame?.ai;
  const displayAlt = effectiveFrame?.alt ?? group.id;
  const isDisplayCurrent = Boolean(currentRawMonitorFrame) || effectiveFrame?.groupId === group.id;
  const inspectorDisplayUrl = isDisplayCurrent ? displayUrl : null;
  const rawMonitorFrame = rawMonitor.frame;
  const rawMonitorNotice = rawMonitor.notice;
  const [autoExposureAdjustment, setAutoExposureAdjustment] = useState<AutoExposurePreviewAdjustment | null>(null);
  const activeFrameAutoExposure = Boolean(rawMonitorPreview?.autoExposureEnabled && displayUrl && isDisplayCurrent);
  const lutNotice = rawMonitorPreview?.lutEnabled ? lutPreview.notice : null;
  const rawMonitorGeneratingTitle = language === 'zh' ? '正在生成预览缓存' : 'Generating preview cache';
  const rawMonitorGeneratingDetail = rawMonitorProgress?.total
    ? `${rawMonitorProgress.processed}/${rawMonitorProgress.total}${rawMonitorProgress.current ? ` · ${rawMonitorProgress.current}` : ''}`
    : (group.raw?.name || '');

  const containerRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const loadRequestId = useRef(0);
  const hasVisibleImage = useRef(false);
  const previousRawMonitorShouldOwnFrame = useRef(false);

  useEffect(() => {
    hasVisibleImage.current = Boolean(displayUrl);
  }, [displayUrl]);

  useEffect(() => {
    if (currentRawMonitorFrame?.groupId !== group.id) return;
    setPendingGroupId(null);
    setIsLoadingRaw(false);
    setRawError(null);
  }, [currentRawMonitorFrame?.groupId, currentRawMonitorFrame?.url, group.id]);

  useEffect(() => {
    if (!activeFrameAutoExposure) setAutoExposureAdjustment(null);
  }, [activeFrameAutoExposure, displayUrl]);

  useEffect(() => {
    setDisplayFrame(frame => (
      frame?.groupId === group.id
        ? { ...frame, alt: group.id, ai: group.ai }
        : frame
    ));
  }, [group.id, group.ai]);

  useEffect(() => {
    const rawMonitorShouldOwnFrame = Boolean(currentRawMonitorFrame?.groupId === group.id);
    const rawMonitorWasOwningFrame = previousRawMonitorShouldOwnFrame.current;
    previousRawMonitorShouldOwnFrame.current = rawMonitorShouldOwnFrame;
    if (
      currentGroupId.current === group.id
      && hasVisibleImage.current
      && !rawMonitorShouldOwnFrame
      && !rawMonitorWasOwningFrame
    ) return;
    currentGroupId.current = group.id;
    setPendingGroupId(group.id);
    if (rawMonitorShouldOwnFrame) {
      setIsLoadingRaw(false);
      setRawError(null);
      setImageReady(true);
      setPendingGroupId(null);
      return;
    }
    const showUrlWhenReady = (url: string, loadingRaw: boolean) => {
      setDisplayFrame({
        groupId: group.id,
        url,
        alt: group.id,
        ai: group.ai,
      });
      setIsLoadingRaw(loadingRaw);
      setRawError(null);
      setImageReady(true);
      setPendingGroupId(null);
    };

    if (group.jpg) {
      setIsLoadingRaw(false);
      setRawError(null);
      showUrlWhenReady(group.jpg.previewUrl, false);
      return;
    }

    if (group.raw?.path) {
      const cachedUrl = getImageFromCache(group.raw.path);
      if (cachedUrl) {
        setRawError(null);
        showUrlWhenReady(cachedUrl, false);
        return;
      }

      const cachedThumbnail = getThumbnailFromCache(group.raw.path);
      if (cachedThumbnail) {
        showUrlWhenReady(cachedThumbnail, true);
        setIsLoadingRaw(true);
        setRawError(null);
      } else {
        if (!hasVisibleImage.current) {
          setDisplayFrame(null);
          setImageReady(false);
        }
      }

      setIsLoadingRaw(true);
      setRawError(null);
      const requestId = loadRequestId.current + 1;
      loadRequestId.current = requestId;
      decodeRawFile(group.raw.path, false)
        .then(dataUrl => {
          if (loadRequestId.current === requestId && currentGroupId.current === group.id) {
            showUrlWhenReady(dataUrl, false);
          }
        })
        .catch(error => {
          console.error('Failed to load RAW preview:', error);
          if (loadRequestId.current === requestId && currentGroupId.current === group.id) {
            if (!hasVisibleImage.current) {
              setDisplayFrame(null);
              setImageReady(false);
            }
            setRawError(error instanceof Error ? error.message : 'Failed to decode RAW file');
            setIsLoadingRaw(false);
          }
        });
    } else {
      setDisplayFrame(null);
      setIsLoadingRaw(false);
      setRawError(null);
      setImageReady(false);
      setPendingGroupId(null);
    }
  }, [
    currentRawMonitorFrame?.groupId,
    currentRawMonitorFrame?.url,
    displayFrame?.groupId,
    group.id,
    group.jpg,
    group.raw,
    rawMonitorPreview?.autoExposureEnabled,
    rawMonitorPreview?.enabled,
    rawMonitorPreview?.engineVersion,
  ]);

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setRotation(0);
  }, [group.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = -event.deltaY;
      setZoom(prevZoom => {
        const nextZoom = Math.min(Math.max(prevZoom + (delta > 0 ? 0.1 : -0.1) * prevZoom, 1), 10);
        if (nextZoom === 1) setOffset({ x: 0, y: 0 });
        return nextZoom;
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  const handleMouseDown = (event: React.MouseEvent) => {
    if (zoom <= 1) return;
    setIsDragging(true);
    lastMousePos.current = { x: event.clientX, y: event.clientY };
  };

  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (!isDragging || zoom <= 1) return;
    const dx = event.clientX - lastMousePos.current.x;
    const dy = event.clientY - lastMousePos.current.y;
    setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    lastMousePos.current = { x: event.clientX, y: event.clientY };
  }, [isDragging, zoom]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const resetZoom = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };
  const frameImageReady = Boolean(currentRawMonitorFrame) || imageReady;
  const showAiOverlay = aiViewMode === 'AI' && isDisplayCurrent && frameImageReady && pendingGroupId === null;
  const handleDisplayImageError = () => {
    setRawError(language === 'zh' ? '预览图加载失败' : 'Failed to display image');
    setIsLoadingRaw(false);
    setPendingGroupId(null);
    setImageReady(false);
  };
  const handleQuickSelection = (state: SelectionState) => {
    if (isAiReviewMode) {
      onAiReview?.(state);
      return;
    }
    onUpdateSelection?.(state);
  };

  return (
    <div className={`flex h-full min-h-0 flex-1 flex-col overflow-hidden md:flex-row ${animationClass}`}>
      <div
        ref={containerRef}
        className={`relative flex flex-1 cursor-crosshair items-center justify-center overflow-hidden p-3 ${
          theme === 'dark'
            ? 'bg-[radial-gradient(circle_at_50%_48%,rgba(70,82,96,0.14)_0%,rgba(24,26,30,0.62)_32%,#101114_100%)]'
            : 'bg-slate-100'
        }`}
        onMouseDown={handleMouseDown}
        onDoubleClick={resetZoom}
      >
        {showAiOverlay && <AiStageLabels ai={displayAi} language={language} theme={theme} />}

        <div
          className="max-w-full max-h-full flex items-center justify-center relative"
          style={{
            transform: `rotate(${rotation}deg)`,
            cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
          }}
        >
          <div
            className="transition-transform duration-75 ease-out will-change-transform"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          >
            {displayUrl ? (
              <ImageWithAiRegions
                src={displayUrl}
                alt={displayAlt}
                imageReady={frameImageReady}
                ai={displayAi}
                theme={theme}
                language={language}
                showAiRegions={showAiOverlay}
                lut={lutPreview.status === 'ready' ? lutPreview.lut : null}
                lutStrength={rawMonitorPreview?.lutStrength ?? 1}
                autoExposureEnabled={activeFrameAutoExposure}
                autoExposureAdjustment={autoExposureAdjustment}
                onAutoExposureComputed={setAutoExposureAdjustment}
                onImageError={handleDisplayImageError}
              />
            ) : rawMonitorOwnsCurrent && (rawMonitor.status === 'checking' || rawMonitorIsGenerating) ? (
              <CenteredNotice
                theme={theme}
                icon={Clock3}
                loading
                title={rawMonitorIsGenerating ? rawMonitorGeneratingTitle : (rawMonitorNotice || rawMonitorPreview?.labels?.checking || 'Checking cache')}
                detail={rawMonitorIsGenerating ? rawMonitorGeneratingDetail : (group.raw?.name || '')}
              />
            ) : rawMonitorOwnsCurrent && !rawMonitorIsGenerating && (rawMonitor.status === 'missing' || rawMonitor.status === 'error') ? (
              <CenteredNotice
                theme={theme}
                icon={rawMonitor.status === 'error' ? AlertTriangle : MonitorCog}
                tone={rawMonitor.status === 'error' ? 'danger' : undefined}
                title={rawMonitorNotice || rawMonitorPreview?.labels?.missing || 'Generate cache first'}
                detail={group.raw?.name || ''}
              />
            ) : isLoadingRaw && !displayUrl ? (
              <CenteredNotice theme={theme} icon={Clock3} loading title={t.viewer.rawLoading.title} detail={group.raw?.name || ''} />
            ) : rawError ? (
              <CenteredNotice theme={theme} icon={AlertTriangle} tone="danger" title={t.viewer.rawError.title} detail={rawError} />
            ) : (
              <CenteredNotice theme={theme} icon={ScanSearch} title={t.viewer.noPreview.title} detail={group.raw?.extension || group.id} />
            )}

            {((isLoadingRaw && displayUrl) || (rawMonitorOwnsCurrent && (rawMonitor.status === 'checking' || rawMonitorIsGenerating) && displayUrl)) && (
              <div className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/18 backdrop-blur-[1px]">
                <div className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#1b1d21]/[0.84] px-3.5 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-[24px]">
                  <AppIcon icon={Clock3} className="h-3.5 w-3.5 animate-pulse text-cyan-200 motion-reduce:animate-none" />
                  <span className="text-[12px] font-medium text-zinc-200">
                    {rawMonitorOwnsCurrent && (rawMonitor.status === 'checking' || rawMonitorIsGenerating)
                      ? (rawMonitorIsGenerating ? rawMonitorGeneratingTitle : rawMonitorNotice)
                      : t.viewer.rawLoading.title}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div
          className={`absolute bottom-4 left-1/2 z-20 h-10 w-[min(680px,calc(100%-136px))] -translate-x-1/2 rounded-lg border px-2.5 ${
            theme === 'dark'
              ? photoOverlay.dark
              : photoOverlay.light
          }`}
          onMouseDown={event => event.stopPropagation()}
        >
          <div className="absolute left-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            <IconButton theme={theme} icon={RotateCcw} title={t.viewer.rotate.left} onClick={() => setRotation(prev => prev - 90)} />
            <IconButton theme={theme} icon={RotateCw} title={t.viewer.rotate.right} onClick={() => setRotation(prev => prev + 90)} />
            {rawMonitorPreview && (
              <MonitorToolbarButton
                theme={theme}
                active={Boolean(rawMonitorPreview.enabled || rawMonitorPreview.autoExposureEnabled || rawMonitorPreview.lutEnabled)}
                title={language === 'zh' ? '预览' : 'Preview'}
                onClick={() => setMonitorPanelOpen(value => !value)}
              />
            )}
          </div>
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center">
            <StarRatingControl
              rating={group.rating}
              theme={theme}
              clearLabel={text.clearStars}
              onChange={rating => onUpdateRating?.(rating)}
            />
          </div>
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            <IconButton theme={theme} icon={ZoomOut} onClick={() => setZoom(value => Math.max(value - 0.5, 1))} />
            <span className={`min-w-[38px] text-center font-mono text-[11px] font-medium ${theme === 'dark' ? 'text-zinc-500' : 'text-gray-500'}`}>
              {Math.round(zoom * 100)}%
            </span>
            <IconButton theme={theme} icon={ZoomIn} onClick={() => setZoom(value => Math.min(value + 0.5, 10))} />
            <Divider theme={theme} />
            <button onClick={resetZoom} className="px-1.5 text-[11px] font-semibold text-sky-300 transition-colors hover:text-sky-200">
              {t.viewer.zoom.reset}
            </button>
          </div>
        </div>

        {monitorPanelOpen && rawMonitorPreview && (
          <MonitorPreviewPopover
            theme={theme}
            language={language}
                preview={rawMonitorPreview}
                autoExposureAdjustment={autoExposureAdjustment}
                lutNotice={lutNotice}
                onClose={() => setMonitorPanelOpen(false)}
              />
        )}

        <ViewModeToggle
          mode={aiViewMode}
          theme={theme}
          language={language}
          shortcut={overlayShortcut}
          onChange={onAiViewModeChange}
        />

        <div className="absolute right-8 top-8 z-20 pointer-events-none">
          {group.selection === SelectionState.PICKED && (
            <SelectionPill icon="fa-check" label={t.viewer.statusLabel.picked} tone="pick" />
          )}
          {group.selection === SelectionState.REJECTED && (
            <SelectionPill icon="fa-xmark" label={t.viewer.statusLabel.rejected} tone="reject" />
          )}
        </div>

        {rawMonitorNotice && (
          <div className={`pointer-events-none absolute left-8 top-8 z-20 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
            rawMonitorFrame?.groupId === group.id
              ? theme === 'dark'
                ? 'border-emerald-300/20 bg-emerald-400/10 text-emerald-200'
                : 'border-emerald-500/25 bg-emerald-100/80 text-emerald-700'
              : theme === 'dark'
                ? 'border-amber-300/20 bg-amber-400/10 text-amber-200'
                : 'border-amber-500/25 bg-amber-100/80 text-amber-700'
          }`}>
            {rawMonitorNotice}
          </div>
        )}
        {lutNotice && (
          <div className={`pointer-events-none absolute left-8 top-16 z-20 max-w-[min(360px,calc(100%-4rem))] truncate rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
            lutPreview.status === 'ready'
              ? theme === 'dark'
                ? 'border-cyan-300/20 bg-cyan-400/10 text-cyan-200'
                : 'border-cyan-500/25 bg-cyan-100/80 text-cyan-800'
              : theme === 'dark'
                ? 'border-amber-300/20 bg-amber-400/10 text-amber-200'
                : 'border-amber-500/25 bg-amber-100/80 text-amber-700'
          }`}>
            {lutNotice}
          </div>
        )}
      </div>

      <div className={`relative min-h-0 w-[268px] overflow-hidden border-l xl:w-[288px] ${
        theme === 'dark'
          ? chromeSolid.dark
          : chromeSolid.light
      }`}>
        <div className="flex h-full min-h-0 flex-col">
          <section className="shrink-0 px-3 pb-2.5 pt-3">
            <div className={`grid grid-cols-2 gap-1 rounded-lg p-0.5 ${
              theme === 'dark' ? 'bg-black/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]' : 'bg-slate-300/22 shadow-[inset_0_1px_0_rgba(255,255,255,0.42)]'
            }`}>
              <InspectorTab
                active={sidePanelTab === 'ai'}
                label={text.aiReview}
                theme={theme}
                onClick={() => setSidePanelTab('ai')}
              />
              <InspectorTab
                active={sidePanelTab === 'metadata'}
                label={text.metadata}
                theme={theme}
                onClick={() => setSidePanelTab('metadata')}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <h2 className={`min-w-0 truncate text-[18px] font-semibold leading-[1.05] tracking-tight xl:text-[19px] ${theme === 'dark' ? 'text-white' : 'text-slate-950'}`} title={group.id}>
                {group.id}
              </h2>
              <FileBundleStatus group={group} theme={theme} />
            </div>
          </section>

          <section className="min-h-0 flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto px-3 pb-2.5 pt-2">
              {sidePanelTab === 'ai' ? (
                <OverviewPanel
                  group={group}
                  ai={group.ai}
                  displayUrl={inspectorDisplayUrl}
                  theme={theme}
                  language={language}
                  reviewedLabel={text.reviewed}
                />
              ) : (
                <AiEvidencePanel
                  ai={group.ai}
                  theme={theme}
                  language={language}
                />
              )}
            </div>
          </section>

          <section
            className={`relative z-20 shrink-0 px-3 pb-5 pt-2.5 ${
            theme === 'dark'
              ? 'bg-[#17191d] shadow-[inset_0_12px_18px_-18px_rgba(255,255,255,0.16)]'
              : 'bg-slate-200 shadow-[inset_0_12px_18px_-18px_rgba(15,23,42,0.20)]'
          }`}
          >
            <div>
              <div className="grid grid-cols-3 gap-2">
                <RatingButton
                  active={group.selection === SelectionState.PICKED}
                  icon={Flag}
                  label={text.pick}
                  hotkey={getKeyByAction('mark_picked')?.displayKey || 'P'}
                  tone="pick"
                  theme={theme}
                  onClick={() => handleQuickSelection(SelectionState.PICKED)}
                />
                <RatingButton
                  active={group.selection === SelectionState.UNMARKED}
                  icon={Circle}
                  label={text.unmark}
                  hotkey={getKeyByAction('mark_unmarked')?.displayKey || 'U'}
                  tone="neutral"
                  theme={theme}
                  onClick={() => handleQuickSelection(SelectionState.UNMARKED)}
                />
                <RatingButton
                  active={group.selection === SelectionState.REJECTED}
                  icon={Trash2}
                  label={text.reject}
                  hotkey={getKeyByAction('mark_rejected')?.displayKey || 'X'}
                  tone="reject"
                  theme={theme}
                  onClick={() => handleQuickSelection(SelectionState.REJECTED)}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

const AiStageLabels = ({ ai, language, theme }: { ai?: AiAnalysis; language: Language; theme: 'light' | 'dark' }) => {
  const text = copy[language];
  if (!ai || (ai.status !== 'ANALYZING' && ai.issues.length === 0)) return null;

  return (
    <div className="absolute top-10 left-1/2 -translate-x-1/2 z-30 flex max-w-[62%] flex-wrap items-center justify-center gap-2 pointer-events-none">
      {ai.status === 'ANALYZING' && (
        <div className="bg-cyan-500 text-zinc-950 px-3 py-1.5 rounded-full text-xs font-semibold shadow-lg flex items-center gap-2">
          <i className="fa-solid fa-spinner fa-spin"></i>
          {text.aiAnalyzing}
        </div>
      )}
      {ai.issues.map(issue => (
        <div
          key={`${issue.code}-${issue.level}`}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold shadow-lg flex items-center gap-2 ${
            issue.level === 'REVIEW_HINT'
              ? theme === 'dark'
                ? 'bg-amber-300/85 text-zinc-950 border border-white/20 backdrop-blur-sm'
                : 'bg-amber-100/95 text-amber-800 border border-amber-300 backdrop-blur-sm'
              : theme === 'dark' ? 'bg-amber-400 text-zinc-950' : 'bg-amber-500 text-white'
          }`}
        >
          <i className={`fa-solid ${aiIssueIcon(issue.code)}`}></i>
          {aiIssueLabel(issue.code, language, issue.level)} {formatConfidence(issue.confidence)}
        </div>
      ))}
    </div>
  );
};

const InspectorTab = ({
  active,
  label,
  theme,
  onClick,
}: {
  active: boolean;
  label: string;
  theme: 'light' | 'dark';
  onClick: () => void;
}) => (
  <button
    type="button"
    className={`h-7 rounded-md px-2 text-[11.5px] font-medium transition-all duration-[180ms] ease-out active:scale-[0.99] ${
      active
        ? theme === 'dark'
          ? 'bg-white/[0.08] text-sky-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_14px_rgba(125,211,252,0.10),0_5px_14px_rgba(0,0,0,0.16)]'
          : 'bg-white/62 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.82),0_0_12px_rgba(14,165,233,0.10),0_4px_12px_rgba(15,23,42,0.07)]'
        : theme === 'dark'
          ? 'text-zinc-500 hover:text-zinc-300'
          : 'text-slate-500 hover:text-slate-800'
    }`}
    onClick={onClick}
  >
    {label}
  </button>
);

const FileBundleStatus = ({ group, theme }: { group: PhotoGroup; theme: 'light' | 'dark' }) => {
  const statusLabel = group.status === GroupStatus.JPG_ONLY
    ? 'JPG ONLY'
    : group.status === GroupStatus.RAW_ONLY
      ? 'RAW ONLY'
      : 'JPG + RAW';
  const isComplete = group.status === GroupStatus.COMPLETE;

  return (
    <div className="shrink-0">
      <span className={`inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2.5 text-[10px] font-semibold leading-none tracking-[0.02em] ${
        isComplete
          ? theme === 'dark'
            ? 'bg-emerald-300/10 text-emerald-200'
            : 'bg-emerald-100/70 text-emerald-800'
          : theme === 'dark'
            ? 'bg-amber-300/10 text-amber-200'
            : 'bg-amber-100/72 text-amber-800'
      }`}>
        <span className={`h-1.5 w-1.5 rounded-full ${isComplete ? 'bg-emerald-300' : 'bg-amber-300'}`} />
        {statusLabel}
      </span>
    </div>
  );
};

const MetadataPanel = ({
  group,
  theme,
  language,
  reviewedLabel,
}: {
  group: PhotoGroup;
  theme: 'light' | 'dark';
  language: Language;
  reviewedLabel: string;
}) => {
  const text = copy[language];

  return (
    <section className={`mt-3.5 border-t pt-4 ${theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-300/70'}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className={`text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {text.photoInfo}
        </p>
        {group.ai?.reviewed && (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            theme === 'dark'
              ? 'bg-sky-400/10 text-sky-300'
              : 'bg-sky-50 text-sky-700'
          }`}>
            {reviewedLabel}
          </span>
        )}
      </div>

      <div className="space-y-3.5">
        <CompactInfoGrid group={group} theme={theme} language={language} />

        <div className={`h-px ${theme === 'dark' ? 'bg-white/[0.06]' : 'bg-slate-300/70'}`} />

        <div className="space-y-2.5">
          <p className={`text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>{text.fileBundle}</p>
          <div className="grid grid-cols-2 gap-2">
            {group.jpg && <FileItem ext="JPG" size={formatSize(group.jpg.size)} theme={theme} />}
            {group.raw && <FileItem ext={group.raw.extension} size={formatSize(group.raw.size)} isRaw theme={theme} />}
          </div>
        </div>
      </div>
    </section>
  );
};

const CompactInfoGrid = ({
  group,
  theme,
  language,
}: {
  group: PhotoGroup;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const t = getTranslations(language);
  const items = [
    { label: t.viewer.exif.shutter, value: group.exif?.shutterSpeed, icon: Timer },
    { label: t.viewer.exif.aperture, value: group.exif?.aperture, icon: Aperture },
    { label: t.viewer.exif.iso, value: group.exif?.iso, icon: Gauge },
    { label: t.viewer.exif.focal, value: group.exif?.focalLength, icon: Focus },
    { label: t.viewer.exif.device, value: group.exif?.model, icon: Camera },
    { label: t.viewer.exif.optics, value: group.exif?.lens, icon: Aperture },
    { label: t.viewer.exif.timestamp, value: group.exif?.dateTime, icon: CalendarClock },
  ];

  return (
    <div className="space-y-3.5">
      <InfoPairRow
        left={items[0]}
        right={items[1]}
        theme={theme}
      />
      <InfoPairRow
        left={items[2]}
        right={items[3]}
        theme={theme}
      />
      <InfoFullRow item={items[4]} theme={theme} />
      <InfoFullRow item={items[5]} theme={theme} />
      <InfoFullRow item={items[6]} theme={theme} />
    </div>
  );
};

const InfoPairRow = ({
  left,
  right,
  theme,
}: {
  left: { label: string; value?: string; icon?: LucideIcon };
  right: { label: string; value?: string; icon?: LucideIcon };
  theme: 'light' | 'dark';
}) => (
  <div className="grid grid-cols-2 gap-4">
    <InfoDatum item={left} theme={theme} compact />
    <InfoDatum item={right} theme={theme} compact />
  </div>
);

const InfoFullRow = ({
  item,
  theme,
}: {
  item: { label: string; value?: string; icon?: LucideIcon };
  theme: 'light' | 'dark';
}) => (
  <InfoDatum item={item} theme={theme} />
);

const InfoDatum = ({
  item,
  theme,
  compact = false,
}: {
  item: { label: string; value?: string; icon?: LucideIcon };
  theme: 'light' | 'dark';
  compact?: boolean;
}) => (
  <div className={`min-w-0 ${compact ? 'py-0.5' : 'px-0 py-1.5'}`}>
    <div className={`mb-1 flex min-w-0 items-center gap-1.5 text-[11px] font-medium leading-none ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
      {item.icon && <AppIcon icon={item.icon} className="h-3.5 w-3.5 shrink-0 opacity-75" />}
      <span className="truncate">{item.label}</span>
    </div>
    <div className={`truncate font-mono text-[13px] font-semibold leading-snug ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-800'}`} title={item.value || '--'}>
      {item.value || '--'}
    </div>
  </div>
);

const HISTOGRAM_BIN_COUNT = 64;
const HISTOGRAM_PAD_X = 9;
const EMPTY_HISTOGRAM = Array.from({ length: HISTOGRAM_BIN_COUNT }, () => 0);
type HistogramChannels = {
  luma: number[];
  red: number[];
  green: number[];
  blue: number[];
};
type VisibleHistogramChannel = 'red' | 'green' | 'blue';

const createEmptyHistogramChannels = (): HistogramChannels => ({
  luma: [...EMPTY_HISTOGRAM],
  red: [...EMPTY_HISTOGRAM],
  green: [...EMPTY_HISTOGRAM],
  blue: [...EMPTY_HISTOGRAM],
});

const HISTOGRAM_CACHE_LIMIT = 80;
const photoHistogramCache = new Map<string, HistogramChannels>();
const pendingPhotoHistograms = new Map<string, Promise<HistogramChannels>>();

function scheduleIdleWork(callback: () => void, timeout = 260) {
  if (typeof window === 'undefined') return () => undefined;
  const idleWindow = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof idleWindow.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(callback, { timeout });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, Math.min(timeout, 120));
  return () => window.clearTimeout(handle);
}

function rememberPhotoHistogram(src: string, histogram: HistogramChannels) {
  if (photoHistogramCache.has(src)) photoHistogramCache.delete(src);
  photoHistogramCache.set(src, histogram);
  while (photoHistogramCache.size > HISTOGRAM_CACHE_LIMIT) {
    const oldestKey = photoHistogramCache.keys().next().value;
    if (!oldestKey) break;
    photoHistogramCache.delete(oldestKey);
  }
}

function getPhotoHistogram(src: string) {
  const cached = photoHistogramCache.get(src);
  if (cached) {
    photoHistogramCache.delete(src);
    photoHistogramCache.set(src, cached);
    return Promise.resolve(cached);
  }

  const pending = pendingPhotoHistograms.get(src);
  if (pending) return pending;

  const promise = computePhotoHistogram(src)
    .then(histogram => {
      rememberPhotoHistogram(src, histogram);
      return histogram;
    })
    .finally(() => {
      pendingPhotoHistograms.delete(src);
    });
  pendingPhotoHistograms.set(src, promise);
  return promise;
}

const PhotoHistogram = ({
  src,
  theme,
  className = '',
  compact = false,
}: {
  src: string | null;
  theme: 'light' | 'dark';
  className?: string;
  compact?: boolean;
}) => {
  const [targetHistogram, setTargetHistogram] = useState<HistogramChannels>(() => createEmptyHistogramChannels());
  const [displayHistogram, setDisplayHistogram] = useState<HistogramChannels>(() => createEmptyHistogramChannels());
  const [hoveredChannel, setHoveredChannel] = useState<VisibleHistogramChannel | null>(null);
  const displayHistogramRef = useRef<HistogramChannels>(createEmptyHistogramChannels());
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!src) {
      setTargetHistogram(createEmptyHistogramChannels());
      return () => {
        cancelled = true;
      };
    }

    const cached = photoHistogramCache.get(src);
    if (cached) {
      setTargetHistogram(cached);
      return () => {
        cancelled = true;
      };
    }

    const cancelScheduledWork = scheduleIdleWork(() => {
      void getPhotoHistogram(src)
        .then(histogram => {
          if (!cancelled) setTargetHistogram(histogram);
        })
        .catch(error => {
          console.warn('Failed to compute photo histogram:', error);
          if (!cancelled) setTargetHistogram(createEmptyHistogramChannels());
        });
    });

    return () => {
      cancelled = true;
      cancelScheduledWork();
    };
  }, [src]);

  useEffect(() => {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      displayHistogramRef.current = targetHistogram;
      setDisplayHistogram(targetHistogram);
      return;
    }

    const startHistogram = displayHistogramRef.current;
    const startedAt = performance.now();
    const duration = 220;

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      const nextHistogram = interpolateHistogram(startHistogram, targetHistogram, eased);

      displayHistogramRef.current = nextHistogram;
      setDisplayHistogram(nextHistogram);

      if (progress < 1) {
        animationRef.current = window.requestAnimationFrame(step);
        return;
      }

      animationRef.current = null;
      displayHistogramRef.current = targetHistogram;
      setDisplayHistogram(targetHistogram);
    };

    animationRef.current = window.requestAnimationFrame(step);

    return () => {
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [targetHistogram]);

  const redAreaPath = histogramAreaPath(displayHistogram.red);
  const greenAreaPath = histogramAreaPath(displayHistogram.green);
  const blueAreaPath = histogramAreaPath(displayHistogram.blue);
  const redPath = histogramLinePath(displayHistogram.red);
  const greenPath = histogramLinePath(displayHistogram.green);
  const bluePath = histogramLinePath(displayHistogram.blue);
  const histogramColors = theme === 'dark'
    ? {
        red: 'rgb(248 113 113)',
        green: 'rgb(52 211 153)',
        blue: 'rgb(56 189 248)',
      }
    : {
        red: 'rgb(225 76 76)',
        green: 'rgb(16 151 116)',
        blue: 'rgb(20 148 214)',
      };
  const isHovering = hoveredChannel !== null;
  const channelOpacity = (channel: VisibleHistogramChannel) => (isHovering ? (hoveredChannel === channel ? 0.96 : 0.24) : (theme === 'dark' ? 0.86 : 0.78));
  const channelStrokeWidth = (channel: VisibleHistogramChannel) => (hoveredChannel === channel ? 2.05 : (theme === 'dark' ? 1.15 : 1.35));
  const channelAreaOpacity = (channel: VisibleHistogramChannel) => {
    if (!isHovering) return theme === 'dark' ? 0.50 : 0.18;
    return hoveredChannel === channel ? (theme === 'dark' ? 0.76 : 0.34) : 0.08;
  };

  return (
    <section className={`${compact ? 'p-0' : 'mb-3 px-0.5 pt-1.5'} ${className}`}>
      <div className={`relative ${compact ? 'h-[58px]' : 'h-[72px]'} overflow-hidden rounded-md ${
        compact
          ? theme === 'dark'
            ? 'bg-white/[0.018] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.025)]'
            : 'bg-white/30 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.10)]'
          : theme === 'dark'
            ? 'bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]'
            : 'bg-white/36 shadow-[inset_0_1px_0_rgba(255,255,255,0.72),inset_0_0_0_1px_rgba(148,163,184,0.12)]'
      }`}>
        <svg
          viewBox="0 0 240 72"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          onPointerLeave={() => setHoveredChannel(null)}
        >
          <defs>
            <linearGradient id="histogram-baseline-dark" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgb(244 244 245)" stopOpacity="0" />
              <stop offset="14%" stopColor="rgb(244 244 245)" stopOpacity="0.22" />
              <stop offset="86%" stopColor="rgb(244 244 245)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="rgb(244 244 245)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="histogram-baseline-light" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgb(71 85 105)" stopOpacity="0" />
              <stop offset="14%" stopColor="rgb(71 85 105)" stopOpacity="0.18" />
              <stop offset="86%" stopColor="rgb(71 85 105)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="rgb(71 85 105)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line
            x1="0"
            y1="66"
            x2="240"
            y2="66"
            stroke={theme === 'dark' ? 'url(#histogram-baseline-dark)' : 'url(#histogram-baseline-light)'}
            strokeWidth="0.8"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={redAreaPath}
            fill={histogramColors.red}
            fillOpacity={channelAreaOpacity('red')}
            style={{ mixBlendMode: theme === 'dark' ? 'screen' : 'normal', transition: 'fill-opacity 160ms ease' }}
          />
          <path
            d={greenAreaPath}
            fill={histogramColors.green}
            fillOpacity={channelAreaOpacity('green')}
            style={{ mixBlendMode: theme === 'dark' ? 'screen' : 'normal', transition: 'fill-opacity 160ms ease' }}
          />
          <path
            d={blueAreaPath}
            fill={histogramColors.blue}
            fillOpacity={channelAreaOpacity('blue')}
            style={{ mixBlendMode: theme === 'dark' ? 'screen' : 'normal', transition: 'fill-opacity 160ms ease' }}
          />
          {([
            ['red', redPath, histogramColors.red],
            ['green', greenPath, histogramColors.green],
            ['blue', bluePath, histogramColors.blue],
          ] as const).map(([channel, path, color]) => (
            <path
              key={channel}
              d={path}
              fill="none"
              stroke={color}
              strokeOpacity={channelOpacity(channel)}
              strokeWidth={channelStrokeWidth(channel)}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              style={{ mixBlendMode: theme === 'dark' ? 'screen' : 'normal', transition: 'stroke-opacity 160ms ease, stroke-width 160ms ease' }}
            />
          ))}
          {([
            ['red', redPath],
            ['green', greenPath],
            ['blue', bluePath],
          ] as const).map(([channel, path]) => (
            <path
              key={`hit-${channel}`}
              d={path}
              fill="none"
              stroke="transparent"
              strokeWidth="12"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="stroke"
              onPointerEnter={() => setHoveredChannel(channel)}
            />
          ))}
        </svg>
      </div>
    </section>
  );
};

const AiScoreRing = ({
  ai,
  theme,
  language,
}: {
  ai?: AiAnalysis;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];
  const score = ai?.photoScore;
  const value = score?.overall ?? 0;
  const displayValue = score ? Math.round(value) : '--';
  const progress = Math.max(0, Math.min(100, value)) / 100;
  const arcStartAngle = 135;
  const arcSpan = 270;
  const trackPath = describeScoreArc(32, 32, 25, arcStartAngle, arcStartAngle - arcSpan);
  const progressPath = progress > 0
    ? describeScoreArc(32, 32, 25, arcStartAngle, arcStartAngle - arcSpan * progress)
    : '';
  const gradeLabel = score ? formatScoreGrade(score.grade, language) : text.photoScorePending;
  const tone = scoreTone(score?.overall);
  const trackColor = theme === 'dark' ? 'rgba(255,255,255,0.075)' : 'rgba(100,116,139,0.16)';
  const glow = score
    ? tone === 'emerald'
      ? theme === 'dark' ? 'drop-shadow(0 0 5px rgba(52,211,153,0.24))' : 'drop-shadow(0 0 4px rgba(5,150,105,0.14))'
      : tone === 'cyan'
        ? theme === 'dark' ? 'drop-shadow(0 0 5px rgba(34,211,238,0.22))' : 'drop-shadow(0 0 4px rgba(8,145,178,0.14))'
        : tone === 'amber'
          ? theme === 'dark' ? 'drop-shadow(0 0 5px rgba(251,191,36,0.20))' : 'drop-shadow(0 0 4px rgba(217,119,6,0.12))'
          : theme === 'dark' ? 'drop-shadow(0 0 5px rgba(251,113,133,0.18))' : 'drop-shadow(0 0 4px rgba(225,29,72,0.10))'
    : 'none';
  const strokeColor = score
    ? tone === 'emerald'
      ? theme === 'dark' ? 'rgb(52 211 153)' : 'rgb(5 150 105)'
      : tone === 'cyan'
        ? theme === 'dark' ? 'rgb(34 211 238)' : 'rgb(8 145 178)'
        : tone === 'amber'
          ? theme === 'dark' ? 'rgb(251 191 36)' : 'rgb(217 119 6)'
          : theme === 'dark' ? 'rgb(251 113 133)' : 'rgb(225 29 72)'
    : theme === 'dark' ? 'rgb(113 113 122)' : 'rgb(100 116 139)';

  return (
    <div className="relative h-[68px] w-[66px] shrink-0">
      <div className="absolute left-1/2 top-0 h-[64px] w-[64px] -translate-x-1/2">
        <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full">
          <path d={trackPath} fill="none" stroke={trackColor} strokeWidth="3.2" strokeLinecap="round" />
          {progressPath && (
            <path
              d={progressPath}
              fill="none"
              stroke={strokeColor}
              strokeWidth="3.8"
              strokeLinecap="round"
              style={{
                filter: glow,
                transition: 'stroke 180ms ease',
              }}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`font-mono text-[22px] font-semibold tabular-nums leading-none tracking-[-0.02em] ${
            score
              ? theme === 'dark' ? 'text-zinc-50' : 'text-slate-950'
              : theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'
          }`}>
            {displayValue}
          </span>
        </div>
      </div>
      <span className={`absolute bottom-[7px] left-1/2 max-w-[64px] -translate-x-1/2 truncate text-[10px] font-medium leading-none ${scoreGradeClass(score?.overall, theme)}`}>
        {gradeLabel}
      </span>
    </div>
  );
};

const ScoreDetailsPopover = ({
  ai,
  theme,
  language,
}: {
  ai?: AiAnalysis;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];
  const score = ai?.photoScore;

  return (
    <div className={`pointer-events-none absolute right-0 top-[calc(100%+8px)] z-30 w-[248px] translate-y-1 rounded-lg border p-2.5 opacity-0 shadow-[0_18px_42px_rgba(0,0,0,0.38),inset_0_1px_0_rgba(255,255,255,0.045)] backdrop-blur-[24px] transition-[opacity,transform] duration-150 group-hover/score:pointer-events-auto group-hover/score:translate-y-0 group-hover/score:opacity-100 group-focus-within/score:pointer-events-auto group-focus-within/score:translate-y-0 group-focus-within/score:opacity-100 ${
      theme === 'dark'
        ? 'border-white/[0.09] bg-[#202226]/[0.985] text-zinc-100'
        : 'border-slate-400/30 bg-white/[0.985] text-slate-950'
    }`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className={`text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-900'}`}>
          {text.photoScoreDetails}
        </span>
        <span className={`font-mono text-[11px] font-semibold tabular-nums ${scoreGradeClass(score?.overall, theme)}`}>
          {score ? `${score.overall}/100` : '--'}
        </span>
      </div>
      <div className="space-y-1.5">
        {(score?.components ?? defaultScoreComponents()).map(component => (
          <div key={component.key}>
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className={theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}>
                {scoreComponentLabel(component.key, language)}
              </span>
              <span className={`font-mono tabular-nums ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-900'}`}>
                {score ? component.score : '--'}
                <span className={theme === 'dark' ? 'text-zinc-600' : 'text-slate-400'}> / {component.weight}%</span>
              </span>
            </div>
            <div className={`mt-1 h-1 overflow-hidden rounded-full ${theme === 'dark' ? 'bg-white/[0.07]' : 'bg-slate-300/45'}`}>
              <div
                className={`h-full rounded-full ${score ? scoreBarClass(component.score, theme) : theme === 'dark' ? 'bg-zinc-600' : 'bg-slate-400'}`}
                style={{ width: score ? `${Math.max(4, Math.min(100, component.score))}%` : '0%' }}
              />
            </div>
            <p className={`mt-0.5 line-clamp-2 min-h-[20px] text-[9px] leading-[10px] ${
              theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'
            }`}>
              {scoreComponentDetail(component, language)}
            </p>
          </div>
        ))}
      </div>
      <p className={`mt-2 text-[10px] leading-snug ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}`}>
        {scoreSummary(ai, language)}
      </p>
    </div>
  );
};

const ScoreHistogramPanel = ({
  ai,
  displayUrl,
  theme,
  language,
}: {
  ai?: AiAnalysis;
  displayUrl: string | null;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];

  return (
    <div
      tabIndex={0}
      className="group/score relative mb-3 px-0.5 pb-1 pt-0.5 outline-none"
      aria-label={text.photoScoreDetails}
    >
      <div className="flex items-center gap-2.5">
        <AiScoreRing ai={ai} theme={theme} language={language} />
        <PhotoHistogram src={displayUrl} theme={theme} compact className="min-w-0 flex-1" />
      </div>
      <ScoreDetailsPopover ai={ai} theme={theme} language={language} />
    </div>
  );
};

function defaultScoreComponents() {
  return ([
    'TECHNICAL_QUALITY',
    'AESTHETIC_QUALITY',
    'SCENE_FIT',
    'EXPOSURE_LATITUDE',
    'AI_RISK',
  ] as AiPhotoScoreComponentKey[]).map(key => ({
    key,
    label: key,
    score: 0,
    weight: scoreComponentWeight(key),
  }));
}

function scoreComponentWeight(key: AiPhotoScoreComponentKey) {
  switch (key) {
    case 'TECHNICAL_QUALITY':
      return 35;
    case 'AESTHETIC_QUALITY':
      return 25;
    case 'SCENE_FIT':
      return 15;
    case 'EXPOSURE_LATITUDE':
      return 15;
    case 'AI_RISK':
    default:
      return 10;
  }
}

function scoreComponentLabel(key: AiPhotoScoreComponentKey, language: Language) {
  const text = copy[language];
  switch (key) {
    case 'TECHNICAL_QUALITY':
      return text.scoreTechnicalQuality;
    case 'AESTHETIC_QUALITY':
      return text.scoreAestheticQuality;
    case 'SCENE_FIT':
      return text.scoreSceneFit;
    case 'EXPOSURE_LATITUDE':
      return text.scoreExposureLatitude;
    case 'AI_RISK':
    default:
      return text.scoreAiRisk;
  }
}

function scoreComponentHint(key: AiPhotoScoreComponentKey, language: Language) {
  const text = copy[language];
  switch (key) {
    case 'TECHNICAL_QUALITY':
      return text.scoreTechnicalHint;
    case 'AESTHETIC_QUALITY':
      return text.scoreAestheticHint;
    case 'SCENE_FIT':
      return text.scoreSceneHint;
    case 'EXPOSURE_LATITUDE':
      return text.scoreExposureHint;
    case 'AI_RISK':
    default:
      return text.scoreRiskHint;
  }
}

function scoreComponentDetail(
  component: { key: AiPhotoScoreComponentKey; detail?: string },
  language: Language,
) {
  if (!component.detail) return scoreComponentHint(component.key, language);
  if (language === 'en') return component.detail;

  switch (component.detail) {
    case 'Subject detail, focus reliability, and local sharpness.':
      return '\u4e3b\u4f53\u7ec6\u8282\u3001\u5bf9\u7126\u53ef\u9760\u6027\u548c\u5c40\u90e8\u6e05\u6670\u5ea6\u3002';
    case 'Frame-level detail, texture peaks, and environmental sharpness; tiny people do not force portrait scoring.':
      return '\u5168\u753b\u9762\u7ec6\u8282\u3001\u7eb9\u7406\u5cf0\u503c\u548c\u73af\u5883\u6e05\u6670\u5ea6\u3002';
    case 'Global detail, texture peaks, and frame-level sharpness.':
      return '\u6309\u5168\u5c40\u7ec6\u8282\u3001\u7eb9\u7406\u5cf0\u503c\u548c\u753b\u9762\u7ea7\u6e05\u6670\u5ea6\u8bc4\u5206\u3002';
    case 'NIMA aesthetic model score.':
      return 'NIMA \u7f8e\u5b66\u6a21\u578b\u5206\u3002';
    case 'Aesthetic fallback from structure, exposure, and color stability.':
      return '\u7ed3\u6784\u3001\u66dd\u5149\u548c\u8272\u5f69\u7a33\u5b9a\u6027\u56de\u9000\u3002';
    case 'Front portrait readiness, crop safety, and subject placement.':
      return '\u6b63\u8138\u4eba\u50cf\u72b6\u6001\u3001\u88c1\u5207\u5b89\u5168\u548c\u4e3b\u4f53\u4f4d\u7f6e\u3002';
    case 'Portrait placement, crop safety, separation, and visual readiness.':
      return '\u4eba\u50cf\u4f4d\u7f6e\u3001\u88c1\u5207\u5b89\u5168\u3001\u4e3b\u4f53\u5206\u79bb\u548c\u753b\u9762\u72b6\u6001\u3002';
    case 'Environmental portrait structure, scale, exposure balance, and visual mood.':
      return '\u7ed3\u6784\u3001\u4eba\u7269\u5c3a\u5ea6\u3001\u66dd\u5149\u548c\u6c1b\u56f4\u3002';
    case 'Landscape, empty-scene, or environmental composition, exposure balance, and visual structure.':
      return '\u6784\u56fe\u3001\u66dd\u5149\u5e73\u8861\u548c\u89c6\u89c9\u7ed3\u6784\u3002';
    case 'Subject brightness plus highlight and shadow detail reserve.':
      return '\u4e3b\u4f53\u4eae\u5ea6\u4ee5\u53ca\u4eae\u90e8/\u6697\u90e8\u7ec6\u8282\u4f59\u91cf\u3002';
    case 'Frame brightness plus global highlight and shadow detail reserve.':
      return '\u5168\u753b\u9762\u4eae\u5ea6\u4ee5\u53ca\u6574\u4f53\u4eae\u90e8/\u6697\u90e8\u7ec6\u8282\u4f59\u91cf\u3002';
    case 'Hard issues and review hints reduce the score.':
      return '\u786c\u4f24\u548c\u590d\u67e5\u7ebf\u7d22\u4f1a\u964d\u4f4e\u5206\u6570\u3002';
    default:
      return scoreComponentHint(component.key, language);
  }
}

function formatScoreGrade(grade: NonNullable<AiAnalysis['photoScore']>['grade'], language: Language) {
  const text = copy[language];
  switch (grade) {
    case 'EXCELLENT':
      return text.gradeExcellent;
    case 'GOOD':
      return text.gradeGood;
    case 'FAIR':
      return text.gradeFair;
    case 'REVIEW':
    default:
      return text.gradeReview;
  }
}

function scoreSummary(ai: AiAnalysis | undefined, language: Language) {
  if (!ai?.photoScore) return copy[language].waitingDecisionDetail;
  const hasHardIssue = ai.issues.some(issue => issue.level === 'ISSUE');
  const hasHint = ai.issues.length > 0;
  if (language === 'en') {
    if (hasHardIssue) return 'Hard AI issues found; review before keeping.';
    if (hasHint) return 'Review hints reduce this score until checked.';
    if (ai.photoScore.grade === 'EXCELLENT') return 'Strong candidate with clean AI checks.';
    if (ai.photoScore.grade === 'GOOD') return 'Good candidate with no hard AI issues.';
    if (ai.photoScore.grade === 'FAIR') return 'Usable frame, but confidence is moderate.';
    return 'Low-confidence candidate; review manually.';
  }
  if (hasHardIssue) return '\u53d1\u73b0\u660e\u786e\u786c\u4f24\uff0c\u5efa\u8bae\u4eba\u5de5\u590d\u67e5\u540e\u518d\u4fdd\u7559\u3002';
  if (hasHint) return '\u5b58\u5728\u590d\u67e5\u7ebf\u7d22\uff0c\u8bc4\u5206\u5df2\u76f8\u5e94\u4e0b\u8c03\u3002';
  if (ai.photoScore.grade === 'EXCELLENT') return '\u5f3a\u5019\u9009\uff0cAI \u68c0\u67e5\u5e72\u51c0\uff0c\u4f18\u5148\u67e5\u770b\u3002';
  if (ai.photoScore.grade === 'GOOD') return '\u826f\u597d\u5019\u9009\uff0c\u672a\u53d1\u73b0\u660e\u663e\u786c\u4f24\u3002';
  if (ai.photoScore.grade === 'FAIR') return '\u53ef\u7528\u7167\u7247\uff0c\u4f46\u6784\u56fe\u6216\u6280\u672f\u4fe1\u5fc3\u4e2d\u7b49\u3002';
  return '\u4f4e\u4fe1\u5fc3\u5019\u9009\uff0c\u5efa\u8bae\u4eba\u5de5\u5224\u65ad\u3002';
}

function scoreTone(score: number | undefined) {
  if (score === undefined) return 'neutral';
  if (score >= 88) return 'emerald';
  if (score >= 76) return 'cyan';
  if (score >= 62) return 'amber';
  return 'rose';
}

function scoreGradeClass(score: number | undefined, theme: 'light' | 'dark') {
  const tone = scoreTone(score);
  if (tone === 'emerald') return theme === 'dark' ? 'text-emerald-200' : 'text-emerald-700';
  if (tone === 'cyan') return theme === 'dark' ? 'text-cyan-200' : 'text-cyan-700';
  if (tone === 'amber') return theme === 'dark' ? 'text-amber-200' : 'text-amber-700';
  if (tone === 'rose') return theme === 'dark' ? 'text-rose-200' : 'text-rose-700';
  return theme === 'dark' ? 'text-zinc-500' : 'text-slate-500';
}

function scoreBarClass(score: number, theme: 'light' | 'dark') {
  if (score >= 88) return theme === 'dark' ? 'bg-emerald-300 shadow-[0_0_7px_rgba(52,211,153,0.20)]' : 'bg-emerald-600';
  if (score >= 76) return theme === 'dark' ? 'bg-cyan-300 shadow-[0_0_7px_rgba(34,211,238,0.18)]' : 'bg-cyan-600';
  if (score >= 62) return theme === 'dark' ? 'bg-amber-300 shadow-[0_0_7px_rgba(251,191,36,0.16)]' : 'bg-amber-500';
  return theme === 'dark' ? 'bg-rose-300 shadow-[0_0_7px_rgba(251,113,133,0.16)]' : 'bg-rose-600';
}

function formatAestheticModelStatus(aesthetic: AiAestheticScore | undefined, language: Language) {
  const text = copy[language];
  if (!aesthetic) return text.aestheticModelUnavailable;
  if (aesthetic.status === 'READY') return text.aestheticModelReady;
  if (aesthetic.status === 'ERROR') return text.aestheticModelError;
  return text.aestheticModelUnavailable;
}

async function computePhotoHistogram(src: string): Promise<HistogramChannels> {
  try {
    return await computePhotoHistogramFromBlob(src);
  } catch (error) {
    console.warn('Blob histogram path failed, falling back to image element:', error);
    return computePhotoHistogramFromImageUrl(src, shouldUseAnonymousCrossOrigin(src));
  }
}

async function computePhotoHistogramFromBlob(src: string): Promise<HistogramChannels> {
  const response = await fetch(src, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Histogram image fetch failed: ${response.status}`);
  const blob = await response.blob();
  if (blob.size <= 0) return createEmptyHistogramChannels();

  const objectUrl = URL.createObjectURL(blob);
  try {
    return await computePhotoHistogramFromImageUrl(objectUrl, false);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function computePhotoHistogramFromImageUrl(src: string, anonymousCrossOrigin: boolean): Promise<HistogramChannels> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    if (anonymousCrossOrigin) {
      image.crossOrigin = 'anonymous';
    }

    image.onload = () => {
      try {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (width <= 0 || height <= 0) {
          resolve(createEmptyHistogramChannels());
          return;
        }

        const maxSampleWidth = 192;
        const scale = Math.min(1, maxSampleWidth / width);
        const sampleWidth = Math.max(1, Math.round(width * scale));
        const sampleHeight = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = sampleWidth;
        canvas.height = sampleHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          resolve(createEmptyHistogramChannels());
          return;
        }

        context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
        const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
        const counts: HistogramChannels = createEmptyHistogramChannels();

        for (let index = 0; index < pixels.length; index += 4) {
          const r = pixels[index] ?? 0;
          const g = pixels[index + 1] ?? 0;
          const b = pixels[index + 2] ?? 0;
          const alpha = pixels[index + 3] ?? 255;
          if (alpha < 16) continue;

          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          counts.luma[valueToHistogramBin(luma)] += 1;
          counts.red[valueToHistogramBin(r)] += 1;
          counts.green[valueToHistogramBin(g)] += 1;
          counts.blue[valueToHistogramBin(b)] += 1;
        }

        resolve(normalizeHistogramChannels(counts));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error('Unable to load histogram image'));
    image.src = src;
  });
}

function shouldUseAnonymousCrossOrigin(src: string) {
  if (!/^https?:/i.test(src)) return false;
  try {
    return new URL(src).origin !== window.location.origin;
  } catch {
    return true;
  }
}

function valueToHistogramBin(value: number) {
  return Math.max(0, Math.min(HISTOGRAM_BIN_COUNT - 1, Math.floor((value / 256) * HISTOGRAM_BIN_COUNT)));
}

function normalizeHistogramChannels(counts: HistogramChannels): HistogramChannels {
  const peak = Math.max(
    ...counts.luma,
    ...counts.red,
    ...counts.green,
    ...counts.blue,
  );

  if (peak <= 0) return createEmptyHistogramChannels();

  return {
    luma: smoothHistogram(normalizeHistogram(counts.luma, peak)),
    red: smoothHistogram(normalizeHistogram(counts.red, peak)),
    green: smoothHistogram(normalizeHistogram(counts.green, peak)),
    blue: smoothHistogram(normalizeHistogram(counts.blue, peak)),
  };
}

function normalizeHistogram(values: number[], peak: number) {
  return values.map(value => Math.sqrt(value / peak));
}

function smoothHistogram(values: number[]) {
  let smoothed = values;
  for (let pass = 0; pass < 2; pass += 1) {
    smoothed = smoothed.map((value, index) => {
      const left2 = smoothed[index - 2] ?? smoothed[index - 1] ?? value;
      const left1 = smoothed[index - 1] ?? value;
      const right1 = smoothed[index + 1] ?? value;
      const right2 = smoothed[index + 2] ?? smoothed[index + 1] ?? value;
      return left2 * 0.06 + left1 * 0.22 + value * 0.44 + right1 * 0.22 + right2 * 0.06;
    });
  }
  return smoothed;
}

function interpolateHistogram(start: HistogramChannels, target: HistogramChannels, progress: number): HistogramChannels {
  return {
    luma: interpolateBins(start.luma, target.luma, progress),
    red: interpolateBins(start.red, target.red, progress),
    green: interpolateBins(start.green, target.green, progress),
    blue: interpolateBins(start.blue, target.blue, progress),
  };
}

function interpolateBins(startBins: number[], targetBins: number[], progress: number) {
  return targetBins.map((value, index) => {
    const start = startBins[index] ?? 0;
    return start + (value - start) * progress;
  });
}

function histogramLinePath(values: number[]) {
  const points = histogramPoints(values);
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;

  const commands = [`M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[Math.min(points.length - 1, index + 2)];
    const cp1x = current.x + (next.x - previous.x) / 6;
    const cp1y = clampHistogramY(current.y + (next.y - previous.y) / 6);
    const cp2x = next.x - (afterNext.x - current.x) / 6;
    const cp2y = clampHistogramY(next.y - (afterNext.y - current.y) / 6);

    commands.push(
      `C${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`
    );
  }

  return commands.join(' ');
}

function histogramAreaPath(values: number[]) {
  const points = histogramPoints(values);
  if (points.length === 0) return '';
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  return `${line} L${(240 - HISTOGRAM_PAD_X).toFixed(2)} 66 L${HISTOGRAM_PAD_X.toFixed(2)} 66 Z`;
}

function histogramPoints(values: number[]) {
  const width = 240;
  const bottom = 66;
  const height = 55;
  const maxIndex = Math.max(1, values.length - 1);
  return values.map((value, index) => ({
    x: HISTOGRAM_PAD_X + (index / maxIndex) * (width - HISTOGRAM_PAD_X * 2),
    y: bottom - Math.max(0, Math.min(1, value)) * height,
  }));
}

function clampHistogramY(value: number) {
  return Math.max(6, Math.min(66, value));
}

function describeScoreArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number, forceLargeArc?: 0 | 1) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const sweep = startAngle - endAngle;
  const largeArcFlag = forceLargeArc ?? (Math.abs(sweep) > 180 ? 1 : 0);
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDegrees: number) {
  const angleRadians = (angleDegrees - 90) * Math.PI / 180;
  return {
    x: cx + r * Math.cos(angleRadians),
    y: cy + r * Math.sin(angleRadians),
  };
}

const OverviewPanel = ({
  group,
  ai,
  displayUrl,
  theme,
  language,
  reviewedLabel,
}: {
  group: PhotoGroup;
  ai?: AiAnalysis;
  displayUrl: string | null;
  theme: 'light' | 'dark';
  language: Language;
  reviewedLabel: string;
}) => {
  const text = copy[language];

  return (
    <section className="pb-2">
      <ScoreHistogramPanel ai={ai} displayUrl={displayUrl} theme={theme} language={language} />

      <div className="mt-2 flex items-center gap-1.5">
        <div className={`min-w-0 text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-100' : 'text-gray-900'}`}>
          <span>{text.aiPanelTitle}</span>
        </div>
      </div>

      <div className="mt-2.5 min-w-0 space-y-3">
        <AiDecisionSummaryCard ai={ai} theme={theme} language={language} />
        <AiInspectionSummary ai={ai} theme={theme} language={language} />
        <AiConfidenceStrip ai={ai} theme={theme} language={language} />
        <MetadataPanel
          group={group}
          theme={theme}
          language={language}
          reviewedLabel={reviewedLabel}
        />
      </div>
    </section>
  );
};

const AiEvidencePanel = ({
  ai,
  theme,
  language,
}: {
  ai?: AiAnalysis;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];
  const issues = ai?.issues ?? [];
  const hasDetails = Boolean(
    issues.length > 0 ||
    ai?.metrics ||
    (ai?.regions && ai.regions.length > 0) ||
    ai?.diagnostics ||
    ai?.error
  );

  return (
    <section className="space-y-3 pb-2">
      {!hasDetails && (
        <div className={`rounded-md p-2.5 text-[11px] font-bold ${theme === 'dark' ? 'bg-white/[0.035] text-zinc-500' : 'bg-slate-100/[0.56] text-slate-500'}`}>
          {text.detailsEmpty}
        </div>
      )}

      {ai && <EvidenceDecisionSummary ai={ai} theme={theme} language={language} />}

      {ai?.metrics && <MetricsGrid metrics={ai.metrics} theme={theme} language={language} />}

      {ai?.regions && ai.regions.length > 0 && <RegionList regions={ai.regions} theme={theme} language={language} />}

      {ai && <AiDiagnosticsPanel ai={ai} theme={theme} language={language} />}

      {ai?.error && (
        <div className={`rounded-md p-2 text-[11px] ${theme === 'dark' ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-100/50 text-amber-700'}`}>
          {ai.error}
        </div>
      )}

      {ai && (
        <EvidenceDetails summary={language === 'zh' ? '\u5206\u6790\u8bbe\u7f6e\u4e0e\u6a21\u578b' : 'Analysis settings and model'} theme={theme}>
          <EvidenceValueList
            items={[
              { label: text.preset, value: aiSensitivityLabel(ai.preset, language) },
              { label: text.confidence, value: formatConfidence(ai.confidence) },
              { label: text.aestheticScore, value: ai.photoScore?.aesthetic?.score !== undefined ? `${Math.round(ai.photoScore.aesthetic.score)}` : undefined },
              { label: text.aestheticModelStatus, value: formatAestheticModelStatus(ai.photoScore?.aesthetic, language) },
              { label: text.faceModelStatus, value: formatFaceModelStatus(ai.faceModelStatus, language) },
              { label: text.model, value: ai.modelVersion },
            ]}
            theme={theme}
          />
        </EvidenceDetails>
      )}
    </section>
  );
};

const AiDecisionSummaryCard = ({
  ai,
  theme,
  language,
}: {
  ai?: AiAnalysis;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];
  const issues = ai?.issues ?? [];
  const issueTotal = issues.length;
  const state = !ai
    ? 'waiting'
    : ai.status === 'ANALYZING'
      ? 'analyzing'
      : ai.status === 'ERROR'
        ? 'error'
        : issueTotal > 0
          ? 'review'
          : ai.status === 'DONE'
            ? 'clear'
            : 'waiting';
  const title = state === 'review'
    ? text.needsReview
    : state === 'clear'
      ? text.passedInitialScreen
      : state === 'analyzing'
        ? text.aiAnalyzing
        : state === 'error'
          ? text.aiError
          : text.noDecisionYet;
  const detail = state === 'review'
    ? text.reviewDecisionDetail
    : state === 'clear'
      ? text.clearDecisionDetail
      : state === 'analyzing'
        ? text.analyzingDecisionDetail
        : state === 'error'
          ? text.errorDecisionDetail
          : text.waitingDecisionDetail;
  const Icon = state === 'review'
    ? AlertTriangle
    : state === 'clear'
      ? CheckCircle2
      : state === 'analyzing'
        ? Clock3
        : state === 'error'
          ? CircleAlert
          : Clock3;
  const toneClass = state === 'review'
      ? theme === 'dark'
        ? 'bg-amber-300/[0.08] text-amber-200'
        : 'bg-amber-100/50 text-amber-800'
    : state === 'clear'
      ? theme === 'dark'
        ? 'bg-emerald-300/[0.07] text-emerald-200'
        : 'bg-emerald-100/48 text-emerald-800'
      : state === 'error'
        ? theme === 'dark'
          ? 'bg-rose-300/[0.08] text-rose-200'
          : 'bg-rose-100/50 text-rose-800'
        : theme === 'dark'
          ? 'bg-white/[0.035] text-zinc-300'
          : 'bg-slate-100/[0.58] text-slate-700';

  return (
    <div className={`min-w-0 flex-1 rounded-md p-2.5 ${toneClass}`}>
      <div className="flex items-start gap-2.5">
        <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[12px] ${
          theme === 'dark' ? 'bg-black/20' : 'bg-white/45'
        }`}>
          <AppIcon icon={Icon} className={`h-4 w-4 ${state === 'analyzing' ? 'animate-pulse' : ''}`} />
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">{title}</p>
          <p className={`mt-0.5 text-[11px] leading-snug ${
            theme === 'dark' ? 'text-zinc-300' : 'text-gray-600'
          }`}>
            {detail}
          </p>
        </div>
      </div>
    </div>
  );
};

const AiConfidenceStrip = ({
  ai,
  theme,
  language,
}: {
  ai?: AiAnalysis;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];
  const hasIssues = (ai?.issues.length ?? 0) > 0;
  const value = ai ? formatConfidence(ai.confidence) : text.pendingValue;
  const percent = ai ? Math.round(Math.max(0, Math.min(1, ai.confidence)) * 100) : 0;
  const filledSegments = ai ? Math.max(1, Math.ceil((percent / 100) * 6)) : 0;
  const barTone = hasIssues
    ? theme === 'dark' ? 'bg-amber-300' : 'bg-amber-500'
    : ai?.status === 'DONE'
      ? theme === 'dark' ? 'bg-emerald-400' : 'bg-emerald-600'
      : theme === 'dark' ? 'bg-zinc-600' : 'bg-slate-400';
  const filledGlow = hasIssues
    ? theme === 'dark'
      ? 'shadow-[0_0_8px_rgba(252,211,77,0.26)]'
      : 'shadow-[0_0_7px_rgba(245,158,11,0.18)]'
    : ai?.status === 'DONE'
      ? theme === 'dark'
        ? 'shadow-[0_0_8px_rgba(52,211,153,0.22)]'
        : 'shadow-[0_0_7px_rgba(5,150,105,0.14)]'
      : '';

  return (
    <div className="pt-1">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className={`truncate text-[10px] font-semibold uppercase tracking-[0.08em] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {text.issueConfidence}
        </span>
        <span className={`shrink-0 text-[11px] font-semibold tabular-nums ${
          hasIssues
            ? theme === 'dark' ? 'text-amber-100' : 'text-amber-800'
            : ai?.status === 'DONE'
              ? theme === 'dark' ? 'text-emerald-100' : 'text-emerald-800'
              : theme === 'dark' ? 'text-zinc-400' : 'text-slate-500'
        }`}>
          {value}
        </span>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {Array.from({ length: 6 }, (_, index) => (
          <span
            key={index}
            className={`h-2 rounded-full transition-colors duration-300 ${
              index < filledSegments
                ? `${barTone} ${filledGlow}`
                : theme === 'dark' ? 'bg-white/[0.07]' : 'bg-slate-300/55'
            }`}
          />
        ))}
      </div>
    </div>
  );
};

const AiInspectionSummary = ({
  ai,
  theme,
  language,
}: {
  ai?: AiAnalysis;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];
  const issues = ai?.issues ?? [];
  const metrics = ai?.metrics;
  const diagnostics = ai?.diagnostics;
  const closedEyesIssue = issues.find(issue => issue.code === 'EYES_CLOSED');
  const focusIssue = issues.find(issue => issue.code === 'OUT_OF_FOCUS');
  const underIssue = issues.find(issue => issue.code === 'UNDER_EXPOSED');
  const overIssue = issues.find(issue => issue.code === 'OVER_EXPOSED');
  const hasExposureReview = Boolean(underIssue || overIssue);
  const hasRegions = (ai?.regions?.length ?? 0) > 0;
  const diagnosticsReady = Boolean(
    diagnostics?.focusMode ||
    diagnostics?.focusReliable !== undefined ||
    diagnostics?.faceDetectorStatus ||
    diagnostics?.landmarkerSuccessCount ||
    diagnostics?.faceDiagnostics?.length ||
    ai?.faceModelStatus
  );
  const isGroupPortrait = diagnostics?.photoKind === 'GROUP_PORTRAIT';
  const groupFaceCount = metrics?.groupFaceCount ?? diagnostics?.groupFaceIndices?.length ?? 0;
  const groupClosedCount = metrics?.groupEyeClosedFaceCount ?? 0;

  const primarySubjectsSummary = isGroupPortrait
    ? null
    : buildSummaryCheck({
      label: text.primarySubjects,
      status: (diagnostics?.primarySubjectCount ?? metrics?.primarySubjectCount ?? 0) > 0
        ? (diagnostics?.subjectConfidence === 'LOW' ? 'muted' : 'good')
        : ai?.status === 'DONE'
          ? 'muted'
          : 'pending',
      value: ai?.status === 'DONE'
        ? String(diagnostics?.primarySubjectCount ?? metrics?.primarySubjectCount ?? 0)
        : text.pendingValue,
      detail: diagnostics?.subjectDecision || (
        diagnostics?.subjectConfidence
          ? `${text.subjectConfidence} ${formatSubjectConfidence(diagnostics.subjectConfidence, language)}`
          : undefined
      ),
      icon: UsersRound,
    });

  const summaryItems = [
    buildSummaryCheck({
      label: text.photoKind,
      status: ai?.status === 'DONE'
        ? isGroupPortrait ? 'warning' : 'good'
        : ai?.status === 'ANALYZING'
          ? 'pending'
          : 'pending',
      value: ai?.status === 'DONE'
        ? isGroupPortrait ? text.groupPortrait : text.standardPhoto
        : ai?.status === 'ANALYZING'
          ? text.analyzingValue
          : text.pendingValue,
      detail: isGroupPortrait
        ? `${text.groupFaces} ${groupFaceCount}${groupClosedCount > 0 ? ` / ${text.groupClosedFaces} ${groupClosedCount}` : ''}`
        : diagnostics?.groupPortraitReason,
      icon: UsersRound,
    }),
    primarySubjectsSummary,
    buildSummaryCheck({
      label: text.faceFocusCheck,
      status: focusIssue
        ? 'warning'
        : ai?.status === 'ANALYZING'
          ? 'pending'
          : metrics?.focusReliable === false
            ? 'muted'
            : ai?.status === 'DONE'
              ? 'good'
              : 'pending',
      value: focusIssue
        ? issueSummaryValue(focusIssue)
        : ai?.status === 'ANALYZING'
          ? text.analyzingValue
          : metrics?.focusReliable === false
            ? text.skippedValue
            : ai?.status === 'DONE'
              ? text.goodValue
              : text.pendingValue,
      detail: focusIssue
        ? issueScoreDetail(focusIssue, language)
        : metrics?.focusReliable === false
          ? `${text.focusMode} ${formatFocusMode(metrics.focusMode, language) || text.skippedValue}`
          : metrics?.focusTextureScore !== undefined
            ? `${text.focusTexture} ${formatMetric(metrics.focusTextureScore)}`
            : undefined,
      icon: Focus,
    }),
    buildSummaryCheck({
      label: text.closedEyesCheck,
      status: closedEyesIssue ? 'warning' : ai?.status === 'DONE' ? 'good' : 'pending',
      value: closedEyesIssue
        ? issueSummaryValue(closedEyesIssue)
        : ai?.status === 'DONE'
          ? text.noValue
          : text.pendingValue,
      detail: closedEyesIssue
        ? issueScoreDetail(closedEyesIssue, language)
        : metrics?.eyeClosedFaceCount
          ? `${text.closedFaces} ${metrics.eyeClosedFaceCount}`
          : metrics?.eyeReviewFaceCount
            ? `${text.reviewFaces} ${metrics.eyeReviewFaceCount}`
            : undefined,
      icon: EyeOff,
    }),
    buildSummaryCheck({
      label: text.exposureCheck,
      status: hasExposureReview ? 'warning' : ai?.status === 'DONE' ? 'good' : 'pending',
      value: hasExposureReview
        ? exposureSummaryValue({ underIssue, overIssue, language })
        : ai?.status === 'DONE'
          ? text.goodValue
          : text.pendingValue,
      detail: hasExposureReview
        ? issueScoreDetail((overIssue || underIssue)!, language)
        : metrics?.subjectExposureScore !== undefined
          ? `${text.subjectExposure} ${formatConfidence(metrics.subjectExposureScore)}`
          : undefined,
      icon: SunMedium,
    }),
    buildSummaryCheck({
      label: text.highlightClipping,
      status: isClippingWarning(metrics?.highlightClipRatio) ? 'warning' : ai?.status === 'DONE' ? 'good' : 'pending',
      value: metrics?.highlightClipRatio !== undefined
        ? formatConfidence(metrics.highlightClipRatio)
        : ai?.status === 'DONE'
          ? text.noValue
          : text.pendingValue,
      detail: metrics?.subjectHighlightClipRatio !== undefined
        ? `${text.subjectHighlightClip} ${formatConfidence(metrics.subjectHighlightClipRatio)}`
        : undefined,
      icon: SunMedium,
    }),
    buildSummaryCheck({
      label: text.shadowClipping,
      status: isClippingWarning(metrics?.darkClipRatio) || Boolean(underIssue) ? 'warning' : ai?.status === 'DONE' ? 'good' : 'pending',
      value: metrics?.darkClipRatio !== undefined
        ? formatConfidence(metrics.darkClipRatio)
        : ai?.status === 'DONE'
          ? text.noValue
          : text.pendingValue,
      detail: metrics?.subjectDarkClipRatio !== undefined
        ? `${text.subjectDarkClip} ${formatConfidence(metrics.subjectDarkClipRatio)}`
        : undefined,
      icon: CircleAlert,
    }),
    buildSummaryCheck({
      label: text.regionsSummary,
      status: hasRegions ? 'good' : ai?.status === 'DONE' ? 'muted' : 'pending',
      value: hasRegions
        ? `${ai?.regions?.length} ${text.regionUnit}`
        : ai?.status === 'DONE'
          ? text.noRegions
          : text.pendingValue,
      detail: hasRegions
        ? summarizeRegionLabels(ai?.regions ?? [], language)
        : undefined,
      icon: ScanSearch,
    }),
    buildSummaryCheck({
      label: text.diagnosticsSummary,
      status: diagnosticsReady ? 'good' : ai?.status === 'DONE' ? 'muted' : 'pending',
      value: diagnosticsReady
        ? diagnosticsValue(ai, language)
        : ai?.status === 'DONE'
          ? text.limitedValue
          : text.pendingValue,
      detail: diagnosticsDetail(ai, language),
      icon: Gauge,
    }),
  ].filter((item): item is SummaryCheckItem => Boolean(item));

  return (
    <div className="space-y-2.5">
      <div>
        <p className={`text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {text.summaryChecks}
        </p>
      </div>
      <div className="space-y-1">
        {summaryItems.map(item => (
          <SummaryCheckRow
            key={item.label}
            item={item}
            theme={theme}
          />
        ))}
      </div>
    </div>
  );
};

type SummaryStatus = 'good' | 'warning' | 'pending' | 'muted';

type SummaryCheckItem = {
  label: string;
  value: string;
  icon: LucideIcon;
  status: SummaryStatus;
  detail?: string;
};

const SummaryCheckRow = ({
  item,
  theme,
}: {
  item: SummaryCheckItem;
  theme: 'light' | 'dark';
}) => {
  const colors = summaryStatusClasses(item.status, theme);
  const rowSurface = theme === 'dark'
    ? 'hover:bg-white/[0.045] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)]'
    : 'hover:bg-white/42 hover:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.08)]';

  return (
    <div className={`group rounded-lg px-1.5 py-1.5 transition-[background-color,box-shadow] duration-150 ${rowSurface}`}>
      <div className="flex min-w-0 items-start gap-2">
        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          <AppIcon icon={item.icon} className="h-3.5 w-3.5" />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[11px] font-medium ${theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}`}>
          {item.label}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={`${colors.icon}`}>
            <AppIcon icon={colors.iconGlyph} className="h-3.5 w-3.5" />
          </span>
          <span className={`text-[11px] font-semibold ${colors.value}`}>
            {item.value}
          </span>
        </span>
      </div>
      {item.detail && (
        <div
          className={`ml-[26px] max-h-0 overflow-hidden text-[10.5px] font-medium opacity-0 transition-[max-height,opacity,margin-top] duration-150 group-hover:mt-0.5 group-hover:max-h-7 group-hover:opacity-100 ${
            theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'
          }`}
          title={item.detail}
        >
          <span className="block truncate">{item.detail}</span>
        </div>
      )}
    </div>
  );
};

function buildSummaryCheck(item: SummaryCheckItem) {
  return item;
}

function summaryStatusClasses(status: SummaryStatus, theme: 'light' | 'dark') {
  if (status === 'good') {
    return theme === 'dark'
      ? {
          dot: 'bg-emerald-400',
          value: 'text-emerald-100',
          icon: 'text-emerald-300',
          iconGlyph: CheckCircle2,
        }
      : {
          dot: 'bg-emerald-600',
          value: 'text-emerald-800',
          icon: 'text-emerald-600',
          iconGlyph: CheckCircle2,
        };
  }

  if (status === 'warning') {
    return theme === 'dark'
      ? {
          dot: 'bg-amber-300',
          value: 'text-amber-100',
          icon: 'text-amber-300',
          iconGlyph: AlertTriangle,
        }
      : {
          dot: 'bg-amber-500',
          value: 'text-amber-800',
          icon: 'text-amber-600',
          iconGlyph: AlertTriangle,
        };
  }

  if (status === 'pending') {
    return theme === 'dark'
      ? {
          dot: 'bg-zinc-600',
          value: 'text-zinc-300',
          icon: 'text-zinc-500',
          iconGlyph: Clock3,
        }
      : {
          dot: 'bg-slate-400',
          value: 'text-slate-600',
          icon: 'text-slate-400',
          iconGlyph: Clock3,
        };
  }

  return theme === 'dark'
    ? {
        dot: 'bg-zinc-700',
        value: 'text-zinc-400',
        icon: 'text-zinc-600',
        iconGlyph: Circle,
      }
    : {
        dot: 'bg-slate-300',
        value: 'text-slate-500',
        icon: 'text-slate-400',
        iconGlyph: Circle,
      };
}

function issueSummaryValue(issue: { confidence: number }) {
  return formatConfidence(issue.confidence);
}

function issueScoreDetail(issue: { score: number; threshold: number }, language: Language) {
  return language === 'zh'
    ? `閸掑棙鏆?${formatMetric(issue.score)} / 闂冨牆鈧?${formatMetric(issue.threshold)}`
    : `Score ${formatMetric(issue.score)} / threshold ${formatMetric(issue.threshold)}`;
}

function exposureSummaryValue({
  underIssue,
  overIssue,
  language,
}: {
  underIssue?: { code: AiIssueCode; level: 'ISSUE' | 'REVIEW_HINT'; confidence: number };
  overIssue?: { code: AiIssueCode; level: 'ISSUE' | 'REVIEW_HINT'; confidence: number };
  language: Language;
}) {
  const issue = overIssue || underIssue;
  if (!issue) return language === 'zh' ? '\u6b63\u5e38' : 'Good';
  return `${aiIssueLabel(issue.code, language, issue.level)} ${formatConfidence(issue.confidence)}`;
}

function isClippingWarning(value: number | undefined) {
  return typeof value === 'number' && value >= 0.05;
}

function summarizeRegionLabels(regions: AiRegion[], language: Language) {
  if (regions.length === 0) return undefined;
  const firstTwo = regions.slice(0, 2).map(region => {
    if (region.label) return region.label;
    if (region.source === 'face') return copy[language].faceRegion;
    if (region.source === 'detector') return copy[language].detectorRegion;
    return copy[language].centerRegion;
  });
  return firstTwo.join(' / ');
}

function diagnosticsValue(ai: AiAnalysis | undefined, language: Language) {
  const text = copy[language];
  const diagnostics = ai?.diagnostics;
  const focusReliable = diagnostics?.focusReliable ?? ai?.metrics?.focusReliable;
  if (focusReliable === false) return text.limitedValue;
  if (diagnostics?.faceDetectorStatus) return formatFaceModelStatus(diagnostics.faceDetectorStatus, language);
  if (ai?.faceModelStatus) return formatFaceModelStatus(ai.faceModelStatus, language);
  return text.goodValue;
}

function diagnosticsDetail(ai: AiAnalysis | undefined, language: Language) {
  const diagnostics = ai?.diagnostics;
  const mode = formatFocusMode(diagnostics?.focusMode || ai?.metrics?.focusMode, language);
  const modelStatus = ai?.faceModelStatus ? formatFaceModelStatus(ai.faceModelStatus, language) : undefined;
  if (mode && diagnostics?.landmarkerSuccessCount !== undefined) {
    return `${mode} / ${copy[language].landmarkerSuccess} ${diagnostics.landmarkerSuccessCount}`;
  }
  if (mode) return mode;
  if (diagnostics?.focusSkipReason) return diagnostics.focusSkipReason;
  if (diagnostics?.faceDetectorError) return diagnostics.faceDetectorError;
  if (modelStatus && ai?.modelVersion) return `${copy[language].faceModelStatus} ${modelStatus} / ${ai.modelVersion}`;
  if (modelStatus) return `${copy[language].faceModelStatus} ${modelStatus}`;
  return undefined;
}

const ViewModeToggle = ({
  mode,
  theme,
  language,
  shortcut,
  onChange,
}: {
  mode: ViewerAiMode;
  theme: 'light' | 'dark';
  language: Language;
  shortcut: string;
  onChange: (mode: ViewerAiMode) => void;
}) => {
  const text = copy[language];
  const isAiMode = mode === 'AI';
  const nextMode: ViewerAiMode = isAiMode ? 'ORIGINAL' : 'AI';
  const tooltip = `${text.toggleViewMode} (${shortcut})`;

  return (
    <button
      type="button"
      onClick={() => onChange(nextMode)}
      aria-label={tooltip}
      aria-pressed={isAiMode}
      className={`absolute bottom-4 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-lg border transition-all duration-200 ${
        theme === 'dark'
          ? `${photoOverlay.dark} text-zinc-300 hover:bg-[#22252a]/[0.88] hover:text-white ${isAiMode ? 'border-cyan-300/16' : 'border-white/[0.05]'}`
          : `${photoOverlay.light} text-slate-700 hover:bg-slate-100/[0.88] hover:text-slate-950 ${isAiMode ? 'border-cyan-500/22' : 'border-slate-400/32'}`
      }`}
      onMouseDown={event => event.stopPropagation()}
      title={tooltip}
    >
      {isAiMode ? <AiViewGlyph theme={theme} /> : <OriginalViewGlyph theme={theme} />}
    </button>
  );
};

const MonitorToolbarButton = ({
  theme,
  active,
  title,
  onClick,
}: {
  theme: 'light' | 'dark';
  active: boolean;
  title: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    aria-pressed={active}
    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
      active
        ? theme === 'dark'
          ? 'bg-cyan-300/14 text-cyan-100'
          : 'bg-cyan-100 text-cyan-800'
        : theme === 'dark'
          ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
          : 'text-slate-600 hover:bg-white/65 hover:text-slate-900'
    }`}
  >
    <AppIcon icon={MonitorCog} className="h-3.5 w-3.5" />
  </button>
);

const MonitorPreviewPopover = ({
  theme,
  language,
  preview,
  autoExposureAdjustment,
  lutNotice,
  onClose,
}: {
  theme: 'light' | 'dark';
  language: Language;
  preview: NonNullable<ViewerProps['rawMonitorPreview']>;
  autoExposureAdjustment: AutoExposurePreviewAdjustment | null;
  lutNotice: string | null;
  onClose: () => void;
}) => {
  const fallbackLabels = {
    title: language === 'zh' ? '预览' : 'Preview',
    raw: language === 'zh' ? 'RAW 预览' : 'RAW preview',
    auto: language === 'zh' ? '自动调整' : 'Auto adjust',
    lut: 'LUT',
    chooseLut: language === 'zh' ? '选择 .cube' : 'Choose .cube',
    changeLut: language === 'zh' ? '更换 .cube' : 'Change .cube',
    removeLut: language === 'zh' ? '移除' : 'Remove',
    strength: language === 'zh' ? '强度' : 'Strength',
    checking: language === 'zh' ? '检查缓存' : 'Checking cache',
    missing: language === 'zh' ? '生成缓存后可用' : 'Generate cache first',
    cacheBalanced: language === 'zh' ? '普通缓存' : 'Balanced cache',
    cacheAuto: language === 'zh' ? '自动曝光预览' : 'Auto exposure preview',
    close: language === 'zh' ? '关闭面板' : 'Close panel',
    autoApplied: language === 'zh' ? '已应用预览' : 'Preview applied',
    autoPreparing: language === 'zh' ? '准备中' : 'Preparing',
    generateCache: language === 'zh' ? '生成缓存' : 'Generate cache',
    cacheNotReady: language === 'zh' ? '先生成 RAW 缓存后可开启' : 'Generate RAW cache first',
    autoCacheNotReady: language === 'zh' ? '先生成自动曝光缓存后可开启' : 'Generate auto exposure cache first',
    cacheReady: language === 'zh' ? '缓存已就绪' : 'Cache ready',
  };
  const labels = preview.labels ?? fallbackLabels;
  const chooseLabel = preview.lutPath ? labels.changeLut : labels.chooseLut;
  const cacheLabel = preview.autoExposureEnabled ? labels.cacheAuto : labels.cacheBalanced;
  const autoDetail = preview.autoExposureEnabled
    ? autoExposureAdjustment
      ? `${labels.autoApplied ?? fallbackLabels.autoApplied} · ${formatEv(autoExposureAdjustment.ev)}`
      : (labels.autoPreparing ?? fallbackLabels.autoPreparing)
    : cacheLabel;
  const lutStrength = preview.lutStrength ?? 1;
  const rawCacheReady = Boolean(preview.rawCacheReady);
  const autoExposureCacheReady = Boolean(preview.autoExposureCacheReady);
  const allPreviewCachesReady = rawCacheReady && autoExposureCacheReady;
  const progress = preview.progress;
  const progressPercent = progress?.total ? Math.round((progress.processed / progress.total) * 100) : 0;
  const cacheRunning = Boolean(progress?.running);
  const canGenerateCache = Boolean(preview.onGenerateCache || preview.onCancelCache);
  const activeCacheLabel = progress?.profileId === RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID ? labels.cacheAuto : labels.cacheBalanced;
  const showCacheProgress = Boolean(progress && progress.phase !== 'idle');
  const cacheTaskTitle = progress?.running
    ? (language === 'zh' ? `正在生成 ${activeCacheLabel}` : `Generating ${activeCacheLabel}`)
    : showCacheProgress
      ? formatRawMonitorCachePhase(progress?.phase, language)
      : allPreviewCachesReady
        ? (labels.cacheReady ?? fallbackLabels.cacheReady)
        : (language === 'zh' ? '预览缓存' : 'Preview cache');
  const generateCacheLabel = preview.labels?.generateCache ?? fallbackLabels.generateCache;
  const stopCacheLabel = preview.labels?.stopCache ?? (language === 'zh' ? '停止生成' : 'Stop');
  const cacheActionHint = preview.labels?.cacheActionHint ?? (
    language === 'zh'
      ? '同时生成 RAW 监看与自动曝光缓存。后台生成，不影响 JPG 筛片。'
      : 'Runs in background; JPG culling stays available'
  );
  const rawSwitchTooltip = rawCacheReady
    ? (language === 'zh' ? '启用已生成的 RAW 监看缓存' : 'Enable generated RAW monitor cache')
    : (labels.cacheNotReady ?? fallbackLabels.cacheNotReady);
  const autoSwitchTooltip = autoExposureCacheReady
    ? (preview.autoExposureEnabled ? autoDetail : (language === 'zh' ? '启用已生成的自动曝光缓存' : 'Enable generated auto exposure cache'))
    : (labels.autoCacheNotReady ?? fallbackLabels.autoCacheNotReady);

  return (
    <div
      className={`absolute bottom-16 left-4 z-40 w-[286px] rounded-lg border p-3 ${
        theme === 'dark'
          ? `${glassPopover.dark} text-zinc-200`
          : `${glassPopover.light} text-slate-800`
      }`}
      onMouseDown={event => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[12px] font-bold">{labels.title}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label={labels.close}
          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
            theme === 'dark' ? 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
          }`}
        >
          <AppIcon icon={X} className="h-3.5 w-3.5" />
        </button>
      </div>
      <MonitorToggleLine
        theme={theme}
        label={labels.raw}
        active={preview.enabled}
        disabled={!rawCacheReady}
        tooltip={rawSwitchTooltip}
        onClick={() => preview.onEnabledChange?.(!preview.enabled)}
      />
      <MonitorToggleLine
        theme={theme}
        label={labels.auto}
        active={Boolean(preview.autoExposureEnabled)}
        disabled={!autoExposureCacheReady}
        tooltip={autoSwitchTooltip}
        onClick={() => preview.onAutoExposureChange?.(!preview.autoExposureEnabled)}
      />
      {preview.autoExposureEnabled && autoExposureAdjustment && (
        <div
          title={`P50 ${Math.round(autoExposureAdjustment.stats.p50Luma * 100)}% · P98 ${Math.round(autoExposureAdjustment.stats.p98Luma * 100)}%`}
          className={`mb-2 flex items-center justify-between gap-2 px-2 text-[10px] font-semibold ${
            theme === 'dark' ? 'text-cyan-100/75' : 'text-cyan-800'
          }`}
        >
          <span>{formatEv(autoExposureAdjustment.ev)}</span>
          <span>{autoExposureAdjustment.confidence}</span>
        </div>
      )}
      {canGenerateCache && (
        <div
          title={cacheRunning ? (progress?.current || cacheTaskTitle) : cacheActionHint}
          className="mb-2 px-2 py-1.5"
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className={`truncate text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}`}>
                {cacheTaskTitle}
              </div>
              {showCacheProgress && progress?.current && (
                <div className={`mt-0.5 truncate text-[10px] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
                  {progress.current}
                </div>
              )}
            </div>
            {cacheRunning ? (
              <button
                type="button"
                title={stopCacheLabel}
                onClick={() => { void preview.onCancelCache?.(); }}
                className={`flex h-7 min-w-[58px] shrink-0 items-center justify-center gap-1 rounded-md px-2 text-[10px] font-bold transition-colors ${
                  theme === 'dark'
                    ? 'bg-rose-400/12 text-rose-100 hover:bg-rose-400/18'
                    : 'bg-rose-50 text-rose-700 hover:bg-rose-100'
                }`}
              >
                <AppIcon icon={X} className="h-3.5 w-3.5" />
                <span>{stopCacheLabel}</span>
              </button>
            ) : (
              <button
                type="button"
                title={cacheActionHint}
                onClick={() => { void preview.onGenerateCache?.(); }}
                className={`flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2.5 text-[10px] font-bold transition-colors ${
                  theme === 'dark'
                    ? 'bg-cyan-300/14 text-cyan-100 hover:bg-cyan-300/20'
                    : 'bg-cyan-100 text-cyan-800 hover:bg-cyan-200'
                }`}
              >
                <AppIcon icon={HardDrive} className="h-3.5 w-3.5" />
                <span>{generateCacheLabel}</span>
              </button>
            )}
          </div>
          {showCacheProgress && progress && (
            <>
              <div className="mt-2 flex items-center justify-between gap-2 text-[10px] font-semibold">
                <span className={theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}>
                  {progress.processed}/{progress.total}
                </span>
                <span className={theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}>
                  {progressPercent}%
                </span>
              </div>
              <div className={`mt-1 h-1.5 overflow-hidden rounded-full ${theme === 'dark' ? 'bg-white/[0.08]' : 'bg-slate-300/60'}`}>
                <div
                  className="h-full rounded-full bg-cyan-500 transition-[width] duration-200"
                  style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                />
              </div>
            </>
          )}
        </div>
      )}
      <MonitorToggleLine
        theme={theme}
        label={labels.lut}
        active={Boolean(preview.lutEnabled)}
        detail={preview.lutName || lutNotice || undefined}
        onClick={() => {
          if (!preview.lutEnabled && !preview.lutPath) void preview.onChooseLut?.();
          else preview.onLutEnabledChange?.(!preview.lutEnabled);
        }}
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => { void preview.onChooseLut?.(); }}
          className={`h-8 rounded-md text-[11px] font-semibold transition-colors ${
            theme === 'dark' ? 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.10]' : 'bg-white/75 text-slate-700 hover:bg-white'
          }`}
        >
          {chooseLabel}
        </button>
        <button
          type="button"
          disabled={!preview.lutPath}
          onClick={() => preview.onRemoveLut?.()}
          className={`h-8 rounded-md text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            theme === 'dark' ? 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.10]' : 'bg-white/75 text-slate-700 hover:bg-white'
          }`}
        >
          {labels.removeLut}
        </button>
      </div>
      <label className={`mt-2 block text-[10px] font-semibold ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
        {labels.strength} · {Math.round(lutStrength * 100)}%
      </label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={lutStrength}
        onChange={event => preview.onLutStrengthChange?.(Number(event.currentTarget.value))}
        className={`export-quality-slider mt-1 w-full ${theme}`}
        style={{ '--quality': `${Math.round(lutStrength * 100)}%` } as React.CSSProperties}
        disabled={!preview.lutPath}
      />
    </div>
  );
};

const MonitorToggleLine = ({
  theme,
  label,
  active,
  disabled = false,
  detail,
  tooltip,
  onClick,
}: {
  theme: 'light' | 'dark';
  label: string;
  active: boolean;
  disabled?: boolean;
  detail?: string;
  tooltip?: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={active}
    disabled={disabled}
    title={tooltip ?? detail ?? label}
    onClick={onClick}
    className={`mb-1.5 flex h-9 w-full items-center justify-between rounded-md px-2 text-left transition-colors ${
      disabled
        ? 'cursor-not-allowed opacity-45'
        : theme === 'dark' ? 'hover:bg-white/[0.055]' : 'hover:bg-white/70'
    }`}
  >
    <span className="min-w-0">
      <span className="block text-[11px] font-semibold">{label}</span>
      {detail && (
        <span className={`block truncate text-[9.5px] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {detail}
        </span>
      )}
    </span>
    <span className={`ml-2 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors ${
      active
        ? theme === 'dark' ? 'bg-cyan-300/72' : 'bg-cyan-600/80'
        : disabled
          ? theme === 'dark' ? 'bg-white/[0.06]' : 'bg-slate-200'
          : theme === 'dark' ? 'bg-white/[0.12]' : 'bg-slate-300'
    }`}>
      <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${active ? 'translate-x-3' : 'translate-x-0'}`} />
    </span>
  </button>
);

function formatEv(ev: number) {
  if (!Number.isFinite(ev) || Math.abs(ev) < 0.005) return '+0.00 EV';
  return `${ev > 0 ? '+' : ''}${ev.toFixed(2)} EV`;
}

function formatRawMonitorCachePhase(
  phase: RawMonitorCacheProgress['phase'] | undefined,
  language: Language,
) {
  if (language === 'en') {
    if (phase === 'checking') return 'Checking cache';
    if (phase === 'rendering') return 'Generating cache';
    if (phase === 'done') return 'Cache ready';
    if (phase === 'error') return 'Cache failed';
    if (phase === 'cancelled') return 'Cancelled';
    return 'Preview cache';
  }
  if (phase === 'checking') return '检查缓存';
  if (phase === 'rendering') return '正在生成缓存';
  if (phase === 'done') return '缓存已就绪';
  if (phase === 'error') return '生成失败';
  if (phase === 'cancelled') return '已取消';
  return '预览缓存';
}

const AiViewGlyph = ({ theme }: { theme: 'light' | 'dark' }) => (
  <span
    className={`relative flex h-5 w-5 items-center justify-center rounded-md font-bold leading-none ${
      theme === 'dark'
        ? 'text-cyan-100 shadow-[0_0_12px_rgba(103,232,249,0.18)]'
        : 'text-cyan-800 shadow-[0_0_10px_rgba(8,145,178,0.10)]'
    }`}
  >
    <span className="text-[11px]">AI</span>
    <span className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${
      theme === 'dark' ? 'bg-cyan-200' : 'bg-cyan-600'
    }`} />
  </span>
);

const OriginalViewGlyph = ({ theme }: { theme: 'light' | 'dark' }) => (
  <span
    className={`relative flex h-5 w-5 items-center justify-center rounded-md ${
      theme === 'dark'
        ? 'text-zinc-100 shadow-[0_0_10px_rgba(255,255,255,0.08)]'
        : 'text-slate-700'
    }`}
  >
    <i className="fa-regular fa-image text-[13px]"></i>
    <span
      className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${
        theme === 'dark' ? 'bg-white/80' : 'bg-slate-500/80'
      }`}
    />
  </span>
);

const ImageWithAiRegions = ({
  src,
  alt,
  imageReady,
  ai,
  theme,
  language,
  showAiRegions,
  lut,
  lutStrength = 1,
  autoExposureEnabled = false,
  autoExposureAdjustment,
  onAutoExposureComputed,
  onImageError,
}: {
  src: string;
  alt: string;
  imageReady: boolean;
  ai?: AiAnalysis;
  theme: 'light' | 'dark';
  language: Language;
  showAiRegions: boolean;
  lut?: CubeLut3D | null;
  lutStrength?: number;
  autoExposureEnabled?: boolean;
  autoExposureAdjustment?: AutoExposurePreviewAdjustment | null;
  onAutoExposureComputed?: (adjustment: AutoExposurePreviewAdjustment | null) => void;
  onImageError?: () => void;
}) => {
  const [paintedSrc, setPaintedSrc] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const imagePainted = paintedSrc === src;
  const autoExposureFilter = autoExposureEnabled
    ? buildAutoExposureCssFilter(autoExposureAdjustment ?? null)
    : undefined;
  const regions = showAiRegions && imagePainted
    ? (ai?.regions ?? []).filter(region => {
        if (region.source !== 'detector') return false;
        const subjectRole = roleFromRegionLabel(region.label);
        return subjectRole === 'PRIMARY' ||
          subjectRole === 'SECONDARY' ||
          isGroupFaceRegion(region.label) ||
          eyeStateFromRegionLabel(region.label) !== null;
      })
    : [];

  useEffect(() => {
    setPaintedSrc(null);
  }, [src]);

  useEffect(() => {
    if (!autoExposureEnabled || !imagePainted || !imageRef.current) {
      if (!autoExposureEnabled) onAutoExposureComputed?.(null);
      return;
    }

    let cancelled = false;
    void computeAutoExposurePreviewFromImage(imageRef.current)
      .then(adjustment => {
        if (!cancelled) onAutoExposureComputed?.(adjustment);
      })
      .catch(error => {
        console.warn('Failed to compute auto exposure preview:', error);
        if (!cancelled) onAutoExposureComputed?.(null);
      });

    return () => {
      cancelled = true;
    };
  }, [autoExposureEnabled, imagePainted, onAutoExposureComputed, src]);

  return (
    <div className="relative inline-block max-w-full max-h-[calc(100vh-6.5rem)]">
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => setPaintedSrc(src)}
        onError={onImageError}
        className={`${previewImageClassName} ${imageReady ? 'opacity-100' : 'opacity-0'}`}
        style={autoExposureFilter ? { filter: autoExposureFilter } : undefined}
      />
      {lut && imagePainted && imageRef.current && (
        <LutPreviewCanvas
          sourceImage={imageRef.current}
          renderKey={paintedSrc}
          lut={lut}
          strength={lutStrength}
          cssFilter={autoExposureFilter}
        />
      )}
      {regions.map((region, index) => {
        const subjectRole = roleFromRegionLabel(region.label);
        const eyeState = eyeStateFromRegionLabel(region.label);
        const eyeTone = eyeState ? eyeRegionTone(eyeState, theme) : null;
        const roleTone = subjectRole ? subjectRoleTone(subjectRole, theme) : undefined;
        const frameClass = eyeTone
          ? eyeTone.frame
          : isGroupFaceRegion(region.label)
            ? groupFaceTone(theme)
            : roleTone?.frame ?? (
              theme === 'dark'
                ? 'border border-zinc-200/24 shadow-[0_0_0_1px_rgba(0,0,0,0.22)]'
                : 'border border-slate-700/28 shadow-[0_0_0_1px_rgba(255,255,255,0.3)]'
            );
        const eyeLabel = eyeState
          ? eyeRegionLabel(eyeState, language)
          : null;
        return (
          <div
            key={`${region.source}-${index}`}
            className={`absolute rounded-sm pointer-events-none ${frameClass}`}
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.width * 100}%`,
              height: `${region.height * 100}%`,
            }}
          >
            {eyeLabel && eyeTone && (
              <span className={`absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${eyeTone.label}`}>
                {eyeLabel}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};

const LutPreviewCanvas = ({
  sourceImage,
  renderKey,
  lut,
  strength,
  cssFilter,
}: {
  sourceImage: HTMLImageElement;
  renderKey: string;
  lut: CubeLut3D;
  strength: number;
  cssFilter?: string;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setReady(false);
    try {
      renderLutToCanvas(canvas, sourceImage, lut, strength);
      setReady(true);
    } catch (error) {
      console.warn('Failed to render LUT preview:', error);
      setReady(false);
    }
  }, [lut, renderKey, sourceImage, strength]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 h-full w-full rounded-sm transition-opacity duration-150 ${ready ? 'opacity-100' : 'opacity-0'}`}
      style={cssFilter ? { filter: cssFilter } : undefined}
      aria-hidden="true"
    />
  );
};

function renderLutToCanvas(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  lut: CubeLut3D,
  strength: number,
) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width <= 0 || height <= 0) throw new Error('Image is not ready');

  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 is not available');

  const program = createLutProgram(gl);
  const positionBuffer = gl.createBuffer();
  const imageTexture = gl.createTexture();
  const lutTexture = gl.createTexture();
  const vao = gl.createVertexArray();
  if (!positionBuffer || !imageTexture || !lutTexture || !vao) {
    throw new Error('Failed to initialize WebGL resources');
  }

  gl.viewport(0, 0, width, height);
  gl.useProgram(program);
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      1, 1, 1, 0,
    ]),
    gl.STATIC_DRAW,
  );

  const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(texCoordLocation);
  gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, imageTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTexture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA,
    lut.size,
    lut.size,
    lut.size,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    cubeLutToRgbaBytes(lut),
  );

  gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_lut'), 1);
  gl.uniform1f(gl.getUniformLocation(program, 'u_size'), lut.size);
  gl.uniform1f(gl.getUniformLocation(program, 'u_strength'), Math.max(0, Math.min(1, strength)));
  gl.uniform3fv(gl.getUniformLocation(program, 'u_domainMin'), lut.domainMin);
  gl.uniform3fv(gl.getUniformLocation(program, 'u_domainMax'), lut.domainMax);

  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.flush();

  gl.deleteTexture(imageTexture);
  gl.deleteTexture(lutTexture);
  gl.deleteBuffer(positionBuffer);
  gl.deleteVertexArray(vao);
  gl.deleteProgram(program);
}

function createLutProgram(gl: WebGL2RenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_texCoord;
uniform sampler2D u_image;
uniform sampler3D u_lut;
uniform float u_size;
uniform float u_strength;
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;
out vec4 outColor;
void main() {
  vec4 source = texture(u_image, v_texCoord);
  vec3 normalized = clamp((source.rgb - u_domainMin) / max(u_domainMax - u_domainMin, vec3(0.0001)), 0.0, 1.0);
  vec3 coord = (normalized * (u_size - 1.0) + 0.5) / u_size;
  vec3 graded = texture(u_lut, coord).rgb;
  outColor = vec4(mix(source.rgb, graded, u_strength), source.a);
}`);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program');
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Failed to link LUT shader';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Failed to compile LUT shader';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function cubeLutToRgbaBytes(lut: CubeLut3D) {
  const voxelCount = lut.size * lut.size * lut.size;
  const output = new Uint8Array(voxelCount * 4);
  for (let index = 0; index < voxelCount; index += 1) {
    output[index * 4] = floatToByte(lut.data[index * 3]);
    output[index * 4 + 1] = floatToByte(lut.data[index * 3 + 1]);
    output[index * 4 + 2] = floatToByte(lut.data[index * 3 + 2]);
    output[index * 4 + 3] = 255;
  }
  return output;
}

function floatToByte(value: number | undefined) {
  return Math.round(Math.max(0, Math.min(1, value ?? 0)) * 255);
}

type EvidenceValue = {
  label: string;
  value?: string | number;
  ratio?: boolean;
};

const EvidenceDecisionSummary = ({
  ai,
  theme,
  language,
}: {
  ai: AiAnalysis;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];
  const issues = ai.issues ?? [];
  const status: SummaryStatus = ai.status === 'ERROR'
    ? 'warning'
    : issues.length > 0
      ? 'warning'
      : ai.status === 'DONE'
        ? 'good'
        : ai.status === 'ANALYZING'
          ? 'pending'
          : 'muted';
  const colors = summaryStatusClasses(status, theme);
  const title = ai.status === 'ERROR'
    ? text.aiError
    : issues.length > 0
      ? text.needsReview
      : ai.status === 'DONE'
        ? text.passedInitialScreen
        : ai.status === 'ANALYZING'
          ? text.aiAnalyzing
          : text.aiWaiting;
  const detail = ai.status === 'ERROR'
    ? (ai.error || text.errorDecisionDetail)
    : issues.length > 0
      ? text.reviewDecisionDetail
      : ai.status === 'DONE'
        ? text.clearDecisionDetail
        : ai.status === 'ANALYZING'
          ? text.analyzingDecisionDetail
          : text.waitingDecisionDetail;

  return (
    <div className={`rounded-xl px-3 py-2.5 ${
      theme === 'dark' ? 'bg-white/[0.035]' : 'bg-slate-100/62'
    }`}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-0.5 shrink-0 ${colors.icon}`}>
          <AppIcon icon={colors.iconGlyph} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className={`min-w-0 truncate text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-900'}`}>
              {title}
            </p>
            <span className={`shrink-0 font-mono text-[11px] font-semibold tabular-nums ${colors.value}`}>
              {formatConfidence(ai.confidence)}
            </span>
          </div>
          <p className={`mt-1 line-clamp-2 text-[10.5px] leading-snug ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
            {detail}
          </p>
        </div>
      </div>

      {issues.length > 0 && (
        <div className={`mt-2.5 space-y-1.5 border-t pt-2 ${
          theme === 'dark' ? 'border-white/[0.05]' : 'border-slate-300/70'
        }`}>
          {issues.map(issue => (
            <div
              key={`${issue.code}-${issue.level}`}
              className="flex min-w-0 items-center justify-between gap-2"
              title={issueScoreDetail(issue, language)}
            >
              <span className={`min-w-0 truncate text-[11px] font-semibold ${theme === 'dark' ? 'text-amber-200' : 'text-amber-800'}`}>
                <i className={`fa-solid ${aiIssueIcon(issue.code)} mr-1.5 text-[10px]`}></i>
                {aiIssueLabel(issue.code, language, issue.level)}
              </span>
              <span className={`shrink-0 font-mono text-[10.5px] font-semibold ${theme === 'dark' ? 'text-amber-100' : 'text-amber-800'}`}>
                {formatConfidence(issue.confidence)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const MetricsGrid = ({ metrics, theme, language }: { metrics: AiMetrics; theme: 'light' | 'dark'; language: Language }) => {
  const text = copy[language];
  const primaryItems: EvidenceValue[] = [
    { label: text.faceCount, value: metrics.faceCount },
    { label: text.focusTexture, value: metrics.focusTextureScore },
    { label: text.subjectLuma, value: metrics.subjectMeanLuma },
    { label: text.subjectExposure, value: metrics.subjectExposureScore, ratio: true },
    { label: text.subjectDarkClip, value: metrics.subjectDarkClipRatio, ratio: true },
    { label: text.subjectHighlightClip, value: metrics.subjectHighlightClipRatio, ratio: true },
  ];
  const advancedItems: EvidenceValue[] = [
    { label: text.sharpness, value: metrics.sharpness },
    { label: text.meanLuma, value: metrics.meanLuma },
    { label: text.darkClip, value: metrics.darkClipRatio, ratio: true },
    { label: text.highlightClip, value: metrics.highlightClipRatio, ratio: true },
    { label: text.faceCandidates, value: metrics.faceCandidateCount },
    { label: text.landmarkedFaces, value: metrics.landmarkedFaceCount },
    { label: text.enhancedPasses, value: metrics.enhancedFaceDetectionPasses },
    { label: text.tenengrad, value: metrics.tenengrad },
    { label: text.edgeDensity, value: metrics.edgeDensity, ratio: true },
    { label: text.focusPeakSharpness, value: metrics.focusPeakSharpness },
    { label: text.focusPeakTenengrad, value: metrics.focusPeakTenengrad },
    { label: text.focusPeakTexture, value: metrics.focusPeakTextureScore },
    { label: text.focusTileCount, value: metrics.focusTileCount },
    { label: text.closedFaces, value: metrics.eyeClosedFaceCount },
    { label: text.reviewFaces, value: metrics.eyeReviewFaceCount },
    { label: text.focusReliability, value: metrics.focusReliabilityScore, ratio: true },
    { label: text.faceQuality, value: metrics.faceQualityScore, ratio: true },
    { label: text.eyeReliability, value: metrics.eyeReliability, ratio: true },
    { label: text.poseReliability, value: metrics.poseReliability, ratio: true },
    { label: text.subjectExposure, value: metrics.subjectExposureScore, ratio: true },
  ];

  return (
    <EvidenceSection title={text.metrics} theme={theme}>
      <EvidenceKeyMetricList items={primaryItems} theme={theme} />
      <EvidenceDetails summary={language === 'zh' ? '\u67e5\u770b\u5168\u90e8\u6307\u6807' : 'Show all metrics'} theme={theme}>
        <EvidenceValueList items={advancedItems} theme={theme} />
      </EvidenceDetails>
    </EvidenceSection>
  );
};

const RegionList = ({ regions, theme, language }: { regions: AiRegion[]; theme: 'light' | 'dark'; language: Language }) => {
  const text = copy[language];
  const summary = language === 'zh' ? `\u67e5\u770b ${regions.length} \u4e2a\u68c0\u6d4b\u533a\u57df` : `View ${regions.length} detection regions`;

  return (
    <EvidenceSection title={text.regions} theme={theme}>
      <EvidenceDetails summary={summary} theme={theme}>
        <div className="space-y-1.5">
          {regions.map((region, index) => (
            <div
              key={`${region.source}-${index}`}
              className={`rounded-lg px-2.5 py-2 ${theme === 'dark' ? 'bg-white/[0.03]' : 'bg-slate-100/55'}`}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className={`min-w-0 truncate text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-800'}`}>
                  {region.label || (region.source === 'detector' ? text.detectorRegion : region.source === 'face' ? text.faceRegion : text.centerRegion)}
                </div>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] ${
                  theme === 'dark' ? 'bg-white/[0.05] text-zinc-500' : 'bg-white/60 text-slate-500'
                }`}>
                  {formatDetectorSource(region.source, language)}
                </span>
              </div>
              <div className={`mt-1.5 truncate text-[10.5px] font-mono ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
                x {formatConfidence(region.x)} / y {formatConfidence(region.y)} / w {formatConfidence(region.width)} / h {formatConfidence(region.height)}
              </div>
            </div>
          ))}
        </div>
      </EvidenceDetails>
    </EvidenceSection>
  );
};

const AiDiagnosticsPanel = ({ ai, theme, language }: { ai: AiAnalysis; theme: 'light' | 'dark'; language: Language }) => {
  const text = copy[language];
  const diagnostics = ai.diagnostics;
  const isGroupPortrait = diagnostics?.photoKind === 'GROUP_PORTRAIT';
  const overviewRows: EvidenceValue[] = [
    { label: text.photoKind, value: diagnostics?.photoKind === 'GROUP_PORTRAIT' ? text.groupPortrait : diagnostics?.photoKind === 'STANDARD' ? text.standardPhoto : undefined },
    { label: text.primarySubjects, value: !isGroupPortrait && diagnostics?.primarySubjectCount !== undefined ? String(diagnostics.primarySubjectCount) : undefined },
    { label: text.subjectConfidence, value: !isGroupPortrait && diagnostics?.subjectConfidence ? formatSubjectConfidence(diagnostics.subjectConfidence, language) : undefined },
    { label: text.focusMode, value: formatFocusMode(diagnostics?.focusMode || ai.metrics?.focusMode, language) },
    { label: text.faceDetectorStatus, value: diagnostics?.faceDetectorStatus ? formatFaceModelStatus(diagnostics.faceDetectorStatus, language) : undefined },
    { label: text.landmarkerSuccess, value: formatOptionalCount(diagnostics?.landmarkerSuccessCount) },
  ];
  const portraitRows: EvidenceValue[] = [
    { label: text.groupFaces, value: diagnostics?.groupFaceIndices?.length ? String(diagnostics.groupFaceIndices.length) : undefined },
    { label: text.groupClosedFaces, value: ai.metrics?.groupEyeClosedFaceCount !== undefined ? String(ai.metrics.groupEyeClosedFaceCount) : undefined },
    { label: text.focusReliable, value: typeof (diagnostics?.focusReliable ?? ai.metrics?.focusReliable) === 'boolean'
      ? ((diagnostics?.focusReliable ?? ai.metrics?.focusReliable) ? text.yes : text.no)
      : undefined },
  ];
  const systemRows: EvidenceValue[] = [
    { label: text.groupPortrait, value: diagnostics?.groupPortraitReason },
    { label: text.subjectDecision, value: !isGroupPortrait ? diagnostics?.subjectDecision : undefined },
    { label: text.focusSkip, value: diagnostics?.focusSkipReason },
    { label: text.eyeSkip, value: diagnostics?.eyeSkipReason },
    { label: text.faceDetectorName, value: diagnostics?.faceDetectorName },
    { label: text.faceDetectorAsset, value: diagnostics?.faceDetectorAssetPath },
    { label: text.faceDetectorError, value: diagnostics?.faceDetectorError },
    { label: text.landmarkerSuccess, value: formatOptionalCount(diagnostics?.landmarkerSuccessCount) },
    { label: text.wasmPath, value: diagnostics?.wasmBase },
    { label: text.modelPath, value: diagnostics?.modelAssetPath },
  ];
  const hasOverview = overviewRows.some(item => item.value !== undefined && item.value !== '');
  const hasPortraitRows = portraitRows.some(item => item.value !== undefined && item.value !== '');
  const hasSystemRows = systemRows.some(item => item.value !== undefined && item.value !== '');
  const faces = diagnostics?.faceDiagnostics ?? [];
  const modelLoadError = diagnostics?.modelLoadError;

  if (!hasOverview && !hasPortraitRows && faces.length === 0 && !modelLoadError && !hasSystemRows) return null;

  return (
    <EvidenceSection title={text.diagnostics} theme={theme}>
      {hasOverview && <EvidenceKeyMetricList items={overviewRows} theme={theme} />}
      {hasPortraitRows && <EvidenceValueList items={portraitRows} theme={theme} compact />}

      {faces.length > 0 && (
        <EvidenceDetails
          summary={language === 'zh' ? `\u67e5\u770b ${faces.length} \u5f20\u4eba\u8138\u8bca\u65ad` : `View ${faces.length} face diagnostics`}
          theme={theme}
          defaultOpen={faces.length <= 2}
        >
          <div className="space-y-2">
            {faces.map(face => (
              <FaceDiagnosticCard
                key={face.index}
                face={face}
                theme={theme}
                language={language}
              />
            ))}
          </div>
        </EvidenceDetails>
      )}

      {(hasSystemRows || modelLoadError) && (
        <EvidenceDetails summary={language === 'zh' ? '\u6a21\u578b\u4e0e\u8df3\u8fc7\u539f\u56e0' : 'Model and skip reasons'} theme={theme}>
          {hasSystemRows && <EvidenceValueList items={systemRows} theme={theme} />}
          {modelLoadError && (
            <pre className={`mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-[10.5px] font-mono leading-relaxed ${
              theme === 'dark' ? 'bg-rose-500/10 text-rose-200' : 'bg-rose-50 text-rose-800'
            }`}>
              {modelLoadError}
            </pre>
          )}
        </EvidenceDetails>
      )}
    </EvidenceSection>
  );
};

const EvidenceSection = ({
  title,
  theme,
  children,
}: {
  title: string;
  theme: 'light' | 'dark';
  children: React.ReactNode;
}) => (
  <div className="space-y-2.5">
    <div className="flex items-center gap-2">
      <span className={`h-px flex-1 ${theme === 'dark' ? 'bg-white/[0.05]' : 'bg-slate-300/70'}`} />
      <p className={`shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>{title}</p>
      <span className={`h-px flex-1 ${theme === 'dark' ? 'bg-white/[0.05]' : 'bg-slate-300/70'}`} />
    </div>
    <div className="space-y-2">{children}</div>
  </div>
);

const EvidenceKeyMetricList = ({ items, theme }: { items: EvidenceValue[]; theme: 'light' | 'dark' }) => {
  const visible = items.filter(item => item.value !== undefined && item.value !== '');
  if (visible.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {visible.map(item => (
        <div
          key={item.label}
          className={`flex min-w-0 items-center justify-between gap-3 rounded-lg px-2.5 py-2 ${
            theme === 'dark' ? 'bg-white/[0.03]' : 'bg-slate-100/58'
          }`}
        >
          <span className={`min-w-0 truncate text-[10.5px] font-medium ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-500'}`}>
            {item.label}
          </span>
          <span className={`shrink-0 font-mono text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-800'}`}>
            {formatEvidenceValue(item)}
          </span>
        </div>
      ))}
    </div>
  );
};

const EvidenceValueList = ({ items, theme, compact = false }: { items: EvidenceValue[]; theme: 'light' | 'dark'; compact?: boolean }) => {
  const visible = items.filter(item => item.value !== undefined && item.value !== '');
  if (visible.length === 0) return null;

  return (
    <div className={compact ? 'space-y-0.5' : 'space-y-1'}>
      {visible.map(item => (
        <div
          key={item.label}
          className={`flex min-w-0 items-baseline justify-between gap-3 ${compact ? 'py-0.5' : 'py-[3px]'}`}
        >
          <div className={`min-w-0 truncate text-[10.5px] font-medium ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>{item.label}</div>
          <div className={`shrink-0 truncate font-mono text-[10.5px] font-semibold ${theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}`}>
            {formatEvidenceValue(item)}
          </div>
        </div>
      ))}
    </div>
  );
};

const EvidenceDetails = ({
  summary,
  theme,
  children,
  defaultOpen = false,
}: {
  summary: string;
  theme: 'light' | 'dark';
  children: React.ReactNode;
  defaultOpen?: boolean;
}) => (
  <details
    open={defaultOpen}
    className={`group rounded-lg px-2.5 py-2 ${theme === 'dark' ? 'bg-white/[0.025]' : 'bg-slate-100/46'}`}
  >
    <summary className={`cursor-pointer list-none text-[10.5px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}`}>
      <span className="inline-flex items-center gap-1.5">
        <span className="transition-transform duration-150 group-open:rotate-90">&gt;</span>
        {summary}
      </span>
    </summary>
    <div className="mt-2">{children}</div>
  </details>
);

const FaceDiagnosticCard = ({
  face,
  theme,
  language,
}: {
  face: AiFaceDiagnostic;
  theme: 'light' | 'dark';
  language: Language;
}) => {
  const text = copy[language];
  const roleTone = face.subjectRole ? subjectRoleTone(face.subjectRole, theme) : undefined;
  const stateLabel = face.closed ? text.closed : face.reviewHint ? text.suspected : face.landmarkerStatus === 'OK' ? text.open : text.skipped;
  const stateIcon = face.closed || face.reviewHint ? AlertTriangle : face.landmarkerStatus === 'OK' ? CheckCircle2 : Circle;
  const stateTone = face.closed || face.reviewHint
    ? theme === 'dark' ? 'text-amber-200' : 'text-amber-700'
    : face.landmarkerStatus === 'OK'
      ? theme === 'dark' ? 'text-emerald-200' : 'text-emerald-700'
      : theme === 'dark' ? 'text-zinc-500' : 'text-slate-500';
  const mainItems: EvidenceValue[] = [
    { label: text.subjectScore, value: face.subjectScore, ratio: true },
    { label: text.lookAtCamera, value: face.lookAtCameraScore, ratio: true },
    { label: text.subjectSharpness, value: face.sharpnessScore, ratio: true },
    { label: text.faceSize, value: face.faceSizeRatio, ratio: true },
  ];
  const detailItems: EvidenceValue[] = [
    { label: text.subjectRank, value: face.subjectRank },
    { label: text.centerScore, value: face.centerScore, ratio: true },
    { label: text.cropSafety, value: face.cropSafetyScore, ratio: true },
    { label: text.eligibleSubject, value: face.eligibleAsPrimary ? text.yes : text.no },
    { label: text.detectorConfidence, value: face.detectorConfidence, ratio: true },
    { label: text.detectorName, value: face.detectorName },
    { label: text.detectorSource, value: formatDetectorSource(face.detectorSource, language) },
    { label: text.landmarkerStatus, value: formatLandmarkerStatus(face.landmarkerStatus, language) },
    { label: text.faceQuality, value: face.faceQualityScore, ratio: true },
    { label: text.eyeReliability, value: face.eyeReliability, ratio: true },
    { label: text.poseReliability, value: face.poseReliability, ratio: true },
    { label: 'L blink', value: face.leftBlink, ratio: true },
    { label: 'R blink', value: face.rightBlink, ratio: true },
    { label: 'L EAR', value: face.leftEar },
    { label: 'R EAR', value: face.rightEar },
    { label: 'score', value: face.eyeClosedScore, ratio: true },
  ];

  return (
    <div className={`rounded-lg px-2.5 py-2 ${theme === 'dark' ? 'bg-white/[0.025]' : 'bg-slate-100/50'}`}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`text-[11.5px] font-semibold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-800'}`}>
            {text.faceIndex} {face.index + 1}
          </span>
          {face.subjectRole && (
            <span className={`rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold ${roleTone?.pill}`}>
              {formatSubjectRole(face.subjectRole, language)}
            </span>
          )}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${stateTone}`}>
          <AppIcon icon={stateIcon} className="h-3 w-3" />
          {stateLabel}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {mainItems
          .filter(item => item.value !== undefined && item.value !== '')
          .map(item => (
            <div key={item.label} className="flex min-w-0 items-baseline justify-between gap-2">
              <span className={`min-w-0 truncate text-[10px] font-medium ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
                {item.label}
              </span>
              <span className={`shrink-0 font-mono text-[10.5px] font-semibold ${theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}`}>
                {formatEvidenceValue(item)}
              </span>
            </div>
          ))}
      </div>

      {(face.subjectReason || face.skippedReason) && (
        <div className={`mt-2 space-y-1 text-[10.5px] leading-snug ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {face.subjectReason && <div className="line-clamp-2">{face.subjectReason}</div>}
          {face.skippedReason && <div className="line-clamp-2">{face.skippedReason}</div>}
        </div>
      )}

      <div className="mt-2">
      <EvidenceDetails summary={language === 'zh' ? '更多人脸数据' : 'More face data'} theme={theme}>
        <EvidenceValueList items={detailItems} theme={theme} />
      </EvidenceDetails>
      </div>
    </div>
  );
};

function formatEvidenceValue(item: EvidenceValue) {
  if (typeof item.value === 'number') {
    return item.ratio ? formatConfidence(item.value) : formatMetric(item.value);
  }
  return item.value ?? '--';
}

const StarRatingControl = ({
  rating,
  theme,
  clearLabel,
  onChange,
}: {
  rating: PhotoRating;
  theme: 'light' | 'dark';
  clearLabel: string;
  onChange: (rating: PhotoRating) => void;
}) => (
  <div className="flex items-center gap-1">
    {[1, 2, 3, 4, 5].map(star => (
      <button
        key={star}
        onClick={() => onChange(rating === star ? 0 : (star as PhotoRating))}
        className={`group relative flex h-7 w-7 items-center justify-center rounded-full transition-all duration-200 ease-out hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 active:translate-y-0 motion-reduce:transition-none ${
          rating >= star
            ? theme === 'dark'
              ? 'text-amber-100 drop-shadow-[0_0_10px_rgba(251,191,36,0.72)]'
              : 'text-amber-600 drop-shadow-[0_0_8px_rgba(245,158,11,0.32)]'
            : theme === 'dark'
              ? 'text-zinc-600 hover:text-amber-200'
              : 'text-gray-400 hover:text-amber-600'
        }`}
        title={rating === star ? clearLabel : `${star}`}
      >
        {rating >= star && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute h-4 w-4 rounded-full blur-[5px] ${
              theme === 'dark' ? 'bg-amber-300/10' : 'bg-amber-300/12'
            }`}
          />
        )}
        <i className={`relative z-10 ${rating >= star ? 'fa-solid' : 'fa-regular'} fa-star text-[14px] transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none`}></i>
      </button>
    ))}
  </div>
);

const RatingButton = ({
  active,
  icon,
  label,
  hotkey,
  tone,
  theme,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  hotkey: string;
  tone: 'pick' | 'reject' | 'neutral';
  theme: 'light' | 'dark';
  onClick: () => void;
}) => {
  const activeClass = tone === 'pick'
    ? theme === 'dark'
      ? 'bg-white/[0.13] text-emerald-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(255,255,255,0.06),0_10px_24px_rgba(0,0,0,0.22)]'
      : 'bg-slate-100/[0.68] text-emerald-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.90),inset_0_-1px_0_rgba(15,23,42,0.05),0_10px_22px_rgba(15,23,42,0.09)]'
    : tone === 'reject'
      ? theme === 'dark'
        ? 'bg-white/[0.13] text-rose-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(255,255,255,0.06),0_10px_24px_rgba(0,0,0,0.22)]'
        : 'bg-slate-100/[0.68] text-rose-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.90),inset_0_-1px_0_rgba(15,23,42,0.05),0_10px_22px_rgba(15,23,42,0.09)]'
      : theme === 'dark'
        ? 'bg-white/[0.13] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(255,255,255,0.06),0_10px_24px_rgba(0,0,0,0.22)]'
        : 'bg-slate-100/[0.68] text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.90),inset_0_-1px_0_rgba(15,23,42,0.05),0_10px_22px_rgba(15,23,42,0.09)]';
  const idleClass = theme === 'dark'
    ? 'text-zinc-300 hover:bg-white/[0.05] hover:text-zinc-100'
    : 'text-slate-700 hover:bg-slate-100/[0.50] hover:text-slate-950';
  const idleIconClass = tone === 'pick'
    ? theme === 'dark' ? 'text-emerald-300' : 'text-emerald-700'
    : tone === 'reject'
      ? theme === 'dark' ? 'text-rose-300' : 'text-rose-700'
      : theme === 'dark' ? 'text-zinc-200' : 'text-gray-800';

  return (
    <button onClick={onClick} className={`group relative flex min-h-[50px] min-w-0 items-center justify-center rounded-lg px-2 py-2.5 text-center transition-all duration-200 ease-out hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 active:translate-y-0 motion-reduce:transition-none ${active ? activeClass : idleClass}`}>
      {active && (
        <span className="pointer-events-none absolute inset-x-2 top-1 h-2 rounded-full bg-white/[0.18] blur-[3px]" />
      )}
      <span className="flex min-w-0 flex-col items-center gap-0.5">
        <AppIcon icon={icon} className={`h-4 w-4 ${active ? '' : idleIconClass}`} />
        <span className="max-w-full truncate text-[11px] font-semibold leading-none">{label}</span>
      </span>
      <kbd className={`absolute right-1 top-1 rounded px-1 py-0.5 text-[9px] font-mono font-medium leading-none transition-colors ${
        active ? 'bg-white/[0.14] text-current shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]' : (theme === 'dark' ? 'bg-black/[0.18] text-zinc-500' : 'bg-slate-100/55 text-slate-500')
      }`}>
        {hotkey}
      </kbd>
    </button>
  );
};


const FileItem = ({ ext, size, isRaw, theme }: { ext: string; size: string; isRaw?: boolean; theme: 'light' | 'dark' }) => (
  <div className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs ${theme === 'dark' ? 'bg-white/[0.03] text-zinc-500' : 'bg-white/[0.24] text-slate-500'}`}>
    <span className={`flex min-w-0 items-center gap-1.5 ${isRaw ? (theme === 'dark' ? 'font-semibold text-cyan-200' : 'font-semibold text-cyan-700') : (theme === 'dark' ? 'text-zinc-400' : 'text-slate-600')}`}>
      <AppIcon icon={HardDrive} className="h-3 w-3 shrink-0 opacity-70" />
      <span className="truncate">{ext}</span>
    </span>
    <span className={`font-mono font-semibold ${theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}`}>{size}</span>
  </div>
);

const CenteredNotice = ({
  theme,
  icon,
  title,
  detail,
  tone = 'normal',
  loading = false,
}: {
  theme: 'light' | 'dark';
  icon: LucideIcon;
  title: string;
  detail: string;
  tone?: 'normal' | 'danger';
  loading?: boolean;
}) => (
  <div
    className={`flex min-w-[240px] max-w-[min(420px,calc(100vw-4rem))] items-center gap-3 rounded-lg border px-4 py-3 ${
      tone === 'danger'
        ? theme === 'dark'
          ? 'border-rose-300/[0.12] bg-[#24191c]/86 shadow-[0_12px_28px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-[28px]'
          : 'border-rose-300/35 bg-rose-50/82 shadow-[0_10px_22px_rgba(148,51,74,0.12),inset_0_1px_0_rgba(255,255,255,0.70)] backdrop-blur-[24px]'
        : theme === 'dark'
          ? photoOverlay.dark
          : photoOverlay.light
    }`}
  >
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
        tone === 'danger'
          ? theme === 'dark'
            ? 'bg-rose-400/[0.10] text-rose-300'
            : 'bg-rose-100/80 text-rose-600'
          : theme === 'dark'
            ? 'bg-cyan-300/[0.08] text-cyan-200'
            : 'bg-white/48 text-cyan-700'
      }`}
    >
      <AppIcon icon={icon} className={`h-[18px] w-[18px] ${loading ? 'animate-pulse motion-reduce:animate-none' : ''}`} />
    </div>
    <div className="min-w-0 text-left">
      <h3 className={`truncate text-[13px] font-semibold leading-5 ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-900'}`}>{title}</h3>
      {detail && (
        <p className={`mt-0.5 max-w-[320px] truncate text-[11px] leading-4 ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}`}>{detail}</p>
      )}
    </div>
  </div>
);

const IconButton = ({ theme, icon, title, onClick }: { theme: 'light' | 'dark'; icon: LucideIcon; title?: string; onClick: () => void }) => (
  <button
    onClick={onClick}
    className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors ${theme === 'dark' ? 'hover:bg-zinc-800 text-zinc-400' : 'hover:bg-slate-300/60 text-slate-600'}`}
    title={title}
  >
    <AppIcon icon={icon} className="h-4 w-4" />
  </button>
);

const Divider = ({ theme }: { theme: 'light' | 'dark' }) => (
  <div className={`w-px h-4 mx-1 ${theme === 'dark' ? 'bg-zinc-800' : 'bg-slate-400/50'}`} />
);

const SelectionPill = ({ icon, label, tone }: { icon: string; label: string; tone: 'pick' | 'reject' }) => (
  <div className={`${tone === 'pick' ? 'bg-emerald-500' : 'bg-rose-500'} text-white px-4 py-2 rounded-full font-bold shadow-lg flex items-center gap-2`}>
    <i className={`fa-solid ${icon}`}></i>
    {label}
  </div>
);

function formatMetric(value: number) {
  if (Math.abs(value) < 1) return value.toFixed(3);
  if (Math.abs(value) < 10) return value.toFixed(2);
  return value.toFixed(1);
}

function formatOptionalCount(value: number | undefined) {
  return typeof value === 'number' ? String(value) : undefined;
}


function formatDetectorSource(source: string | undefined, language: Language) {
  if (!source) return '--';
  if (language === 'en') {
    if (source === 'full') return 'Full';
    if (source === 'tile') return 'Tile';
    if (source === 'center') return 'Center';
    if (source === 'landmarker') return 'Landmarker';
    return source;
  }
  if (source === 'full') return '\u5168\u56fe';
  if (source === 'tile') return '\u5206\u5757';
  if (source === 'center') return '\u4e2d\u592e';
  if (source === 'landmarker') return '\u5173\u952e\u70b9';
  return source;
}

function formatLandmarkerStatus(status: 'OK' | 'FAILED' | 'SKIPPED' | undefined, language: Language) {
  if (!status) return '--';
  if (language === 'en') {
    if (status === 'OK') return 'OK';
    if (status === 'FAILED') return 'Failed';
    return 'Skipped';
  }
  if (status === 'OK') return '\u6210\u529f';
  if (status === 'FAILED') return '\u5931\u8d25';
  return '\u8df3\u8fc7';
}

function formatFaceModelStatus(status: AiAnalysis['faceModelStatus'], language: Language) {
  const text = copy[language];
  if (status === 'READY') return text.faceModelReady;
  if (status === 'UNAVAILABLE') return text.faceModelUnavailable;
  return text.faceModelUnused;
}

function formatSubjectRole(role: AiSubjectRole, language: Language) {
  if (language === 'en') {
    if (role === 'PRIMARY') return 'Primary';
    if (role === 'SECONDARY') return 'Secondary';
    if (role === 'OCCLUDER') return 'Occluder';
    return 'Background';
  }
  if (role === 'PRIMARY') return '\u4e3b\u4f53';
  if (role === 'SECONDARY') return '\u6b21\u8981';
  if (role === 'OCCLUDER') return '\u906e\u6321';
  return '\u80cc\u666f';
}

function formatSubjectConfidence(confidence: AiSubjectConfidence, language: Language) {
  if (language === 'en') {
    if (confidence === 'HIGH') return 'High';
    if (confidence === 'MEDIUM') return 'Medium';
    if (confidence === 'LOW') return 'Low';
    return 'None';
  }
  if (confidence === 'HIGH') return '\u9ad8';
  if (confidence === 'MEDIUM') return '\u4e2d';
  if (confidence === 'LOW') return '\u4f4e';
  return '\u65e0';
}

function roleFromRegionLabel(label?: string): AiSubjectRole | undefined {
  if (!label) return undefined;
  if (label.startsWith('PRIMARY')) return 'PRIMARY';
  if (label.startsWith('SECONDARY')) return 'SECONDARY';
  if (label.startsWith('BACKGROUND')) return 'BACKGROUND';
  if (label.startsWith('OCCLUDER')) return 'OCCLUDER';
  return undefined;
}

type EyeRegionState = 'closed' | 'review';

function eyeStateFromRegionLabel(label?: string): EyeRegionState | null {
  if (!label) return null;
  if (label.includes('EYE_CLOSED')) return 'closed';
  if (label.includes('EYE_REVIEW')) return 'review';
  return null;
}

function isGroupFaceRegion(label?: string) {
  return Boolean(label?.includes('GROUP_FACE'));
}

function eyeRegionLabel(state: EyeRegionState, language: Language) {
  if (language === 'en') return state === 'closed' ? 'Closed eyes' : 'Possible blink';
  return state === 'closed' ? '\u95ed\u773c' : '\u7591\u4f3c\u95ed\u773c';
}

function eyeRegionTone(state: EyeRegionState, theme: 'light' | 'dark') {
  if (state === 'closed') {
    return theme === 'dark'
      ? {
          frame: 'border-2 border-amber-300 shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_0_18px_rgba(251,191,36,0.30)]',
          label: 'bg-amber-300 text-zinc-950 shadow-[0_5px_16px_rgba(0,0,0,0.28)]',
        }
      : {
          frame: 'border-2 border-amber-600 shadow-[0_0_0_1px_rgba(255,255,255,0.42),0_0_14px_rgba(217,119,6,0.18)]',
          label: 'bg-amber-600 text-white shadow-[0_5px_14px_rgba(15,23,42,0.18)]',
        };
  }

  return theme === 'dark'
    ? {
        frame: 'border-2 border-amber-200/72 border-dashed shadow-[0_0_0_1px_rgba(0,0,0,0.30),0_0_14px_rgba(251,191,36,0.18)]',
        label: 'border border-amber-200/20 bg-zinc-950/76 text-amber-100 backdrop-blur-md',
      }
    : {
        frame: 'border-2 border-amber-600/66 border-dashed shadow-[0_0_0_1px_rgba(255,255,255,0.36),0_0_12px_rgba(217,119,6,0.12)]',
        label: 'border border-amber-800/16 bg-slate-100/88 text-amber-800 backdrop-blur-md',
      };
}

function groupFaceTone(theme: 'light' | 'dark') {
  return theme === 'dark'
    ? 'border border-cyan-200/42 shadow-[0_0_0_1px_rgba(0,0,0,0.22)]'
    : 'border border-cyan-700/46 shadow-[0_0_0_1px_rgba(255,255,255,0.30)]';
}

function subjectRoleTone(role: AiSubjectRole, theme: 'light' | 'dark') {
  if (role === 'PRIMARY') {
    return theme === 'dark'
      ? {
          frame: 'border-2 border-cyan-200/90 shadow-[0_0_0_1px_rgba(8,145,178,0.22),0_0_18px_rgba(103,232,249,0.16)]',
          label: 'bg-cyan-200 text-zinc-950 shadow-lg',
          pill: 'bg-cyan-200 text-zinc-950',
        }
      : {
          frame: 'border-2 border-cyan-700/90 shadow-[0_0_0_1px_rgba(255,255,255,0.35),0_0_16px_rgba(8,145,178,0.12)]',
          label: 'bg-cyan-700 text-white shadow-lg',
          pill: 'bg-cyan-700 text-white',
        };
  }

  if (role === 'SECONDARY') {
    return theme === 'dark'
      ? {
          frame: 'border border-zinc-100/34 shadow-[0_0_0_1px_rgba(0,0,0,0.20)]',
          label: 'border border-white/10 bg-zinc-950/72 text-zinc-200 backdrop-blur-md',
          pill: 'bg-zinc-800 text-zinc-300',
        }
      : {
          frame: 'border border-slate-700/34 shadow-[0_0_0_1px_rgba(255,255,255,0.28)]',
          label: 'border border-slate-400/30 bg-slate-100/82 text-slate-700 backdrop-blur-md',
          pill: 'bg-slate-200/80 text-slate-700',
        };
  }

  if (role === 'OCCLUDER') {
    return theme === 'dark'
      ? {
          frame: 'border border-amber-200/58 border-dashed shadow-[0_0_0_1px_rgba(0,0,0,0.22)]',
          label: 'border border-white/10 bg-zinc-950/76 text-amber-100 backdrop-blur-md',
          pill: 'bg-amber-300/16 text-amber-100',
        }
      : {
          frame: 'border border-amber-700/58 border-dashed shadow-[0_0_0_1px_rgba(255,255,255,0.32)]',
          label: 'border border-amber-800/14 bg-slate-100/82 text-amber-800 backdrop-blur-md',
          pill: 'bg-amber-100/86 text-amber-800',
        };
  }

  return theme === 'dark'
    ? {
        frame: 'border border-zinc-300/34 border-dashed shadow-[0_0_0_1px_rgba(0,0,0,0.22)]',
        label: 'border border-white/10 bg-zinc-950/68 text-zinc-300 backdrop-blur-md',
        pill: 'bg-zinc-800 text-zinc-300',
      }
    : {
        frame: 'border border-slate-600/34 border-dashed shadow-[0_0_0_1px_rgba(255,255,255,0.32)]',
        label: 'border border-slate-400/30 bg-slate-100/82 text-slate-700 backdrop-blur-md',
        pill: 'bg-slate-200/80 text-slate-700',
      };
}

function formatFocusMode(mode: AiMetrics['focusMode'], language: Language) {
  if (!mode) return undefined;
  if (language === 'en') {
    if (mode === 'FACE_ROI') return 'Face ROI';
    if (mode === 'NO_FACE_TEXTURED') return 'Textured non-face';
    return 'Skipped / unreliable';
  }
  if (mode === 'FACE_ROI') return '\u4eba\u8138/\u773c\u90e8 ROI';
  if (mode === 'NO_FACE_TEXTURED') return '\u9ad8\u7eb9\u7406\u65e0\u4eba\u8138';
  return '\u8df3\u8fc7/\u4e0d\u53ef\u9760';
}

export default Viewer;
