import React from 'react';
import {
  Check,
  FilePlus2,
  FolderOpen,
  Image,
  PanelRight,
  ScanLine,
} from 'lucide-react';
import { Language } from '../i18n';
import { ImportProgress, PhotoFilter } from '../types';
import { AppIcon } from './ui/AppIcon';
import { BrandLogo } from './ui/BrandLogo';
import { glassInteractive, glassSurface, photoOverlay } from './ui/chrome';

interface EmptyStateProps {
  theme: 'light' | 'dark';
  t: any;
  language: Language;
  filter: PhotoFilter;
  hasPhotos: boolean;
  onImportFiles: () => void;
  onImportFolder: () => void;
  importProgress?: ImportProgress;
  initialImportActive?: boolean;
}

const IDLE_IMPORT_PROGRESS: ImportProgress = {
  phase: 'idle',
  total: 0,
  processed: 0,
  running: false,
};

const copy = {
  zh: {
    title: '准备导入照片',
    description: '选择文件或文件夹。FrameCull AI 会先完成本地扫描、RAW/JPG 匹配和首屏预览准备，再进入选图界面。',
    importFiles: '导入文件',
    importFilesHint: '选择单张或多张照片',
    importFolder: '导入文件夹',
    importFolderHint: '扫描一个拍摄目录',
    progressTitle: '导入工作台',
    progressIdle: '等待照片进入队列',
    scan: '扫描文件',
    pair: '匹配 RAW/JPG',
    metadata: '读取元数据',
    preload: '准备预览',
    done: '准备完成',
    currentFile: '当前文件',
    filteredAction: '继续导入',
    aiReviewTitle: '暂无 AI 待复查照片',
    aiReviewDescription: 'AI 还没有标记复查线索，或当前线索已经完成了人工复查。',
    aiNormalTitle: '暂无 AI 正常照片',
    aiNormalDescription: '先运行 AI 筛图，或放宽当前星级筛选条件。',
    aiPickedTitle: '暂无 AI 精选照片',
    aiPickedDescription: '先运行 AI 筛图。重复照片只会收录奖杯推荐的单张，有复查问题的照片不会进入这里。',
    duplicateTitle: '暂无重复照片',
    duplicateDescription: 'AI 筛图完成后会生成重复组。若没有结果，说明当前敏感度下未发现可合并比较的重复照片。',
    groupPhotoTitle: '当前没有合照',
    groupPhotoDescription: '这批照片里暂时没有识别到稳定的合照。可以试试导入更多照片，或先运行 AI 筛图后再查看。',
  },
  en: {
    title: 'Ready to import photos',
    description: 'Choose files or a folder. FrameCull AI finishes local scanning, RAW/JPG pairing, and first-screen preview prep before opening the review workspace.',
    importFiles: 'Import Files',
    importFilesHint: 'Choose one or many photos',
    importFolder: 'Import Folder',
    importFolderHint: 'Scan a shoot directory',
    progressTitle: 'Import workbench',
    progressIdle: 'Waiting for photos',
    scan: 'Scan files',
    pair: 'Pair RAW/JPG',
    metadata: 'Read metadata',
    preload: 'Prepare previews',
    done: 'Ready',
    currentFile: 'Current file',
    filteredAction: 'Import more',
    aiReviewTitle: 'No AI review photos',
    aiReviewDescription: 'AI has not flagged review evidence yet, or every flagged photo has already been reviewed.',
    aiNormalTitle: 'No AI clear photos',
    aiNormalDescription: 'Run AI culling first, or loosen the current star rating filter.',
    aiPickedTitle: 'No AI picks yet',
    aiPickedDescription: 'Run AI culling first. Duplicate groups only include the trophy best frame, and photos with review issues stay out of this view.',
    duplicateTitle: 'No duplicate photos',
    duplicateDescription: 'Duplicate groups appear after AI culling completes. If this stays empty, no repeat candidates matched the current sensitivity.',
    groupPhotoTitle: 'No group portraits here',
    groupPhotoDescription: 'This batch does not have a stable group portrait match yet. Try importing more photos, or run AI culling before checking again.',
  },
};

