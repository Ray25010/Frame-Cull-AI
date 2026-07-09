import type {
  AiAestheticScore,
  AiDiagnostics,
  AiIssue,
  AiMetrics,
  AiPhotoScore,
  AiPhotoScoreComponent,
  AiPhotoScoreComponentKey,
  DuplicateGroup,
  PhotoGroup,
} from '../types';
import { SelectionState } from '../types';
import { duplicateSimilarity, splitIntoCompactDuplicateBuckets } from './duplicateDetection';
import { comparablePhotoTimeGap, filenameNumericGap, photoSortValue } from './photoTime';

export const PHOTO_SCORE_VERSION = 'photo-score-v10-exposure-recoverability';
export const AI_PICK_TARGET_RATIO = 0.6;
export const AI_PICK_MIN_CANDIDATE_SCORE = 38;
export const AI_PICK_MIN_CANDIDATE_TECHNICAL = 20;
export const AI_PICK_MIN_OVERALL = AI_PICK_MIN_CANDIDATE_SCORE;
export const AI_PICK_MIN_TECHNICAL = AI_PICK_MIN_CANDIDATE_TECHNICAL;
export const FOCUS_FAIL_OVERALL_CAP = 49;
export const FOCUS_FAIL_TECHNICAL_CAP = 38;
const AI_PICK_PAIR_SIMILARITY = 0.84;
const AI_PICK_PAIR_ANCHOR_FLOOR = 0.8;
const AI_PICK_SOLO_SUPPRESSION_SIMILARITY = 0.82;
const AI_PICK_SOLO_SUPPRESSION_NUMERIC_GAP = 3;
const AI_PICK_SOLO_SUPPRESSION_TIME_SPAN_MS = 1000 * 60 * 2;
const AI_PICK_BURST_MAX_NUMERIC_SPAN = 18;
const AI_PICK_BURST_MAX_TIME_SPAN_MS = 1000 * 60 * 30;
const AI_PICK_MAX_COMPACT_GROUP_SIZE = 5;

// Engineering weights from the supervised G-drive culling bench; rerun the bench before retuning.
const AI_PICK_RANK_WEIGHTS = {
  overall: 0.62,
  technical: 0.95,
  scene: 0.18,
  aesthetic: 0.12,
  exposure: 0.08,
  focusTexture: 0.24,
  focusReliability: 8,
  rating: 3,
  manualPicked: 10,
  manualRejected: -20,
  reviewPenalty: 4,
  reviewPenaltyFloor: 0.45,
} as const;

type ScoreInput = {
  metrics?: AiMetrics;
  diagnostics?: AiDiagnostics;
  issues?: AiIssue[];
  aesthetic?: AiAestheticScore;
  duplicateBestPass?: boolean;
};

type ScoreSceneKind = 'FRONT_PORTRAIT' | 'PORTRAIT' | 'GROUP_PORTRAIT' | 'ENVIRONMENTAL_PERSON' | 'SCENIC';

type ScoreSceneProfile = {
  kind: ScoreSceneKind;
  portraitScoring: boolean;
  frontPortrait: boolean;
  peoplePresent: boolean;
};

const COMPONENT_LABELS: Record<AiPhotoScoreComponentKey, string> = {
  TECHNICAL_QUALITY: 'Technical quality',
  AESTHETIC_QUALITY: 'Aesthetic quality',
  SCENE_FIT: 'Scene fit',
  EXPOSURE_LATITUDE: 'Exposure latitude',
  AI_RISK: 'AI risk',
};

