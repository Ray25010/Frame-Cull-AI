import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, Filter, Trophy } from 'lucide-react';
import { PhotoFilter, PhotoGroup, PhotoRatingFilter, SelectionState } from '../types';
import LazyThumbnail from './LazyThumbnail';
import { Language } from '../i18n';
import { aiIssueIcon, aiIssueLabel, formatConfidence } from '../utils/aiLabels';
import { AppIcon } from './ui/AppIcon';
import { chromeSolid, glassActive, glassInteractive, glassPopover } from './ui/chrome';
import {
  DEFAULT_FILMSTRIP_ITEM_HEIGHT,
  DEFAULT_FILMSTRIP_OVERSCAN,
  getSelectionTrackingScrollTop,
  getVirtualRange,
  shouldSyncVirtualScroll,
} from '../utils/filmstripVirtualization';

interface FilmstripProps {
  theme: 'light' | 'dark';
  filteredPhotos: PhotoGroup[];
  selectedIndex: number | null;
  selectedPhotoIds: string[];
  filter: PhotoFilter;
  ratingFilter: PhotoRatingFilter;
  stats: {
    total: number;
    picked: number;
    rejected: number;
    unmarked: number;
    orphans: number;
    aiReview: number;
    aiNormal: number;
    aiPicked: number;
    groupPhoto: number;
    duplicates: number;
    rated: number;
  };
  onSelectPhoto: (index: number, mode?: 'replace' | 'toggle' | 'range') => void;
  onFilterChange: (filter: PhotoFilter) => void;
  onRatingFilterChange: (filter: PhotoRatingFilter) => void;
  duplicateBestPhotoIds?: ReadonlySet<string>;
  aiPickedPhotoIds?: ReadonlySet<string>;
  showAiPickedBadge?: boolean;
  language: Language;
}

const labels = {
  zh: {
    filters: {
      ALL: '\u5168\u90e8\u7167\u7247',
      PICKED: '\u4fdd\u7559',
      REJECTED: '\u5f03\u7528',
      UNMARKED: '\u672a\u51b3',
      ORPHANS: '\u5355\u6587\u4ef6',
      AI_REVIEW: 'AI\u5f85\u590d\u67e5',
      AI_NORMAL: 'AI\u6b63\u5e38',
      AI_PICKED: 'AI\u7cbe\u9009',
      GROUP_PHOTO: '\u5408\u7167',
      DUPLICATES: '\u91cd\u590d\u7167\u7247',
    },
    ratingAll: '\u5168\u90e8\u661f\u7ea7',
    unrated: '\u672a\u8bc4\u661f',
    onePlus: '1\u661f+',
    twoPlus: '2\u661f+',
    threePlus: '3\u661f+',
    fourPlus: '4\u661f+',
    fiveOnly: '5\u661f',
    filterButton: '\u7b5b\u9009',
    statusFilter: '\u72b6\u6001',
    ratingFilter: '\u661f\u7ea7',
    duplicateBest: '\u63a8\u8350',
    aiPickedBadge: '\u7cbe\u9009',
  },
  en: {
    filters: {
      ALL: 'All Photos',
      PICKED: 'Keep',
      REJECTED: 'Reject',
      UNMARKED: 'Undecided',
      ORPHANS: 'Orphans',
      AI_REVIEW: 'AI Review',
      AI_NORMAL: 'AI Clear',
      AI_PICKED: 'AI Picks',
      GROUP_PHOTO: 'Group Portraits',
      DUPLICATES: 'Duplicates',
    },
    ratingAll: 'All ratings',
    unrated: 'Unrated',
    onePlus: '1+ stars',
    twoPlus: '2+ stars',
    threePlus: '3+ stars',
    fourPlus: '4+ stars',
    fiveOnly: '5 stars',
    filterButton: 'Filter',
    statusFilter: 'Status',
    ratingFilter: 'Rating',
    duplicateBest: 'Best',
    aiPickedBadge: 'Pick',
  },
};

const statusOrder: PhotoFilter[] = ['ALL', 'AI_NORMAL', 'AI_PICKED', 'AI_REVIEW', 'GROUP_PHOTO', 'DUPLICATES', 'PICKED', 'REJECTED', 'UNMARKED', 'ORPHANS'];

type RatingLabelKey = 'ratingAll' | 'unrated' | 'onePlus' | 'twoPlus' | 'threePlus' | 'fourPlus' | 'fiveOnly';

