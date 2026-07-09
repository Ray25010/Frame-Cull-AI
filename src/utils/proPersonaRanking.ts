import type { AiIssue, DuplicateGroup, PhotoGroup } from '../types';
import { SelectionState } from '../types';
import { duplicateSimilarity } from './duplicateDetection';
import { comparablePhotoTimeGap, filenameNumericGap, photoSortValue, trailingNumber } from './photoTime';

export const PRO_PERSONA_RANKING_VERSION = 'pro-persona-ranking-v16b-persona-only';

export type ProPersonaRankMode =
  | 'pro-semantic-v2-flash-persona'
  | 'pro-semantic-v2-persona-only'
  | 'pro-persona';

export type ProPersonaRankingSettings = {
  enabled: boolean;
  rankMode?: ProPersonaRankMode;
};

export type ProPersonaPairSimilarity = {
  leftId: string;
  rightId: string;
  similarity: number;
  numericGap?: number;
  timeGapMs?: number;
  candidate?: boolean;
};

export type ProPersonaRankingOptions = {
  settings?: ProPersonaRankingSettings;
  pairSimilarities?: ProPersonaPairSimilarity[];
};

type RatioProfile = {
  ratio: number;
  rankMode: ProPersonaRankMode;
  gateMode: 'hard-only';
  groupMode: 'known' | 'pair-threshold';
  maxBurstSize: number;
  similarityThreshold?: number;
  maxNumericGap?: number;
  maxTimeGapMs?: number;
  requireCandidate?: boolean;
};

type ProPersonaRecord = {
  id: string;
  photo: PhotoGroup;
  sourceFolder: string;
  numericId: number | null;
};

type ProPersonaGroup = {
  id: string;
  source: string;
  photoIds: string[];
};

const PRO_PERSONA_SELECTED_RATIO_PROFILES: RatioProfile[] = [
  {
    ratio: 0.38,
    rankMode: 'pro-semantic-v2-persona-only',
    gateMode: 'hard-only',
    groupMode: 'known',
    maxBurstSize: 5,
  },
  {
    ratio: 0.45,
    rankMode: 'pro-semantic-v2-persona-only',
    gateMode: 'hard-only',
    groupMode: 'known',
    maxBurstSize: 5,
  },
  {
    ratio: 0.5,
    rankMode: 'pro-semantic-v2-persona-only',
    gateMode: 'hard-only',
    groupMode: 'pair-threshold',
    maxBurstSize: 4,
    similarityThreshold: 0.92,
    maxNumericGap: 12,
    maxTimeGapMs: 1000 * 60 * 8,
    requireCandidate: false,
  },
  {
    ratio: 0.6,
    rankMode: 'pro-semantic-v2-persona-only',
    gateMode: 'hard-only',
    groupMode: 'pair-threshold',
    maxBurstSize: 4,
    similarityThreshold: 0.92,
    maxNumericGap: 12,
    maxTimeGapMs: 1000 * 60 * 8,
    requireCandidate: false,
  },
];

const PRO_PERSONA_SOLO_SUPPRESSION_SIMILARITY = 0.82;
const PRO_PERSONA_SOLO_SUPPRESSION_NUMERIC_GAP = 3;

export function shouldUseProPersonaRanking(options?: ProPersonaRankingOptions) {
  return options?.settings?.enabled === true;
}

export function buildProPersonaPickedPhotoIds(
  photos: PhotoGroup[],
  targetRatio: number,
  duplicateGroups: DuplicateGroup[] = [],
  options: ProPersonaRankingOptions = {},
) {
  const profile = profileForRatio(targetRatio, options.settings?.rankMode);
  const records = photos.map(toRecord).sort(compareRecordOrder);
  const usable = records.filter(record => isProPersonaUsablePhoto(record.photo));
  const target = Math.max(0, Math.ceil(usable.length * targetRatio));
  const byId = new Map(records.map(record => [record.id, record]));
  const pairSimilarities = normalizePairSimilarities(records, options.pairSimilarities);
  const pairSimilarityMap = buildPairSimilarityMap(pairSimilarities);
  const groups = buildAllGroups(records, duplicateGroups, pairSimilarities, profile);
  const groupedIds = new Set(groups.flatMap(group => group.photoIds));
  const selected = new Set<string>();

  for (const group of groups) {
    const candidates = group.photoIds
      .map(id => byId.get(id))
      .filter((record): record is ProPersonaRecord => Boolean(record && isProPersonaUsablePhoto(record.photo)));
    const representative = topByProPersonaRank(candidates, profile.rankMode);
    if (representative) selected.add(representative.id);
  }

  const solos = usable
    .filter(record => !groupedIds.has(record.id))
    .sort((left, right) => proPersonaRankScore(right.photo, profile.rankMode) - proPersonaRankScore(left.photo, profile.rankMode) || compareRecordOrder(left, right));
  const deferredSolos: ProPersonaRecord[] = [];

  for (const record of solos) {
    if (selected.size >= target) break;
    if (isRedundantSoloRecord(record, selected, byId, pairSimilarityMap)) {
      deferredSolos.push(record);
      continue;
    }
    selected.add(record.id);
  }

  for (const record of deferredSolos) {
    if (selected.size >= target) break;
    selected.add(record.id);
  }

  return selected;
}