export function buildPhotoScore({
  metrics,
  diagnostics,
  issues = [],
  aesthetic,
  duplicateBestPass = true,
}: ScoreInput): AiPhotoScore {
  const primaryFace = getPrimaryFaceDiagnostic(diagnostics);
  const hasReliableFrontFace = Boolean(primaryFace && (
    primaryFace.landmarkerStatus === 'OK' &&
    (primaryFace.lookAtCameraScore ?? 0) >= 0.48 &&
    (primaryFace.faceQualityScore ?? 0) >= 0.42
  ));
  const sceneProfile = classifyScoreScene(metrics, diagnostics, primaryFace, hasReliableFrontFace);
  const issuePenalty = scoreIssueRisk(issues);
  const focusFail = hasFocusFail(issues, metrics) || hasFocusReview(issues);
  const aestheticScore = aesthetic?.status === 'READY' && typeof aesthetic.score === 'number'
    ? calibratedAestheticModelScore(aesthetic.score)
    : heuristicAesthetic(metrics, diagnostics, sceneProfile.portraitScoring);

  const baseTechnical = sceneProfile.portraitScoring
    ? portraitTechnicalScore(metrics, primaryFace)
    : scenicTechnicalScore(metrics, aestheticScore);
  const technical = focusFail
    ? Math.min(baseTechnical, FOCUS_FAIL_TECHNICAL_CAP / 100)
    : baseTechnical;

  const sceneFit = sceneProfile.frontPortrait
    ? average([
      ratio(primaryFace?.lookAtCameraScore ?? metrics?.eyeReliability ?? 0.58),
      ratio(primaryFace?.poseReliability ?? metrics?.poseReliability ?? 0.58),
      ratio(primaryFace?.centerScore ?? 0.58),
      ratio(primaryFace?.cropSafetyScore ?? 0.72),
      subjectSeparation(diagnostics),
    ])
    : sceneProfile.portraitScoring
      ? average([
        ratio(primaryFace?.centerScore ?? 0.62),
        ratio(primaryFace?.cropSafetyScore ?? 0.72),
        subjectSeparation(diagnostics),
        exposureBalance(metrics, true),
        aestheticScore,
      ])
    : average([
      aestheticScore,
      globalSceneStructure(metrics),
      exposureBalance(metrics, false),
      normalize100(metrics?.edgeDensity !== undefined ? metrics.edgeDensity * 100 : undefined, 7),
    ]);

  const exposure = sceneProfile.portraitScoring
    ? average([
      exposureBalance(metrics, true),
      recoverableClipSafety(metrics, 'shadow', true),
      recoverableClipSafety(metrics, 'highlight', true),
      subjectBrightness(metrics?.subjectExposureScore, metrics?.subjectMeanLuma),
    ])
    : average([
      exposureBalance(metrics, false),
      recoverableClipSafety(metrics, 'shadow', false),
      recoverableClipSafety(metrics, 'highlight', false),
      frameBrightness(metrics?.meanLuma),
    ]);

  const risk = clamp01(1 - issuePenalty);

  const components: AiPhotoScoreComponent[] = [
    makeComponent('TECHNICAL_QUALITY', technical, 35, technicalDetailForScene(sceneProfile)),
    makeComponent('AESTHETIC_QUALITY', aestheticScore, 25, aesthetic?.status === 'READY' ? 'NIMA aesthetic model score.' : 'Aesthetic fallback from structure, exposure, and color stability.'),
    makeComponent('SCENE_FIT', sceneFit, 15, sceneFitDetailForScene(sceneProfile)),
    makeComponent('EXPOSURE_LATITUDE', exposure, 15, sceneProfile.portraitScoring ? 'Subject brightness plus highlight and shadow detail reserve.' : 'Frame brightness plus global highlight and shadow detail reserve.'),
    makeComponent('AI_RISK', risk, 10, 'Hard issues and review hints reduce the score.'),
  ];

  const rawOverall = Math.round(components.reduce((sum, component) => sum + component.score * component.weight, 0) / 100);
  const overall = focusFail ? Math.min(rawOverall, FOCUS_FAIL_OVERALL_CAP) : rawOverall;
  const technicalScore = componentScore(components, 'TECHNICAL_QUALITY');
  const gates = buildGates({
    statusDone: true,
    hasHardIssues: hasHardIssue(issues),
    hasReviewHints: issues.some(issue => issue.level === 'REVIEW_HINT'),
    overall,
    technicalScore,
    duplicateBestPass,
    focusFail,
  });

  return {
    version: PHOTO_SCORE_VERSION,
    overall,
    grade: gradeFromScore(overall),
    components,
    summary: summaryFromScore(overall, sceneProfile, issues, gates),
    aesthetic,
    gates,
  };
}

/**
 * Pro-only: rebuild a photo score from an existing worker analysis, replacing
 * the aesthetic input with the native ONNX layer's score (§10.5). The worker is
 * never modified; in Pro edition the main thread re-derives the score with the
 * native aesthetic so the picked-quality signal comes from the native layer
 * rather than wasm NIMA. `nativeAesthetic01` is the native head output in 0..1.
 */
export function rebuildPhotoScoreWithNativeAesthetic(
  analysis: {
    metrics?: AiMetrics;
    diagnostics?: AiDiagnostics;
    issues?: AiIssue[];
    photoScore?: AiPhotoScore;
  },
  nativeAesthetic01: number,
): AiPhotoScore {
  const aesthetic: AiAestheticScore = {
    status: 'READY',
    // calibratedAestheticModelScore expects a 0..100 raw input.
    score: clamp01(nativeAesthetic01) * 100,
    modelVersion: 'pro-native-aesthetic',
  };
  return buildPhotoScore({
    metrics: analysis.metrics,
    diagnostics: analysis.diagnostics,
    issues: analysis.issues ?? [],
    aesthetic,
  });
}

export function isAiPickedPhoto(
  photo: PhotoGroup,
  duplicateBestPhotoIds?: ReadonlySet<string>,
  duplicatePhotoIds?: ReadonlySet<string>,
) {
  return isAiPickCandidatePhoto(photo, duplicateBestPhotoIds, duplicatePhotoIds);
}

