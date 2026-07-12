import { describe, expect, it } from 'vitest';
import { GroupStatus, SelectionState, type AiAnalysis, type AiIssue, type DuplicateGroup, type PhotoGroup } from '../types';
import { buildEditionAiPickedPhotoIds } from '../editions/buildAiPickedPhotoIds.pro';
import { buildAiPickedPhotoIds } from './photoScoring';
import { buildProPersonaPickedPhotoIds, PRO_PERSONA_RANKING_VERSION, proPersonaRankScore } from './proPersonaRanking';

const hardFocusIssue: AiIssue = {
  code: 'OUT_OF_FOCUS',
  level: 'ISSUE',
  confidence: 0.9,
  score: 10,
  threshold: 35,
  message: 'Out of focus',
};

const reviewHint: AiIssue = {
  code: 'OVER_EXPOSED',
  level: 'REVIEW_HINT',
  confidence: 0.7,
  score: 0.1,
  threshold: 0.08,
  message: 'Review highlight',
};

function makeAi(overrides: Partial<AiAnalysis> = {}): AiAnalysis {
  const issues = overrides.issues ?? [];
  return {
    status: 'DONE',
    issues,
    confidence: 0.9,
    preset: 'standard',
    reviewed: false,
    modelVersion: 'test',
    metrics: {
      focusTextureScore: 68,
      focusPeakTextureScore: 72,
      focusReliabilityScore: 0.78,
      tenengrad: 80,
      ...overrides.metrics,
    },
    photoScore: {
      version: 'test-score',
      overall: 78,
      grade: 'GOOD',
      summary: 'Good',
      components: [
        { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 74, weight: 35 },
        { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 72, weight: 25 },
        { key: 'SCENE_FIT', label: 'Scene', score: 70, weight: 15 },
        { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 70, weight: 15 },
        { key: 'AI_RISK', label: 'Risk', score: issues.some(issue => issue.level === 'ISSUE') ? 30 : 100, weight: 10 },
      ],
      gates: {
        aiPickedEligible: !issues.some(issue => issue.level === 'ISSUE'),
        technicalPass: true,
        duplicateBestPass: true,
        reasons: [],
      },
    },
    proScores: {
      aesthetic: 0.72,
      personaScore: 0.5,
    },
    ...overrides,
  };
}

function makePhoto(id: string, overrides: Partial<PhotoGroup> = {}): PhotoGroup {
  return {
    id,
    status: GroupStatus.COMPLETE,
    selection: SelectionState.UNMARKED,
    rating: 0,
    jpg: {
      name: `${id}.JPG`,
      extension: 'JPG',
      file: null as unknown as File,
      previewUrl: `asset://${id}.JPG`,
      size: 2048,
      modifiedMs: 1710000000000 + (Number(id.match(/(\d+)$/)?.[1] ?? 0) * 1000),
      path: `C:/photos/session/${id}.JPG`,
    },
    ai: makeAi(),
    ...overrides,
  };
}

