import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { AiAnalysis, ExportMode, ExportOperation, ExportStreamEvent, GroupStatus, ImportProgress, PhotoGroup, PhotoRating, SelectionState } from '../types';
import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { applyAiReviewSelection } from '../utils/aiReview';
import { createAiDemoPhotos } from '../utils/demoPhotos';
import { isAiNormalPhoto, isAiReviewPhoto, isGroupPhoto, normalizeRating } from '../utils/photoFilters';
import { applyCachedPhotoState, forgetPhotoState, loadPhotoStateCache, rememberPhotoState } from '../utils/photoStateCache';
import { hasTauriRuntime } from '../utils/tauriRuntime';

type RustPhotoGroup = {
  id: string;
  jpg: RustPhotoFile | null;
  raw: RustPhotoFile | null;
  status: GroupStatus;
  rating: PhotoRating;
  exif: PhotoGroup['exif'] | null;
};

type RustPhotoFile = {
  name: string;
  extension: string;
  path?: string;
  size: number;
  modifiedMs?: number;
};

type ImportProgressPayload = {
  phase: ImportProgress['phase'];
  processed: number;
  total: number;
  current?: string;
};

type ImportStreamPayload = {
  kind: 'started' | 'progress' | 'groups' | 'metadata' | 'done' | 'error';
  phase?: ImportProgress['phase'] | 'final';
  processed?: number;
  total?: number;
  current?: string;
  groups?: RustPhotoGroup[];
  error?: string;
};

const IDLE_IMPORT_PROGRESS: ImportProgress = {
  phase: 'idle',
  total: 0,
  processed: 0,
  running: false,
};

export function toRustGroups(groups: PhotoGroup[]): RustPhotoGroup[] {
  return groups.map(group => ({
    id: group.id,
    jpg: group.jpg ? {
      name: group.jpg.name,
      extension: group.jpg.extension,
      path: group.jpg.path,
      size: group.jpg.size,
      modifiedMs: group.jpg.modifiedMs,
    } : null,
    raw: group.raw ? {
      name: group.raw.name,
      extension: group.raw.extension,
      path: group.raw.path,
      size: group.raw.size,
      modifiedMs: group.raw.modifiedMs,
    } : null,
    status: group.status,
    rating: group.rating ?? 0,
    exif: group.exif || null,
  }));
}