export function buildAiPickedPhotoIds(
  photos: PhotoGroup[],
  duplicateBestPhotoIds?: ReadonlySet<string>,
  duplicatePhotoIds?: ReadonlySet<string>,
  targetRatio = AI_PICK_TARGET_RATIO,
  duplicateGroups: DuplicateGroup[] = [],
) {
  const usableCount = photos.filter(photo => isAiPickUsablePhoto(photo)).length;
  const targetCount = Math.max(0, Math.ceil(usableCount * normalizeAiPickTargetRatio(targetRatio)));
  const photoById = new Map(photos.map(photo => [photo.id, photo]));
  const buckets = buildAiPickBuckets(photos, photoById, duplicateGroups, duplicatePhotoIds, duplicateBestPhotoIds);
  const selectedIds = new Set<string>();
  const representativeBuckets = buckets
    .filter(bucket => bucket.kind !== 'solo')
    .sort((left, right) => aiPickRankScore(right.representative) - aiPickRankScore(left.representative));
  const soloBuckets = buckets
    .filter(bucket => bucket.kind === 'solo')
    .sort((left, right) => aiPickRankScore(right.representative) - aiPickRankScore(left.representative));

  for (const bucket of representativeBuckets) {
    selectedIds.add(bucket.representative.id);
  }

  const deferredSoloBuckets: AiPickBucket[] = [];
  for (const bucket of soloBuckets) {
    if (selectedIds.size >= targetCount) break;
    if (isRedundantSoloBucket(bucket, selectedIds, photoById)) {
      deferredSoloBuckets.push(bucket);
      continue;
    }
    selectedIds.add(bucket.representative.id);
  }

  for (const bucket of deferredSoloBuckets) {
    if (selectedIds.size >= targetCount) break;
    selectedIds.add(bucket.representative.id);
  }

  return selectedIds;
}

export type AiPickDecisionReason = {
  photoId: string;
  picked: boolean;
  bucketKind: AiPickBucket['kind'];
  bucketPhotoIds: string[];
  representativeId: string;
  rankScore: number;
  reasons: string[];
};

export function buildAiPickDecisionReasons(
  photos: PhotoGroup[],
  duplicateBestPhotoIds?: ReadonlySet<string>,
  duplicatePhotoIds?: ReadonlySet<string>,
  targetRatio = AI_PICK_TARGET_RATIO,
  duplicateGroups: DuplicateGroup[] = [],
): AiPickDecisionReason[] {
  const pickedIds = buildAiPickedPhotoIds(photos, duplicateBestPhotoIds, duplicatePhotoIds, targetRatio, duplicateGroups);
  const photoById = new Map(photos.map(photo => [photo.id, photo]));
  const buckets = buildAiPickBuckets(photos, photoById, duplicateGroups, duplicatePhotoIds, duplicateBestPhotoIds);
  const decisions: AiPickDecisionReason[] = [];

  for (const bucket of buckets) {
    const representativeId = bucket.representative.id;
    for (const photo of bucket.photos) {
      decisions.push({
        photoId: photo.id,
        picked: pickedIds.has(photo.id),
        bucketKind: bucket.kind,
        bucketPhotoIds: bucket.photos.map(item => item.id),
        representativeId,
        rankScore: Math.round(aiPickRankScore(photo) * 100) / 100,
        reasons: aiPickDecisionReasons(photo, representativeId, pickedIds.has(photo.id), duplicatePhotoIds, duplicateBestPhotoIds),
      });
    }
  }

  return decisions;
}

type AiPickBucket = {
  kind: 'duplicate' | 'burst' | 'solo';
  photos: PhotoGroup[];
  representative: PhotoGroup;
};

function aiPickDecisionReasons(
  photo: PhotoGroup,
  representativeId: string,
  picked: boolean,
  duplicatePhotoIds?: ReadonlySet<string>,
  duplicateBestPhotoIds?: ReadonlySet<string>,
) {
  const reasons: string[] = [];
  const isDuplicate = duplicatePhotoIds?.has(photo.id) ?? false;
  if (picked) reasons.push('PICKED');
  if (!isAiPickUsablePhoto(photo)) reasons.push(...aiPickUsabilityReasons(photo));
  if (isDuplicate && !(duplicateBestPhotoIds?.has(photo.id) ?? false)) reasons.push('DUPLICATE_NON_BEST');
  if (photo.id !== representativeId) reasons.push(`NOT_BUCKET_REPRESENTATIVE:${representativeId}`);
  if (photo.selection === SelectionState.PICKED) reasons.push('USER_PICKED_BONUS');
  if ((photo.rating ?? 0) > 0) reasons.push(`STAR_RATING:${photo.rating}`);
  return reasons.length > 0 ? reasons : ['ELIGIBLE_NOT_SELECTED'];
}

function aiPickUsabilityReasons(photo: PhotoGroup) {
  const reasons: string[] = [];
  if (photo.ai?.status !== 'DONE') reasons.push('AI_NOT_DONE');
  if (photo.selection === SelectionState.REJECTED) reasons.push('USER_REJECTED');
  const issues = photo.ai?.issues ?? [];
  if (hasHardIssue(issues)) reasons.push('HAS_HARD_ISSUE');
  if (hasFocusReview(issues)) reasons.push('HAS_FOCUS_REVIEW');
  if (!photo.ai?.photoScore) reasons.push('NO_SCORE');
  const score = photo.ai?.photoScore;
  if (score && score.overall < AI_PICK_MIN_CANDIDATE_SCORE) reasons.push('LOW_OVERALL');
  const technicalScore = componentScore(score?.components, 'TECHNICAL_QUALITY');
  if (score && technicalScore < AI_PICK_MIN_CANDIDATE_TECHNICAL) reasons.push('LOW_TECHNICAL');
  if (photo.ai && hasFocusFail(photo.ai.issues ?? [], photo.ai.metrics)) reasons.push('FOCUS_FAIL');
  if (score?.gates && !score.gates.technicalPass) reasons.push('TECHNICAL_GATE_FAIL');
  return reasons;
}

