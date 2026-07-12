import type { AiIssue, AiIssueCode, AiIssueLevel, AiMetrics, AiSensitivity, AiSettings, DuplicateSensitivity, PhotoGroup } from '../types';
import { AI_MODEL_VERSION, DEFAULT_AI_SETTINGS } from './aiLabels';

export type AiThresholds = {
  sharpness: number;
  tenengrad: number;
  minEdgeDensity: number;
  highlightClipRatio: number;
  darkClipRatio: number;
  underMeanLuma: number;
  overMeanLuma: number;
  eyeClosedScore: number;
};

export const AI_THRESHOLDS: Record<AiSensitivity, AiThresholds> = {
  weak: {
    sharpness: 25,
    tenengrad: 32,
    minEdgeDensity: 0.012,
    highlightClipRatio: 0.12,
    darkClipRatio: 0.45,
    underMeanLuma: 60,
    overMeanLuma: 205,
    eyeClosedScore: 0.82,
  },
  standard: {
    sharpness: 35,
    tenengrad: 45,
    minEdgeDensity: 0.018,
    highlightClipRatio: 0.08,
    darkClipRatio: 0.35,
    underMeanLuma: 70,
    overMeanLuma: 190,
    eyeClosedScore: 0.7,
  },
  strong: {
    sharpness: 55,
    tenengrad: 62,
    minEdgeDensity: 0.014,
    highlightClipRatio: 0.05,
    darkClipRatio: 0.25,
    underMeanLuma: 85,
    overMeanLuma: 175,
    eyeClosedScore: 0.55,
  },
};

const AI_ISSUE_CODES: AiIssueCode[] = ['OUT_OF_FOCUS', 'UNDER_EXPOSED', 'OVER_EXPOSED', 'EYES_CLOSED'];

export function normalizeAiSettings(value: Partial<AiSettings> | null | undefined): AiSettings {
  const sensitivity = isAiSensitivity(value?.sensitivity)
    ? value.sensitivity
    : DEFAULT_AI_SETTINGS.sensitivity;
  const sensitivityByCheck = { ...DEFAULT_AI_SETTINGS.sensitivityByCheck };

  AI_ISSUE_CODES.forEach(code => {
    const itemSensitivity = value?.sensitivityByCheck?.[code];
    sensitivityByCheck[code] = isAiSensitivity(itemSensitivity)
      ? itemSensitivity
      : DEFAULT_AI_SETTINGS.sensitivityByCheck[code];
  });

  return {
    enabledChecks: {
      ...DEFAULT_AI_SETTINGS.enabledChecks,
      ...value?.enabledChecks,
    },
    sensitivity,
    sensitivityByCheck,
    duplicateSensitivity: isDuplicateSensitivity(value?.duplicateSensitivity)
      ? value.duplicateSensitivity
      : DEFAULT_AI_SETTINGS.duplicateSensitivity,
    duplicateAlwaysRecommendOne: typeof value?.duplicateAlwaysRecommendOne === 'boolean'
      ? value.duplicateAlwaysRecommendOne
      : DEFAULT_AI_SETTINGS.duplicateAlwaysRecommendOne,
    aiPickTargetRatio: normalizeAiPickTargetRatio(value?.aiPickTargetRatio),
    proPersonaRanking: {
      enabled: typeof value?.proPersonaRanking?.enabled === 'boolean'
        ? value.proPersonaRanking.enabled
        : DEFAULT_AI_SETTINGS.proPersonaRanking.enabled,
    },
  };
}

export function thresholdsForIssue(settings: AiSettings, code: AiIssueCode) {
  return AI_THRESHOLDS[settings.sensitivityByCheck[code] ?? settings.sensitivity];
}

