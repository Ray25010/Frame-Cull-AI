import { describe, expect, it } from 'vitest';
import { rankSubjects, type SubjectRankInput } from './subjectRanker';

const baseFace = (overrides: Partial<SubjectRankInput>): SubjectRankInput => ({
  index: 0,
  x: 0.42,
  y: 0.24,
  width: 0.16,
  height: 0.18,
  faceSizeRatio: 0.14,
  faceQualityScore: 0.82,
  eyeReliability: 0.82,
  poseReliability: 0.82,
  sharpnessScore: 0.78,
  landmarkerStatus: 'OK',
  ...overrides,
});

describe('subject ranker', () => {
  it('selects a centered reliable face as the primary subject', () => {
    const result = rankSubjects([baseFace({ index: 0 })]);

    expect(result.primaryFaceIndices).toEqual([0]);
    expect(result.primarySubjectCount).toBe(1);
    expect(result.faces[0].subjectRole).toBe('PRIMARY');
  });

  it('selects two parallel main subjects when scores are close', () => {
    const result = rankSubjects([
      baseFace({ index: 0, x: 0.34, y: 0.24 }),
      baseFace({ index: 1, x: 0.52, y: 0.25, faceSizeRatio: 0.13, width: 0.15, height: 0.17 }),
      baseFace({ index: 2, x: 0.82, y: 0.2, width: 0.06, height: 0.07, faceSizeRatio: 0.05, eyeReliability: 0.42 }),
    ]);

    expect(result.primaryFaceIndices.sort()).toEqual([0, 1]);
    expect(result.primarySubjectCount).toBe(2);
    expect(result.faces.find(face => face.index === 2)?.subjectRole).not.toBe('PRIMARY');
  });

  it('keeps a closed background passerby out of primary subject decisions', () => {
    const result = rankSubjects([
      baseFace({ index: 0 }),
      baseFace({
        index: 1,
        x: 0.83,
        y: 0.18,
        width: 0.045,
        height: 0.055,
        faceSizeRatio: 0.035,
        faceQualityScore: 0.45,
        eyeReliability: 0.18,
        poseReliability: 0.22,
      }),
    ]);

    expect(result.primaryFaceIndices).toEqual([0]);
    expect(result.faces.find(face => face.index === 1)?.subjectRole).toBe('BACKGROUND');
  });

  it('marks a cropped unreliable foreground face as an occluder', () => {
    const result = rankSubjects([
      baseFace({
        index: 0,
        x: 0,
        y: 0.18,
        width: 0.28,
        height: 0.36,
        faceSizeRatio: 0.24,
        faceQualityScore: 0.52,
        eyeReliability: 0.12,
        poseReliability: 0.14,
      }),
      baseFace({ index: 1, x: 0.44, y: 0.25, width: 0.13, height: 0.16, faceSizeRatio: 0.12 }),
    ]);

    expect(result.faces.find(face => face.index === 0)?.subjectRole).toBe('OCCLUDER');
    expect(result.primaryFaceIndices).toEqual([1]);
  });

  it('does not let a larger edge-cropped face steal primary from a centered subject', () => {
    const result = rankSubjects([
      baseFace({
        index: 0,
        x: 0.01,
        y: 0.1,
        width: 0.24,
        height: 0.3,
        faceSizeRatio: 0.22,
        eyeReliability: 0.2,
        poseReliability: 0.16,
      }),
      baseFace({ index: 1, x: 0.43, y: 0.27, width: 0.11, height: 0.13, faceSizeRatio: 0.1 }),
    ]);

    expect(result.faces.find(face => face.index === 0)?.subjectRole).toBe('OCCLUDER');
    expect(result.primaryFaceIndices).toEqual([1]);
  });

  it('reports low confidence when no face is eligible as a primary subject', () => {
    const result = rankSubjects([
      baseFace({
        index: 0,
        width: 0.05,
        height: 0.055,
        faceSizeRatio: 0.03,
        faceQualityScore: 0.28,
        eyeReliability: 0.12,
      }),
    ]);

    expect(result.primarySubjectCount).toBe(0);
    expect(result.subjectConfidence).toBe('LOW');
    expect(result.subjectDecision).toContain('Subject unclear');
  });
});