function buildAiPickBuckets(
  photos: PhotoGroup[],
  photoById: ReadonlyMap<string, PhotoGroup>,
  duplicateGroups: DuplicateGroup[],
  duplicatePhotoIds?: ReadonlySet<string>,
  duplicateBestPhotoIds?: ReadonlySet<string>,
) {
  const buckets: AiPickBucket[] = [];
  const formalDuplicateMemberIds = new Set<string>();

  for (const group of duplicateGroups) {
    const groupPhotos = group.photoIds
      .map(id => photoById.get(id))
      .filter((photo): photo is PhotoGroup => Boolean(photo));
    group.photoIds.forEach(id => formalDuplicateMemberIds.add(id));
    const compactGroups = splitIntoCompactDuplicateBuckets(groupPhotos, group.sensitivity, {
      maxGroupSize: AI_PICK_MAX_COMPACT_GROUP_SIZE,
    });

    for (const compactGroup of compactGroups) {
      const storedBest = group.bestPhotoId ? compactGroup.find(photo => photo.id === group.bestPhotoId) : undefined;
      const representative = storedBest && isAiPickUsablePhoto(storedBest)
        ? storedBest
        : topAiPickRepresentative(compactGroup.filter(photo => isAiPickUsablePhoto(photo)));
      if (representative) buckets.push({ kind: 'duplicate', photos: compactGroup, representative });
    }
  }

  for (const group of buildInferredBurstGroups(photos, duplicatePhotoIds, duplicateBestPhotoIds, formalDuplicateMemberIds)) {
    const representative = topAiPickRepresentative(group);
    if (!representative) continue;
    buckets.push({
      kind: group.length >= 2 ? 'burst' : 'solo',
      photos: group,
      representative,
    });
  }

  return buckets;
}

