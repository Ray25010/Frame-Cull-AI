import { describe, expect, it } from 'vitest';
import type { AiDiagnostics, AiIssue, AiMetrics } from '../types';
import { buildPhotoScore } from './photoScoring';

const focusIssue: AiIssue = {
  code: 'OUT_OF_FOCUS',
  level: 'ISSUE',
  confidence: 0.82,
  score: 18,
  threshold: 35,
  message: 'Soft focus',
};

const strongPortraitMetrics: AiMetrics = {
  focusTextureScore: 78,
  focusPeakTextureScore: 92,
  tenengrad: 86,
  focusReliabilityScore: 0.9,
  focusReliable: true,
  faceQualityScore: 0.88,
  eyeReliability: 0.86,
  poseReliability: 0.84,
  subjectExposureScore: 0.52,
  subjectMeanLuma: 134,
  subjectDarkClipRatio: 0.02,
  subjectHighlightClipRatio: 0.03,
  primarySubjectCount: 1,
  subjectConfidenceScore: 0.9,
};

const strongPortraitDiagnostics: AiDiagnostics = {
  faceDiagnostics: [{
    index: 0,
    x: 0.36,
    y: 0.22,
    width: 0.24,
    height: 0.34,
    faceSizeRatio: 0.16,
    sharpnessScore: 0.9,
    faceQualityScore: 0.88,
    eyeReliability: 0.86,
    poseReliability: 0.84,
    lookAtCameraScore: 0.9,
    centerScore: 0.86,
    sizeScore: 0.82,
    cropSafetyScore: 0.92,
    subjectRole: 'PRIMARY',
    subjectScore: 0.9,
    landmarkerStatus: 'OK',
    closed: false,
  }],
  primaryFaceIndices: [0],
  primarySubjectCount: 1,
  subjectConfidence: 'HIGH',
  photoKind: 'STANDARD',
};

