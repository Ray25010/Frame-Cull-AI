import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import {
  PhotoGroup,
  RawEngineSettings,
  RawEngineValidationResult,
  RawMonitorCacheEntry,
  RawMonitorCacheEvent,
  RawMonitorProfileReadyState,
  RawMonitorProfileId,
  RawMonitorSettings,
} from '../types';
import { hasTauriRuntime } from './tauriRuntime';

export const RAW_ENGINE_SETTINGS_STORAGE_KEY = 'framecull-raw-engine-settings';
export const RAW_MONITOR_SETTINGS_STORAGE_KEY = 'framecull-pro-raw-monitor-settings';
export const RAW_MONITOR_BALANCED_PROFILE_ID: RawMonitorProfileId = 'FrameCull_Monitor_Balanced_v1';
export const RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID: RawMonitorProfileId = 'FrameCull_Monitor_AutoExposure_v1';
export const RAW_MONITOR_PROFILE_ID = RAW_MONITOR_BALANCED_PROFILE_ID;
export const RAW_MONITOR_SETTINGS_VERSION = 5;

export const DEFAULT_RAW_ENGINE_SETTINGS: RawEngineSettings = {
  engineKind: 'RAWTHERAPEE',
  enginePath: '',
  status: 'idle',
};

export const DEFAULT_RAW_MONITOR_SETTINGS: RawMonitorSettings = {
  settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
  enabled: false,
  autoExposureEnabled: false,
  engineKind: 'RAWTHERAPEE',
  enginePath: '',
  profileId: RAW_MONITOR_BALANCED_PROFILE_ID,
  lutEnabled: false,
  lutStrength: 1,
  cacheVersion: 0,
  cacheReadyProfiles: {},
};

const rawMonitorEntryCache = new Map<string, RawMonitorCacheEntry & { cacheUrl?: string }>();

export function parseRawEngineSettings(value: string | null): RawEngineSettings {
  if (!value) return { ...DEFAULT_RAW_ENGINE_SETTINGS };

  try {
    const parsed = JSON.parse(value) as Partial<RawEngineSettings>;
    if (parsed.engineKind !== 'RAWTHERAPEE') return { ...DEFAULT_RAW_ENGINE_SETTINGS };
    return {
      engineKind: 'RAWTHERAPEE',
      enginePath: typeof parsed.enginePath === 'string' ? parsed.enginePath : '',
      status: isRawEngineStatus(parsed.status) ? parsed.status : 'idle',
      engineSource: isRawEngineSource(parsed.engineSource) ? parsed.engineSource : undefined,
      lastDetectedAt: typeof parsed.lastDetectedAt === 'number' ? parsed.lastDetectedAt : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      bundledEngineVersion: typeof parsed.bundledEngineVersion === 'string' ? parsed.bundledEngineVersion : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    };
  } catch {
    return { ...DEFAULT_RAW_ENGINE_SETTINGS };
  }
}