export function proPersonaRankScore(photo: PhotoGroup, rankMode: ProPersonaRankMode = 'pro-semantic-v2-persona-only') {
  const overall = photo.ai?.photoScore?.overall ?? 0;
  const technical = componentScore(photo, 'TECHNICAL_QUALITY');
  const aesthetic = componentScore(photo, 'AESTHETIC_QUALITY');
  const scene = componentScore(photo, 'SCENE_FIT');
  const nativeAesthetic = (photo.ai?.proScores?.aesthetic ?? (aesthetic / 100)) * 100;
  const persona = photo.ai?.proScores?.personaScore ?? 0.5;
  const focusReliability = photo.ai?.metrics?.focusReliabilityScore ?? (photo.ai?.metrics?.focusReliable === false ? 0.38 : 0.5);
  const reviewPenalty = (photo.ai?.issues ?? []).filter(issue => issue.level === 'REVIEW_HINT').length * 4;

  if (rankMode === 'pro-persona') {
    const personaBonus = persona >= 0.62 ? 18 : persona >= 0.56 ? 8 : 0;
    return overall * 0.56 + technical * 0.28 + scene * 0.34 + nativeAesthetic * 0.14 + persona * 42 + focusReliability * 4.5 + personaBonus - reviewPenalty;
  }

  if (rankMode === 'pro-semantic-v2-persona-only') {
    return overall * 0.54 + technical * 0.28 + scene * 0.24 + nativeAesthetic * 0.14 + persona * 46 + focusReliability * 4.5 - reviewPenalty;
  }

  // v16 attribution profile: keep the Flash/current ranking spine and add the
  // v14 semantic student persona signal. v16b keeps this branch for A/B
  // comparison, but the production default is persona-only.
  return overall * 1.2 + technical * 0.25 + scene * 0.12 + nativeAesthetic * 0.14 + persona * 46 + focusReliability * 3 - reviewPenalty;
}

function profileForRatio(targetRatio: number, rankMode?: ProPersonaRankMode): RatioProfile {
  const rounded = Math.round(targetRatio * 100) / 100;
  const exact = PRO_PERSONA_SELECTED_RATIO_PROFILES.find(profile => Math.abs(profile.ratio - rounded) < 1e-9);
  const fallback = rounded < 0.5
    ? PRO_PERSONA_SELECTED_RATIO_PROFILES[1]
    : PRO_PERSONA_SELECTED_RATIO_PROFILES[2];
  return {
    ...(exact ?? fallback),
    ratio: targetRatio,
    rankMode: rankMode ?? exact?.rankMode ?? fallback.rankMode,
  };
}

function toRecord(photo: PhotoGroup): ProPersonaRecord {
  return {
    id: photo.id,
    photo,
    sourceFolder: sourceFolder(photo),
    numericId: trailingNumber(photo.id),
  };
}

