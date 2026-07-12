import { describe, expect, it } from 'vitest';
import { GroupStatus, SelectionState, type AiSettings, type PhotoGroup } from '../types';
import { AI_MODEL_VERSION, DEFAULT_AI_SETTINGS } from './aiLabels';
import { buildAiCacheKey, classifyAiIssues, normalizeAiSettings, shouldDetectFacesForAi, thresholdsForIssue } from './aiCore';
import { applyAiReviewSelection } from './aiReview';

const baseGroup: PhotoGroup = {
  id: 'IMG_0001',
  jpg: {
    name: 'IMG_0001.JPG',
    extension: 'JPG',
    file: null as unknown as File,
    previewUrl: 'asset://IMG_0001.JPG',
    size: 2048,
    modifiedMs: 1710000000000,
    path: 'C:/photos/IMG_0001.JPG',
  },
  status: GroupStatus.JPG_ONLY,
  selection: SelectionState.UNMARKED,
  rating: 0,
};

describe('AI core settings', () => {
  it('normalizes legacy settings with missing per-check sensitivity', () => {
    const settings = normalizeAiSettings({
      enabledChecks: {
        ...DEFAULT_AI_SETTINGS.enabledChecks,
        EYES_CLOSED: false,
      },
      sensitivity: 'strong',
    } as Partial<AiSettings>);

    expect(settings.enabledChecks.EYES_CLOSED).toBe(false);
    expect(settings.sensitivity).toBe('strong');
    expect(settings.sensitivityByCheck.OUT_OF_FOCUS).toBe('standard');
    expect(settings.sensitivityByCheck.EYES_CLOSED).toBe('standard');
    expect(settings.duplicateSensitivity).toBe(DEFAULT_AI_SETTINGS.duplicateSensitivity);
    expect(settings.duplicateAlwaysRecommendOne).toBe(DEFAULT_AI_SETTINGS.duplicateAlwaysRecommendOne);
    expect(settings.aiPickTargetRatio).toBe(DEFAULT_AI_SETTINGS.aiPickTargetRatio);
  });

  it('drops invalid persisted duplicate and AI pick settings', () => {
    const settings = normalizeAiSettings({
      duplicateSensitivity: 'wild' as never,
      duplicateAlwaysRecommendOne: 'yes' as never,
      aiPickTargetRatio: 'often' as never,
    });

    expect(settings.duplicateSensitivity).toBe(DEFAULT_AI_SETTINGS.duplicateSensitivity);
    expect(settings.duplicateAlwaysRecommendOne).toBe(DEFAULT_AI_SETTINGS.duplicateAlwaysRecommendOne);
    expect(settings.aiPickTargetRatio).toBe(DEFAULT_AI_SETTINGS.aiPickTargetRatio);
    expect(normalizeAiSettings({ aiPickTargetRatio: 0.04 }).aiPickTargetRatio).toBe(0.1);
    expect(normalizeAiSettings({ aiPickTargetRatio: 0.94 }).aiPickTargetRatio).toBe(0.7);
    expect(normalizeAiSettings({ aiPickTargetRatio: 0.383 }).aiPickTargetRatio).toBe(0.4);
  });

  it('uses each check sensitivity when selecting thresholds', () => {
    const settings = normalizeAiSettings({
      sensitivity: 'weak',
      sensitivityByCheck: {
        ...DEFAULT_AI_SETTINGS.sensitivityByCheck,
        OUT_OF_FOCUS: 'strong',
        EYES_CLOSED: 'weak',
      },
    });

    expect(thresholdsForIssue(settings, 'OUT_OF_FOCUS').sharpness).toBe(55);
    expect(thresholdsForIssue(settings, 'EYES_CLOSED').eyeClosedScore).toBe(0.82);
    expect(thresholdsForIssue(settings, 'OVER_EXPOSED').highlightClipRatio).toBe(0.08);
  });

  it('drops invalid persisted per-check sensitivity values', () => {
    const settings = normalizeAiSettings({
      sensitivityByCheck: {
        ...DEFAULT_AI_SETTINGS.sensitivityByCheck,
        OUT_OF_FOCUS: 'extreme' as never,
      },
    });

    expect(settings.sensitivityByCheck.OUT_OF_FOCUS).toBe('standard');
    expect(thresholdsForIssue(settings, 'OUT_OF_FOCUS').sharpness).toBe(35);
  });

  it('includes enabled checks, per-check sensitivity, file size, and mtime in cache keys', () => {
    const standardKey = buildAiCacheKey(baseGroup, DEFAULT_AI_SETTINGS);
    const strongFocus = normalizeAiSettings({
      sensitivityByCheck: {
        ...DEFAULT_AI_SETTINGS.sensitivityByCheck,
        OUT_OF_FOCUS: 'strong',
      },
    });
    const withoutEyes = normalizeAiSettings({
      enabledChecks: {
        ...DEFAULT_AI_SETTINGS.enabledChecks,
        EYES_CLOSED: false,
      },
    });
    const changedFile: PhotoGroup = {
      ...baseGroup,
      jpg: baseGroup.jpg ? { ...baseGroup.jpg, modifiedMs: 1710000000001 } : undefined,
    };

    expect(buildAiCacheKey(baseGroup, strongFocus)).not.toBe(standardKey);
    expect(buildAiCacheKey(baseGroup, withoutEyes)).not.toBe(standardKey);
    expect(buildAiCacheKey(changedFile, DEFAULT_AI_SETTINGS)).not.toBe(standardKey);
  });

  it('changes cache keys when duplicate detection settings change', () => {
    const standardKey = buildAiCacheKey(baseGroup, DEFAULT_AI_SETTINGS);
    const duplicateOff = normalizeAiSettings({
      duplicateSensitivity: 'off',
    });
    const duplicateNoRecommendation = normalizeAiSettings({
      duplicateAlwaysRecommendOne: false,
    });

    expect(buildAiCacheKey(baseGroup, duplicateOff)).not.toBe(standardKey);
    expect(buildAiCacheKey(baseGroup, duplicateNoRecommendation)).not.toBe(standardKey);
  });

  it('does not include the AI pick target ratio in per-photo analysis cache keys', () => {
    const standardKey = buildAiCacheKey(baseGroup, DEFAULT_AI_SETTINGS);
    const widerPickTarget = normalizeAiSettings({
      aiPickTargetRatio: 0.7,
    });

    expect(buildAiCacheKey(baseGroup, widerPickTarget)).toBe(standardKey);
  });

  it('does not include the Pro persona ranking switch in per-photo analysis cache keys', () => {
    const standardKey = buildAiCacheKey(baseGroup, DEFAULT_AI_SETTINGS);
    const enabledProPersonaRanking = normalizeAiSettings({
      proPersonaRanking: {
        enabled: true,
      },
    });

    expect(buildAiCacheKey(baseGroup, enabledProPersonaRanking)).toBe(standardKey);
  });

  it('uses face detection whenever any AI hard-fault check is enabled', () => {
    const allDisabled = normalizeAiSettings({
      enabledChecks: {
        OUT_OF_FOCUS: false,
        UNDER_EXPOSED: false,
        OVER_EXPOSED: false,
        EYES_CLOSED: false,
      },
    });
    const exposureOnly = normalizeAiSettings({
      enabledChecks: {
        OUT_OF_FOCUS: false,
        UNDER_EXPOSED: true,
        OVER_EXPOSED: false,
        EYES_CLOSED: false,
      },
    });

    expect(shouldDetectFacesForAi(allDisabled)).toBe(false);
    expect(shouldDetectFacesForAi(exposureOnly)).toBe(true);
  });
});

