import type { PhotoGroup } from '../types';
import type { Language } from '../i18n';

export type RawMonitorNotify = (notification: {
  kind: 'success' | 'warning' | 'error' | 'info';
  title: string;
  message?: string;
  detail?: string;
  autoDismissMs?: number;
}) => void;

export function useRawMonitorFeature(_options: {
  photos: PhotoGroup[];
  filteredPhotos?: PhotoGroup[];
  selectedIndex?: number | null;
  language: Language;
  notify: RawMonitorNotify;
}) {
  return {
    rawEngineSettings: null,
    rawMonitorSettings: null,
    rawEngineBusy: false,
    rawMonitorProgress: undefined,
    rawCacheReady: false,
    autoExposureCacheReady: false,
    rawMonitorCacheSizeBytes: null,
    rawMonitorCacheBusy: false,
    viewerPreview: undefined,
    onRawMonitorEnabledChange: undefined,
    onRawMonitorAutoExposureChange: undefined,
    onRawMonitorLutEnabledChange: undefined,
    onChooseMonitorLut: undefined,
    onRemoveMonitorLut: undefined,
    onRawMonitorLutStrengthChange: undefined,
    onDetectRawEngine: undefined,
    onChooseRawEngine: undefined,
    onClearRawEngine: undefined,
    onGenerateRawMonitorCache: undefined,
    onCancelRawMonitorCache: undefined,
    onRefreshRawMonitorCacheSize: undefined,
    onCleanupRawMonitorCache: undefined,
    clearCache: () => undefined,
  };
}