function sourceFolder(photo: PhotoGroup) {
  const source = photo.jpg?.path ?? photo.raw?.path ?? photo.jpg?.name ?? photo.raw?.name ?? photo.id;
  const normalized = String(source).replace(/\//g, '\\');
  const known = normalized.match(/(108NZ6_3|109NZ6_3|110NZ6_3|camera-teacher-jpegs|five-mountain-previews-384)/i);
  if (known) return known[1];
  const parts = normalized.split('\\').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
}

function buildAllGroups(
  records: ProPersonaRecord[],
  duplicateGroups: DuplicateGroup[],
  pairSimilarities: ProPersonaPairSimilarity[],
  profile: RatioProfile,
) {
  const groups: ProPersonaGroup[] = [];
  const knownMemberIds = new Set<string>();
  const seedGroups = buildSeedGroups(records, duplicateGroups, pairSimilarities, profile);

  for (const seed of seedGroups) {
    const freshIds = seed.photoIds.filter(id => !knownMemberIds.has(id));
    if (freshIds.length < 2) continue;
    const chunks = splitIntoCompactChunks(freshIds, records, profile.maxBurstSize);
    chunks.forEach((chunk, index) => {
      chunk.forEach(id => knownMemberIds.add(id));
      if (chunk.length >= 2) {
        groups.push({
          id: `${seed.id}${chunks.length > 1 ? `-chunk-${index + 1}` : ''}`,
          source: seed.source,
          photoIds: chunk,
        });
      }
    });
  }

  return groups;
}

function buildSeedGroups(
  records: ProPersonaRecord[],
  duplicateGroups: DuplicateGroup[],
  pairSimilarities: ProPersonaPairSimilarity[],
  profile: RatioProfile,
) {
  const knownGroups = buildKnownGroups(records, duplicateGroups);
  if (profile.groupMode === 'known') return dedupeGroups(records, knownGroups);

  const pairGroups = buildPairSimilarityGroups(records, pairSimilarities, profile);
  return pairGroups.length > 0 ? dedupeGroups(records, pairGroups) : dedupeGroups(records, knownGroups);
}

function buildKnownGroups(records: ProPersonaRecord[], duplicateGroups: DuplicateGroup[]) {
  const byId = new Map(records.map(record => [record.id, record]));
  return duplicateGroups
    .map((group, index): ProPersonaGroup => ({
      id: group.id || `known-${index + 1}`,
      source: 'production-duplicate-group',
      photoIds: group.photoIds.filter(id => byId.has(id)),
    }))
    .filter(group => group.photoIds.length >= 2);
}

function normalizePairSimilarities(records: ProPersonaRecord[], pairs?: ProPersonaPairSimilarity[]) {
  if (pairs && pairs.length > 0) {
    const byId = new Set(records.map(record => record.id));
    return pairs
      .map(pair => ({
        leftId: pair.leftId,
        rightId: pair.rightId,
        similarity: Number(pair.similarity),
        numericGap: numberOr(pair.numericGap, undefined),
        timeGapMs: numberOr(pair.timeGapMs, undefined),
        candidate: Boolean(pair.candidate),
      }))
      .filter(pair => byId.has(pair.leftId) && byId.has(pair.rightId) && Number.isFinite(pair.similarity))
      .sort(comparePairSimilarity);
  }

  const generated: ProPersonaPairSimilarity[] = [];
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    const left = records[leftIndex];
    const leftSignature = left.photo.ai?.duplicateSignature;
    if (!leftSignature) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const right = records[rightIndex];
      if (left.sourceFolder !== right.sourceFolder) continue;
      const numericGap = numericGapBetween(left.id, right.id);
      const timeGap = comparablePhotoTimeGap(left.photo, right.photo);
      const nearEnough = (
        (Number.isFinite(numericGap) && numericGap > 0 && numericGap <= 18) ||
        (timeGap && timeGap.gapMs <= 1000 * 60 * 30)
      );
      if (!nearEnough) continue;
      const rightSignature = right.photo.ai?.duplicateSignature;
      if (!rightSignature) continue;
      generated.push({
        leftId: left.id,
        rightId: right.id,
        similarity: duplicateSimilarity(leftSignature, rightSignature),
        numericGap,
        timeGapMs: timeGap?.gapMs,
        candidate: true,
      });
    }
  }
  return generated.sort(comparePairSimilarity);
}