export const EmptyState: React.FC<EmptyStateProps> = ({
  theme,
  t,
  language,
  filter,
  hasPhotos,
  onImportFiles,
  onImportFolder,
  importProgress = IDLE_IMPORT_PROGRESS,
  initialImportActive = false,
}) => {
  const text = copy[language];
  const isDark = theme === 'dark';
  const showImportProgress = initialImportActive && importProgress.phase !== 'idle';

  if (!hasPhotos) {
    return (
      <div className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden px-4 py-5 sm:px-6 ${
        isDark
          ? 'bg-[radial-gradient(circle_at_50%_50%,rgba(72,84,103,0.12),transparent_34%),linear-gradient(135deg,#18191d_0%,#101115_56%,#16171b_100%)]'
          : 'bg-[radial-gradient(circle_at_50%_48%,rgba(148,163,184,0.30),transparent_36%),linear-gradient(135deg,#eef2f7_0%,#dfe5ed_100%)]'
        }`}>
        <div className={`relative z-10 w-full ${showImportProgress ? 'max-w-[560px]' : 'max-w-[820px]'}`}>
          {showImportProgress ? (
            <ImportProgressPanel theme={theme} language={language} progress={importProgress} />
          ) : (
            <section className="relative min-h-[500px] overflow-hidden">
              <div className={`pointer-events-none absolute inset-0 ${
                isDark
                  ? 'bg-[radial-gradient(circle_at_50%_45%,rgba(56,189,248,0.08),transparent_30%)]'
                  : 'bg-[radial-gradient(circle_at_50%_43%,rgba(14,165,233,0.14),transparent_32%)]'
              }`} />
              <div className="relative flex min-h-[500px] flex-col items-center justify-center px-6 py-14 text-center">
                <BrandLogo
                  className="mb-5 justify-center"
                  markClassName="h-12 w-12 rounded-xl shadow-[0_0_30px_rgba(56,189,248,0.14)]"
                  nameClassName={isDark ? 'text-zinc-100 text-[14px]' : 'text-slate-950 text-[14px]'}
                />
                <h2 className={`text-[24px] font-semibold leading-tight sm:text-[28px] ${
                  isDark ? 'text-zinc-50' : 'text-slate-950'
                }`}>
                  {text.title}
                </h2>
                <p className={`mt-2 max-w-[610px] text-[13px] leading-6 ${
                  isDark ? 'text-zinc-400' : 'text-slate-600'
                }`}>
                  {text.description}
                </p>
                <div className="mt-10 flex w-full max-w-[520px] flex-col gap-2 sm:flex-row">
                  <WorkbenchImportButton
                    theme={theme}
                    icon={FilePlus2}
                    label={text.importFiles}
                    hint={text.importFilesHint}
                    disabled={showImportProgress}
                    onClick={onImportFiles}
                  />
                  <WorkbenchImportButton
                    theme={theme}
                    icon={FolderOpen}
                    label={text.importFolder}
                    hint={text.importFolderHint}
                    disabled={showImportProgress}
                    onClick={onImportFolder}
                  />
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    );
  }

  const filtered = getFilteredCopy(filter, t, text);

  return (
    <div className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden px-6 py-8 text-center ${
      isDark
        ? 'bg-[radial-gradient(circle_at_50%_48%,rgba(72,84,103,0.12),transparent_34%),linear-gradient(135deg,#18191d_0%,#101115_56%,#16171b_100%)]'
        : 'bg-[radial-gradient(circle_at_50%_48%,rgba(148,163,184,0.28),transparent_36%),linear-gradient(135deg,#eef2f7_0%,#dfe5ed_100%)]'
    }`}>
      <WorkspaceBackdrop theme={theme} subtle />
      <div className={`relative z-10 w-full max-w-[470px] rounded-[16px] border px-5 py-5 ${
        isDark ? glassSurface.dark : glassSurface.light
      }`}>
        <div className={`mx-auto flex h-11 w-11 items-center justify-center rounded-xl ${
          isDark ? 'bg-white/[0.06] text-zinc-300' : 'bg-white/64 text-slate-600'
        }`}>
          <AppIcon icon={Image} className="h-5 w-5" />
        </div>
        <h2 className={`mt-4 text-[18px] font-semibold ${isDark ? 'text-zinc-50' : 'text-slate-950'}`}>
          {filtered.title}
        </h2>
        <p className={`mx-auto mt-2 max-w-[360px] text-[13px] leading-6 ${
          isDark ? 'text-zinc-400' : 'text-slate-600'
        }`}>
          {filtered.description}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onImportFiles}
            className={`flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-colors ${
              isDark
                ? 'bg-sky-300 text-zinc-950 hover:bg-sky-200'
                : 'bg-sky-600 text-white hover:bg-sky-500'
            }`}
          >
            <AppIcon icon={FilePlus2} className="h-4 w-4" />
            <span>{text.filteredAction}</span>
          </button>
          <button
            type="button"
            onClick={onImportFolder}
            className={`flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-medium transition-colors ${
              isDark ? glassInteractive.dark : glassInteractive.light
            }`}
          >
            <AppIcon icon={FolderOpen} className="h-4 w-4" />
            <span>{text.importFolder}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

function getFilteredCopy(filter: PhotoFilter, t: any, text: typeof copy.zh) {
  if (filter === 'PICKED') return t.emptyState.picked;
  if (filter === 'REJECTED') return t.emptyState.rejected;
  if (filter === 'UNMARKED') return t.emptyState.unmarked;
  if (filter === 'ORPHANS') return t.emptyState.orphans;
  if (filter === 'AI_REVIEW') {
    return {
      title: text.aiReviewTitle,
      description: text.aiReviewDescription,
    };
  }
  if (filter === 'AI_NORMAL') {
    return {
      title: text.aiNormalTitle,
      description: text.aiNormalDescription,
    };
  }
  if (filter === 'AI_PICKED') {
    return {
      title: text.aiPickedTitle,
      description: text.aiPickedDescription,
    };
  }
  if (filter === 'DUPLICATES') {
    return {
      title: text.duplicateTitle,
      description: text.duplicateDescription,
    };
  }
  if (filter === 'GROUP_PHOTO') {
    return {
      title: text.groupPhotoTitle,
      description: text.groupPhotoDescription,
    };
  }
  return t.emptyState.all;
}

const WorkspaceBackdrop = ({ theme, subtle = false }: { theme: 'light' | 'dark'; subtle?: boolean }) => {
  const isDark = theme === 'dark';
  return (
    <div className={`pointer-events-none absolute inset-0 ${subtle ? 'opacity-35' : 'opacity-70'}`} aria-hidden="true">
      <div className={`absolute left-4 top-4 hidden h-[calc(100%-32px)] w-[172px] rounded-2xl border xl:block ${
        isDark ? 'border-white/[0.035] bg-black/10' : 'border-white/70 bg-white/24'
      }`}>
        <div className={`h-10 border-b ${isDark ? 'border-white/[0.035]' : 'border-white/70'}`} />
        <div className="space-y-2 p-3">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className={`h-16 rounded-lg ${isDark ? 'bg-white/[0.035]' : 'bg-white/54'}`} />
          ))}
        </div>
      </div>
      <div className={`absolute right-4 top-4 hidden h-[calc(100%-32px)] w-[262px] rounded-2xl border xl:block ${
        isDark ? 'border-white/[0.035] bg-black/10' : 'border-white/70 bg-white/24'
      }`}>
        <div className={`flex h-10 items-center gap-2 border-b px-4 ${isDark ? 'border-white/[0.035]' : 'border-white/70'}`}>
          <AppIcon icon={PanelRight} className={`h-4 w-4 ${isDark ? 'text-zinc-700' : 'text-slate-400'}`} />
          <span className={`h-2 w-24 rounded-full ${isDark ? 'bg-white/[0.04]' : 'bg-slate-300/60'}`} />
        </div>
        <div className="space-y-3 p-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className={`h-7 rounded-lg ${isDark ? 'bg-white/[0.035]' : 'bg-white/52'}`} />
          ))}
        </div>
      </div>
      <div className={`absolute left-1/2 top-1/2 h-[56vh] w-[48vw] -translate-x-1/2 -translate-y-1/2 rounded-[32px] border ${
        isDark ? 'border-white/[0.025]' : 'border-white/50'
      }`} />
    </div>
  );
};