describe('Pro persona ranking', () => {
  it('defaults the v16b production profile to semantic persona-only while keeping flash-persona available', () => {
    const photo = makePhoto('IMG_0009', {
      ai: makeAi({
        issues: [reviewHint],
        metrics: {
          focusReliabilityScore: 0.8,
        },
        photoScore: {
          ...makeAi().photoScore!,
          overall: 80,
          components: [
            { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 70, weight: 35 },
            { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 61, weight: 25 },
            { key: 'SCENE_FIT', label: 'Scene', score: 60, weight: 15 },
            { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 70, weight: 15 },
            { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
          ],
        },
        proScores: {
          aesthetic: 0.65,
          personaScore: 0.7,
        },
      }),
    });

    const expectedPersonaOnly = 80 * 0.54 + 70 * 0.28 + 60 * 0.24 + 65 * 0.14 + 0.7 * 46 + 0.8 * 4.5 - 4;

    expect(PRO_PERSONA_RANKING_VERSION).toBe('pro-persona-ranking-v16b-persona-only');
    expect(proPersonaRankScore(photo)).toBeCloseTo(expectedPersonaOnly, 6);
    expect(proPersonaRankScore(photo, 'pro-semantic-v2-persona-only')).toBeCloseTo(expectedPersonaOnly, 6);
    expect(proPersonaRankScore(photo, 'pro-semantic-v2-flash-persona')).not.toBeCloseTo(expectedPersonaOnly, 6);
  });

  it('keeps the production wrapper identical to current AI picks when disabled', () => {
    const photos = [
      makePhoto('IMG_0001'),
      makePhoto('IMG_0002', {
        ai: makeAi({
          photoScore: {
            ...makeAi().photoScore!,
            overall: 90,
          },
        }),
      }),
    ];

    const current = buildAiPickedPhotoIds(photos, undefined, undefined, 0.5, []);
    const disabled = buildEditionAiPickedPhotoIds(photos, undefined, undefined, 0.5, [], {
      enabledChecks: {
        OUT_OF_FOCUS: true,
        UNDER_EXPOSED: true,
        OVER_EXPOSED: true,
        EYES_CLOSED: true,
      },
      sensitivity: 'standard',
      sensitivityByCheck: {
        OUT_OF_FOCUS: 'standard',
        UNDER_EXPOSED: 'standard',
        OVER_EXPOSED: 'standard',
        EYES_CLOSED: 'standard',
      },
      duplicateSensitivity: 'standard',
      duplicateAlwaysRecommendOne: true,
      aiPickTargetRatio: 0.5,
      proPersonaRanking: {
        enabled: false,
      },
    });

    expect(disabled).toEqual(current);
  });

  it('uses student persona as a ranking feature without rating or manual pick leakage', () => {
    const highPersona = makePhoto('IMG_0100', {
      rating: 0,
      selection: SelectionState.UNMARKED,
      ai: makeAi({
        proScores: {
          aesthetic: 0.62,
          personaScore: 0.88,
        },
      }),
    });
    const highManualSignal = makePhoto('IMG_0101', {
      rating: 5,
      selection: SelectionState.PICKED,
      ai: makeAi({
        proScores: {
          aesthetic: 0.92,
          personaScore: 0.18,
        },
      }),
    });

    expect(proPersonaRankScore(highPersona)).toBeGreaterThan(proPersonaRankScore(highManualSignal));
    expect(buildProPersonaPickedPhotoIds([highPersona, highManualSignal], 0.5)).toEqual(new Set(['IMG_0100']));
  });

  it('keeps one persona-ranked representative from a known duplicate group', () => {
    const lowPersona = makePhoto('IMG_0201', {
      ai: makeAi({ proScores: { aesthetic: 0.7, personaScore: 0.32 } }),
    });
    const highPersona = makePhoto('IMG_0202', {
      ai: makeAi({ proScores: { aesthetic: 0.7, personaScore: 0.82 } }),
    });
    const group: DuplicateGroup = {
      id: 'dup-1',
      photoIds: [lowPersona.id, highPersona.id],
      bestPhotoId: lowPersona.id,
      similarity: 0.98,
      sensitivity: 'standard',
      createdAt: 1,
      matches: [],
    };

    expect(buildProPersonaPickedPhotoIds([lowPersona, highPersona], 0.38, [group])).toEqual(new Set(['IMG_0202']));
  });

  it('uses the v16 pair-threshold profile at 50% and suppresses duplicate non-representatives', () => {
    const photos = [
      makePhoto('IMG_0301', { ai: makeAi({ proScores: { aesthetic: 0.7, personaScore: 0.2 } }) }),
      makePhoto('IMG_0302', { ai: makeAi({ proScores: { aesthetic: 0.7, personaScore: 0.9 } }) }),
      makePhoto('IMG_0310', { ai: makeAi({ proScores: { aesthetic: 0.7, personaScore: 0.75 } }) }),
    ];

    const picked = buildProPersonaPickedPhotoIds(photos, 0.5, [], {
      pairSimilarities: [{
        leftId: 'IMG_0301',
        rightId: 'IMG_0302',
        similarity: 0.95,
        numericGap: 1,
        timeGapMs: 1000,
        candidate: true,
      }],
    });

    expect(picked).toEqual(new Set(['IMG_0302', 'IMG_0310']));
  });

  it('does not rescue hard issue or rejected photos with high persona scores', () => {
    const hardIssue = makePhoto('IMG_0401', {
      ai: makeAi({
        issues: [hardFocusIssue],
        proScores: { aesthetic: 1, personaScore: 1 },
      }),
    });
    const rejected = makePhoto('IMG_0402', {
      selection: SelectionState.REJECTED,
      ai: makeAi({
        proScores: { aesthetic: 1, personaScore: 1 },
      }),
    });
    const reviewOnly = makePhoto('IMG_0403', {
      ai: makeAi({
        issues: [reviewHint],
        proScores: { aesthetic: 0.6, personaScore: 0.7 },
      }),
    });

    expect(buildProPersonaPickedPhotoIds([hardIssue, rejected, reviewOnly], 1)).toEqual(new Set(['IMG_0403']));
  });
});
