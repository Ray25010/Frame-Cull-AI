import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AppWindow,
  ChevronDown,
  Clock3,
  Circle,
  FilePlus2,
  FileUp,
  FolderOpen,
  Maximize2,
  Minus,
  Pause,
  Play,
  Settings,
  SlidersHorizontal,
  Trash2,
  UsersRound,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Language } from '../i18n';
import { AiProgress, ImportProgress, RawDecodeProgress } from '../types';
import { formatElapsedTime, getDisplayedElapsedMs } from './AiFloatingPanel';
import { AppIcon } from './ui/AppIcon';
import { BrandLogo } from './ui/BrandLogo';
import { chromeGlass, glassActive, glassInteractive, glassPopover } from './ui/chrome';

interface ToolbarProps {
  theme: 'light' | 'dark';
  language: Language;
  t: any;
  isLoading: boolean;
  importProgress: ImportProgress;
  rawDecodeProgress: RawDecodeProgress;
  aiProgress: AiProgress;
  aiStats: {
    total: number;
  };
  onImportFiles: () => void;
  onImportFolder: () => void;
  onAiStart: () => void;
  onAiPause: () => void;
  onAiResume: () => void;
  onAiSettingsClick: () => void;
  stats: {
    total: number;
    rejected: number;
    aiReview: number;
  };
  selectionCount: number;
  peopleActive?: boolean;
  peopleCount?: number;
  onPeopleClick?: () => void;
  onDeleteRejected: () => void;
  onExportClick: () => void;
  onSettingsClick: () => void;
  isMacOS: boolean;
  isMaximized?: boolean;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}

