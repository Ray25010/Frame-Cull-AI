import React from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, X } from 'lucide-react';
import { Language } from '../i18n';
import { ExportProgress } from '../types';
import { AppIcon } from './ui/AppIcon';
import { chromeGlass, modalBackdrop } from './ui/chrome';

interface ExportProgressOverlayProps {
  theme: 'light' | 'dark';
  language: Language;
  progress: ExportProgress;
  onClose: () => void;
  onRevealResult: () => void;
}

const copy = {
  zh: {
    title: '正在导出',
    doneTitle: '导出完成',
    lightroomDoneTitle: 'Lightroom',
    errorTitle: '导出失败',
    preparing: '准备导出',
    rendering: '渲染照片',
    copying: '生成新文件',
    moving: '移动原片',
    writing: '写入文件',
    done: '完成',
    error: '出错',
    current: '当前文件',
    destination: '文件夹',
    revealResult: '显示导出结果',
    revealLightroomFolder: '显示文件夹',
    lightroomReady: '已写入星级，并打开所选照片所在文件夹。',
    lightroomLaunched: 'Lightroom Classic 已启动',
    lightroomNotFound: '未检测到 Lightroom Classic，星级已写入',
    lightroomLaunchError: 'Lightroom Classic 启动失败，星级已写入',
    close: '完成',
    files: '个文件',
  },
  en: {
    title: 'Exporting',
    doneTitle: 'Export complete',
    lightroomDoneTitle: 'Lightroom',
    errorTitle: 'Export failed',
    preparing: 'Preparing export',
    rendering: 'Rendering photos',
    copying: 'Creating new files',
    moving: 'Moving originals',
    writing: 'Writing files',
    done: 'Done',
    error: 'Error',
    current: 'Current file',
    destination: 'Folder',
    revealResult: 'Show Result',
    revealLightroomFolder: 'Show Folder',
    lightroomReady: 'Ratings were written and the selected photos folder is open.',
    lightroomLaunched: 'Lightroom Classic was launched.',
    lightroomNotFound: 'Lightroom Classic was not detected; ratings were written.',
    lightroomLaunchError: 'Lightroom Classic failed to launch; ratings were written.',
    close: 'Done',
    files: 'files',
  },
};

