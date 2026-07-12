import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, SlidersHorizontal, WandSparkles } from 'lucide-react';
import type { AiProgress } from '../types';
import type { Language } from '../i18n';
import { AppIcon } from './ui/AppIcon';
import { glassInteractive, glassSubtle, glassSurface } from './ui/chrome';
import { readStorage } from '../utils/storage';

interface AiFloatingPanelProps {
  theme: 'light' | 'dark';
  language: Language;
  stats: {
    total: number;
    aiReview: number;
  };
  progress: AiProgress;
  onAiStart: () => void;
  onAiPause: () => void;
  onAiResume: () => void;
  onAiSettingsClick: () => void;
}

export type PanelEdge = 'left' | 'right';
export type PanelPosition = { x: number; y: number };
export type PanelDockState = { hiddenEdge: PanelEdge | null };
export type PanelStorageState = PanelDockState & { position: PanelPosition };

type PanelDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: PanelPosition;
  current: PanelPosition;
};

export const PANEL_WIDTH = 268;
export const PANEL_HEIGHT = 272;
export const DEFAULT_POSITION: PanelPosition = { x: 18, y: 150 };
const STORAGE_KEY = 'framecull-ai-floating-panel-position';
const EDGE_MIN_X = 8;
const EDGE_MIN_Y = 96;
const EDGE_GUTTER = 8;
const RESTORE_INSET = 18;
const EDGE_TAB_HEIGHT = 78;
const TAB_PULL_OFFSET = 18;

const copy = {
  zh: {
    title: 'AI\u6311\u56fe',
    review: '\u5f85\u590d\u67e5',
    start: '\u5f00\u59cb',
    pause: '\u6682\u505c',
    resume: '\u7ee7\u7eed',
    settings: 'AI\u8bbe\u7f6e',
    active: '\u5f53\u524d',
    idle: '\u5c31\u7eea',
    empty: '\u65e0\u7167\u7247',
    scanned: '\u5df2\u7b5b',
    elapsed: '\u8fd0\u884c\u65f6\u95f4',
    remaining: '\u9884\u8ba1\u5269\u4f59',
    noEstimate: '--',
    proScoringPhase: '\u6574\u7406 Pro \u6a21\u578b\u5206\u6570',
    proScoringState: '\u6536\u5c3e\u4e2d',
    engineInit: 'AI \u7f8e\u5b66\u5f15\u64ce\u542f\u52a8\u4e2d',
    engineInitShort: '\u7f8e\u5b66\u5f15\u64ce',
    engineInitDetail: '\u6b63\u5728\u52a0\u8f7d\u672c\u5730\u5ba1\u7f8e\u6a21\u578b\u4e0e\u7b5b\u7247\u89c4\u5219',
    engineInitState: '\u542f\u52a8\u4e2d',
    duplicatePhase: '分析重复照片',
    collapse: '\u6536\u8d77',
    restore: '\u6062\u590d\u9762\u677f',
  },
  en: {
    title: 'AI Cull',
    review: 'Review',
    start: 'Start',
    pause: 'Pause',
    resume: 'Resume',
    settings: 'AI Settings',
    active: 'Active',
    idle: 'Ready',
    empty: 'No photos',
    scanned: 'Scanned',
    elapsed: 'Elapsed',
    remaining: 'Remaining',
    noEstimate: '--',
    proScoringPhase: 'Finalizing Pro model scores',
    proScoringState: 'Finishing',
    engineInit: 'Starting AI aesthetic engine',
    engineInitShort: 'Aesthetic engine',
    engineInitDetail: 'Loading local aesthetic model and culling rules',
    engineInitState: 'Starting',
    duplicatePhase: 'Analyzing duplicates',
    collapse: 'Collapse',
    restore: 'Restore panel',
  },
};

