import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Images, RotateCw, Trophy, WandSparkles, type LucideIcon } from 'lucide-react';
import { DuplicateGroup, DuplicateReviewStatus, PhotoGroup, SelectionState, type PhotoRating } from '../types';
import { Language } from '../i18n';
import { AppIcon } from './ui/AppIcon';
import { glassInteractive, glassSurface } from './ui/chrome';
import { aiIssueLabel } from '../utils/aiLabels';
import { preloadJpegThumbnail } from '../utils/jpegThumbnailLoader';
import { decodeRawFile, getThumbnailFromCache } from '../utils/rawLoader';
import LazyThumbnail from './LazyThumbnail';
import Viewer, { type ViewerAiMode } from './Viewer';

interface DuplicateReviewWorkspaceProps {
  theme: 'light' | 'dark';
  language: Language;
  photos: PhotoGroup[];
  groups: DuplicateGroup[];
  status: DuplicateReviewStatus;
  selectedPhotoId?: string;
  aiRunning: boolean;
  aiViewMode: ViewerAiMode;
  onAiViewModeChange: (mode: ViewerAiMode) => void;
  onSelectPhoto: (photoId: string) => void;
  onNavigatePhoto?: (direction: 'prev' | 'next') => void;
  onUpdateSelection: (photoId: string, state: SelectionState) => void;
  onUpdateRating: (photoIds: string[], rating: PhotoRating) => void | Promise<void>;
  onAiStart: () => void;
}

const copy = {
  zh: {
    title: '重复照片选优',
    subtitle: 'AI 筛图完成后按相似画面分组，每组只给出一张最佳候选。',
    waitingTitle: '等待 AI 筛图完成',
    waitingDescription: '重复识别已并入 AI 筛图流程。完成后这里会自动显示重复组和奖杯推荐。',
    disabledTitle: '重复检测未启用',
    disabledDescription: '在 AI 设置中打开重复检测后，重新运行 AI 筛图即可生成重复组。',
    emptyTitle: '没有发现重复照片',
    emptyDescription: '当前敏感度下没有可合并比较的重复组，可以在 AI 设置中调到“轻度相似”。',
    startAi: '开始 AI 筛图',
    group: '重复组',
    photos: '张',
    similarity: '相似度',
    best: '推荐',
    bestCurrent: '当前为推荐图',
    back: '返回重复组',
    open: '双击查看大图',
    manualPick: '人工保留优先',
    rating: '星级优先',
    aiClear: 'AI 正常优先',
    quality: '质量评分优先',
  },
  en: {
    title: 'Duplicate Review',
    subtitle: 'After AI culling, similar frames are grouped and one best candidate is recommended.',
    waitingTitle: 'Waiting for AI culling',
    waitingDescription: 'Duplicate detection runs inside AI culling. Groups and trophies appear here when it finishes.',
    disabledTitle: 'Duplicate detection is off',
    disabledDescription: 'Turn it on in AI settings, then run AI culling again to create duplicate groups.',
    emptyTitle: 'No duplicates found',
    emptyDescription: 'No duplicate groups matched the current sensitivity. Try Loose similarity in AI settings.',
    startAi: 'Start AI culling',
    group: 'Group',
    photos: 'photos',
    similarity: 'Similarity',
    best: 'Best',
    bestCurrent: 'Recommended frame',
    back: 'Back to groups',
    open: 'Double-click to open',
    manualPick: 'Manual pick wins',
    rating: 'Rating wins',
    aiClear: 'AI clear wins',
    quality: 'Quality score wins',
  },
};