const copy = {
  zh: {
    importFiles: '\u5bfc\u5165\u6587\u4ef6',
    importFilesDescription: '\u9009\u62e9\u5355\u5f20\u6216\u591a\u5f20\u7167\u7247',
    importFolder: '\u5bfc\u5165\u6587\u4ef6\u5939',
    importFolderDescription: '\u626b\u63cf\u4e00\u4e2a\u62cd\u6444\u76ee\u5f55',
    import: '\u5bfc\u5165',
    importProgress: '\u5bfc\u5165\u8fdb\u5ea6',
    deleteRejected: '\u786e\u8ba4\u5f03\u7528',
    export: '\u5bfc\u51fa',
    exportSelected: '\u5bfc\u51fa\u9009\u4e2d',
    noSelection: '\u6ca1\u6709\u9009\u4e2d\u7684\u7167\u7247\u53ef\u5bfc\u51fa\u3002',
    loading: '\u52a0\u8f7d\u4e2d...',
    importScan: '\u626b\u63cf',
    importMetadata: '\u8bfb\u53d6\u5143\u6570\u636e',
    importPreload: '\u51c6\u5907\u9884\u89c8',
    importDone: '\u5bfc\u5165\u5b8c\u6210',
    rawDecode: 'RAW \u9884\u89c8',
    aiCulling: 'AI \u7b5b\u56fe',
    aiStart: '\u5f00\u59cbAI\u7b5b\u56fe',
    aiPause: '\u6682\u505cAI\u7b5b\u56fe',
    aiResume: '\u7ee7\u7eedAI\u7b5b\u56fe',
    aiSettings: 'AI\u8bbe\u7f6e',
    aiReview: '\u5f85\u590d\u67e5',
    aiCurrentFile: '\u5f53\u524d\u6587\u4ef6',
    aiElapsed: '\u5f53\u524d\u7528\u65f6',
    aiRemaining: '\u9884\u4f30\u5269\u4f59',
    aiScanned: '\u5df2\u7b5b\u6570\u91cf',
    aiRunning: '\u8fd0\u884c\u4e2d',
    aiPaused: '\u5df2\u6682\u505c',
    aiReady: '\u5c31\u7eea',
    aiEngineInit: 'AI \u7f8e\u5b66\u5f15\u64ce\u542f\u52a8\u4e2d',
    aiEngineInitShort: '\u7f8e\u5b66\u5f15\u64ce',
    aiEngineInitDetail: '\u6b63\u5728\u52a0\u8f7d\u672c\u5730\u5ba1\u7f8e\u6a21\u578b\u4e0e\u7b5b\u7247\u89c4\u5219',
    aiEngineInitState: '\u542f\u52a8\u4e2d',
    aiNoEstimate: '--',
    aiProScoringPhase: '\u6574\u7406 Pro \u6a21\u578b\u5206\u6570',
    aiProScoringState: '\u6536\u5c3e\u4e2d',
    aiDuplicatePhase: '分析重复照片',
    peopleSplit: '\u4eba\u7269\u5206\u7247',
    aiWorkspace: 'AI\u9009\u7247',
  },
  en: {
    importFiles: 'Import Files',
    importFilesDescription: 'Choose one or many photos',
    importFolder: 'Import Folder',
    importFolderDescription: 'Scan a shoot directory',
    import: 'Import',
    importProgress: 'Import progress',
    deleteRejected: 'Confirm Rejects',
    export: 'Export',
    exportSelected: 'Export Selected',
    noSelection: 'No selected photos to export.',
    loading: 'Loading...',
    importScan: 'Scanning',
    importMetadata: 'Metadata',
    importPreload: 'Preview prep',
    importDone: 'Imported',
    rawDecode: 'RAW preview',
    aiCulling: 'AI Culling',
    aiStart: 'Start AI culling',
    aiPause: 'Pause AI culling',
    aiResume: 'Resume AI culling',
    aiSettings: 'AI settings',
    aiReview: 'Review',
    aiCurrentFile: 'Current file',
    aiElapsed: 'Elapsed',
    aiRemaining: 'Remaining',
    aiScanned: 'Scanned',
    aiRunning: 'Running',
    aiPaused: 'Paused',
    aiReady: 'Ready',
    aiEngineInit: 'Starting AI aesthetic engine',
    aiEngineInitShort: 'Aesthetic engine',
    aiEngineInitDetail: 'Loading local aesthetic model and culling rules',
    aiEngineInitState: 'Starting',
    aiNoEstimate: '--',
    aiProScoringPhase: 'Finalizing Pro model scores',
    aiProScoringState: 'Finishing',
    aiDuplicatePhase: 'Analyzing duplicates',
    peopleSplit: 'People Split',
    aiWorkspace: 'AI Cull',
  },
};

