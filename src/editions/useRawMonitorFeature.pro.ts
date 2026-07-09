import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Language } from '../i18n';
import type {
  PhotoGroup,
  RawEngineSettings,
  RawMonitorCacheEvent,
  RawMonitorCacheProgress,
  RawMonitorProfileId,
  RawMonitorSettings,
} from '../types';
import * as engine from '../utils/rawMonitorEngine';
import { parseCubeLut } from '../utils/cubeLut';
import type { RawMonitorNotify } from './useRawMonitorFeature.flash';
import {
  cleanupRawMonitorCacheLRU,
  getRawMonitorCacheSize,
} from './rawCacheManager.pro';

const IDLE_RAW_MONITOR_PROGRESS: RawMonitorCacheProgress = {
  phase: 'idle',
  total: 0,
  processed: 0,
  running: false,
};

type RawMonitorGenerationRequest = {
  monitorSettings: RawMonitorSettings;
};

type ImportedMonitorLut = {
  path: string;
  name: string;
  content: string;
};

export function useRawMonitorFeature({
  photos,
  filteredPhotos,
  selectedIndex,
  language,
  notify,
}: {
  photos: PhotoGroup[];
  filteredPhotos?: PhotoGroup[];
  selectedIndex?: number | null;
  language: Language;
  notify: RawMonitorNotify;
}) {
  const [rawEngineSettings, setRawEngineSettings] = useState<RawEngineSettings | null>(null);
  const [rawMonitorSettings, setRawMonitorSettings] = useState<RawMonitorSettings>(() => engine.readRawMonitorSettings());
  const [rawEngineBusy, setRawEngineBusy] = useState(false);
  const [rawMonitorProgress, setRawMonitorProgress] = useState<RawMonitorCacheProgress>(IDLE_RAW_MONITOR_PROGRESS);
  const [rawMonitorCacheSizeBytes, setRawMonitorCacheSizeBytes] = useState<number | null>(null);
  const [rawMonitorCacheBusy, setRawMonitorCacheBusy] = useState(false);
  const rawMonitorGenerationRunningRef = useRef(false);
  const rawMonitorActiveProfileRef = useRef<string | null>(null);
  const rawMonitorPendingGenerationRef = useRef<RawMonitorGenerationRequest | null>(null);
  const rawMonitorPriorityPathsRef = useRef<Set<string>>(new Set());
  const rawMonitorCancelRequestedRef = useRef(false);

  const refreshRawMonitorCacheSize = useCallback(async () => {
    const size = await getRawMonitorCacheSize();
    setRawMonitorCacheSizeBytes(size);
    return size;
  }, []);

  useEffect(() => {
    void refreshRawMonitorCacheSize();
  }, [refreshRawMonitorCacheSize]);

  const persistRawEngineSettings = async (
    settings: RawEngineSettings,
    baseMonitorSettings?: RawMonitorSettings,
  ) => {
    const monitorSeed = baseMonitorSettings ?? rawMonitorSettings;
    setRawEngineSettings(settings);
    engine.saveRawEngineSettings(settings);
    const nextMonitorSettings = engine.syncRawMonitorSettingsWithEngine(monitorSeed, settings);
    setRawMonitorSettings(nextMonitorSettings);
    engine.saveRawMonitorSettings(nextMonitorSettings);
  };

  useEffect(() => {
    const nextEngine = engine.readRawEngineSettings();
    const nextMonitor = engine.syncRawMonitorSettingsWithEngine(engine.readRawMonitorSettings(), nextEngine);
    setRawEngineSettings(nextEngine);
    setRawMonitorSettings(nextMonitor);
    engine.saveRawMonitorSettings(nextMonitor);

    if (nextEngine.engineSource === 'MANUAL') return;

    let cancelled = false;
    void engine.detectRawTherapeeCli()
      .then(result => {
        if (cancelled || !result.ok) return;

        const shouldAdopt =
          !nextEngine.enginePath
          || nextEngine.engineSource !== result.engineSource
          || nextEngine.version !== result.version
          || nextEngine.enginePath !== (result.enginePath || '')
          || nextEngine.bundledEngineVersion !== result.bundledEngineVersion;

        if (!shouldAdopt) return;

        const detectedSettings: RawEngineSettings = {
          engineKind: 'RAWTHERAPEE',
          enginePath: result.enginePath || '',
          status: 'detected',
          engineSource: result.engineSource,
          lastDetectedAt: Date.now(),
          version: result.version,
          bundledEngineVersion: result.bundledEngineVersion,
          message: result.message,
        };
        void persistRawEngineSettings(detectedSettings, nextMonitor);
      })
      .catch(error => {
        console.warn('Failed to auto-detect RawTherapee CLI:', error);
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistRawMonitorSettings = (settings: RawMonitorSettings) => {
    setRawMonitorSettings(settings);
    engine.saveRawMonitorSettings(settings);
  };

  const rawMonitorScope = useMemo(() => {
    const scopePhotos = filteredPhotos?.length ? filteredPhotos : photos;
    const { rawPaths } = engine.buildRawMonitorGenerationQueue(
      scopePhotos,
      selectedIndex ?? 0,
      { nearby: 4 },
    );
    return {
      rawPaths,
      total: rawPaths.length,
      signature: engine.buildRawMonitorScopeSignature(rawPaths),
    };
  }, [filteredPhotos, photos, selectedIndex]);

  const rawCacheReady = engine.isRawMonitorProfileReady(
    rawMonitorSettings,
    engine.RAW_MONITOR_BALANCED_PROFILE_ID,
    rawMonitorScope.signature,
    rawMonitorScope.total,
  );
  const autoExposureCacheReady = engine.isRawMonitorProfileReady(
    rawMonitorSettings,
    engine.RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID,
    rawMonitorScope.signature,
    rawMonitorScope.total,
  );

  const onRawMonitorEnabledChange = (enabled: boolean) => {
    if (enabled && !rawCacheReady) {
      notify({
        kind: 'info',
        title: language === 'zh' ? '请先生成 RAW 监看缓存' : 'Generate RAW preview cache first',
        message: language === 'zh'
          ? '开关只负责启用已有缓存，不会自动开始生成。'
          : 'The switch only enables an existing cache and will not start rendering.',
        autoDismissMs: 2600,
      });
      return;
    }
    const nextSettings = engine.applyRawMonitorEnabledChange(rawMonitorSettings, enabled);
    persistRawMonitorSettings(nextSettings);
  };

  const onRawMonitorAutoExposureChange = (autoExposureEnabled: boolean) => {
    if (autoExposureEnabled && !autoExposureCacheReady) {
      notify({
        kind: 'info',
        title: language === 'zh' ? '请先生成自动曝光缓存' : 'Generate auto exposure cache first',
        message: language === 'zh'
          ? '自动曝光开关只应用已有缓存，不会自动开始生成。'
          : 'The auto exposure switch only applies an existing cache and will not start rendering.',
        autoDismissMs: 2600,
      });
      return;
    }
    let nextSettings = engine.applyRawMonitorAutoExposureChange(rawMonitorSettings, autoExposureEnabled);
    if (autoExposureEnabled && !nextSettings.enabled) {
      nextSettings = engine.applyRawMonitorEnabledChange(nextSettings, true);
    }
    persistRawMonitorSettings(nextSettings);
  };

  const onRawMonitorLutEnabledChange = (lutEnabled: boolean) => {
    persistRawMonitorSettings({
      ...rawMonitorSettings,
      lutEnabled,
    });
  };

  const onRawMonitorLutStrengthChange = (lutStrength: number) => {
    persistRawMonitorSettings({
      ...rawMonitorSettings,
      lutStrength: Math.max(0, Math.min(1, lutStrength)),
    });
  };

  const onChooseMonitorLut = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: 'Cube LUT', extensions: ['cube'] }],
      title: 'Choose .cube LUT',
    });
    if (typeof selected !== 'string') return;

    try {
      const imported = await invoke<ImportedMonitorLut>('import_monitor_lut', { sourcePath: selected });
      const lut = parseCubeLut(imported.content, imported.name);
      persistRawMonitorSettings({
        ...rawMonitorSettings,
        lutEnabled: true,
        lutPath: imported.path,
        lutName: lut.title || imported.name,
        lutStrength: rawMonitorSettings.lutStrength || 1,
      });
      notify({
        kind: 'success',
        title: language === 'zh' ? 'LUT 已导入' : 'LUT imported',
        message: lut.title || imported.name,
        autoDismissMs: 2400,
      });
    } catch (error) {
      notify({
        kind: 'error',
        title: language === 'zh' ? 'LUT 导入失败' : 'Failed to import LUT',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onRemoveMonitorLut = () => {
    persistRawMonitorSettings({
      ...rawMonitorSettings,
      lutEnabled: false,
      lutPath: undefined,
      lutName: undefined,
      lutStrength: 1,
    });
  };

  const onDetectRawEngine = async (baseMonitorSettings?: RawMonitorSettings) => {
    if (rawEngineBusy) return;
    setRawEngineBusy(true);
    try {
      const result = await engine.detectRawTherapeeCli();
      const nextSettings: RawEngineSettings = {
        engineKind: 'RAWTHERAPEE',
        enginePath: result.enginePath || '',
        status: result.ok ? 'detected' : 'missing',
        engineSource: result.engineSource,
        lastDetectedAt: Date.now(),
        version: result.version,
        bundledEngineVersion: result.bundledEngineVersion,
        message: result.message,
      };
      await persistRawEngineSettings(nextSettings, baseMonitorSettings);
      notify({
        kind: result.ok ? 'success' : 'warning',
        title: result.ok ? 'RawTherapee CLI ready' : 'RawTherapee CLI not found',
        message: result.message,
        autoDismissMs: 2600,
      });
    } catch (error) {
      notify({
        kind: 'error',
        title: 'RawTherapee detection failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRawEngineBusy(false);
    }
  };

  const onChooseRawEngine = async () => {
    if (rawEngineBusy) return;
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: 'RawTherapee CLI', extensions: ['exe'] }],
      title: 'Choose rawtherapee-cli.exe',
    });
    if (typeof selected !== 'string') return;

    setRawEngineBusy(true);
    try {
      const result = await engine.validateRawEngine(selected);
      const nextSettings: RawEngineSettings = {
        engineKind: 'RAWTHERAPEE',
        enginePath: selected,
        status: result.ok ? 'manual' : 'invalid',
        engineSource: 'MANUAL',
        lastDetectedAt: Date.now(),
        version: result.version,
        bundledEngineVersion: result.bundledEngineVersion,
        message: result.message,
      };
      await persistRawEngineSettings(nextSettings);
      notify({
        kind: result.ok ? 'success' : 'error',
        title: result.ok ? 'RawTherapee CLI saved' : 'Invalid RawTherapee CLI',
        message: result.message,
        autoDismissMs: result.ok ? 2600 : undefined,
      });
    } catch (error) {
      notify({
        kind: 'error',
        title: 'RawTherapee validation failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRawEngineBusy(false);
    }
  };

  const onClearRawEngine = async () => {
    const nextSettings = { ...engine.DEFAULT_RAW_ENGINE_SETTINGS };
    await persistRawEngineSettings(nextSettings);
    persistRawMonitorSettings({
      ...engine.DEFAULT_RAW_MONITOR_SETTINGS,
      enabled: false,
    });
    void onDetectRawEngine({ ...engine.DEFAULT_RAW_MONITOR_SETTINGS, enabled: false });
  };

  const isReadyEngine = (settings?: RawEngineSettings | null): settings is RawEngineSettings => (
    Boolean(settings?.enginePath && ['detected', 'manual', 'valid'].includes(settings.status))
  );

  const detectReadyEngine = async (baseMonitorSettings: RawMonitorSettings) => {
    if (isReadyEngine(rawEngineSettings)) return rawEngineSettings;
    const result = await engine.detectRawTherapeeCli();
    const nextSettings: RawEngineSettings = {
      engineKind: 'RAWTHERAPEE',
      enginePath: result.enginePath || '',
      status: result.ok ? 'detected' : 'missing',
      engineSource: result.engineSource,
      lastDetectedAt: Date.now(),
      version: result.version,
      bundledEngineVersion: result.bundledEngineVersion,
      message: result.message,
    };
    await persistRawEngineSettings(nextSettings, baseMonitorSettings);
    return isReadyEngine(nextSettings) ? nextSettings : null;
  };

  const generateRawMonitorCacheForSettings = async (monitorSettings: RawMonitorSettings) => {
    const requestedProfileId = engine.getRawMonitorProfileId(monitorSettings);
    if (rawMonitorProgress.running || rawMonitorGenerationRunningRef.current) {
      if (rawMonitorActiveProfileRef.current !== requestedProfileId) {
        rawMonitorPendingGenerationRef.current = { monitorSettings };
        void engine.cancelRawMonitorCacheRender().catch(error => {
          console.warn('Failed to cancel stale RAW monitor cache task:', error);
        });
        notify({
          kind: 'info',
          title: language === 'zh' ? '已切换 RAW 监看缓存' : 'RAW monitor cache switched',
          message: language === 'zh'
            ? '当前任务结束后会继续生成 RAW 监看缓存。'
            : 'RAW monitor cache will continue after the current task stops.',
          autoDismissMs: 2600,
        });
      }
      return;
    }
    rawMonitorGenerationRunningRef.current = true;
    rawMonitorActiveProfileRef.current = requestedProfileId;

    const finishWithoutRender = () => {
      rawMonitorGenerationRunningRef.current = false;
      rawMonitorActiveProfileRef.current = null;
    };

    const { rawPaths, priorityRawPaths } = engine.buildRawMonitorGenerationQueue(
      filteredPhotos?.length ? filteredPhotos : photos,
      selectedIndex ?? 0,
      { nearby: 4 },
    );
    const scopeSignature = engine.buildRawMonitorScopeSignature(rawPaths);
    rawMonitorPriorityPathsRef.current = new Set(priorityRawPaths);

    if (rawPaths.length === 0) {
      notify({
        kind: 'warning',
        title: 'No RAW files',
        message: 'Import RAW or RAW+JPG photos before generating monitor cache.',
        autoDismissMs: 2600,
      });
      finishWithoutRender();
      return;
    }

    let activeEngine = rawEngineSettings;
    if (!isReadyEngine(activeEngine)) {
      try {
        activeEngine = await detectReadyEngine(monitorSettings);
      } catch (error) {
        notify({
          kind: 'error',
          title: 'RawTherapee detection failed',
          detail: error instanceof Error ? error.message : String(error),
        });
        finishWithoutRender();
        return;
      }
    }

    if (!isReadyEngine(activeEngine)) {
      notify({
        kind: 'warning',
        title: 'RawTherapee CLI is not configured',
        message: 'Detect the bundled engine or choose rawtherapee-cli.exe first.',
        autoDismissMs: 3200,
      });
      finishWithoutRender();
      return;
    }

    let activeMonitorSettings = monitorSettings;
    if (activeEngine.version && monitorSettings.engineVersion !== activeEngine.version) {
      activeMonitorSettings = engine.syncRawMonitorSettingsWithEngine(monitorSettings, activeEngine);
      setRawMonitorSettings(prev => {
        const next = engine.syncRawMonitorSettingsWithEngine(prev, activeEngine);
        engine.saveRawMonitorSettings(next);
        return next;
      });
    }

    const profileId = engine.getRawMonitorProfileId(activeMonitorSettings);
    let skippedDuringRender = false;
    const pendingBeforeRender = rawMonitorPendingGenerationRef.current;
    if (pendingBeforeRender && engine.getRawMonitorProfileId(pendingBeforeRender.monitorSettings) !== profileId) {
      rawMonitorPendingGenerationRef.current = null;
      finishWithoutRender();
      void generateRawMonitorCacheForSettings(pendingBeforeRender.monitorSettings);
      return;
    }

    setRawMonitorProgress({
      phase: 'checking',
      total: rawPaths.length,
      processed: 0,
      profileId,
      running: true,
    });
    rawMonitorActiveProfileRef.current = profileId;

    try {
      void cleanupRawMonitorCacheLRU()
        .then(freed => {
          if (freed > 0) void refreshRawMonitorCacheSize();
        })
        .catch(error => {
          console.warn('Failed to cleanup RAW monitor cache before render:', error);
        });

      await engine.renderRawMonitorCacheStream({
        enginePath: activeEngine.enginePath,
        rawPaths,
        profileId,
        priorityCount: priorityRawPaths.length,
        onEvent: (event: RawMonitorCacheEvent) => {
          if (event.engineVersion && event.engineVersion !== activeEngine.version) {
            const nextSettings: RawEngineSettings = {
              ...activeEngine,
              status: activeEngine.status === 'manual' ? 'manual' : 'valid',
              version: event.engineVersion,
              lastDetectedAt: Date.now(),
            };
            setRawEngineSettings(nextSettings);
            engine.saveRawEngineSettings(nextSettings);
            activeMonitorSettings = engine.syncRawMonitorSettingsWithEngine(activeMonitorSettings, nextSettings);
            setRawMonitorSettings(prev => {
              const nextMonitorSettings = engine.syncRawMonitorSettingsWithEngine(prev, nextSettings);
              engine.saveRawMonitorSettings(nextMonitorSettings);
              return nextMonitorSettings;
            });
          }

          if (event.kind === 'started' || event.kind === 'progress') {
            setRawMonitorProgress({
              phase: event.kind === 'started' ? 'checking' : 'rendering',
              total: event.total ?? rawPaths.length,
              processed: event.processed ?? 0,
              current: event.current,
              profileId,
              running: true,
              errors: event.errors,
            });
          } else if (event.kind === 'cached') {
            if (event.rawPath && rawMonitorPriorityPathsRef.current.has(event.rawPath)) {
              setRawMonitorSettings(prev => {
                const next = { ...prev, cacheVersion: prev.cacheVersion + 1 };
                engine.saveRawMonitorSettings(next);
                return next;
              });
            }
            setRawMonitorProgress({
              phase: 'rendering',
              total: event.total ?? rawPaths.length,
              processed: event.processed ?? 0,
              current: event.current,
              profileId,
              running: true,
              errors: event.errors,
            });
          } else if (event.kind === 'skipped') {
            skippedDuringRender = true;
            setRawMonitorProgress(prev => ({
              ...prev,
              phase: 'rendering',
              total: event.total ?? prev.total,
              processed: event.processed ?? prev.processed,
              current: event.current,
              profileId,
              running: true,
            }));
          } else if (event.kind === 'error') {
            setRawMonitorProgress(prev => ({
              ...prev,
              phase: 'rendering',
              total: event.total ?? prev.total,
              processed: event.processed ?? prev.processed,
              current: event.current,
              profileId,
              errors: event.errors ?? (event.error ? [...(prev.errors ?? []), event.error] : prev.errors),
              running: true,
            }));
          } else if (event.kind === 'cancelled') {
            rawMonitorCancelRequestedRef.current = true;
            setRawMonitorProgress({
              phase: 'cancelled',
              total: event.total ?? rawPaths.length,
              processed: event.processed ?? 0,
              profileId,
              running: false,
              errors: event.errors,
            });
            setRawMonitorSettings(prev => {
              const next = engine.clearRawMonitorProfileReady(
                { ...prev, cacheVersion: prev.cacheVersion + 1 },
                profileId,
              );
              engine.saveRawMonitorSettings(next);
              return next;
            });
            void refreshRawMonitorCacheSize();
          } else if (event.kind === 'done') {
            const completed = !event.errors?.length && !skippedDuringRender && (event.processed ?? rawPaths.length) >= rawPaths.length;
            setRawMonitorProgress({
              phase: event.errors?.length ? 'error' : 'done',
              total: event.total ?? rawPaths.length,
              processed: event.processed ?? rawPaths.length,
              profileId,
              running: false,
              errors: event.errors,
            });
            setRawMonitorSettings(prev => {
              const versioned = { ...prev, cacheVersion: prev.cacheVersion + 1 };
              const next = completed
                ? engine.markRawMonitorProfileReady(versioned, profileId, scopeSignature, rawPaths.length)
                : engine.clearRawMonitorProfileReady(versioned, profileId);
              engine.saveRawMonitorSettings(next);
              return next;
            });
            void cleanupRawMonitorCacheLRU()
              .catch(error => {
                console.warn('Failed to cleanup RAW monitor cache after render:', error);
                return 0;
              })
              .finally(() => {
                void refreshRawMonitorCacheSize();
              });
          }
        },
      });
    } catch (error) {
      setRawMonitorProgress(prev => ({
        ...prev,
        phase: 'error',
        running: false,
        errors: [...(prev.errors ?? []), error instanceof Error ? error.message : String(error)],
      }));
      notify({
        kind: 'error',
        title: 'RAW monitor cache failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      setRawMonitorSettings(prev => {
        const next = engine.clearRawMonitorProfileReady(prev, requestedProfileId);
        engine.saveRawMonitorSettings(next);
        return next;
      });
    } finally {
      rawMonitorGenerationRunningRef.current = false;
      rawMonitorActiveProfileRef.current = null;
      rawMonitorPriorityPathsRef.current = new Set();
      const pending = rawMonitorPendingGenerationRef.current;
      rawMonitorPendingGenerationRef.current = null;
      if (pending) {
        void generateRawMonitorCacheForSettings(pending.monitorSettings);
      }
    }
  };

  const buildRawMonitorGenerationSettings = (profileId?: RawMonitorProfileId): RawMonitorSettings => {
    if (!profileId) return rawMonitorSettings;
    const autoExposureEnabled = profileId === engine.RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID;
    return {
      ...rawMonitorSettings,
      enabled: autoExposureEnabled ? true : rawMonitorSettings.enabled,
      autoExposureEnabled,
      profileId,
    };
  };

  const onGenerateRawMonitorCache = async () => {
    rawMonitorCancelRequestedRef.current = false;
    if (rawMonitorScope.total === 0) {
      await generateRawMonitorCacheForSettings(buildRawMonitorGenerationSettings(engine.RAW_MONITOR_BALANCED_PROFILE_ID));
      return;
    }
    await generateRawMonitorCacheForSettings(buildRawMonitorGenerationSettings(engine.RAW_MONITOR_BALANCED_PROFILE_ID));
    if (rawMonitorCancelRequestedRef.current) return;
    await generateRawMonitorCacheForSettings(buildRawMonitorGenerationSettings(engine.RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID));
  };

  const onCancelRawMonitorCache = async () => {
    rawMonitorCancelRequestedRef.current = true;
    try {
      await engine.cancelRawMonitorCacheRender();
    } catch (error) {
      console.warn('Failed to cancel RAW monitor cache:', error);
    }
  };

  const clearCache = async () => {
    setRawMonitorCacheBusy(true);
    try {
      await engine.clearRawMonitorCache();
        setRawMonitorSettings(prev => {
          const next = engine.clearRawMonitorProfileReady({ ...prev, cacheVersion: prev.cacheVersion + 1 });
          engine.saveRawMonitorSettings(next);
          return next;
        });
      await refreshRawMonitorCacheSize();
    } catch (error) {
      console.warn('Failed to clear RAW monitor cache:', error);
    } finally {
      setRawMonitorCacheBusy(false);
    }
  };

  const onRefreshRawMonitorCacheSize = async () => {
    setRawMonitorCacheBusy(true);
    try {
      await refreshRawMonitorCacheSize();
    } finally {
      setRawMonitorCacheBusy(false);
    }
  };

  const onCleanupRawMonitorCache = async () => {
    setRawMonitorCacheBusy(true);
    try {
      const freed = await cleanupRawMonitorCacheLRU();
      await refreshRawMonitorCacheSize();
      notify({
        kind: 'success',
        title: language === 'zh' ? 'RAW 监看缓存已检查' : 'RAW monitor cache checked',
        message: language === 'zh'
          ? (freed > 0 ? `已清理 ${formatCacheSize(freed)}。` : '缓存未超过上限，无需清理。')
          : (freed > 0 ? `Freed ${formatCacheSize(freed)}.` : 'Cache is below the limit.'),
        autoDismissMs: 2600,
      });
    } catch (error) {
      notify({
        kind: 'error',
        title: language === 'zh' ? 'RAW 监看缓存清理失败' : 'RAW monitor cleanup failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRawMonitorCacheBusy(false);
    }
  };

  useEffect(() => {
    engine.preloadRawMonitorCacheEntries(filteredPhotos ?? photos, selectedIndex ?? null, {
      enabled: rawMonitorSettings.enabled,
      engineVersion: rawMonitorSettings.engineVersion,
      profileId: engine.getRawMonitorProfileId(rawMonitorSettings),
      cacheVersion: rawMonitorSettings.cacheVersion,
      ahead: 3,
      behind: 1,
    });
  }, [
    filteredPhotos,
    photos,
    rawMonitorSettings.enabled,
    rawMonitorSettings.engineVersion,
    rawMonitorSettings.profileId,
    rawMonitorSettings.cacheVersion,
    selectedIndex,
  ]);

  return {
    rawEngineSettings,
    rawMonitorSettings,
    rawEngineBusy,
    rawMonitorProgress,
    rawMonitorCacheSizeBytes,
    rawMonitorCacheBusy,
    viewerPreview: {
      enabled: rawMonitorSettings.enabled && (rawMonitorSettings.autoExposureEnabled ? autoExposureCacheReady : rawCacheReady),
      autoExposureEnabled: rawMonitorSettings.autoExposureEnabled && autoExposureCacheReady,
      rawCacheReady,
      autoExposureCacheReady,
      profileId: engine.getRawMonitorProfileId(rawMonitorSettings),
      engineVersion: rawMonitorSettings.engineVersion,
      cacheVersion: rawMonitorSettings.cacheVersion,
      progress: rawMonitorProgress,
      lutEnabled: rawMonitorSettings.lutEnabled,
      lutPath: rawMonitorSettings.lutPath,
      lutName: rawMonitorSettings.lutName,
      lutStrength: rawMonitorSettings.lutStrength,
      onEnabledChange: onRawMonitorEnabledChange,
      onAutoExposureChange: onRawMonitorAutoExposureChange,
      onLutEnabledChange: onRawMonitorLutEnabledChange,
      onChooseLut: onChooseMonitorLut,
      onRemoveLut: onRemoveMonitorLut,
      onLutStrengthChange: onRawMonitorLutStrengthChange,
      onGenerateCache: onGenerateRawMonitorCache,
      onCancelCache: onCancelRawMonitorCache,
      labels: rawMonitorViewerLabels(language),
    },
    rawCacheReady,
    autoExposureCacheReady,
    onRawMonitorEnabledChange,
    onRawMonitorAutoExposureChange,
    onRawMonitorLutEnabledChange,
    onChooseMonitorLut,
    onRemoveMonitorLut,
    onRawMonitorLutStrengthChange,
    onDetectRawEngine,
    onChooseRawEngine,
    onClearRawEngine,
    onGenerateRawMonitorCache,
    onCancelRawMonitorCache,
    onRefreshRawMonitorCacheSize,
    onCleanupRawMonitorCache,
    clearCache,
  };
}

function formatCacheSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function rawMonitorViewerLabels(language: Language) {
  if (language === 'zh') {
    return {
      title: '监看',
      raw: 'RAW 监看',
      auto: '自动曝光',
      lut: 'LUT',
      chooseLut: '选择 .cube',
      changeLut: '更换 .cube',
      removeLut: '移除',
      strength: '强度',
      checking: '检查 RAW 监看缓存',
      missing: '需要先生成 RAW 监看缓存',
      cacheBalanced: '普通监看缓存',
      cacheAuto: '自动曝光预览',
      close: '关闭监看面板',
    };
  }

  return {
    title: 'Monitor',
    raw: 'RAW preview',
    auto: 'Auto exposure',
    lut: 'LUT',
    chooseLut: 'Choose .cube',
    changeLut: 'Change .cube',
    removeLut: 'Remove',
    strength: 'Strength',
    checking: 'Checking RAW preview cache',
    missing: 'Generate RAW preview cache first',
    cacheBalanced: 'Balanced cache',
    cacheAuto: 'Auto exposure preview',
    close: 'Close monitor panel',
  };
}
