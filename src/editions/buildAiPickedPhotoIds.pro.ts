import type { AiSettings, DuplicateGroup, PhotoGroup } from '../types';
import { buildAiPickedPhotoIds } from '../utils/photoScoring';
import { buildProPersonaPickedPhotoIds, shouldUseProPersonaRanking } from '../utils/proPersonaRanking';

export function buildEditionAiPickedPhotoIds(
  photos: PhotoGroup[],
  duplicateBestPhotoIds?: ReadonlySet<string>,
  duplicatePhotoIds?: ReadonlySet<string>,
  targetRatio = 0.6,
  duplicateGroups: DuplicateGroup[] = [],
  settings?: AiSettings,
) {
  if (shouldUseProPersonaRanking({ settings: settings?.proPersonaRanking })) {
    return buildProPersonaPickedPhotoIds(photos, targetRatio, duplicateGroups, {
      settings: settings?.proPersonaRanking,
    });
  }

  return buildAiPickedPhotoIds(photos, duplicateBestPhotoIds, duplicatePhotoIds, targetRatio, duplicateGroups);
}
