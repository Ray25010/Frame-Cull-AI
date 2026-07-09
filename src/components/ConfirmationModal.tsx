import React, { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  Image,
  Send,
  Star,
  Trash2,
} from 'lucide-react';
import {
  ExportColorSpace,
  ExportIntent,
  ExportTarget,
  ExportMetadataMode,
  ExportMode,
  ExportOperation,
  ExportOptions,
  PhotoGroup,
} from '../types';
import { Language } from '../i18n';
import { AppIcon } from './ui/AppIcon';
import { chromeGlass, glassSubtle, glassPopover, modalBackdrop } from './ui/chrome';

interface ConfirmationModalProps {
  groups: PhotoGroup[];
  onConfirm: (value?: ExportOptions) => void;
  onCancel: () => void;
  type: 'delete' | 'export' | 'forceDelete';
  orphanDeleteKind?: 'RAW' | 'JPG' | null;
  theme: 'light' | 'dark';
  language?: Language;
}

const labels = {
  zh: {
    cancel: '取消',
    deleteTitle: '移动到回收站',
    deleteBody: '即将把这些已弃用照片移动到系统回收站。',
    deleteConfirm: '移到回收站',
    orphanRawTitle: '清理孤立 RAW',
    orphanJpgTitle: '清理孤立 JPG',
    orphanRawBody: '即将把所有没有配对 JPG 的 RAW 文件移动到系统回收站。这是文件维护操作，不会按 AI 标签处理照片。',
    orphanJpgBody: '即将把所有没有配对 RAW 的 JPG 文件移动到系统回收站。这是文件维护操作，不会按 AI 标签处理照片。',
    orphanConfirm: '确认清理',
    forceTitle: '永久删除',
    forceBody: '无法移动到回收站。如果继续，文件会被直接删除，此操作不可撤销。',
    forceConfirm: '直接删除',
    exportTitle: '导出选中照片',
    exportTarget: '导出目标',
    exportToFolder: '普通文件夹',
    exportToFolderHint: '只导出到本地目录，完成后可手动打开。',
    exportToLightroom: 'Lightroom Classic',
    exportToLightroomHint: '写入星级并打开所选照片所在文件夹。',
    lightroomQuickTitle: '打开 Lightroom Classic',
    lightroomQuickHint: '',
    exportMethod: '导出方式',
    exportCopy: '导出副本',
    moveOriginals: '原始文件',
    exportCopyHint: '重新渲染为新文件，原片留在当前位置。',
    moveOriginalsHint: '复制或移动原始 JPG/RAW，RAW 的 XMP 会一并处理。',
    operation: '处理方式',
    copyOriginals: '复制原片',
    copyOriginalsHint: '原片留在当前位置，目标目录写入星级副本。',
    moveOriginalsOperation: '移动原片',
    moveOriginalsOperationHint: '把原始文件移动到目标目录。',
    lightroomHandoff: 'Lightroom',
    lightroomImportFolder: '源文件夹',
    lightroomImportFolderHint: '启动 Lightroom Classic，并打开当前所选照片所在文件夹。',
    lightroomWatchedFolder: '源文件夹',
    lightroomWatchedFolderHint: '启动 Lightroom Classic，并打开当前所选照片所在文件夹。',
    launchLightroom: '导出完成后启动 Lightroom Classic',
    lightroomHonestHint: 'FrameCull 会把当前星级写入照片元数据，并打开 Lightroom Classic 与源文件夹。',
    fileSettings: '文件设置',
    fileNaming: '文件命名',
    metadata: '元数据',
    destination: '目标目录',
    imageFormat: '图像格式',
    quality: '品质',
    colorSpace: '色彩空间',
    renameAs: '重新命名',
    nameAs: '命名为',
    renameHint: '多张导出会自动追加序号，例如：婚礼精选-001.jpg。',
    extensionExample: '示例',
    chooseFolder: '选择目录',
    noFolder: '尚未选择目录',
    exportConfirm: '开始导出',
    importLightroomConfirm: '打开 LR',
    groups: '照片组',
    files: '个文件',
    andMore: '还有',
    more: '项',
    renderJpeg: 'JPEG',
    renderTiff: 'TIFF',
    renderPng: 'PNG',
    sourceJpg: 'JPG',
    sourceRaw: 'RAW',
    sourceBoth: 'RAW + JPG',
    metadataStrategy: '保留策略',
    noMetadata: '不保留元数据',
    noMetadataHint: '只生成图像文件，不写入 FrameCull 星级，也不复制 EXIF 或 XMP。',
    ratingMetadata: '写入星级',
    ratingMetadataHint: '只写入 FrameCull 当前星级。JPEG 写入文件内，TIFF/PNG 生成同名 .xmp。',
    captureAndRatingMetadata: '保留拍摄信息并写入星级',
    captureAndRatingMetadataHint: '仅 JPEG / sRGB 可用。复制原 JPG 的 EXIF/XMP（时间、相机、镜头、GPS 等）并写入当前星级。',
    sourceMetadata: '原始文件并写入星级',
    sourceMetadataHint: '原 JPG/RAW 不重新编码。复制或移动到目标目录后，会把 FrameCull 当前星级写入目标 JPG 或 RAW 同名 .xmp，并保留原有拍摄时间、位置信息和其他元数据。',
    colorSpaceSrgb: 'sRGB IEC61966-2.1',
    colorSpaceAdobe: 'Adobe RGB (1998)',
    colorSpaceHint: 'JPEG/TIFF/PNG 均可输出 sRGB 或 Adobe RGB (1998)。',
    selectDestinationFirst: '选择目标目录后即可开始导出。',
    lightroomReadySummary: '写入星级，并打开 Lightroom Classic 到所选照片文件夹。',
    willRender: '将生成',
    willMove: '将处理',
    willCopy: '将复制',
    lightroomSummary: '并打开 Lightroom Classic',
    toDestination: '到目标目录',
  },
  en: {
    cancel: 'Cancel',
    deleteTitle: 'Move to Trash',
    deleteBody: 'These rejected photos will be moved to the system trash.',
    deleteConfirm: 'Move to Trash',
    orphanRawTitle: 'Clean orphan RAW',
    orphanJpgTitle: 'Clean orphan JPG',
    orphanRawBody: 'All RAW files without a paired JPG will be moved to the system trash. This is file maintenance and does not act on AI labels.',
    orphanJpgBody: 'All JPG files without a paired RAW will be moved to the system trash. This is file maintenance and does not act on AI labels.',
    orphanConfirm: 'Clean Files',
    forceTitle: 'Permanent Delete',
    forceBody: 'Moving to trash failed. Continuing will permanently delete these files and cannot be undone.',
    forceConfirm: 'Delete Permanently',
    exportTitle: 'Export Selected Photos',
    exportTarget: 'Export target',
    exportToFolder: 'Folder',
    exportToFolderHint: 'Export to a local folder and open it manually.',
    exportToLightroom: 'Lightroom Classic',
    exportToLightroomHint: 'Write ratings and open the selected photos folder.',
    lightroomQuickTitle: 'Open Lightroom Classic',
    lightroomQuickHint: '',
    exportMethod: 'Export method',
    exportCopy: 'Export copy',
    moveOriginals: 'Original files',
    exportCopyHint: 'Render new files and leave originals in place.',
    moveOriginalsHint: 'Copy or move original JPG/RAW files and handle RAW XMP sidecars.',
    operation: 'Operation',
    copyOriginals: 'Copy originals',
    copyOriginalsHint: 'Keep originals in place and write ratings to exported targets.',
    moveOriginalsOperation: 'Move originals',
    moveOriginalsOperationHint: 'Move original files to the destination folder.',
    lightroomHandoff: 'Lightroom',
    lightroomImportFolder: 'Import folder',
    lightroomImportFolderHint: 'Launch Lightroom Classic and open the source folder.',
    lightroomWatchedFolder: 'Watched folder',
    lightroomWatchedFolderHint: 'Launch Lightroom Classic and open the selected photos folder.',
    launchLightroom: 'Launch Lightroom Classic after export',
    lightroomHonestHint: 'FrameCull writes ratings and opens Lightroom at the source folder.',
    fileSettings: 'File settings',
    fileNaming: 'File naming',
    metadata: 'Metadata',
    destination: 'Destination',
    imageFormat: 'Image format',
    quality: 'Quality',
    colorSpace: 'Color space',
    renameAs: 'Rename',
    nameAs: 'Name as',
    renameHint: 'Multiple exports append a sequence, for example: wedding-picks-001.jpg.',
    extensionExample: 'Example',
    chooseFolder: 'Choose Folder',
    noFolder: 'No folder selected',
    exportConfirm: 'Start Export',
    importLightroomConfirm: 'Open LR',
    groups: 'photo groups',
    files: 'files',
    andMore: 'and',
    more: 'more',
    renderJpeg: 'JPEG',
    renderTiff: 'TIFF',
    renderPng: 'PNG',
    sourceJpg: 'JPG',
    sourceRaw: 'RAW',
    sourceBoth: 'RAW + JPG',
    metadataStrategy: 'Policy',
    noMetadata: 'No metadata',
    noMetadataHint: 'Create image files only, without FrameCull rating, EXIF, or XMP.',
    ratingMetadata: 'Write rating',
    ratingMetadataHint: 'Writes only the current FrameCull rating. JPEG embeds it; TIFF/PNG get matching .xmp sidecars.',
    captureAndRatingMetadata: 'Keep capture info and write rating',
    captureAndRatingMetadataHint: 'JPEG / sRGB only. Copies source JPG EXIF/XMP such as time, camera, lens, and GPS, then writes the current rating.',
    sourceMetadata: 'Original files with ratings',
    sourceMetadataHint: 'Original JPG/RAW files are not re-encoded. After copying or moving to the destination, FrameCull writes the current rating into target JPG or RAW .xmp while preserving capture time, location, and other original metadata.',
    colorSpaceSrgb: 'sRGB IEC61966-2.1',
    colorSpaceAdobe: 'Adobe RGB (1998)',
    colorSpaceHint: 'JPEG, TIFF, and PNG can export sRGB or Adobe RGB (1998).',
    selectDestinationFirst: 'Choose a destination folder to start export.',
    lightroomReadySummary: 'Write ratings and open Lightroom Classic at the selected photos folder.',
    willRender: 'Will create',
    willMove: 'Will process',
    willCopy: 'Will copy',
    lightroomSummary: 'and open Lightroom Classic',
    toDestination: 'to the destination folder',
  },
} as const;