export const Toolbar: React.FC<ToolbarProps> = ({
  theme,
  language,
  t,
  isLoading,
  importProgress,
  rawDecodeProgress,
  aiProgress,
  aiStats,
  onImportFiles,
  onImportFolder,
  onAiStart,
  onAiPause,
  onAiResume,
  onAiSettingsClick,
  stats,
  selectionCount,
  peopleActive = false,
  peopleCount = 0,
  onPeopleClick,
  onDeleteRejected,
  onExportClick,
  onSettingsClick,
  isMacOS,
  isMaximized = false,
  onMinimize,
  onMaximize,
  onClose,
}) => {
  const text = copy[language];
  const [importOpen, setImportOpen] = useState(false);
  const [aiProgressHover, setAiProgressHover] = useState(false);
  const [timeNow, setTimeNow] = useState(() => Date.now());
  const importMenuRef = useRef<HTMLDivElement>(null);
  const activeProgress = importProgress.running || importProgress.phase === 'done'
    ? buildImportProgressLabel(importProgress, text)
    : rawDecodeProgress.running
      ? buildRawProgressLabel(rawDecodeProgress, text)
      : null;
  const aiTotal = aiProgress.total || aiStats.total;
  const aiPercent = aiProgress.total > 0
    ? Math.min(100, Math.round((aiProgress.processed / aiProgress.total) * 100))
    : 0;
  const aiEngineInitializing = aiProgress.running && aiProgress.phase === 'AI_ENGINE_INIT';
  const aiProScoring = aiProgress.running && aiProgress.phase === 'PRO_MODEL_SCORING';
  const aiDisplayPercent = aiEngineInitializing
    ? 16
    : aiProScoring
    ? 98
    : aiTotal > 0 ? Math.max(3, aiPercent) : 0;
  const aiAction = aiProgress.running
    ? aiProgress.paused
      ? { icon: Play, label: text.aiResume, onClick: onAiResume }
      : { icon: Pause, label: text.aiPause, onClick: onAiPause }
    : { icon: Play, label: text.aiStart, onClick: onAiStart };
  const aiElapsedMs = getDisplayedElapsedMs(aiProgress, timeNow);
  const aiRemainingMs = estimateRemainingMs(aiElapsedMs, aiProgress.processed, aiTotal);
  const showAiProgressPanel = aiProgressHover || aiProgress.running;
  const aiControlButtonClass = theme === 'dark'
    ? 'text-zinc-200 hover:bg-white/[0.06] hover:text-white'
    : 'text-slate-700 hover:bg-white/[0.50] hover:text-slate-950';
  const maximizeTitle = isMaximized ? t.window.restore : t.window.maximize;
  const peopleToggleLabel = peopleActive ? text.aiWorkspace : text.peopleSplit;
  const peopleToggleIcon = peopleActive ? Activity : UsersRound;

  useEffect(() => {
    if (!importOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!importMenuRef.current?.contains(event.target as Node)) {
        setImportOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImportOpen(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [importOpen]);

  useEffect(() => {
    if (!aiProgress.running || aiProgress.paused) return;
    setTimeNow(Date.now());
    const timer = window.setInterval(() => setTimeNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [aiProgress.paused, aiProgress.running]);

  return (
    <nav
      className={`relative z-20 flex min-h-[48px] items-center justify-between gap-2 border-b px-2.5 [--filmstrip-width:176px] [--inspector-width:268px] xl:[--filmstrip-width:188px] xl:[--inspector-width:288px] ${
        theme === 'dark'
          ? chromeGlass.dark
          : chromeGlass.light
      }`}
      data-tauri-drag-region
    >
      <div className="flex min-w-0 items-center gap-2" data-tauri-drag-region="false" style={{ WebkitAppRegion: 'no-drag' } as any}>
        {isMacOS && (
          <div className="hidden items-center gap-2 pl-1 md:flex">
            <MacWindowDot color="bg-[#ff5f57]" onClick={onClose} title={t.window.close} />
            <MacWindowDot color="bg-[#ffbd2e]" onClick={onMinimize} title={t.window.minimize} />
            <MacWindowDot color="bg-[#28c840]" onClick={onMaximize} title={maximizeTitle} />
          </div>
        )}

        <BrandLogo
          className="shrink-0"
          markClassName="h-6 w-6"
          nameClassName={theme === 'dark' ? 'text-zinc-100' : 'text-gray-900'}
        />

        <div ref={importMenuRef} className="relative">
          <button
            type="button"
            disabled={isLoading}
            onClick={() => setImportOpen(open => !open)}
            className={`flex h-8 items-center gap-2 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:opacity-35 disabled:pointer-events-none ${
              importOpen
                ? theme === 'dark'
                  ? glassActive.dark
                  : glassActive.light
                : theme === 'dark'
                  ? glassInteractive.dark
                  : glassInteractive.light
            }`}
            aria-haspopup="menu"
            aria-expanded={importOpen}
          >
            <AppIcon icon={FilePlus2} className="h-4 w-4" />
            <span>{isLoading ? text.loading : text.import}</span>
            <AppIcon icon={ChevronDown} className="h-3.5 w-3.5 opacity-55" />
          </button>

          {importOpen && (
            <div className={`absolute left-0 top-[calc(100%+8px)] z-50 w-[268px] overflow-hidden rounded-lg border py-1 ${
              theme === 'dark'
                ? glassPopover.dark
                : glassPopover.light
            }`}>
              <ImportMenuItem
                icon={FilePlus2}
                label={text.importFiles}
                description={text.importFilesDescription}
                theme={theme}
                onClick={() => {
                  setImportOpen(false);
                  onImportFiles();
                }}
              />
              <ImportMenuItem
                icon={FolderOpen}
                label={text.importFolder}
                description={text.importFolderDescription}
                theme={theme}
                onClick={() => {
                  setImportOpen(false);
                  onImportFolder();
                }}
              />
              {activeProgress && (
                <ImportMenuProgress
                  theme={theme}
                  title={text.importProgress}
                  label={activeProgress.label}
                  detail={activeProgress.detail}
                  percent={activeProgress.percent}
                />
              )}
            </div>
          )}
        </div>

        <button
          onClick={onPeopleClick}
          disabled={!onPeopleClick}
          className={`hidden h-8 items-center gap-2 rounded-lg px-2.5 text-[12px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-35 lg:flex ${
            peopleActive
              ? theme === 'dark'
                ? glassActive.dark
                : glassActive.light
              : theme === 'dark'
                ? glassInteractive.dark
                : glassInteractive.light
          }`}
          title={peopleToggleLabel}
        >
          <AppIcon icon={peopleToggleIcon} className="h-4 w-4" />
          <span>{peopleToggleLabel}</span>
          {!peopleActive && peopleCount > 0 && (
            <span className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
              theme === 'dark' ? 'bg-white/[0.08] text-zinc-100' : 'bg-white/72 text-slate-800'
            }`}>{peopleCount}</span>
          )}
        </button>
      </div>

      {activeProgress && (
        <div className="absolute left-[calc(var(--filmstrip-width)+210px)] top-1/2 hidden -translate-y-1/2 2xl:block">
          <ToolbarProgress
            theme={theme}
            label={activeProgress.label}
            detail={activeProgress.detail}
            percent={activeProgress.percent}
          />
        </div>
      )}

      <div className="pointer-events-none absolute inset-y-0 left-[var(--filmstrip-width)] right-[var(--inspector-width)] hidden items-center justify-center lg:flex">
        <div
          className={`pointer-events-auto relative flex h-8 w-[min(430px,calc(100%-24px))] min-w-[280px] items-center gap-2 rounded-xl px-2 ${
            theme === 'dark'
              ? 'bg-white/[0.025] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]'
              : 'bg-white/[0.34] shadow-[inset_0_1px_0_rgba(255,255,255,0.62)]'
          }`}
          data-tauri-drag-region="false"
          style={{ WebkitAppRegion: 'no-drag' } as any}
          onMouseEnter={() => setAiProgressHover(true)}
          onMouseLeave={() => setAiProgressHover(false)}
        >
          <button
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all disabled:cursor-not-allowed disabled:opacity-35 ${aiControlButtonClass}`}
            disabled={aiStats.total === 0}
            onClick={aiAction.onClick}
            title={aiAction.label}
          >
            <AppIcon icon={aiAction.icon} className="h-[15px] w-[15px]" />
          </button>

          <div className="relative flex min-w-0 flex-1 items-center gap-2">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              aiEngineInitializing
                ? 'bg-cyan-200 shadow-[0_0_10px_rgba(103,232,249,0.72)]'
                : aiProgress.running && !aiProgress.paused
                  ? 'bg-sky-300 shadow-[0_0_8px_rgba(125,211,252,0.55)]'
                  : theme === 'dark' ? 'bg-zinc-600' : 'bg-slate-400'
            }`} />
            <span className={`shrink-0 truncate text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-700'}`}>
              {aiEngineInitializing ? text.aiEngineInit : text.aiCulling}
            </span>
            {aiEngineInitializing && (
              <span
                className={`hidden shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold lg:flex ${
                  theme === 'dark'
                    ? 'bg-cyan-300/[0.10] text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_18px_rgba(34,211,238,0.10)]'
                    : 'bg-cyan-50/80 text-cyan-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.86)]'
                }`}
              >
                <AiEngineNodes />
                {text.aiEngineInitShort}
              </span>
            )}
            <div className={`h-1 min-w-0 flex-1 overflow-hidden rounded-full ${theme === 'dark' ? 'bg-black/32' : 'bg-slate-300/58'}`}>
              <div
                className={`relative h-full overflow-hidden rounded-full transition-[width] duration-300 ${
                  aiEngineInitializing ? 'ai-engine-scan bg-cyan-300' : 'bg-sky-400'
                } ${
                  aiProgress.running && !aiProgress.paused ? 'ai-progress-sheen' : ''
                }`}
                style={{ width: `${aiDisplayPercent}%` }}
              />
            </div>
            <span className={`shrink-0 text-[11px] font-medium tabular-nums ${
              aiEngineInitializing
                ? theme === 'dark' ? 'text-cyan-100' : 'text-cyan-700'
                : theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'
            }`}>
              {aiEngineInitializing ? text.aiEngineInitState : aiProScoring ? text.aiProScoringState : `${Math.min(aiProgress.processed, aiTotal)} / ${aiTotal}`}
            </span>
            <AiProgressPopover
              theme={theme}
              text={text}
              progress={aiProgress}
              total={aiTotal}
              percent={aiPercent}
              reviewCount={stats.aiReview}
              elapsedMs={aiElapsedMs}
              remainingMs={aiRemainingMs}
              open={showAiProgressPanel}
            />
          </div>

          <div className={`h-5 w-px shrink-0 ${theme === 'dark' ? 'bg-white/[0.06]' : 'bg-slate-400/24'}`} />
          <button
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-medium transition-colors ${
              theme === 'dark'
                ? glassInteractive.dark
                : glassInteractive.light
            }`}
            onClick={onAiSettingsClick}
            title={text.aiSettings}
          >
            <AppIcon icon={SlidersHorizontal} className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2" data-tauri-drag-region="false" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <button
          onClick={onDeleteRejected}
          disabled={stats.rejected === 0}
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold transition-all disabled:opacity-30 disabled:pointer-events-none ${
            theme === 'dark'
              ? 'text-rose-200 hover:bg-white/[0.06] hover:text-rose-100'
              : 'text-rose-800 hover:bg-white/[0.56] hover:text-rose-900'
          }`}
          title={`${text.deleteRejected} ${stats.rejected}`}
        >
          <span className={`flex h-6 w-6 items-center justify-center rounded-md ${
            theme === 'dark'
              ? 'bg-rose-400/[0.10] text-rose-300'
              : 'bg-rose-100/80 text-rose-700'
          }`}>
            <AppIcon icon={Trash2} className="h-4 w-4" />
          </span>
          <span className="hidden xl:inline">{text.deleteRejected}</span>
          <span className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
            theme === 'dark' ? 'bg-white/[0.08] text-zinc-100' : 'bg-white/72 text-slate-800'
          }`}>{stats.rejected}</span>
        </button>

        <button
          onClick={onExportClick}
          disabled={selectionCount === 0}
          className={`flex h-8 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-all disabled:opacity-35 disabled:pointer-events-none ${
            theme === 'dark'
              ? 'bg-white/[0.065] text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.055)] hover:bg-white/[0.10] hover:text-white'
              : 'bg-white/64 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.76)] hover:bg-white/80 hover:text-slate-950'
          }`}
          title={text.exportSelected}
        >
          <AppIcon icon={FileUp} className={`h-[17px] w-[17px] ${theme === 'dark' ? 'text-sky-200' : 'text-sky-700'}`} />
          <span>{text.export}</span>
        </button>

        <button
          onClick={onSettingsClick}
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
            theme === 'dark'
              ? glassInteractive.dark
              : glassInteractive.light
          }`}
          title={t.settings.title}
        >
          <AppIcon icon={Settings} className="h-[18px] w-[18px]" />
        </button>

        {!isMacOS && (
          <div className={`ml-2.5 hidden items-center gap-1.5 border-l pl-3 md:flex ${theme === 'dark' ? 'border-zinc-800' : 'border-slate-400/40'}`}>
            <WindowButton icon={Minus} title={t.window.minimize} onClick={onMinimize} theme={theme} />
            <WindowButton icon={isMaximized ? AppWindow : Maximize2} title={maximizeTitle} onClick={onMaximize} theme={theme} />
            <WindowButton icon={X} title={t.window.close} onClick={onClose} theme={theme} danger />
          </div>
        )}
      </div>
    </nav>
  );
};

function buildImportProgressLabel(importProgress: ImportProgress, text: typeof copy.zh) {
  const phaseLabel = importProgress.phase === 'metadata'
    ? text.importMetadata
    : importProgress.phase === 'preload'
      ? text.importPreload
    : importProgress.phase === 'done'
      ? text.importDone
      : text.importScan;
  const percent = importProgress.total > 0
    ? Math.min(100, Math.round((importProgress.processed / importProgress.total) * 100))
    : 0;

  return {
    label: phaseLabel,
    detail: importProgress.total > 0
      ? `${importProgress.processed}/${importProgress.total}`
      : importProgress.current || '',
    percent,
  };
}

function buildRawProgressLabel(rawProgress: RawDecodeProgress, text: typeof copy.zh) {
  const total = rawProgress.total || rawProgress.processed + rawProgress.queued + rawProgress.active;
  const percent = total > 0
    ? Math.min(100, Math.round((rawProgress.processed / total) * 100))
    : 0;

  return {
    label: text.rawDecode,
    detail: rawProgress.current || `${rawProgress.processed}/${total}`,
    percent,
  };
}

function estimateRemainingMs(elapsedMs: number, processed: number, total: number) {
  if (processed <= 0 || total <= processed || elapsedMs < 1000) return null;
  return Math.max(0, Math.round((elapsedMs / processed) * (total - processed)));
}

const AiProgressPopover = ({
  theme,
  text,
  progress,
  total,
  percent,
  reviewCount,
  elapsedMs,
  remainingMs,
  open,
}: {
  theme: 'light' | 'dark';
  text: typeof copy.zh;
  progress: AiProgress;
  total: number;
  percent: number;
  reviewCount: number;
  elapsedMs: number;
  remainingMs: number | null;
  open: boolean;
}) => {
  const processed = Math.min(progress.processed, total);
  const engineInitializing = progress.phase === 'AI_ENGINE_INIT';
  const proScoring = progress.phase === 'PRO_MODEL_SCORING';
  const activeFile = engineInitializing
    ? text.aiEngineInitDetail
    : proScoring
    ? text.aiProScoringPhase
    : progress.phase === 'DUPLICATE_GROUPING'
    ? text.aiDuplicatePhase
    : progress.activeId || text.aiReady;
  const stateLabel = progress.running
    ? progress.paused
      ? text.aiPaused
      : engineInitializing ? text.aiEngineInitState : proScoring ? text.aiProScoringState : text.aiRunning
    : text.aiReady;
  const displayPercent = engineInitializing ? 16 : proScoring ? 98 : total > 0 ? Math.max(3, percent) : 0;

  return (
    <div
      className={`absolute left-1/2 top-[calc(100%+18px)] z-40 w-[392px] -translate-x-1/2 overflow-hidden rounded-lg border px-3 py-2.5 transition-all duration-200 ease-out motion-reduce:transition-opacity ${
        open
          ? 'pointer-events-auto translate-y-0 scale-100 opacity-100'
          : 'pointer-events-none -translate-y-2 scale-[0.98] opacity-0'
      } ${
        theme === 'dark'
          ? glassPopover.dark
          : glassPopover.light
      }`}
      aria-hidden={!open}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
            engineInitializing
              ? 'bg-cyan-200 text-zinc-950 shadow-[0_0_22px_rgba(103,232,249,0.26)]'
              : progress.running && !progress.paused
                ? 'bg-sky-300 text-zinc-950'
                : theme === 'dark'
                  ? 'bg-white/[0.08] text-zinc-300'
                  : 'bg-white/70 text-slate-700'
          }`}>
            {progress.running && !progress.paused && (
              <span className="absolute h-6 w-6 rounded-full border border-sky-200/80 ai-running-orbit" />
            )}
            <AppIcon icon={progress.running ? (progress.paused ? Clock3 : Activity) : Circle} className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className={`truncate text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-950'}`}>
              {engineInitializing ? text.aiEngineInit : text.aiCulling}
            </div>
            <div className={`truncate text-[11px] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`} title={activeFile}>
              {text.aiCurrentFile}: {activeFile}
            </div>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${
          engineInitializing
            ? theme === 'dark' ? 'bg-cyan-300/16 text-cyan-100' : 'bg-cyan-100 text-cyan-800'
            : progress.running && !progress.paused
              ? theme === 'dark' ? 'bg-sky-300/16 text-sky-100' : 'bg-sky-100 text-sky-800'
              : theme === 'dark' ? 'bg-white/[0.06] text-zinc-300' : 'bg-white/62 text-slate-700'
        }`}>
          {stateLabel}
        </span>
      </div>

      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        <AiProgressMetric theme={theme} label={text.aiScanned} value={`${processed}/${total}`} />
        <AiProgressMetric theme={theme} label={text.aiReview} value={String(reviewCount)} />
        <AiProgressMetric theme={theme} label={text.aiElapsed} value={formatElapsedTime(elapsedMs)} />
        <AiProgressMetric theme={theme} label={text.aiRemaining} value={remainingMs === null ? text.aiNoEstimate : formatElapsedTime(remainingMs)} />
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <div className={`h-1.5 min-w-0 flex-1 overflow-hidden rounded-full ${theme === 'dark' ? 'bg-black/36' : 'bg-slate-400/24'}`}>
          <div
            className={`relative h-full overflow-hidden rounded-full transition-[width] duration-300 ${
              engineInitializing ? 'ai-engine-scan bg-cyan-300' : 'bg-sky-400'
            } ${
              progress.running && !progress.paused ? 'ai-progress-sheen' : ''
            }`}
            style={{ width: `${displayPercent}%` }}
          />
        </div>
        <span className={`w-11 text-right text-[11px] font-medium tabular-nums ${
          engineInitializing
            ? theme === 'dark' ? 'text-cyan-100' : 'text-cyan-700'
            : theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'
        }`}>
          {engineInitializing ? text.aiEngineInitState : proScoring ? text.aiProScoringState : `${percent}%`}
        </span>
      </div>
    </div>
  );
};

const AiEngineNodes = () => (
  <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
    <span className="ai-engine-node h-1.5 w-[2px] rounded-full bg-current opacity-70" />
    <span className="ai-engine-node h-2.5 w-[2px] rounded-full bg-current opacity-70" />
    <span className="ai-engine-node h-2 w-[2px] rounded-full bg-current opacity-70" />
  </span>
);

const AiProgressMetric = ({
  theme,
  label,
  value,
}: {
  theme: 'light' | 'dark';
  label: string;
  value: string;
}) => (
  <div className={`min-w-0 rounded-md px-2 py-1.5 ${
    theme === 'dark'
      ? 'bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
      : 'bg-white/46 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]'
  }`}>
    <div className={`truncate text-[11px] font-medium ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>{label}</div>
    <div className={`mt-0.5 truncate text-[12px] font-semibold tabular-nums ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-950'}`}>{value}</div>
  </div>
);

const ToolbarProgress = ({
  theme,
  label,
  detail,
  percent,
}: {
  theme: 'light' | 'dark';
  label: string;
  detail: string;
  percent: number;
}) => (
  <div
    className={`flex w-[152px] items-center gap-2 rounded-lg px-2.5 py-1.5 ${
    theme === 'dark'
      ? 'bg-white/[0.04] text-zinc-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
      : 'bg-slate-100/[0.58] text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.74),inset_0_-1px_0_rgba(15,23,42,0.05)]'
  }`}
    title={detail}
  >
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-2">
        <span className={`truncate text-[11px] font-medium ${theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}`}>
          {label}
        </span>
        <span className={`font-mono text-[11px] font-medium ${theme === 'dark' ? 'text-sky-200' : 'text-sky-700'}`}>
          {percent}%
        </span>
      </div>
      <div className={`mt-1 h-1 overflow-hidden rounded-full ${theme === 'dark' ? 'bg-black/28' : 'bg-slate-300/55'}`}>
        <div
          className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
          style={{ width: `${Math.max(3, percent)}%` }}
        />
      </div>
    </div>
  </div>
);

const MacWindowDot = ({ color, title, onClick }: { color: string; title: string; onClick: () => void }) => (
  <button
    className={`h-3 w-3 rounded-full ${color} shadow-[inset_0_-1px_0_rgba(0,0,0,0.24)]`}
    onClick={onClick}
    title={title}
  />
);

const WindowButton = ({
  icon,
  title,
  onClick,
  theme,
  danger,
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  theme: 'light' | 'dark';
  danger?: boolean;
}) => (
  <button
    onClick={onClick}
    className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
      danger
        ? `hover:bg-red-600 hover:text-white ${theme === 'dark' ? 'text-zinc-400' : 'text-gray-500'}`
        : theme === 'dark' ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100' : 'text-slate-500 hover:bg-white/56 hover:text-slate-900'
    }`}
    title={title}
  >
    <AppIcon icon={icon} className="h-4 w-4" />
  </button>
);

const ImportMenuItem = ({
  icon,
  label,
  description,
  theme,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  theme: 'light' | 'dark';
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
      theme === 'dark'
        ? 'text-zinc-100 hover:bg-white/[0.055]'
        : 'text-slate-900 hover:bg-white/58'
    }`}
  >
    <AppIcon icon={icon} className={`h-4 w-4 shrink-0 ${
      theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'
    }`} />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] font-semibold leading-5">{label}</span>
      <span className={`block truncate text-[12px] leading-4 ${
        theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'
      }`}>
        {description}
      </span>
    </span>
  </button>
);

