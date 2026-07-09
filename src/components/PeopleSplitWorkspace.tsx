import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, Filter, Loader2, Merge, Play, RefreshCw, Search, Square, SquareCheck, StopCircle, UserPlus, UserRound, UsersRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SelectionState, type PeopleSplitState, type PersonCluster, type PersonFaceEmbedding, type PhotoFilter, type PhotoGroup, type PhotoRating, type PhotoRatingFilter } from '../types';
import { Language } from '../i18n';
import { AppIcon } from './ui/AppIcon';
import { glassActive, glassInteractive, glassPopover, glassSurface } from './ui/chrome';
import { getCachedJpegThumbnail, loadJpegThumbnail, preloadJpegThumbnail } from '../utils/jpegThumbnailLoader';
import { decodeRawFile, getThumbnailFromCache } from '../utils/rawLoader';
import { aiIssueLabel } from '../utils/aiLabels';
import { isAiReviewPhoto, matchesRatingFilter, matchesStatusFilter, RATING_FILTERS, STATUS_FILTERS } from '../utils/photoFilters';
import Viewer, { type ViewerAiMode } from './Viewer';
import { formatElapsedTime } from './AiFloatingPanel';

interface PeopleSplitWorkspaceProps {
  theme: 'light' | 'dark';
  language: Language;
  photos: PhotoGroup[];
  state: PeopleSplitState;
  selectedClusters: PersonCluster[];
  onStart: () => void;
  onStop: () => void;
  onRenameCluster: (clusterId: string, displayName: string) => void;
  onMergeClusters: (sourceIds: string[], targetId: string) => void;
  onMoveFace: (faceKey: string, targetClusterId: string | 'UNASSIGNED') => void;
  onCreatePersonFromFace: (faceKey: string) => string | undefined;
  onToggleClusterSelection: (clusterId: string) => void;
  onSetSelectedClusterIds: (clusterIds: string[]) => void;
  onExportSelected: () => void;
  aiViewMode: ViewerAiMode;
  onAiViewModeChange: (mode: ViewerAiMode) => void;
  onFocusPhoto?: (photoId: string) => void;
  onUpdatePhotoSelection: (photoId: string, state: SelectionState) => void;
  onUpdatePhotoRating: (photoId: string, rating: PhotoRating) => void | Promise<void>;
}

const copy = {
  zh: {
    title: '人物分片',
    subtitle: '在当前导入批次内自动聚类人物，支持命名、合并、拆分和按人物导出。',
    start: '开始分析',
    rerun: '重新聚类',
    stop: '停止',
    exportSelected: '导出选中人物',
    selectAll: '全选人物',
    clearSelection: '取消选择',
    mergeToActive: '合并到当前人物',
    people: '人物',
    photos: '张照片',
    faces: '张脸',
    unnamed: '未命名人物',
    renamePlaceholder: '输入人物名称',
    unassigned: '未归类人脸',
    unassignedHint: '低质量、裁切或过小的人脸会先放在这里，可以手动拆出或移动到已有人物。',
    emptyTitle: '还没有人物分片结果',
    emptyDescription: '点击开始分析后，FrameCull AI 会在后台检测当前批次的人脸并聚类同一人物。',
    errorTitle: '人物分片分析失败',
    noClusterTitle: '未生成可用人物组',
    noClusterDescription: '已完成分析，但没有检测到足够稳定的人脸样本。可以先运行 AI 筛图，再重新聚类。',
    runningTitle: '正在分析当前批次',
    runningDescription: '这是独立任务，不会并入 AI 筛图主循环。可以继续查看照片。',
    elapsed: '已用时间',
    remaining: '预计剩余',
    noEstimate: '--',
    activePerson: '当前人物',
    photoGrid: '人物照片',
    faceList: '人脸样本',
    moveTo: '移动',
    moveUnassigned: '移到未归类',
    splitOut: '拆出为新人物',
    rawPreviewing: 'RAW 预览中',
    previewUnavailable: '预览不可用',
    selected: '已选',
    backToGrid: '返回人物照片',
    openPhoto: '打开审片',
    faceFilter: '筛选人脸',
    faceFilterAll: '全部人脸',
    faceFilterSelected: '已勾选',
    faceFilterAiReview: 'AI 待复查',
    faceFilterUnassigned: '未归类',
    aiReviewBadge: 'AI 复查',
  },
  en: {
    title: 'People Split',
    subtitle: 'Cluster people in the current import batch, then rename, merge, and export JPGs by person.',
    start: 'Start analysis',
    rerun: 'Re-cluster',
    stop: 'Stop',
    exportSelected: 'Export selected',
    selectAll: 'Select all',
    clearSelection: 'Clear selection',
    mergeToActive: 'Merge into active',
    people: 'People',
    photos: 'photos',
    faces: 'faces',
    unnamed: 'Unnamed person',
    renamePlaceholder: 'Person name',
    unassigned: 'Unassigned',
    unassignedHint: 'Low-quality, cropped, or tiny faces stay here first.',
    emptyTitle: 'No people split yet',
    emptyDescription: 'Start analysis to detect faces and cluster the same person inside this import batch.',
    errorTitle: 'People split failed',
    noClusterTitle: 'No usable people groups',
    noClusterDescription: 'Analysis finished, but no stable face samples were detected. Run AI culling first, then re-cluster.',
    runningTitle: 'Analyzing current batch',
    runningDescription: 'This is a separate task and does not run inside the AI culling loop. You can keep browsing.',
    elapsed: 'Elapsed',
    remaining: 'Remaining',
    noEstimate: '--',
    activePerson: 'Active person',
    photoGrid: 'Person photos',
    faceList: 'Face samples',
    moveTo: 'Move to',
    moveUnassigned: 'Move to unassigned',
    splitOut: 'New person',
    rawPreviewing: 'Preparing RAW',
    previewUnavailable: 'Preview unavailable',
    selected: 'selected',
    backToGrid: 'Back to grid',
    openPhoto: 'Open photo',
    faceFilter: 'Filter faces',
    faceFilterAll: 'All faces',
    faceFilterSelected: 'Selected',
    faceFilterAiReview: 'AI review',
    faceFilterUnassigned: 'Unassigned',
    aiReviewBadge: 'AI review',
  },
};