export function classifyAiIssues(metrics: AiMetrics, settings: AiSettings): AiIssue[] {
  const sharpnessThresholds = thresholdsForIssue(settings, 'OUT_OF_FOCUS');
  const underExposureThresholds = thresholdsForIssue(settings, 'UNDER_EXPOSED');
  const overExposureThresholds = thresholdsForIssue(settings, 'OVER_EXPOSED');
  const eyeThresholds = thresholdsForIssue(settings, 'EYES_CLOSED');
  const sharpness = metrics.sharpness ?? Number.POSITIVE_INFINITY;
  const tenengrad = metrics.tenengrad ?? sharpness;
  const edgeDensity = metrics.edgeDensity ?? 1;
  const focusTextureScore = metrics.focusTextureScore ?? Math.min(sharpness, tenengrad);
  const focusPeakSharpness = metrics.focusPeakSharpness ?? sharpness;
  const focusPeakTenengrad = metrics.focusPeakTenengrad ?? tenengrad;
  const focusPeakTextureScore = metrics.focusPeakTextureScore ?? Math.min(focusPeakSharpness, focusPeakTenengrad);
  const meanLuma = metrics.meanLuma ?? 128;
  const subjectMeanLuma = metrics.subjectMeanLuma ?? meanLuma;
  const darkClipRatio = metrics.darkClipRatio ?? 0;
  const highlightClipRatio = metrics.highlightClipRatio ?? 0;
  const subjectReliable = metrics.subjectReliable === true;
  const primarySubjectCount = metrics.primarySubjectCount ?? 0;
  const subjectUnclear = metrics.subjectConfidence === 'LOW' || metrics.subjectConfidence === 'NONE';
  const subjectDarkClipRatio = metrics.subjectDarkClipRatio ?? darkClipRatio;
  const subjectHighlightClipRatio = metrics.subjectHighlightClipRatio ?? highlightClipRatio;
  const shadowRatio = metrics.shadowRatio ?? darkClipRatio;
  const highlightRatio = metrics.highlightRatio ?? highlightClipRatio;
  const midtoneMeanLuma = metrics.midtoneMeanLuma ?? meanLuma;
  const p10Luma = metrics.p10Luma ?? meanLuma;
  const p50Luma = metrics.p50Luma ?? meanLuma;
  const p90Luma = metrics.p90Luma ?? meanLuma;
  const groupFaceCount = metrics.groupFaceCount ?? 0;
  const groupEyeClosedFaceCount = metrics.groupEyeClosedFaceCount ?? 0;
  const groupEyeReviewFaceCount = metrics.groupEyeReviewFaceCount ?? 0;
  const isGroupPortrait = groupFaceCount >= 5;
  const eyeClosedScore = typeof metrics.eyeClosedScore === 'number' ? metrics.eyeClosedScore : undefined;
  const eyeReviewScore = typeof metrics.eyeReviewScore === 'number' ? metrics.eyeReviewScore : undefined;
  const issues: AiIssue[] = [];

  const focusReliable = metrics.focusReliable === true;
  const focusMode = metrics.focusMode;
  const hasFaceFocusCandidate = focusMode === 'FACE_ROI' && primarySubjectCount > 0;
  const hasEnoughDetailToJudge =
    focusMode === 'FACE_ROI' ||
    (
      focusMode === 'NO_FACE_TEXTURED' &&
      edgeDensity >= sharpnessThresholds.minEdgeDensity
    );
  const lowLaplacian = sharpness < sharpnessThresholds.sharpness;
  const lowTenengrad = tenengrad < sharpnessThresholds.tenengrad;
  const lowComposite = focusTextureScore < sharpnessThresholds.sharpness;
  const faceHasStructuredEdges = focusMode === 'FACE_ROI' && edgeDensity >= 0.18;
  const faceEdgeDensityIsLow = focusMode !== 'FACE_ROI' || edgeDensity < 0.12;
  const localDetailIsLow =
    focusPeakSharpness < sharpnessThresholds.sharpness * 1.05 &&
    focusPeakTenengrad < sharpnessThresholds.tenengrad * 1.05 &&
    focusPeakTextureScore < sharpnessThresholds.sharpness &&
    !faceHasStructuredEdges &&
    faceEdgeDensityIsLow;
  const focusEvidenceCount =
    Number(lowLaplacian) +
    Number(lowTenengrad) +
    Number(lowComposite);
  const severeFocusEvidence =
    focusTextureScore < sharpnessThresholds.sharpness * 0.62 &&
    tenengrad < sharpnessThresholds.tenengrad * 0.72 &&
    focusPeakTextureScore < sharpnessThresholds.sharpness * 0.88 &&
    !faceHasStructuredEdges;

  const formalFocusIssue =
    settings.enabledChecks.OUT_OF_FOCUS &&
    (focusMode !== 'FACE_ROI' || (primarySubjectCount > 0 && !subjectUnclear)) &&
    focusReliable &&
    hasEnoughDetailToJudge &&
    (
      (focusEvidenceCount >= 2 && localDetailIsLow) ||
      severeFocusEvidence
    );

  if (formalFocusIssue) {
    issues.push(makeIssue(
      'OUT_OF_FOCUS',
      'ISSUE',
      focusConfidence(
        sharpness,
        tenengrad,
        focusTextureScore,
        sharpnessThresholds.sharpness,
        sharpnessThresholds.tenengrad
      ),
      Math.min(sharpness, tenengrad, focusTextureScore),
      sharpnessThresholds.sharpness,
      focusMode === 'FACE_ROI'
        ? 'Face or eye ROI focus metrics are consistently below threshold.'
        : 'Textured non-face region has consistently low focus metrics.'
    ));
  } else if (
    settings.enabledChecks.OUT_OF_FOCUS &&
    hasFaceFocusCandidate &&
    lowLaplacian &&
    lowTenengrad &&
    lowComposite &&
    focusPeakSharpness < sharpnessThresholds.sharpness * 1.65 &&
    focusPeakTenengrad < sharpnessThresholds.tenengrad * 1.65
  ) {
    issues.push(makeIssue(
      'OUT_OF_FOCUS',
      'REVIEW_HINT',
      Math.min(0.78, focusConfidence(
        sharpness,
        tenengrad,
        focusTextureScore,
        sharpnessThresholds.sharpness,
        sharpnessThresholds.tenengrad
      )),
      Math.min(sharpness, tenengrad, focusTextureScore),
      sharpnessThresholds.sharpness,
      focusReliable
        ? 'Face ROI focus is low but not consistent enough for a hard reject.'
        : 'Small, angled, or partly occluded face has low focus metrics; review manually.'
    ));
  }

  const hasDetectedFaces = (metrics.faceCount ?? 0) > 0;
  const subjectOverExposed =
    subjectReliable &&
    subjectHighlightClipRatio > overExposureThresholds.highlightClipRatio &&
    subjectMeanLuma > overExposureThresholds.overMeanLuma;
  const severeSubjectOverExposed =
    subjectReliable &&
    hasHardHighlightLoss({
      clipRatio: subjectHighlightClipRatio,
      highlightRatio: Math.max(subjectHighlightClipRatio, highlightRatio * 0.45),
      meanLuma: subjectMeanLuma,
      p50Luma: subjectMeanLuma,
      p90Luma,
      threshold: overExposureThresholds.highlightClipRatio,
      subject: true,
    });
  const fullOverExposed =
    highlightClipRatio > overExposureThresholds.highlightClipRatio &&
    meanLuma > overExposureThresholds.overMeanLuma &&
    (
      (!subjectReliable && !hasDetectedFaces) ||
      subjectOverExposed
    );
  const disasterFullOverExposed =
    !subjectReliable &&
    !hasDetectedFaces &&
    hasHardHighlightLoss({
      clipRatio: highlightClipRatio,
      highlightRatio,
      meanLuma,
      p50Luma,
      p90Luma,
      threshold: overExposureThresholds.highlightClipRatio,
      subject: false,
    });

  if (settings.enabledChecks.OVER_EXPOSED && (disasterFullOverExposed || severeSubjectOverExposed)) {
    const overConfidenceScores = [
      confidenceAbove(highlightClipRatio, overExposureThresholds.highlightClipRatio, 0.25),
    ];
    if (subjectReliable) {
      overConfidenceScores.push(
        confidenceAbove(subjectHighlightClipRatio, overExposureThresholds.highlightClipRatio, 0.25)
      );
    }
    issues.push(makeIssue(
      'OVER_EXPOSED',
      'ISSUE',
      Math.max(...overConfidenceScores),
      subjectReliable ? Math.max(highlightClipRatio, subjectHighlightClipRatio) : highlightClipRatio,
      overExposureThresholds.highlightClipRatio,
      'Clipped highlights remain severe after recoverability checks.'
    ));
  } else if (settings.enabledChecks.OVER_EXPOSED && (fullOverExposed || (
    subjectReliable &&
    subjectHighlightClipRatio > overExposureThresholds.highlightClipRatio * 0.72 &&
    subjectMeanLuma > overExposureThresholds.overMeanLuma * 0.92
  ) || (
    hasDetectedFaces &&
    !subjectReliable &&
    highlightClipRatio > overExposureThresholds.highlightClipRatio * 0.9 &&
    meanLuma > overExposureThresholds.overMeanLuma * 0.96
  ))) {
    issues.push(makeIssue(
      'OVER_EXPOSED',
      'REVIEW_HINT',
      Math.min(0.76, confidenceAbove(
        subjectReliable ? Math.max(subjectHighlightClipRatio, highlightClipRatio * 0.5) : highlightClipRatio,
        overExposureThresholds.highlightClipRatio,
        0.28
      )),
      subjectReliable ? Math.max(subjectHighlightClipRatio, highlightClipRatio * 0.5) : highlightClipRatio,
      overExposureThresholds.highlightClipRatio,
      subjectReliable
        ? 'Subject highlights may need highlight recovery; review manually.'
        : 'Full-image highlights are high but still treated as recoverable unless clipped areas are severe.'
    ));
  }

  const subjectUnderExposed =
    subjectReliable &&
    subjectDarkClipRatio > underExposureThresholds.darkClipRatio &&
    subjectMeanLuma < underExposureThresholds.underMeanLuma;
  const severeSubjectUnderExposed =
    subjectReliable &&
    hasHardShadowLoss({
      clipRatio: subjectDarkClipRatio,
      shadowRatio: Math.max(subjectDarkClipRatio, shadowRatio * 0.45),
      meanLuma: subjectMeanLuma,
      p10Luma,
      p50Luma: subjectMeanLuma,
      threshold: underExposureThresholds.darkClipRatio,
      subject: true,
    });
  const fullUnderExposed =
    darkClipRatio > underExposureThresholds.darkClipRatio &&
    meanLuma < underExposureThresholds.underMeanLuma &&
    (
      (!subjectReliable && !hasDetectedFaces) ||
      subjectUnderExposed
    );
  const disasterFullUnderExposed =
    !subjectReliable &&
    !hasDetectedFaces &&
    hasHardShadowLoss({
      clipRatio: darkClipRatio,
      shadowRatio,
      meanLuma,
      p10Luma,
      p50Luma,
      threshold: underExposureThresholds.darkClipRatio,
      subject: false,
    });
  const highContrastShadowReview =
    !subjectReliable &&
    shadowRatio > 0.28 &&
    highlightRatio > 0.18 &&
    midtoneMeanLuma < underExposureThresholds.underMeanLuma * 1.9 &&
    p10Luma < underExposureThresholds.underMeanLuma * 0.82 &&
    p90Luma > overExposureThresholds.overMeanLuma * 0.95;

  if (settings.enabledChecks.UNDER_EXPOSED && (disasterFullUnderExposed || severeSubjectUnderExposed)) {
    const underConfidenceScores = [
      confidenceAbove(darkClipRatio, underExposureThresholds.darkClipRatio, 0.6),
      confidenceBelow(meanLuma, underExposureThresholds.underMeanLuma),
    ];
    if (subjectReliable) {
      underConfidenceScores.push(
        confidenceAbove(subjectDarkClipRatio, underExposureThresholds.darkClipRatio, 0.6),
        confidenceBelow(subjectMeanLuma, underExposureThresholds.underMeanLuma)
      );
    }
    issues.push(makeIssue(
      'UNDER_EXPOSED',
      'ISSUE',
      Math.max(...underConfidenceScores),
      subjectReliable ? Math.max(darkClipRatio, subjectDarkClipRatio) : darkClipRatio,
      underExposureThresholds.darkClipRatio,
      'Dead-shadow areas remain severe after recoverability checks.'
    ));
  } else if (settings.enabledChecks.UNDER_EXPOSED && (fullUnderExposed || highContrastShadowReview || (
    subjectReliable &&
    subjectDarkClipRatio > underExposureThresholds.darkClipRatio * 0.72 &&
    subjectMeanLuma < underExposureThresholds.underMeanLuma * 1.18
  ) || (
    hasDetectedFaces &&
    !subjectReliable &&
    darkClipRatio > underExposureThresholds.darkClipRatio * 0.9 &&
    meanLuma < underExposureThresholds.underMeanLuma * 1.04
  ))) {
    issues.push(makeIssue(
      'UNDER_EXPOSED',
      'REVIEW_HINT',
      Math.min(0.76, Math.max(
        confidenceAbove(subjectReliable ? subjectDarkClipRatio : darkClipRatio, underExposureThresholds.darkClipRatio, 0.72),
        confidenceBelow(subjectReliable ? subjectMeanLuma : meanLuma, underExposureThresholds.underMeanLuma)
      )),
      subjectReliable ? Math.max(subjectDarkClipRatio, darkClipRatio * 0.5) : darkClipRatio,
      underExposureThresholds.darkClipRatio,
      subjectReliable
        ? 'Subject shadows may need shadow recovery; review manually.'
        : highContrastShadowReview
          ? 'Backlit or high-contrast frame has heavy shadows while highlights remain bright; review exposure balance manually.'
          : 'Full-image shadows are high but still treated as recoverable unless dead-shadow areas are severe.'
    ));
  }

  const standardClosedEyeIssue = (
    settings.enabledChecks.EYES_CLOSED &&
    primarySubjectCount > 0 &&
    !subjectUnclear &&
    (metrics.eyeClosedFaceCount ?? 0) > 0 &&
    eyeClosedScore !== undefined &&
    eyeClosedScore >= eyeThresholds.eyeClosedScore
  );
  const groupClosedEyeIssue = (
    settings.enabledChecks.EYES_CLOSED &&
    isGroupPortrait &&
    groupFaceCount > 0 &&
    groupEyeClosedFaceCount > 0 &&
    eyeClosedScore !== undefined &&
    eyeClosedScore >= eyeThresholds.eyeClosedScore
  );

  if (standardClosedEyeIssue || groupClosedEyeIssue) {
    issues.push(makeIssue(
      'EYES_CLOSED',
      'ISSUE',
      eyeClosedScore ?? 0,
      eyeClosedScore ?? 0,
      eyeThresholds.eyeClosedScore,
      isGroupPortrait
        ? 'At least one member in the group portrait appears to have both eyes closed.'
        : 'At least one detected face appears to have both eyes closed.'
    ));
  } else {
    const standardClosedEyeReview = (
      settings.enabledChecks.EYES_CLOSED &&
      primarySubjectCount > 0 &&
      (metrics.eyeReviewFaceCount ?? 0) > 0 &&
      eyeReviewScore !== undefined &&
      eyeReviewScore >= eyeThresholds.eyeClosedScore * 0.72
    );
    const groupClosedEyeReview = (
      settings.enabledChecks.EYES_CLOSED &&
      isGroupPortrait &&
      groupFaceCount > 0 &&
      groupEyeReviewFaceCount > 0 &&
      eyeReviewScore !== undefined &&
      eyeReviewScore >= eyeThresholds.eyeClosedScore * 0.72
    );

    if (!(standardClosedEyeReview || groupClosedEyeReview)) {
      return issues;
    }

    issues.push(makeIssue(
      'EYES_CLOSED',
      'REVIEW_HINT',
      Math.min(0.78, eyeReviewScore ?? 0),
      eyeReviewScore ?? 0,
      eyeThresholds.eyeClosedScore,
      isGroupPortrait
        ? 'Eye metrics suggest a possible blink in the group portrait, but the evidence is not strong enough for a hard closed-eyes label.'
        : 'Eye metrics suggest a possible blink, but the evidence is not strong enough for a hard closed-eyes label.'
    ));
  }

  return issues;
}

