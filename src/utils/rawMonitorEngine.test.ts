import { describe, expect, it } from 'vitest';
import { GroupStatus, SelectionState, type PhotoGroup } from '../types';
import {
  DEFAULT_RAW_ENGINE_SETTINGS,
  DEFAULT_RAW_MONITOR_SETTINGS,
  RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID,
  RAW_MONITOR_BALANCED_PROFILE_ID,
  RAW_MONITOR_PROFILE_ID,
  RAW_MONITOR_SETTINGS_VERSION,
  applyRawMonitorAutoExposureChange,
  applyRawMonitorEnabledChange,
  buildRawMonitorGenerationQueue,
  getRawMonitorProfileId,
  parseRawEngineSettings,
  parseRawMonitorSettings,
} from './rawMonitorEngine';

function photo(id: string, rawPath?: string): PhotoGroup {
  return {
    id,
    raw: rawPath ? {
      name: `${id}.NEF`,
      extension: 'nef',
      file: {} as File,
      previewUrl: '',
      size: 1,
      path: rawPath,
    } : undefined,
    status: rawPath ? GroupStatus.RAW_ONLY : GroupStatus.JPG_ONLY,
    selection: SelectionState.UNMARKED,
    rating: 0,
  };
}

describe('rawMonitorEngine settings', () => {
  it('falls back to default settings for empty or invalid storage', () => {
    expect(parseRawEngineSettings(null)).toEqual(DEFAULT_RAW_ENGINE_SETTINGS);
    expect(parseRawEngineSettings('{bad json')).toEqual(DEFAULT_RAW_ENGINE_SETTINGS);
  });

  it('keeps a valid RawTherapee setting payload', () => {
    const settings = parseRawEngineSettings(JSON.stringify({
      engineKind: 'RAWTHERAPEE',
      enginePath: 'C:/Program Files/RawTherapee/rawtherapee-cli.exe',
      status: 'valid',
      engineSource: 'SYSTEM',
      lastDetectedAt: 123,
      version: 'RawTherapee, version 5.12',
      bundledEngineVersion: '5.12',
      message: 'ok',
    }));

    expect(settings).toEqual({
      engineKind: 'RAWTHERAPEE',
      enginePath: 'C:/Program Files/RawTherapee/rawtherapee-cli.exe',
      status: 'valid',
      engineSource: 'SYSTEM',
      lastDetectedAt: 123,
      version: 'RawTherapee, version 5.12',
      bundledEngineVersion: '5.12',
      message: 'ok',
    });
  });

  it('rejects unsupported engines and invalid statuses', () => {
    expect(parseRawEngineSettings(JSON.stringify({
      engineKind: 'DARKTABLE',
      enginePath: 'darktable-cli.exe',
      status: 'valid',
    }))).toEqual(DEFAULT_RAW_ENGINE_SETTINGS);

    expect(parseRawEngineSettings(JSON.stringify({
      engineKind: 'RAWTHERAPEE',
      enginePath: 'rawtherapee-cli.exe',
      status: 'surprising',
    }))).toMatchObject({
      engineKind: 'RAWTHERAPEE',
      enginePath: 'rawtherapee-cli.exe',
      status: 'idle',
    });
  });
});

describe('rawMonitorEngine generation queue', () => {
  it('prioritizes the current photo and nearby RAW files before filling the rest', () => {
    const photos = [
      photo('p0', 'raw-0.nef'),
      photo('p1', 'raw-1.nef'),
      photo('p2', 'raw-2.nef'),
      photo('p3', 'raw-3.nef'),
      photo('p4', 'raw-4.nef'),
      photo('p5', 'raw-5.nef'),
    ];

    const queue = buildRawMonitorGenerationQueue(photos, 2, { nearby: 2 });

    expect(queue.priorityRawPaths).toEqual([
      'raw-2.nef',
      'raw-1.nef',
      'raw-3.nef',
      'raw-0.nef',
      'raw-4.nef',
    ]);
    expect(queue.rawPaths).toEqual([
      'raw-2.nef',
      'raw-1.nef',
      'raw-3.nef',
      'raw-0.nef',
      'raw-4.nef',
      'raw-5.nef',
    ]);
  });

  it('deduplicates RAW paths and skips non-RAW groups in the current scope', () => {
    const photos = [
      photo('p0', 'raw-0.nef'),
      photo('p1'),
      photo('p2', 'raw-2.nef'),
      photo('p3', 'raw-2.nef'),
      photo('p4', 'raw-4.nef'),
    ];

    const queue = buildRawMonitorGenerationQueue(photos, 2, { nearby: 3 });

    expect(queue.priorityRawPaths).toEqual(['raw-2.nef', 'raw-0.nef', 'raw-4.nef']);
    expect(queue.rawPaths).toEqual(['raw-2.nef', 'raw-0.nef', 'raw-4.nef']);
  });
});