export const ExportProgressOverlay: React.FC<ExportProgressOverlayProps> = ({
  theme,
  language,
  progress,
  onClose,
  onRevealResult,
}) => {
  const text = copy[language];
  const isDark = theme === 'dark';
  const isDone = progress.phase === 'done';
  const isError = progress.phase === 'error';
  const isLightroomHandoff = progress.exportTarget === 'LIGHTROOM_CLASSIC';
  const canRevealResult = Boolean(progress.destinationFolder || progress.files?.length);
  const percent = progress.total > 0
    ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
    : isDone ? 100 : 0;
  const title = isDone ? (isLightroomHandoff ? text.lightroomDoneTitle : text.doneTitle) : isError ? text.errorTitle : text.title;
  const phaseLabel = getPhaseLabel(progress.phase, text);
  const lightroomStatus = getLightroomStatus(progress, text);

  return (
    <div className={`fixed inset-0 z-[120] flex items-center justify-center p-4 ${modalBackdrop}`}>
      <div className={`relative w-full max-w-[520px] overflow-hidden rounded-lg border ${isDark ? chromeGlass.dark : chromeGlass.light}`}>
        <div className={`pointer-events-none absolute inset-x-0 top-0 h-px ${isDark ? 'bg-white/12' : 'bg-white/80'}`} />
        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                isDone
                  ? isDark ? 'bg-emerald-300/14 text-emerald-200' : 'bg-emerald-100 text-emerald-700'
                  : isError
                    ? isDark ? 'bg-rose-300/14 text-rose-200' : 'bg-rose-100 text-rose-700'
                    : isDark ? 'bg-sky-300/14 text-sky-200' : 'bg-sky-100 text-sky-700'
              }`}>
                <AppIcon
                  icon={isDone ? CheckCircle2 : isError ? AlertTriangle : Loader2}
                  className={`h-5 w-5 ${progress.running ? 'animate-spin motion-reduce:animate-none' : ''}`}
                />
              </span>
              <div className="min-w-0">
                <h2 className={`text-[17px] font-semibold ${isDark ? 'text-zinc-50' : 'text-slate-950'}`}>
                  {title}
                </h2>
                <p className={`mt-1 text-[13px] ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                  {phaseLabel}
                  {progress.total > 0 && ` · ${progress.processed}/${progress.total} ${text.files}`}
                </p>
              </div>
            </div>

            {!progress.running && (
              <button
                type="button"
                onClick={onClose}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
                  isDark ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-white' : 'text-slate-500 hover:bg-white/60 hover:text-slate-900'
                }`}
                title={text.close}
              >
                <AppIcon icon={X} className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="mt-5">
            <div className={`mb-2 flex items-center justify-between text-[12px] ${
              isDark ? 'text-zinc-500' : 'text-slate-500'
            }`}>
              <span>{progress.current ? `${text.current}: ${progress.current}` : phaseLabel}</span>
              <span className="font-mono tabular-nums">{percent}%</span>
            </div>
            <div className={`h-2 overflow-hidden rounded-full ${isDark ? 'bg-black/34' : 'bg-slate-300/58'}`}>
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${
                  isError ? 'bg-rose-400' : isDone ? 'bg-emerald-400' : 'bg-sky-400'
                }`}
                style={{ width: `${Math.max(isDone ? 100 : 4, percent)}%` }}
              />
            </div>
          </div>

          {progress.destinationFolder && (
            <div className={`mt-4 rounded-lg border px-3 py-2.5 ${
              isDark ? 'border-white/[0.05] bg-black/18' : 'border-slate-300/55 bg-white/48'
            }`}>
              <div className={`mb-1 text-[11px] font-medium ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                {text.destination}
              </div>
              <div className={`truncate font-mono text-[12px] ${isDark ? 'text-zinc-300' : 'text-slate-700'}`}>
                {progress.destinationFolder}
              </div>
            </div>
          )}

          {isDone && isLightroomHandoff && (
            <div className={`mt-4 rounded-lg border px-3 py-2.5 text-[12px] leading-5 ${
              isDark ? 'border-cyan-200/12 bg-cyan-300/8 text-cyan-50' : 'border-cyan-200 bg-cyan-50 text-cyan-900'
            }`}>
              <div className="font-semibold">{lightroomStatus.title}</div>
              <div className={`mt-1 ${isDark ? 'text-zinc-300' : 'text-slate-700'}`}>
                {text.lightroomReady}
              </div>
              {progress.lightroomMessage && (
                <div className={`mt-1 whitespace-pre-wrap font-mono text-[11px] ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                  {progress.lightroomMessage}
                </div>
              )}
            </div>
          )}

          {isError && progress.error && (
            <div className={`mt-4 max-h-28 overflow-auto rounded-lg border px-3 py-2.5 text-[12px] leading-5 ${
              isDark ? 'border-rose-300/16 bg-rose-300/8 text-rose-100' : 'border-rose-200 bg-rose-50 text-rose-800'
            }`}>
              {progress.error}
            </div>
          )}

          {!progress.running && (
            <div className="mt-5 flex justify-end gap-2">
              {canRevealResult && !isError && (
                <button
                  type="button"
                  onClick={onRevealResult}
                  className={`flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-colors ${
                    isDark ? 'bg-white/[0.07] text-zinc-100 hover:bg-white/[0.10]' : 'bg-white/72 text-slate-800 hover:bg-white'
                  }`}
                >
                  <AppIcon icon={FolderOpen} className="h-4 w-4" />
                  <span>{isLightroomHandoff ? text.revealLightroomFolder : text.revealResult}</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className={`h-9 rounded-lg px-4 text-[12px] font-semibold transition-colors ${
                  isError
                    ? isDark ? 'bg-rose-400 text-zinc-950 hover:bg-rose-300' : 'bg-rose-600 text-white hover:bg-rose-500'
                    : isDark ? 'bg-sky-300 text-zinc-950 hover:bg-sky-200' : 'bg-sky-600 text-white hover:bg-sky-500'
                }`}
              >
                {text.close}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

function getPhaseLabel(phase: ExportProgress['phase'], text: typeof copy.zh) {
  if (phase === 'preparing') return text.preparing;
  if (phase === 'rendering') return text.rendering;
  if (phase === 'copying') return text.copying;
  if (phase === 'moving') return text.moving;
  if (phase === 'writing') return text.writing;
  if (phase === 'done') return text.done;
  if (phase === 'error') return text.error;
  return text.preparing;
}

function getLightroomStatus(progress: ExportProgress, text: typeof copy.zh) {
  if (progress.lightroomLaunchStatus === 'LAUNCHED') {
    return { title: text.lightroomLaunched };
  }
  if (progress.lightroomLaunchStatus === 'NOT_FOUND') {
    return { title: text.lightroomNotFound };
  }
  if (progress.lightroomLaunchStatus === 'ERROR') {
    return { title: text.lightroomLaunchError };
  }
  return { title: text.lightroomReady };
}