export function shouldDetectFacesForAi(settings: AiSettings) {
  return (
    settings.enabledChecks.OUT_OF_FOCUS ||
    settings.enabledChecks.UNDER_EXPOSED ||
    settings.enabledChecks.OVER_EXPOSED ||
    settings.enabledChecks.EYES_CLOSED
  );
}

export function buildAiCacheKey(group: PhotoGroup, settings: AiSettings) {
  const normalized = normalizeAiSettings(settings);
  const primary = group.jpg || group.raw;
  const enabled = Object.entries(normalized.enabledChecks)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .sort()
    .join(',');
  const sensitivities = Object.entries(normalized.sensitivityByCheck)
    .map(([key, value]) => `${key}:${value}`)
    .sort()
    .join(',');

  return [
    AI_MODEL_VERSION,
    normalized.sensitivity,
    sensitivities,
    enabled,
    `duplicate:${normalized.duplicateSensitivity}:${normalized.duplicateAlwaysRecommendOne ? '1' : '0'}`,
    primary?.path || group.id,
    primary?.size || 0,
    primary?.modifiedMs || 0,
  ].join('|');
}

function isAiSensitivity(value: unknown): value is AiSensitivity {
  return value === 'weak' || value === 'standard' || value === 'strong';
}

function isDuplicateSensitivity(value: unknown): value is DuplicateSensitivity {
  return value === 'off' || value === 'loose' || value === 'standard' || value === 'strict';
}

