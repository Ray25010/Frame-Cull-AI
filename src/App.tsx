import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { open } from '@tauri-apps/plugin-dialog';
import { SelectionState, GroupStatus, ExportOptions, PhotoRating, RawDecodeProgress, ImportProgress, ExportProgress, ExportStreamEvent, PhotoGroup, type LightroomSourceFolderResult } from './types';
import Viewer, { type ViewerAiMode } from './components/Viewer';
import { Toolbar } from './components/Toolbar';
import { Filmstrip } from './components/Filmstrip';
import { EmptyState } from './components/EmptyState';
import { ExportProgressOverlay } from './components/ExportProgressOverlay';
import { NotificationCenter, type AppNotification, type NotificationKind } from './components/NotificationCenter';
import { PeopleSplitWorkspace } from './components/PeopleSplitWorkspace';
import { DuplicateReviewWorkspace } from './components/DuplicateReviewWorkspace';
import ConfirmationModal from './components/ConfirmationModal';
import SettingsPanel from './components/SettingsPanel';
import AiSettingsPanel from './components/AiSettingsPanel';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getTranslations, Language } from './i18n';
import { usePlatform } from './hooks/usePlatform';
import { useTheme } from './hooks/useTheme';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { toRustGroups, usePhotoState } from './hooks/usePhotoState';
import { useModalState } from './hooks/useModalState';
import { usePhotoNavigation } from './hooks/usePhotoNavigation';
import { useAiCulling } from './hooks/useAiCulling';
import { usePeopleSplit } from './hooks/usePeopleSplit';
import { renderGroupForExport } from './utils/aiImage';
import { clearAppCaches, getAppCacheUsage, type AppCacheUsage } from './utils/cacheMaintenance';
import { hasTauriRuntime } from './utils/tauriRuntime';
import { cancelRawPreloads, decodeRawFile, preloadRawWindow, subscribeRawDecodeProgress } from './utils/rawLoader';
import { getDisplayPreviewUrl, loadDisplayImage, preloadDisplayWindow } from './utils/imagePreloader';
import { readStorage } from './utils/storage';
import { buildEditionAiPickedPhotoIds } from '@edition/buildAiPickedPhotoIds';
import { useRawMonitorFeature } from '@edition/useRawMonitorFeature';

const LANGUAGE_STORAGE_KEY = 'framecull-language';
const LIGHTROOM_PATH_STORAGE_KEY = 'framecull-lightroom-classic-path';

const SPLASH_MIN_VISIBLE_MS = 2400;
const SPLASH_FIRST_PAINT_DELAY_MS = 180;
type WorkspaceMode = 'CULLING' | 'PEOPLE_SPLIT';

const IDLE_EXPORT_PROGRESS: ExportProgress = {
  phase: 'idle',
  total: 0,
  processed: 0,
  running: false,
};

function getSelectionTargetAfterRemoval(
  visiblePhotos: PhotoGroup[],
  currentPhotoId: string | undefined,
  removedIds: ReadonlySet<string>,
) {
  if (!currentPhotoId) {
    return visiblePhotos.find(photo => !removedIds.has(photo.id))?.id ?? null;
  }

  if (!removedIds.has(currentPhotoId)) {
    return currentPhotoId;
  }

  const currentIndex = visiblePhotos.findIndex(photo => photo.id === currentPhotoId);
  const searchStart = currentIndex === -1 ? 0 : currentIndex + 1;
  const nextPhoto = visiblePhotos.slice(searchStart).find(photo => !removedIds.has(photo.id));
  if (nextPhoto) return nextPhoto.id;

  const previousPhoto = visiblePhotos.slice(0, Math.max(0, searchStart - 1)).reverse().find(photo => !removedIds.has(photo.id));
  return previousPhoto?.id ?? null;
}