export function usePhotoState() {
  const [photos, setPhotos] = useState<PhotoGroup[]>(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('ai-demo')) {
      return createAiDemoPhotos();
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress>(IDLE_IMPORT_PROGRESS);
  const pendingAiUpdatesRef = useRef<Map<string, AiAnalysis>>(new Map());
  const aiUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const convertRustGroupsToPhotoGroups = useCallback((rustGroups: any[]): PhotoGroup[] => {
    const cache = loadPhotoStateCache();
    return rustGroups.map(group => applyCachedPhotoState({
      id: group.id,
      jpg: group.jpg ? {
        name: group.jpg.name,
        extension: group.jpg.extension,
        file: null as any,
        previewUrl: convertFileSrc(group.jpg.path),
        size: group.jpg.size,
        modifiedMs: group.jpg.modifiedMs,
        path: group.jpg.path,
      } : undefined,
      raw: group.raw ? {
        name: group.raw.name,
        extension: group.raw.extension,
        file: null as any,
        previewUrl: convertFileSrc(group.raw.path),
        size: group.raw.size,
        modifiedMs: group.raw.modifiedMs,
        path: group.raw.path,
      } : undefined,
      status: group.status as GroupStatus,
      selection: SelectionState.UNMARKED,
      rating: normalizeRating(group.rating),
      exif: group.exif,
    }, cache));
  }, []);

  const updateImportedGroupMetadata = useCallback((rustGroups: RustPhotoGroup[]) => {
    const enrichedGroups = convertRustGroupsToPhotoGroups(rustGroups);
    const metadataByPath = new Map<string, Pick<PhotoGroup, 'exif' | 'rating'>>();

    enrichedGroups.forEach(group => {
      if (group.jpg?.path) metadataByPath.set(group.jpg.path, { exif: group.exif, rating: group.rating });
      if (group.raw?.path) metadataByPath.set(group.raw.path, { exif: group.exif, rating: group.rating });
    });

    setPhotos(prev => prev.map(photo => {
      const metadata = (photo.jpg?.path && metadataByPath.get(photo.jpg.path))
        || (photo.raw?.path && metadataByPath.get(photo.raw.path));
      if (!metadata) return photo;
      return {
        ...photo,
        exif: metadata.exif || photo.exif,
        rating: normalizeRating(metadata.rating),
      };
    }));
  }, [convertRustGroupsToPhotoGroups]);

  const enrichMetadataInBackground = useCallback((rustGroups: RustPhotoGroup[]) => {
    if (!hasTauriRuntime() || rustGroups.length === 0) return;

    void invoke<RustPhotoGroup[]>('enrich_photo_metadata', { groups: rustGroups })
      .then(result => {
        updateImportedGroupMetadata(result);
        setImportProgress(prev => ({
          ...prev,
          phase: 'done',
          running: false,
          processed: prev.total || result.length,
          total: prev.total || result.length,
        }));
        window.setTimeout(() => setImportProgress(IDLE_IMPORT_PROGRESS), 900);
      })
      .catch(error => {
        console.warn('Failed to enrich imported metadata:', error);
        setImportProgress(prev => ({ ...prev, phase: 'error', running: false }));
      });
  }, [updateImportedGroupMetadata]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;

    let mounted = true;
    let cleanup: (() => void) | undefined;
    void listen<ImportProgressPayload>('framecull://import-progress', event => {
      if (!mounted) return;
      const payload = event.payload;
      setImportProgress({
        phase: payload.phase,
        total: payload.total,
        processed: payload.processed,
        current: payload.current,
        running: payload.phase !== 'done' && payload.phase !== 'error' && payload.total > 0,
      });
    }).then(unlisten => {
      cleanup = unlisten;
      if (!mounted) {
        unlisten();
      }
    });

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, []);

  const mergeImportedGroups = useCallback((existingPhotos: PhotoGroup[], newGroups: PhotoGroup[]): { mergedPhotos: PhotoGroup[], firstNewGroupId: string | null } => {
    const existingPathMap = new Map<string, PhotoGroup>();
    existingPhotos.forEach(group => {
      if (group.jpg?.path) existingPathMap.set(group.jpg.path, group);
      if (group.raw?.path) existingPathMap.set(group.raw.path, group);
    });

    const mergedPhotos = [...existingPhotos];
    let firstNewGroupId: string | null = null;

    newGroups.forEach(newGroup => {
      const jpgDuplicate = newGroup.jpg?.path && existingPathMap.has(newGroup.jpg.path);
      const rawDuplicate = newGroup.raw?.path && existingPathMap.has(newGroup.raw.path);

      if ((newGroup.jpg && jpgDuplicate) && (newGroup.raw && rawDuplicate)) return;
      if ((newGroup.jpg && jpgDuplicate) || (newGroup.raw && rawDuplicate)) return;

      const existingOrphanIndex = mergedPhotos.findIndex(existing => {
        if (existing.id !== newGroup.id) return false;
        if (existing.status === GroupStatus.COMPLETE) return false;
        return (
          (existing.status === GroupStatus.JPG_ONLY && newGroup.raw) ||
          (existing.status === GroupStatus.RAW_ONLY && newGroup.jpg)
        );
      });

      if (existingOrphanIndex !== -1) {
        const existingOrphan = mergedPhotos[existingOrphanIndex];
        const mergedGroup: PhotoGroup = {
          ...existingOrphan,
          jpg: existingOrphan.jpg || newGroup.jpg,
          raw: existingOrphan.raw || newGroup.raw,
          status: GroupStatus.COMPLETE,
          rating: Math.max(existingOrphan.rating ?? 0, newGroup.rating ?? 0) as PhotoRating,
          exif: existingOrphan.exif || newGroup.exif,
        };
        mergedPhotos[existingOrphanIndex] = mergedGroup;
        if (firstNewGroupId === null) firstNewGroupId = mergedGroup.id;
      } else {
        mergedPhotos.push(newGroup);
        if (firstNewGroupId === null) firstNewGroupId = newGroup.id;
      }
    });

    return { mergedPhotos, firstNewGroupId };
  }, []);

  const mergeImportedBatch = useCallback((rustGroups: RustPhotoGroup[], onFirstGroup?: (photoId: string) => void) => {
    if (rustGroups.length === 0) return;
    const newGroups = convertRustGroupsToPhotoGroups(rustGroups);
    setPhotos(prev => {
      const { mergedPhotos, firstNewGroupId } = mergeImportedGroups(prev, newGroups);
      if (firstNewGroupId) onFirstGroup?.(firstNewGroupId);
      return mergedPhotos;
    });
  }, [convertRustGroupsToPhotoGroups, mergeImportedGroups]);

  const importWithStream = useCallback((
    command: 'import_files_stream' | 'import_folder_stream',
    args: Record<string, unknown>,
  ): Promise<string | null> => {
    if (!hasTauriRuntime()) {
      return Promise.resolve(null);
    }

    let firstNewGroupId: string | null = null;

    return new Promise((resolve, reject) => {
      const channel = new Channel<ImportStreamPayload>((payload) => {
        if (payload.kind === 'progress') {
          const phase = payload.phase === 'final' ? 'metadata' : payload.phase;
          setImportProgress({
            phase: phase || 'scan',
            total: payload.total ?? 0,
            processed: payload.processed ?? 0,
            current: payload.current,
            running: true,
          });
          return;
        }

        if (payload.kind === 'groups' && payload.groups) {
          mergeImportedBatch(payload.groups, (photoId) => {
            if (!firstNewGroupId) firstNewGroupId = photoId;
          });
          return;
        }

        if (payload.kind === 'metadata' && payload.groups) {
          updateImportedGroupMetadata(payload.groups);
          setImportProgress(prev => ({
            ...prev,
            phase: 'metadata',
            total: payload.total ?? prev.total,
            processed: payload.processed ?? prev.processed,
            running: true,
          }));
          return;
        }

        if (payload.kind === 'done') {
          setImportProgress(prev => ({
            ...prev,
            phase: 'done',
            running: false,
            processed: payload.processed ?? prev.processed,
            total: payload.total ?? prev.total,
          }));
          window.setTimeout(() => setImportProgress(IDLE_IMPORT_PROGRESS), 900);
          resolve(firstNewGroupId);
          return;
        }

        if (payload.kind === 'error') {
          const error = payload.error || 'Import failed';
          setImportProgress(prev => ({ ...prev, phase: 'error', running: false, current: error }));
          reject(new Error(error));
        }
      });

      void invoke<void>(command, { ...args, onEvent: channel }).catch(error => {
        setImportProgress(prev => ({ ...prev, phase: 'error', running: false }));
        reject(error);
      });
    });
  }, [mergeImportedBatch, updateImportedGroupMetadata]);

  const importFiles = useCallback(async (): Promise<string | null> => {
    try {
      setIsLoading(true);
      setImportProgress({ phase: 'scan', total: 0, processed: 0, running: true });
      const filePaths = await open({
        multiple: true,
        filters: [{
          name: 'Images',
          extensions: ['jpg', 'jpeg', 'arw', 'cr2', 'cr3', 'nef', 'nrw', 'dng', 'orf', 'raf', 'rw2', 'srw', 'srf', 'sr2'],
        }],
      });

      if (!filePaths || (Array.isArray(filePaths) && filePaths.length === 0)) {
        setImportProgress(IDLE_IMPORT_PROGRESS);
        return null;
      }

      const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
      if (hasTauriRuntime()) {
        return await importWithStream('import_files_stream', { filePaths: paths });
      }

      const rustGroups = await invoke<RustPhotoGroup[]>('scan_files', { filePaths: paths });
      const newGroups = convertRustGroupsToPhotoGroups(rustGroups);
      const { mergedPhotos, firstNewGroupId } = mergeImportedGroups(photos, newGroups);
      setPhotos(mergedPhotos);
      enrichMetadataInBackground(rustGroups);
      return firstNewGroupId;
    } finally {
      setIsLoading(false);
    }
  }, [photos, convertRustGroupsToPhotoGroups, enrichMetadataInBackground, importWithStream, mergeImportedGroups]);

  const importFolder = useCallback(async (): Promise<string | null> => {
    try {
      setIsLoading(true);
      setImportProgress({ phase: 'scan', total: 0, processed: 0, running: true });
      const folderPath = await open({
        directory: true,
        multiple: false,
        recursive: true,
      });

      if (!folderPath) {
        setImportProgress(IDLE_IMPORT_PROGRESS);
        return null;
      }

      if (hasTauriRuntime()) {
        return await importWithStream('import_folder_stream', { folderPath });
      }

      const rustGroups = await invoke<RustPhotoGroup[]>('scan_folder', { folderPath });
      const newGroups = convertRustGroupsToPhotoGroups(rustGroups);
      const { mergedPhotos, firstNewGroupId } = mergeImportedGroups(photos, newGroups);
      setPhotos(mergedPhotos);
      enrichMetadataInBackground(rustGroups);
      return firstNewGroupId;
    } finally {
      setIsLoading(false);
    }
  }, [photos, convertRustGroupsToPhotoGroups, enrichMetadataInBackground, importWithStream, mergeImportedGroups]);

  const updatePhotoSelection = useCallback((photoId: string, selection: SelectionState) => {
    setPhotos(prev => prev.map(photo => {
      if (photo.id !== photoId) return photo;
      const next = { ...photo, selection };
      rememberPhotoState(next);
      return next;
    }));
  }, []);

  const flushPhotoAiUpdates = useCallback(() => {
    if (aiUpdateTimerRef.current !== null) {
      clearTimeout(aiUpdateTimerRef.current);
      aiUpdateTimerRef.current = null;
    }

    const pending = pendingAiUpdatesRef.current;
    if (pending.size === 0) return;

    const updates = new Map(pending);
    pending.clear();
    setPhotos(prev => {
      let changed = false;
      const next = prev.map(photo => {
        const ai = updates.get(photo.id);
        if (!ai) return photo;
        changed = true;
        return { ...photo, ai };
      });
      return changed ? next : prev;
    });
  }, []);

  const updatePhotoAiAnalysis = useCallback((photoId: string, ai: AiAnalysis) => {
    pendingAiUpdatesRef.current.set(photoId, ai);
    if (aiUpdateTimerRef.current !== null) return;
    aiUpdateTimerRef.current = setTimeout(flushPhotoAiUpdates, 60);
  }, [flushPhotoAiUpdates]);

  useEffect(() => () => {
    if (aiUpdateTimerRef.current !== null) {
      clearTimeout(aiUpdateTimerRef.current);
      aiUpdateTimerRef.current = null;
    }
    pendingAiUpdatesRef.current.clear();
  }, []);

  const reviewAiPhoto = useCallback((photoId: string, selection: SelectionState) => {
    setPhotos(prev => prev.map(photo => {
      if (photo.id !== photoId) return photo;
      const next = applyAiReviewSelection(photo, selection);
      rememberPhotoState(next);
      return next;
    }));
  }, []);

  const updatePhotoRating = useCallback(async (photoIds: string[], rating: PhotoRating) => {
    const ids = Array.from(new Set(photoIds));
    if (ids.length === 0) return;

    const groups = photos.filter(photo => ids.includes(photo.id));
    const previousRatings = new Map(groups.map(group => [group.id, group.rating]));
    setPhotos(prev => prev.map(photo => {
      if (!ids.includes(photo.id)) return photo;
      const next = { ...photo, rating };
      rememberPhotoState(next);
      return next;
    }));

    if (!hasTauriRuntime()) return;

    try {
      await invoke<string[]>('write_rating_metadata', {
        groups: toRustGroups(groups.map(group => ({ ...group, rating }))),
        rating,
      });
    } catch (error) {
      setPhotos(prev => prev.map(photo => {
        const previous = previousRatings.get(photo.id);
        if (typeof previous !== 'number') return photo;
        const next = { ...photo, rating: previous };
        rememberPhotoState(next);
        return next;
      }));
      throw error;
    }
  }, [photos]);

  const deleteRejectedPhotos = useCallback(async (): Promise<number> => {
    const rejectedGroups = photos.filter(p => p.selection === SelectionState.REJECTED);
    if (rejectedGroups.length === 0) return 0;

    const movedFiles = await invoke<string[]>('move_to_trash', { groups: toRustGroups(rejectedGroups) });
    forgetPhotoState(rejectedGroups);
    setPhotos(prev => prev.filter(p => p.selection !== SelectionState.REJECTED));
    return movedFiles.length;
  }, [photos]);

  const deleteOrphanPhotos = useCallback(async (type: 'RAW' | 'JPG'): Promise<number> => {
    const orphanGroups = photos.filter(p => type === 'RAW'
      ? p.status === GroupStatus.RAW_ONLY
      : p.status === GroupStatus.JPG_ONLY);
    if (orphanGroups.length === 0) return 0;

    const movedFiles = await invoke<string[]>('move_to_trash', { groups: toRustGroups(orphanGroups) });
    forgetPhotoState(orphanGroups);
    setPhotos(prev => prev.filter(p => type === 'RAW'
      ? p.status !== GroupStatus.RAW_ONLY
      : p.status !== GroupStatus.JPG_ONLY));
    return movedFiles.length;
  }, [photos]);

  const forceDeletePhotos = useCallback(async (groupsToDelete: PhotoGroup[]): Promise<number> => {
    const deletedFiles = await invoke<string[]>('delete_files_permanently', { groups: toRustGroups(groupsToDelete) });
    forgetPhotoState(groupsToDelete);
    setPhotos(prev => prev.filter(p => !groupsToDelete.find(g => g.id === p.id)));
    return deletedFiles.length;
  }, []);

  const exportPhotos = useCallback(async (
    groups: PhotoGroup[],
    exportMode: Exclude<ExportMode, 'RENDER_JPG' | 'RENDER_TIFF' | 'RENDER_PNG'>,
    operation: ExportOperation,
    destinationFolder: string,
  ): Promise<number> => {
    if (groups.length === 0) return 0;

    const exportedFiles = await invoke<string[]>('export_files', {
      groups: toRustGroups(groups),
      exportMode,
      operation,
      destinationFolder,
    });

    if (operation === 'MOVE') {
      const movedIds = new Set(groups.map(group => group.id));
      forgetPhotoState(groups);
      setPhotos(prev => prev.filter(photo => !movedIds.has(photo.id)));
    }

    return exportedFiles.length;
  }, []);

  const exportPhotosStream = useCallback(async (
    groups: PhotoGroup[],
    exportMode: Exclude<ExportMode, 'RENDER_JPG' | 'RENDER_TIFF' | 'RENDER_PNG'>,
    operation: ExportOperation,
    destinationFolder: string,
    onEvent: Channel<ExportStreamEvent>,
    includeRawSidecars = true,
  ): Promise<string[]> => {
    if (groups.length === 0) return [];

    const exportedFiles = await invoke<string[]>('export_files_stream', {
      groups: toRustGroups(groups),
      exportMode,
      operation,
      destinationFolder,
      onEvent,
      includeRawSidecars,
    });

    if (operation === 'MOVE') {
      const movedIds = new Set(groups.map(group => group.id));
      forgetPhotoState(groups);
      setPhotos(prev => prev.filter(photo => !movedIds.has(photo.id)));
    }

    return exportedFiles;
  }, []);

  const clearCurrentSessionMarks = useCallback(() => {
    setPhotos(prev => prev.map(photo => (
      photo.selection === SelectionState.UNMARKED
        ? photo
        : { ...photo, selection: SelectionState.UNMARKED }
    )));
  }, []);

  const stats = useMemo(() => {
    return {
      total: photos.length,
      picked: photos.filter(p => p.selection === SelectionState.PICKED).length,
      rejected: photos.filter(p => p.selection === SelectionState.REJECTED).length,
      orphans: photos.filter(p => p.status !== GroupStatus.COMPLETE).length,
      orphanRaw: photos.filter(p => p.status === GroupStatus.RAW_ONLY).length,
      orphanJpg: photos.filter(p => p.status === GroupStatus.JPG_ONLY).length,
      unmarked: photos.filter(p => p.selection === SelectionState.UNMARKED).length,
      aiReview: photos.filter(isAiReviewPhoto).length,
      aiNormal: photos.filter(isAiNormalPhoto).length,
      groupPhoto: photos.filter(isGroupPhoto).length,
      duplicates: 0,
      rated: photos.filter(p => (p.rating ?? 0) > 0).length,
    };
  }, [photos]);

  return {
    photos,
    isLoading,
    importProgress,
    stats,
    importFiles,
    importFolder,
    updatePhotoSelection,
    updatePhotoRating,
    updatePhotoAiAnalysis,
    reviewAiPhoto,
    deleteRejectedPhotos,
    deleteOrphanPhotos,
    forceDeletePhotos,
    exportPhotos,
    exportPhotosStream,
    clearCurrentSessionMarks,
  };
}