export const DuplicateReviewWorkspace: React.FC<DuplicateReviewWorkspaceProps> = ({
  theme,
  language,
  photos,
  groups,
  status,
  selectedPhotoId,
  aiRunning,
  aiViewMode,
  onAiViewModeChange,
  onSelectPhoto,
  onNavigatePhoto,
  onUpdateSelection,
  onUpdateRating,
  onAiStart,
}) => {
  const text = copy[language];
  const isDark = theme === 'dark';
  const [viewerOpen, setViewerOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const photoRefs = useRef(new Map<string, HTMLElement>());
  const scrollAlignFrameRef = useRef<number | null>(null);
  const scrollAlignRetryRef = useRef<number | null>(null);
  const photoMap = useMemo(() => new Map(photos.map(photo => [photo.id, photo])), [photos]);
  const duplicatePhotos = useMemo(
    () => groups
      .flatMap(group => group.photoIds)
      .map(id => photoMap.get(id))
      .filter((photo): photo is PhotoGroup => Boolean(photo)),
    [groups, photoMap],
  );
  const selectedGroup = useMemo(
    () => selectedPhotoId ? groups.find(group => group.photoIds.includes(selectedPhotoId)) ?? null : null,
    [groups, selectedPhotoId],
  );
  const bestPhotoIds = useMemo(
    () => new Set(groups.map(group => group.bestPhotoId).filter((id): id is string => Boolean(id))),
    [groups],
  );
  const selectedDuplicateIndex = useMemo(
    () => selectedPhotoId ? duplicatePhotos.findIndex(photo => photo.id === selectedPhotoId) : 0,
    [duplicatePhotos, selectedPhotoId],
  );
  const focusedPhoto = viewerOpen && selectedPhotoId ? photoMap.get(selectedPhotoId) ?? null : null;
  const focusedIsBest = focusedPhoto ? bestPhotoIds.has(focusedPhoto.id) : false;

  useEffect(() => {
    if (duplicatePhotos.length === 0) return;
    preloadDuplicateThumbnailWindow(duplicatePhotos, selectedDuplicateIndex >= 0 ? selectedDuplicateIndex : 0, { ahead: 42, behind: 18 });
  }, [duplicatePhotos, selectedDuplicateIndex]);

  const alignSelectedPhoto = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (!selectedGroup) return false;
    const scroller = scrollContainerRef.current;
    if (!scroller) return false;

    const element = selectedPhotoId
      ? photoRefs.current.get(selectedPhotoId) ?? groupRefs.current.get(selectedGroup.id)
      : groupRefs.current.get(selectedGroup.id);
    if (!element) return false;

    const scrollerRect = scroller.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (elementRect.height <= 0) return false;

    const targetTop = Math.max(
      0,
      Math.min(
        scroller.scrollHeight - scroller.clientHeight,
        scroller.scrollTop + elementRect.top - scrollerRect.top - (scrollerRect.height - elementRect.height) / 2,
      ),
    );

    if (Math.abs(targetTop - scroller.scrollTop) <= 8) return true;
    scroller.scrollTo({ top: targetTop, behavior });
    return true;
  }, [selectedGroup, selectedPhotoId]);

  useEffect(() => {
    if (!selectedGroup) return;

    if (scrollAlignFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollAlignFrameRef.current);
    }
    if (scrollAlignRetryRef.current !== null) {
      window.clearTimeout(scrollAlignRetryRef.current);
    }

    scrollAlignFrameRef.current = window.requestAnimationFrame(() => {
      scrollAlignFrameRef.current = null;
      const aligned = alignSelectedPhoto('smooth');
      if (aligned) return;

      scrollAlignRetryRef.current = window.setTimeout(() => {
        scrollAlignRetryRef.current = null;
        alignSelectedPhoto('smooth');
      }, 80);
    });
  }, [alignSelectedPhoto, selectedGroup?.id, selectedPhotoId]);

  useEffect(() => {
    if (!viewerOpen || !onNavigatePhoto) return;

    const handleViewerKeyDown = (event: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName || '';
      const isEditingText = document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) || isEditingText) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

      event.preventDefault();
      event.stopPropagation();
      onNavigatePhoto(event.key === 'ArrowRight' ? 'next' : 'prev');
    };

    window.addEventListener('keydown', handleViewerKeyDown, true);
    return () => window.removeEventListener('keydown', handleViewerKeyDown, true);
  }, [onNavigatePhoto, viewerOpen]);

  useEffect(() => () => {
    if (scrollAlignFrameRef.current !== null) window.cancelAnimationFrame(scrollAlignFrameRef.current);
    if (scrollAlignRetryRef.current !== null) window.clearTimeout(scrollAlignRetryRef.current);
  }, []);

  useEffect(() => {
    if (viewerOpen && selectedPhotoId && !photoMap.has(selectedPhotoId)) setViewerOpen(false);
  }, [photoMap, selectedPhotoId, viewerOpen]);

  if (focusedPhoto) {
    return (
      <div className="relative h-full min-h-0">
        <button
          type="button"
          onClick={() => setViewerOpen(false)}
          className={`absolute left-4 top-4 z-30 flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold backdrop-blur-[72px] ${
            isDark ? 'bg-[#1b1d21]/86 text-zinc-100 hover:bg-[#24272c]/90' : 'bg-white/78 text-slate-900 hover:bg-white'
          }`}
        >
          <AppIcon icon={ArrowLeft} className="h-4 w-4" />
          {text.back}
        </button>
        {focusedIsBest && (
          <div className={`absolute right-4 top-4 z-30 inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold backdrop-blur-[72px] ${
            isDark ? 'bg-amber-300/92 text-zinc-950 shadow-[0_0_22px_rgba(251,191,36,0.22)]' : 'bg-amber-300/92 text-zinc-950 shadow-[0_8px_22px_rgba(180,83,9,0.16)]'
          }`}>
            <AppIcon icon={Trophy} className="h-4 w-4" />
            {text.bestCurrent}
          </div>
        )}
        <Viewer
          group={focusedPhoto}
          animationClass=""
          onUpdateSelection={state => onUpdateSelection(focusedPhoto.id, state)}
          theme={theme}
          language={language}
          onUpdateRating={rating => { void onUpdateRating([focusedPhoto.id], rating); }}
          aiViewMode={aiViewMode}
          onAiViewModeChange={onAiViewModeChange}
        />
      </div>
    );
  }

  if (status === 'DISABLED') {
    return <DuplicateStatusSurface theme={theme} title={text.disabledTitle} description={text.disabledDescription} icon={Images} />;
  }

  if (aiRunning || status === 'ANALYZING' || status === 'IDLE') {
    return (
      <DuplicateStatusSurface
        theme={theme}
        title={text.waitingTitle}
        description={text.waitingDescription}
        icon={WandSparkles}
        actionLabel={!aiRunning ? text.startAi : undefined}
        onAction={!aiRunning ? onAiStart : undefined}
        loading={aiRunning || status === 'ANALYZING'}
      />
    );
  }

  if (groups.length === 0) {
    return <DuplicateStatusSurface theme={theme} title={text.emptyTitle} description={text.emptyDescription} icon={CheckCircle2} />;
  }

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-hidden ${isDark ? 'bg-[#151517]' : 'bg-slate-100'}`}>
      <header className={`flex h-[52px] shrink-0 items-center justify-between border-b px-4 ${
        isDark ? 'border-white/[0.06] bg-[#17191d]/[0.72]' : 'border-slate-300/70 bg-slate-200/84'
      }`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AppIcon icon={Images} className={isDark ? 'h-4 w-4 text-cyan-200' : 'h-4 w-4 text-cyan-700'} />
            <h1 className={`text-[15px] font-semibold ${isDark ? 'text-zinc-50' : 'text-slate-950'}`}>{text.title}</h1>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
              isDark ? 'bg-white/[0.06] text-zinc-300' : 'bg-white/70 text-slate-700'
            }`}>
              {groups.length}
            </span>
          </div>
          <p className={`mt-0.5 truncate text-[12px] ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>{text.subtitle}</p>
        </div>
        <div className={`text-[11px] font-medium tabular-nums ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
          {duplicatePhotos.length} {text.photos}
        </div>
      </header>

      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-[1280px] space-y-4">
          {groups.map((group, index) => (
            <DuplicateGroupSection
              key={group.id}
              refCallback={element => {
                if (element) groupRefs.current.set(group.id, element);
                else groupRefs.current.delete(group.id);
              }}
              group={group}
              index={index}
              photoMap={photoMap}
              selectedPhotoId={selectedPhotoId}
              theme={theme}
              language={language}
              labels={text}
              photoRefCallback={(photoId, element) => {
                if (element) photoRefs.current.set(photoId, element);
                else photoRefs.current.delete(photoId);
              }}
              onSelectPhoto={onSelectPhoto}
              onOpenPhoto={photoId => {
                onSelectPhoto(photoId);
                setViewerOpen(true);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

const DuplicateGroupSection = ({
  refCallback,
  group,
  index,
  photoMap,
  selectedPhotoId,
  theme,
  language,
  labels,
  photoRefCallback,
  onSelectPhoto,
  onOpenPhoto,
}: {
  refCallback: (element: HTMLElement | null) => void;
  group: DuplicateGroup;
  index: number;
  photoMap: Map<string, PhotoGroup>;
  selectedPhotoId?: string;
  theme: 'light' | 'dark';
  language: Language;
  labels: typeof copy.zh;
  photoRefCallback: (photoId: string, element: HTMLElement | null) => void;
  onSelectPhoto: (photoId: string) => void;
  onOpenPhoto: (photoId: string) => void;
}) => {
  const isDark = theme === 'dark';
  const photos = group.photoIds.map(id => photoMap.get(id)).filter((photo): photo is PhotoGroup => Boolean(photo));
  const bestMatch = group.matches.find(match => match.photoId === group.bestPhotoId);

  return (
    <section ref={refCallback} className={`overflow-hidden rounded-lg border ${
      isDark ? 'border-white/[0.055] bg-[#1a1b1f]/72' : 'border-slate-300/70 bg-white/58'
    }`}>
      <div className={`flex items-center justify-between gap-3 border-b px-3 py-2.5 ${
        isDark ? 'border-white/[0.055] bg-white/[0.035]' : 'border-slate-300/70 bg-white/62'
      }`}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={`text-[13px] font-semibold ${isDark ? 'text-zinc-100' : 'text-slate-950'}`}>
            {labels.group} {index + 1}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${isDark ? 'bg-white/[0.06] text-zinc-400' : 'bg-slate-100 text-slate-600'}`}>
            {photos.length} {labels.photos}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${isDark ? 'bg-cyan-300/10 text-cyan-100' : 'bg-cyan-100/80 text-cyan-800'}`}>
            {labels.similarity} {Math.round(group.similarity * 100)}%
          </span>
        </div>
        {bestMatch && (
          <span className={`hidden items-center gap-1.5 text-[11px] font-medium md:flex ${isDark ? 'text-amber-100' : 'text-amber-700'}`}>
            <AppIcon icon={Trophy} className="h-3.5 w-3.5" />
            {bestReasonLabel(bestMatch.reason, labels)}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3 p-3">
        {photos.map(photo => {
          const match = group.matches.find(item => item.photoId === photo.id);
          return (
            <DuplicateTile
              key={photo.id}
              photo={photo}
              match={match}
              active={selectedPhotoId === photo.id}
              best={group.bestPhotoId === photo.id}
              eager={selectedPhotoId === photo.id || group.bestPhotoId === photo.id || index < 3}
              theme={theme}
              language={language}
              labels={labels}
              refCallback={element => photoRefCallback(photo.id, element)}
              onSelect={() => onSelectPhoto(photo.id)}
              onOpen={() => onOpenPhoto(photo.id)}
            />
          );
        })}
      </div>
    </section>
  );
};

const DuplicateTile = ({
  photo,
  match,
  active,
  best,
  eager,
  theme,
  language,
  labels,
  refCallback,
  onSelect,
  onOpen,
}: {
  photo: PhotoGroup;
  match?: DuplicateGroup['matches'][number];
  active: boolean;
  best: boolean;
  eager: boolean;
  theme: 'light' | 'dark';
  language: Language;
  labels: typeof copy.zh;
  refCallback: (element: HTMLElement | null) => void;
  onSelect: () => void;
  onOpen: () => void;
}) => {
  const isDark = theme === 'dark';
  const issues = photo.ai?.issues ?? [];

  return (
    <button
      type="button"
      ref={refCallback}
      onClick={onSelect}
      onDoubleClick={onOpen}
      title={labels.open}
      className={`group relative overflow-hidden rounded-lg border text-left outline-none transition-[border-color,box-shadow,transform,background-color] duration-180 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-cyan-300/45 active:translate-y-0 ${
        active
          ? isDark
            ? 'border-cyan-200/54 bg-cyan-300/[0.08] shadow-[0_0_0_1px_rgba(103,232,249,0.18),0_12px_30px_rgba(0,0,0,0.28)]'
            : 'border-cyan-600/45 bg-white/78 shadow-[0_0_0_1px_rgba(8,145,178,0.12),0_10px_24px_rgba(15,23,42,0.12)]'
          : isDark
            ? 'border-white/[0.05] bg-black/24'
            : 'border-slate-300/50 bg-white/58'
      }`}
    >
      <div className={`relative aspect-[4/3] overflow-hidden ${isDark ? 'bg-zinc-900' : 'bg-slate-200'}`}>
        <div className="h-full w-full transition-transform duration-200 group-hover:scale-[1.025]">
          <LazyThumbnail group={photo} isVisible={active || best || eager} />
        </div>
        {best && (
          <span className={`absolute left-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold backdrop-blur-md ${
            isDark
              ? 'bg-amber-300/96 text-black shadow-[0_0_18px_rgba(251,191,36,0.34)]'
              : 'bg-amber-300 text-zinc-950 shadow-[0_0_16px_rgba(251,191,36,0.22)]'
          }`}>
            <AppIcon icon={Trophy} className="h-3 w-3" />
            {labels.best}
          </span>
        )}
        {issues.length > 0 && (
          <span className="absolute right-2 top-2 rounded-full bg-amber-300/92 px-2 py-1 text-[10px] font-semibold text-zinc-950 backdrop-blur-md">
            {aiIssueLabel(issues[0].code, language, issues[0].level)}
          </span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-[linear-gradient(180deg,transparent_0%,rgba(0,0,0,0.68)_100%)] px-2 pb-2 pt-8">
          <div className="flex items-center gap-0.5">
            {Array.from({ length: 5 }, (_, star) => star + 1).map(star => (
              <i key={star} className={`${(photo.rating ?? 0) >= star ? 'fa-solid text-white' : 'fa-regular text-white/34'} fa-star text-[9px]`} />
            ))}
          </div>
          <span className="rounded-full bg-black/30 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white/86">
            {Math.round((match?.similarity ?? 0) * 100)}%
          </span>
        </div>
      </div>
      <div className="px-2 py-1.5">
        <div className={`truncate text-[11px] font-medium ${isDark ? 'text-zinc-300' : 'text-slate-700'}`}>
          {photo.jpg?.name || photo.raw?.name || photo.id}
        </div>
      </div>
    </button>
  );
};

const DuplicateStatusSurface = ({
  theme,
  title,
  description,
  icon,
  actionLabel,
  onAction,
  loading = false,
}: {
  theme: 'light' | 'dark';
  title: string;
  description: string;
  icon: LucideIcon;
  actionLabel?: string;
  onAction?: () => void;
  loading?: boolean;
}) => {
  const isDark = theme === 'dark';
  return (
    <div className={`flex h-full items-center justify-center ${isDark ? 'bg-[#151517]' : 'bg-slate-100'}`}>
      <section className={`w-full max-w-[430px] rounded-xl border px-6 py-6 text-center ${isDark ? glassSurface.dark : glassSurface.light}`}>
        <span className={`mx-auto flex h-12 w-12 items-center justify-center rounded-xl ${isDark ? 'bg-white/[0.06] text-cyan-200' : 'bg-white/70 text-cyan-700'}`}>
          <AppIcon icon={loading ? RotateCw : icon} className={`h-5 w-5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} />
        </span>
        <h2 className={`mt-4 text-[17px] font-semibold ${isDark ? 'text-zinc-50' : 'text-slate-950'}`}>{title}</h2>
        <p className={`mt-2 text-[13px] leading-6 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>{description}</p>
        {actionLabel && onAction && (
          <button type="button" onClick={onAction} className={`mt-5 h-9 rounded-lg px-3 text-[12px] font-semibold ${isDark ? glassInteractive.dark : glassInteractive.light}`}>
            {actionLabel}
          </button>
        )}
      </section>
    </div>
  );
};

function bestReasonLabel(reason: string | undefined, labels: typeof copy.zh) {
  if (reason === 'manual-pick') return labels.manualPick;
  if (reason === 'rating') return labels.rating;
  if (reason === 'ai-clear') return labels.aiClear;
  return labels.quality;
}

function preloadDuplicateThumbnailWindow(
  photos: PhotoGroup[],
  currentIndex: number,
  options: { ahead: number; behind: number },
) {
  if (photos.length === 0 || currentIndex < 0) return;

  const maxOffset = Math.max(options.ahead, options.behind);
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    if (offset <= options.ahead) {
      preloadDuplicateThumbnail(photos[currentIndex + offset], offset === 0);
    }
    if (offset > 0 && offset <= options.behind) {
      preloadDuplicateThumbnail(photos[currentIndex - offset], false);
    }
  }
}

function preloadDuplicateThumbnail(photo: PhotoGroup | undefined, highPriority: boolean) {
  if (!photo) return;

  if (photo.jpg?.path && photo.jpg.previewUrl) {
    preloadJpegThumbnail(photo.jpg.path, photo.jpg.previewUrl, 360, highPriority ? 'high' : 'low');
    return;
  }

  if (!photo.raw?.path || getThumbnailFromCache(photo.raw.path)) return;
  void decodeRawFile(photo.raw.path, true, {
    priority: highPriority ? 'high' : 'low',
    silent: true,
  }).catch(() => undefined);
}