const ratingOptions: Array<{ value: PhotoRatingFilter; labelKey: RatingLabelKey }> = [
  { value: 'RATING_ALL', labelKey: 'ratingAll' },
  { value: 'RATING_NONE', labelKey: 'unrated' },
  { value: 'RATING_1_PLUS', labelKey: 'onePlus' },
  { value: 'RATING_2_PLUS', labelKey: 'twoPlus' },
  { value: 'RATING_3_PLUS', labelKey: 'threePlus' },
  { value: 'RATING_4_PLUS', labelKey: 'fourPlus' },
  { value: 'RATING_5', labelKey: 'fiveOnly' },
];

export const Filmstrip: React.FC<FilmstripProps> = ({
  theme,
  filteredPhotos,
  selectedIndex,
  selectedPhotoIds,
  filter,
  ratingFilter,
  stats,
  onSelectPhoto,
  onFilterChange,
  onRatingFilterChange,
  duplicateBestPhotoIds,
  aiPickedPhotoIds,
  showAiPickedBadge = false,
  language,
}) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const filterControlRef = useRef<HTMLDivElement>(null);
  const centerScrollFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const renderScrollTopRef = useRef(0);
  const latestScrollTopRef = useRef(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [visualActiveIndex, setVisualActiveIndex] = useState<number | null>(selectedIndex);
  const selectedSet = useMemo(() => new Set(selectedPhotoIds), [selectedPhotoIds]);
  const text = labels[language];
  const virtualRange = useMemo(
    () => getVirtualRange(
      filteredPhotos.length,
      scrollTop,
      viewportHeight,
      DEFAULT_FILMSTRIP_ITEM_HEIGHT,
      DEFAULT_FILMSTRIP_OVERSCAN,
    ),
    [filteredPhotos.length, scrollTop, viewportHeight],
  );
  const visiblePhotos = useMemo(
    () => filteredPhotos.slice(virtualRange.startIndex, virtualRange.endIndex),
    [filteredPhotos, virtualRange.endIndex, virtualRange.startIndex],
  );

  const syncRenderedScrollTop = useCallback((nextScrollTop: number, force = false) => {
    latestScrollTopRef.current = nextScrollTop;

    if (!force && !shouldSyncVirtualScroll(renderScrollTopRef.current, nextScrollTop, DEFAULT_FILMSTRIP_ITEM_HEIGHT)) {
      return;
    }

    renderScrollTopRef.current = nextScrollTop;
    setScrollTop(nextScrollTop);
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;

    const updateViewport = () => {
      setViewportHeight(strip.clientHeight);
      latestScrollTopRef.current = strip.scrollTop;
      renderScrollTopRef.current = strip.scrollTop;
    };
    updateViewport();

    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(strip);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || selectedIndex === null || viewportHeight <= 0) return;

    if (centerScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(centerScrollFrameRef.current);
    }

    centerScrollFrameRef.current = window.requestAnimationFrame(() => {
      centerScrollFrameRef.current = null;
      const nextScrollTop = getSelectionTrackingScrollTop(
        selectedIndex,
        latestScrollTopRef.current || strip.scrollTop,
        strip.clientHeight,
        filteredPhotos.length,
        DEFAULT_FILMSTRIP_ITEM_HEIGHT,
        0.62,
        1.1,
      );
      if (Math.abs(nextScrollTop - strip.scrollTop) > 1) {
        strip.scrollTop = nextScrollTop;
      }
      syncRenderedScrollTop(nextScrollTop, true);
    });
  }, [filteredPhotos.length, selectedIndex, syncRenderedScrollTop, viewportHeight]);

  useEffect(() => {
    setVisualActiveIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => () => {
    if (centerScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(centerScrollFrameRef.current);
    }
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!filterOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!filterControlRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFilterOpen(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [filterOpen]);

  return (
    <aside className={`relative flex h-full w-[176px] shrink-0 flex-col border-r xl:w-[188px] ${
      theme === 'dark'
        ? chromeSolid.dark
        : chromeSolid.light
    }`}>
      <div className={`shrink-0 border-b px-2.5 py-1.5 ${theme === 'dark' ? 'border-white/10' : 'border-slate-400/30'}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <div className={`truncate text-[14px] font-semibold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-950'}`}>
              {text.filters[filter]}
            </div>
            <div className={`shrink-0 text-[11px] font-medium tabular-nums ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
              {countForFilter(filter, stats)}
            </div>
            {selectedPhotoIds.length > 1 && (
              <div className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                theme === 'dark'
                  ? 'bg-sky-300/12 text-sky-100'
                  : 'bg-sky-100/80 text-sky-800'
              }`}>
                {language === 'zh' ? `已选 ${selectedPhotoIds.length}` : `${selectedPhotoIds.length} selected`}
              </div>
            )}
          </div>
          <div ref={filterControlRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setFilterOpen(open => !open)}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                filterOpen
                  ? theme === 'dark'
                    ? glassActive.dark
                    : glassActive.light
                  : theme === 'dark'
                    ? glassInteractive.dark
                    : glassInteractive.light
              }`}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              title={text.filterButton}
            >
              <AppIcon icon={Filter} className="h-4 w-4" />
            </button>

            {filterOpen && (
              <div className={`absolute right-0 top-[calc(100%+8px)] z-50 max-h-[calc(100vh-120px)] w-[168px] overflow-y-auto rounded-lg border p-1.5 ${
                theme === 'dark'
                  ? glassPopover.dark
                  : glassPopover.light
              }`}>
                <p className={`px-2 pb-1.5 text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-700'}`}>
                  {text.statusFilter}
                </p>
                <div className="space-y-0.5">
                  {statusOrder.map(statusFilter => (
                    <FilterMenuRow
                      key={statusFilter}
                      active={filter === statusFilter}
                      label={text.filters[statusFilter]}
                      count={countForFilter(statusFilter, stats)}
                      theme={theme}
                      onClick={() => {
                        onFilterChange(statusFilter);
                        setFilterOpen(false);
                      }}
                    />
                  ))}
                </div>

                <div className={`mt-2 border-t pt-2 ${theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-400/24'}`}>
                  <p className={`px-2 pb-1.5 text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-700'}`}>
                    {text.ratingFilter}
                  </p>
                  <div className="space-y-0.5">
                    {ratingOptions.map(option => (
                      <FilterMenuRow
                        key={option.value}
                        active={ratingFilter === option.value}
                        label={text[option.labelKey]}
                        theme={theme}
                        onClick={() => {
                          onRatingFilterChange(option.value);
                          setFilterOpen(false);
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={stripRef}
          className="h-full overflow-y-auto px-2.5 py-1.5"
          onScroll={event => {
            const strip = event.currentTarget;
            if (scrollFrameRef.current !== null) return;
            scrollFrameRef.current = window.requestAnimationFrame(() => {
              scrollFrameRef.current = null;
              syncRenderedScrollTop(strip.scrollTop);
            });
          }}
        >
          <div
            className="relative"
            style={{ height: filteredPhotos.length * DEFAULT_FILMSTRIP_ITEM_HEIGHT }}
          >
            {visiblePhotos.map((photo, offset) => {
              const index = virtualRange.startIndex + offset;
              return (
                <div
                  key={photo.id}
                  className={`absolute inset-x-0 px-0.5 py-1 transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
                    visualActiveIndex === index ? 'z-10' : 'z-0'
                  }`}
                  style={{
                    top: index * DEFAULT_FILMSTRIP_ITEM_HEIGHT,
                    height: DEFAULT_FILMSTRIP_ITEM_HEIGHT,
                    contain: 'layout paint style',
                  }}
                >
                  <ThumbnailCard
                    photo={photo}
                    index={index}
                    active={visualActiveIndex === index}
                    selected={selectedPhotoIds.length > 1 && selectedSet.has(photo.id)}
                    duplicateBest={duplicateBestPhotoIds?.has(photo.id) ?? false}
                    aiPicked={showAiPickedBadge && (aiPickedPhotoIds?.has(photo.id) ?? false)}
                    eager={shouldEagerLoadThumbnail(index, selectedIndex)}
                    theme={theme}
                    language={language}
                    onSelectPhoto={onSelectPhoto}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
};

const ThumbnailCard = React.memo(({
  photo,
  index,
  active,
  selected,
  duplicateBest,
  aiPicked,
  eager,
  theme,
  language,
  onSelectPhoto,
}: {
  photo: PhotoGroup;
  index: number;
  active: boolean;
  selected: boolean;
  duplicateBest: boolean;
  aiPicked: boolean;
  eager: boolean;
  theme: 'light' | 'dark';
  language: Language;
  onSelectPhoto: (index: number, mode?: 'replace' | 'toggle' | 'range') => void;
}) => {
  const issues = photo.ai?.issues ?? [];
  const isAnalyzing = photo.ai?.status === 'ANALYZING';
  const issueSummary = issues
    .map(issue => `${aiIssueLabel(issue.code, language, issue.level)} ${formatConfidence(issue.confidence)}`)
    .join(', ');

  return (
    <button
      onClick={event => {
        const mode = event.shiftKey ? 'range' : (event.ctrlKey || event.metaKey) ? 'toggle' : 'replace';
        onSelectPhoto(index, mode);
      }}
      className={`group relative block h-full w-full transform-gpu rounded-md text-left transition-[opacity,transform] duration-[240ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-transform motion-reduce:transition-none ${
        active
          ? theme === 'dark'
            ? 'z-10 -translate-y-0.5 scale-[1.016] opacity-100'
            : 'z-10 -translate-y-0.5 scale-[1.016] opacity-100'
          : selected
            ? theme === 'dark'
              ? 'opacity-100'
              : 'opacity-100'
            : theme === 'dark'
              ? 'opacity-[0.86] hover:opacity-100'
              : 'opacity-90 hover:opacity-100'
      }`}
      title={issueSummary ? `${photo.id} - ${issueSummary}` : photo.id}
    >
      {active && (
        <span
          className={`filmstrip-active-rail pointer-events-none absolute left-0 top-2 z-20 h-6 w-[3px] rounded-full ${
            theme === 'dark'
              ? 'bg-sky-300 shadow-[0_0_8px_rgba(125,211,252,0.44)]'
              : 'bg-sky-600 shadow-[0_0_7px_rgba(2,132,199,0.22)]'
          }`}
        />
      )}

      <div className={`relative overflow-hidden rounded-lg transition-[filter,box-shadow,transform] duration-[240ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
        active
          ? theme === 'dark'
            ? 'shadow-[0_12px_20px_rgba(0,0,0,0.22)]'
            : 'shadow-[0_10px_16px_rgba(15,23,42,0.10)]'
          : selected
            ? theme === 'dark'
              ? 'shadow-[0_0_0_1.5px_rgba(226,232,240,0.58),0_0_0_4px_rgba(148,163,184,0.10)]'
              : 'shadow-[0_0_0_1.5px_rgba(51,65,85,0.42),0_0_0_4px_rgba(148,163,184,0.14)]'
            : 'shadow-none'
      }`}>
        <div className="relative aspect-[16/9] overflow-hidden rounded-lg">
          <LazyThumbnail group={photo} isVisible={active || selected || eager} />

          {active && (
            <span
              className={`pointer-events-none absolute inset-0 rounded-[inherit] ${
                theme === 'dark'
                  ? 'shadow-[inset_0_0_0_1.5px_rgba(125,211,252,0.74),0_0_0_3px_rgba(125,211,252,0.09)]'
                  : 'shadow-[inset_0_0_0_1.5px_rgba(2,132,199,0.64),0_0_0_3px_rgba(2,132,199,0.08)]'
              }`}
            />
          )}
        </div>

        {(active || selected) && (
          <span
            className={`pointer-events-none absolute inset-0 transition-opacity duration-[220ms] ease-out ${
              active
                ? theme === 'dark'
                  ? 'bg-white/[0.085]'
                  : 'bg-white/[0.16]'
                : theme === 'dark'
                  ? 'bg-white/[0.035]'
                  : 'bg-white/[0.08]'
            }`}
          />
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-[linear-gradient(180deg,transparent_0%,rgba(0,0,0,0.66)_100%)] px-1.5 pb-1 pt-6">
          <div className="flex items-center gap-0.5">
            {Array.from({ length: 5 }, (_, star) => star + 1).map(star => (
              <i
                key={star}
                className={`${(photo.rating ?? 0) >= star ? 'fa-solid text-white' : 'fa-regular text-white/32'} fa-star text-[7px]`}
              />
            ))}
          </div>
          <span className="rounded-full bg-black/28 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white/86">
            {photo.raw ? 'RAW' : 'JPG'}
          </span>
        </div>

        {(issues.length > 0 || isAnalyzing || duplicateBest || aiPicked) && (
          <div className="pointer-events-none absolute inset-x-1.5 top-1.5 flex items-start justify-between gap-1.5">
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
              {issues.length > 0 && issues.slice(0, 2).map(issue => (
                <ThumbnailIssueBadge
                  key={`${issue.code}-${issue.level}`}
                  issue={issue}
                  language={language}
                />
              ))}
              {isAnalyzing && (
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-sky-400 text-zinc-950 shadow-lg">
                  <i className="fa-solid fa-spinner fa-spin text-[9px]"></i>
                </div>
              )}
            </div>

            {duplicateBest ? (
              <ThumbnailTopBadge
                icon={Trophy}
                label={labels[language].duplicateBest}
                tone="duplicate"
                theme={theme}
              />
            ) : aiPicked ? (
              <ThumbnailTopBadge
                icon={BadgeCheck}
                label={labels[language].aiPickedBadge}
                tone="ai"
                theme={theme}
              />
            ) : null}
          </div>
        )}

        {photo.selection === SelectionState.PICKED && (
          <div className={`absolute left-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-emerald-400 text-[8px] text-zinc-950 shadow-lg ${issues.length > 0 || isAnalyzing ? 'top-7' : 'top-1.5'}`}>
            <i className="fa-solid fa-flag"></i>
          </div>
        )}
        {photo.selection === SelectionState.REJECTED && (
          <div className={`absolute left-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-rose-400 text-[8px] text-white shadow-lg ${issues.length > 0 || isAnalyzing ? 'top-7' : 'top-1.5'}`}>
            <i className="fa-solid fa-trash"></i>
          </div>
        )}
      </div>

      <div className="pt-0.5">
        <div className={`truncate text-[11px] font-medium ${active ? theme === 'dark' ? 'text-sky-100' : 'text-sky-800' : theme === 'dark' ? 'text-zinc-300' : 'text-slate-900'}`}>
          {photo.id}
        </div>
      </div>
    </button>
  );
}, (previous, next) => (
  previous.photo === next.photo
  && previous.index === next.index
  && previous.active === next.active
  && previous.selected === next.selected
  && previous.duplicateBest === next.duplicateBest
  && previous.aiPicked === next.aiPicked
  && previous.eager === next.eager
  && previous.theme === next.theme
  && previous.language === next.language
  && previous.onSelectPhoto === next.onSelectPhoto
));

function shouldEagerLoadThumbnail(index: number, selectedIndex: number | null) {
  if (index < 14) return true;
  if (selectedIndex === null) return false;
  return Math.abs(index - selectedIndex) <= 24;
}

const FilterMenuRow = ({
  active,
  label,
  count,
  theme,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  theme: 'light' | 'dark';
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-[12px] font-medium transition-all duration-150 ease-out active:scale-[0.99] ${
      active
        ? theme === 'dark'
          ? 'bg-white/[0.075] text-zinc-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]'
          : 'bg-white/64 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.92),inset_0_-1px_0_rgba(15,23,42,0.06),0_4px_12px_rgba(15,23,42,0.08)]'
        : theme === 'dark'
          ? 'text-zinc-200 hover:bg-white/[0.045] hover:text-zinc-50'
          : 'text-slate-800 hover:bg-white/44 hover:text-slate-950'
    }`}
  >
    <span className="truncate">{label}</span>
    {typeof count === 'number' && (
      <span className={`font-mono text-[11px] ${active ? '' : theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}`}>
        {count}
      </span>
    )}
  </button>
);

const ThumbnailIssueBadge = ({
  issue,
  language,
}: {
  issue: NonNullable<PhotoGroup['ai']>['issues'][number];
  language: Language;
}) => (
  <span className="flex h-5 max-w-full min-w-0 items-center gap-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-medium text-zinc-950 shadow-[0_2px_6px_rgba(0,0,0,0.2)]">
    <i className={`fa-solid ${aiIssueIcon(issue.code)} shrink-0 text-[9px]`}></i>
    <span className="min-w-0 truncate">{aiIssueLabel(issue.code, language, issue.level)}</span>
  </span>
);

const ThumbnailTopBadge = ({
  icon,
  label,
  tone,
  theme,
}: {
  icon: typeof Trophy;
  label: string;
  tone: 'duplicate' | 'ai';
  theme: 'light' | 'dark';
}) => (
  <div className={`inline-flex h-5 max-w-[62px] shrink-0 items-center gap-1 rounded-full px-1.5 text-[9px] font-semibold ${
    tone === 'duplicate'
      ? theme === 'dark'
        ? 'bg-amber-300 text-black'
        : 'bg-amber-300 text-zinc-950'
      : theme === 'dark'
        ? 'bg-cyan-300 text-zinc-950'
        : 'bg-cyan-500 text-white'
  }`}>
    <AppIcon icon={icon} className="h-3 w-3 shrink-0" />
    <span className="min-w-0 truncate">{label}</span>
  </div>
);

function countForFilter(filter: PhotoFilter, stats: FilmstripProps['stats']) {
  switch (filter) {
    case 'PICKED':
      return stats.picked;
    case 'REJECTED':
      return stats.rejected;
    case 'UNMARKED':
      return stats.unmarked;
    case 'ORPHANS':
      return stats.orphans;
    case 'AI_REVIEW':
      return stats.aiReview;
    case 'AI_NORMAL':
      return stats.aiNormal;
    case 'AI_PICKED':
      return stats.aiPicked;
    case 'GROUP_PHOTO':
      return stats.groupPhoto;
    case 'DUPLICATES':
      return stats.duplicates;
    case 'ALL':
    default:
      return stats.total;
  }
}