describe('AI review state transitions', () => {
  const flaggedPhoto: PhotoGroup = {
    ...baseGroup,
    ai: {
      status: 'DONE',
      issues: [{
        code: 'OUT_OF_FOCUS',
        level: 'ISSUE',
        confidence: 0.82,
        score: 22,
        threshold: 35,
        message: 'Soft focus',
      }],
      confidence: 0.82,
      preset: 'standard',
      reviewed: false,
      modelVersion: AI_MODEL_VERSION,
    },
  };

  it('marks keep and reject decisions as reviewed', () => {
    expect(applyAiReviewSelection(flaggedPhoto, SelectionState.PICKED).ai?.reviewed).toBe(true);
    expect(applyAiReviewSelection(flaggedPhoto, SelectionState.REJECTED).ai?.reviewed).toBe(true);
  });

  it('keeps undecided photos in the AI review queue while preserving labels', () => {
    const result = applyAiReviewSelection(flaggedPhoto, SelectionState.UNMARKED);

    expect(result.selection).toBe(SelectionState.UNMARKED);
    expect(result.ai?.reviewed).toBe(false);
    expect(result.ai?.issues[0]?.code).toBe('OUT_OF_FOCUS');
  });
});

describe('AI issue classification', () => {
  it('flags out-of-focus frames below the standard sharpness threshold', () => {
    const issues = classifyAiIssues({
      sharpness: 20,
      tenengrad: 24,
      edgeDensity: 0.08,
      focusTextureScore: 20,
      focusReliable: true,
      focusMode: 'FACE_ROI',
      primarySubjectCount: 1,
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).toContain('OUT_OF_FOCUS');
  });

  it('does not flag low-texture frames as out of focus without enough detail to judge', () => {
    const issues = classifyAiIssues({
      sharpness: 12,
      tenengrad: 16,
      edgeDensity: 0.002,
      focusTextureScore: 12,
      faceCount: 0,
      focusReliable: false,
      focusMode: 'NO_FACE_UNRELIABLE',
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('OUT_OF_FOCUS');
  });

  it('does not flag focus when the face model is ready but no reliable face ROI exists', () => {
    const issues = classifyAiIssues({
      sharpness: 8,
      tenengrad: 10,
      edgeDensity: 0.06,
      focusTextureScore: 8,
      faceCount: 0,
      focusReliable: false,
      focusMode: 'NO_FACE_UNRELIABLE',
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('OUT_OF_FOCUS');
  });

  it('does not flag clear face ROI frames as out of focus', () => {
    const issues = classifyAiIssues({
      sharpness: 64,
      tenengrad: 72,
      edgeDensity: 0.18,
      focusTextureScore: 64,
      faceCount: 1,
      focusReliable: true,
      focusMode: 'FACE_ROI',
      primarySubjectCount: 1,
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('OUT_OF_FOCUS');
  });

  it('does not flag face ROI frames when local focus peaks show crisp detail', () => {
    const issues = classifyAiIssues({
      sharpness: 12,
      tenengrad: 18,
      edgeDensity: 0.09,
      focusTextureScore: 12,
      focusPeakSharpness: 58,
      focusPeakTenengrad: 71,
      focusPeakTextureScore: 52,
      focusTileCount: 9,
      faceCount: 1,
      focusReliable: true,
      focusMode: 'FACE_ROI',
      primarySubjectCount: 1,
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('OUT_OF_FOCUS');
  });

  it('flags focus when most correlated focus metrics are low and local detail is weak', () => {
    const issues = classifyAiIssues({
      sharpness: 28,
      tenengrad: 42,
      edgeDensity: 0.08,
      focusTextureScore: 25,
      focusPeakSharpness: 30,
      focusPeakTenengrad: 46,
      focusPeakTextureScore: 28,
      focusTileCount: 9,
      faceCount: 1,
      focusReliable: true,
      focusMode: 'FACE_ROI',
      primarySubjectCount: 1,
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    const focusIssue = issues.find(issue => issue.code === 'OUT_OF_FOCUS');
    expect(focusIssue?.level).toBe('ISSUE');
  });

  it('does not hard-flag focus when only one core focus metric is low', () => {
    const issues = classifyAiIssues({
      sharpness: 28,
      tenengrad: 58,
      edgeDensity: 0.08,
      focusTextureScore: 42,
      focusPeakSharpness: 30,
      focusPeakTenengrad: 50,
      focusPeakTextureScore: 38,
      focusTileCount: 9,
      faceCount: 1,
      focusReliable: true,
      focusMode: 'FACE_ROI',
      primarySubjectCount: 1,
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    const focusIssue = issues.find(issue => issue.code === 'OUT_OF_FOCUS');
    expect(focusIssue?.level).not.toBe('ISSUE');
  });

  it('downgrades ambiguous structured-edge focus to a review hint', () => {
    const issues = classifyAiIssues({
      sharpness: 14,
      tenengrad: 20,
      edgeDensity: 0.2,
      focusTextureScore: 14,
      focusPeakSharpness: 20,
      focusPeakTenengrad: 26,
      focusPeakTextureScore: 20,
      focusTileCount: 9,
      faceCount: 1,
      focusReliable: true,
      focusMode: 'FACE_ROI',
      primarySubjectCount: 1,
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    const focusIssue = issues.find(issue => issue.code === 'OUT_OF_FOCUS');
    expect(focusIssue?.level).toBe('REVIEW_HINT');
  });

  it('does not hard-flag focus when subject selection is low confidence', () => {
    const issues = classifyAiIssues({
      sharpness: 14,
      tenengrad: 18,
      edgeDensity: 0.08,
      focusTextureScore: 14,
      focusPeakSharpness: 18,
      focusPeakTenengrad: 22,
      focusPeakTextureScore: 18,
      focusTileCount: 9,
      faceCount: 1,
      focusReliable: true,
      focusMode: 'FACE_ROI',
      primarySubjectCount: 1,
      subjectConfidence: 'LOW',
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    const focusIssue = issues.find(issue => issue.code === 'OUT_OF_FOCUS');
    expect(focusIssue?.level).toBe('REVIEW_HINT');
  });

  it('can flag textured non-face frames only when the focus region is reliable', () => {
    const issues = classifyAiIssues({
      sharpness: 12,
      tenengrad: 14,
      edgeDensity: 0.16,
      focusTextureScore: 12,
      faceCount: 0,
      focusReliable: true,
      focusMode: 'NO_FACE_TEXTURED',
      meanLuma: 130,
      darkClipRatio: 0.02,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).toContain('OUT_OF_FOCUS');
  });

  it('keeps recoverable overexposure as a review hint', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 210,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.12,
    }, DEFAULT_AI_SETTINGS);

    const overIssue = issues.find(issue => issue.code === 'OVER_EXPOSED');
    expect(overIssue?.level).toBe('REVIEW_HINT');
  });

  it('flags severe overexposure only when clipped areas are large', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 218,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.22,
      highlightRatio: 0.58,
      p90Luma: 246,
    }, DEFAULT_AI_SETTINGS);

    const overIssue = issues.find(issue => issue.code === 'OVER_EXPOSED');
    expect(overIssue?.level).toBe('ISSUE');
  });

  it('does not hard-flag bright scenes when highlight recovery still looks plausible', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 204,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.16,
      highlightRatio: 0.28,
      p50Luma: 172,
      p90Luma: 232,
    }, DEFAULT_AI_SETTINGS);

    const overIssue = issues.find(issue => issue.code === 'OVER_EXPOSED');
    expect(overIssue?.level).toBe('REVIEW_HINT');
  });

  it('keeps recoverable underexposure as a review hint', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 52,
      darkClipRatio: 0.42,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    const underIssue = issues.find(issue => issue.code === 'UNDER_EXPOSED');
    expect(underIssue?.level).toBe('REVIEW_HINT');
  });

  it('does not hard-flag dark scenes when shadow recovery still looks plausible', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 58,
      darkClipRatio: 0.52,
      highlightClipRatio: 0.01,
      shadowRatio: 0.58,
      p10Luma: 24,
      p50Luma: 64,
    }, DEFAULT_AI_SETTINGS);

    const underIssue = issues.find(issue => issue.code === 'UNDER_EXPOSED');
    expect(underIssue?.level).toBe('REVIEW_HINT');
  });

  it('flags severe underexposure only when dead-shadow areas are large', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 46,
      darkClipRatio: 0.62,
      highlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    const underIssue = issues.find(issue => issue.code === 'UNDER_EXPOSED');
    expect(underIssue?.level).toBe('ISSUE');
  });

  it('does not flag underexposure from a dark background when the confirmed face is exposed', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 52,
      darkClipRatio: 0.42,
      highlightClipRatio: 0.01,
      subjectReliable: true,
      subjectMeanLuma: 132,
      subjectDarkClipRatio: 0.04,
      subjectHighlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('UNDER_EXPOSED');
  });

  it('keeps a dark confirmed face as review when clipping is not severe', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 52,
      darkClipRatio: 0.42,
      highlightClipRatio: 0.01,
      subjectReliable: true,
      subjectMeanLuma: 48,
      subjectDarkClipRatio: 0.46,
      subjectHighlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    const underIssue = issues.find(issue => issue.code === 'UNDER_EXPOSED');
    expect(underIssue?.level).toBe('REVIEW_HINT');
  });

  it('still hard-flags underexposure when the confirmed face has large dead-shadow loss', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 48,
      darkClipRatio: 0.44,
      highlightClipRatio: 0.01,
      subjectReliable: true,
      subjectMeanLuma: 42,
      subjectDarkClipRatio: 0.58,
      subjectHighlightClipRatio: 0.01,
    }, DEFAULT_AI_SETTINGS);

    const underIssue = issues.find(issue => issue.code === 'UNDER_EXPOSED');
    expect(underIssue?.level).toBe('ISSUE');
  });

  it('downgrades full-image exposure problems when faces exist but no primary subject is reliable', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 48,
      darkClipRatio: 0.44,
      highlightClipRatio: 0.01,
      faceCount: 2,
      subjectReliable: false,
      primarySubjectCount: 0,
    }, DEFAULT_AI_SETTINGS);

    const underIssue = issues.find(issue => issue.code === 'UNDER_EXPOSED');
    expect(underIssue?.level).toBe('REVIEW_HINT');
  });

  it('adds an exposure review hint for backlit high-contrast scenic frames', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 112,
      darkClipRatio: 0.06,
      highlightClipRatio: 0.01,
      shadowRatio: 0.38,
      highlightRatio: 0.24,
      midtoneMeanLuma: 112,
      p10Luma: 46,
      p90Luma: 192,
      subjectReliable: false,
      faceCount: 0,
      primarySubjectCount: 0,
    }, DEFAULT_AI_SETTINGS);

    const underIssue = issues.find(issue => issue.code === 'UNDER_EXPOSED');
    expect(underIssue?.level).toBe('REVIEW_HINT');
  });

  it('flags closed eyes at the standard blink threshold', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
      eyeClosedScore: 0.74,
      eyeClosedFaceCount: 1,
      primarySubjectCount: 1,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).toContain('EYES_CLOSED');
  });

  it('does not flag closed eyes from a scalar score without a closed face diagnostic', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
      eyeClosedScore: 0.92,
      eyeClosedFaceCount: 0,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('EYES_CLOSED');
  });

  it('does not flag closed eyes from non-primary face diagnostics', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
      faceCount: 2,
      primarySubjectCount: 1,
      eyeClosedScore: 0.92,
      eyeClosedFaceCount: 0,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('EYES_CLOSED');
  });

  it('flags closed eyes for any valid member in a group portrait', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
      faceCount: 5,
      primarySubjectCount: 0,
      eyeClosedScore: 0.76,
      eyeClosedFaceCount: 1,
      groupFaceCount: 5,
      groupEyeClosedFaceCount: 1,
    }, DEFAULT_AI_SETTINGS);

    const eyeIssue = issues.find(issue => issue.code === 'EYES_CLOSED');
    expect(eyeIssue?.level).toBe('ISSUE');
    expect(eyeIssue?.message).toContain('group portrait');
  });

  it('keeps clear group portraits out of the AI review queue', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
      faceCount: 5,
      primarySubjectCount: 0,
      eyeClosedScore: 0.12,
      eyeClosedFaceCount: 0,
      eyeReviewFaceCount: 0,
      groupFaceCount: 5,
      groupEyeClosedFaceCount: 0,
      groupEyeReviewFaceCount: 0,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('EYES_CLOSED');
  });

  it('adds a review hint for ambiguous closed eyes in a group portrait', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
      faceCount: 5,
      primarySubjectCount: 0,
      eyeReviewScore: 0.54,
      eyeReviewFaceCount: 1,
      groupFaceCount: 5,
      groupEyeClosedFaceCount: 0,
      groupEyeReviewFaceCount: 1,
    }, DEFAULT_AI_SETTINGS);

    const eyeIssue = issues.find(issue => issue.code === 'EYES_CLOSED');
    expect(eyeIssue?.level).toBe('REVIEW_HINT');
    expect(eyeIssue?.message).toContain('group portrait');
  });

  it('downgrades closed eyes when subject selection is low confidence', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
      primarySubjectCount: 1,
      subjectConfidence: 'LOW',
      eyeClosedScore: 0.74,
      eyeClosedFaceCount: 1,
      eyeReviewScore: 0.74,
      eyeReviewFaceCount: 1,
    }, DEFAULT_AI_SETTINGS);

    const eyeIssue = issues.find(issue => issue.code === 'EYES_CLOSED');
    expect(eyeIssue?.level).toBe('REVIEW_HINT');
  });

  it('does not treat one-eye or insufficient eye data as closed eyes', () => {
    const issues = classifyAiIssues({
      sharpness: 80,
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
      eyeClosedScore: 0.58,
      eyeClosedFaceCount: 0,
    }, DEFAULT_AI_SETTINGS);

    expect(issues.map(issue => issue.code)).not.toContain('EYES_CLOSED');
  });

  it('honors disabled checks during classification', () => {
    const settings = normalizeAiSettings({
      enabledChecks: {
        ...DEFAULT_AI_SETTINGS.enabledChecks,
        OUT_OF_FOCUS: false,
      },
    });
    const issues = classifyAiIssues({
      sharpness: 10,
      tenengrad: 10,
      edgeDensity: 0.2,
      focusTextureScore: 10,
      focusReliable: true,
      focusMode: 'FACE_ROI',
      meanLuma: 130,
      darkClipRatio: 0.01,
      highlightClipRatio: 0.01,
    }, settings);

    expect(issues.map(issue => issue.code)).not.toContain('OUT_OF_FOCUS');
  });
});
