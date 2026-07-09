import { AiDuplicateSignature, DuplicateGroup, DuplicateSensitivity, PhotoGroup, SelectionState } from '../types';
import { comparablePhotoTimeGap, filenameNumericGap, photoSortValue } from './photoTime';

export const DUPLICATE_SIGNATURE_VERSION = 'duplicate-signature-v1';
export const DUPLICATE_GROUP_VERSION = 'duplicate-groups-v1';

type SignaturePhoto = PhotoGroup & { ai: NonNullable<PhotoGroup['ai']> & { duplicateSignature: AiDuplicateSignature } };

type DuplicateThresholds = {
  minSimilarity: number;
  maxHashDistance: number;
  maxAspectDelta: number;
  candidateWindowMs: number;
  maxGroupSize: number;
};

export type DuplicatePairSimilarity = {
  leftId: string;
  rightId: string;
  similarity: number;
  lumaHashDistance: number;
  structureHashDistance: number;
  aspectDelta: number;
  timeGapMs?: number;
  numericGap?: number;
  candidate: boolean;
};

export type CompactDuplicateBucket = {
  id: string;
  photoIds: string[];
  similarity: number;
  bestPhotoId?: string;
};

const THRESHOLDS: Record<Exclude<DuplicateSensitivity, 'off'>, DuplicateThresholds> = {
  loose: {
    minSimilarity: 0.76,
    maxHashDistance: 24,
    maxAspectDelta: 0.08,
    candidateWindowMs: 1000 * 60 * 60 * 6,
    maxGroupSize: 8,
  },
  standard: {
    minSimilarity: 0.84,
    maxHashDistance: 18,
    maxAspectDelta: 0.045,
    candidateWindowMs: 1000 * 60 * 45,
    maxGroupSize: 6,
  },
  strict: {
    minSimilarity: 0.92,
    maxHashDistance: 10,
    maxAspectDelta: 0.02,
    candidateWindowMs: 1000 * 60 * 8,
    maxGroupSize: 5,
  },
};

export function buildDuplicateSignature(imageData: ImageData): AiDuplicateSignature {
  const width = imageData.width;
  const height = imageData.height;
  const lumaHash = buildDifferenceHash(imageData, 9, 8, 'luma');
  const structureHash = buildDifferenceHash(imageData, 9, 8, 'edge');
  const colorHistogram = buildColorHistogram(imageData);
  const lumaHistogram = buildLumaHistogram(imageData);
  const meanLuma = lumaHistogram.reduce((sum, value, index) => sum + value * ((index + 0.5) / lumaHistogram.length) * 255, 0);

  return {
    version: DUPLICATE_SIGNATURE_VERSION,
    width,
    height,
    aspectRatio: width / Math.max(1, height),
    lumaHash,
    structureHash,
    colorHistogram,
    lumaHistogram,
    meanLuma,
  };
}

export function classifyDuplicateGroups(
  photos: PhotoGroup[],
  sensitivity: DuplicateSensitivity,
  alwaysRecommendOne: boolean,
): DuplicateGroup[] {
  if (sensitivity === 'off') return [];

  const candidates = signaturePhotos(photos);
  if (candidates.length < 2) return [];

  const buckets = buildCompactDuplicateBuckets(candidates, THRESHOLDS[sensitivity]);

  return buckets
    .filter(group => group.length >= 2)
    .map((group, index) => buildDuplicateGroup(group, sensitivity, alwaysRecommendOne, index))
    .sort((a, b) => a.photoIds[0].localeCompare(b.photoIds[0], undefined, { numeric: true }));
}

export function duplicateSimilarity(left: AiDuplicateSignature, right: AiDuplicateSignature) {
  const hashSimilarity = 1 - Math.min(1, hammingDistance(left.lumaHash, right.lumaHash) / 64);
  const structureSimilarity = 1 - Math.min(1, hammingDistance(left.structureHash, right.structureHash) / 64);
  const colorSimilarity = 1 - histogramDistance(left.colorHistogram, right.colorHistogram);
  const lumaSimilarity = 1 - histogramDistance(left.lumaHistogram, right.lumaHistogram);
  const aspectPenalty = Math.min(1, Math.abs(left.aspectRatio - right.aspectRatio) / 0.16);

  return clamp01(
    hashSimilarity * 0.4 +
    structureSimilarity * 0.24 +
    colorSimilarity * 0.2 +
    lumaSimilarity * 0.12 +
    (1 - aspectPenalty) * 0.04
  );
}

