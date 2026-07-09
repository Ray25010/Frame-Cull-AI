import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { PhotoFilter, PhotoGroup, PhotoRating, PhotoRatingFilter, SelectionState } from '../types';
import { filterPhotos } from '../utils/photoFilters';

/**
 * Manages Lightroom-style filtering, preview navigation, and multi-selection.
 */
export function usePhotoNavigation(
  photos: PhotoGroup[],
  duplicatePhotoIds?: ReadonlySet<string>,
  duplicateBestPhotoIds?: ReadonlySet<string>,
  aiPickedReady = true,
  aiPickedPhotoIds?: ReadonlySet<string>,
) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [filter, setFilterInternal] = useState<PhotoFilter>('ALL');
  const [ratingFilter, setRatingFilterInternal] = useState<PhotoRatingFilter>('RATING_ALL');
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]);
  const [anchorPhotoId, setAnchorPhotoId] = useState<string | null>(null);
  const [lastSelectedIds, setLastSelectedIds] = useState<Record<PhotoFilter, string | null>>({
    ALL: null,
    PICKED: null,
    REJECTED: null,
    UNMARKED: null,
    ORPHANS: null,
    AI_REVIEW: null,
    AI_NORMAL: null,
    AI_PICKED: null,
    GROUP_PHOTO: null,
    DUPLICATES: null,
  });
  const pendingNavigateIndexRef = useRef<number | null>(null);
  const navigateFrameRef = useRef<number | null>(null);

  const filteredPhotos = useMemo(
    () => filterPhotos(photos, filter, ratingFilter, duplicatePhotoIds, duplicateBestPhotoIds, aiPickedReady, aiPickedPhotoIds),
    [photos, filter, ratingFilter, duplicatePhotoIds, duplicateBestPhotoIds, aiPickedReady, aiPickedPhotoIds],
  );

  const currentPhoto = selectedIndex !== null ? filteredPhotos[selectedIndex] : null;

  const selectedPhotos = useMemo(() => {
    const selectedSet = new Set(selectedPhotoIds);
    return photos.filter(photo => selectedSet.has(photo.id));
  }, [photos, selectedPhotoIds]);

  const currentSelectionTarget = useMemo(() => {
    if (selectedPhotos.length > 0) return selectedPhotos;
    return currentPhoto ? [currentPhoto] : [];
  }, [currentPhoto, selectedPhotos]);

  const selectedCount = selectedPhotoIds.length;

  const commitSelectedIndex = useCallback((nextIndex: number) => {
    const nextPhoto = filteredPhotos[nextIndex];
    if (!nextPhoto) return;

    setSelectedIndex(nextIndex);
    setSelectedPhotoIds([nextPhoto.id]);
    setAnchorPhotoId(nextPhoto.id);
    setLastSelectedIds(prev => ({ ...prev, [filter]: nextPhoto.id }));
  }, [filteredPhotos, filter]);

  const navigate = useCallback((direction: 'prev' | 'next') => {
    if (selectedIndex === null || filteredPhotos.length === 0) return;

    const baseIndex = pendingNavigateIndexRef.current ?? selectedIndex;
    const nextIndex = direction === 'next'
      ? (baseIndex + 1) % filteredPhotos.length
      : (baseIndex - 1 + filteredPhotos.length) % filteredPhotos.length;
    pendingNavigateIndexRef.current = nextIndex;

    if (navigateFrameRef.current !== null) return;
    navigateFrameRef.current = window.requestAnimationFrame(() => {
      navigateFrameRef.current = null;
      const queuedIndex = pendingNavigateIndexRef.current;
      pendingNavigateIndexRef.current = null;
      if (queuedIndex !== null) commitSelectedIndex(queuedIndex);
    });
  }, [commitSelectedIndex, selectedIndex, filteredPhotos.length]);

  const updateSelectionWithAnimation = useCallback((
    state: SelectionState,
    onUpdate: (photoId: string, state: SelectionState) => void,
  ) => {
    if (selectedIndex === null || !currentPhoto) return;

    const targetIds = currentSelectionTarget.length > 0
      ? currentSelectionTarget.map(photo => photo.id)
      : [currentPhoto.id];

    targetIds.forEach(photoId => onUpdate(photoId, state));
    setLastSelectedIds(prev => ({
      ...prev,
      [filter]: currentPhoto.id,
    }));
  }, [selectedIndex, currentPhoto, currentSelectionTarget, filter]);

  const updateRatingForSelection = useCallback((
    rating: PhotoRating,
    onUpdate: (photoIds: string[], rating: PhotoRating) => void | Promise<void>,
  ) => {
    if (!currentPhoto && selectedPhotoIds.length === 0) return;
    const targetIds = selectedPhotoIds.length > 0 ? selectedPhotoIds : currentPhoto ? [currentPhoto.id] : [];
    void onUpdate(targetIds, rating);
  }, [currentPhoto, selectedPhotoIds]);

  const selectAllFilteredPhotos = useCallback(() => {
    if (filteredPhotos.length === 0) return;
    setSelectedPhotoIds(filteredPhotos.map(photo => photo.id));
    const anchorId = currentPhoto?.id ?? filteredPhotos[selectedIndex ?? 0]?.id ?? filteredPhotos[0].id;
    setAnchorPhotoId(anchorId);
  }, [currentPhoto, filteredPhotos, selectedIndex]);

  const clearMultiSelection = useCallback(() => {
    const currentId = currentPhoto?.id;
    if (!currentId) {
      setSelectedPhotoIds([]);
      setAnchorPhotoId(null);
      return;
    }

    setSelectedPhotoIds([currentId]);
    setAnchorPhotoId(currentId);
  }, [currentPhoto]);

  const selectPhotoByIndex = useCallback((
    index: number,
    mode: 'replace' | 'toggle' | 'range' = 'replace',
  ) => {
    if (index < 0 || index >= filteredPhotos.length) return;
    if (navigateFrameRef.current !== null) {
      window.cancelAnimationFrame(navigateFrameRef.current);
      navigateFrameRef.current = null;
      pendingNavigateIndexRef.current = null;
    }

    const photo = filteredPhotos[index];

    if (mode === 'range') {
      const anchorIndex = anchorPhotoId
        ? filteredPhotos.findIndex(item => item.id === anchorPhotoId)
        : selectedIndex ?? index;
      const start = Math.min(anchorIndex === -1 ? index : anchorIndex, index);
      const end = Math.max(anchorIndex === -1 ? index : anchorIndex, index);
      setSelectedPhotoIds(filteredPhotos.slice(start, end + 1).map(item => item.id));
      return;
    }

    if (mode === 'toggle') {
      setSelectedPhotoIds(prev => {
        const exists = prev.includes(photo.id);
        const next = exists ? prev.filter(id => id !== photo.id) : [...prev, photo.id];
        return next.length > 0 ? next : [photo.id];
      });
      setAnchorPhotoId(photo.id);
      return;
    }

    setSelectedIndex(index);
    setLastSelectedIds(prev => ({
      ...prev,
      [filter]: photo.id,
    }));
    setSelectedPhotoIds([photo.id]);
    setAnchorPhotoId(photo.id);
  }, [anchorPhotoId, filter, filteredPhotos, selectedIndex]);

  const selectPhotoById = useCallback((photoId: string, mode: 'replace' | 'toggle' | 'range' = 'replace') => {
    const index = filteredPhotos.findIndex(p => p.id === photoId);
    if (index !== -1) selectPhotoByIndex(index, mode);
  }, [filteredPhotos, selectPhotoByIndex]);

  const setFilter = useCallback((newFilter: PhotoFilter) => {
    if (selectedIndex !== null && filteredPhotos[selectedIndex]) {
      setLastSelectedIds(prev => ({
        ...prev,
        [filter]: filteredPhotos[selectedIndex].id,
      }));
    }

    setFilterInternal(newFilter);
  }, [filter, selectedIndex, filteredPhotos]);

  const setRatingFilter = useCallback((newFilter: PhotoRatingFilter) => {
    setRatingFilterInternal(newFilter);
  }, []);

  useEffect(() => {
    pendingNavigateIndexRef.current = null;
    if (navigateFrameRef.current !== null) {
      window.cancelAnimationFrame(navigateFrameRef.current);
      navigateFrameRef.current = null;
    }
  }, [filteredPhotos, filter]);

  useEffect(() => () => {
    if (navigateFrameRef.current !== null) {
      window.cancelAnimationFrame(navigateFrameRef.current);
    }
  }, []);

  useEffect(() => {
    const availableIds = new Set(filteredPhotos.map(photo => photo.id));
    setSelectedPhotoIds(prev => {
      const next = prev.filter(id => availableIds.has(id));
      return next.length === prev.length ? prev : next;
    });

    if (filteredPhotos.length === 0) {
      setSelectedIndex(null);
      return;
    }

    const visibleSelectedIds = selectedPhotoIds.filter(id => availableIds.has(id));

    if (visibleSelectedIds.length > 1) {
      if (currentPhoto && availableIds.has(currentPhoto.id)) {
        const currentIndex = filteredPhotos.findIndex(photo => photo.id === currentPhoto.id);
        if (currentIndex !== -1 && currentIndex !== selectedIndex) setSelectedIndex(currentIndex);
        return;
      }

      const anchorId = anchorPhotoId && availableIds.has(anchorPhotoId)
        ? anchorPhotoId
        : visibleSelectedIds[0];
      const anchorIndex = filteredPhotos.findIndex(photo => photo.id === anchorId);
      if (anchorIndex !== -1) {
        setSelectedIndex(anchorIndex);
        setAnchorPhotoId(anchorId);
        return;
      }
    }

    const singleSelectedId = visibleSelectedIds.length === 1 ? visibleSelectedIds[0] : null;
    const preferredId = singleSelectedId
      || (currentPhoto && availableIds.has(currentPhoto.id) ? currentPhoto.id : null)
      || lastSelectedIds[filter];

    if (preferredId) {
      const index = filteredPhotos.findIndex(p => p.id === preferredId);
      if (index !== -1) {
        setSelectedIndex(index);
        setSelectedPhotoIds(prev => (
          prev.length === 1 && prev[0] === preferredId ? prev : [preferredId]
        ));
        setAnchorPhotoId(preferredId);
        return;
      }
    }

    setSelectedIndex(0);
    setSelectedPhotoIds(prev => (
      prev.length === 1 && prev[0] === filteredPhotos[0].id ? prev : [filteredPhotos[0].id]
    ));
    setAnchorPhotoId(filteredPhotos[0].id);
  }, [filteredPhotos, filter, lastSelectedIds, currentPhoto, selectedIndex, selectedPhotoIds, anchorPhotoId]);

  const autoSelectFirst = useCallback(() => {
    if (filteredPhotos.length > 0 && selectedIndex === null) {
      setSelectedIndex(0);
      setSelectedPhotoIds([filteredPhotos[0].id]);
      setAnchorPhotoId(filteredPhotos[0].id);
      setLastSelectedIds(prev => ({
        ...prev,
        [filter]: filteredPhotos[0].id,
      }));
    }
  }, [filteredPhotos, selectedIndex, filter]);

  return {
    selectedIndex,
    setSelectedIndex,
    filter,
    setFilter,
    ratingFilter,
    setRatingFilter,
    filteredPhotos,
    currentPhoto,
    selectedPhotoIds,
    selectedPhotos,
    selectedCount,
    currentSelectionTarget,
    navigate,
    updateSelectionWithAnimation,
    updateRatingForSelection,
    selectAllFilteredPhotos,
    clearMultiSelection,
    selectPhotoByIndex,
    selectPhotoById,
    autoSelectFirst,
  };
}
