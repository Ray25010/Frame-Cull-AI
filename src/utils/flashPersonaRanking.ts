import type { AiPhotoScoreComponentKey, DuplicateGroup, PhotoGroup } from '../types';
import { SelectionState } from '../types';
import { duplicateSimilarity } from './duplicateDetection';
import { comparablePhotoTimeGap, filenameNumericGap, photoSortValue, trailingNumber } from './photoTime';

/**
 * Flash版persona ranking - 不依赖Pro版的原生ONNX personaScore
 * 使用Flash版已有的特征（aesthetic, technical, scene等）来模拟persona ranking行为
 */

export const FLASH_PERSONA_RANKING_VERSION = 'flash-persona-ranking-v1-fallback';

export type FlashPersonaRankingSettings = {
  enabled: boolean;
};

export type FlashPersonaRankingOptions = {
  settings?: FlashPersonaRankingSettings;
};

type RatioProfile = {
  ratio: number;
  gateMode: 'hard-only';
  groupMode: 'known' | 'pair-threshold';
  maxBurstSize: number;
  similarityThreshold?: number;
  maxNumericGap?: number;
  maxTimeGapMs?: number;
};

type FlashPersonaRecord = {
  id: string;
  photo: PhotoGroup;
  sourceFolder: string;
  numericId: number | null;
};

type FlashPersonaGroup = {
  id: string;
  source: string;
  photoIds: string[];
};

const FLASH_PERSONA_SELECTED_RATIO_PROFILES: RatioProfile[] = [
  {
    ratio: 0.38,
    gateMode: 'hard-only',
    groupMode: 'known',
    maxBurstSize: 5,
  },
  {
    ratio: 0.45,
    gateMode: 'hard-only',
    groupMode: 'known',
    maxBurstSize: 5,
  },
  {
    ratio: 0.5,
    gateMode: 'hard-only',
    groupMode: 'pair-threshold',
    maxBurstSize: 4,
    similarityThreshold: 0.92,
    maxNumericGap: 12,
    maxTimeGapMs: 1000 * 60 * 8,
  },
  {
    ratio: 0.6,
    gateMode: 'hard-only',
    groupMode: 'pair-threshold',
    maxBurstSize: 4,
    similarityThreshold: 0.92,
    maxNumericGap: 12,
    maxTimeGapMs: 1000 * 60 * 8,
  },
];

export function shouldUseFlashPersonaRanking(options?: FlashPersonaRankingOptions) {
  return options?.settings?.enabled === true;
}

/**
 * Flash版persona rank分数 - 使用已有特征模拟persona行为
 * 核心思路：通过组合已有特征来近似Pro版的persona score效果
 */
export function flashPersonaRankScore(photo: PhotoGroup) {
  const overall = photo.ai?.photoScore?.overall ?? 0;
  const technical = componentScore(photo, 'TECHNICAL_QUALITY');
  const aesthetic = componentScore(photo, 'AESTHETIC_QUALITY');
  const scene = componentScore(photo, 'SCENE_FIT');
  const nativeAesthetic = photo.ai?.photoScore?.aesthetic?.score ?? aesthetic;

  // Flash版特征：使用已有的指标来模拟persona score
  const focusReliability = photo.ai?.metrics?.focusReliabilityScore ??
    (photo.ai?.metrics?.focusReliable === false ? 0.38 : 0.5);
  const primaryFace = getPrimaryFace(photo);
  const subjectScore = primaryFace?.subjectScore ?? photo.ai?.metrics?.subjectConfidenceScore ?? 0.5;
  const subjectConfidence = parseSubjectConfidence(photo.ai?.metrics?.subjectConfidence);
  const faceQuality = primaryFace?.faceQualityScore ?? photo.ai?.metrics?.faceQualityScore ?? 0.5;
  const centerScore = primaryFace?.centerScore ?? 0.5;

  // 模拟persona score：组合主体相关的特征
  // persona关注的是"人物主体的表现力"，我们用已有特征近似
  const personaProxy =
    subjectScore * 0.35 +
    subjectConfidence * 0.25 +
    faceQuality * 0.20 +
    centerScore * 0.10 +
    focusReliability * 0.10;

  const reviewPenalty = (photo.ai?.issues ?? [])
    .filter(issue => issue.level === 'REVIEW_HINT').length * 4;

  // Flash版persona ranking公式 - 调整权重来匹配Pro版v16b的行为
  const personaBonus = personaProxy >= 0.65 ? 16 : personaProxy >= 0.58 ? 8 : 0;

  return (
    overall * 0.52 +
    technical * 0.26 +
    scene * 0.22 +
    nativeAesthetic * 0.14 +
    personaProxy * 44 +
    focusReliability * 4.2 +
    personaBonus -
    reviewPenalty
  );
}