export function duplicatePhotoIds(groups: DuplicateGroup[]) {
  return new Set(groups.flatMap(group => group.photoIds));
}

export function duplicatePairSimilarities(
  photos: PhotoGroup[],
  sensitivity: Exclude<DuplicateSensitivity, 'off'> = 'standard',
): DuplicatePairSimilarity[] {
  const thresholds = THRESHOLDS[sensitivity];
  const candidates = signaturePhotos(photos);
  const pairs: DuplicatePairSimilarity[] = [];

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      const numericGap = filenameNumericGap(left.id, right.id);
      const photoTimeGap = comparablePhotoTimeGap(left, right);
      const timeGapMs = photoTimeGap?.gapMs;
      const nearbyByName = photoTimeGap === undefined && numericGap !== undefined && numericGap <= 24;
      const nearbyByTime = photoTimeGap !== undefined && photoTimeGap.gapMs <= thresholds.candidateWindowMs;
      if (!nearbyByName && !nearbyByTime && !isLikelyCandidatePair(left, right, thresholds)) continue;

      const leftSignature = left.ai.duplicateSignature;
      const rightSignature = right.ai.duplicateSignature;
      const similarity = duplicateSimilarity(leftSignature, rightSignature);
      const lumaHashDistance = hammingDistance(leftSignature.lumaHash, rightSignature.lumaHash);
      const structureHashDistance = hammingDistance(leftSignature.structureHash, rightSignature.structureHash);
      const aspectDelta = Math.abs(leftSignature.aspectRatio - rightSignature.aspectRatio);
      pairs.push({
        leftId: left.id,
        rightId: right.id,
        similarity,
        lumaHashDistance,
        structureHashDistance,
        aspectDelta,
        timeGapMs,
        numericGap,
        candidate: isLikelyCandidatePair(left, right, thresholds) && similarity >= thresholds.minSimilarity,
      });
    }
  }

  return pairs.sort((left, right) => (
    (left.timeGapMs ?? Number.POSITIVE_INFINITY) - (right.timeGapMs ?? Number.POSITIVE_INFINITY) ||
    (left.numericGap ?? Number.POSITIVE_INFINITY) - (right.numericGap ?? Number.POSITIVE_INFINITY) ||
    right.similarity - left.similarity ||
    left.leftId.localeCompare(right.leftId, undefined, { numeric: true }) ||
    left.rightId.localeCompare(right.rightId, undefined, { numeric: true })
  ));
}

export function compactDuplicateBuckets(
  photos: PhotoGroup[],
  sensitivity: Exclude<DuplicateSensitivity, 'off'> = 'standard',
  options: { maxGroupSize?: number } = {},
): CompactDuplicateBucket[] {
  const thresholds = {
    ...THRESHOLDS[sensitivity],
    maxGroupSize: options.maxGroupSize ?? THRESHOLDS[sensitivity].maxGroupSize,
  };
  return buildCompactDuplicateBucketSummaries(signaturePhotos(photos), sensitivity, thresholds)
    .filter(group => group.length >= 2)
    .map(group => group.summary);
}

export function splitIntoCompactDuplicateBuckets(
  photos: PhotoGroup[],
  sensitivity: Exclude<DuplicateSensitivity, 'off'> = 'standard',
  options: { maxGroupSize?: number } = {},
): PhotoGroup[][] {
  const photoById = new Map(photos.map(photo => [photo.id, photo]));
  const thresholds = {
    ...THRESHOLDS[sensitivity],
    maxGroupSize: options.maxGroupSize ?? THRESHOLDS[sensitivity].maxGroupSize,
  };
  const compactBuckets = buildCompactDuplicateBucketSummaries(signaturePhotos(photos), sensitivity, thresholds)
    .map(bucket => bucket.summary.photoIds.map(id => photoById.get(id)).filter((photo): photo is PhotoGroup => Boolean(photo)));
  const compactIds = new Set(compactBuckets.flatMap(bucket => bucket.map(photo => photo.id)));
  const remaining = photos
    .filter(photo => !compactIds.has(photo.id))
    .sort((left, right) => photoSortValue(left) - photoSortValue(right));
  const maxGroupSize = options.maxGroupSize ?? THRESHOLDS[sensitivity].maxGroupSize;

  for (let index = 0; index < remaining.length; index += maxGroupSize) {
    compactBuckets.push(remaining.slice(index, index + maxGroupSize));
  }

  return compactBuckets
    .filter(bucket => bucket.length > 0)
    .sort((left, right) => photoSortValue(left[0]) - photoSortValue(right[0]));
}

