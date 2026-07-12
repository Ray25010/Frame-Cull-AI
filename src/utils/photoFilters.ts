import { GroupStatus, PhotoFilter, PhotoGroup, PhotoRatingFilter, SelectionState } from '../types';
import { buildAiPickedPhotoIds, isAiPickedPhoto } from './photoScoring';

export const STATUS_FILTERS: PhotoFilter[] = ['ALL', 'AI_NORMAL', 'AI_PICKED', 'AI_REVIEW', 'GROUP_PHOTO', 'DUPLICATES', 'PICKED', 'REJECTED', 'UNMARKED', 'ORPHANS'];
export const RATING_FILTERS: PhotoRatingFilter[] = [
  'RATING_ALL',
  'RATING_NONE',
  'RATING_1_PLUS',
  'RATING_2_PLUS',
  'RATING_3_PLUS',
  'RATING_4_PLUS',
  'RATING_5',
];

export function isAiReviewPhoto(photo: PhotoGroup) {
  return (photo.ai?.issues.length ?? 0) > 0 && !photo.ai?.reviewed;
}

export function isAiNormalPhoto(photo: PhotoGroup) {
  return photo.ai?.status === 'DONE' && !isAiReviewPhoto(photo);
}

export function isGroupPhoto(photo: PhotoGroup) {
  return photo.ai?.diagnostics?.photoKind === 'GROUP_PORTRAIT';
}

export function isDuplicatePhoto(photo: PhotoGroup, duplicatePhotoIds?: ReadonlySet<string>) {
  return duplicatePhotoIds?.has(photo.id) ?? false;
}

export function matchesStatusFilter(
  photo: PhotoGroup,
  filter: PhotoFilter,
  duplicatePhotoIds?: ReadonlySet<string>,
  duplicateBestPhotoIds?: ReadonlySet<string>,
  aiPickedReady = true,
  aiPickedPhotoIds?: ReadonlySet<string>,
) {
  switch (filter) {
    case 'PICKED':
      return photo.selection === SelectionState.PICKED;
    case 'REJECTED':
      return photo.selection === SelectionState.REJECTED;
    case 'UNMARKED':
      return photo.selection === SelectionState.UNMARKED;
    case 'ORPHANS':
      return photo.status !== GroupStatus.COMPLETE;
    case 'AI_REVIEW':
      return isAiReviewPhoto(photo);
    case 'AI_NORMAL':
      return isAiNormalPhoto(photo);
    case 'AI_PICKED':
      if (!aiPickedReady) return false;
      if (aiPickedPhotoIds) return aiPickedPhotoIds.has(photo.id);
      return isAiPickedPhoto(photo, duplicateBestPhotoIds, duplicatePhotoIds);
    case 'GROUP_PHOTO':
      return isGroupPhoto(photo);
    case 'DUPLICATES':
      return isDuplicatePhoto(photo, duplicatePhotoIds);
    case 'ALL':
    default:
      return true;
  }
}

export function matchesRatingFilter(photo: PhotoGroup, filter: PhotoRatingFilter) {
  const rating = photo.rating ?? 0;
  switch (filter) {
    case 'RATING_NONE':
      return rating === 0;
    case 'RATING_1_PLUS':
      return rating >= 1;
    case 'RATING_2_PLUS':
      return rating >= 2;
    case 'RATING_3_PLUS':
      return rating >= 3;
    case 'RATING_4_PLUS':
      return rating >= 4;
    case 'RATING_5':
      return rating === 5;
    case 'RATING_ALL':
    default:
      return true;
  }
}

export function filterPhotos(
  photos: PhotoGroup[],
  statusFilter: PhotoFilter,
  ratingFilter: PhotoRatingFilter,
  duplicatePhotoIds?: ReadonlySet<string>,
  duplicateBestPhotoIds?: ReadonlySet<string>,
  aiPickedReady = true,
  aiPickedPhotoIds?: ReadonlySet<string>,
) {
  const resolvedAiPickedPhotoIds = statusFilter === 'AI_PICKED' && aiPickedReady
    ? aiPickedPhotoIds ?? buildAiPickedPhotoIds(photos, duplicateBestPhotoIds, duplicatePhotoIds)
    : aiPickedPhotoIds;
  return photos.filter(photo => (
    matchesStatusFilter(photo, statusFilter, duplicatePhotoIds, duplicateBestPhotoIds, aiPickedReady, resolvedAiPickedPhotoIds)
    && matchesRatingFilter(photo, ratingFilter)
  ));
}

export function normalizeRating(value: unknown): 0 | 1 | 2 | 3 | 4 | 5 {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.min(5, Math.round(numberValue))) as 0 | 1 | 2 | 3 | 4 | 5;
}
