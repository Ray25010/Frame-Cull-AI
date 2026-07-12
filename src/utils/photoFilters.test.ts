import { describe, expect, it } from 'vitest';
import { GroupStatus, SelectionState, type AiAnalysis, type AiIssue, type PhotoGroup, type PhotoRating } from '../types';
import { filterPhotos, isAiNormalPhoto, isAiReviewPhoto, isGroupPhoto, matchesStatusFilter, STATUS_FILTERS } from './photoFilters';
import { buildAiPickedPhotoIds } from './photoScoring';

const basePhoto: PhotoGroup = {
  id: 'IMG_0001',
  status: GroupStatus.COMPLETE,
  selection: SelectionState.UNMARKED,
  rating: 0,
  jpg: {
    name: 'IMG_0001.JPG',
    extension: 'JPG',
    file: null as unknown as File,
    previewUrl: 'asset://IMG_0001.JPG',
    size: 2048,
    modifiedMs: 1710000000000,
    path: 'C:/photos/IMG_0001.JPG',
  },
};

const focusIssue: AiIssue = {
  code: 'OUT_OF_FOCUS',
  level: 'REVIEW_HINT',
  confidence: 0.64,
  score: 22,
  threshold: 35,
  message: 'Possible soft focus',
};

const exposureHint: AiIssue = {
  code: 'OVER_EXPOSED',
  level: 'REVIEW_HINT',
  confidence: 0.58,
  score: 0.1,
  threshold: 0.08,
  message: 'Possible highlight clipping',
};

function makeAi(overrides: Partial<AiAnalysis> = {}): AiAnalysis {
  const issues = overrides.issues ?? [];
  const score = overrides.photoScore ?? {
    version: 'test-score',
    overall: issues.length > 0 ? 70 : 82,
    grade: issues.length > 0 ? 'FAIR' : 'GOOD',
    summary: issues.length > 0 ? 'Review' : 'Good',
    components: [
      { key: 'TECHNICAL_QUALITY' as const, label: 'Technical', score: 78, weight: 35 },
      { key: 'AESTHETIC_QUALITY' as const, label: 'Aesthetic', score: 80, weight: 25 },
      { key: 'SCENE_FIT' as const, label: 'Scene', score: 80, weight: 15 },
      { key: 'EXPOSURE_LATITUDE' as const, label: 'Exposure', score: 80, weight: 15 },
      { key: 'AI_RISK' as const, label: 'Risk', score: issues.length > 0 ? 70 : 100, weight: 10 },
    ],
    gates: {
      aiPickedEligible: issues.length === 0,
      technicalPass: true,
      duplicateBestPass: true,
      reasons: issues.length > 0 ? ['AI review issues are present.'] : [],
    },
  };
  return {
    status: 'DONE',
    issues,
    confidence: 0,
    preset: 'standard',
    reviewed: false,
    modelVersion: 'test-model',
    photoScore: score,
    ...overrides,
  };
}

function makePhoto(id: string, overrides: Partial<PhotoGroup> = {}): PhotoGroup {
  return {
    ...basePhoto,
    id,
    jpg: basePhoto.jpg ? { ...basePhoto.jpg, name: `${id}.JPG`, path: `C:/photos/${id}.JPG` } : undefined,
    ...overrides,
  };
}