function buildCompactDuplicateBucketSummaries(
  photos: SignaturePhoto[],
  sensitivity: Exclude<DuplicateSensitivity, 'off'>,
  thresholds: DuplicateThresholds,
) {
  return buildCompactDuplicateBuckets(photos, thresholds)
    .filter(group => group.length > 0)
    .map((group, index) => {
      const duplicateGroup = buildDuplicateGroup(group, sensitivity, true, index);
      return {
        photos: group,
        length: group.length,
        summary: {
          id: duplicateGroup.id,
          photoIds: duplicateGroup.photoIds,
          similarity: duplicateGroup.similarity,
          bestPhotoId: duplicateGroup.bestPhotoId,
        },
      };
    });
}

function signaturePhotos(photos: PhotoGroup[]): SignaturePhoto[] {
  return photos
    .filter((photo): photo is SignaturePhoto => (
      photo.ai?.status === 'DONE' &&
      Boolean(photo.ai.duplicateSignature) &&
      photo.ai.duplicateSignature?.version === DUPLICATE_SIGNATURE_VERSION
    ))
    .sort((a, b) => photoSortValue(a) - photoSortValue(b));
}

function buildDuplicateGroup(
  photos: SignaturePhoto[],
  sensitivity: Exclude<DuplicateSensitivity, 'off'>,
  alwaysRecommendOne: boolean,
  index: number,
): DuplicateGroup {
  const sorted = [...photos].sort((a, b) => photoSortValue(a) - photoSortValue(b));
  const similarities = sorted.flatMap((photo, photoIndex) => (
    sorted.slice(photoIndex + 1).map(other => duplicateSimilarity(photo.ai.duplicateSignature, other.ai.duplicateSignature))
  ));
  const groupSimilarity = similarities.length > 0
    ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
    : 1;
  const scored = sorted
    .map(photo => ({
      photo,
      score: duplicateBestScore(photo),
    }))
    .sort((a, b) => b.score - a.score || a.photo.id.localeCompare(b.photo.id, undefined, { numeric: true }));
  const bestCandidate = scored.find(item => canRecommendDuplicateBest(item.photo));
  const bestPhotoId = alwaysRecommendOne ? bestCandidate?.photo.id : undefined;

  return {
    id: `duplicate-${index + 1}-${sorted[0]?.id ?? Date.now()}`,
    photoIds: sorted.map(photo => photo.id),
    bestPhotoId,
    similarity: groupSimilarity,
    sensitivity,
    createdAt: Date.now(),
    matches: sorted.map(photo => {
      const matchSimilarity = sorted.length <= 1
        ? groupSimilarity
        : sorted
          .filter(other => other.id !== photo.id)
          .reduce((sum, other) => sum + duplicateSimilarity(photo.ai.duplicateSignature, other.ai.duplicateSignature), 0) / (sorted.length - 1);
      return {
        photoId: photo.id,
        similarity: matchSimilarity,
        qualityScore: duplicateBestScore(photo),
        isBest: photo.id === bestPhotoId,
        reason: photo.id === bestPhotoId ? bestReason(photo) : undefined,
      };
    }),
  };
}