function buildPairSimilarityGroups(
  records: ProPersonaRecord[],
  pairs: ProPersonaPairSimilarity[],
  profile: RatioProfile,
) {
  const byId = new Map(records.map(record => [record.id, record]));
  const threshold = profile.similarityThreshold ?? 0.92;
  const maxNumericGap = profile.maxNumericGap ?? 12;
  const maxTimeGapMs = profile.maxTimeGapMs ?? 1000 * 60 * 8;
  const usablePairs = pairs.filter(pair => {
    if (pair.similarity < threshold) return false;
    if (profile.requireCandidate && !pair.candidate) return false;
    const numericGap = pair.numericGap ?? numericGapBetween(pair.leftId, pair.rightId);
    const nearbyByName = Number.isFinite(numericGap) && numericGap > 0 && numericGap <= maxNumericGap;
    const nearbyByTime = typeof pair.timeGapMs === 'number' && Number.isFinite(pair.timeGapMs) && pair.timeGapMs <= maxTimeGapMs;
    return nearbyByName || nearbyByTime;
  });

  const byFolder = new Map<string, ProPersonaPairSimilarity[]>();
  for (const pair of usablePairs) {
    const left = byId.get(pair.leftId);
    const right = byId.get(pair.rightId);
    if (!left || !right || left.sourceFolder !== right.sourceFolder) continue;
    if (!byFolder.has(left.sourceFolder)) byFolder.set(left.sourceFolder, []);
    byFolder.get(left.sourceFolder)?.push(pair);
  }

  const groups: ProPersonaGroup[] = [];
  for (const [folder, folderPairs] of byFolder.entries()) {
    const photoIds = new Set(folderPairs.flatMap(pair => [pair.leftId, pair.rightId]));
    const sortedRecords = [...photoIds]
      .map(id => byId.get(id))
      .filter((record): record is ProPersonaRecord => Boolean(record))
      .sort(compareRecordOrder);
    let current: ProPersonaRecord[] = [];
    for (const record of sortedRecords) {
      if (current.length === 0 || canJoinPairGroup(record, current, folderPairs, profile)) {
        current.push(record);
        continue;
      }
      pushPairGroup(groups, folder, current, threshold);
      current = [record];
    }
    pushPairGroup(groups, folder, current, threshold);
  }

  return groups;
}

function canJoinPairGroup(
  record: ProPersonaRecord,
  current: ProPersonaRecord[],
  folderPairs: ProPersonaPairSimilarity[],
  profile: RatioProfile,
) {
  if (current.length >= profile.maxBurstSize) return false;
  const anchor = current[0];
  const previous = current[current.length - 1];
  if (!anchor || !previous) return false;
  const anchorPair = findPair(folderPairs, anchor.id, record.id);
  const previousPair = findPair(folderPairs, previous.id, record.id);
  if (!anchorPair || !previousPair) return false;
  const threshold = profile.similarityThreshold ?? 0.92;
  const anchorFloor = Math.max(0.8, threshold - 0.04);
  const numericSpan = numericGapBetween(anchor.id, record.id);
  if (Number.isFinite(numericSpan) && numericSpan > (profile.maxNumericGap ?? 12)) return false;
  return previousPair.similarity >= threshold && anchorPair.similarity >= anchorFloor;
}

function isRedundantSoloRecord(
  record: ProPersonaRecord,
  selectedIds: ReadonlySet<string>,
  byId: ReadonlyMap<string, ProPersonaRecord>,
  pairSimilarityMap: ReadonlyMap<string, ProPersonaPairSimilarity>,
) {
  if (record.numericId === null) return false;
  for (const selectedId of selectedIds) {
    const selected = byId.get(selectedId);
    if (!selected || selected.sourceFolder !== record.sourceFolder || selected.numericId === null) continue;
    const gap = Math.abs(record.numericId - selected.numericId);
    if (gap <= 0 || gap > PRO_PERSONA_SOLO_SUPPRESSION_NUMERIC_GAP) continue;
    const pair = pairSimilarityMap.get(pairKey(record.id, selected.id));
    if (pair && pair.similarity >= PRO_PERSONA_SOLO_SUPPRESSION_SIMILARITY) return true;
  }
  return false;
}

function isProPersonaUsablePhoto(photo: PhotoGroup) {
  if (photo.ai?.status !== 'DONE') return false;
  if (photo.selection === SelectionState.REJECTED) return false;
  if (hasHardIssue(photo.ai.issues ?? [])) return false;
  if (hasFocusFail(photo)) return false;
  const score = photo.ai.photoScore;
  if (!score) return false;
  if (score.overall < 38) return false;
  if (componentScore(photo, 'TECHNICAL_QUALITY') < 20) return false;
  return true;
}