describe('photo status filters', () => {
  it('keeps group photo directly after AI review in the filmstrip filter order', () => {
    expect(STATUS_FILTERS.slice(0, 6)).toEqual(['ALL', 'AI_NORMAL', 'AI_PICKED', 'AI_REVIEW', 'GROUP_PHOTO', 'DUPLICATES']);
  });

  it('matches AI review only for photos with unreviewed AI issues', () => {
    const reviewPhoto = makePhoto('review', { ai: makeAi({ issues: [focusIssue], reviewed: false }) });
    const reviewedPhoto = makePhoto('reviewed', { ai: makeAi({ issues: [focusIssue], reviewed: true }) });
    const clearPhoto = makePhoto('clear', { ai: makeAi({ issues: [] }) });

    expect(isAiReviewPhoto(reviewPhoto)).toBe(true);
    expect(matchesStatusFilter(reviewPhoto, 'AI_REVIEW')).toBe(true);
    expect(isAiReviewPhoto(reviewedPhoto)).toBe(false);
    expect(isAiReviewPhoto(clearPhoto)).toBe(false);
  });

  it('matches AI normal for completed analysis that is not waiting for review', () => {
    const clearPhoto = makePhoto('clear', { ai: makeAi({ issues: [] }) });
    const reviewedIssuePhoto = makePhoto('reviewed-issue', { ai: makeAi({ issues: [focusIssue], reviewed: true }) });
    const reviewPhoto = makePhoto('review', { ai: makeAi({ issues: [focusIssue], reviewed: false }) });

    expect(isAiNormalPhoto(clearPhoto)).toBe(true);
    expect(isAiNormalPhoto(reviewedIssuePhoto)).toBe(true);
    expect(isAiNormalPhoto(reviewPhoto)).toBe(false);
    expect(matchesStatusFilter(clearPhoto, 'AI_NORMAL')).toBe(true);
  });

  it('excludes unanalyzed and unfinished AI states from AI normal', () => {
    const statuses: Array<AiAnalysis['status'] | undefined> = [undefined, 'PENDING', 'ANALYZING', 'ERROR', 'SKIPPED'];

    statuses.forEach((status, index) => {
      const photo = makePhoto(`not-normal-${index}`, {
        ai: status ? makeAi({ status }) : undefined,
      });

      expect(isAiNormalPhoto(photo)).toBe(false);
      expect(matchesStatusFilter(photo, 'AI_NORMAL')).toBe(false);
    });
  });

  it('combines AI normal with star rating filters', () => {
    const photos = [
      makePhoto('clear-5', { rating: 5, ai: makeAi() }),
      makePhoto('clear-3', { rating: 3, ai: makeAi() }),
      makePhoto('review-5', { rating: 5, ai: makeAi({ issues: [focusIssue], reviewed: false }) }),
      makePhoto('pending-5', { rating: 5, ai: makeAi({ status: 'ANALYZING' }) }),
    ];

    expect(filterPhotos(photos, 'AI_NORMAL', 'RATING_4_PLUS').map(photo => photo.id)).toEqual(['clear-5']);
  });

  it('matches AI picked for analyzed photos without hard gates failing', () => {
    const clearPhoto = makePhoto('clear', { ai: makeAi({ issues: [] }) });
    const reviewPhoto = makePhoto('review', { ai: makeAi({ issues: [exposureHint] }) });
    const hardIssuePhoto = makePhoto('hard-issue', {
      ai: makeAi({
        issues: [{
          ...focusIssue,
          level: 'ISSUE',
        }],
      }),
    });
    const pendingPhoto = makePhoto('pending', { ai: makeAi({ status: 'ANALYZING', issues: [] }) });

    expect(matchesStatusFilter(clearPhoto, 'AI_PICKED')).toBe(true);
    expect(matchesStatusFilter(reviewPhoto, 'AI_PICKED')).toBe(true);
    expect(matchesStatusFilter(hardIssuePhoto, 'AI_PICKED')).toBe(false);
    expect(matchesStatusFilter(pendingPhoto, 'AI_PICKED')).toBe(false);
  });

  it('excludes low-scoring or low-technical photos from AI picked', () => {
    const lowScore = makePhoto('low-score', {
      ai: makeAi({
        photoScore: {
          version: 'test-score',
          overall: 32,
          grade: 'FAIR',
          summary: 'Low',
          components: [
            { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 74, weight: 35 },
            { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 64, weight: 25 },
            { key: 'SCENE_FIT', label: 'Scene', score: 64, weight: 15 },
            { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 70, weight: 15 },
            { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
          ],
          gates: {
            aiPickedEligible: false,
            technicalPass: true,
            duplicateBestPass: true,
            reasons: ['Photo score is below 38.'],
          },
        },
      }),
    });
    const blurry = makePhoto('blurry', {
      ai: makeAi({
        photoScore: {
          version: 'test-score',
          overall: 78,
          grade: 'GOOD',
          summary: 'Blurry',
          components: [
            { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 18, weight: 35 },
            { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 90, weight: 25 },
            { key: 'SCENE_FIT', label: 'Scene', score: 88, weight: 15 },
            { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 82, weight: 15 },
            { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
          ],
          gates: {
            aiPickedEligible: false,
            technicalPass: false,
            duplicateBestPass: true,
            reasons: ['Technical quality is below 20.'],
          },
        },
      }),
    });

    expect(matchesStatusFilter(lowScore, 'AI_PICKED')).toBe(false);
    expect(matchesStatusFilter(blurry, 'AI_PICKED')).toBe(false);
  });

  it('keeps only duplicate best photos in AI picked', () => {
    const bestDuplicate = makePhoto('best', { rating: 5, ai: makeAi() });
    const nonBestDuplicate = makePhoto('non-best', { rating: 5, ai: makeAi() });
    const normalClear = makePhoto('normal', { rating: 5, ai: makeAi() });
    const duplicateIds = new Set(['best', 'non-best']);
    const bestIds = new Set(['best']);

    expect(matchesStatusFilter(bestDuplicate, 'AI_PICKED', duplicateIds, bestIds)).toBe(true);
    expect(matchesStatusFilter(nonBestDuplicate, 'AI_PICKED', duplicateIds, bestIds)).toBe(false);
    expect(matchesStatusFilter(normalClear, 'AI_PICKED', duplicateIds, bestIds)).toBe(true);
    const aiPickedIds = buildAiPickedPhotoIds([bestDuplicate, nonBestDuplicate, normalClear], bestIds, duplicateIds, 1);
    expect(filterPhotos([bestDuplicate, nonBestDuplicate, normalClear], 'AI_PICKED', 'RATING_4_PLUS', duplicateIds, bestIds, true, aiPickedIds).map(photo => photo.id)).toEqual(['best', 'normal']);
  });

  it('keeps AI picked empty until duplicate grouping is ready', () => {
    const clearPhoto = makePhoto('clear', { ai: makeAi({ issues: [] }) });

    expect(filterPhotos([clearPhoto], 'AI_PICKED', 'RATING_ALL', undefined, undefined, false)).toEqual([]);
  });

  it('builds AI picked as the top batch slice of eligible clear photos', () => {
    const photos = Array.from({ length: 10 }, (_, index) => makePhoto(`photo-${index}`, {
      ai: makeAi({
        photoScore: {
          version: 'test-score',
          overall: 50 + index,
          grade: 'FAIR',
          summary: 'Candidate',
          components: [
            { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 55 + index, weight: 35 },
            { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 60 + index, weight: 25 },
            { key: 'SCENE_FIT', label: 'Scene', score: 60, weight: 15 },
            { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 70, weight: 15 },
            { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
          ],
          gates: {
            aiPickedEligible: true,
            technicalPass: true,
            duplicateBestPass: true,
            reasons: [],
          },
        },
      }),
    }));

    const aiPickedIds = buildAiPickedPhotoIds(photos);
    expect(aiPickedIds.size).toBe(6);
    expect(filterPhotos(photos, 'AI_PICKED', 'RATING_ALL', undefined, undefined, true, aiPickedIds).map(photo => photo.id))
      .toEqual(expect.arrayContaining(['photo-7', 'photo-8', 'photo-9']));
  });

  it('uses the configured AI pick target ratio for solo usable photos', () => {
    const photos = Array.from({ length: 100 }, (_, index) => makePhoto(`solo-${index}`, {
      ai: makeAi({
        photoScore: {
          version: 'test-score',
          overall: 50 + (index % 50),
          grade: 'GOOD',
          summary: 'Candidate',
          components: [
            { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 55 + (index % 45), weight: 35 },
            { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 70, weight: 25 },
            { key: 'SCENE_FIT', label: 'Scene', score: 70, weight: 15 },
            { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 76, weight: 15 },
            { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
          ],
          gates: {
            aiPickedEligible: true,
            technicalPass: true,
            duplicateBestPass: true,
            reasons: [],
          },
        },
      }),
    }));

    expect(buildAiPickedPhotoIds(photos).size).toBe(60);
    expect(buildAiPickedPhotoIds(photos, undefined, undefined, 0.3).size).toBe(30);
    expect(buildAiPickedPhotoIds(photos, undefined, undefined, 0.5).size).toBe(50);
  });

  it('keeps duplicate non-best photos out of batch AI picked', () => {
    const photos = [
      makePhoto('best', { ai: makeAi({ photoScore: makeAi().photoScore }) }),
      makePhoto('non-best', { ai: makeAi({ photoScore: makeAi({ photoScore: { ...makeAi().photoScore!, overall: 95 } }).photoScore }) }),
      makePhoto('normal', { ai: makeAi({ photoScore: makeAi({ photoScore: { ...makeAi().photoScore!, overall: 90 } }).photoScore }) }),
    ];
    const duplicateIds = new Set(['best', 'non-best']);
    const bestIds = new Set(['best']);
    const aiPickedIds = buildAiPickedPhotoIds(photos, bestIds, duplicateIds, 1);

    expect(aiPickedIds.has('non-best')).toBe(false);
    expect(aiPickedIds.has('best')).toBe(true);
    expect(aiPickedIds.has('normal')).toBe(true);
  });

  it('keeps one representative from each compact inferred adjacent burst segment', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(12).fill(1 / 12),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const photos = Array.from({ length: 5 }, (_, index) => makePhoto(`IMG_10${index}`, {
      ai: makeAi({
        duplicateSignature: sharedSignature,
        photoScore: {
          version: 'test-score',
          overall: 70 + index,
          grade: 'GOOD',
          summary: 'Burst',
          components: [
            { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 72 + index, weight: 35 },
            { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 70 + index, weight: 25 },
            { key: 'SCENE_FIT', label: 'Scene', score: 70 + index, weight: 15 },
            { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 76, weight: 15 },
            { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
          ],
          gates: {
            aiPickedEligible: true,
            technicalPass: true,
            duplicateBestPass: true,
            reasons: [],
          },
        },
      }),
    }));

    const aiPickedIds = buildAiPickedPhotoIds(photos, undefined, undefined, 1);
    expect(aiPickedIds.size).toBe(1);
    expect(aiPickedIds.has('IMG_104')).toBe(true);
  });

  it('joins renamed visually similar photos by capture time instead of filename suffix', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const photos = [
      makePhoto('wedding-hero-a', {
        exif: { dateTime: '2026:06:17 10:00:00' },
        ai: makeAi({ duplicateSignature: sharedSignature, photoScore: { ...makeAi().photoScore!, overall: 82 } }),
      }),
      makePhoto('favorite-export-final', {
        exif: { dateTime: '2026:06:17 10:00:04' },
        ai: makeAi({ duplicateSignature: sharedSignature, photoScore: { ...makeAi().photoScore!, overall: 86 } }),
      }),
    ];

    const aiPickedIds = buildAiPickedPhotoIds(photos, undefined, undefined, 1);
    expect(aiPickedIds).toEqual(new Set(['favorite-export-final']));
  });

  it('does not join nearby filenames when capture times are far apart', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const photos = [
      makePhoto('IMG_5000', {
        exif: { dateTime: '2026:06:17 10:00:00' },
        ai: makeAi({ duplicateSignature: sharedSignature, photoScore: { ...makeAi().photoScore!, overall: 82 } }),
      }),
      makePhoto('IMG_5001', {
        exif: { dateTime: '2026:06:17 12:00:00' },
        ai: makeAi({ duplicateSignature: sharedSignature, photoScore: { ...makeAi().photoScore!, overall: 86 } }),
      }),
    ];

    const aiPickedIds = buildAiPickedPhotoIds(photos, undefined, undefined, 1);
    expect(aiPickedIds).toEqual(new Set(['IMG_5000', 'IMG_5001']));
  });

  it('does not collapse adjacent photos when duplicate signatures are visually different', () => {
    const photos = Array.from({ length: 10 }, (_, index) => makePhoto(`IMG_20${index}`, {
      ai: makeAi({
        duplicateSignature: {
          version: 'duplicate-signature-v1',
          width: 100,
          height: 100,
          aspectRatio: 1,
          lumaHash: index % 2 === 0 ? '0000000000000000' : 'ffffffffffffffff',
          structureHash: index % 2 === 0 ? '1111111111111111' : 'eeeeeeeeeeeeeeee',
          colorHistogram: Array.from({ length: 24 }, (_, bin) => (bin === index % 24 ? 1 : 0)),
          lumaHistogram: Array.from({ length: 16 }, (_, bin) => (bin === index % 16 ? 1 : 0)),
          meanLuma: 30 + index * 18,
        },
        photoScore: {
          version: 'test-score',
          overall: 70 + index,
          grade: 'GOOD',
          summary: 'Distinct',
          components: [
            { key: 'TECHNICAL_QUALITY', label: 'Technical', score: 72 + index, weight: 35 },
            { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: 70 + index, weight: 25 },
            { key: 'SCENE_FIT', label: 'Scene', score: 70 + index, weight: 15 },
            { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: 76, weight: 15 },
            { key: 'AI_RISK', label: 'Risk', score: 100, weight: 10 },
          ],
          gates: {
            aiPickedEligible: true,
            technicalPass: true,
            duplicateBestPass: true,
            reasons: [],
          },
        },
      }),
    }));

    const aiPickedIds = buildAiPickedPhotoIds(photos);
    expect(aiPickedIds.size).toBe(6);
    expect(aiPickedIds.has('IMG_209')).toBe(true);
  });

  it('defers highly similar adjacent solo photos until diverse picks are exhausted', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const distinctSignature = {
      ...sharedSignature,
      lumaHash: '1111111111111111',
      structureHash: '2222222222222222',
      colorHistogram: Array.from({ length: 24 }, (_, bin) => (bin === 0 ? 1 : 0)),
      lumaHistogram: Array.from({ length: 16 }, (_, bin) => (bin === 0 ? 1 : 0)),
      meanLuma: 42,
    };
    const makeScored = (id: string, overall: number, duplicateSignature = sharedSignature) => makePhoto(id, {
      ai: makeAi({
        duplicateSignature,
        photoScore: {
          ...makeAi().photoScore!,
          overall,
          components: makeAi().photoScore!.components.map(component => (
            component.key === 'TECHNICAL_QUALITY' ? { ...component, score: overall } : component
          )),
        },
      }),
    });
    const photos = [
      makeScored('IMG_3000', 92, sharedSignature),
      makeScored('IMG_3001', 91, sharedSignature),
      makeScored('IMG_3008', 80, distinctSignature),
    ];

    const aiPickedIds = buildAiPickedPhotoIds(photos, undefined, undefined, 2 / 3);
    expect(aiPickedIds).toEqual(new Set(['IMG_3000', 'IMG_3008']));
  });

  it('fills the target with deferred adjacent solo photos when needed', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const distinctSignature = {
      ...sharedSignature,
      lumaHash: '1111111111111111',
      structureHash: '2222222222222222',
      colorHistogram: Array.from({ length: 24 }, (_, bin) => (bin === 0 ? 1 : 0)),
      lumaHistogram: Array.from({ length: 16 }, (_, bin) => (bin === 0 ? 1 : 0)),
      meanLuma: 42,
    };
    const makeScored = (id: string, overall: number, duplicateSignature = sharedSignature) => makePhoto(id, {
      ai: makeAi({
        duplicateSignature,
        photoScore: {
          ...makeAi().photoScore!,
          overall,
          components: makeAi().photoScore!.components.map(component => (
            component.key === 'TECHNICAL_QUALITY' ? { ...component, score: overall } : component
          )),
        },
      }),
    });
    const photos = [
      makeScored('IMG_4000', 92),
      makeScored('IMG_4001', 91),
      makeScored('IMG_4008', 80, distinctSignature),
    ];
    const duplicateGroups = [{
      id: 'representative-group',
      photoIds: ['IMG_4000'],
      bestPhotoId: 'IMG_4000',
      similarity: 1,
      sensitivity: 'standard' as const,
      createdAt: 1,
      matches: [],
    }];

    const aiPickedIds = buildAiPickedPhotoIds(photos, new Set(['IMG_4000']), new Set(['IMG_4000']), 1, duplicateGroups);
    expect(aiPickedIds.size).toBe(3);
  });

  it('uses the supervised pair-threshold strategy for near-frame AI picks', () => {
    const mostlySharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const photos = ['IMG_1000', 'IMG_1008', 'IMG_1016'].map((id, index) => makePhoto(id, {
      ai: makeAi({
        duplicateSignature: mostlySharedSignature,
        photoScore: {
          ...makeAi().photoScore!,
          overall: 70 + index,
          components: makeAi().photoScore!.components.map(component => (
            component.key === 'TECHNICAL_QUALITY' ? { ...component, score: 72 + index } : component
          )),
        },
      }),
    }));

    const aiPickedIds = buildAiPickedPhotoIds(photos, undefined, undefined, 1);
    expect(aiPickedIds).toEqual(new Set(['IMG_1016']));
  });

  it('keeps one usable representative from every duplicate group', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const photos = [
      makePhoto('burst-1', { ai: makeAi({ duplicateSignature: sharedSignature, photoScore: makeAi({ photoScore: { ...makeAi().photoScore!, overall: 65 } }).photoScore }) }),
      makePhoto('burst-2', { ai: makeAi({ duplicateSignature: sharedSignature, photoScore: makeAi({ photoScore: { ...makeAi().photoScore!, overall: 88 } }).photoScore }) }),
      makePhoto('burst-3', { ai: makeAi({ duplicateSignature: sharedSignature, photoScore: makeAi({ photoScore: { ...makeAi().photoScore!, overall: 83 } }).photoScore }) }),
    ];
    const duplicateIds = new Set(photos.map(photo => photo.id));
    const bestIds = new Set(['burst-1']);
    const duplicateGroups = [{
      id: 'group-1',
      photoIds: photos.map(photo => photo.id),
      bestPhotoId: 'burst-1',
      similarity: 0.92,
      sensitivity: 'standard' as const,
      createdAt: 1,
      matches: [],
    }];

    const aiPickedIds = buildAiPickedPhotoIds(photos, bestIds, duplicateIds, 0.1, duplicateGroups);
    expect(aiPickedIds.size).toBe(1);
    expect(aiPickedIds.has('burst-1')).toBe(true);
  });

  it('reselects duplicate representative when stored trophy best is unusable', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const photos = [
      makePhoto('bad-best', { ai: makeAi({ issues: [focusIssue], duplicateSignature: sharedSignature }) }),
      makePhoto('usable-alt', { ai: makeAi({ duplicateSignature: sharedSignature, photoScore: makeAi({ photoScore: { ...makeAi().photoScore!, overall: 82 } }).photoScore }) }),
    ];
    const duplicateGroups = [{
      id: 'group-1',
      photoIds: photos.map(photo => photo.id),
      bestPhotoId: 'bad-best',
      similarity: 0.92,
      sensitivity: 'standard' as const,
      createdAt: 1,
      matches: [],
    }];

    const aiPickedIds = buildAiPickedPhotoIds(photos, new Set(['bad-best']), new Set(photos.map(photo => photo.id)), 1, duplicateGroups);
    expect(aiPickedIds).toEqual(new Set(['usable-alt']));
  });

  it('prefers the technically stronger duplicate representative over a higher overall soft frame', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const softHighOverall = makePhoto('soft-high-overall', {
      ai: makeAi({
        duplicateSignature: sharedSignature,
        metrics: {
          focusTextureScore: 24,
          focusPeakTextureScore: 28,
          focusReliabilityScore: 0.5,
        },
        photoScore: {
          ...makeAi().photoScore!,
          overall: 90,
          components: makeAi().photoScore!.components.map(component => (
            component.key === 'TECHNICAL_QUALITY' ? { ...component, score: 45 } : component
          )),
        },
      }),
    });
    const sharpLowerOverall = makePhoto('sharp-lower-overall', {
      ai: makeAi({
        duplicateSignature: sharedSignature,
        metrics: {
          focusTextureScore: 78,
          focusPeakTextureScore: 82,
          focusReliabilityScore: 0.82,
        },
        photoScore: {
          ...makeAi().photoScore!,
          overall: 80,
          components: makeAi().photoScore!.components.map(component => (
            component.key === 'TECHNICAL_QUALITY' ? { ...component, score: 86 } : component
          )),
        },
      }),
    });
    const photos = [softHighOverall, sharpLowerOverall];
    const duplicateGroups = [{
      id: 'technical-best-group',
      photoIds: photos.map(photo => photo.id),
      similarity: 0.94,
      sensitivity: 'standard' as const,
      createdAt: 1,
      matches: [],
    }];

    const aiPickedIds = buildAiPickedPhotoIds(photos, undefined, new Set(photos.map(photo => photo.id)), 1, duplicateGroups);
    expect(aiPickedIds).toEqual(new Set(['sharp-lower-overall']));
  });

  it('keeps one representative from each compact segment of an oversized formal duplicate group', () => {
    const sharedSignature = {
      version: 'duplicate-signature-v1' as const,
      width: 100,
      height: 100,
      aspectRatio: 1,
      lumaHash: 'aaaaaaaaaaaaaaaa',
      structureHash: 'bbbbbbbbbbbbbbbb',
      colorHistogram: Array(24).fill(1 / 24),
      lumaHistogram: Array(16).fill(1 / 16),
      meanLuma: 120,
    };
    const photos = Array.from({ length: 9 }, (_, index) => makePhoto(`long-burst-${index}`, {
      ai: makeAi({
        duplicateSignature: sharedSignature,
        photoScore: {
          ...makeAi().photoScore!,
          overall: 70 + index,
          components: makeAi().photoScore!.components.map(component => (
            component.key === 'TECHNICAL_QUALITY' ? { ...component, score: 70 + index } : component
          )),
        },
      }),
    }));
    const duplicateGroups = [{
      id: 'oversized-group',
      photoIds: photos.map(photo => photo.id),
      bestPhotoId: 'long-burst-8',
      similarity: 1,
      sensitivity: 'standard' as const,
      createdAt: 1,
      matches: [],
    }];

    const aiPickedIds = buildAiPickedPhotoIds(photos, new Set(['long-burst-8']), new Set(photos.map(photo => photo.id)), 0.1, duplicateGroups);
    expect(aiPickedIds.size).toBe(2);
    expect(aiPickedIds.has('long-burst-4')).toBe(true);
    expect(aiPickedIds.has('long-burst-8')).toBe(true);
  });

  it('skips a duplicate group representative only when every frame is unusable', () => {
    const photos = [
      makePhoto('bad-1', { ai: makeAi({ issues: [focusIssue] }) }),
      makePhoto('bad-2', { ai: makeAi({ issues: [focusIssue] }) }),
    ];
    const duplicateIds = new Set(photos.map(photo => photo.id));
    const duplicateGroups = [{
      id: 'bad-group',
      photoIds: photos.map(photo => photo.id),
      bestPhotoId: 'bad-1',
      similarity: 0.93,
      sensitivity: 'standard' as const,
      createdAt: 1,
      matches: [],
    }];

    const aiPickedIds = buildAiPickedPhotoIds(photos, new Set(['bad-1']), duplicateIds, 1, duplicateGroups);
    expect(aiPickedIds.size).toBe(0);
  });

  it('keeps existing selection filters independent from AI state', () => {
    const pickedAiReview = makePhoto('picked-review', {
      selection: SelectionState.PICKED,
      rating: 4 as PhotoRating,
      ai: makeAi({ issues: [focusIssue] }),
    });

    expect(matchesStatusFilter(pickedAiReview, 'PICKED')).toBe(true);
    expect(matchesStatusFilter(pickedAiReview, 'AI_REVIEW')).toBe(true);
  });

  it('matches group portrait photos from diagnostics', () => {
    const groupPhoto = makePhoto('group', {
      ai: makeAi({
        diagnostics: {
          photoKind: 'GROUP_PORTRAIT',
          groupFaceIndices: [0, 1, 2],
        },
      }),
    });
    const standardPhoto = makePhoto('single', {
      ai: makeAi({
        diagnostics: {
          photoKind: 'STANDARD',
        },
      }),
    });

    expect(isGroupPhoto(groupPhoto)).toBe(true);
    expect(matchesStatusFilter(groupPhoto, 'GROUP_PHOTO')).toBe(true);
    expect(isGroupPhoto(standardPhoto)).toBe(false);
    expect(matchesStatusFilter(standardPhoto, 'GROUP_PHOTO')).toBe(false);
  });

  it('combines group portrait filter with star rating filters', () => {
    const photos = [
      makePhoto('group-5', {
        rating: 5,
        ai: makeAi({ diagnostics: { photoKind: 'GROUP_PORTRAIT', groupFaceIndices: [0, 1, 2] } }),
      }),
      makePhoto('group-3', {
        rating: 3,
        ai: makeAi({ diagnostics: { photoKind: 'GROUP_PORTRAIT', groupFaceIndices: [0, 1, 2] } }),
      }),
      makePhoto('single-5', {
        rating: 5,
        ai: makeAi({ diagnostics: { photoKind: 'STANDARD' } }),
      }),
    ];

    expect(filterPhotos(photos, 'GROUP_PHOTO', 'RATING_4_PLUS').map(photo => photo.id)).toEqual(['group-5']);
  });

  it('matches duplicate photos only from the provided duplicate id set', () => {
    const duplicatePhoto = makePhoto('duplicate', { rating: 5 });
    const normalPhoto = makePhoto('normal', { rating: 5 });
    const duplicateIds = new Set(['duplicate']);

    expect(matchesStatusFilter(duplicatePhoto, 'DUPLICATES', duplicateIds)).toBe(true);
    expect(matchesStatusFilter(normalPhoto, 'DUPLICATES', duplicateIds)).toBe(false);
    expect(matchesStatusFilter(duplicatePhoto, 'DUPLICATES')).toBe(false);
    expect(filterPhotos([duplicatePhoto, normalPhoto], 'DUPLICATES', 'RATING_4_PLUS', duplicateIds).map(photo => photo.id)).toEqual(['duplicate']);
  });
});