function buildInferredBurstGroups(
  photos: PhotoGroup[],
  duplicatePhotoIds?: ReadonlySet<string>,
  duplicateBestPhotoIds?: ReadonlySet<string>,
  formalDuplicateMemberIds: ReadonlySet<string> = new Set(),
) {
  const candidates = photos
    .filter(photo => isAiPickUsablePhoto(photo))
    .filter(photo => !formalDuplicateMemberIds.has(photo.id))
    .filter(photo => !(duplicatePhotoIds?.has(photo.id) ?? false) || (duplicateBestPhotoIds?.has(photo.id) ?? false))
    .sort((left, right) => photoSortValue(left) - photoSortValue(right));
  const groups: PhotoGroup[][] = [];
  let current: PhotoGroup[] = [];

  for (const candidate of candidates) {
    if (
      current.length > 0 &&
      current.length < AI_PICK_MAX_COMPACT_GROUP_SIZE &&
      shouldJoinInferredBurst(candidate, current)
    ) {
      current.push(candidate);
      continue;
    }
    if (current.length >= 1) groups.push(current);
    current = [candidate];
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function topAiPickRepresentative(photos: PhotoGroup[]) {
  return [...photos].sort((left, right) => aiPickRankScore(right) - aiPickRankScore(left))[0];
}

function isRedundantSoloBucket(
  bucket: AiPickBucket,
  selectedIds: ReadonlySet<string>,
  photoById: ReadonlyMap<string, PhotoGroup>,
) {
  const candidate = bucket.representative;
  if (!candidate.ai?.duplicateSignature) return false;

  for (const selectedId of selectedIds) {
    const selected = photoById.get(selectedId);
    if (!selected?.ai?.duplicateSignature) continue;
    if (!isWithinSoloSuppressionSpan(candidate, selected)) continue;
    if (duplicateSimilarity(candidate.ai.duplicateSignature, selected.ai.duplicateSignature) >= AI_PICK_SOLO_SUPPRESSION_SIMILARITY) {
      return true;
    }
  }

  return false;
}

export function isAiPickCandidatePhoto(
  photo: PhotoGroup,
  duplicateBestPhotoIds?: ReadonlySet<string>,
  duplicatePhotoIds?: ReadonlySet<string>,
) {
  const isDuplicate = duplicatePhotoIds?.has(photo.id) ?? false;
  const duplicateBestPass = !isDuplicate || (duplicateBestPhotoIds?.has(photo.id) ?? false);
  return isAiPickBaseCandidatePhoto(photo, duplicateBestPass);
}

function isAiPickBaseCandidatePhoto(photo: PhotoGroup, duplicateBestPass = true) {
  if (!isAiPickUsablePhoto(photo)) return false;
  if (!duplicateBestPass) return false;
  const score = photo.ai?.photoScore;
  const gates = score?.gates ?? buildGates({
    statusDone: photo.ai?.status === 'DONE',
    hasHardIssues: hasHardIssue(photo.ai?.issues ?? []),
    hasReviewHints: (photo.ai?.issues ?? []).some(issue => issue.level === 'REVIEW_HINT'),
    overall: score?.overall ?? 0,
    technicalScore: componentScore(score?.components, 'TECHNICAL_QUALITY'),
    duplicateBestPass,
  });
  return gates.duplicateBestPass;
}

function isAiPickUsablePhoto(photo: PhotoGroup) {
  if (photo.ai?.status !== 'DONE') return false;
  if (photo.selection === SelectionState.REJECTED) return false;
  if (hasHardIssue(photo.ai.issues ?? [])) return false;
  if (hasFocusReview(photo.ai.issues ?? [])) return false;
  const score = photo.ai.photoScore;
  if (!score) return false;
  if (score.overall < AI_PICK_MIN_CANDIDATE_SCORE) return false;
  const technicalScore = componentScore(score.components, 'TECHNICAL_QUALITY');
  if (technicalScore < AI_PICK_MIN_CANDIDATE_TECHNICAL) return false;
  const focusFail = hasFocusFail(photo.ai.issues ?? [], photo.ai.metrics);
  const gates = score.gates ?? buildGates({
    statusDone: photo.ai.status === 'DONE',
    hasHardIssues: hasHardIssue(photo.ai.issues ?? []),
    hasReviewHints: (photo.ai.issues ?? []).some(issue => issue.level === 'REVIEW_HINT'),
    overall: score.overall,
    technicalScore,
    duplicateBestPass: true,
    focusFail,
  });
  return gates.technicalPass && !focusFail;
}

function aiPickRankScore(photo: PhotoGroup) {
  const score = photo.ai?.photoScore;
  const technical = componentScore(score?.components, 'TECHNICAL_QUALITY');
  const aesthetic = componentScore(score?.components, 'AESTHETIC_QUALITY');
  const scene = componentScore(score?.components, 'SCENE_FIT');
  const exposure = componentScore(score?.components, 'EXPOSURE_LATITUDE');
  const manual = photo.selection === 'PICKED'
    ? AI_PICK_RANK_WEIGHTS.manualPicked
    : photo.selection === 'REJECTED'
      ? AI_PICK_RANK_WEIGHTS.manualRejected
      : 0;
  const rating = (photo.rating ?? 0) * AI_PICK_RANK_WEIGHTS.rating;
  const metrics = photo.ai?.metrics;
  const focusTexture = metrics?.focusTextureScore ?? 0;
  const peakTexture = metrics?.focusPeakTextureScore ?? 0;
  const focusReliability = metrics?.focusReliabilityScore ?? (metrics?.focusReliable === false ? 0.38 : 0.5);
  const reviewPenalty = (photo.ai?.issues ?? [])
    .filter(issue => issue.level === 'REVIEW_HINT')
    .reduce((sum, issue) => (
      sum + AI_PICK_RANK_WEIGHTS.reviewPenalty * Math.max(AI_PICK_RANK_WEIGHTS.reviewPenaltyFloor, issue.confidence)
    ), 0);

  return (
    (score?.overall ?? 0) * AI_PICK_RANK_WEIGHTS.overall +
    technical * AI_PICK_RANK_WEIGHTS.technical +
    scene * AI_PICK_RANK_WEIGHTS.scene +
    aesthetic * AI_PICK_RANK_WEIGHTS.aesthetic +
    exposure * AI_PICK_RANK_WEIGHTS.exposure +
    Math.min(Math.max(focusTexture, peakTexture), 70) * AI_PICK_RANK_WEIGHTS.focusTexture +
    focusReliability * AI_PICK_RANK_WEIGHTS.focusReliability +
    rating +
    manual -
    reviewPenalty
  );
}

function shouldJoinInferredBurst(candidate: PhotoGroup, current: PhotoGroup[]) {
  const anchor = current[0];
  const previous = current[current.length - 1];
  if (!anchor || !previous) return false;
  if (!isWithinBurstSpan(anchor, candidate)) return false;
  return isTooSimilarForAiPicks(candidate, previous, anchor);
}

function isTooSimilarForAiPicks(left: PhotoGroup, previous: PhotoGroup, anchor: PhotoGroup) {
  const leftSignature = left.ai?.duplicateSignature;
  const previousSignature = previous.ai?.duplicateSignature;
  const anchorSignature = anchor.ai?.duplicateSignature;
  if (!leftSignature || !previousSignature || !anchorSignature) return false;
  if (!isWithinBurstSpan(previous, left)) return false;

  const previousSimilarity = duplicateSimilarity(leftSignature, previousSignature);
  const anchorSimilarity = duplicateSimilarity(leftSignature, anchorSignature);
  return (
    previousSimilarity >= AI_PICK_PAIR_SIMILARITY &&
    anchorSimilarity >= AI_PICK_PAIR_ANCHOR_FLOOR
  );
}

function isWithinBurstSpan(anchor: PhotoGroup, candidate: PhotoGroup) {
  const timeGap = comparablePhotoTimeGap(anchor, candidate);
  if (timeGap) return timeGap.gapMs <= AI_PICK_BURST_MAX_TIME_SPAN_MS;
  return (filenameNumericGap(anchor.id, candidate.id) ?? Number.POSITIVE_INFINITY) <= AI_PICK_BURST_MAX_NUMERIC_SPAN;
}

function normalizeAiPickTargetRatio(value: number) {
  if (!Number.isFinite(value)) return AI_PICK_TARGET_RATIO;
  return Math.max(0.1, Math.min(0.7, value));
}

function isWithinSoloSuppressionSpan(candidate: PhotoGroup, selected: PhotoGroup) {
  const timeGap = comparablePhotoTimeGap(candidate, selected);
  if (timeGap) return timeGap.gapMs <= AI_PICK_SOLO_SUPPRESSION_TIME_SPAN_MS;
  return (filenameNumericGap(candidate.id, selected.id) ?? Number.POSITIVE_INFINITY) <= AI_PICK_SOLO_SUPPRESSION_NUMERIC_GAP;
}

function buildGates({
  statusDone,
  hasHardIssues,
  hasReviewHints = false,
  overall,
  technicalScore,
  duplicateBestPass,
  focusFail = false,
}: {
  statusDone: boolean;
  hasHardIssues: boolean;
  hasReviewHints?: boolean;
  overall: number;
  technicalScore: number;
  duplicateBestPass: boolean;
  focusFail?: boolean;
}) {
  const reasons: string[] = [];
  if (!statusDone) reasons.push('AI analysis is not complete.');
  if (hasHardIssues) reasons.push('Hard AI issues are present.');
  if (hasReviewHints) reasons.push('AI review hints reduce the ranking score.');
  if (focusFail) reasons.push('Out-of-focus or blurry frame fails the AI Pick gate.');
  if (overall < AI_PICK_MIN_OVERALL) reasons.push(`Photo score is below ${AI_PICK_MIN_OVERALL}.`);
  if (technicalScore < AI_PICK_MIN_TECHNICAL) reasons.push(`Technical quality is below ${AI_PICK_MIN_TECHNICAL}.`);
  if (!duplicateBestPass) reasons.push('This duplicate frame is not the recommended best.');
  const technicalPass = technicalScore >= AI_PICK_MIN_TECHNICAL && !focusFail;
  return {
    aiPickedEligible: statusDone && !hasHardIssues && overall >= AI_PICK_MIN_OVERALL && technicalPass && duplicateBestPass && !focusFail,
    technicalPass,
    duplicateBestPass,
    reasons,
  };
}

function hasFocusFail(issues: AiIssue[], metrics?: AiMetrics) {
  if (issues.some(issue => issue.code === 'OUT_OF_FOCUS' && issue.level === 'ISSUE')) return true;
  const focusTexture = metrics?.focusTextureScore ?? 100;
  const peakTexture = metrics?.focusPeakTextureScore ?? 100;
  const tenengrad = metrics?.tenengrad ?? 100;
  const reliability = metrics?.focusReliabilityScore ?? (metrics?.focusReliable === false ? 0.38 : 1);
  return focusTexture < 30 && peakTexture < 38 && tenengrad < 40 && reliability < 0.42;
}

function hasHardIssue(issues: AiIssue[]) {
  return issues.some(issue => issue.level === 'ISSUE');
}

function hasFocusReview(issues: AiIssue[]) {
  return issues.some(issue => issue.code === 'OUT_OF_FOCUS');
}

function getPrimaryFaceDiagnostic(diagnostics?: AiDiagnostics) {
  const faces = diagnostics?.faceDiagnostics ?? [];
  const primaryIndex = diagnostics?.primaryFaceIndices?.[0];
  if (typeof primaryIndex === 'number') {
    const primary = faces.find(face => face.index === primaryIndex);
    if (primary) return primary;
  }
  return faces.find(face => face.subjectRole === 'PRIMARY') ?? faces[0];
}

function classifyScoreScene(
  metrics: AiMetrics | undefined,
  diagnostics: AiDiagnostics | undefined,
  primaryFace: ReturnType<typeof getPrimaryFaceDiagnostic>,
  hasReliableFrontFace: boolean,
): ScoreSceneProfile {
  const primarySubjectCount = Math.max(
    metrics?.primarySubjectCount ?? 0,
    diagnostics?.primarySubjectCount ?? 0,
    diagnostics?.primaryFaceIndices?.length ?? 0,
  );
  const faceCount = Math.max(metrics?.faceCount ?? 0, diagnostics?.faceDiagnostics?.length ?? 0);
  const subjectConfidence = metrics?.subjectConfidence ?? diagnostics?.subjectConfidence;
  const hasReliableSubject = primarySubjectCount > 0 && subjectConfidence !== 'LOW' && subjectConfidence !== 'NONE';
  const tinyOrWeakFace = Boolean(primaryFace && (
    (primaryFace.faceSizeRatio ?? 0) < 0.045 ||
    (primaryFace.subjectScore ?? 0.5) < 0.46 ||
    primaryFace.landmarkerStatus !== 'OK'
  ));

  if (diagnostics?.photoKind === 'GROUP_PORTRAIT' || (metrics?.groupFaceCount ?? 0) >= 5) {
    return {
      kind: 'GROUP_PORTRAIT',
      portraitScoring: true,
      frontPortrait: false,
      peoplePresent: true,
    };
  }

  if (hasReliableFrontFace && hasReliableSubject && !tinyOrWeakFace) {
    return {
      kind: 'FRONT_PORTRAIT',
      portraitScoring: true,
      frontPortrait: true,
      peoplePresent: true,
    };
  }

  if (hasReliableSubject && primaryFace && !tinyOrWeakFace) {
    return {
      kind: 'PORTRAIT',
      portraitScoring: true,
      frontPortrait: false,
      peoplePresent: true,
    };
  }

  if (faceCount > 0 || primarySubjectCount > 0 || (metrics?.faceCandidateCount ?? 0) > 0) {
    return {
      kind: 'ENVIRONMENTAL_PERSON',
      portraitScoring: false,
      frontPortrait: false,
      peoplePresent: true,
    };
  }

  return {
    kind: 'SCENIC',
    portraitScoring: false,
    frontPortrait: false,
    peoplePresent: false,
  };
}

function portraitTechnicalScore(metrics: AiMetrics | undefined, primaryFace: ReturnType<typeof getPrimaryFaceDiagnostic>) {
  return average([
    normalize100(metrics?.focusTextureScore, 72),
    normalize100(metrics?.focusPeakTextureScore, 84),
    ratio(primaryFace?.sharpnessScore ?? metrics?.faceQualityScore ?? metrics?.focusReliabilityScore ?? 0.5),
    ratio(metrics?.focusReliabilityScore ?? (metrics?.focusReliable ? 0.92 : 0.38)),
  ]);
}

function scenicTechnicalScore(metrics: AiMetrics | undefined, aestheticScore: number) {
  const textureFloor = Math.max(
    normalize100(metrics?.focusTextureScore, 62),
    normalize100(metrics?.focusPeakTextureScore, 76) * 0.88,
    aestheticScore * 0.72,
  );
  return average([
    textureFloor,
    normalize100(metrics?.focusPeakTextureScore, 78),
    normalize100(metrics?.tenengrad, 72),
    globalSceneStructure(metrics),
  ]);
}

function technicalDetailForScene(sceneProfile: ScoreSceneProfile) {
  if (sceneProfile.portraitScoring) return 'Subject detail, focus reliability, and local sharpness.';
  if (sceneProfile.kind === 'ENVIRONMENTAL_PERSON') return 'Frame-level detail, texture peaks, and environmental sharpness; tiny people do not force portrait scoring.';
  return 'Global detail, texture peaks, and frame-level sharpness.';
}

function sceneFitDetailForScene(sceneProfile: ScoreSceneProfile) {
  if (sceneProfile.frontPortrait) return 'Front portrait readiness, crop safety, and subject placement.';
  if (sceneProfile.portraitScoring) return 'Portrait placement, crop safety, separation, and visual readiness.';
  if (sceneProfile.kind === 'ENVIRONMENTAL_PERSON') return 'Environmental portrait structure, scale, exposure balance, and visual mood.';
  return 'Landscape, empty-scene, or environmental composition, exposure balance, and visual structure.';
}

function scoreIssueRisk(issues: AiIssue[]) {
  return clamp01(issues.reduce((sum, issue) => (
    sum + (issue.level === 'ISSUE' ? 0.34 : 0.08) * Math.max(0.45, issue.confidence)
  ), 0));
}

function makeComponent(key: AiPhotoScoreComponentKey, ratioScore: number, weight: number, detail: string): AiPhotoScoreComponent {
  return {
    key,
    label: COMPONENT_LABELS[key],
    score: Math.round(clamp01(ratioScore) * 100),
    weight,
    detail,
  };
}

function calibratedAestheticModelScore(rawScore: number) {
  const raw = clamp01(rawScore / 100);
  return clamp01(0.48 + raw * 0.52);
}

function gradeFromScore(score: number) {
  if (score >= 86) return 'EXCELLENT';
  if (score >= 74) return 'GOOD';
  if (score >= 62) return 'FAIR';
  return 'REVIEW';
}

function summaryFromScore(
  score: number,
  sceneProfile: ScoreSceneProfile,
  issues: AiIssue[],
  gates: AiPhotoScore['gates'],
) {
  if (issues.some(issue => issue.level === 'ISSUE')) return 'Hard AI issues found; review before keeping.';
  if (issues.length > 0) return 'Review hints found; score is reduced until checked.';
  if (gates && !gates.technicalPass) return 'Technical quality is too low for AI Picks.';
  if (score >= 86) return sceneProfile.frontPortrait ? 'Strong portrait candidate with clean AI checks.' : 'Strong scene candidate with clean AI checks.';
  if (score >= 74) return sceneProfile.frontPortrait ? 'Good portrait candidate with no hard AI issues.' : 'Good scene candidate with no hard AI issues.';
  if (score >= 62) return 'Usable frame, but composition or technical confidence is moderate.';
  return 'Low confidence candidate; review manually.';
}

function heuristicAesthetic(metrics?: AiMetrics, diagnostics?: AiDiagnostics, hasPortraitSubject = false) {
  const primaryFace = getPrimaryFaceDiagnostic(diagnostics);
  const portraitBoost = hasPortraitSubject
    ? average([
      ratio(primaryFace?.centerScore ?? 0.58),
      ratio(primaryFace?.cropSafetyScore ?? 0.68),
      ratio(primaryFace?.faceQualityScore ?? metrics?.faceQualityScore ?? 0.56),
    ])
    : 0.62;
  return average([
    centerRegionStructure(metrics),
    exposureBalance(metrics, hasPortraitSubject),
    recoverableClipSafety(metrics, 'highlight', hasPortraitSubject),
    recoverableClipSafety(metrics, 'shadow', hasPortraitSubject),
    portraitBoost,
  ]);
}

function subjectSeparation(diagnostics?: AiDiagnostics) {
  const primaryCount = diagnostics?.primarySubjectCount ?? diagnostics?.primaryFaceIndices?.length ?? 0;
  const faceCount = diagnostics?.faceDiagnostics?.length ?? 0;
  if (faceCount <= 1) return 0.82;
  if (primaryCount >= 1 && faceCount <= 4) return 0.72;
  return 0.58;
}

function centerRegionStructure(metrics?: AiMetrics) {
  const texture = normalize100(metrics?.focusTextureScore, 70);
  const edge = normalize100(metrics?.edgeDensity !== undefined ? metrics.edgeDensity * 100 : undefined, 8);
  return average([texture, edge]);
}

function globalSceneStructure(metrics?: AiMetrics) {
  const peak = normalize100(metrics?.focusPeakTextureScore, 76);
  const tenengrad = normalize100(metrics?.tenengrad, 72);
  const edge = normalize100(metrics?.edgeDensity !== undefined ? metrics.edgeDensity * 100 : undefined, 6);
  const center = normalize100(metrics?.focusTextureScore, 64);
  return average([Math.max(peak, center), tenengrad, edge]);
}

function exposureBalance(metrics?: AiMetrics, useSubject = true) {
  const exposureScore = useSubject
    ? metrics?.subjectExposureScore ?? (metrics?.subjectMeanLuma !== undefined ? metrics.subjectMeanLuma / 255 : undefined)
    : metrics?.meanLuma !== undefined ? metrics.meanLuma / 255 : metrics?.subjectExposureScore;
  if (exposureScore === undefined) return 0.68;
  const deviation = Math.abs(exposureScore - 0.5);
  if (deviation <= 0.18) return 0.94;
  return clamp01(0.94 - (deviation - 0.18) / 0.46);
}

function clipSafety(value: number | undefined) {
  if (value === undefined) return 0.76;
  if (value <= 0.08) return 0.94;
  return clamp01(0.94 - (value - 0.08) / 0.42);
}

function recoverableClipSafety(metrics: AiMetrics | undefined, side: 'shadow' | 'highlight', useSubject: boolean) {
  if (!metrics) return 0.76;
  const clip = side === 'shadow'
    ? useSubject ? metrics.subjectDarkClipRatio ?? metrics.darkClipRatio : metrics.darkClipRatio
    : useSubject ? metrics.subjectHighlightClipRatio ?? metrics.highlightClipRatio : metrics.highlightClipRatio;
  if (clip === undefined) return 0.76;
  const meanLuma = useSubject && metrics.subjectMeanLuma !== undefined ? metrics.subjectMeanLuma : metrics.meanLuma;
  const p10 = metrics.p10Luma ?? meanLuma;
  const p50 = useSubject && metrics.subjectMeanLuma !== undefined ? metrics.subjectMeanLuma : metrics.p50Luma ?? meanLuma;
  const p90 = metrics.p90Luma ?? meanLuma;
  const tonalRatio = side === 'shadow'
    ? metrics.shadowRatio ?? Math.min(0.9, clip * 2.2)
    : metrics.highlightRatio ?? Math.min(0.9, clip * 2.2);
  const softLimit = side === 'shadow'
    ? useSubject ? 0.52 : 0.56
    : useSubject ? 0.15 : 0.18;
  const hardLimit = side === 'shadow'
    ? useSubject ? 0.72 : 0.78
    : useSubject ? 0.3 : 0.34;
  const base = clipSafety(Math.min(clip, softLimit));
  const rawOverflow = clamp01((clip - softLimit) / Math.max(0.01, hardLimit - softLimit));
  const tonalSeverity = side === 'shadow'
    ? average([
      ratio(tonalRatio / (useSubject ? 0.62 : 0.7)),
      p10 !== undefined ? ratio((22 - p10) / 22) : 0,
      p50 !== undefined ? ratio(((useSubject ? 58 : 62) - p50) / (useSubject ? 58 : 62)) : 0,
    ])
    : average([
      ratio(tonalRatio / (useSubject ? 0.42 : 0.52)),
      p90 !== undefined ? ratio((p90 - 236) / 19) : 0,
      p50 !== undefined ? ratio((p50 - (useSubject ? 196 : 204)) / 51) : 0,
    ]);
  const residualLoss = rawOverflow * (0.35 + tonalSeverity * 0.65);
  return clamp01(base - residualLoss * 0.62);
}

function subjectBrightness(exposureScore: number | undefined, subjectMeanLuma: number | undefined) {
  const value = exposureScore ?? (subjectMeanLuma !== undefined ? subjectMeanLuma / 255 : undefined);
  if (value === undefined) return 0.72;
  const deviation = Math.abs(value - 0.52);
  if (deviation <= 0.2) return 0.94;
  return clamp01(0.94 - (deviation - 0.2) / 0.52);
}

function frameBrightness(meanLuma: number | undefined) {
  if (meanLuma === undefined) return 0.74;
  const deviation = Math.abs(meanLuma / 255 - 0.5);
  if (deviation <= 0.22) return 0.94;
  return clamp01(0.94 - (deviation - 0.22) / 0.56);
}

function normalize100(value: number | undefined, target: number) {
  if (value === undefined || target <= 0) return 0.58;
  return clamp01(value / target);
}

function ratio(value: number | undefined) {
  if (value === undefined) return 0.58;
  return clamp01(value);
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + clamp01(value), 0) / values.length;
}

function componentScore(components: AiPhotoScoreComponent[] | undefined, key: AiPhotoScoreComponentKey) {
  return components?.find(component => component.key === key)?.score ?? 0;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