const photoFilterCopy = {
  zh: {
    filters: {
      ALL: '全部照片',
      PICKED: '保留',
      REJECTED: '弃用',
      UNMARKED: '未决',
      ORPHANS: '单文件',
      AI_REVIEW: 'AI 待复查',
      AI_NORMAL: 'AI 正常',
      AI_PICKED: 'AI 精选',
      GROUP_PHOTO: '合照',
    },
    ratingAll: '全部星级',
    unrated: '未评星',
    onePlus: '1 星+',
    twoPlus: '2 星+',
    threePlus: '3 星+',
    fourPlus: '4 星+',
    fiveOnly: '5 星',
    filterButton: '筛选',
    statusFilter: '状态',
    ratingFilter: '星级',
    noFilteredPhotos: '当前筛选下没有照片',
    selectedPhotoFaces: '当前照片人脸',
    noSelectedPhoto: '选择一张预览图查看画面中的人脸',
    unassignedFace: '未归类',
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
    noFilteredPhotos: 'No photos match this filter',
    selectedPhotoFaces: 'Faces in selected photo',
    noSelectedPhoto: 'Select a preview photo to inspect its faces',
    unassignedFace: 'Unassigned',
  },
};

type PeoplePhotoFilter = Exclude<PhotoFilter, 'DUPLICATES' | 'AI_PICKED'>;
type PeoplePhotoStats = Record<PeoplePhotoFilter, number>;

const PEOPLE_STATUS_FILTERS: PeoplePhotoFilter[] = STATUS_FILTERS.filter(
  (filter): filter is PeoplePhotoFilter => filter !== 'DUPLICATES' && filter !== 'AI_PICKED',
);

const EMPTY_FACES: PersonFaceEmbedding[] = [];
const PEOPLE_TILE_THUMBNAIL_EDGE = 520;
const PEOPLE_PRELOAD_AHEAD = 12;
const PEOPLE_PRELOAD_BEHIND = 5;