const WorkbenchImportButton = ({
  theme,
  icon,
  label,
  hint,
  onClick,
  disabled = false,
}: {
  theme: 'light' | 'dark';
  icon: typeof FilePlus2;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) => {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`group flex min-h-[64px] flex-1 items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-sky-300/50 disabled:pointer-events-none disabled:opacity-45 ${
        isDark
          ? 'border-white/[0.07] bg-white/[0.052] text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] hover:border-sky-200/20 hover:bg-white/[0.078]'
          : 'border-white/70 bg-white/68 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] hover:bg-white/90'
      }`}
    >
      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center ${
        isDark ? 'text-sky-100' : 'text-sky-700'
      }`}>
        <AppIcon
          icon={icon}
          className={`h-[21px] w-[21px] ${
            isDark
              ? 'drop-shadow-[0_0_9px_rgba(125,211,252,0.48)]'
              : 'drop-shadow-[0_0_7px_rgba(2,132,199,0.28)]'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold">{label}</span>
        <span className={`mt-1 block text-[12px] leading-5 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
          {hint}
        </span>
      </span>
    </button>
  );
};

const ImportProgressPanel = ({
  theme,
  language,
  progress,
}: {
  theme: 'light' | 'dark';
  language: Language;
  progress: ImportProgress;
}) => {
  const isDark = theme === 'dark';
  const text = copy[language];
  const percent = progress.total > 0
    ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
    : progress.phase === 'done'
      ? 100
      : 0;

  return (
    <aside className={`relative overflow-hidden rounded-lg border px-4 py-3.5 ${
      isDark ? photoOverlay.dark : photoOverlay.light
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-[13px] font-semibold ${isDark ? 'text-zinc-100' : 'text-slate-950'}`}>
            {text.progressTitle}
          </div>
          <div className={`mt-0.5 truncate text-[12px] ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
            {progress.current ? `${text.currentFile}: ${progress.current}` : text.progressIdle}
          </div>
        </div>
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
          progress.phase === 'done'
            ? isDark ? 'bg-emerald-300/12 text-emerald-200' : 'bg-emerald-100 text-emerald-700'
            : isDark ? 'bg-sky-300/12 text-sky-200' : 'bg-sky-100 text-sky-700'
        }`}>
          <AppIcon icon={progress.phase === 'done' ? Check : ScanLine} className="h-4 w-4" />
        </span>
      </div>

      <div className="mt-4">
        <div className="relative px-1">
          <div className={`pointer-events-none absolute left-[12.5%] right-[12.5%] top-[7px] h-[2px] rounded-full ${
            isDark ? 'bg-white/[0.13]' : 'bg-slate-300/95'
          }`}>
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${
                progress.phase === 'done'
                  ? 'bg-emerald-400'
                  : isDark ? 'bg-sky-300/55' : 'bg-sky-500/45'
              }`}
              style={{ width: `${flowRailProgress(progress.phase)}%` }}
            />
          </div>
          <div className="grid grid-cols-4">
          <ImportFlowStep
            theme={theme}
            label={text.scan}
            state={stepState(progress.phase, 'scan')}
          />
          <ImportFlowStep
            theme={theme}
            label={text.pair}
            state={stepState(progress.phase, 'pair')}
          />
          <ImportFlowStep
            theme={theme}
            label={text.metadata}
            state={stepState(progress.phase, 'metadata')}
          />
          <ImportFlowStep
            theme={theme}
            label={text.preload}
            state={stepState(progress.phase, 'preload')}
          />
          </div>
        </div>
      </div>

      <div className="mx-auto mt-4 max-w-[440px]">
        <div className={`mb-1.5 flex items-center justify-between text-[11px] ${
          isDark ? 'text-zinc-500' : 'text-slate-500'
        }`}>
          <span>{progress.phase === 'done' ? text.done : activePhaseLabel(progress.phase, text)}</span>
          <span className="font-mono tabular-nums">
            {progress.total > 0 ? `${progress.processed}/${progress.total}` : `${percent}%`}
          </span>
        </div>
        <div className={`h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-black/36' : 'bg-slate-300/64'}`}>
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${
              progress.phase === 'done' ? 'bg-emerald-400' : 'bg-sky-400'
            }`}
            style={{ width: `${Math.max(progress.phase === 'done' ? 100 : 4, percent)}%` }}
          />
        </div>
      </div>
    </aside>
  );
};

type StepState = 'waiting' | 'active' | 'done' | 'error';

function stepState(phase: ImportProgress['phase'], step: 'scan' | 'pair' | 'metadata' | 'preload'): StepState {
  if (phase === 'error') return 'error';
  if (phase === step) return 'active';
  if (phase === 'done') return 'done';
  const order = ['scan', 'pair', 'metadata', 'preload'];
  return order.indexOf(phase) > order.indexOf(step) ? 'done' : 'waiting';
}

function activePhaseLabel(phase: ImportProgress['phase'], text: typeof copy.zh) {
  if (phase === 'scan') return text.scan;
  if (phase === 'pair') return text.pair;
  if (phase === 'metadata') return text.metadata;
  if (phase === 'preload') return text.preload;
  if (phase === 'done') return text.done;
  return text.progressIdle;
}

const ImportFlowStep = ({
  theme,
  label,
  state,
}: {
  theme: 'light' | 'dark';
  label: string;
  state: StepState;
}) => {
  const isDark = theme === 'dark';
  const active = state === 'active';
  const done = state === 'done';
  const error = state === 'error';
  const dotClass = done
    ? isDark ? 'border-emerald-300 bg-emerald-300 text-zinc-950' : 'border-emerald-500 bg-emerald-500 text-white'
    : active
      ? isDark ? 'border-sky-200 bg-sky-300 text-zinc-950 shadow-[0_0_10px_rgba(56,189,248,0.48)]' : 'border-sky-600 bg-sky-600 text-white shadow-[0_0_8px_rgba(2,132,199,0.18)]'
      : error
        ? isDark ? 'border-rose-300 bg-rose-300 text-zinc-950' : 'border-rose-500 bg-rose-500 text-white'
        : isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-500' : 'border-slate-300 bg-slate-200 text-slate-500';
  const labelClass = done || active
    ? isDark ? 'text-zinc-200' : 'text-slate-800'
    : isDark ? 'text-zinc-600' : 'text-slate-500';

  return (
    <div className="relative z-10 min-w-0 px-2">
      <div className="relative flex items-center justify-center">
        <span className={`relative z-10 flex h-4 w-4 items-center justify-center rounded-full border text-[8px] transition-colors duration-200 ${dotClass}`}>
          {done ? <AppIcon icon={Check} className="h-2.5 w-2.5" /> : active ? <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" /> : null}
        </span>
      </div>
      <div className={`mt-1.5 truncate text-center text-[10px] font-medium leading-4 ${labelClass}`}>
        {label}
      </div>
    </div>
  );
};

function flowRailProgress(phase: ImportProgress['phase']) {
  if (phase === 'pair') return 33.333;
  if (phase === 'metadata') return 66.666;
  if (phase === 'preload' || phase === 'done') return 100;
  return 0;
}