function normalizeAiPickTargetRatio(value: unknown) {
  const ratio = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ratio)) return DEFAULT_AI_SETTINGS.aiPickTargetRatio;
  return Math.max(0.1, Math.min(0.7, Math.round(ratio * 20) / 20));
}

function hasHardHighlightLoss({
  clipRatio,
  highlightRatio,
  meanLuma,
  p50Luma,
  p90Luma,
  threshold,
  subject,
}: {
  clipRatio: number;
  highlightRatio: number;
  meanLuma: number;
  p50Luma: number;
  p90Luma: number;
  threshold: number;
  subject: boolean;
}) {
  const strictClip = subject
    ? Math.max(threshold * 2.05, 0.18)
    : Math.max(threshold * 2.45, 0.2);
  const catastrophicClip = subject
    ? Math.max(threshold * 3.15, 0.3)
    : Math.max(threshold * 3.55, 0.34);
  const denseBrightArea =
    highlightRatio > (subject ? 0.36 : 0.48) &&
    p90Luma > 238;
  const globallyWashed =
    meanLuma > (subject ? 208 : 216) &&
    p50Luma > 198;
  const unrecoverableTail = p90Luma > 250 && clipRatio > strictClip * 0.86;

  return clipRatio > catastrophicClip || (
    clipRatio > strictClip &&
    (denseBrightArea || globallyWashed || unrecoverableTail)
  );
}