function duplicateBestScore(photo: PhotoGroup) {
  const ai = photo.ai;
  if (!canRecommendDuplicateBest(photo)) return Number.NEGATIVE_INFINITY;
  const issuePenalty = (ai?.issues ?? []).reduce((sum, issue) => (
    sum + (issue.level === 'ISSUE' ? 0.32 : 0.18) * Math.max(0.45, issue.confidence)
  ), 0);
  const manualScore = photo.selection === SelectionState.PICKED
    ? 0.42
    : photo.selection === SelectionState.REJECTED
      ? -0.42
      : 0;
  const ratingScore = (photo.rating ?? 0) * 0.075;
  const technicalScore = getPhotoScoreComponent(ai, 'TECHNICAL_QUALITY');
  const aestheticScore = getPhotoScoreComponent(ai, 'AESTHETIC_QUALITY');
  const photoScore = ai?.photoScore ? (ai.photoScore.overall / 100) * 0.32 : 0;
  const focusScore = (technicalScore > 0 ? technicalScore : (ai?.metrics?.focusTextureScore ?? ai?.metrics?.sharpness ?? 45)) / 100 * 0.24;
  const faceScore = (ai?.metrics?.faceQualityScore ?? ai?.metrics?.subjectConfidenceScore ?? 0.55) * 0.05;
  const aestheticPenalty = aestheticScore > 0 && aestheticScore < 54 ? (54 - aestheticScore) / 100 * 0.16 : 0;
  const technicalPenalty = technicalScore > 0 && technicalScore < 62 ? (62 - technicalScore) / 100 * 0.38 : 0;
  const exposurePenalty = Math.max(
    ai?.metrics?.subjectDarkClipRatio ?? ai?.metrics?.darkClipRatio ?? 0,
    ai?.metrics?.subjectHighlightClipRatio ?? ai?.metrics?.highlightClipRatio ?? 0,
  ) * 0.16;
  const sourceScore = photo.jpg ? 0.04 : 0;
  return manualScore + ratingScore + photoScore + focusScore + faceScore + sourceScore - issuePenalty - exposurePenalty - technicalPenalty - aestheticPenalty;
}

function canRecommendDuplicateBest(photo: PhotoGroup) {
  const ai = photo.ai;
  if (photo.selection === SelectionState.REJECTED) return false;
  if (ai?.status !== 'DONE') return false;
  if ((ai.issues ?? []).some(issue => issue.level === 'ISSUE')) return false;
  const technicalScore = getPhotoScoreComponent(ai, 'TECHNICAL_QUALITY');
  if (ai.photoScore?.gates && !ai.photoScore.gates.technicalPass) return false;
  if (technicalScore > 0 && technicalScore < 20) return false;
  if ((ai.photoScore?.overall ?? 100) < 45) return false;
  if (hasFocusFail(ai)) return false;
  return true;
}

function getPhotoScoreComponent(ai: PhotoGroup['ai'], key: 'TECHNICAL_QUALITY' | 'AESTHETIC_QUALITY') {
  return ai?.photoScore?.components.find(component => component.key === key)?.score ?? 0;
}

function hasFocusFail(ai: PhotoGroup['ai']) {
  if (!ai) return false;
  if (ai.issues.some(issue => issue.code === 'OUT_OF_FOCUS' && issue.level === 'ISSUE')) return true;
  const focusTexture = ai.metrics?.focusTextureScore ?? 100;
  const peakTexture = ai.metrics?.focusPeakTextureScore ?? 100;
  const tenengrad = ai.metrics?.tenengrad ?? 100;
  const reliability = ai.metrics?.focusReliabilityScore ?? (ai.metrics?.focusReliable === false ? 0.38 : 1);
  return focusTexture < 30 && peakTexture < 38 && tenengrad < 40 && reliability < 0.42;
}

function bestReason(photo: PhotoGroup) {
  if (photo.selection === SelectionState.PICKED) return 'manual-pick';
  if ((photo.rating ?? 0) > 0) return 'rating';
  if ((photo.ai?.issues.length ?? 0) === 0 && photo.ai?.status === 'DONE') return 'ai-clear';
  return 'quality-score';
}