export function buildFlashPersonaPickedPhotoIds(
  photos: PhotoGroup[],
  targetRatio: number,
  duplicateGroups: DuplicateGroup[] = [],
  _options: FlashPersonaRankingOptions = {},
) {
  const profile = profileForRatio(targetRatio);
  const records = photos.map(toRecord).sort(compareRecordOrder);
  const usable = records.filter(record => isFlashPersonaUsablePhoto(record.photo));
  const target = Math.max(0, Math.ceil(usable.length * targetRatio));
  const byId = new Map(records.map(record => [record.id, record]));
  const groups = buildAllGroups(records, duplicateGroups, profile);
  const groupedIds = new Set(groups.flatMap(group => group.photoIds));
  const selected = new Set<string>();

  // 从每个组中选择最佳代表
  for (const group of groups) {
    const candidates = group.photoIds
      .map(id => byId.get(id))
      .filter((record): record is FlashPersonaRecord =>
        Boolean(record && isFlashPersonaUsablePhoto(record.photo)));
    const representative = topByFlashPersonaRank(candidates);
    if (representative) selected.add(representative.id);
  }

  // 处理单张照片
  const solos = usable
    .filter(record => !groupedIds.has(record.id))
    .sort((left, right) =>
      flashPersonaRankScore(right.photo) - flashPersonaRankScore(left.photo) ||
      compareRecordOrder(left, right));

  for (const record of solos) {
    if (selected.size >= target) break;
    selected.add(record.id);
  }

  return selected;
}

// Helper functions

function componentScore(photo: PhotoGroup, key: AiPhotoScoreComponentKey) {
  const components = photo.ai?.photoScore?.components;
  const component = components?.find(item => item.key === key);
  return typeof component?.score === 'number' ? component.score : 0;
}

function parseSubjectConfidence(confidence: unknown) {
  if (typeof confidence === 'number') return confidence;
  if (confidence === 'HIGH') return 0.85;
  if (confidence === 'MEDIUM') return 0.6;
  if (confidence === 'LOW') return 0.35;
  return 0.5;
}

function profileForRatio(targetRatio: number): RatioProfile {
  const sorted = [...FLASH_PERSONA_SELECTED_RATIO_PROFILES].sort((a, b) =>
    Math.abs(a.ratio - targetRatio) - Math.abs(b.ratio - targetRatio));
  return sorted[0] || FLASH_PERSONA_SELECTED_RATIO_PROFILES[0];
}

function isFlashPersonaUsablePhoto(photo: PhotoGroup) {
  if (photo.selection === SelectionState.REJECTED) return false;
  const hardIssues = (photo.ai?.issues ?? []).filter(issue => issue.level === 'ISSUE');
  return hardIssues.length === 0;
}

function toRecord(photo: PhotoGroup): FlashPersonaRecord {
  const sourcePath = photo.jpg?.path ?? photo.raw?.path ?? photo.id;
  const parts = sourcePath.split(/[\\/]/);
  const folder = parts.slice(0, -1).join('/') || '/';
  const numericId = trailingNumber(photo.id);
  return { id: photo.id, photo, sourceFolder: folder, numericId };
}