type CopyKey = keyof typeof labels.zh;
type CopyTable = Record<CopyKey, string>;

const renderModeOptions: Array<{ value: ExportMode; labelKey: CopyKey }> = [
  { value: 'RENDER_JPG', labelKey: 'renderJpeg' },
  { value: 'RENDER_TIFF', labelKey: 'renderTiff' },
  { value: 'RENDER_PNG', labelKey: 'renderPng' },
];

const baseOriginalModeOptions: Array<{ value: ExportMode; labelKey: CopyKey }> = [
  { value: 'JPG', labelKey: 'sourceJpg' },
  { value: 'RAW', labelKey: 'sourceRaw' },
  { value: 'BOTH', labelKey: 'sourceBoth' },
];

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  groups,
  onConfirm,
  onCancel,
  type,
  orphanDeleteKind = null,
  theme,
  language = 'zh',
}) => {
  const [exportTarget, setExportTarget] = useState<ExportTarget>('FOLDER');
  const [intent, setIntent] = useState<ExportIntent>('RENDER_COPY');
  const [mode, setMode] = useState<ExportMode>('RENDER_JPG');
  const [sourceOperation, setSourceOperation] = useState<ExportOperation>('MOVE');
  const [jpegQuality, setJpegQuality] = useState(100);
  const [colorSpace, setColorSpace] = useState<ExportColorSpace>('SRGB');
  const [metadataMode, setMetadataMode] = useState<ExportMetadataMode>('RATING_ONLY');
  const [renameEnabled, setRenameEnabled] = useState(false);
  const [renameBaseName, setRenameBaseName] = useState('');
  const [destinationFolder, setDestinationFolder] = useState('');
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const text = labels[language];
  const isDark = theme === 'dark';
  const isRenderIntent = intent === 'RENDER_COPY';
  const isLightroomTarget = exportTarget === 'LIGHTROOM_CLASSIC';
  const isLightroomImport = intent === 'LIGHTROOM_IMPORT' || isLightroomTarget;
  const originalAvailability = useMemo(() => getOriginalAvailability(groups), [groups]);
  const originalModeOptions = useMemo(
    () => getAvailableOriginalModeOptions(originalAvailability),
    [originalAvailability],
  );
  const modeOptions = isRenderIntent ? renderModeOptions : originalModeOptions;
  const operation: ExportOperation = isRenderIntent ? 'COPY' : sourceOperation;
  const supportsCaptureMetadata = isRenderIntent
    && mode === 'RENDER_JPG'
    && colorSpace === 'SRGB'
    && groups.every(group => Boolean(group.jpg?.path));
  const exportedFileCount = useMemo(
    () => countExportFiles(groups, mode),
    [groups, mode],
  );
  const currentModeLabel = text[modeOptions.find(option => option.value === mode)?.labelKey || 'renderJpeg'];
  const exportSummary = buildExportSummary({
    text,
    modeLabel: currentModeLabel,
    groupsCount: groups.length,
    fileCount: exportedFileCount,
    intent,
    operation,
    exportTarget,
    hasDestination: Boolean(destinationFolder),
  });
  const isOrphanDelete = type === 'delete' && orphanDeleteKind !== null;
  const title = isOrphanDelete
    ? (orphanDeleteKind === 'RAW' ? text.orphanRawTitle : text.orphanJpgTitle)
    : type === 'delete'
      ? text.deleteTitle
      : type === 'forceDelete'
        ? text.forceTitle
        : text.exportTitle;
  const icon = type === 'delete'
    ? Trash2
    : type === 'forceDelete'
      ? AlertTriangle
      : Send;
  const confirmLabel = isOrphanDelete
    ? text.orphanConfirm
    : type === 'delete'
      ? text.deleteConfirm
      : type === 'forceDelete'
        ? text.forceConfirm
        : isLightroomImport
          ? text.importLightroomConfirm
          : text.exportConfirm;

  useEffect(() => {
    if (type !== 'export') return;
    if (modeOptions.some(option => option.value === mode)) return;
    setMode(isRenderIntent ? 'RENDER_JPG' : getDefaultOriginalMode(originalAvailability));
  }, [isRenderIntent, mode, modeOptions, originalAvailability, type]);

  const chooseDestination = async () => {
    const folder = await open({
      directory: true,
      multiple: false,
      title: text.destination,
    });
    if (typeof folder === 'string') setDestinationFolder(folder);
  };

  const handleIntentChange = (nextIntent: ExportIntent) => {
    setIntent(nextIntent);
    setMode(nextIntent === 'RENDER_COPY' ? 'RENDER_JPG' : getDefaultOriginalMode(originalAvailability));
    setMetadataMode(nextIntent === 'RENDER_COPY' ? 'RATING_ONLY' : 'ALL');
    if (nextIntent === 'MOVE_ORIGINALS') {
      setSourceOperation(isLightroomTarget ? 'COPY' : 'MOVE');
    }
    setFormatMenuOpen(false);
  };

  const handleExportTargetChange = (nextTarget: ExportTarget) => {
    setExportTarget(nextTarget);
    if (nextTarget === 'LIGHTROOM_CLASSIC') {
      setIntent('LIGHTROOM_IMPORT');
      setMode(getDefaultOriginalMode(originalAvailability));
      setSourceOperation('COPY');
      setMetadataMode('ALL');
    } else if (intent === 'LIGHTROOM_IMPORT') {
      setIntent('RENDER_COPY');
      setMode('RENDER_JPG');
      setSourceOperation('MOVE');
      setMetadataMode('RATING_ONLY');
    } else if (intent === 'MOVE_ORIGINALS') {
      setSourceOperation('MOVE');
    }
    setFormatMenuOpen(false);
  };

  const handleModeChange = (nextMode: ExportMode) => {
    setMode(nextMode);
    setFormatMenuOpen(false);
    if (nextMode !== 'RENDER_JPG' && metadataMode === 'CAPTURE_INFO_AND_RATING') {
      setMetadataMode('RATING_ONLY');
    }
  };

  const handleColorSpaceChange = (value: ExportColorSpace) => {
    setColorSpace(value);
    if (value !== 'SRGB' && metadataMode === 'CAPTURE_INFO_AND_RATING') {
      setMetadataMode('RATING_ONLY');
    }
  };

  const handleQualityChange = (value: number) => {
    setJpegQuality(Math.min(100, Math.max(1, Math.round(value))));
  };

  const handleConfirm = () => {
    if (type !== 'export') {
      onConfirm();
      return;
    }

    if (!destinationFolder && !isLightroomImport) return;
    onConfirm({
      intent,
      mode,
      operation,
      destinationFolder: isLightroomImport ? '' : destinationFolder,
      exportTarget,
      lightroomMode: isLightroomImport ? 'SOURCE_FOLDER' : undefined,
      launchLightroom: isLightroomImport ? true : undefined,
      jpegQuality,
      colorSpace,
      metadataMode: isRenderIntent ? metadataMode : 'ALL',
      renameEnabled,
      renameBaseName: renameBaseName.trim(),
      includeRawSidecars: !isRenderIntent,
    });
  };

  return (
    <div className={`fixed inset-0 z-[100] flex items-center justify-center p-4 ${modalBackdrop}`}>
      <div className={`flex max-h-[calc(100dvh-32px)] w-full ${type === 'export' ? 'max-w-[640px]' : 'max-w-2xl'} flex-col overflow-hidden rounded-lg border ${
        isDark
          ? chromeGlass.dark
          : chromeGlass.light
      }`}>
        <div className={`${type === 'export' ? 'px-5 py-4' : `shrink-0 border-b px-5 py-4 ${isDark ? 'border-white/[0.06]' : 'border-slate-400/24'}`}`}>
          <h2 className={`flex items-center gap-3 ${type === 'export' ? 'text-[17px]' : 'text-[18px]'} font-semibold ${isDark ? 'text-white' : 'text-slate-950'}`}>
            <AppIcon icon={icon} className={`${type === 'export' ? 'text-cyan-300' : 'text-rose-500'} h-[18px] w-[18px]`} />
            {title}
          </h2>

          {type === 'export' && (
            <div className={`mt-1.5 text-[12px] ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
              {groups.length} {text.groups}, {exportedFileCount} {text.files}
            </div>
          )}

          <div className={`mt-2 space-y-2 text-sm ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
            {type === 'delete' && (
              <p>{isOrphanDelete
                ? (orphanDeleteKind === 'RAW' ? text.orphanRawBody : text.orphanJpgBody)
                : text.deleteBody}
              </p>
            )}
            {type === 'forceDelete' && <p className="font-semibold text-rose-500">{text.forceBody}</p>}
          </div>
        </div>

        {type === 'export' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-0">
            <ExportSection title={text.exportTarget} theme={theme}>
              <SegmentedChoice
                value={exportTarget}
                options={[
                  { value: 'FOLDER' as const, label: text.exportToFolder, hint: text.exportToFolderHint },
                  { value: 'LIGHTROOM_CLASSIC' as const, label: text.exportToLightroom, hint: text.exportToLightroomHint },
                ]}
                theme={theme}
                onChange={handleExportTargetChange}
              />
            </ExportSection>

            {!isLightroomImport && (
              <div className="mt-3">
                <ExportSection title={text.exportMethod} theme={theme}>
                  <SegmentedChoice
                    value={intent}
                    options={[
                      { value: 'RENDER_COPY' as const, label: text.exportCopy, hint: text.exportCopyHint },
                      { value: 'MOVE_ORIGINALS' as const, label: text.moveOriginals, hint: text.moveOriginalsHint },
                    ]}
                    theme={theme}
                    onChange={handleIntentChange}
                  />
                </ExportSection>
              </div>
            )}

            <div className="mt-3 space-y-3">
              {!isLightroomImport && isRenderIntent && (
                <ExportSection
                  title={text.renameAs}
                  theme={theme}
                  headerAction={
                    <button
                      type="button"
                      aria-label={text.renameAs}
                      aria-pressed={renameEnabled}
                      onClick={() => setRenameEnabled(value => !value)}
                      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                        isDark ? 'hover:bg-white/[0.055]' : 'hover:bg-white/60'
                      }`}
                    >
                      <span className={`h-4 w-4 rounded-full ${
                        renameEnabled
                          ? isDark ? 'bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.28)]' : 'bg-cyan-600'
                        : isDark ? 'bg-white/[0.08]' : 'bg-slate-300/80'
                      }`} />
                    </button>
                  }
                >
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-[108px_minmax(0,1fr)] items-center gap-3 text-[12px]">
                      <span className={isDark ? 'text-zinc-500' : 'text-slate-500'}>{text.nameAs}</span>
                      <input
                        type="text"
                        value={renameBaseName}
                        onChange={event => setRenameBaseName(event.target.value)}
                        disabled={!renameEnabled}
                        placeholder="Wedding Picks"
                        className={inputClass(theme)}
                        style={{ colorScheme: isDark ? 'dark' : 'light' }}
                      />
                    </div>
                    <div className={`text-[11px] leading-5 ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>
                      {text.renameHint}
                      {renameEnabled && renameBaseName.trim() && (
                        <span className="ml-2">
                          {text.extensionExample}: {buildRenamePreview(renameBaseName.trim(), mode)}
                        </span>
                      )}
                    </div>
                  </div>
                </ExportSection>
              )}

              {!isLightroomImport && (
                <ExportSection title={text.fileSettings} theme={theme}>
                  {!isRenderIntent && (
                    <ExportField label={text.operation} theme={theme}>
                      <SegmentedChoice
                        value={sourceOperation}
                        options={[
                          { value: 'COPY' as const, label: text.copyOriginals, hint: text.copyOriginalsHint },
                          { value: 'MOVE' as const, label: text.moveOriginalsOperation, hint: text.moveOriginalsOperationHint },
                        ]}
                        theme={theme}
                        onChange={setSourceOperation}
                      />
                    </ExportField>
                  )}

                  <ExportField label={text.imageFormat} theme={theme}>
                    <FormatSelect
                      value={mode}
                      open={formatMenuOpen}
                      options={modeOptions}
                      text={text}
                      theme={theme}
                      onToggle={() => setFormatMenuOpen(value => !value)}
                      onChange={handleModeChange}
                    />
                  </ExportField>

                  {mode === 'RENDER_JPG' && (
                    <ExportField label={text.quality} theme={theme}>
                      <div className="grid grid-cols-[minmax(180px,1fr)_68px] items-center gap-3">
                        <div className={`flex h-7 items-center rounded-md px-3 ${
                          isDark ? 'bg-black/[0.10]' : 'bg-slate-100/52'
                        }`}>
                          <input
                            type="range"
                            min={1}
                            max={100}
                            value={jpegQuality}
                            onChange={event => handleQualityChange(Number(event.target.value))}
                            className={`export-quality-slider w-full ${isDark ? 'dark' : 'light'}`}
                            style={{ colorScheme: isDark ? 'dark' : 'light', '--quality': `${jpegQuality}%` } as React.CSSProperties}
                          />
                        </div>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={jpegQuality}
                          onChange={event => handleQualityChange(Number(event.target.value || 1))}
                          className={`${compactInputClass(theme)} h-7 w-[68px] text-right font-medium tabular-nums`}
                          style={{ colorScheme: isDark ? 'dark' : 'light' }}
                        />
                      </div>
                    </ExportField>
                  )}

                  {isRenderIntent && (
                    <ExportField label={text.colorSpace} theme={theme}>
                      <div>
                        <ColorSpaceSwitch
                          value={colorSpace}
                          disabled={false}
                          text={text}
                          theme={theme}
                          onChange={handleColorSpaceChange}
                        />
                        <div className={`mt-1 text-[11px] ${isDark ? 'text-zinc-500' : 'text-slate-500'}`}>{text.colorSpaceHint}</div>
                      </div>
                    </ExportField>
                  )}
                </ExportSection>
              )}

              {!isLightroomImport && (
                <ExportSection title={text.metadata} theme={theme}>
                  {isRenderIntent ? (
                    <div className="grid gap-2">
                      {supportsCaptureMetadata && (
                        <MetadataChoice
                          active={metadataMode === 'CAPTURE_INFO_AND_RATING'}
                          icon={CheckCircle2}
                          title={text.captureAndRatingMetadata}
                          hint={text.captureAndRatingMetadataHint}
                          theme={theme}
                          onClick={() => setMetadataMode('CAPTURE_INFO_AND_RATING')}
                        />
                      )}
                      <MetadataChoice
                        active={metadataMode === 'RATING_ONLY' || (!supportsCaptureMetadata && metadataMode === 'CAPTURE_INFO_AND_RATING')}
                        icon={Star}
                        title={text.ratingMetadata}
                        hint={text.ratingMetadataHint}
                        theme={theme}
                        onClick={() => setMetadataMode('RATING_ONLY')}
                      />
                      <MetadataChoice
                        active={metadataMode === 'NONE'}
                        icon={Image}
                        title={text.noMetadata}
                        hint={text.noMetadataHint}
                        theme={theme}
                        onClick={() => setMetadataMode('NONE')}
                      />
                    </div>
                  ) : (
                    <MetadataChoice
                      active
                      icon={CheckCircle2}
                      title={text.sourceMetadata}
                      theme={theme}
                    />
                  )}
                </ExportSection>
              )}

              {!isLightroomImport && (
                <ExportSection title={text.destination} theme={theme}>
                  <div className={`flex min-h-10 items-center gap-2 rounded-lg px-2 py-1 ${
                    isDark ? 'bg-black/[0.20]' : 'bg-white/55'
                  }`}>
                    <div className={`min-w-0 flex-1 truncate px-1.5 font-mono text-[12px] ${
                      destinationFolder
                        ? isDark ? 'text-zinc-300' : 'text-slate-700'
                        : isDark ? 'text-zinc-600' : 'text-slate-500'
                    }`}>
                      {destinationFolder || text.noFolder}
                    </div>
                    <button
                      type="button"
                      onClick={chooseDestination}
                      className={`h-8 shrink-0 rounded-md px-3 text-[12px] font-semibold transition-colors ${
                        isDark
                          ? 'bg-white/[0.075] text-zinc-100 hover:bg-white/[0.11]'
                          : 'bg-slate-900/[0.08] text-slate-800 hover:bg-slate-900/[0.12]'
                      }`}
                    >
                      <AppIcon icon={FolderOpen} className="mr-1.5 inline h-4 w-4 align-[-3px]" />
                      {text.chooseFolder}
                    </button>
                  </div>
                </ExportSection>
              )}
            </div>
          </div>
        )}

        {type !== 'export' && (
          <div className={`flex-1 overflow-y-auto p-2 ${isDark ? 'bg-black/[0.10]' : 'bg-gray-50'}`}>
            <div className="grid grid-cols-2 gap-2 p-4 md:grid-cols-3">
              {groups.slice(0, 24).map(group => (
                <div key={group.id} className={`truncate rounded border p-1.5 font-mono text-[10px] ${isDark ? `${glassSubtle.dark} text-zinc-400` : 'border-gray-200 bg-white text-gray-600'}`}>
                  {group.id}
                </div>
              ))}
              {groups.length > 24 && (
                <div className={`col-span-2 py-2 text-center text-[10px] italic md:col-span-3 ${isDark ? 'text-zinc-600' : 'text-gray-500'}`}>
                  {text.andMore} {groups.length - 24} {text.more}
                </div>
              )}
            </div>
          </div>
        )}

        <div className={`${type === 'export' ? 'shrink-0 px-5 pb-4 pt-3' : `shrink-0 border-t p-4 ${isDark ? 'border-white/[0.06]' : 'border-gray-200'}`}`}>
          {type === 'export' && (
            <div className={`mb-3 text-[12px] leading-5 ${
              destinationFolder || isLightroomImport
                ? isDark ? 'text-cyan-100' : 'text-cyan-800'
                : isDark ? 'text-zinc-500' : 'text-slate-500'
            }`}>
              {exportSummary}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              autoFocus
              className={`rounded-lg px-6 py-2 text-sm font-bold transition-colors ${isDark ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`}
            >
              {text.cancel}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={type === 'export' && !destinationFolder && !isLightroomImport}
              className={`rounded-lg px-8 py-2 text-sm font-bold text-white transition-all disabled:pointer-events-none disabled:opacity-40 ${
                type === 'export'
                  ? 'bg-cyan-600 shadow-[0_4px_14px_rgba(8,145,178,0.22),inset_0_1px_0_rgba(255,255,255,0.16)] hover:bg-cyan-500'
                  : 'bg-rose-600 shadow-[0_4px_14px_rgba(225,29,72,0.22),inset_0_1px_0_rgba(255,255,255,0.16)] hover:bg-rose-500'
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const SegmentedChoice = <T extends string>({
  value,
  options,
  theme,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; hint: string }>;
  theme: 'light' | 'dark';
  onChange: (value: T) => void;
}) => {
  const isDark = theme === 'dark';
  return (
    <div className={`grid grid-cols-2 gap-1 rounded-md p-1 ${
      isDark ? 'bg-black/[0.16]' : 'bg-slate-100/60'
    }`}>
      {options.map(option => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-2 text-left transition-colors ${
              active
                ? isDark
                  ? 'bg-cyan-400/[0.11] text-zinc-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.055)]'
                  : 'bg-cyan-100/72 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]'
                : isDark
                  ? 'text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-200'
                  : 'text-slate-600 hover:bg-white/68 hover:text-slate-900'
            }`}
          >
            <span className="block text-[12px] font-semibold">{option.label}</span>
            <span className={`mt-0.5 block truncate text-[10px] ${active ? isDark ? 'text-zinc-300' : 'text-slate-600' : isDark ? 'text-zinc-600' : 'text-slate-500'}`}>
              {option.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
};

const ExportSection = ({
  title,
  theme,
  headerAction,
  children,
}: {
  title: string;
  theme: 'light' | 'dark';
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) => {
  const isDark = theme === 'dark';
  return (
    <section className={`rounded-lg px-3 py-3 ${
      isDark
        ? 'bg-white/[0.035] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.045)]'
        : 'bg-white/42 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.22)]'
    }`}>
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <div className={`text-[12px] font-semibold ${
          isDark ? 'text-zinc-200' : 'text-slate-800'
        }`}>
          {title}
        </div>
        {headerAction}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
};

const ExportField = ({
  label,
  theme,
  children,
}: {
  label: string;
  theme: 'light' | 'dark';
  children: React.ReactNode;
}) => {
  const isDark = theme === 'dark';
  return (
    <label className="grid grid-cols-[108px_minmax(0,1fr)] items-center gap-3 text-[12px]">
      <span className={isDark ? 'text-zinc-400' : 'text-slate-600'}>{label}</span>
      {children}
    </label>
  );
};

const FormatSelect = ({
  value,
  open,
  options,
  text,
  theme,
  onToggle,
  onChange,
}: {
  value: ExportMode;
  open: boolean;
  options: Array<{ value: ExportMode; labelKey: CopyKey }>;
  text: CopyTable;
  theme: 'light' | 'dark';
  onToggle: () => void;
  onChange: (value: ExportMode) => void;
}) => {
  const isDark = theme === 'dark';
  const current = options.find(option => option.value === value) ?? options[0];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={`${inputClass(theme)} flex items-center justify-between pr-9 text-left`}
      >
        <span>{text[current.labelKey]}</span>
      </button>
      <AppIcon
        icon={ChevronDown}
        className={`pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 transition-transform ${
          open ? 'rotate-180' : ''
        } ${
          isDark ? 'text-zinc-500' : 'text-slate-500'
        }`}
      />
      {open && (
        <div className={`absolute left-0 right-0 top-[calc(100%+8px)] z-20 overflow-hidden rounded-lg border ${
          isDark
            ? glassPopover.dark
            : glassPopover.light
        }`}>
          <div className="p-1">
            {options.map(option => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChange(option.value)}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[12px] transition-colors ${
                    active
                      ? isDark
                        ? 'bg-cyan-400/[0.10] text-zinc-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                        : 'bg-cyan-100/72 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]'
                      : isDark
                        ? 'text-zinc-300 hover:bg-white/[0.045]'
                        : 'text-slate-700 hover:bg-white/68'
                  }`}
                >
                  <span>{text[option.labelKey]}</span>
                  {active && <AppIcon icon={Check} className={`h-4 w-4 ${isDark ? 'text-cyan-200' : 'text-cyan-700'}`} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const MetadataChoice = ({
  active,
  icon,
  title,
  hint,
  theme,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  title: string;
  hint?: string;
  theme: 'light' | 'dark';
  onClick?: () => void;
}) => {
  const isDark = theme === 'dark';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
        active
          ? isDark
            ? 'bg-cyan-400/[0.09] text-zinc-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.055)]'
            : 'bg-cyan-100/65 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]'
          : isDark
            ? 'bg-black/[0.14] text-zinc-300 hover:bg-white/[0.045]'
            : 'bg-white/45 text-slate-800 hover:bg-white/70'
      }`}
    >
      <AppIcon
        icon={icon}
        className={`mt-0.5 h-4 w-4 shrink-0 ${
          active
            ? isDark ? 'text-cyan-200' : 'text-cyan-700'
            : isDark ? 'text-zinc-500' : 'text-slate-500'
        }`}
      />
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold">{title}</span>
        {hint && (
          <span className={`mt-0.5 block text-[11px] leading-5 ${
            active
              ? isDark ? 'text-zinc-300' : 'text-slate-600'
              : isDark ? 'text-zinc-500' : 'text-slate-500'
          }`}>
            {hint}
          </span>
        )}
      </span>
      {active && (
        <AppIcon
          icon={Check}
          className={`ml-auto mt-0.5 h-4 w-4 shrink-0 ${isDark ? 'text-cyan-200' : 'text-cyan-700'}`}
        />
      )}
    </Tag>
  );
};

const ColorSpaceSwitch = ({
  value,
  disabled,
  text,
  theme,
  onChange,
}: {
  value: ExportColorSpace;
  disabled: boolean;
  text: CopyTable;
  theme: 'light' | 'dark';
  onChange: (value: ExportColorSpace) => void;
}) => {
  const isDark = theme === 'dark';
  return (
    <div className={`grid grid-cols-2 gap-1 rounded-md p-1 ${
      isDark ? 'bg-black/[0.16]' : 'bg-slate-100/60'
    } ${disabled ? 'opacity-70' : ''}`}>
      {([
        { value: 'SRGB' as const, label: text.colorSpaceSrgb },
        { value: 'ADOBE_RGB' as const, label: text.colorSpaceAdobe },
      ]).map(option => {
        const active = value === option.value;
        const blocked = disabled && option.value === 'ADOBE_RGB';
        return (
          <button
            key={option.value}
            type="button"
            disabled={blocked}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-2 text-[12px] font-medium transition-colors ${
              active
                ? isDark
                  ? 'bg-cyan-400/[0.11] text-zinc-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.055)]'
                  : 'bg-cyan-100/72 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]'
                : isDark
                  ? 'text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-200'
                  : 'text-slate-600 hover:bg-white/68 hover:text-slate-900'
            } ${blocked ? 'pointer-events-none opacity-45' : ''}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
};

function inputClass(theme: 'light' | 'dark') {
  return `h-8 w-full rounded-md px-2.5 text-[13px] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
    theme === 'dark'
      ? 'bg-[#22252a]/95 text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)] placeholder:text-zinc-600 focus:shadow-[inset_0_0_0_1px_rgba(103,232,249,0.34),0_0_0_2px_rgba(103,232,249,0.08)]'
      : 'bg-slate-100/75 text-slate-950 shadow-[inset_0_0_0_1px_rgba(100,116,139,0.24)] placeholder:text-slate-400 focus:shadow-[inset_0_0_0_1px_rgba(8,145,178,0.40),0_0_0_2px_rgba(8,145,178,0.10)]'
  }`;
}

function compactInputClass(theme: 'light' | 'dark') {
  return `h-8 rounded-md px-2.5 text-[13px] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
    theme === 'dark'
      ? 'bg-[#22252a]/95 text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)] focus:shadow-[inset_0_0_0_1px_rgba(103,232,249,0.34),0_0_0_2px_rgba(103,232,249,0.08)]'
      : 'bg-slate-100/75 text-slate-950 shadow-[inset_0_0_0_1px_rgba(100,116,139,0.24)] focus:shadow-[inset_0_0_0_1px_rgba(8,145,178,0.40),0_0_0_2px_rgba(8,145,178,0.10)]'
  }`;
}

function countExportFiles(groups: PhotoGroup[], mode: ExportMode) {
  if (mode === 'RENDER_JPG' || mode === 'RENDER_TIFF' || mode === 'RENDER_PNG') return groups.length;
  return groups.reduce((count, group) => {
    if (mode === 'JPG') return count + (group.jpg ? 1 : 0);
    if (mode === 'RAW') return count + (group.raw ? 1 : 0);
    return count + (group.jpg ? 1 : 0) + (group.raw ? 1 : 0);
  }, 0);
}

type OriginalAvailability = {
  hasJpg: boolean;
  hasRaw: boolean;
  hasCompletePair: boolean;
};

function getOriginalAvailability(groups: PhotoGroup[]): OriginalAvailability {
  return groups.reduce<OriginalAvailability>((availability, group) => ({
    hasJpg: availability.hasJpg || Boolean(group.jpg),
    hasRaw: availability.hasRaw || Boolean(group.raw),
    hasCompletePair: availability.hasCompletePair || Boolean(group.jpg && group.raw),
  }), {
    hasJpg: false,
    hasRaw: false,
    hasCompletePair: false,
  });
}

function getAvailableOriginalModeOptions(availability: OriginalAvailability) {
  return baseOriginalModeOptions.filter(option => {
    if (option.value === 'JPG') return availability.hasJpg;
    if (option.value === 'RAW') return availability.hasRaw;
    if (option.value === 'BOTH') return availability.hasCompletePair;
    return false;
  });
}

function getDefaultOriginalMode(availability: OriginalAvailability): ExportMode {
  if (availability.hasCompletePair) return 'BOTH';
  if (availability.hasRaw) return 'RAW';
  if (availability.hasJpg) return 'JPG';
  return 'JPG';
}

function buildRenamePreview(baseName: string, mode: ExportMode) {
  const extension = mode === 'RENDER_TIFF' ? 'tiff' : mode === 'RENDER_PNG' ? 'png' : 'jpg';
  return `${baseName}-001.${extension}`;
}

function buildExportSummary({
  text,
  modeLabel,
  groupsCount,
  fileCount,
  intent,
  operation,
  exportTarget,
  hasDestination,
}: {
  text: CopyTable;
  modeLabel: string;
  groupsCount: number;
  fileCount: number;
  intent: ExportIntent;
  operation: ExportOperation;
  exportTarget: ExportTarget;
  hasDestination: boolean;
}) {
  if (exportTarget === 'LIGHTROOM_CLASSIC') return text.lightroomReadySummary;
  if (!hasDestination) return text.selectDestinationFirst;

  const action = intent === 'RENDER_COPY'
    ? text.willRender
    : operation === 'COPY'
      ? text.willCopy
      : text.willMove;
  return `${action} ${groupsCount} ${text.groups}, ${fileCount} ${text.files} (${modeLabel}) ${text.toDestination}`;
}

export default ConfirmationModal;