describe('photo scoring', () => {
  it('raises the score for clear portraits with strong focus and composition', () => {
    const strong = buildPhotoScore({
      metrics: strongPortraitMetrics,
      diagnostics: strongPortraitDiagnostics,
      issues: [],
    });
    const weak = buildPhotoScore({
      metrics: {
        ...strongPortraitMetrics,
        focusTextureScore: 28,
        focusPeakTextureScore: 35,
        focusReliabilityScore: 0.42,
        faceQualityScore: 0.38,
        eyeReliability: 0.44,
        poseReliability: 0.42,
        subjectExposureScore: 0.28,
        subjectDarkClipRatio: 0.18,
      },
      diagnostics: {
        ...strongPortraitDiagnostics,
        faceDiagnostics: [{
          ...strongPortraitDiagnostics.faceDiagnostics![0],
          sharpnessScore: 0.36,
          faceQualityScore: 0.38,
          lookAtCameraScore: 0.42,
          centerScore: 0.38,
          cropSafetyScore: 0.45,
        }],
      },
      issues: [],
    });

    expect(strong.overall).toBeGreaterThan(weak.overall);
    expect(strong.components.find(component => component.key === 'SCENE_FIT')?.score).toBeGreaterThan(70);
  });

  it('penalizes hard AI issues', () => {
    const clear = buildPhotoScore({
      metrics: strongPortraitMetrics,
      diagnostics: strongPortraitDiagnostics,
      issues: [],
    });
    const flagged = buildPhotoScore({
      metrics: strongPortraitMetrics,
      diagnostics: strongPortraitDiagnostics,
      issues: [focusIssue],
    });

    expect(flagged.overall).toBeLessThan(clear.overall);
    expect(flagged.components.find(component => component.key === 'AI_RISK')?.score).toBeLessThan(
      clear.components.find(component => component.key === 'AI_RISK')?.score ?? 100,
    );
  });

  it('uses a valid non-portrait fallback when no face diagnostics exist', () => {
    const score = buildPhotoScore({
      metrics: {
        focusTextureScore: 70,
        focusPeakTextureScore: 80,
        tenengrad: 75,
        edgeDensity: 0.08,
        focusReliabilityScore: 0.74,
        subjectExposureScore: 0.5,
        darkClipRatio: 0.02,
        highlightClipRatio: 0.02,
      },
      diagnostics: { photoKind: 'STANDARD' },
      issues: [],
    });

    expect(score.overall).toBeGreaterThan(0);
    expect(score.overall).toBeLessThanOrEqual(100);
    expect(score.components).toHaveLength(5);
  });

  it('uses NIMA aesthetic score to lift strong back-view or empty-scene candidates', () => {
    const score = buildPhotoScore({
      metrics: {
        focusTextureScore: 82,
        focusPeakTextureScore: 92,
        tenengrad: 88,
        edgeDensity: 0.08,
        focusReliabilityScore: 0.86,
        subjectExposureScore: 0.5,
        darkClipRatio: 0.01,
        highlightClipRatio: 0.01,
      },
      diagnostics: { photoKind: 'STANDARD', primarySubjectCount: 0 },
      issues: [],
      aesthetic: {
        status: 'READY',
        score: 88,
        modelVersion: 'test-nima',
      },
    });

    expect(score.overall).toBeGreaterThanOrEqual(74);
    expect(score.components.find(component => component.key === 'AESTHETIC_QUALITY')?.score).toBeGreaterThanOrEqual(88);
  });

  it('does not bury a strong recoverable frame for moderate exposure drift', () => {
    const score = buildPhotoScore({
      metrics: {
        focusTextureScore: 82,
        focusPeakTextureScore: 94,
        tenengrad: 88,
        edgeDensity: 0.09,
        focusReliabilityScore: 0.86,
        meanLuma: 82,
        darkClipRatio: 0.12,
        highlightClipRatio: 0.02,
        shadowRatio: 0.32,
        highlightRatio: 0.08,
      },
      diagnostics: { photoKind: 'STANDARD', primarySubjectCount: 0 },
      issues: [{
        code: 'UNDER_EXPOSED',
        level: 'REVIEW_HINT',
        confidence: 0.68,
        score: 0.12,
        threshold: 0.35,
        message: 'Recoverable shadow exposure.',
      }],
      aesthetic: {
        status: 'READY',
        score: 84,
        modelVersion: 'test-nima',
      },
    });

    expect(score.overall).toBeGreaterThanOrEqual(70);
    expect(score.components.find(component => component.key === 'AI_RISK')?.score).toBeGreaterThanOrEqual(90);
  });

  it('does not fail low-texture environmental frames without a hard focus issue', () => {
    const score = buildPhotoScore({
      metrics: {
        focusTextureScore: 17,
        focusPeakTextureScore: 17,
        tenengrad: 44,
        edgeDensity: 0.04,
        focusReliabilityScore: 0.48,
        focusReliable: false,
        subjectExposureScore: 0.5,
        darkClipRatio: 0.02,
        highlightClipRatio: 0.02,
      },
      diagnostics: { photoKind: 'STANDARD', primarySubjectCount: 0 },
      issues: [],
      aesthetic: {
        status: 'READY',
        score: 75,
        modelVersion: 'test-nima',
      },
    });

    expect(score.overall).toBeGreaterThan(50);
    expect(score.gates?.technicalPass).toBe(true);
    expect(score.gates?.aiPickedEligible).toBe(true);
  });

  it('scores large scenic frames with tiny people by scene quality instead of portrait focus', () => {
    const score = buildPhotoScore({
      metrics: {
        focusTextureScore: 22,
        focusPeakTextureScore: 70,
        tenengrad: 62,
        edgeDensity: 0.07,
        focusReliabilityScore: 0.48,
        focusReliable: false,
        meanLuma: 132,
        subjectMeanLuma: 108,
        subjectExposureScore: 0.42,
        darkClipRatio: 0.03,
        highlightClipRatio: 0.01,
        subjectDarkClipRatio: 0.08,
        subjectHighlightClipRatio: 0.01,
        faceCount: 1,
        faceCandidateCount: 1,
        primarySubjectCount: 0,
        subjectConfidence: 'LOW',
      },
      diagnostics: {
        photoKind: 'STANDARD',
        primarySubjectCount: 0,
        subjectConfidence: 'LOW',
        faceDiagnostics: [{
          index: 0,
          x: 0.44,
          y: 0.62,
          width: 0.035,
          height: 0.065,
          faceSizeRatio: 0.002,
          sharpnessScore: 0.34,
          faceQualityScore: 0.28,
          lookAtCameraScore: 0.18,
          centerScore: 0.46,
          cropSafetyScore: 0.86,
          subjectScore: 0.24,
          landmarkerStatus: 'SKIPPED',
          closed: false,
        }],
      },
      issues: [],
      aesthetic: {
        status: 'READY',
        score: 77,
        modelVersion: 'test-nima',
      },
    });

    expect(score.components.find(component => component.key === 'TECHNICAL_QUALITY')?.score).toBeGreaterThanOrEqual(55);
    expect(score.components.find(component => component.key === 'SCENE_FIT')?.score).toBeGreaterThanOrEqual(72);
    expect(score.overall).toBeGreaterThanOrEqual(70);
    expect(score.gates?.technicalPass).toBe(true);
  });

  it('keeps technically weak photos out of AI picks even with a high aesthetic score', () => {
    const score = buildPhotoScore({
      metrics: {
        focusTextureScore: 26,
        focusPeakTextureScore: 34,
        tenengrad: 32,
        edgeDensity: 0.03,
        focusReliabilityScore: 0.34,
        subjectExposureScore: 0.52,
        darkClipRatio: 0.01,
        highlightClipRatio: 0.01,
      },
      diagnostics: { photoKind: 'STANDARD' },
      issues: [],
      aesthetic: {
        status: 'READY',
        score: 90,
        modelVersion: 'test-nima',
      },
    });

    expect(score.components.find(component => component.key === 'TECHNICAL_QUALITY')?.score).toBeLessThan(68);
    expect(score.gates?.aiPickedEligible).toBe(false);
  });

  it('fails out-of-focus photos even when the aesthetic model score is high', () => {
    const score = buildPhotoScore({
      metrics: strongPortraitMetrics,
      diagnostics: strongPortraitDiagnostics,
      issues: [focusIssue],
      aesthetic: {
        status: 'READY',
        score: 95,
        modelVersion: 'test-nima',
      },
    });

    expect(score.overall).toBeLessThan(50);
    expect(score.grade).toBe('REVIEW');
    expect(score.components.find(component => component.key === 'TECHNICAL_QUALITY')?.score).toBeLessThan(40);
    expect(score.gates?.technicalPass).toBe(false);
    expect(score.gates?.aiPickedEligible).toBe(false);
  });

  it('treats extremely blurry metrics as failing even before an issue is attached', () => {
    const score = buildPhotoScore({
      metrics: {
        focusTextureScore: 22,
        focusPeakTextureScore: 31,
        tenengrad: 28,
        edgeDensity: 0.02,
        focusReliabilityScore: 0.4,
        focusReliable: false,
        subjectExposureScore: 0.52,
        darkClipRatio: 0.01,
        highlightClipRatio: 0.01,
      },
      diagnostics: { photoKind: 'STANDARD' },
      issues: [],
      aesthetic: {
        status: 'READY',
        score: 92,
        modelVersion: 'test-nima',
      },
    });

    expect(score.overall).toBeLessThan(50);
    expect(score.gates?.technicalPass).toBe(false);
    expect(score.gates?.aiPickedEligible).toBe(false);
  });
});