const ImportMenuProgress = ({
  theme,
  title,
  label,
  detail,
  percent,
}: {
  theme: 'light' | 'dark';
  title: string;
  label: string;
  detail: string;
  percent: number;
}) => (
  <div className={`mx-2 mt-1.5 border-t px-1 py-2 ${
    theme === 'dark'
      ? 'border-white/[0.06]'
      : 'border-slate-400/24'
  }`}>
    <div className={`flex items-center justify-between gap-2 text-[11px] ${
      theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'
    }`}>
      <span>{title}</span>
      <span className="font-mono tabular-nums">{percent}%</span>
    </div>
    <div className={`mt-1.5 flex items-center justify-between gap-3 text-[12px] ${
      theme === 'dark' ? 'text-zinc-100' : 'text-slate-900'
    }`}>
      <span className="truncate font-medium">{label}</span>
      <span className={`shrink-0 font-mono tabular-nums ${
        theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'
      }`}>
        {detail}
      </span>
    </div>
    <div className={`mt-2 h-1.5 overflow-hidden rounded-full ${
      theme === 'dark' ? 'bg-black/32' : 'bg-slate-300/56'
    }`}>
      <div
        className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
        style={{ width: `${Math.max(3, percent)}%` }}
      />
    </div>
  </div>
);
