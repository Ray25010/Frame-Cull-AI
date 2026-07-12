import { PhotoGroup, SelectionState } from '../types';

export function applyAiReviewSelection(photo: PhotoGroup, selection: SelectionState): PhotoGroup {
  return {
    ...photo,
    selection,
    ai: photo.ai ? {
      ...photo.ai,
      reviewed: selection !== SelectionState.UNMARKED,
    } : photo.ai,
  };
}