describe('rawMonitorEngine monitor settings', () => {
  it('defaults the Pro monitor preview to disabled', () => {
    expect(parseRawMonitorSettings(null)).toEqual(DEFAULT_RAW_MONITOR_SETTINGS);
    expect(DEFAULT_RAW_MONITOR_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_RAW_MONITOR_SETTINGS.autoExposureEnabled).toBe(false);
  });

  it('keeps a valid Pro monitor preview payload', () => {
    const settings = parseRawMonitorSettings(JSON.stringify({
      settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
      enabled: true,
      engineKind: 'RAWTHERAPEE',
      enginePath: 'C:/Program Files/RawTherapee/rawtherapee-cli.exe',
      engineVersion: 'RawTherapee, version 5.12',
      engineSource: 'BUNDLED',
      bundledEngineVersion: '5.12',
      profileId: RAW_MONITOR_PROFILE_ID,
      autoExposureEnabled: false,
      lutEnabled: true,
      lutPath: 'C:/looks/soft.cube',
      lutName: 'soft',
      lutStrength: 0.65,
      cacheVersion: 3,
    }));

    expect(settings).toEqual({
      settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
      enabled: true,
      engineKind: 'RAWTHERAPEE',
      enginePath: 'C:/Program Files/RawTherapee/rawtherapee-cli.exe',
      engineVersion: 'RawTherapee, version 5.12',
      engineSource: 'BUNDLED',
      bundledEngineVersion: '5.12',
      profileId: RAW_MONITOR_PROFILE_ID,
      autoExposureEnabled: false,
      lutEnabled: true,
      lutPath: 'C:/looks/soft.cube',
      lutName: 'soft',
      lutStrength: 0.65,
      cacheVersion: 3,
      cacheReadyProfiles: {},
    });
  });

  it('migrates old Pro monitor settings to disabled while preserving non-switch preferences', () => {
    const settings = parseRawMonitorSettings(JSON.stringify({
      settingsVersion: RAW_MONITOR_SETTINGS_VERSION - 1,
      enabled: true,
      autoExposureEnabled: true,
      engineKind: 'RAWTHERAPEE',
      enginePath: 'C:/Program Files/RawTherapee/rawtherapee-cli.exe',
      engineVersion: 'RawTherapee, version 5.12',
      engineSource: 'BUNDLED',
      bundledEngineVersion: '5.12',
      profileId: RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID,
      lutEnabled: true,
      lutPath: 'C:/looks/soft.cube',
      lutName: 'soft',
      lutStrength: 0.5,
      cacheVersion: 8,
    }));

    expect(settings).toMatchObject({
      settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
      enabled: false,
      autoExposureEnabled: false,
      enginePath: 'C:/Program Files/RawTherapee/rawtherapee-cli.exe',
      engineVersion: 'RawTherapee, version 5.12',
      engineSource: 'BUNDLED',
      bundledEngineVersion: '5.12',
      profileId: RAW_MONITOR_BALANCED_PROFILE_ID,
      lutEnabled: true,
      lutPath: 'C:/looks/soft.cube',
      lutName: 'soft',
      lutStrength: 0.5,
      cacheVersion: 8,
    });
  });

  it('does not re-migrate current Pro monitor settings', () => {
    const settings = parseRawMonitorSettings(JSON.stringify({
      settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
      enabled: true,
      autoExposureEnabled: true,
      engineKind: 'RAWTHERAPEE',
      profileId: RAW_MONITOR_BALANCED_PROFILE_ID,
      cacheVersion: 4,
    }));

    expect(settings.enabled).toBe(true);
    expect(settings.autoExposureEnabled).toBe(true);
    expect(settings.profileId).toBe(RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID);
    expect(settings.cacheVersion).toBe(4);
  });

  it('rejects unsupported monitor payload details', () => {
    expect(parseRawMonitorSettings(JSON.stringify({
      enabled: true,
      engineKind: 'DARKTABLE',
      enginePath: 'darktable-cli.exe',
    }))).toEqual(DEFAULT_RAW_MONITOR_SETTINGS);

    expect(parseRawMonitorSettings(JSON.stringify({
      enabled: true,
      engineKind: 'RAWTHERAPEE',
      settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
      profileId: 'custom',
      cacheVersion: -2,
    }))).toMatchObject({
      settingsVersion: RAW_MONITOR_SETTINGS_VERSION,
      enabled: true,
      engineKind: 'RAWTHERAPEE',
      profileId: RAW_MONITOR_PROFILE_ID,
      autoExposureEnabled: false,
      lutEnabled: false,
      lutStrength: 1,
      cacheVersion: 0,
    });
  });

  it('selects the auto exposure cache profile when auto exposure preview is enabled', () => {
    expect(getRawMonitorProfileId({
      autoExposureEnabled: false,
      profileId: RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID,
    })).toBe(RAW_MONITOR_BALANCED_PROFILE_ID);

    expect(getRawMonitorProfileId({
      autoExposureEnabled: true,
      profileId: RAW_MONITOR_BALANCED_PROFILE_ID,
    })).toBe(RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID);
  });

  it('keeps auto exposure independent from the RAW monitor enabled switch', () => {
    const base = {
      ...DEFAULT_RAW_MONITOR_SETTINGS,
      enabled: false,
      autoExposureEnabled: false,
      cacheVersion: 2,
    };

    const autoOn = applyRawMonitorAutoExposureChange(base, true);
    expect(autoOn.enabled).toBe(false);
    expect(autoOn.autoExposureEnabled).toBe(true);
    expect(autoOn.profileId).toBe(RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID);
    expect(autoOn.cacheVersion).toBe(2);

    const monitorOn = applyRawMonitorEnabledChange(autoOn, true);
    expect(monitorOn.enabled).toBe(true);
    expect(monitorOn.profileId).toBe(RAW_MONITOR_AUTO_EXPOSURE_PROFILE_ID);
    expect(monitorOn.cacheVersion).toBe(2);

    const autoOff = applyRawMonitorAutoExposureChange(monitorOn, false);
    expect(autoOff.enabled).toBe(true);
    expect(autoOff.profileId).toBe(RAW_MONITOR_BALANCED_PROFILE_ID);
    expect(autoOff.cacheVersion).toBe(2);
  });
});
