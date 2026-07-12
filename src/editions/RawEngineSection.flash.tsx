import type { ResolvedTheme } from '../hooks/useTheme';
import type { Language } from '../i18n';
import type { RawEngineSettings, RawMonitorCacheProgress, RawMonitorSettings } from '../types';

export interface RawEngineSectionProps {
  theme: ResolvedTheme;
  language: Language;
  settings?: RawEngineSettings | null;
  monitorSettings?: RawMonitorSettings | null;
  busy?: boolean;
  progress?: RawMonitorCacheProgress;
  rawCacheReady?: boolean;
  autoExposureCacheReady?: boolean;
  cacheSizeBytes?: number | null;
  cacheBusy?: boolean;
  onMonitorEnabledChange?: (enabled: boolean) => void;
  onAutoExposureChange?: (enabled: boolean) => void;
  onLutEnabledChange?: (enabled: boolean) => void;
  onChooseLut?: () => void;
  onRemoveLut?: () => void;
  onLutStrengthChange?: (strength: number) => void;
  onDetect?: () => void;
  onChoose?: () => void;
  onClear?: () => void;
  onGenerate?: () => void;
  onCancel?: () => void;
  onRefreshCacheSize?: () => void;
  onCleanupCache?: () => void;
  onClearCache?: () => void;
}

export const RawEngineSection = (_props: RawEngineSectionProps) => null;