async function launchLightroomAfterExport(options: ExportOptions): Promise<Pick<ExportProgress, 'lightroomLaunchStatus' | 'lightroomExecutablePath' | 'lightroomMessage'>> {
  if (options.exportTarget !== 'LIGHTROOM_CLASSIC' || !options.launchLightroom) {
    return { lightroomLaunchStatus: 'NOT_REQUESTED' };
  }

  const savedPath = readStorage(LIGHTROOM_PATH_STORAGE_KEY) || options.lightroomExecutablePath;
  try {
    const launchedPath = await invoke<string | null>('launch_lightroom_classic', {
      executablePath: savedPath || null,
    });
    if (launchedPath) {
      localStorage.setItem(LIGHTROOM_PATH_STORAGE_KEY, launchedPath);
      return {
        lightroomLaunchStatus: 'LAUNCHED',
        lightroomExecutablePath: launchedPath,
      };
    }
    return {
      lightroomLaunchStatus: 'NOT_FOUND',
      lightroomMessage: 'Lightroom Classic was not found. Open the selected photos folder from Lightroom.',
    };
  } catch (error) {
    return {
      lightroomLaunchStatus: 'ERROR',
      lightroomMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatBytesForLog(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const App: React.FC = () => {
  // Settings
  const { theme, themeMode, setThemeMode } = useTheme();
  const [language, setLanguage] = useState<Language>(() => {
    const saved = readStorage(LANGUAGE_STORAGE_KEY);
    return (saved === 'zh' || saved === 'en') ? saved : 'zh';
  });
  const [viewerAiMode, setViewerAiMode] = useState<ViewerAiMode>('AI');
  const [rawDecodeProgress, setRawDecodeProgress] = useState<RawDecodeProgress>({
    total: 0,
    processed: 0,
    queued: 0,
    active: 0,
    running: false,
  });
  const [isMaximized, setIsMaximized] = useState(false);
  const [initialImportActive, setInitialImportActive] = useState(false);
  const [initialImportSelectionId, setInitialImportSelectionId] = useState<string | null>(null);
  const [initialImportPreloadProgress, setInitialImportPreloadProgress] = useState<ImportProgress | null>(null);
  const initialPreloadStartedRef = useRef(false);
  const latestPhotosRef = useRef<PhotoGroup[]>([]);
  const [exportProgress, setExportProgress] = useState<ExportProgress>(IDLE_EXPORT_PROGRESS);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  // Custom hooks for state management
  const photoState = usePhotoState();
  const modalState = useModalState();
  const aiCulling = useAiCulling(photoState.photos, photoState.updatePhotoAiAnalysis);
  const duplicateBestPhotoIds = useMemo(
    () => new Set(aiCulling.duplicateGroups.map(group => group.bestPhotoId).filter((id): id is string => Boolean(id))),
    [aiCulling.duplicateGroups],
  );
  const aiPickedPhotoIds = useMemo(
    () => aiCulling.duplicateStatus === 'READY'
      ? buildEditionAiPickedPhotoIds(
        photoState.photos,
        duplicateBestPhotoIds,
        aiCulling.duplicatePhotoIds,
        aiCulling.settings.aiPickTargetRatio,
        aiCulling.duplicateGroups,
        aiCulling.settings,
      )
      : new Set<string>(),
    [
      photoState.photos,
      duplicateBestPhotoIds,
      aiCulling.duplicatePhotoIds,
      aiCulling.duplicateGroups,
      aiCulling.duplicateStatus,
      aiCulling.settings.aiPickTargetRatio,
      aiCulling.settings.proPersonaRanking,
    ],
  );
  const navigation = usePhotoNavigation(
    photoState.photos,
    aiCulling.duplicatePhotoIds,
    duplicateBestPhotoIds,
    aiCulling.duplicateStatus === 'READY',
    aiPickedPhotoIds,
  );
  const peopleSplit = usePeopleSplit(photoState.photos, {
    aiCullingRunning: aiCulling.progress.running && !aiCulling.progress.paused,
  });
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('CULLING');
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [appCacheUsage, setAppCacheUsage] = useState<AppCacheUsage | null>(null);
  const [appCacheUsageBusy, setAppCacheUsageBusy] = useState(false);
  const t = getTranslations(language);
  const runningInTauri = hasTauriRuntime();

  // Platform detection
  const { isMacOS } = usePlatform();

  useEffect(() => {
    latestPhotosRef.current = photoState.photos;
  }, [photoState.photos]);

  const dismissNotification = (id: string) => {
    setNotifications(prev => prev.filter(notification => notification.id !== id));
  };

  const notify = ({
    kind,
    title,
    message,
    detail,
    autoDismissMs,
  }: {
    kind: NotificationKind;
    title: string;
    message?: string;
    detail?: string;
    autoDismissMs?: number;
  }) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next: AppNotification = {
      id,
      kind,
      title,
      message,
      detail,
      createdAt: Date.now(),
      autoDismissMs,
    };
    setNotifications(prev => [...prev, next]);
  };

  const rawMonitorFeature = useRawMonitorFeature({
    photos: photoState.photos,
    filteredPhotos: navigation.filteredPhotos,
    selectedIndex: navigation.selectedIndex,
    language,
    notify,
  });
  const {
    rawEngineSettings,
    rawEngineBusy,
    rawMonitorProgress,
    rawMonitorCacheSizeBytes,
    rawMonitorCacheBusy,
    viewerPreview: rawMonitorPreview,
    onDetectRawEngine: handleDetectRawEngine,
    onChooseRawEngine: handleChooseRawEngine,
    onClearRawEngine: handleClearRawEngine,
    onRefreshRawMonitorCacheSize: handleRefreshRawMonitorCacheSize,
    onCleanupRawMonitorCache: handleCleanupRawMonitorCache,
    clearCache: clearRawMonitorCache,
  } = rawMonitorFeature;

  const refreshAppCacheUsage = useCallback(async () => {
    setAppCacheUsageBusy(true);
    try {
      setAppCacheUsage(await getAppCacheUsage());
    } catch (error) {
      console.warn('Failed to refresh app cache usage:', error);
    } finally {
      setAppCacheUsageBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!modalState.showSettings) return;
    void refreshAppCacheUsage();
  }, [modalState.showSettings, refreshAppCacheUsage]);


  useEffect(() => {
    const timers = notifications
      .filter(notification => typeof notification.autoDismissMs === 'number' && notification.autoDismissMs > 0)
      .map(notification => window.setTimeout(() => {
        dismissNotification(notification.id);
      }, notification.autoDismissMs));

    return () => {
      timers.forEach(timer => window.clearTimeout(timer));
    };
  }, [notifications]);


  const completeInitialImport = (selectedId: string | null, fallbackIndex = 0) => {
    setInitialImportActive(false);
    setInitialImportPreloadProgress(null);
    initialPreloadStartedRef.current = false;
    if (selectedId) {
      navigation.selectPhotoById(selectedId);
    } else if (photoState.photos.length > 0) {
      navigation.setSelectedIndex(fallbackIndex);
    } else {
      navigation.setSelectedIndex(null);
    }
  };

  const prepareInitialPreviewWindow = async (selectedId: string | null) => {
    const targetPhotos = photoState.photos;
    if (targetPhotos.length === 0) {
      completeInitialImport(selectedId);
      return;
    }

    let startIndex = 0;
    if (selectedId) {
      const foundIndex = targetPhotos.findIndex(photo => photo.id === selectedId);
      if (foundIndex >= 0) startIndex = foundIndex;
    }

    const previewCandidates = targetPhotos.slice(startIndex, startIndex + 2);
    const preloadTotal = Math.max(1, previewCandidates.length);

    setInitialImportPreloadProgress({
      phase: 'preload',
      total: preloadTotal,
      processed: 0,
      running: true,
      current: targetPhotos[startIndex]?.id,
    });

    preloadDisplayWindow(targetPhotos, startIndex, { ahead: 3, behind: 0 });
    preloadRawWindow(targetPhotos, startIndex, { ahead: 2, behind: 0, includeCurrent: false });

    const preloadTasks = previewCandidates.map(async (group, index) => {
      setInitialImportPreloadProgress(prev => prev ? {
        ...prev,
        processed: index,
        current: group.id,
      } : prev);

      const tasks: Promise<unknown>[] = [];
      if (group.raw?.path) {
        tasks.push(
          decodeRawFile(group.raw.path, false, {
            priority: index === 0 ? 'high' : 'low',
            silent: true,
            fallbackToWorker: index === 0,
          })
            .catch(() => null)
        );
      }
      const displayUrl = getDisplayPreviewUrl(group);
      if (displayUrl) {
        tasks.push(loadDisplayImage(displayUrl).catch(() => null));
      }
      await Promise.all(tasks);
    });

    await Promise.race([
      Promise.all(preloadTasks),
      new Promise(resolve => window.setTimeout(resolve, 1400)),
    ]);

    setInitialImportPreloadProgress(prev => prev ? {
      ...prev,
      phase: 'done',
      running: false,
      processed: prev.total,
    } : prev);
    window.setTimeout(() => completeInitialImport(selectedId, startIndex), 140);
  };

  const handleMinimize = () => {
    if (!hasTauriRuntime()) return;
    getCurrentWindow().minimize();
  };

  const handleMaximize = async () => {
    if (!hasTauriRuntime()) return;
    const appWindow = getCurrentWindow();
    const isMaximized = await appWindow.isMaximized();
    if (isMaximized) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
    setIsMaximized(await appWindow.isMaximized());
  };

  const handleClose = () => {
    if (!hasTauriRuntime()) return;
    getCurrentWindow().close();
  };

  // Persist language setting
  useEffect(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useEffect(() => subscribeRawDecodeProgress(setRawDecodeProgress), []);

  useEffect(() => {
    if (!runningInTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    const syncMaximizedState = async () => {
      try {
        const maximized = await appWindow.isMaximized();
        if (!disposed) setIsMaximized(maximized);
      } catch {
        if (!disposed) setIsMaximized(false);
      }
    };

    void syncMaximizedState();
    void appWindow.onResized(() => {
      void syncMaximizedState();
    }).then(cleanup => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runningInTauri]);

  useEffect(() => {
    if (initialImportActive) return;
    if (aiCulling.progress.running) {
      cancelRawPreloads();
    } else {
      preloadRawWindow(navigation.filteredPhotos, navigation.selectedIndex, {
        ahead: 2,
        behind: 0,
        includeCurrent: false,
      });
    }
    const displayWindow = aiCulling.progress.running
      ? { ahead: 2, behind: 0, includeCurrent: false }
      : { ahead: 5, behind: 1, includeCurrent: false };
    preloadDisplayWindow(navigation.filteredPhotos, navigation.selectedIndex, displayWindow);
  }, [aiCulling.progress.running, initialImportActive, navigation.filteredPhotos, navigation.selectedIndex]);

  // Auto-select first photo when photos are available
  useEffect(() => {
    if (initialImportActive) return;
    navigation.autoSelectFirst();
  }, [initialImportActive, photoState.photos.length]);

  useEffect(() => {
    if (!initialImportActive || initialPreloadStartedRef.current) return;
    if (photoState.photos.length === 0) return;
    if (!initialImportSelectionId && photoState.importProgress.phase !== 'done') return;

    const selectedId = initialImportSelectionId || photoState.photos[0]?.id || null;
    initialPreloadStartedRef.current = true;
    void prepareInitialPreviewWindow(selectedId).catch(error => {
      console.warn('Initial preview preparation failed:', error);
      completeInitialImport(selectedId);
    });
  }, [initialImportActive, initialImportSelectionId, photoState.photos, photoState.importProgress.phase]);

  // Show window after app is ready
  useEffect(() => {
    const splashStartedAt = performance.now();
    let disposed = false;
    let hideTimer: number | undefined;
    let showTimer: number | undefined;
    let imageTimer: number | undefined;

    const hideLoading = () => {
      if (disposed) return;
      const loadingEl = document.getElementById('app-loading');
      if (loadingEl) {
        loadingEl.classList.add('fade-out');
        setTimeout(() => {
          loadingEl.style.display = 'none';
        }, 380);
      }
    };

    const scheduleHideLoading = () => {
      const elapsed = performance.now() - splashStartedAt;
      hideTimer = window.setTimeout(hideLoading, Math.max(0, SPLASH_MIN_VISIBLE_MS - elapsed));
    };

    const waitForSplashPaint = (callback: () => void) => {
      const runAfterPaint = () => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            showTimer = window.setTimeout(callback, SPLASH_FIRST_PAINT_DELAY_MS);
          });
        });
      };

      const loadingMark = document.querySelector<HTMLImageElement>('#app-loading img');
      if (!loadingMark || loadingMark.complete) {
        runAfterPaint();
        return;
      }

      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        loadingMark.removeEventListener('load', complete);
        loadingMark.removeEventListener('error', complete);
        if (imageTimer !== undefined) window.clearTimeout(imageTimer);
        runAfterPaint();
      };

      loadingMark.addEventListener('load', complete, { once: true });
      loadingMark.addEventListener('error', complete, { once: true });
      imageTimer = window.setTimeout(complete, 420);
    };

    const showWindow = async () => {
      if (disposed) return;
      try {
        if (runningInTauri) {
          await invoke('show_main_window');
        }
      } catch (error) {
        console.error('Failed to show window:', error);
      } finally {
        scheduleHideLoading();
      }
    };

    waitForSplashPaint(() => { void showWindow(); });
    return () => {
      disposed = true;
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
      if (showTimer !== undefined) window.clearTimeout(showTimer);
      if (imageTimer !== undefined) window.clearTimeout(imageTimer);
    };
  }, [runningInTauri]);

  // Import handlers
  const handleImportFiles = async () => {
    try {
      const isInitialImport = photoState.photos.length === 0;
      if (isInitialImport) {
        setInitialImportActive(true);
        setInitialImportSelectionId(null);
        setInitialImportPreloadProgress(null);
        initialPreloadStartedRef.current = false;
      }
      const firstNewGroupId = await photoState.importFiles();
      if (isInitialImport) {
        if (firstNewGroupId) {
          setInitialImportSelectionId(firstNewGroupId);
        } else {
          window.setTimeout(() => {
            const fallbackId = latestPhotosRef.current[0]?.id || null;
            if (fallbackId) {
              setInitialImportSelectionId(fallbackId);
            } else {
              setInitialImportActive(false);
            }
          }, 80);
        }
      } else if (firstNewGroupId) {
        navigation.selectPhotoById(firstNewGroupId);
      } else if (navigation.selectedIndex === null && photoState.photos.length > 0) {
        navigation.autoSelectFirst();
      }
    } catch (error) {
      setInitialImportActive(false);
      setInitialImportSelectionId(null);
      setInitialImportPreloadProgress(null);
      initialPreloadStartedRef.current = false;
      console.error('Failed to import files:', error);
      notify({
        kind: 'error',
        title: t.messages.importFailed,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleImportFolder = async () => {
    try {
      const isInitialImport = photoState.photos.length === 0;
      if (isInitialImport) {
        setInitialImportActive(true);
        setInitialImportSelectionId(null);
        setInitialImportPreloadProgress(null);
        initialPreloadStartedRef.current = false;
      }
      const firstNewGroupId = await photoState.importFolder();
      if (isInitialImport) {
        if (firstNewGroupId) {
          setInitialImportSelectionId(firstNewGroupId);
        } else {
          window.setTimeout(() => {
            const fallbackId = latestPhotosRef.current[0]?.id || null;
            if (fallbackId) {
              setInitialImportSelectionId(fallbackId);
            } else {
              setInitialImportActive(false);
            }
          }, 80);
        }
      } else if (firstNewGroupId) {
        navigation.selectPhotoById(firstNewGroupId);
      } else if (navigation.selectedIndex === null && photoState.photos.length > 0) {
        navigation.autoSelectFirst();
      }
    } catch (error) {
      setInitialImportActive(false);
      setInitialImportSelectionId(null);
      setInitialImportPreloadProgress(null);
      initialPreloadStartedRef.current = false;
      console.error('Failed to import folder:', error);
      notify({
        kind: 'error',
        title: t.messages.importFailed,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Delete handlers
  const handleDeleteRejected = async () => {
    try {
      const rejectedIds = new Set(photoState.photos
        .filter(photo => photo.selection === SelectionState.REJECTED)
        .map(photo => photo.id));
      const nextSelectionId = getSelectionTargetAfterRemoval(
        navigation.filteredPhotos,
        navigation.currentPhoto?.id,
        rejectedIds,
      );
      const deletedCount = await photoState.deleteRejectedPhotos();
      modalState.setShowDeleteConfirm(false);
      if (nextSelectionId) {
        navigation.selectPhotoById(nextSelectionId);
      } else {
        navigation.setSelectedIndex(null);
      }
      console.log(`Successfully moved ${deletedCount} files to trash`);
    } catch (error) {
      console.error('Failed to move files to trash:', error);
      modalState.setShowDeleteConfirm(false);

      // Show force delete confirmation
      const rejectedGroups = photoState.photos.filter(p => p.selection === SelectionState.REJECTED);
      modalState.setGroupsToForceDelete(rejectedGroups);
      modalState.setShowForceDeleteConfirm(true);
      notify({
        kind: 'warning',
        title: language === 'zh' ? '移动到回收站失败' : 'Move to trash failed',
        message: language === 'zh' ? '\u5df2\u5207\u6362\u4e3a\u6c38\u4e45\u5220\u9664\u786e\u8ba4\u3002\u8bf7\u518d\u6b21\u786e\u8ba4\u6b64\u64cd\u4f5c\u3002' : 'Switched to permanent delete confirmation. Please confirm again.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleOrphanDeleteStart = (type: 'RAW' | 'JPG') => {
    const orphanGroups = photoState.photos.filter(p => {
      if (type === 'RAW') {
        return p.status === GroupStatus.RAW_ONLY;
      } else {
        return p.status === GroupStatus.JPG_ONLY;
      }
    });

    if (orphanGroups.length === 0) {
      notify({
        kind: 'info',
        title: type === 'RAW' ? t.messages.noOrphanRawFiles : t.messages.noOrphanJpgFiles,
        autoDismissMs: 4500,
      });
      return;
    }

    modalState.setOrphanDeleteType(type);
    modalState.setShowOrphanDeleteConfirm(true);
  };

  const handleOrphanDelete = async () => {
    if (!modalState.orphanDeleteType) {
      modalState.setShowOrphanDeleteConfirm(false);
      return;
    }

    try {
      const deletedCount = await photoState.deleteOrphanPhotos(modalState.orphanDeleteType);
      modalState.setShowOrphanDeleteConfirm(false);
      modalState.setOrphanDeleteType(null);

      if (photoState.photos.length > deletedCount) {
        navigation.setSelectedIndex(0);
      } else {
        navigation.setSelectedIndex(null);
      }

      notify({
        kind: 'success',
        title: t.messages.orphanDeleteSuccess,
        message: `${deletedCount} ${language === 'zh' ? '\u4e2a\u6587\u4ef6\u5df2\u79fb\u81f3\u56de\u6536\u7ad9' : 'files moved to trash'}`,
        autoDismissMs: 4500,
      });
      console.log(`Successfully moved ${deletedCount} orphan files to trash`);
    } catch (error) {
      console.error('Failed to move orphan files to trash:', error);
      modalState.setShowOrphanDeleteConfirm(false);

      // Show force delete confirmation
      if (modalState.orphanDeleteType) {
        const orphanGroups = photoState.photos.filter(p => {
          if (modalState.orphanDeleteType === 'RAW') {
            return p.status === GroupStatus.RAW_ONLY;
          } else {
            return p.status === GroupStatus.JPG_ONLY;
          }
        });
        modalState.setGroupsToForceDelete(orphanGroups);
        modalState.setShowForceDeleteConfirm(true);
        notify({
          kind: 'warning',
          title: language === 'zh' ? '移动到回收站失败' : 'Move to trash failed',
          message: language === 'zh' ? '\u5df2\u5207\u6362\u4e3a\u6c38\u4e45\u5220\u9664\u786e\u8ba4\u3002\u8bf7\u518d\u6b21\u786e\u8ba4\u6b64\u64cd\u4f5c\u3002' : 'Switched to permanent delete confirmation. Please confirm again.',
          detail: error instanceof Error ? error.message : String(error),
        });
      } else {
        modalState.setOrphanDeleteType(null);
      }
    }
  };

  const handleForceDelete = async () => {
    try {
      const removedIds = new Set(modalState.groupsToForceDelete.map(group => group.id));
      const nextSelectionId = getSelectionTargetAfterRemoval(
        navigation.filteredPhotos,
        navigation.currentPhoto?.id,
        removedIds,
      );
      const deletedCount = await photoState.forceDeletePhotos(modalState.groupsToForceDelete);
      modalState.setShowForceDeleteConfirm(false);
      modalState.setGroupsToForceDelete([]);
      modalState.setOrphanDeleteType(null);

      if (nextSelectionId) {
        navigation.selectPhotoById(nextSelectionId);
      } else {
        navigation.setSelectedIndex(null);
      }

      console.log(`Successfully deleted ${deletedCount} files permanently`);
    } catch (error) {
      console.error('Failed to force delete files:', error);
      notify({
        kind: 'error',
        title: t.messages.deleteFailed,
        detail: error instanceof Error ? error.message : String(error),
      });
      modalState.setShowForceDeleteConfirm(false);
      modalState.setGroupsToForceDelete([]);
      modalState.setOrphanDeleteType(null);
    }
  };

  // Export handlers
  const showExportError = (error: unknown, destinationFolder?: string) => {
    const message = error instanceof Error ? error.message : String(error);
    setExportProgress({
      phase: 'error',
      total: 0,
      processed: 0,
      running: false,
      destinationFolder,
      error: message,
    });
  };

  const applyExportStreamEvent = (payload: ExportStreamEvent, destinationFolder: string) => {
    setExportProgress(prev => {
      const nextPhase = payload.phase || prev.phase;
      const processed = payload.processed ?? prev.processed;
      const total = payload.total ?? prev.total;
      const current = payload.current ?? prev.current;
      const files = payload.files ?? prev.files;

      if (payload.kind === 'done') {
        return {
          phase: 'done',
          total: total || files?.length || processed,
          processed: processed || files?.length || total,
          current,
          destinationFolder,
          running: false,
          files,
        };
      }

      if (payload.kind === 'error') {
        return {
          phase: 'error',
          total,
          processed,
          current,
          destinationFolder,
          running: false,
          files,
          error: payload.error || 'Export failed',
        };
      }

      return {
        ...prev,
        phase: nextPhase === 'idle' || nextPhase === 'done' || nextPhase === 'error' ? 'copying' : nextPhase,
        total,
        processed,
        current,
        destinationFolder,
        running: true,
      };
    });
  };

  const handleExportStart = () => {
    if (navigation.currentSelectionTarget.length === 0) {
      showExportError(t.messages.noPhotosToExport);
      return;
    }
    modalState.setShowExportConfirm(true);
  };

  const handleExport = async (options?: ExportOptions) => {
    if (!options) {
      modalState.setShowExportConfirm(false);
      return;
    }

    try {
      const targetGroups = navigation.currentSelectionTarget;
      if (targetGroups.length === 0) {
        modalState.setShowExportConfirm(false);
        showExportError(t.messages.noPhotosToExport, options.destinationFolder);
        return;
      }

      const exportMode = options.mode;
      const exportIntent = options.intent;
      const movedGroupCount = targetGroups.length;
      const isLightroomDirectImport = exportIntent === 'LIGHTROOM_IMPORT' || options.exportTarget === 'LIGHTROOM_CLASSIC';
      const isRenderedExport = exportIntent === 'RENDER_COPY';
      const sourceExportMode = isSourceExportMode(exportMode) ? exportMode : 'BOTH';
      let finalExportedFiles: string[] = [];

      modalState.setShowExportConfirm(false);
      if (isLightroomDirectImport) {
        setExportProgress({
          phase: 'preparing',
          total: targetGroups.length,
          processed: 0,
          exportTarget: 'LIGHTROOM_CLASSIC',
          lightroomMode: 'SOURCE_FOLDER',
          running: true,
        });
        const savedPath = readStorage(LIGHTROOM_PATH_STORAGE_KEY) || options.lightroomExecutablePath;
        const result = await invoke<LightroomSourceFolderResult>('open_lightroom_source_folder', {
          groups: toRustGroups(targetGroups),
          executablePath: savedPath || null,
        });
        if (result.executablePath) {
          localStorage.setItem(LIGHTROOM_PATH_STORAGE_KEY, result.executablePath);
        }
        const lightroomMessage = (result.warnings || []).filter(Boolean).join('\n') || undefined;
        setExportProgress({
          phase: 'done',
          total: result.files.length,
          processed: result.files.length,
          exportTarget: 'LIGHTROOM_CLASSIC',
          lightroomMode: 'SOURCE_FOLDER',
          lightroomLaunchStatus: result.launched ? 'LAUNCHED' : 'NOT_FOUND',
          destinationFolder: result.sourceFolder,
          lightroomExecutablePath: result.executablePath,
          lightroomMessage,
          running: false,
          files: result.files,
        });
        if (!result.launched) {
          try {
            await revealItemInDir(result.files);
          } catch (revealError) {
            console.warn('Failed to reveal Lightroom import source files:', revealError);
          }
          notify({
            kind: 'warning',
            title: language === 'zh' ? '未检测到 Lightroom Classic' : 'Lightroom Classic was not detected',
            message: language === 'zh'
              ? '\u5df2\u5199\u5165\u661f\u7ea7\u5143\u6570\u636e\uff0c\u5e76\u6253\u5f00\u6240\u9009\u7167\u7247\u6240\u5728\u6587\u4ef6\u5939\u3002'
              : 'Ratings were written and the source folder was revealed.',
            autoDismissMs: 8000,
          });
        }
        console.log('Lightroom source folder opened');
        return;
      }
      setExportProgress({
        phase: 'preparing',
        total: isRenderedExport ? targetGroups.length : countSourceExportFiles(targetGroups, sourceExportMode),
        processed: 0,
        destinationFolder: options.destinationFolder,
        exportTarget: options.exportTarget,
        lightroomMode: options.lightroomMode,
        running: true,
      });

      if (isRenderedExport) {
        const format = exportMode === 'RENDER_TIFF'
          ? 'tiff'
          : exportMode === 'RENDER_PNG'
            ? 'png'
            : 'jpeg';
        const renderedFiles: Awaited<ReturnType<typeof renderGroupForExport>>[] = [];

        for (const [index, group] of targetGroups.entries()) {
          const current = group.jpg?.name || group.raw?.name || group.id;
          setExportProgress({
            phase: 'rendering',
            total: targetGroups.length,
            processed: index,
            current,
            destinationFolder: options.destinationFolder,
            running: true,
          });
          const renderedFile = await renderGroupForExport(group, format, {
            jpegQuality: options.jpegQuality ?? 100,
            fileNameBase: getRenderedExportFileNameBase(options, group, index, targetGroups.length),
            metadataMode: options.metadataMode ?? 'NONE',
            colorSpace: options.colorSpace ?? 'SRGB',
          });
          renderedFiles.push(renderedFile);
          setExportProgress({
            phase: 'rendering',
            total: targetGroups.length,
            processed: index + 1,
            current: renderedFile.fileName,
            destinationFolder: options.destinationFolder,
            running: true,
          });
        }

        const channel = new Channel<ExportStreamEvent>((payload) => {
          applyExportStreamEvent(payload, options.destinationFolder);
        });
        const exportedFiles = await invoke<string[]>('write_rendered_export_stream', {
          files: renderedFiles,
          destinationFolder: options.destinationFolder,
          onEvent: channel,
        });
        finalExportedFiles = exportedFiles;
        setExportProgress({
          phase: 'done',
          total: exportedFiles.length,
          processed: exportedFiles.length,
          destinationFolder: options.destinationFolder,
          exportTarget: options.exportTarget,
          lightroomMode: options.lightroomMode,
          running: false,
          files: exportedFiles,
        });
      } else {
        const phase = options.operation === 'MOVE' ? 'moving' : 'copying';
        setExportProgress(prev => ({ ...prev, phase, running: true }));
        const channel = new Channel<ExportStreamEvent>((payload) => {
          applyExportStreamEvent(payload, options.destinationFolder);
        });
        const exportedFiles = await photoState.exportPhotosStream(
          targetGroups,
          sourceExportMode,
          options.operation,
          options.destinationFolder,
          channel,
          options.includeRawSidecars ?? true
        );
        finalExportedFiles = exportedFiles;
        setExportProgress({
          phase: 'done',
          total: exportedFiles.length,
          processed: exportedFiles.length,
          destinationFolder: options.destinationFolder,
          exportTarget: options.exportTarget,
          lightroomMode: options.lightroomMode,
          running: false,
          files: exportedFiles,
        });
      }

      const lightroomResult = await launchLightroomAfterExport(options);
      setExportProgress(prev => ({
        ...prev,
        phase: 'done',
        total: prev.total || finalExportedFiles.length,
        processed: prev.processed || finalExportedFiles.length,
        destinationFolder: options.destinationFolder,
        exportTarget: options.exportTarget,
        lightroomMode: options.lightroomMode,
        running: false,
        files: prev.files || finalExportedFiles,
        ...lightroomResult,
      }));

      if (lightroomResult.lightroomLaunchStatus === 'NOT_FOUND' || lightroomResult.lightroomLaunchStatus === 'ERROR') {
        try {
          await revealItemInDir(options.destinationFolder);
        } catch (revealError) {
          console.warn('Failed to reveal Lightroom folder:', revealError);
        }
        notify({
          kind: 'warning',
          title: language === 'zh' ? 'Lightroom \u672a\u542f\u52a8' : 'Lightroom was not launched',
          message: language === 'zh'
            ? '\u5bfc\u51fa\u6587\u4ef6\u548c\u661f\u7ea7\u5df2\u51c6\u5907\u597d\uff0c\u8bf7\u5728 Lightroom Classic \u4e2d\u6253\u5f00\u76ee\u6807\u76ee\u5f55\u3002'
            : 'The exported files and ratings are ready. Open the destination folder from Lightroom Classic.',
          detail: lightroomResult.lightroomMessage,
          autoDismissMs: 8000,
        });
      }

      if (options.intent === 'MOVE_ORIGINALS' && options.operation === 'MOVE') {
        navigation.setSelectedIndex(photoState.photos.length > movedGroupCount ? 0 : null);
      }

      console.log('Export completed');
    } catch (error) {
      console.error('Failed to export files:', error);
      modalState.setShowExportConfirm(false);
      showExportError(error, options.destinationFolder);
    }
  };

  const handleCloseExportProgress = () => {
    if (exportProgress.running) return;
    setExportProgress(IDLE_EXPORT_PROGRESS);
  };

  const handleRevealExportResult = async () => {
    const revealTarget = exportProgress.exportTarget === 'LIGHTROOM_CLASSIC'
      ? (exportProgress.files?.length ? exportProgress.files : exportProgress.destinationFolder)
      : exportProgress.files?.length
      ? exportProgress.files
      : exportProgress.destinationFolder;
    if (!revealTarget) return;

    try {
      await revealItemInDir(revealTarget);
    } catch (error) {
      console.error('Failed to reveal export result:', error);
      notify({
        kind: 'error',
        title: language === 'zh' ? '无法显示导出结果' : 'Failed to show export result',
        message: language === 'zh' ? '\u5bfc\u51fa\u5df2\u5b8c\u6210\uff0c\u4f46\u65e0\u6cd5\u5728\u8d44\u6e90\u7ba1\u7406\u5668\u4e2d\u5b9a\u4f4d\u6587\u4ef6\u3002' : 'Export completed, but the result could not be revealed in the file manager.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handlePeopleExport = async () => {
    if (peopleSplit.selectedClusters.length === 0) {
      notify({
        kind: 'info',
        title: language === 'zh' ? '\u8bf7\u5148\u9009\u62e9\u4eba\u7269\u7ec4' : 'Select at least one person',
        autoDismissMs: 3200,
      });
      return;
    }

    try {
      const destinationFolder = await open({
        directory: true,
        multiple: false,
      });
      if (!destinationFolder || Array.isArray(destinationFolder)) return;

      setExportProgress({
        phase: 'copying',
        total: peopleSplit.selectedClusters.reduce((count, cluster) => count + cluster.photoCount, 0),
        processed: 0,
        destinationFolder,
        running: true,
      });

      const channel = new Channel<ExportStreamEvent>((payload) => {
        applyExportStreamEvent(payload, destinationFolder);
      });
      const exportedFiles = await peopleSplit.exportClusters(
        peopleSplit.selectedClusters,
        destinationFolder,
        channel,
      );
      setExportProgress({
        phase: 'done',
        total: exportedFiles.length,
        processed: exportedFiles.length,
        destinationFolder,
        running: false,
        files: exportedFiles,
      });
    } catch (error) {
      console.error('Failed to export people clusters:', error);
      showExportError(error);
    }
  };

  const handleUpdateRating = (rating: PhotoRating) => {
    navigation.updateRatingForSelection(rating, (photoIds, nextRating) => {
      void photoState.updatePhotoRating(photoIds, nextRating).catch(error => {
        console.error('Failed to write rating metadata:', error);
        notify({
          kind: 'error',
          title: language === 'zh' ? '\u5199\u5165\u661f\u7ea7\u5143\u6570\u636e\u5931\u8d25' : 'Failed to write rating metadata',
          message: language === 'zh' ? '\u754c\u9762\u8bc4\u5206\u5df2\u56de\u9000\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002' : 'The visible rating has been rolled back. Please try again.',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    });
  };

  const handleClearCaches = async () => {
    const result = await clearAppCaches();
    await clearRawMonitorCache();
    photoState.clearCurrentSessionMarks();
    void refreshAppCacheUsage();
    if (handleRefreshRawMonitorCacheSize) {
      void handleRefreshRawMonitorCacheSize();
    }
    notify({
      kind: 'success',
      title: language === 'zh' ? '\u7f13\u5b58\u5df2\u6e05\u9664' : 'Caches cleared',
      message: language === 'zh'
        ? '\u5df2\u6e05\u9664 AI \u5206\u6790\u3001\u7b5b\u7247\u72b6\u6001\u548c\u9884\u89c8\u7f13\u5b58\u3002\u8bed\u8a00\u3001\u4e3b\u9898\u3001AI \u8bbe\u7f6e\u548c Lightroom \u8def\u5f84\u5df2\u4fdd\u7559\u3002'
        : 'AI analysis, culling state, and preview caches were cleared. Language, theme, AI settings, and Lightroom path were kept.',
      detail: `persistent=${result.clearedPersistent}; disk=${formatBytesForLog(result.clearedDiskBytes)}; memory=${result.clearedMemory}`,
      autoDismissMs: 2600,
    });
  };

  const toggleViewerAiMode = () => {
    setViewerAiMode(mode => mode === 'AI' ? 'ORIGINAL' : 'AI');
  };

  // Keyboard shortcuts
  useKeyboardShortcuts({
    enabled: workspaceMode === 'CULLING' && navigation.selectedIndex !== null,
    onNavigate: navigation.navigate,
    onUpdateSelection: (state: SelectionState) => {
      const updater = navigation.filter === 'AI_REVIEW'
        ? photoState.reviewAiPhoto
        : photoState.updatePhotoSelection;
      navigation.updateSelectionWithAnimation(state, updater);
    },
    onUpdateRating: handleUpdateRating,
    onToggleAiOverlay: toggleViewerAiMode,
    onSelectAll: navigation.selectAllFilteredPhotos,
    onClearSelection: navigation.clearMultiSelection,
  });

  const toolbarRawDecodeProgress = aiCulling.progress.running
    ? { total: 0, processed: 0, queued: 0, active: 0, running: false }
    : rawDecodeProgress;
  const showInitialImportSurface = photoState.photos.length === 0 || initialImportActive;
  const initialImportProgress = initialImportPreloadProgress || photoState.importProgress;
  const filmstripStats = {
    ...photoState.stats,
    duplicates: aiCulling.duplicatePhotoIds.size,
    aiPicked: aiPickedPhotoIds.size,
  };

  return (
    <div className={`h-screen select-none overflow-hidden ${
      theme === 'dark' ? 'bg-[#151517] text-zinc-100' : 'bg-slate-100 text-slate-950'
    }`}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {/* Top Nav */}
        <Toolbar
          theme={theme}
          language={language}
          t={t}
          isLoading={photoState.isLoading}
          importProgress={photoState.importProgress}
          rawDecodeProgress={toolbarRawDecodeProgress}
          aiProgress={aiCulling.progress}
          aiStats={{
            total: photoState.stats.total,
          }}
          onImportFiles={handleImportFiles}
          onImportFolder={handleImportFolder}
          onAiStart={() => { void aiCulling.start(); }}
          onAiPause={aiCulling.pause}
          onAiResume={aiCulling.resume}
          onAiSettingsClick={() => setShowAiSettings(true)}
          stats={filmstripStats}
          selectionCount={navigation.currentSelectionTarget.length}
          peopleActive={workspaceMode === 'PEOPLE_SPLIT'}
          peopleCount={peopleSplit.state.clusters.length}
          onPeopleClick={() => setWorkspaceMode(mode => mode === 'PEOPLE_SPLIT' ? 'CULLING' : 'PEOPLE_SPLIT')}
          onDeleteRejected={() => modalState.setShowDeleteConfirm(true)}
          onExportClick={handleExportStart}
          onSettingsClick={() => modalState.setShowSettings(!modalState.showSettings)}
          isMacOS={isMacOS}
          isMaximized={isMaximized}
          onMinimize={handleMinimize}
          onMaximize={handleMaximize}
          onClose={handleClose}
        />

        {/* Main Workspace */}
        <main className={`min-h-0 flex-1 overflow-hidden ${
          theme === 'dark'
            ? 'bg-[linear-gradient(135deg,#18181b_0%,#121214_52%,#1a1a1d_100%)]'
            : 'bg-slate-100/80'
        }`}>
        {workspaceMode === 'PEOPLE_SPLIT' ? (
          <PeopleSplitWorkspace
            theme={theme}
            language={language}
            photos={photoState.photos}
            state={peopleSplit.state}
            selectedClusters={peopleSplit.selectedClusters}
            onStart={() => { void peopleSplit.start(); }}
            onStop={peopleSplit.stop}
            onRenameCluster={peopleSplit.renameCluster}
            onMergeClusters={peopleSplit.mergeClusters}
            onMoveFace={peopleSplit.moveFace}
            onCreatePersonFromFace={peopleSplit.createPersonFromFace}
            onToggleClusterSelection={peopleSplit.toggleClusterSelection}
            onSetSelectedClusterIds={peopleSplit.setSelectedClusterIds}
            onExportSelected={() => { void handlePeopleExport(); }}
            aiViewMode={viewerAiMode}
            onAiViewModeChange={setViewerAiMode}
            onFocusPhoto={navigation.selectPhotoById}
            onUpdatePhotoSelection={photoState.updatePhotoSelection}
            onUpdatePhotoRating={(photoId, rating) => photoState.updatePhotoRating([photoId], rating)}
          />
        ) : showInitialImportSurface ? (
          <EmptyState
            theme={theme}
            t={t}
            language={language}
            filter={navigation.filter}
            hasPhotos={false}
            onImportFiles={handleImportFiles}
            onImportFolder={handleImportFolder}
            importProgress={initialImportProgress}
            initialImportActive={initialImportActive}
          />
        ) : (
          <div className="flex h-full min-h-0 overflow-hidden">
            <Filmstrip
              theme={theme}
              filteredPhotos={navigation.filteredPhotos}
              selectedIndex={navigation.selectedIndex}
              selectedPhotoIds={navigation.selectedPhotoIds}
              filter={navigation.filter}
              ratingFilter={navigation.ratingFilter}
              stats={filmstripStats}
              onSelectPhoto={navigation.selectPhotoByIndex}
              onFilterChange={navigation.setFilter}
              onRatingFilterChange={navigation.setRatingFilter}
              duplicateBestPhotoIds={navigation.filter === 'DUPLICATES' ? duplicateBestPhotoIds : undefined}
              aiPickedPhotoIds={navigation.filter === 'ALL' ? aiPickedPhotoIds : undefined}
              showAiPickedBadge={navigation.filter === 'ALL'}
              language={language}
            />

            <section className="min-w-0 flex-1 overflow-hidden">
            {navigation.filter === 'DUPLICATES' ? (
              <DuplicateReviewWorkspace
                theme={theme}
                language={language}
                photos={photoState.photos}
                groups={aiCulling.duplicateGroups}
                status={aiCulling.duplicateStatus}
                selectedPhotoId={navigation.currentPhoto?.id}
                aiRunning={aiCulling.progress.running}
                aiViewMode={viewerAiMode}
                onAiViewModeChange={setViewerAiMode}
                onSelectPhoto={navigation.selectPhotoById}
                onNavigatePhoto={navigation.navigate}
                onUpdateSelection={(photoId, state) => {
                  if (navigation.currentPhoto?.id === photoId) {
                    navigation.updateSelectionWithAnimation(state, photoState.updatePhotoSelection);
                    return;
                  }
                  photoState.updatePhotoSelection(photoId, state);
                }}
                onUpdateRating={(photoIds, rating) => {
                  if (photoIds.length === 1 && navigation.currentPhoto?.id === photoIds[0]) {
                    handleUpdateRating(rating);
                    return;
                  }
                  photoState.updatePhotoRating(photoIds, rating);
                }}
                onAiStart={() => { void aiCulling.start(); }}
              />
            ) : navigation.filteredPhotos.length === 0 ? (
              <EmptyState
                theme={theme}
                t={t}
                language={language}
                filter={navigation.filter}
                hasPhotos={true}
                onImportFiles={handleImportFiles}
                onImportFolder={handleImportFolder}
              />
            ) : navigation.currentPhoto && (
              <Viewer
                group={navigation.currentPhoto}
                onUpdateSelection={(state: SelectionState) => {
                  navigation.updateSelectionWithAnimation(state, photoState.updatePhotoSelection);
                }}
                onAiReview={(state: SelectionState) => {
                  navigation.updateSelectionWithAnimation(state, photoState.reviewAiPhoto);
                }}
                theme={theme}
                language={language}
                onUpdateRating={handleUpdateRating}
                aiViewMode={viewerAiMode}
                onAiViewModeChange={setViewerAiMode}
                isAiReviewMode={navigation.filter === 'AI_REVIEW'}
                rawMonitorPreview={rawMonitorPreview}
              />
            )}
            </section>
          </div>
        )}
        </main>
      </div>

      <NotificationCenter
        theme={theme}
        notifications={notifications}
        onDismiss={dismissNotification}
      />

      {/* Modals */}
      {modalState.showDeleteConfirm && (
        <ConfirmationModal
          type="delete"
          groups={photoState.photos.filter(p => p.selection === SelectionState.REJECTED)}
          onConfirm={handleDeleteRejected}
          onCancel={() => modalState.setShowDeleteConfirm(false)}
          theme={theme}
          language={language}
        />
      )}

      {modalState.showExportConfirm && (
        <ConfirmationModal
          type="export"
          groups={navigation.currentSelectionTarget}
          onConfirm={handleExport}
          onCancel={() => modalState.setShowExportConfirm(false)}
          theme={theme}
          language={language}
        />
      )}

      {modalState.showOrphanDeleteConfirm && modalState.orphanDeleteType && (
        <ConfirmationModal
          type="delete"
          groups={photoState.photos.filter(p => {
            if (modalState.orphanDeleteType === 'RAW') {
              return p.status === GroupStatus.RAW_ONLY;
            } else {
              return p.status === GroupStatus.JPG_ONLY;
            }
          })}
          orphanDeleteKind={modalState.orphanDeleteType}
          onConfirm={handleOrphanDelete}
          onCancel={() => {
            modalState.setShowOrphanDeleteConfirm(false);
            modalState.setOrphanDeleteType(null);
          }}
          theme={theme}
          language={language}
        />
      )}

      {modalState.showForceDeleteConfirm && (
        <ConfirmationModal
          type="forceDelete"
          groups={modalState.groupsToForceDelete}
          onConfirm={handleForceDelete}
          onCancel={() => {
            modalState.setShowForceDeleteConfirm(false);
            modalState.setGroupsToForceDelete([]);
            modalState.setOrphanDeleteType(null);
          }}
          theme={theme}
          language={language}
        />
      )}

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={modalState.showSettings}
        onClose={() => modalState.setShowSettings(false)}
        theme={theme}
        themeMode={themeMode}
        language={language}
        onThemeModeChange={setThemeMode}
        onLanguageChange={setLanguage}
        orphanStats={{
          raw: photoState.stats.orphanRaw,
          jpg: photoState.stats.orphanJpg,
        }}
        onDeleteOrphanRaw={() => handleOrphanDeleteStart('RAW')}
        onDeleteOrphanJpg={() => handleOrphanDeleteStart('JPG')}
        onClearCaches={handleClearCaches}
        appCacheUsage={appCacheUsage}
        appCacheUsageBusy={appCacheUsageBusy}
        onRefreshAppCacheUsage={() => { void refreshAppCacheUsage(); }}
        rawEngineSettings={rawEngineSettings}
        rawEngineBusy={rawEngineBusy}
        rawMonitorProgress={rawMonitorProgress}
        rawMonitorCacheSizeBytes={rawMonitorCacheSizeBytes}
        rawMonitorCacheBusy={rawMonitorCacheBusy}
        onDetectRawEngine={handleDetectRawEngine ? () => { void handleDetectRawEngine(); } : undefined}
        onChooseRawEngine={handleChooseRawEngine ? () => { void handleChooseRawEngine(); } : undefined}
        onClearRawEngine={handleClearRawEngine ? () => { void handleClearRawEngine(); } : undefined}
        onRefreshRawMonitorCacheSize={handleRefreshRawMonitorCacheSize ? () => { void handleRefreshRawMonitorCacheSize(); } : undefined}
        onCleanupRawMonitorCache={handleCleanupRawMonitorCache ? () => { void handleCleanupRawMonitorCache(); } : undefined}
        onClearRawMonitorCache={() => { void clearRawMonitorCache(); }}
      />

      <AiSettingsPanel
        isOpen={showAiSettings}
        onClose={() => setShowAiSettings(false)}
        theme={theme}
        language={language}
        settings={aiCulling.settings}
        onSettingsChange={aiCulling.setSettings}
      />

      {exportProgress.phase !== 'idle' && (
        <ExportProgressOverlay
          theme={theme}
          language={language}
          progress={exportProgress}
          onClose={handleCloseExportProgress}
          onRevealResult={handleRevealExportResult}
        />
      )}
    </div>
  );
};

export default App;

function countSourceExportFiles(groups: PhotoGroup[], mode: Exclude<ExportOptions['mode'], 'RENDER_JPG' | 'RENDER_TIFF' | 'RENDER_PNG'>) {
  return groups.reduce((count, group) => {
    if (mode === 'JPG') return count + (group.jpg ? 1 : 0);
    if (mode === 'RAW') return count + (group.raw ? 1 : 0);
    return count + (group.jpg ? 1 : 0) + (group.raw ? 1 : 0);
  }, 0);
}

function getRenderedExportFileNameBase(options: ExportOptions, group: PhotoGroup, index: number, total: number) {
  const baseName = options.renameBaseName?.trim();
  if (!options.renameEnabled || !baseName) return group.id;
  if (total <= 1) return baseName;
  return `${baseName}-${String(index + 1).padStart(3, '0')}`;
}

function isSourceExportMode(mode: ExportOptions['mode']): mode is Exclude<ExportOptions['mode'], 'RENDER_JPG' | 'RENDER_TIFF' | 'RENDER_PNG'> {
  return mode === 'JPG' || mode === 'RAW' || mode === 'BOTH';
}