function hasFocusFail(photo: PhotoGroup) {
  const issues = photo.ai?.issues ?? [];
  if (issues.some(issue => issue.code === 'OUT_OF_FOCUS' && issue.level === 'ISSUE')) return true;
  const metrics = photo.ai?.metrics;
  const focusTexture = metrics?.focusTextureScore ?? 100;
  const peakTexture = metrics?.focusPeakTextureScore ?? 100;
  const tenengrad = metrics?.tenengrad ?? 100;
  const reliability = metrics?.focusReliabilityScore ?? (metrics?.focusReliable === false ? 0.38 : 1);
  return focusTexture < 30 && peakTexture < 38 && tenengrad < 40 && reliability < 0.42;
}

function hasHardIssue(issues: AiIssue[]) {
  return issues.some(issue => issue.level === 'ISSUE');
}

function topByProPersonaRank(records: ProPersonaRecord[], rankMode: ProPersonaRankMode) {
  return [...records].sort((left, right) => proPersonaRankScore(right.photo, rankMode) - proPersonaRankScore(left.photo, rankMode) || compareRecordOrder(left, right))[0];
}

function componentScore(photo: PhotoGroup, key: 'TECHNICAL_QUALITY' | 'AESTHETIC_QUALITY' | 'SCENE_FIT') {
  return photo.ai?.photoScore?.components.find(component => component.key === key)?.score ?? 0;
}

function splitIntoCompactChunks(ids: string[], records: ProPersonaRecord[], maxSize: number) {
  if (ids.length <= maxSize) return [ids];
  const byId = new Map(records.map(record => [record.id, record]));
  const sorted = [...ids].sort((left, right) => compareRecordOrder(byId.get(left), byId.get(right)));
  const chunks: string[][] = [];
  for (let index = 0; index < sorted.length; index += maxSize) {
    chunks.push(sorted.slice(index, index + maxSize));
  }
  return chunks;
}

function pushPairGroup(groups: ProPersonaGroup[], folder: string, current: ProPersonaRecord[], threshold: number) {
  if (current.length < 2) return;
  groups.push({
    id: `pair-sim-${threshold}-${folder}-${current[0].id}-${current[current.length - 1].id}`,
    source: 'pair-similarity-compact',
    photoIds: current.map(record => record.id),
  });
}

function dedupeGroups(records: ProPersonaRecord[], groups: ProPersonaGroup[]) {
  const seen = new Set<string>();
  const byId = new Map(records.map(record => [record.id, record]));
  const deduped: ProPersonaGroup[] = [];
  for (const group of groups) {
    const ids = [...new Set(group.photoIds)]
      .filter(id => byId.has(id))
      .sort((left, right) => compareRecordOrder(byId.get(left), byId.get(right)));
    if (ids.length < 2) continue;
    const key = ids.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...group, photoIds: ids });
  }
  return deduped;
}

function findPair(pairs: ProPersonaPairSimilarity[], leftId: string, rightId: string) {
  return pairs.find(pair => (
    (pair.leftId === leftId && pair.rightId === rightId) ||
    (pair.leftId === rightId && pair.rightId === leftId)
  ));
}

function buildPairSimilarityMap(pairs: ProPersonaPairSimilarity[]) {
  const map = new Map<string, ProPersonaPairSimilarity>();
  for (const pair of pairs) {
    map.set(pairKey(pair.leftId, pair.rightId), pair);
  }
  return map;
}

function pairKey(leftId: string, rightId: string) {
  return [leftId, rightId]
    .sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }))
    .join('::');
}

function numericGapBetween(leftId: string, rightId: string) {
  return filenameNumericGap(leftId, rightId) ?? Number.POSITIVE_INFINITY;
}

function compareRecordOrder(left?: ProPersonaRecord, right?: ProPersonaRecord) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const folder = String(left.sourceFolder).localeCompare(String(right.sourceFolder), undefined, { numeric: true });
  if (folder !== 0) return folder;
  return (left.numericId ?? Number.MAX_SAFE_INTEGER) - (right.numericId ?? Number.MAX_SAFE_INTEGER) ||
    photoSortValue(left.photo) - photoSortValue(right.photo) ||
    String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
}

function comparePairSimilarity(left: ProPersonaPairSimilarity, right: ProPersonaPairSimilarity) {
  return (
    (left.numericGap ?? Number.POSITIVE_INFINITY) - (right.numericGap ?? Number.POSITIVE_INFINITY) ||
    right.similarity - left.similarity ||
    left.leftId.localeCompare(right.leftId, undefined, { numeric: true }) ||
    left.rightId.localeCompare(right.rightId, undefined, { numeric: true })
  );
}

function numberOr<T>(value: unknown, fallback: T) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
