import React from 'react';
import { Cpu } from 'lucide-react';
import { AppIcon } from '../components/ui/AppIcon';
import { glassSubtle } from '../components/ui/chrome';
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

export const RawEngineSection = ({
  theme,
  language,
  settings,
  monitorSettings,
  busy,
  progress,
  rawCacheReady = false,
  autoExposureCacheReady = false,
  cacheSizeBytes,
  cacheBusy,
  onMonitorEnabledChange,
  onAutoExposureChange,
  onLutEnabledChange,
  onChooseLut,
  onRemoveLut,
  onLutStrengthChange,
  onDetect,
  onChoose,
  onClear,
  onGenerate,
  onCancel,
  onRefreshCacheSize,
  onCleanupCache,
  onClearCache,
}: RawEngineSectionProps) => {
  const text = copy[language];
  const isRunning = Boolean(progress?.running);
  const percent = progress?.total ? Math.round((progress.processed / progress.total) * 100) : 0;
  const ok = settings?.status === 'detected' || settings?.status === 'manual' || settings?.status === 'valid';
  const enabled = Boolean(monitorSettings?.enabled && rawCacheReady);
  const autoExposureEnabled = Boolean(monitorSettings?.autoExposureEnabled && autoExposureCacheReady);
  const lutEnabled = Boolean(monitorSettings?.lutEnabled);
  const lutStrength = monitorSettings?.lutStrength ?? 1;
  const sourceLabel = sourceCopy(language, settings?.engineSource);
  const cacheSizeLabel = cacheSizeBytes == null ? text.cacheUnknown : formatCacheSize(cacheSizeBytes);
  const hasCache = (cacheSizeBytes ?? 0) > 0;
  const statusLabel = ok
    ? `${text.ready} · ${sourceLabel}`
    : text.notReady;

  return (
    <div className={`pt-6 border-t ${theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-400/24'}`}>
      <label className={`block text-sm font-bold mb-2 ${theme === 'dark' ? 'text-zinc-300' : 'text-gray-700'}`}>
        <AppIcon icon={Cpu} className="mr-2 inline h-4 w-4 align-[-3px]" />
        {text.title}
      </label>
      <p className={`mb-3 text-xs leading-relaxed ${theme === 'dark' ? 'text-zinc-500' : 'text-gray-500'}`}>
        {text.description}
      </p>

      <div className={`rounded-lg border p-3 ${
        theme === 'dark'
          ? `${glassSubtle.dark}`
          : 'border-slate-400/30 bg-slate-100/[0.62] shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]'
      }`}>
        <SwitchRow
          theme={theme}
          active={enabled}
          title={text.preview}
          detail={rawCacheReady ? text.previewHint : text.cacheNotReady}
          disabled={!rawCacheReady}
          onClick={() => onMonitorEnabledChange?.(!enabled)}
        />
        <SwitchRow
          theme={theme}
          active={autoExposureEnabled}
          title={text.autoExposure}
          detail={autoExposureCacheReady ? text.autoExposureHint : text.autoCacheNotReady}
          disabled={!autoExposureCacheReady}
          onClick={() => onAutoExposureChange?.(!autoExposureEnabled)}
        />
        <SwitchRow
          theme={theme}
          active={lutEnabled}
          title={text.lut}
          detail={monitorSettings?.lutName || text.lutHint}
          onClick={() => {
            if (!lutEnabled && !monitorSettings?.lutPath) onChooseLut?.();
            else onLutEnabledChange?.(!lutEnabled);
          }}
        />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <SmallSettingsButton theme={theme} onClick={onChooseLut || (() => undefined)}>
            {monitorSettings?.lutPath ? text.changeLut : text.chooseLut}
          </SmallSettingsButton>
          <SmallSettingsButton theme={theme} onClick={onRemoveLut || (() => undefined)} disabled={!monitorSettings?.lutPath}>
            {text.removeLut}
          </SmallSettingsButton>
        </div>
        <label className={`mt-3 block text-[10.5px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}`}>
          {text.lutStrength} · {Math.round(lutStrength * 100)}%
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={lutStrength}
          onChange={event => onLutStrengthChange?.(Number(event.currentTarget.value))}
          className={`export-quality-slider mt-1 w-full ${theme}`}
          style={{ '--quality': `${Math.round(lutStrength * 100)}%` } as React.CSSProperties}
          disabled={!monitorSettings?.lutPath}
        />

        <div className={`mt-4 text-xs font-semibold ${ok ? (theme === 'dark' ? 'text-emerald-300' : 'text-emerald-700') : (theme === 'dark' ? 'text-zinc-400' : 'text-slate-600')}`}>
          {statusLabel}
        </div>
        <div className={`mt-2 truncate font-mono text-[10px] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {settings?.enginePath || 'rawtherapee-cli.exe'}
        </div>
        {settings?.version && (
          <div className={`mt-1 truncate font-mono text-[10px] ${theme === 'dark' ? 'text-zinc-600' : 'text-slate-400'}`}>
            {settings.version}
          </div>
        )}
        {settings?.bundledEngineVersion && (
          <div className={`mt-1 text-[10.5px] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
            {language === 'zh'
              ? `Pro 内置 RawTherapee ${settings.bundledEngineVersion}`
              : `Pro bundled RawTherapee ${settings.bundledEngineVersion}`}
          </div>
        )}
        {settings?.message && !ok && (
          <div className={`mt-2 text-[10.5px] leading-4 ${theme === 'dark' ? 'text-amber-300' : 'text-amber-700'}`}>
            {settings.message}
          </div>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          <SmallSettingsButton theme={theme} onClick={onDetect || (() => undefined)} disabled={busy || isRunning}>
            {busy ? '...' : text.detect}
          </SmallSettingsButton>
          <SmallSettingsButton theme={theme} onClick={onChoose || (() => undefined)} disabled={busy || isRunning}>
            {text.choose}
          </SmallSettingsButton>
          <SmallSettingsButton theme={theme} onClick={onClear || (() => undefined)} disabled={busy || isRunning || !settings?.enginePath}>
            {text.reset}
          </SmallSettingsButton>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <SmallSettingsButton theme={theme} onClick={onGenerate || (() => undefined)} disabled={busy || isRunning || !ok}>
            {text.generate}
          </SmallSettingsButton>
          <SmallSettingsButton theme={theme} onClick={onCancel || (() => undefined)} disabled={!isRunning}>
            {text.cancel}
          </SmallSettingsButton>
        </div>

        {progress && progress.phase !== 'idle' && (
          <div className="mt-3">
            <div className="flex items-center justify-between gap-2 text-[10.5px] font-semibold">
              <span className={theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}>
                {progress.phase}
              </span>
              <span className={theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}>
                {progress.processed}/{progress.total} · {percent}%
              </span>
            </div>
            <div className={`mt-1 h-1.5 overflow-hidden rounded-full ${theme === 'dark' ? 'bg-white/[0.06]' : 'bg-slate-300/60'}`}>
              <div
                className="h-full rounded-full bg-cyan-500 transition-[width] duration-200"
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            </div>
            {progress.current && (
              <div className={`mt-1 truncate text-[10px] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
                {progress.current}
              </div>
            )}
            {progress.errors?.length ? (
              <div className={`mt-1 text-[10px] ${theme === 'dark' ? 'text-amber-300' : 'text-amber-700'}`}>
                {language === 'zh' ? `失败 ${progress.errors.length} 张` : `${progress.errors.length} failed`}
              </div>
            ) : null}
          </div>
        )}

        <div className={`mt-3 rounded-md px-2.5 py-2 text-[10.5px] leading-5 ${
          theme === 'dark' ? 'bg-black/18 text-zinc-400' : 'bg-white/64 text-slate-600'
        }`}>
          <div className="flex items-center justify-between gap-3">
            <span>{text.cacheSize}</span>
            <span className={`font-mono font-semibold ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-800'}`}>
              {cacheBusy ? '...' : cacheSizeLabel}
            </span>
          </div>
          <div className={`mt-1 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
            {text.cacheHint}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <SmallSettingsButton theme={theme} onClick={onRefreshCacheSize || (() => undefined)} disabled={cacheBusy}>
            {text.refreshCache}
          </SmallSettingsButton>
          <SmallSettingsButton theme={theme} onClick={onCleanupCache || (() => undefined)} disabled={cacheBusy || isRunning}>
            {text.cleanupCache}
          </SmallSettingsButton>
          <SmallSettingsButton theme={theme} onClick={onClearCache || (() => undefined)} disabled={cacheBusy || isRunning || !hasCache}>
            {text.clearCache}
          </SmallSettingsButton>
        </div>
      </div>
    </div>
  );
};

const copy = {
  zh: {
    title: 'RAW 监看引擎',
    description: 'Pro 使用内置 RawTherapee 生成只影响大图预览的 RAW 监看缓存。关闭时不扫描、不采样、不影响切图或 AI 筛片。',
    preview: 'RAW 监看预览',
    previewHint: '开启后优先读取已生成的 RAW 监看缓存；缺缓存时仍显示 JPG / 普通预览。',
    cacheNotReady: '先生成当前范围 RAW 缓存，完成后才可开启。',
    autoExposure: '自动曝光预览',
    autoExposureHint: '开启后自动生成自动曝光预览缓存；关闭时不会重新生成普通缓存。',
    autoCacheNotReady: '先生成当前范围自动曝光缓存，完成后才可开启。',
    lut: 'LUT 监看',
    lutHint: '导入 .cube 后可叠加在当前预览上。',
    chooseLut: '选择 .cube',
    changeLut: '更换 LUT',
    removeLut: '移除 LUT',
    lutStrength: 'LUT 强度',
    ready: 'RawTherapee CLI 已就绪',
    notReady: 'RawTherapee CLI 未就绪',
    detect: '检测引擎',
    choose: '手动选择',
    reset: '重置',
    generate: '生成缓存',
    generateAuto: '生成自动曝光预览',
    cancel: '取消',
    cacheSize: 'RAW 缓存占用',
    cacheHint: '只管理 RAW 监看/自动曝光预览缓存，不会删除原片。',
    cacheUnknown: '未计算',
    refreshCache: '刷新',
    cleanupCache: '瘦身',
    clearCache: '清空',
  },
  en: {
    title: 'RAW monitor engine',
    description: 'Pro uses bundled RawTherapee to generate RAW monitor cache for Viewer only. When off, it does not scan, sample, or affect culling speed.',
    preview: 'RAW monitor preview',
    previewHint: 'When enabled, Viewer prefers generated RAW monitor cache; without cache it keeps JPG / normal previews visible.',
    cacheNotReady: 'Generate the current range RAW cache before enabling.',
    autoExposure: 'Auto exposure preview',
    autoExposureHint: 'When enabled, it automatically generates an auto-exposure preview cache; turning it off will not regenerate the normal cache.',
    autoCacheNotReady: 'Generate the current range auto exposure cache before enabling.',
    lut: 'LUT monitor',
    lutHint: 'Import a .cube file and apply it over the current preview.',
    chooseLut: 'Choose .cube',
    changeLut: 'Change LUT',
    removeLut: 'Remove LUT',
    lutStrength: 'LUT strength',
    ready: 'RawTherapee CLI ready',
    notReady: 'RawTherapee CLI not ready',
    detect: 'Detect',
    choose: 'Choose CLI',
    reset: 'Reset',
    generate: 'Generate cache',
    generateAuto: 'Generate auto preview',
    cancel: 'Cancel',
    cacheSize: 'RAW cache size',
    cacheHint: 'Only RAW monitor / auto-exposure preview cache is managed here. Original photos stay untouched.',
    cacheUnknown: 'Not checked',
    refreshCache: 'Refresh',
    cleanupCache: 'Trim',
    clearCache: 'Clear',
  },
} as const;

function formatCacheSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sourceCopy(language: Language, source?: RawEngineSettings['engineSource']) {
  if (source === 'BUNDLED') return language === 'zh' ? '内置引擎' : 'Bundled engine';
  if (source === 'MANUAL') return language === 'zh' ? '手动指定' : 'Manual override';
  if (source === 'SYSTEM') return language === 'zh' ? '系统安装' : 'System install';
  return language === 'zh' ? '未检测' : 'Not detected';
}

const SwitchRow = ({
  theme,
  active,
  title,
  detail,
  disabled = false,
  onClick,
}: {
  theme: ResolvedTheme;
  active: boolean;
  title: string;
  detail: string;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={active}
    disabled={disabled}
    onClick={onClick}
    className={`mb-2 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
      disabled
        ? theme === 'dark'
          ? 'cursor-not-allowed border-white/[0.045] bg-white/[0.02] text-zinc-500 opacity-70'
          : 'cursor-not-allowed border-slate-300/35 bg-slate-100/55 text-slate-400 opacity-80'
        : active
        ? theme === 'dark'
          ? 'border-cyan-300/20 bg-cyan-300/10 text-cyan-100'
          : 'border-cyan-500/28 bg-cyan-100/70 text-cyan-900'
        : theme === 'dark'
          ? 'border-white/[0.07] bg-white/[0.035] text-zinc-300 hover:bg-white/[0.055]'
          : 'border-slate-400/25 bg-white/50 text-slate-700 hover:bg-white/80'
    }`}
  >
    <span className="min-w-0">
      <span className="block text-xs font-bold">{title}</span>
      <span className={`mt-1 block truncate text-[10.5px] leading-4 ${active && !disabled ? '' : theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
        {detail}
      </span>
    </span>
    <span className={`ml-3 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors ${
      active
        ? theme === 'dark' ? 'bg-cyan-300/70' : 'bg-cyan-600/80'
        : disabled
          ? theme === 'dark' ? 'bg-white/[0.06]' : 'bg-slate-200'
          : theme === 'dark' ? 'bg-white/[0.12]' : 'bg-slate-300'
    }`}>
      <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${active ? 'translate-x-3' : 'translate-x-0'}`} />
    </span>
  </button>
);

const SmallSettingsButton = ({
  theme,
  children,
  disabled,
  onClick,
}: {
  theme: ResolvedTheme;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`min-h-8 rounded-md px-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      theme === 'dark'
        ? 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.10]'
        : 'bg-white/72 text-slate-700 hover:bg-cyan-50'
    }`}
  >
    {children}
  </button>
);