function hasHardShadowLoss({
  clipRatio,
  shadowRatio,
  meanLuma,
  p10Luma,
  p50Luma,
  threshold,
  subject,
}: {
  clipRatio: number;
  shadowRatio: number;
  meanLuma: number;
  p10Luma: number;
  p50Luma: number;
  threshold: number;
  subject: boolean;
}) {
  const strictClip = subject
    ? Math.max(threshold * 1.58, 0.55)
    : Math.max(threshold * 1.74, 0.6);
  const catastrophicClip = subject
    ? Math.max(threshold * 1.95, 0.68)
    : Math.max(threshold * 2.15, 0.75);
  const denseDeadShadow =
    shadowRatio > (subject ? 0.58 : 0.66) &&
    p10Luma < 18;
  const crushedFrame =
    meanLuma < (subject ? 48 : 50) &&
    p50Luma < (subject ? 54 : 58);
  const unrecoverableTail = p10Luma < 10 && clipRatio > strictClip * 0.9;

  return clipRatio > catastrophicClip || (
    clipRatio > strictClip &&
    (denseDeadShadow || crushedFrame || unrecoverableTail)
  );
}

function makeIssue(
  code: AiIssueCode,
  level: AiIssueLevel,
  confidence: number,
  score: number,
  threshold: number,
  message: string
): AiIssue {
  return {
    code,
    level,
    confidence: clamp(confidence),
    score,
    threshold,
    message,
  };
}

function confidenceBelow(score: number, threshold: number) {
  if (threshold <= 0) return 0;
  return clamp(0.55 + (threshold - score) / threshold);
}

function confidenceAbove(score: number, threshold: number, maxSpread: number) {
  if (maxSpread <= 0) return 0;
  return clamp(0.55 + (score - threshold) / maxSpread);
}

function focusConfidence(
  sharpness: number,
  tenengrad: number,
  focusTextureScore: number,
  sharpnessThreshold: number,
  tenengradThreshold: number
) {
  const deficits = [
    deficitRatio(sharpness, sharpnessThreshold),
    deficitRatio(tenengrad, tenengradThreshold),
    deficitRatio(focusTextureScore, sharpnessThreshold),
  ];
  const averageDeficit = deficits.reduce((sum, value) => sum + value, 0) / deficits.length;
  const base = 0.58 + averageDeficit * 0.34;
  const allExtremelyLow = deficits.every(value => value > 0.82);
  return clamp(allExtremelyLow ? Math.min(0.98, base + 0.05) : Math.min(0.92, base));
}

function deficitRatio(score: number, threshold: number) {
  if (threshold <= 0) return 0;
  return clamp((threshold - score) / threshold);
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}