export function readRawEngineSettings(): RawEngineSettings {
  try {
    return parseRawEngineSettings(localStorage.getItem(RAW_ENGINE_SETTINGS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_RAW_ENGINE_SETTINGS };
  }
}

export function saveRawEngineSettings(settings: RawEngineSettings) {
  try {
    localStorage.setItem(RAW_ENGINE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Settings are helpful, but losing them should not block culling.
  }
}

export function parseRawMonitorSettings(value: string | null): RawMonitorSettings {
  if (!value) return { ...DEFAULT_RAW_MONITOR_SETTINGS };

  try {
    const parsed = JSON.parse(value) as Partial<RawMonitorSettings>;
    if (parsed.engineKind !== 'RAWTHERAPEE') return { ...DEFAULT_RAW_MONITOR_SETTINGS };
    const migratedFromOldSettings = parsed.settingsVersion !== RAW_MONITOR_SETTINGS_VERSION;
    const autoExposureEnabled = migratedFromOldSettings ? false : parsed.autoExposureEnabled === true;
    const profileId = autoExposureEnabled
      ? RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID
      : RAW_MONITOR_BALANCED_PROFILE_ID;
    return {
      settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
      enabled: migratedFromOldSettings ? false : parsed.enabled === true,
      autoExposureEnabled,
      engineKind: 'RAWTHERAPEE',
      enginePath: typeof parsed.enginePath === 'string' ? parsed.enginePath : '',
      engineVersion: typeof parsed.engineVersion === 'string' ? parsed.engineVersion : undefined,
      engineSource: isRawEngineSource(parsed.engineSource) ? parsed.engineSource : undefined,
      bundledEngineVersion: typeof parsed.bundledEngineVersion === 'string' ? parsed.bundledEngineVersion : undefined,
      profileId,
      lutEnabled: parsed.lutEnabled === true,
      lutPath: typeof parsed.lutPath === 'string' && parsed.lutPath.trim() ? parsed.lutPath : undefined,
      lutName: typeof parsed.lutName === 'string' && parsed.lutName.trim() ? parsed.lutName : undefined,
      lutStrength: normalizeLutStrength(parsed.lutStrength),
      cacheVersion: typeof parsed.cacheVersion === 'number' && Number.isFinite(parsed.cacheVersion)
        ? Math.max(0, Math.floor(parsed.cacheVersion))
        : 0,
      cacheReadyProfiles: parseRawMonitorProfileReadyStates(parsed.cacheReadyProfiles),
    };
  } catch {
    return { ...DEFAULT_RAW_MONITOR_SETTINGS };
  }
}

export function readRawMonitorSettings(): RawMonitorSettings {
  try {
    return parseRawMonitorSettings(localStorage.getItem(RAW_MONITOR_SETTINGS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_RAW_MONITOR_SETTINGS };
  }
}

export function saveRawMonitorSettings(settings: RawMonitorSettings) {
  try {
    localStorage.setItem(RAW_MONITOR_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Preview settings are optional; losing them should never block culling.
  }
}

export function syncRawMonitorSettingsWithEngine(
  settings: RawMonitorSettings,
  engine: RawEngineSettings,
): RawMonitorSettings {
  return {
    ...settings,
    engineKind: engine.engineKind,
    enginePath: engine.enginePath,
    engineVersion: engine.version,
    engineSource: engine.engineSource,
    bundledEngineVersion: engine.bundledEngineVersion,
    profileId: getRawMonitorProfileId(settings),
  };
}

export function getRawMonitorProfileId(settings: Pick<RawMonitorSettings, 'autoExposureEnabled' | 'profileId'>): RawMonitorProfileId {
  return settings.autoExposureEnabled ? RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID : RAW_MONITOR_BALANCED_PROFILE_ID;
}

export function applyRawMonitorEnabledChange(settings: RawMonitorSettings, enabled: boolean): RawMonitorSettings {
  return {
    ...settings,
    settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
    enabled,
    profileId: getRawMonitorProfileId(settings),
  };
}

export function applyRawMonitorAutoExposureChange(settings: RawMonitorSettings, autoExposureEnabled: boolean): RawMonitorSettings {
  return {
    ...settings,
    settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
    autoExposureEnabled,
    profileId: getRawMonitorProfileId({ ...settings, autoExposureEnabled }),
  };
}

export function buildRawMonitorScopeSignature(rawPaths: string[]) {
  const uniqueSorted = [...new Set(rawPaths)]
    .map(path => path.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  let hash = 2166136261;
  for (const path of uniqueSorted) {
    for (let index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 124;
    hash = Math.imul(hash, 16777619);
  }
  return `${uniqueSorted.length}:${(hash >>> 0).toString(16)}`;
}

export function isRawMonitorProfileReady(
  settings: RawMonitorSettings,
  profileId: RawMonitorProfileId,
  signature: string,
  total: number,
) {
  if (!signature || total <= 0) return false;
  const ready = settings.cacheReadyProfiles?.[profileId];
  return Boolean(ready && ready.signature === signature && ready.total === total);
}

export function markRawMonitorProfileReady(
  settings: RawMonitorSettings,
  profileId: RawMonitorProfileId,
  signature: string,
  total: number,
): RawMonitorSettings {
  return {
    ...settings,
    cacheReadyProfiles: {
      ...(settings.cacheReadyProfiles ?? {}),
      [profileId]: {
        signature,
        total,
        completedAt: Date.now(),
      },
    },
  };
}

export function clearRawMonitorProfileReady(
  settings: RawMonitorSettings,
  profileId?: RawMonitorProfileId,
): RawMonitorSettings {
  if (!profileId) {
    return {
      ...settings,
      cacheReadyProfiles: {},
    };
  }
  const nextReady = { ...(settings.cacheReadyProfiles ?? {}) };
  delete nextReady[profileId];
  return {
    ...settings,
    cacheReadyProfiles: nextReady,
  };
}

export async function detectRawTherapeeCli(): Promise<RawEngineValidationResult> {
  if (!hasTauriRuntime()) {
    return {
      ok: false,
      engineKind: 'RAWTHERAPEE',
      message: 'RawTherapee detection is only available in the desktop app.',
    };
  }
  return invoke<RawEngineValidationResult>('detect_rawtherapee_cli');
}

export async function validateRawEngine(enginePath: string): Promise<RawEngineValidationResult> {
  if (!hasTauriRuntime()) {
    return {
      ok: false,
      engineKind: 'RAWTHERAPEE',
      enginePath,
      message: 'RawTherapee validation is only available in the desktop app.',
    };
  }
  return invoke<RawEngineValidationResult>('validate_raw_engine', { enginePath });
}

export async function getRawMonitorCacheEntry(
  rawPath: string,
  engineVersion: string,
  profileId: RawMonitorProfileId,
  cacheVersion = 0,
): Promise<(RawMonitorCacheEntry & { cacheUrl?: string }) | null> {
  if (!hasTauriRuntime()) return null;
  const memoryKey = rawMonitorEntryMemoryKey(rawPath, engineVersion, profileId, cacheVersion);
  const entry = await invoke<RawMonitorCacheEntry>('get_raw_monitor_cache_entry', {
    rawPath,
    engineVersion,
    profileId,
  });
  const normalized = {
    ...entry,
    profileId,
    cacheUrl: entry.cachePath ? convertFileSrc(entry.cachePath) : undefined,
  };
  rawMonitorEntryCache.set(memoryKey, normalized);
  return normalized;
}

export function peekRawMonitorCacheEntry(
  rawPath: string,
  engineVersion: string,
  profileId: RawMonitorProfileId,
  cacheVersion = 0,
): (RawMonitorCacheEntry & { cacheUrl?: string }) | null {
  return rawMonitorEntryCache.get(rawMonitorEntryMemoryKey(rawPath, engineVersion, profileId, cacheVersion)) ?? null;
}

export function preloadRawMonitorCacheEntries(
  photos: PhotoGroup[],
  currentIndex: number | null,
  options: {
    enabled?: boolean;
    engineVersion?: string;
    profileId?: RawMonitorProfileId;
    cacheVersion?: number;
    ahead?: number;
    behind?: number;
  },
) {
  if (!options.enabled || !options.engineVersion || !options.profileId) return;
  if (currentIndex === null || currentIndex < 0 || photos.length === 0) return;

  const ahead = options.ahead ?? 3;
  const behind = options.behind ?? 1;
  const start = Math.max(0, currentIndex - behind);
  const end = Math.min(photos.length - 1, currentIndex + ahead);
  for (let index = start; index <= end; index += 1) {
    const rawPath = photos[index]?.raw?.path;
    if (!rawPath) continue;
    if (peekRawMonitorCacheEntry(rawPath, options.engineVersion, options.profileId, options.cacheVersion)) continue;
    void getRawMonitorCacheEntry(rawPath, options.engineVersion, options.profileId, options.cacheVersion).catch(() => {
      // A prefetch miss should not interrupt navigation.
    });
  }
}

export function buildRawMonitorGenerationQueue(
  photos: PhotoGroup[],
  currentIndex: number | null | undefined,
  options: {
    nearby?: number;
  } = {},
) {
  const rawAt = (index: number) => photos[index]?.raw?.path || null;
  const unique = new Set<string>();
  const ordered: string[] = [];
  const priority: string[] = [];
  const push = (path: string | null, isPriority = false) => {
    if (!path || unique.has(path)) return;
    unique.add(path);
    ordered.push(path);
    if (isPriority) priority.push(path);
  };

  if (photos.length === 0) {
    return { rawPaths: ordered, priorityRawPaths: priority };
  }

  const nearby = Math.max(0, Math.floor(options.nearby ?? 4));
  const center = typeof currentIndex === 'number' && Number.isFinite(currentIndex)
    ? Math.max(0, Math.min(photos.length - 1, Math.floor(currentIndex)))
    : 0;

  push(rawAt(center), true);
  for (let distance = 1; distance <= nearby; distance += 1) {
    push(rawAt(center - distance), true);
    push(rawAt(center + distance), true);
  }
  for (let index = 0; index < photos.length; index += 1) {
    push(rawAt(index), false);
  }

  return { rawPaths: ordered, priorityRawPaths: priority };
}

export async function renderRawMonitorCacheStream({
  enginePath,
  rawPaths,
  profileId,
  priorityCount,
  onEvent,
}: {
  enginePath: string;
  rawPaths: string[];
  profileId: RawMonitorProfileId;
  priorityCount?: number;
  onEvent: (event: RawMonitorCacheEvent) => void;
}) {
  if (!hasTauriRuntime()) throw new Error('RAW monitor cache rendering is only available in the desktop app.');
  const channel = new Channel<RawMonitorCacheEvent>(onEvent);
  await invoke('render_raw_monitor_cache_stream', {
    enginePath,
    rawPaths,
    profileId,
    priorityCount,
    onEvent: channel,
  });
}

export async function cancelRawMonitorCacheRender() {
  if (!hasTauriRuntime()) return;
  await invoke('cancel_raw_monitor_cache_render');
}

export async function clearRawMonitorCache() {
  if (!hasTauriRuntime()) return;
  await invoke('clear_raw_monitor_cache');
}

function isRawEngineStatus(value: unknown): value is RawEngineSettings['status'] {
  return value === 'idle'
    || value === 'detected'
    || value === 'manual'
    || value === 'valid'
    || value === 'invalid'
    || value === 'missing'
    || value === 'error';
}

function isRawEngineSource(value: unknown): value is RawEngineSettings['engineSource'] {
  return value === 'BUNDLED' || value === 'MANUAL' || value === 'SYSTEM';
}

function normalizeLutStrength(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function parseRawMonitorProfileReadyStates(value: unknown): RawMonitorSettings['cacheReadyProfiles'] {
  if (!value || typeof value !== 'object') return {};
  const source = value as Partial<Record<RawMonitorProfileId, Partial<RawMonitorProfileReadyState>>>;
  const output: RawMonitorSettings['cacheReadyProfiles'] = {};
  for (const profileId of [RAW_MONITOR_BALANCED_PROFILE_ID, RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID]) {
    const item = source[profileId];
    if (!item || typeof item.signature !== 'string' || !item.signature) continue;
    if (typeof item.total !== 'number' || !Number.isFinite(item.total) || item.total <= 0) continue;
    output[profileId] = {
      signature: item.signature,
      total: Math.floor(item.total),
      completedAt: typeof item.completedAt === 'number' && Number.isFinite(item.completedAt)
        ? item.completedAt
        : 0,
    };
  }
  return output;
}

function rawMonitorEntryMemoryKey(
  rawPath: string,
  engineVersion: string,
  profileId: RawMonitorProfileId,
  cacheVersion: number,
) {
  return `${profileId}\n${engineVersion}\n${cacheVersion}\n${rawPath}`;
}