function topByFlashPersonaRank(records: FlashPersonaRecord[]): FlashPersonaRecord | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((left, right) =>
    flashPersonaRankScore(right.photo) - flashPersonaRankScore(left.photo) ||
    compareRecordOrder(left, right));
  return sorted[0] || null;
}

function buildAllGroups(
  records: FlashPersonaRecord[],
  duplicateGroups: DuplicateGroup[],
  profile: RatioProfile,
): FlashPersonaGroup[] {
  const groups: FlashPersonaGroup[] = [];
  const usedIds = new Set<string>();

  // 已知重复组
  for (const dupGroup of duplicateGroups) {
    if (dupGroup.photoIds.length === 0) continue;
    const groupIds = dupGroup.photoIds.filter(id => !usedIds.has(id));
    if (groupIds.length > 1) {
      groups.push({ id: `dup-${dupGroup.photoIds[0]}`, source: 'duplicate', photoIds: groupIds });
      groupIds.forEach(id => usedIds.add(id));
    }
  }

  // Pair threshold模式：基于相似度和时间/数字间隔
  if (profile.groupMode === 'pair-threshold') {
    const ungrouped = records.filter(record => !usedIds.has(record.id));
    for (let i = 0; i < ungrouped.length; i += 1) {
      if (usedIds.has(ungrouped[i].id)) continue;
      const burstGroup: string[] = [ungrouped[i].id];
      usedIds.add(ungrouped[i].id);

      for (let j = i + 1; j < ungrouped.length && burstGroup.length < profile.maxBurstSize; j += 1) {
        if (usedIds.has(ungrouped[j].id)) continue;
        const left = ungrouped[i].photo;
        const right = ungrouped[j].photo;

        const leftSignature = left.ai?.duplicateSignature;
        const rightSignature = right.ai?.duplicateSignature;
        if (!leftSignature || !rightSignature) continue;

        const similarity = duplicateSimilarity(leftSignature, rightSignature);
        const numericGap = filenameNumericGap(left.id, right.id) ?? Number.POSITIVE_INFINITY;
        const timeGap = comparablePhotoTimeGap(left, right);

        if (
          similarity >= (profile.similarityThreshold ?? 0.92) &&
          numericGap <= (profile.maxNumericGap ?? 12) &&
          (timeGap === undefined || timeGap.gapMs <= (profile.maxTimeGapMs ?? 480000))
        ) {
          burstGroup.push(ungrouped[j].id);
          usedIds.add(ungrouped[j].id);
        }
      }

      if (burstGroup.length > 1) {
        groups.push({ id: `burst-${burstGroup[0]}`, source: 'pair-threshold', photoIds: burstGroup });
      }
    }
  }

  return groups;
}

function getPrimaryFace(photo: PhotoGroup) {
  const faces = photo.ai?.diagnostics?.faceDiagnostics ?? [];
  const primaryIndex = photo.ai?.diagnostics?.primaryFaceIndices?.[0];
  return faces.find(face => face.index === primaryIndex)
    ?? faces.find(face => face.subjectRole === 'PRIMARY')
    ?? faces.find(face => face.eligibleAsPrimary)
    ?? faces[0];
}

function compareRecordOrder(left?: FlashPersonaRecord, right?: FlashPersonaRecord) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const folder = String(left.sourceFolder).localeCompare(String(right.sourceFolder), undefined, { numeric: true });
  if (folder !== 0) return folder;
  return (
    (left.numericId ?? Number.MAX_SAFE_INTEGER) - (right.numericId ?? Number.MAX_SAFE_INTEGER) ||
    photoSortValue(left.photo) - photoSortValue(right.photo) ||
    String(left.id).localeCompare(String(right.id), undefined, { numeric: true })
  );
}
