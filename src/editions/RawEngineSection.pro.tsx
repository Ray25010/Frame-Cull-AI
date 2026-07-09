import React from 'react';
import { Cpu, RefreshCw } from 'lucide-react';
import { AppIcon } from '../components/ui/AppIcon';
import { glassSubtle } from '../components/ui/chrome';
import type { ResolvedTheme } from '../hooks/useTheme';
import type { Language } from '../i18n';
import type { RawEngineSettings, RawMonitorCacheProgress } from '../types';

export interface RawEngineSectionProps {
  theme: ResolvedTheme;
  language: Language;
  settings?: RawEngineSettings | null;
  busy?: boolean;
  progress?: RawMonitorCacheProgress;
  cacheSizeBytes?: number | null;
  cacheBusy?: boolean;
  onDetect?: () => void;
  onChoose?: () => void;
  onClear?: () => void;
  onRefreshCacheSize?: () => void;
  onCleanupCache?: () => void;
  onClearCache?: () => void;
}

export const RawEngineSection = ({
  theme,
  language,
  settings,
  busy,
  progress,
  cacheSizeBytes,
  cacheBusy,
  onDetect,
  onChoose,
  onClear,
  onRefreshCacheSize,
  onCleanupCache,
  onClearCache,
}: RawEngineSectionProps) => {
  const text = copy[language];
  const isRunning = Boolean(progress?.running);
  const ok = settings?.status === 'detected' || settings?.status === 'manual' || settings?.status === 'valid';
  const sourceLabel = sourceCopy(language, settings?.engineSource);
  const cacheSizeLabel = cacheSizeBytes == null ? text.cacheUnknown : formatCacheSize(cacheSizeBytes);
  const hasCache = (cacheSizeBytes ?? 0) > 0;
  const statusLabel = ok ? `${text.ready} · ${sourceLabel}` : text.notReady;

  return (
    <div className={`border-t pt-6 ${theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-400/24'}`}>
      <label className={`mb-2 block text-sm font-bold ${theme === 'dark' ? 'text-zinc-300' : 'text-gray-700'}`}>
        <AppIcon icon={Cpu} className="mr-2 inline h-4 w-4 align-[-3px]" />
        {text.title}
      </label>
      <p
        className={`mb-3 truncate text-xs ${theme === 'dark' ? 'text-zinc-500' : 'text-gray-500'}`}
        title={text.description}
      >
        {text.shortDescription}
      </p>

      <div className={`rounded-lg border p-3 ${
        theme === 'dark'
          ? `${glassSubtle.dark}`
          : 'border-slate-400/30 bg-slate-100/[0.62] shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]'
      }`}>
        <div className={`text-xs font-semibold ${ok ? (theme === 'dark' ? 'text-emerald-300' : 'text-emerald-700') : (theme === 'dark' ? 'text-zinc-400' : 'text-slate-600')}`}>
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

        <div className={`mt-3 rounded-md px-2.5 py-2 text-[10.5px] leading-5 ${
          theme === 'dark' ? 'bg-black/18 text-zinc-400' : 'bg-white/64 text-slate-600'
        }`}>
          <div className="flex items-center justify-between gap-3">
            <span title={text.cacheHint}>{text.cacheSize}</span>
            <span className={`font-mono font-semibold ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-800'}`}>
              {cacheBusy ? '...' : cacheSizeLabel}
            </span>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onRefreshCacheSize || (() => undefined)}
            disabled={cacheBusy}
            title={text.refreshHint}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-wait disabled:opacity-45 ${
              theme === 'dark'
                ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-cyan-200'
                : 'text-slate-500 hover:bg-white/70 hover:text-cyan-700'
            }`}
          >
            <AppIcon icon={RefreshCw} className={`h-3.5 w-3.5 ${cacheBusy ? 'animate-spin' : ''}`} />
          </button>
          <SmallSettingsButton
            theme={theme}
            onClick={onCleanupCache || (() => undefined)}
            disabled={cacheBusy || isRunning}
            title={text.cleanupHint}
            className="flex-1"
          >
            {text.cleanupCache}
          </SmallSettingsButton>
          <SmallSettingsButton
            theme={theme}
            onClick={onClearCache || (() => undefined)}
            disabled={cacheBusy || isRunning || !hasCache}
            title={text.clearHint}
            className="flex-1"
          >
            {text.clearCache}
          </SmallSettingsButton>
        </div>
      </div>
    </div>
  );
};

const copy = {
  zh: {
    title: 'RAW 引擎',
    shortDescription: '用于 Pro RAW 监看和自动曝光缓存。',
    description: 'RawTherapee 只负责生成预览缓存，不会修改原片，也不影响主界面的 JPG 预览筛片。',
    ready: 'RawTherapee CLI 已就绪',
    notReady: 'RawTherapee CLI 未就绪',
    detect: '检测引擎',
    choose: '手动选择',
    reset: '重置',
    cacheSize: 'RAW 缓存占用',
    cacheHint: '只统计 RAW 监看和自动曝光预览缓存，不包含原片。',
    cacheUnknown: '未统计',
    refreshHint: '重新计算 RAW 缓存占用。',
    cleanupCache: '瘦身',
    cleanupHint: '只在缓存超过上限时删除最旧缓存，保留最近使用的缓存，不删除原片。',
    clearCache: '清空',
    clearHint: '清空 RAW 监看和自动曝光预览缓存，不删除原片。之后可在主界面重新生成。',
  },
  en: {
    title: 'RAW engine',
    shortDescription: 'For Pro RAW monitor and auto-exposure cache.',
    description: 'RawTherapee only generates preview cache. It never edits originals or blocks JPG-based culling.',
    ready: 'RawTherapee CLI ready',
    notReady: 'RawTherapee CLI not ready',
    detect: 'Detect',
    choose: 'Choose',
    reset: 'Reset',
    cacheSize: 'RAW cache size',
    cacheHint: 'Only RAW monitor and auto-exposure preview cache is counted. Originals are not included.',
    cacheUnknown: 'Not checked',
    refreshHint: 'Recalculate RAW cache usage.',
    cleanupCache: 'Trim',
    cleanupHint: 'Deletes the oldest cache only when the cache exceeds its limit. Recent cache and originals are kept.',
    clearCache: 'Clear',
    clearHint: 'Clears RAW monitor and auto-exposure preview cache without deleting originals. It can be regenerated from the viewer.',
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

const SmallSettingsButton = ({
  theme,
  children,
  disabled,
  onClick,
  title,
  className = '',
}: {
  theme: ResolvedTheme;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    title={title}
    className={`min-h-8 whitespace-nowrap rounded-md px-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      theme === 'dark'
        ? 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.10]'
        : 'bg-white/72 text-slate-700 hover:bg-cyan-50'
    } ${className}`}
  >
    {children}
  </button>
);