export const AiFloatingPanel: React.FC<AiFloatingPanelProps> = ({
  theme,
  language,
  stats,
  progress,
  onAiStart,
  onAiPause,
  onAiResume,
  onAiSettingsClick,
}) => {
  const text = copy[language];
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PanelDragState | null>(null);
  const tabCleanupRef = useRef<(() => void) | null>(null);
  const [panelState, setPanelState] = useState<PanelStorageState>(() => loadPanelState());
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [timeNow, setTimeNow] = useState(() => Date.now());
  const isCompact = viewportWidth < 720;
  const expanded = !isCompact || mobileOpen;
  const hiddenEdge = !isCompact ? panelState.hiddenEdge : null;
  const progressPercent = useMemo(() => {
    if (!progress.total) return 0;
    return Math.round((progress.processed / progress.total) * 100);
  }, [progress.processed, progress.total]);
  const progressTotal = progress.total || stats.total;
  const engineInitializing = progress.running && progress.phase === 'AI_ENGINE_INIT';
  const proScoring = progress.running && progress.phase === 'PRO_MODEL_SCORING';
  const displayPercent = engineInitializing ? 16 : proScoring ? 98 : progressPercent;
  const scannedValue = `${Math.min(progress.processed, progressTotal)}/${progressTotal}`;
  const elapsedMs = getDisplayedElapsedMs(progress, timeNow);
  const elapsedValue = formatElapsedTime(elapsedMs);
  const remainingMs = estimateRemainingMs(elapsedMs, progress.processed, progressTotal);
  const remainingValue = remainingMs === null ? text.noEstimate : formatElapsedTime(remainingMs);
  const activeValue = engineInitializing
    ? text.engineInitDetail
    : proScoring
    ? text.proScoringPhase
    : progress.phase === 'DUPLICATE_GROUPING'
    ? text.duplicatePhase
    : progress.activeId || (stats.total === 0 ? text.empty : text.idle);

  const panelWidth = useCallback(() => panelRef.current?.offsetWidth || PANEL_WIDTH, []);
  const panelHeight = useCallback(() => panelRef.current?.offsetHeight || PANEL_HEIGHT, []);
  const clampForWindow = useCallback((next: PanelPosition) => {
    return clampPanelPosition(next, window.innerWidth, window.innerHeight, panelWidth(), panelHeight());
  }, [panelHeight, panelWidth]);

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
      setPanelState(prev => ({
        ...prev,
        position: clampForWindow(prev.position),
      }));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [clampForWindow]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(panelState));
  }, [panelState]);

  useEffect(() => {
    return () => {
      tabCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!progress.running || progress.paused) return;
    setTimeNow(Date.now());
    const timer = window.setInterval(() => setTimeNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress.paused, progress.running]);

  const restoreFromEdge = useCallback((edge: PanelEdge) => {
    setPanelState(prev => ({
      hiddenEdge: null,
      position: getRestoredPosition(edge, prev.position.y, window.innerWidth, window.innerHeight, panelWidth(), panelHeight()),
    }));
  }, [panelHeight, panelWidth]);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (isCompact && !expanded) return;
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;
    const origin = panelState.position;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      current: origin,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [expanded, isCompact, panelState.position]);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampForWindow({
      x: drag.origin.x + event.clientX - drag.startX,
      y: drag.origin.y + event.clientY - drag.startY,
    });
    drag.current = next;
    setPanelState({ hiddenEdge: null, position: next });
  }, [clampForWindow]);

  const endDrag = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }

    const finalPosition = drag.current;
    const nextEdge = !isCompact
      ? getEdgeForPosition(finalPosition, window.innerWidth, panelWidth())
      : null;
    setPanelState({
      hiddenEdge: nextEdge,
      position: finalPosition,
    });
    dragRef.current = null;
  }, [isCompact, panelWidth]);

  const handleEdgePointerDown = useCallback((event: React.PointerEvent, edge: PanelEdge) => {
    event.preventDefault();
    tabCleanupRef.current?.();

    const drag = {
      startX: event.clientX,
      startY: event.clientY,
      originY: panelState.position.y,
      opened: false,
    };

    const handleMove = (moveEvent: PointerEvent) => {
      const distance = Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY);
      if (!drag.opened && distance < 4) return;
      drag.opened = true;

      const width = panelWidth();
      const height = panelHeight();
      const bounds = getPanelBounds(window.innerWidth, window.innerHeight, width, height);
      const rawX = edge === 'left'
        ? Math.max(bounds.minX + RESTORE_INSET, moveEvent.clientX - TAB_PULL_OFFSET)
        : Math.min(bounds.maxX - RESTORE_INSET, moveEvent.clientX - width + TAB_PULL_OFFSET);
      const next = clampPanelPosition({
        x: rawX,
        y: drag.originY + moveEvent.clientY - drag.startY,
      }, window.innerWidth, window.innerHeight, width, height);

      setPanelState({ hiddenEdge: null, position: next });
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      tabCleanupRef.current = null;
    };

    const handleUp = () => {
      cleanup();
      if (!drag.opened) {
        restoreFromEdge(edge);
      }
    };

    tabCleanupRef.current = cleanup;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [panelHeight, panelState.position.y, panelWidth, restoreFromEdge]);

  if (!expanded) {
    return (
      <button
        className={`fixed z-30 flex h-12 w-12 items-center justify-center rounded-lg border transition-colors ${
          theme === 'dark'
            ? `${glassSurface.dark} text-cyan-300 hover:bg-[#22252a]/[0.90]`
            : `${glassSurface.light} text-cyan-700 hover:bg-slate-100/[0.90]`
        }`}
        style={{ left: 14, top: 150 }}
        onClick={() => setMobileOpen(true)}
        title={text.title}
      >
        <AppIcon icon={WandSparkles} className="h-4 w-4" />
        {progress.running && (
          <span className={`absolute -right-1 -top-1 h-3 w-3 rounded-full bg-cyan-400 ring-2 ${
            theme === 'dark' ? 'ring-zinc-950' : 'ring-white'
          }`} />
        )}
      </button>
    );
  }

  if (hiddenEdge) {
    return (
      <button
        className={`fixed z-30 flex h-[78px] w-[34px] flex-col items-center justify-center gap-2 border transition-colors ${
          hiddenEdge === 'left' ? 'rounded-r-lg border-l-0' : 'rounded-l-lg border-r-0'
        } ${
          theme === 'dark'
            ? `${glassSurface.dark} text-cyan-300 hover:bg-[#22252a]/[0.92]`
            : `${glassSurface.light} text-cyan-700 hover:bg-slate-100/[0.92]`
        }`}
        style={{
          left: hiddenEdge === 'left' ? 0 : undefined,
          right: hiddenEdge === 'right' ? 0 : undefined,
          top: clampBookmarkY(panelState.position.y),
        }}
        title={text.restore}
        onPointerDown={event => handleEdgePointerDown(event, hiddenEdge)}
      >
        <AppIcon icon={WandSparkles} className="h-3.5 w-3.5" />
        <AppIcon icon={hiddenEdge === 'left' ? ChevronRight : ChevronLeft} className="h-3 w-3" />
        {progress.running && (
          <span className={`absolute top-1.5 h-2.5 w-2.5 rounded-full bg-cyan-400 ring-2 ${
            hiddenEdge === 'left' ? '-right-1' : '-left-1'
          } ${theme === 'dark' ? 'ring-zinc-950' : 'ring-white'}`} />
        )}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className={`fixed z-30 w-[268px] overflow-hidden rounded-lg border transition-colors ${
        theme === 'dark'
          ? glassSurface.dark
          : glassSurface.light
      }`}
      style={{ transform: `translate3d(${panelState.position.x}px, ${panelState.position.y}px, 0)` }}
    >
      <div
        className={`flex cursor-grab items-center justify-between gap-3 border-b px-3 py-2 active:cursor-grabbing ${
          theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-400/24'
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
            theme === 'dark' ? 'bg-cyan-400/10 text-cyan-300' : 'bg-cyan-100/55 text-cyan-700'
          }`}>
            <AppIcon icon={WandSparkles} className="h-3.5 w-3.5" />
          </span>
          <div className={`truncate text-xs font-black ${theme === 'dark' ? 'text-zinc-100' : 'text-gray-900'}`}>
            {engineInitializing ? text.engineInit : text.title}
          </div>
        </div>
        {isCompact && (
          <button
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
              theme === 'dark' ? glassInteractive.dark : glassInteractive.light
            }`}
            onClick={() => setMobileOpen(false)}
            title={text.collapse}
          >
            <AppIcon icon={ChevronLeft} className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="grid grid-cols-[1fr_2.75rem] items-center gap-2">
          <div className={`h-1.5 overflow-hidden rounded-full ${theme === 'dark' ? 'bg-white/10' : 'bg-slate-500/18'}`}>
            <div
              className={`relative h-full overflow-hidden rounded-full bg-cyan-400 transition-all duration-300 ${
                engineInitializing ? 'ai-engine-scan' : ''
              }`}
              style={{ width: `${displayPercent}%` }}
            />
          </div>
          <div className={`text-right text-[11px] font-semibold tabular-nums ${
            engineInitializing
              ? theme === 'dark' ? 'text-cyan-100' : 'text-cyan-700'
              : theme === 'dark' ? 'text-zinc-100' : 'text-gray-900'
          }`}>
            {engineInitializing ? text.engineInitState : proScoring ? text.proScoringState : `${progressPercent}%`}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <MetricCell theme={theme} label={text.scanned} value={scannedValue} />
          <MetricCell theme={theme} label={text.review} value={String(stats.aiReview)} />
          <MetricCell theme={theme} label={text.elapsed} value={elapsedValue} />
          <MetricCell theme={theme} label={text.remaining} value={remainingValue} />
        </div>

        <div className={`flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 ${
          theme === 'dark' ? glassSubtle.dark : glassSubtle.light
        }`} title={activeValue}>
          <span className={`shrink-0 text-[10px] font-black ${theme === 'dark' ? 'text-zinc-300' : 'text-gray-700'}`}>
            {text.active}:
          </span>
          <span className={`min-w-0 truncate text-xs font-semibold tabular-nums ${
            theme === 'dark' ? 'text-zinc-100' : 'text-gray-900'
          }`}>
            {activeValue}
          </span>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <button
            className={`min-h-10 rounded-md px-3 text-xs font-black transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              theme === 'dark'
                ? 'bg-cyan-400 text-zinc-950 hover:bg-cyan-300'
                : 'bg-cyan-600 text-white hover:bg-cyan-700'
            }`}
            disabled={stats.total === 0}
            onClick={progress.running ? (progress.paused ? onAiResume : onAiPause) : onAiStart}
          >
            <AppIcon icon={progress.running ? (progress.paused ? Play : Pause) : WandSparkles} className="mr-2 inline h-4 w-4 align-[-3px]" />
            {progress.running ? (progress.paused ? text.resume : engineInitializing ? text.engineInitShort : proScoring ? text.proScoringState : text.pause) : text.start}
          </button>
          <button
            className={`flex h-10 w-10 items-center justify-center rounded-md border transition-colors ${
              theme === 'dark'
                ? `${glassSubtle.dark} text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100`
                : 'border-slate-400/28 bg-slate-100/[0.72] text-slate-600 hover:bg-white/72 hover:text-slate-950'
            }`}
            onClick={onAiSettingsClick}
            title={text.settings}
          >
            <AppIcon icon={SlidersHorizontal} className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

const MetricCell = ({ theme, label, value }: { theme: 'light' | 'dark'; label: string; value: string }) => (
  <div className={`rounded-md border px-2 py-1.5 ${
    theme === 'dark' ? glassSubtle.dark : glassSubtle.light
  }`}>
    <div className={`truncate text-[10px] font-black ${theme === 'dark' ? 'text-zinc-300' : 'text-gray-700'}`}>{label}</div>
    <div className={`truncate text-xs font-semibold tabular-nums ${theme === 'dark' ? 'text-white' : 'text-gray-950'}`}>{value}</div>
  </div>
);

export function getDisplayedElapsedMs(progress: AiProgress, nowMs: number) {
  if (!progress.running || progress.paused || progress.startedAt === undefined) {
    return progress.elapsedMs ?? 0;
  }
  return Math.max(0, nowMs - progress.startedAt - (progress.pausedTotalMs ?? 0));
}

function estimateRemainingMs(elapsedMs: number, processed: number, total: number) {
  if (processed <= 0 || total <= processed || elapsedMs < 1000) return null;
  return Math.max(0, Math.round((elapsedMs / processed) * (total - processed)));
}

export function formatElapsedTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function getPanelBounds(viewportWidth: number, viewportHeight: number, panelWidth = PANEL_WIDTH, panelHeight = PANEL_HEIGHT) {
  const maxX = Math.max(EDGE_MIN_X, viewportWidth - panelWidth - EDGE_GUTTER);
  const maxY = Math.max(EDGE_MIN_Y, viewportHeight - panelHeight - EDGE_GUTTER);
  return {
    minX: EDGE_MIN_X,
    minY: EDGE_MIN_Y,
    maxX,
    maxY,
  };
}

export function clampPanelPosition(position: PanelPosition, viewportWidth: number, viewportHeight: number, panelWidth = PANEL_WIDTH, panelHeight = PANEL_HEIGHT): PanelPosition {
  const bounds = getPanelBounds(viewportWidth, viewportHeight, panelWidth, panelHeight);
  return {
    x: Math.min(Math.max(bounds.minX, position.x), bounds.maxX),
    y: Math.min(Math.max(bounds.minY, position.y), bounds.maxY),
  };
}

export function getEdgeForPosition(position: PanelPosition, viewportWidth: number, panelWidth = PANEL_WIDTH): PanelEdge | null {
  const maxX = Math.max(EDGE_MIN_X, viewportWidth - panelWidth - EDGE_GUTTER);
  if (position.x <= EDGE_MIN_X) return 'left';
  if (position.x >= maxX) return 'right';
  return null;
}

export function getRestoredPosition(edge: PanelEdge, y: number, viewportWidth: number, viewportHeight: number, panelWidth = PANEL_WIDTH, panelHeight = PANEL_HEIGHT): PanelPosition {
  const bounds = getPanelBounds(viewportWidth, viewportHeight, panelWidth, panelHeight);
  const x = edge === 'left'
    ? bounds.minX + RESTORE_INSET
    : bounds.maxX - RESTORE_INSET;
  return clampPanelPosition({ x, y }, viewportWidth, viewportHeight, panelWidth, panelHeight);
}

export function parseStoredPanelState(raw: string | null, viewportWidth: number, viewportHeight: number, panelWidth = PANEL_WIDTH, panelHeight = PANEL_HEIGHT): PanelStorageState {
  if (!raw) {
    return {
      position: clampPanelPosition(DEFAULT_POSITION, viewportWidth, viewportHeight, panelWidth, panelHeight),
      hiddenEdge: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PanelPosition & PanelStorageState>;
    const legacyX = typeof parsed.x === 'number' ? parsed.x : undefined;
    const legacyY = typeof parsed.y === 'number' ? parsed.y : undefined;
    const position = parsed.position && typeof parsed.position.x === 'number' && typeof parsed.position.y === 'number'
      ? parsed.position
      : legacyX !== undefined && legacyY !== undefined
        ? { x: legacyX, y: legacyY }
        : DEFAULT_POSITION;
    const hiddenEdge = parsed.hiddenEdge === 'left' || parsed.hiddenEdge === 'right'
      ? parsed.hiddenEdge
      : null;

    return {
      position: clampPanelPosition(migrateStoredPanelPosition(position, hiddenEdge), viewportWidth, viewportHeight, panelWidth, panelHeight),
      hiddenEdge,
    };
  } catch {
    return {
      position: clampPanelPosition(DEFAULT_POSITION, viewportWidth, viewportHeight, panelWidth, panelHeight),
      hiddenEdge: null,
    };
  }
}

function migrateStoredPanelPosition(position: PanelPosition, hiddenEdge: PanelEdge | null): PanelPosition {
  if (hiddenEdge) return position;
  if (position.y < 132) {
    return { ...position, y: DEFAULT_POSITION.y };
  }
  return position;
}

function loadPanelState(): PanelStorageState {
  return parseStoredPanelState(readStorage(STORAGE_KEY), window.innerWidth, window.innerHeight);
}

function clampBookmarkY(y: number) {
  const maxY = Math.max(EDGE_MIN_Y, window.innerHeight - EDGE_TAB_HEIGHT - EDGE_GUTTER);
  return Math.min(Math.max(EDGE_MIN_Y, y), maxY);
}