function isLikelyCandidatePair(left: SignaturePhoto, right: SignaturePhoto, thresholds: DuplicateThresholds) {
  const leftSignature = left.ai.duplicateSignature;
  const rightSignature = right.ai.duplicateSignature;
  if (Math.abs(leftSignature.aspectRatio - rightSignature.aspectRatio) > thresholds.maxAspectDelta) return false;
  const hashDistance = Math.min(
    hammingDistance(leftSignature.lumaHash, rightSignature.lumaHash),
    hammingDistance(leftSignature.structureHash, rightSignature.structureHash),
  );
  if (hashDistance > thresholds.maxHashDistance) return false;

  const photoTimeGap = comparablePhotoTimeGap(left, right);
  if (photoTimeGap && photoTimeGap.gapMs > thresholds.candidateWindowMs) return false;
  return true;
}

function buildDifferenceHash(imageData: ImageData, width: number, height: number, mode: 'luma' | 'edge') {
  const samples = resizeToLuma(imageData, width, height);
  let bits = '';
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const current = samples[y * width + x];
      const next = samples[y * width + x + 1];
      if (mode === 'edge') {
        const below = samples[Math.min(height - 1, y + 1) * width + x];
        const belowNext = samples[Math.min(height - 1, y + 1) * width + x + 1];
        bits += Math.abs(current - below) > Math.abs(next - belowNext) ? '1' : '0';
      } else {
        bits += current > next ? '1' : '0';
      }
    }
  }
  return bitsToHex(bits);
}

function resizeToLuma(imageData: ImageData, targetWidth: number, targetHeight: number) {
  const { data, width, height } = imageData;
  const values = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / targetWidth));
      const index = (sourceY * width + sourceX) * 4;
      values[y * targetWidth + x] = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    }
  }
  return values;
}

function buildColorHistogram(imageData: ImageData) {
  const bins = new Array(24).fill(0);
  const { data } = imageData;
  const stride = Math.max(4, Math.floor(data.length / 4 / 12000) * 4);
  let count = 0;
  for (let i = 0; i < data.length; i += stride) {
    bins[Math.min(7, data[i] >> 5)] += 1;
    bins[8 + Math.min(7, data[i + 1] >> 5)] += 1;
    bins[16 + Math.min(7, data[i + 2] >> 5)] += 1;
    count += 1;
  }
  return bins.map(value => value / Math.max(1, count));
}

function buildLumaHistogram(imageData: ImageData) {
  const bins = new Array(16).fill(0);
  const { data } = imageData;
  const stride = Math.max(4, Math.floor(data.length / 4 / 12000) * 4);
  let count = 0;
  for (let i = 0; i < data.length; i += stride) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    bins[Math.min(15, Math.floor(y / 16))] += 1;
    count += 1;
  }
  return bins.map(value => value / Math.max(1, count));
}

function bitsToHex(bits: string) {
  let hex = '';
  for (let index = 0; index < bits.length; index += 4) {
    hex += Number.parseInt(bits.slice(index, index + 4).padEnd(4, '0'), 2).toString(16);
  }
  return hex;
}

function hammingDistance(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);
  let distance = 0;
  for (let index = 0; index < maxLength; index += 1) {
    const a = Number.parseInt(left[index] ?? '0', 16);
    const b = Number.parseInt(right[index] ?? '0', 16);
    distance += bitCount(a ^ b);
  }
  return distance;
}

function bitCount(value: number) {
  let count = 0;
  let current = value;
  while (current) {
    count += current & 1;
    current >>= 1;
  }
  return count;
}

function histogramDistance(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length);
  let distance = 0;
  for (let index = 0; index < length; index += 1) {
    distance += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return Math.min(1, distance / 2);
}

function buildCompactDuplicateBuckets(candidates: SignaturePhoto[], thresholds: DuplicateThresholds) {
  const buckets: SignaturePhoto[][] = [];

  for (const candidate of candidates) {
    const bucket = buckets.find(items => items.length < thresholds.maxGroupSize && canJoinDuplicateBucket(candidate, items, thresholds));
    if (bucket) {
      bucket.push(candidate);
    } else {
      buckets.push([candidate]);
    }
  }

  return buckets;
}

function canJoinDuplicateBucket(candidate: SignaturePhoto, bucket: SignaturePhoto[], thresholds: DuplicateThresholds) {
  return bucket.every(member => (
    isLikelyCandidatePair(member, candidate, thresholds) &&
    duplicateSimilarity(member.ai.duplicateSignature, candidate.ai.duplicateSignature) >= thresholds.minSimilarity
  ));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