export const PeopleSplitWorkspace: React.FC<PeopleSplitWorkspaceProps> = ({
  theme,
  language,
  photos,
  state,
  selectedClusters,
  onStart,
  onStop,
  onRenameCluster,
  onMergeClusters,
  onMoveFace,
  onCreatePersonFromFace,
  onToggleClusterSelection,
  onSetSelectedClusterIds,
  onExportSelected,
  aiViewMode,
  onAiViewModeChange,
  onFocusPhoto,
  onUpdatePhotoSelection,
  onUpdatePhotoRating,
}) => {
  const text = copy[language];
  const isDark = theme === 'dark';
  const [activeClusterId, setActiveClusterId] = useState<string | null>(state.clusters[0]?.id ?? null);
  const [renameDraft, setRenameDraft] = useState('');
  const [focusedPhotoId, setFocusedPhotoId] = useState<string | null>(null);
  const [selectedPreviewPhotoId, setSelectedPreviewPhotoId] = useState<string | null>(null);
  const [selectedFaceKeys, setSelectedFaceKeys] = useState<string[]>([]);
  const [photoFilter, setPhotoFilter] = useState<PeoplePhotoFilter>('ALL');
  const [ratingFilter, setRatingFilter] = useState<PhotoRatingFilter>('RATING_ALL');
  const [photoFilterOpen, setPhotoFilterOpen] = useState(false);
  const [timeNow, setTimeNow] = useState(() => Date.now());
  const activePersonButtonRef = useRef<HTMLButtonElement | null>(null);
  const photoGridScrollRef = useRef<HTMLDivElement | null>(null);
  const activeCluster = state.clusters.find(cluster => cluster.id === activeClusterId) ?? state.clusters[0] ?? null;
  const faceMap = useMemo(() => new Map(state.faces.map(face => [face.key, face])), [state.faces]);
  const photoMap = useMemo(() => new Map(photos.map(photo => [photo.id, photo])), [photos]);
  const clusterByFaceKey = useMemo(() => {
    const map = new Map<string, PersonCluster>();
    state.clusters.forEach(cluster => {
      cluster.memberFaceKeys.forEach(key => map.set(key, cluster));
    });
    return map;
  }, [state.clusters]);
  const activeFaces = useMemo(
    () => activeCluster ? activeCluster.memberFaceKeys.map(key => faceMap.get(key)).filter((face): face is PersonFaceEmbedding => Boolean(face)) : [],
    [activeCluster, faceMap],
  );
  const activeFacesByPhotoId = useMemo(() => {
    const map = new Map<string, PersonFaceEmbedding[]>();
    activeFaces.forEach(face => {
      const faces = map.get(face.photoId);
      if (faces) {
        faces.push(face);
      } else {
        map.set(face.photoId, [face]);
      }
    });
    return map;
  }, [activeFaces]);
  const activePhotos = useMemo(
    () => activeCluster ? activeCluster.photoIds.map(id => photoMap.get(id)).filter((photo): photo is PhotoGroup => Boolean(photo)) : [],
    [activeCluster, photoMap],
  );
  const activePhotoStats = useMemo(() => buildPeoplePhotoStats(activePhotos), [activePhotos]);
  const filteredActivePhotos = useMemo(
    () => activePhotos.filter(photo => matchesStatusFilter(photo, photoFilter) && matchesRatingFilter(photo, ratingFilter)),
    [activePhotos, photoFilter, ratingFilter],
  );
  const selectedPreviewPhoto = selectedPreviewPhotoId ? photoMap.get(selectedPreviewPhotoId) ?? null : null;
  const focusedPhoto = focusedPhotoId ? photoMap.get(focusedPhotoId) ?? null : null;
  const selectedFaceKeySet = useMemo(() => new Set(selectedFaceKeys), [selectedFaceKeys]);
  const selectedPreviewFaces = useMemo(
    () => selectedPreviewPhotoId
      ? state.faces.filter(face => face.photoId === selectedPreviewPhotoId)
      : [],
    [selectedPreviewPhotoId, state.faces],
  );
  const progressPercent = state.totalPhotos > 0
    ? state.status === 'RUNNING'
      ? Math.min(99, Math.floor((state.processedPhotos / state.totalPhotos) * 100))
      : Math.round((state.processedPhotos / state.totalPhotos) * 100)
    : 0;
  const peopleElapsedMs = state.status === 'RUNNING' && state.startedAt
    ? Math.max(0, timeNow - state.startedAt)
    : state.elapsedMs ?? 0;
  const peopleRemainingMs = estimatePeopleRemainingMs(peopleElapsedMs, state.processedPhotos, state.totalPhotos);

  useEffect(() => {
    if (!activeClusterId && state.clusters[0]) setActiveClusterId(state.clusters[0].id);
    if (activeClusterId && !state.clusters.some(cluster => cluster.id === activeClusterId)) {
      setActiveClusterId(state.clusters[0]?.id ?? null);
    }
  }, [activeClusterId, state.clusters]);

  useEffect(() => {
    setRenameDraft(activeCluster?.displayName ?? '');
  }, [activeCluster?.displayName, activeCluster?.id]);

  useEffect(() => {
    const availableKeys = new Set(state.faces.map(face => face.key));
    setSelectedFaceKeys(prev => prev.filter(key => availableKeys.has(key)));
  }, [state.faces]);

  useEffect(() => {
    setPhotoFilterOpen(false);
  }, [activeCluster?.id, photoFilter, ratingFilter]);

  useEffect(() => {
    activePersonButtonRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeCluster?.id]);

  useEffect(() => {
    if (state.status !== 'RUNNING') return undefined;
    setTimeNow(Date.now());
    const timer = window.setInterval(() => setTimeNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.status]);

  useEffect(() => {
    if (!activeCluster) {
      setSelectedPreviewPhotoId(null);
      return;
    }
    if (selectedPreviewPhotoId && activePhotos.some(photo => photo.id === selectedPreviewPhotoId)) {
      return;
    }
    setSelectedPreviewPhotoId(filteredActivePhotos[0]?.id ?? activePhotos[0]?.id ?? null);
  }, [activeCluster, activePhotos, filteredActivePhotos, selectedPreviewPhotoId]);

  useEffect(() => {
    if (!focusedPhotoId) return;
    if (!activePhotos.some(photo => photo.id === focusedPhotoId)) {
      setFocusedPhotoId(null);
    }
  }, [activePhotos, focusedPhotoId]);

  useEffect(() => {
    if (filteredActivePhotos.length === 0) return;
    const selectedIndex = selectedPreviewPhotoId
      ? filteredActivePhotos.findIndex(photo => photo.id === selectedPreviewPhotoId)
      : 0;
    const index = selectedIndex >= 0 ? selectedIndex : 0;
    preloadPeoplePreviewWindow(filteredActivePhotos, index);
  }, [filteredActivePhotos, selectedPreviewPhotoId]);

  const handleSelectPreviewPhoto = useCallback((photoId: string) => {
    setSelectedPreviewPhotoId(photoId);
  }, []);

  const handleOpenPreviewPhoto = useCallback((photoId: string) => {
    setSelectedPreviewPhotoId(photoId);
    setFocusedPhotoId(photoId);
    onFocusPhoto?.(photoId);
  }, [onFocusPhoto]);

  useEffect(() => {
    if (!focusedPhoto) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.preventDefault();
        onUpdatePhotoSelection(focusedPhoto.id, SelectionState.PICKED);
        return;
      }
      if (key === 'x') {
        event.preventDefault();
        onUpdatePhotoSelection(focusedPhoto.id, SelectionState.REJECTED);
        return;
      }
      if (key === 'u') {
        event.preventDefault();
        onUpdatePhotoSelection(focusedPhoto.id, SelectionState.UNMARKED);
        return;
      }
      if (/^[0-5]$/.test(key)) {
        event.preventDefault();
        void onUpdatePhotoRating(focusedPhoto.id, Number(key) as PhotoRating);
        return;
      }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && activePhotos.length > 0) {
        event.preventDefault();
        const currentIndex = activePhotos.findIndex(photo => photo.id === focusedPhoto.id);
        const fallbackIndex = currentIndex === -1 ? 0 : currentIndex;
        const nextIndex = event.key === 'ArrowRight'
          ? (fallbackIndex + 1) % activePhotos.length
          : (fallbackIndex - 1 + activePhotos.length) % activePhotos.length;
        const nextPhoto = activePhotos[nextIndex];
        if (nextPhoto) {
          setFocusedPhotoId(nextPhoto.id);
          onFocusPhoto?.(nextPhoto.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activePhotos, focusedPhoto, onFocusPhoto, onUpdatePhotoRating, onUpdatePhotoSelection]);

  const selectedIds = new Set(state.selectedClusterIds);
  const canMerge = activeCluster && state.selectedClusterIds.filter(id => id !== activeCluster.id).length > 0;
  const toggleFaceSelection = (faceKey: string) => {
    setSelectedFaceKeys(prev => (
      prev.includes(faceKey)
        ? prev.filter(key => key !== faceKey)
        : [...prev, faceKey]
    ));
  };
  const focusClusterForFace = (faceKey: string) => {
    const cluster = clusterByFaceKey.get(faceKey);
    if (!cluster) return;
    setActiveClusterId(cluster.id);
    setFocusedPhotoId(null);
  };

  return (
    <div className={`flex h-full min-h-0 flex-col ${isDark ? 'bg-[#151517]' : 'bg-slate-100'}`}>
      <header className={`flex h-[58px] shrink-0 items-center justify-between border-b px-4 ${
        isDark ? 'border-white/[0.06] bg-[#17191d]/[0.72]' : 'border-slate-300/70 bg-slate-200/84'
      }`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AppIcon icon={UsersRound} className={`h-4 w-4 ${isDark ? 'text-cyan-200' : 'text-cyan-700'}`} />
            <h1 className={`text-[15px] font-semibold ${isDark ? 'text-zinc-50' : 'text-slate-950'}`}>{text.title}</h1>
            {state.status === 'DONE' && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                isDark ? 'bg-white/[0.06] text-zinc-300' : 'bg-white/70 text-slate-700'
              }`}>
                {state.clusters.length} {text.people}
              </span>
            )}
          </div>
          <p className={`mt-0.5 truncate text-[12px] ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
            {text.subtitle}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {state.status === 'RUNNING' ? (
            <button
              type="button"
              onClick={onStop}
              className={`flex h-8 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-colors ${
                isDark ? 'bg-rose-300/12 text-rose-100 hover:bg-rose-300/18' : 'bg-rose-100 text-rose-700 hover:bg-rose-200'
              }`}
            >
              <AppIcon icon={StopCircle} className="h-4 w-4" />
              {text.stop}
            </button>
          ) : (
            <button
              type="button"
              onClick={state.status === 'DONE' ? onStart : onStart}
              disabled={photos.length === 0}
              className={`flex h-8 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-colors disabled:opacity-35 ${
                isDark ? 'bg-cyan-300 text-zinc-950 hover:bg-cyan-200' : 'bg-cyan-600 text-white hover:bg-cyan-500'
              }`}
            >
              <AppIcon icon={state.status === 'DONE' ? RefreshCw : Play} className="h-4 w-4" />
              {state.status === 'DONE' ? text.rerun : text.start}
            </button>
          )}
          <button
            type="button"
            onClick={onExportSelected}
            disabled={selectedClusters.length === 0 || state.status === 'RUNNING'}
            className={`flex h-8 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-colors disabled:opacity-35 ${
              isDark ? 'bg-white/[0.07] text-zinc-100 hover:bg-white/[0.10]' : 'bg-white/70 text-slate-800 hover:bg-white'
            }`}
          >
            <AppIcon icon={Download} className="h-4 w-4" />
            {text.exportSelected}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className={`flex w-[278px] shrink-0 flex-col border-r ${isDark ? 'border-white/[0.06] bg-[#18181b]/[0.74]' : 'border-slate-300/70 bg-slate-200/76'}`}>
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
            <div className={`text-[12px] font-semibold ${isDark ? 'text-zinc-300' : 'text-slate-700'}`}>
              {text.people}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSetSelectedClusterIds(state.clusters.map(cluster => cluster.id))}
                className={`rounded-md px-2 py-1 text-[11px] ${isDark ? glassInteractive.dark : glassInteractive.light}`}
              >
                {text.selectAll}
              </button>
              <button
                type="button"
                onClick={() => onSetSelectedClusterIds([])}
                className={`rounded-md px-2 py-1 text-[11px] ${isDark ? glassInteractive.dark : glassInteractive.light}`}
              >
                {text.clearSelection}
              </button>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-auto px-3 pb-3">
            {state.clusters.map(cluster => {
              const cover = cluster.coverFaceKey ? faceMap.get(cluster.coverFaceKey) : undefined;
              const active = activeCluster?.id === cluster.id;
              const selected = selectedIds.has(cluster.id);
              return (
                <button
                  key={cluster.id}
                  ref={active ? activePersonButtonRef : undefined}
                  type="button"
                  onClick={() => {
                    setActiveClusterId(cluster.id);
                    setFocusedPhotoId(null);
                  }}
                  className={`relative flex min-h-[134px] w-full flex-col items-center rounded-2xl border px-2.5 pb-2.5 pt-3 text-center transition-[border-color,box-shadow,background-color,transform] duration-180 hover:-translate-y-0.5 ${
                    active
                      ? isDark
                        ? 'border-cyan-200/38 bg-white/[0.065] shadow-[0_0_0_1px_rgba(103,232,249,0.10),0_12px_26px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.055)]'
                        : 'border-cyan-600/32 bg-white/66 shadow-[0_10px_22px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.72)]'
                      : isDark
                        ? 'border-white/[0.045] bg-white/[0.025] hover:border-white/[0.075] hover:bg-white/[0.045]'
                        : 'border-slate-300/45 bg-white/42 hover:border-slate-300/70 hover:bg-white/64'
                  }`}
                >
                  <span
                    role="checkbox"
                    aria-checked={selected}
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleClusterSelection(cluster.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        onToggleClusterSelection(cluster.id);
                      }
                    }}
                    className={`absolute left-2 top-2 z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-md backdrop-blur-md ${
                      selected
                        ? isDark ? 'bg-cyan-300/12 text-cyan-200' : 'bg-white/80 text-cyan-700'
                        : isDark ? 'bg-black/18 text-zinc-600 hover:text-zinc-300' : 'bg-white/58 text-slate-400 hover:text-slate-700'
                    }`}
                  >
                    <AppIcon icon={selected ? SquareCheck : Square} className="h-4 w-4" />
                  </span>
                  <Avatar face={cover} theme={theme} size="large" />
                  <span className="mt-2 block min-w-0 max-w-full">
                    <span className={`block max-w-full truncate text-[13px] font-semibold ${isDark ? 'text-zinc-100' : 'text-slate-950'}`}>
                      {cluster.displayName || text.unnamed}
                    </span>
                    <span className={`mt-0.5 block max-w-full truncate text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                      {cluster.photoCount} {text.photos} · {cluster.faceCount} {text.faces}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className={`min-w-0 flex-1 overflow-hidden ${focusedPhoto ? 'p-0' : 'p-4'}`}>
          {state.status === 'RUNNING' ? (
            <StatusSurface
              theme={theme}
              title={text.runningTitle}
              description={text.runningDescription}
              icon={Loader2}
              progress={progressPercent}
              detail={`${state.processedPhotos}/${state.totalPhotos}${state.currentFile ? ` · ${state.currentFile}` : ''}${state.currentStage ? ` · ${state.currentStage}` : ''}`}
              metrics={[
                { label: text.elapsed, value: formatElapsedTime(peopleElapsedMs) },
                { label: text.remaining, value: peopleRemainingMs === null ? text.noEstimate : formatElapsedTime(peopleRemainingMs) },
              ]}
              spinning
            />
          ) : state.status === 'ERROR' ? (
            <StatusSurface
              theme={theme}
              title={text.errorTitle}
              description={state.error || text.noClusterDescription}
              icon={Search}
            />
          ) : state.clusters.length === 0 ? (
            <StatusSurface
              theme={theme}
              title={state.processedPhotos > 0 ? text.noClusterTitle : text.emptyTitle}
              description={state.error || (state.processedPhotos > 0 ? text.noClusterDescription : text.emptyDescription)}
              icon={Search}
            />
          ) : focusedPhoto ? (
            <div className="relative h-full min-h-0">
              <button
                type="button"
                onClick={() => setFocusedPhotoId(null)}
                className={`absolute left-3 top-3 z-40 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold shadow-[0_10px_26px_rgba(0,0,0,0.24)] backdrop-blur-2xl transition-colors ${
                  isDark
                    ? 'border border-white/[0.06] bg-[#1b1d21]/86 text-zinc-100 hover:bg-[#23262b]/92'
                    : 'border border-slate-300/45 bg-slate-200/86 text-slate-800 hover:bg-slate-100/92'
                }`}
                title={text.backToGrid}
              >
                <AppIcon icon={ArrowLeft} className="h-3.5 w-3.5" />
                {text.backToGrid}
              </button>
              <Viewer
                group={focusedPhoto}
                onUpdateSelection={(nextState) => onUpdatePhotoSelection(focusedPhoto.id, nextState)}
                onUpdateRating={(rating) => { void onUpdatePhotoRating(focusedPhoto.id, rating); }}
                theme={theme}
                language={language}
                aiViewMode={aiViewMode}
                onAiViewModeChange={onAiViewModeChange}
              />
            </div>
          ) : activeCluster ? (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className={`shrink-0 rounded-xl border px-3 py-3 ${isDark ? glassSurface.dark : glassSurface.light}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={`text-[11px] font-medium ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>{text.activePerson}</div>
                    <input
                      value={renameDraft}
                      onChange={event => setRenameDraft(event.target.value)}
                      onBlur={() => onRenameCluster(activeCluster.id, renameDraft)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.currentTarget.blur();
                        }
                      }}
                      placeholder={text.renamePlaceholder}
                      className={`mt-1 w-full bg-transparent text-[20px] font-semibold outline-none ${
                        isDark ? 'text-zinc-50 placeholder:text-zinc-600' : 'text-slate-950 placeholder:text-slate-400'
                      }`}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={!canMerge}
                      onClick={() => {
                        if (!activeCluster) return;
                        onMergeClusters(state.selectedClusterIds.filter(id => id !== activeCluster.id), activeCluster.id);
                      }}
                      className={`flex h-8 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-colors disabled:opacity-35 ${
                        isDark ? glassInteractive.dark : glassInteractive.light
                      }`}
                    >
                      <AppIcon icon={Merge} className="h-4 w-4" />
                      {text.mergeToActive}
                    </button>
                  </div>
                </div>
              </div>

              <div ref={photoGridScrollRef} className="min-h-0 flex-1 overflow-auto">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={`text-[12px] font-semibold ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                      {text.photoGrid}
                    </div>
                    <div className={`mt-0.5 text-[11px] tabular-nums ${isDark ? 'text-zinc-600' : 'text-slate-500'}`}>
                      {filteredActivePhotos.length}/{activePhotos.length}
                    </div>
                  </div>
                  <PeoplePhotoFilterControl
                    theme={theme}
                    language={language}
                    filter={photoFilter}
                    ratingFilter={ratingFilter}
                    stats={activePhotoStats}
                    open={photoFilterOpen}
                    onOpenChange={setPhotoFilterOpen}
                    onFilterChange={setPhotoFilter}
                    onRatingFilterChange={setRatingFilter}
                  />
                </div>
                {filteredActivePhotos.length > 0 ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2.5 pb-5">
                    {filteredActivePhotos.map(photo => (
                      <PhotoTile
                        key={photo.id}
                        photo={photo}
                        faces={activeFacesByPhotoId.get(photo.id) ?? EMPTY_FACES}
                        active={selectedPreviewPhotoId === photo.id}
                        theme={theme}
                        language={language}
                        rawPreviewingLabel={text.rawPreviewing}
                        previewUnavailableLabel={text.previewUnavailable}
                        openPhotoLabel={text.openPhoto}
                        aiReviewLabel={text.aiReviewBadge}
                        scrollRootRef={photoGridScrollRef}
                        onSelectPhoto={handleSelectPreviewPhoto}
                        onOpenPhoto={handleOpenPreviewPhoto}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={`flex h-[180px] items-center justify-center rounded-xl border text-[12px] ${
                    isDark ? 'border-white/[0.05] bg-black/20 text-zinc-500' : 'border-slate-300/50 bg-white/46 text-slate-500'
                  }`}>
                    {photoFilterCopy[language].noFilteredPhotos}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </section>

{!focusedPhoto && (
        <aside className={`flex w-[286px] shrink-0 flex-col border-l ${isDark ? 'border-white/[0.06] bg-[#18181b]/[0.70]' : 'border-slate-300/70 bg-slate-200/72'}`}>
          <div className="shrink-0 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className={`text-[12px] font-semibold ${isDark ? 'text-zinc-300' : 'text-slate-700'}`}>{photoFilterCopy[language].selectedPhotoFaces}</div>
                <div className={`mt-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                  {selectedPreviewPhoto ? `${selectedPreviewFaces.length} ${text.faces} · ${selectedFaceKeys.length} ${text.selected}` : photoFilterCopy[language].noSelectedPhoto}
                </div>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-3">
            {selectedPreviewPhoto && selectedPreviewFaces.length > 0 ? (
              selectedPreviewFaces.map(face => (
                <FaceRow
                  key={face.key}
                  face={face}
                  ownerCluster={clusterByFaceKey.get(face.key)}
                  unassignedLabel={photoFilterCopy[language].unassignedFace}
                  clusters={state.clusters}
                  activeClusterId={activeCluster?.id}
                  theme={theme}
                  selected={selectedFaceKeySet.has(face.key)}
                  moveToLabel={text.moveTo}
                  moveUnassignedLabel={text.moveUnassigned}
                  splitOutLabel={text.splitOut}
                  onToggleSelected={toggleFaceSelection}
                  onFocusCluster={focusClusterForFace}
                  onMoveFace={onMoveFace}
                  onCreatePersonFromFace={(faceKey) => {
                    const nextId = onCreatePersonFromFace(faceKey);
                    if (nextId) setActiveClusterId(nextId);
                  }}
                />
              ))
            ) : (
              <div className={`rounded-xl border px-3 py-8 text-center text-[12px] ${
                isDark ? 'border-white/[0.05] bg-white/[0.035] text-zinc-500' : 'border-slate-300/45 bg-white/48 text-slate-500'
              }`}>
                {selectedPreviewPhoto ? text.unassignedHint : photoFilterCopy[language].noSelectedPhoto}
              </div>
            )}
          </div>
        </aside>
        )}
      </div>
    </div>
  );
};

const Avatar: React.FC<{ face?: PersonFaceEmbedding; theme: 'light' | 'dark'; size?: 'small' | 'medium' | 'large' }> = ({ face, theme, size = 'medium' }) => {
  const sizeClass = size === 'large' ? 'h-20 w-20 rounded-2xl' : size === 'small' ? 'h-9 w-9 rounded-lg' : 'h-11 w-11 rounded-lg';
  const iconClass = size === 'large' ? 'h-8 w-8' : size === 'small' ? 'h-4 w-4' : 'h-5 w-5';
  if (face?.thumbnail) {
    return (
      <img
        src={face.thumbnail}
        alt=""
        className={`${sizeClass} shrink-0 object-cover ${theme === 'dark' ? 'bg-zinc-900' : 'bg-slate-300'}`}
        draggable={false}
      />
    );
  }
  return (
    <span className={`${sizeClass} flex shrink-0 items-center justify-center ${theme === 'dark' ? 'bg-white/[0.06] text-zinc-500' : 'bg-white/70 text-slate-500'}`}>
      <AppIcon icon={UserRound} className={iconClass} />
    </span>
  );
};

const IssueCapsule: React.FC<{
  theme: 'light' | 'dark';
  label: string;
  className?: string;
  compact?: boolean;
}> = ({ theme, label, className = '', compact }) => (
  <span
    className={`pointer-events-none rounded-full border font-semibold leading-none backdrop-blur-md ${
      compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[10px]'
    } ${
      theme === 'dark'
        ? 'border-amber-200/18 bg-amber-300/18 text-amber-100 shadow-[0_0_18px_rgba(251,191,36,0.16)]'
        : 'border-amber-600/18 bg-amber-100/88 text-amber-800 shadow-[0_6px_18px_rgba(217,119,6,0.12)]'
    } ${className}`}
  >
    {label}
  </span>
);

const PhotoPreviewSkeleton: React.FC<{
  theme: 'light' | 'dark';
  label: string;
  active: boolean;
}> = ({ theme, label, active }) => (
  <div className={`absolute inset-0 flex items-center justify-center overflow-hidden text-[11px] ${
    theme === 'dark' ? 'bg-zinc-900 text-zinc-600' : 'bg-slate-200 text-slate-500'
  }`}>
    <span className={`absolute inset-x-0 top-0 h-px ${theme === 'dark' ? 'bg-white/[0.05]' : 'bg-white/70'}`} />
    {active && (
      <span
        className={`absolute inset-y-0 w-1/3 -translate-x-full skew-x-[-16deg] motion-reduce:hidden ${
          theme === 'dark' ? 'bg-white/[0.035]' : 'bg-white/42'
        }`}
        style={{ animation: 'people-preview-sheen 1.15s ease-in-out infinite' }}
      />
    )}
    <span className="relative z-10">{label}</span>
  </div>
);

const PhotoTile = React.memo(({
  photo,
  faces,
  active,
  theme,
  language,
  rawPreviewingLabel,
  previewUnavailableLabel,
  openPhotoLabel,
  aiReviewLabel,
  scrollRootRef,
  onSelectPhoto,
  onOpenPhoto,
}: {
  photo: PhotoGroup;
  faces: PersonFaceEmbedding[];
  active: boolean;
  theme: 'light' | 'dark';
  language: Language;
  rawPreviewingLabel: string;
  previewUnavailableLabel: string;
  openPhotoLabel: string;
  aiReviewLabel: string;
  scrollRootRef: React.RefObject<HTMLDivElement | null>;
  onSelectPhoto: (photoId: string) => void;
  onOpenPhoto: (photoId: string) => void;
}) => {
  const isDark = theme === 'dark';
  const tileRef = useRef<HTMLButtonElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => getCachedPeoplePreviewUrl(photo));
  const [loadingRaw, setLoadingRaw] = useState(false);
  const [imagePainted, setImagePainted] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [nearViewport, setNearViewport] = useState(active);

  useEffect(() => {
    setNearViewport(active);
  }, [active, photo.id]);

  useEffect(() => {
    if (active) setNearViewport(true);
  }, [active]);

  useEffect(() => {
    if (nearViewport) return undefined;
    const node = tileRef.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return undefined;
    }

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, {
      root: scrollRootRef.current,
      rootMargin: '520px 0px',
      threshold: 0.01,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [nearViewport, scrollRootRef]);

  useEffect(() => {
    let disposed = false;
    const applyPreviewUrl = (url: string | null) => {
      if (disposed) return;
      setPreviewUrl(previous => {
        if (previous === url) return previous;
        setImagePainted(false);
        return url;
      });
    };

    applyPreviewUrl(getCachedPeoplePreviewUrl(photo));
    setNaturalSize(null);

    if (photo.jpg?.path && photo.jpg.previewUrl) {
      if (!nearViewport && !active) {
        setLoadingRaw(false);
        return () => {
          disposed = true;
        };
      }

      setLoadingRaw(false);
      void loadJpegThumbnail(
        photo.jpg.path,
        photo.jpg.previewUrl,
        PEOPLE_TILE_THUMBNAIL_EDGE,
        active ? 'high' : 'low',
      )
        .then(url => {
          applyPreviewUrl(url);
        })
        .catch(() => {
          applyPreviewUrl(photo.jpg?.previewUrl ?? null);
        });
      return () => {
        disposed = true;
      };
    }

    if (photo.jpg?.previewUrl) {
      if (!nearViewport && !active) {
        setLoadingRaw(false);
        return () => {
          disposed = true;
        };
      }

      setLoadingRaw(false);
      applyPreviewUrl(photo.jpg.previewUrl);
      return () => {
        disposed = true;
      };
    }

    if (!photo.raw?.path) {
      setLoadingRaw(false);
      return () => {
        disposed = true;
      };
    }

    const cachedRawThumbnail = getThumbnailFromCache(photo.raw.path);
    if (cachedRawThumbnail) {
      applyPreviewUrl(cachedRawThumbnail);
      setLoadingRaw(false);
      return () => {
        disposed = true;
      };
    }

    if (!nearViewport && !active) {
      setLoadingRaw(false);
      return () => {
        disposed = true;
      };
    }

    setLoadingRaw(true);
    void decodeRawFile(photo.raw.path, true, {
      priority: active ? 'high' : 'low',
      silent: true,
    })
      .then(url => {
        if (disposed) return;
        applyPreviewUrl(url);
      })
      .catch(() => {
        if (!disposed) applyPreviewUrl(null);
      })
      .finally(() => {
        if (!disposed) setLoadingRaw(false);
      });

    return () => {
      disposed = true;
    };
  }, [active, nearViewport, photo]);

  return (
    <button
      ref={tileRef}
      type="button"
      onClick={() => onSelectPhoto(photo.id)}
      onDoubleClick={() => onOpenPhoto(photo.id)}
      title={openPhotoLabel}
      className={`group overflow-hidden rounded-xl border text-left outline-none transition-[border-color,box-shadow,transform,background-color] duration-180 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-cyan-300/45 active:translate-y-0 ${
        active
          ? isDark
            ? 'border-cyan-200/54 bg-cyan-300/[0.08] shadow-[0_0_0_1px_rgba(103,232,249,0.18),0_12px_30px_rgba(0,0,0,0.28),0_0_22px_rgba(34,211,238,0.12)]'
            : 'border-cyan-600/45 bg-white/78 shadow-[0_0_0_1px_rgba(8,145,178,0.12),0_10px_24px_rgba(15,23,42,0.12)]'
          : isDark
            ? 'border-white/[0.05] bg-black/24'
            : 'border-slate-300/50 bg-white/58'
      }`}
    >
      <div className={`relative aspect-[4/3] overflow-hidden ${isDark ? 'bg-zinc-900' : 'bg-slate-200'}`}>
        {previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            className={`h-full w-full object-cover transition-[opacity,transform] duration-200 group-hover:scale-[1.025] ${imagePainted ? 'opacity-100' : 'opacity-0'}`}
            draggable={false}
            loading={nearViewport || active ? 'eager' : 'lazy'}
            decoding="async"
            onLoad={event => {
              setImagePainted(true);
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
            }}
          />
        ) : (
          <PhotoPreviewSkeleton
            theme={theme}
            label={loadingRaw ? rawPreviewingLabel : previewUnavailableLabel}
            active={loadingRaw}
          />
        )}
        {previewUrl && imagePainted && faces.map(face => (
          <span
            key={face.key}
            className="pointer-events-none absolute rounded-[5px] border border-cyan-200/95 shadow-[0_0_0_1px_rgba(8,145,178,0.32),0_0_14px_rgba(103,232,249,0.38)]"
            style={coverFaceBoxStyle(face.boundingBox, naturalSize)}
          />
        ))}
        {previewUrl && imagePainted && faces.length > 0 && (
          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/48 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-100 backdrop-blur-md">
            {faces.length}
          </span>
        )}
        {isAiReviewPhoto(photo) && (
          <IssueCapsule
            theme={theme}
            label={photo.ai?.issues[0] ? aiIssueLabel(photo.ai.issues[0].code, language, photo.ai.issues[0].level) : aiReviewLabel}
            className="absolute right-2 top-2"
          />
        )}
      </div>
      <div className="px-2 py-1.5">
        <div className={`truncate text-[11px] font-medium ${isDark ? 'text-zinc-300' : 'text-slate-700'}`}>{photo.jpg?.name || photo.raw?.name || photo.id}</div>
      </div>
    </button>
  );
});

PhotoTile.displayName = 'PhotoTile';

const FaceRow: React.FC<{
  face: PersonFaceEmbedding;
  ownerCluster?: PersonCluster;
  unassignedLabel?: string;
  clusters: PersonCluster[];
  activeClusterId?: string;
  theme: 'light' | 'dark';
  selected: boolean;
  moveToLabel: string;
  moveUnassignedLabel: string;
  splitOutLabel: string;
  onToggleSelected: (faceKey: string) => void;
  onFocusCluster?: (faceKey: string) => void;
  onMoveFace: (faceKey: string, targetClusterId: string | 'UNASSIGNED') => void;
  onCreatePersonFromFace: (faceKey: string) => void;
}> = ({
  face,
  ownerCluster,
  unassignedLabel,
  clusters,
  activeClusterId,
  theme,
  selected,
  moveToLabel,
  moveUnassignedLabel,
  splitOutLabel,
  onToggleSelected,
  onFocusCluster,
  onMoveFace,
  onCreatePersonFromFace,
}) => {
  const isDark = theme === 'dark';
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`rounded-xl border p-2 transition-colors ${ownerCluster ? 'cursor-pointer' : ''} ${isDark ? glassPopover.dark : glassPopover.light}`}
      onClick={() => {
        if (ownerCluster) onFocusCluster?.(face.key);
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelected(face.key);
          }}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
            selected
              ? isDark ? 'text-cyan-200' : 'text-cyan-700'
              : isDark ? 'text-zinc-600 hover:text-zinc-300' : 'text-slate-400 hover:text-slate-700'
          }`}
          aria-pressed={selected}
        >
          <AppIcon icon={selected ? SquareCheck : Square} className="h-4 w-4" />
        </button>
        <div className="relative shrink-0">
          <Avatar face={face} theme={theme} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[12px] font-semibold ${isDark ? 'text-zinc-100' : 'text-slate-900'}`}>
            {ownerCluster?.displayName || unassignedLabel || face.photoId}
          </div>
          <div className={`mt-0.5 text-[11px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
            {Math.round(face.quality * 100)}% · {face.source}
          </div>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setOpen(value => !value);
          }}
          className={`rounded-md px-2 py-1 text-[11px] ${isDark ? glassInteractive.dark : glassInteractive.light}`}
        >
          {moveToLabel}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCreatePersonFromFace(face.key);
          }}
          className={`flex h-6 w-6 items-center justify-center rounded-md ${isDark ? glassInteractive.dark : glassInteractive.light}`}
          title={splitOutLabel}
        >
          <AppIcon icon={UserPlus} className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="mt-2 grid gap-1" onClick={event => event.stopPropagation()}>
          {clusters.filter(cluster => cluster.id !== activeClusterId).map(cluster => (
            <button
              key={cluster.id}
              type="button"
              onClick={() => {
                onMoveFace(face.key, cluster.id);
                setOpen(false);
              }}
              className={`rounded-lg px-2 py-1.5 text-left text-[11px] ${isDark ? 'hover:bg-white/[0.06] text-zinc-300' : 'hover:bg-white/70 text-slate-700'}`}
            >
              {cluster.displayName}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              onMoveFace(face.key, 'UNASSIGNED');
              setOpen(false);
            }}
            className={`rounded-lg px-2 py-1.5 text-left text-[11px] ${isDark ? 'hover:bg-white/[0.06] text-zinc-500' : 'hover:bg-white/70 text-slate-500'}`}
          >
            {moveUnassignedLabel}
          </button>
        </div>
      )}
    </div>
  );
};

function coverFaceBoxStyle(
  box: PersonFaceEmbedding['boundingBox'],
  naturalSize: { width: number; height: number } | null,
): React.CSSProperties {
  if (!naturalSize || naturalSize.width <= 0 || naturalSize.height <= 0) {
    return {
      left: `${box.x * 100}%`,
      top: `${box.y * 100}%`,
      width: `${box.width * 100}%`,
      height: `${box.height * 100}%`,
    };
  }

  const containerAspect = 4 / 3;
  const imageAspect = naturalSize.width / naturalSize.height;
  let scaleX = 1;
  let scaleY = 1;
  let offsetX = 0;
  let offsetY = 0;

  if (imageAspect > containerAspect) {
    scaleX = imageAspect / containerAspect;
    offsetX = (scaleX - 1) / 2;
  } else if (imageAspect < containerAspect) {
    scaleY = containerAspect / imageAspect;
    offsetY = (scaleY - 1) / 2;
  }

  return {
    left: `${(box.x * scaleX - offsetX) * 100}%`,
    top: `${(box.y * scaleY - offsetY) * 100}%`,
    width: `${box.width * scaleX * 100}%`,
    height: `${box.height * scaleY * 100}%`,
  };
}

const PeoplePhotoFilterControl: React.FC<{
  theme: 'light' | 'dark';
  language: Language;
  filter: PeoplePhotoFilter;
  ratingFilter: PhotoRatingFilter;
  stats: PeoplePhotoStats;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilterChange: (filter: PeoplePhotoFilter) => void;
  onRatingFilterChange: (filter: PhotoRatingFilter) => void;
}> = ({
  theme,
  language,
  filter,
  ratingFilter,
  stats,
  open,
  onOpenChange,
  onFilterChange,
  onRatingFilterChange,
}) => {
  const text = photoFilterCopy[language];
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold transition-colors ${
          open
            ? theme === 'dark' ? glassActive.dark : glassActive.light
            : theme === 'dark' ? glassInteractive.dark : glassInteractive.light
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={text.filterButton}
      >
        <AppIcon icon={Filter} className="h-4 w-4" />
        <span>{text.filters[filter]}</span>
        <span className={`font-mono text-[11px] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {stats[filter]}
        </span>
      </button>

      {open && (
        <div className={`absolute right-0 top-[calc(100%+8px)] z-50 max-h-[calc(100vh-160px)] w-[176px] overflow-y-auto rounded-xl border p-1.5 backdrop-blur-[80px] backdrop-saturate-150 ${
          theme === 'dark' ? glassPopover.dark : glassPopover.light
        }`}>
          <p className={`px-2 pb-1.5 text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-700'}`}>
            {text.statusFilter}
          </p>
          <div className="space-y-0.5">
            {PEOPLE_STATUS_FILTERS.map(statusFilter => (
              <PeopleFilterMenuRow
                key={statusFilter}
                active={filter === statusFilter}
                label={text.filters[statusFilter]}
                count={stats[statusFilter]}
                theme={theme}
                onClick={() => {
                  onFilterChange(statusFilter);
                  onOpenChange(false);
                }}
              />
            ))}
          </div>

          <div className={`mt-2 border-t pt-2 ${theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-400/24'}`}>
            <p className={`px-2 pb-1.5 text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-700'}`}>
              {text.ratingFilter}
            </p>
            <div className="space-y-0.5">
              {RATING_FILTERS.map(option => (
                <PeopleFilterMenuRow
                  key={option}
                  active={ratingFilter === option}
                  label={ratingFilterLabel(option, text)}
                  theme={theme}
                  onClick={() => {
                    onRatingFilterChange(option);
                    onOpenChange(false);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const PeopleFilterMenuRow = ({
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

function ratingFilterLabel(filter: PhotoRatingFilter, text: typeof photoFilterCopy.zh) {
  switch (filter) {
    case 'RATING_NONE':
      return text.unrated;
    case 'RATING_1_PLUS':
      return text.onePlus;
    case 'RATING_2_PLUS':
      return text.twoPlus;
    case 'RATING_3_PLUS':
      return text.threePlus;
    case 'RATING_4_PLUS':
      return text.fourPlus;
    case 'RATING_5':
      return text.fiveOnly;
    case 'RATING_ALL':
    default:
      return text.ratingAll;
  }
}

function buildPeoplePhotoStats(photos: PhotoGroup[]): PeoplePhotoStats {
  return PEOPLE_STATUS_FILTERS.reduce((stats, filter) => {
    stats[filter] = photos.filter(photo => matchesStatusFilter(photo, filter)).length;
    return stats;
  }, {} as PeoplePhotoStats);
}

function preloadPeoplePreviewWindow(photos: PhotoGroup[], currentIndex: number) {
  if (currentIndex < 0 || photos.length === 0) return;
  const indices = getPeoplePreviewPreloadOrder(currentIndex, photos.length, PEOPLE_PRELOAD_AHEAD, PEOPLE_PRELOAD_BEHIND);
  schedulePeoplePreviewPreload(() => {
    indices.forEach(index => {
      const photo = photos[index];
      if (!photo) return;

      if (photo.jpg?.path && photo.jpg.previewUrl) {
        preloadJpegThumbnail(
          photo.jpg.path,
          photo.jpg.previewUrl,
          PEOPLE_TILE_THUMBNAIL_EDGE,
          index === currentIndex ? 'high' : 'low',
        );
        return;
      }

      if (photo.jpg?.previewUrl) return;

      if (!photo.raw?.path) return;
      if (getThumbnailFromCache(photo.raw.path)) return;
      void decodeRawFile(photo.raw.path, true, {
        priority: index === currentIndex ? 'high' : 'low',
        silent: true,
      })
        .catch(() => undefined);
    });
  });
}

function getCachedPeoplePreviewUrl(photo: PhotoGroup) {
  if (photo.jpg?.path) {
    return getCachedJpegThumbnail(photo.jpg.path, PEOPLE_TILE_THUMBNAIL_EDGE);
  }
  if (photo.jpg?.previewUrl) {
    return null;
  }
  if (photo.raw?.path) {
    return getThumbnailFromCache(photo.raw.path);
  }
  return null;
}

function getPeoplePreviewPreloadOrder(currentIndex: number, total: number, ahead: number, behind: number) {
  const order: number[] = [];
  const maxOffset = Math.max(ahead, behind);
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    if (offset <= ahead) {
      const forward = currentIndex + offset;
      if (forward < total) order.push(forward);
    }
    if (offset > 0 && offset <= behind) {
      const backward = currentIndex - offset;
      if (backward >= 0) order.push(backward);
    }
  }
  return order;
}

function schedulePeoplePreviewPreload(callback: () => void) {
  if (typeof window === 'undefined') return;
  const appWindow = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
  };
  if (typeof appWindow.requestIdleCallback === 'function') {
    appWindow
      .requestIdleCallback(callback, { timeout: 140 });
    return;
  }
  globalThis.setTimeout(callback, 32);
}

const StatusSurface: React.FC<{
  theme: 'light' | 'dark';
  title: string;
  description: string;
  icon: LucideIcon;
  progress?: number;
  detail?: string;
  metrics?: Array<{ label: string; value: string }>;
  spinning?: boolean;
}> = ({ theme, title, description, icon, progress, detail, metrics, spinning }) => {
  const isDark = theme === 'dark';
  return (
    <div className={`flex h-full items-center justify-center rounded-2xl border ${isDark ? glassSurface.dark : glassSurface.light}`}>
      <div className="w-full max-w-[420px] px-6 text-center">
        <span className={`mx-auto flex h-12 w-12 items-center justify-center rounded-2xl ${isDark ? 'bg-white/[0.06] text-cyan-200' : 'bg-white/70 text-cyan-700'}`}>
          <AppIcon icon={icon} className={`h-5 w-5 ${spinning ? 'animate-spin motion-reduce:animate-none' : ''}`} />
        </span>
        <h2 className={`mt-4 text-[17px] font-semibold ${isDark ? 'text-zinc-50' : 'text-slate-950'}`}>{title}</h2>
        <p className={`mt-2 text-[13px] leading-6 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>{description}</p>
        {typeof progress === 'number' && (
          <div className="mt-5">
            <div className={`mb-2 flex justify-between text-[11px] ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
              <span>{detail}</span>
              <span>{progress}%</span>
            </div>
            <div className={`h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-black/34' : 'bg-slate-300/58'}`}>
              <div className="h-full rounded-full bg-cyan-300 transition-[width] duration-300" style={{ width: `${Math.max(4, progress)}%` }} />
            </div>
            {metrics && metrics.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-2">
                {metrics.map(metric => (
                  <div
                    key={metric.label}
                    className={`rounded-lg px-3 py-2 text-left ${
                      isDark ? 'bg-white/[0.035]' : 'bg-white/54'
                    }`}
                  >
                    <div className={`text-[10px] font-medium ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>{metric.label}</div>
                    <div className={`mt-0.5 font-mono text-[12px] font-semibold tabular-nums ${isDark ? 'text-zinc-100' : 'text-slate-900'}`}>{metric.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

function estimatePeopleRemainingMs(elapsedMs: number, processed: number, total: number) {
  if (processed <= 0 || total <= processed || elapsedMs < 1000) return null;
  return Math.max(0, Math.round((elapsedMs / processed) * (total - processed)));
}
