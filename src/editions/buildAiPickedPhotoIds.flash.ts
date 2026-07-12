import type { AiSettings, DuplicateGroup, PhotoGroup } from '../types';
import { buildAiPickedPhotoIds } from '../utils/photoScoring';
import {
  buildFlashPersonaPickedPhotoIds,
  shouldUseFlashPersonaRanking,
  type FlashPersonaRankingOptions,
} from '../utils/flashPersonaRanking';

export function buildEditionAiPickedPhotoIds(
  photos: PhotoGroup[],
  duplicateBestPhotoIds?: ReadonlySet<string>,
  duplicatePhotoIds?: ReadonlySet<string>,
  targetRatio?: number,
  duplicateGroups?: DuplicateGroup[],
  settings?: AiSettings,
) {
  // Flash版persona ranking选项
  const flashPersonaOptions: FlashPersonaRankingOptions = {
    settings: {
      enabled: settings?.flashPersonaRanking?.enabled === true,
    },
  };

  // 如果启用Flash版persona ranking，使用新算法
  if (shouldUseFlashPersonaRanking(flashPersonaOptions)) {
    const ratio = targetRatio ?? 0.5;
    return buildFlashPersonaPickedPhotoIds(photos, ratio, duplicateGroups, flashPersonaOptions);
  }

  // 否则使用原有的基础算法
  return buildAiPickedPhotoIds(photos, duplicateBestPhotoIds, duplicatePhotoIds, targetRatio, duplicateGroups);
}
