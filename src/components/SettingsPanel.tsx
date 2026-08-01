import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowLeft,
  Cpu,
  DatabaseZap,
  FileImage,
  Film,
  Image,
  Info,
  Keyboard,
  Languages,
  Mail,
  MonitorCog,
  Moon,
  Palette,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Sun,
  UsersRound,
  WandSparkles,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getTranslations, Language } from '../i18n';
import { ThemeMode, ResolvedTheme } from '../hooks/useTheme';
import ShortcutSettings from './ShortcutSettings';
import { AppIcon } from './ui/AppIcon';
import { chromeGlass, glassInteractive, glassSubtle, modalBackdrop } from './ui/chrome';
import { updateSpotlightPosition } from './ui/reactBitsPilot';
import { APP_VERSION, IS_PRO_EDITION, PRODUCT_DISPLAY_NAME, PRODUCT_FOOTER } from '../utils/appInfo';
import { readStorage } from '../utils/storage';
import type { AppCacheUsage } from '../utils/cacheMaintenance';
import type { ProInferCapabilities, RawEngineSettings, RawMonitorCacheProgress } from '../types';
import type { AboutPanelContent } from '../types/aboutPanelContent';
import { extendAboutPanelContent } from '@edition/extendAboutPanelContent';
import { RawEngineSection } from '@edition/RawEngineSection';
import { RawEngineNotice } from '@edition/RawEngineNotice';
import {
  getDefaultProManifestPath,
  getProInferCapabilities,
  PRO_MODEL_MANIFEST_STORAGE_KEY,
  resetProInferState,
} from '../utils/proInfer';

const LIGHTROOM_PATH_STORAGE_KEY = 'framecull-lightroom-classic-path';

const updateSettingsSpotlight: React.PointerEventHandler<HTMLElement> = event => {
  updateSpotlightPosition(event.currentTarget, event.clientX, event.clientY);
};

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  theme: ResolvedTheme;
  themeMode: ThemeMode;
  language: Language;
  onThemeModeChange: (mode: ThemeMode) => void;
  onLanguageChange: (language: Language) => void;
  orphanStats: {
    raw: number;
    jpg: number;
  };
  onDeleteOrphanRaw: () => void;
  onDeleteOrphanJpg: () => void;
  onClearCaches: () => void;
  appCacheUsage?: AppCacheUsage | null;
  appCacheUsageBusy?: boolean;
  onRefreshAppCacheUsage?: () => void;
  rawEngineSettings?: RawEngineSettings | null;
  rawEngineBusy?: boolean;
  rawMonitorProgress?: RawMonitorCacheProgress;
  rawMonitorCacheSizeBytes?: number | null;
  rawMonitorCacheBusy?: boolean;
  onDetectRawEngine?: () => void;
  onChooseRawEngine?: () => void;
  onClearRawEngine?: () => void;
  onRefreshRawMonitorCacheSize?: () => void;
  onCleanupRawMonitorCache?: () => void;
  onClearRawMonitorCache?: () => void;
}

const settingsCopy = {
  zh: {
    aboutTitle: `关于 ${PRODUCT_DISPLAY_NAME}`,
    aboutEntryTitle: `关于 ${PRODUCT_DISPLAY_NAME}`,
    aboutEntryDescription: '查看产品定位、核心能力、运行要求和联系方式。',
    maintenance: '文件维护',
    maintenanceDescription: '只处理没有配对文件的孤立 RAW/JPG，不会按 AI 标签删除照片。',
    cacheTitle: '缓存',
    cacheDescription: '清除 AI 分析、筛片状态和预览缓存，不会删除照片，也不会重置语言、主题、AI 设置或 Lightroom 路径。',
    clearCaches: '清除缓存',
    cacheUsage: '\u5f53\u524d\u5360\u7528',
    cacheCalculating: '\u6b63\u5728\u8ba1\u7b97...',
    cacheUnknown: '\u5c1a\u672a\u7edf\u8ba1',
    cachePersistent: '\u5206\u6790/\u7b5b\u7247\u72b6\u6001',
    cacheDisk: '\u9884\u89c8\u7f13\u5b58',
    cacheRefresh: '\u5237\u65b0',
    cachePersistentHint: '\u4ec5\u5305\u542b AI \u5206\u6790\u7ed3\u679c\u548c\u672c\u5730\u7b5b\u7247\u72b6\u6001\uff0c\u4e0d\u5305\u542b\u7167\u7247\u6587\u4ef6\u3002',
    cacheDiskHint: '\u8f6f\u4ef6\u751f\u6210\u7684\u7f29\u7565\u56fe\u548c\u9884\u89c8\u6587\u4ef6\u7f13\u5b58\u3002\u6e05\u7406\u540e\u4e0d\u4f1a\u5220\u9664\u539f\u7247\uff0c\u9700\u8981\u65f6\u4f1a\u91cd\u65b0\u751f\u6210\u3002',
    cacheClearHint: '\u6e05\u9664 AI \u5206\u6790\u3001\u7b5b\u7247\u72b6\u6001\u548c\u8f6f\u4ef6\u9884\u89c8\u7f13\u5b58\uff0c\u4e0d\u5220\u9664\u539f\u7247\u548c\u7528\u6237\u8bbe\u7f6e\u3002',
    lightroom: 'Lightroom Classic',
    lightroomDescription: '用于写入星级后自动启动 Lightroom，并打开所选照片所在文件夹。',
    lightroomDetect: '自动检测',
    lightroomChoose: '\u9009\u62e9',
    lightroomClear: '清除',
    lightroomDetected: '已检测到 Lightroom Classic',
    lightroomNotFound: '未检测到 Lightroom Classic',
    lightroomManual: '已手动指定路径',
    proModel: 'Pro 实验模型',
    proModelDescription: '仅 Pro 可用。默认使用内置蒸馏语义学生模型；需要实验时可切换原生推理 manifest。',
    proModelChoose: '选择 manifest.json',
    proModelClear: '恢复内置模型',
    proModelDetected: '当前使用外部实验模型',
    proModelDefault: '当前使用内置语义学生模型',
    proModelEpActive: '当前推理',
    proModelEpIdle: '尚未初始化',
    proModelCudaReady: 'CUDA 已启用',
    proModelCudaFallback: '未命中 CUDA，已按降级链运行',
    proModelWarmup: '预热',
    proModelBackbone: '模型',
    proModelFallback: '回退原因',
    orphanRaw: '清理孤立 RAW',
    orphanJpg: '清理孤立 JPG',
    files: '个文件',
  },
  en: {
    aboutTitle: `About ${PRODUCT_DISPLAY_NAME}`,
    aboutEntryTitle: `About ${PRODUCT_DISPLAY_NAME}`,
    aboutEntryDescription: 'View product positioning, core features, requirements, and contact info.',
    maintenance: 'File Maintenance',
    maintenanceDescription: 'Only handles unpaired RAW/JPG files. It does not delete photos by AI labels.',
    cacheTitle: 'Cache',
    cacheDescription: 'Clears AI analysis, culling state, and preview caches without deleting photos or resetting language, theme, AI settings, or Lightroom path.',
    clearCaches: 'Clear caches',
    cacheUsage: 'Current usage',
    cacheCalculating: 'Calculating...',
    cacheUnknown: 'Not calculated',
    cachePersistent: 'Analysis / culling state',
    cacheDisk: 'Preview cache',
    cacheRefresh: 'Refresh',
    cachePersistentHint: 'AI analysis results and local culling state only. Photo files are not included.',
    cacheDiskHint: 'Generated thumbnails and preview-file cache. Clearing it never deletes originals; previews will be rebuilt when needed.',
    cacheClearHint: 'Clears AI analysis, culling state, and generated preview caches without deleting photos or user settings.',
    lightroom: 'Lightroom Classic',
    lightroomDescription: 'Used to launch Lightroom automatically and open the source folder after writing ratings.',
    lightroomDetect: 'Auto detect',
    lightroomChoose: 'Choose',
    lightroomClear: 'Clear',
    lightroomDetected: 'Lightroom Classic detected',
    lightroomNotFound: 'Lightroom Classic not found',
    lightroomManual: 'Manual path saved',
    proModel: 'Pro experimental model',
    proModelDescription: 'Pro only. Uses the bundled distilled semantic student model by default; switch the native manifest only for lab models.',
    proModelChoose: 'Choose manifest.json',
    proModelClear: 'Use bundled model',
    proModelDetected: 'Using external experimental model',
    proModelDefault: 'Using bundled semantic student model',
    proModelEpActive: 'Current inference',
    proModelEpIdle: 'Not initialized yet',
    proModelCudaReady: 'CUDA active',
    proModelCudaFallback: 'CUDA not active; fallback chain is in use',
    proModelWarmup: 'Warmup',
    proModelBackbone: 'Backbone',
    proModelFallback: 'Fallback reason',
    orphanRaw: 'Clean orphan RAW',
    orphanJpg: 'Clean orphan JPG',
    files: 'files',
  },
};

const aboutReadmeContent: Record<Language, AboutPanelContent> = {
  zh: {
    subtitle: '面向摄影师的本地 AI 筛片与图库整理助手。',
    intro: `${PRODUCT_DISPLAY_NAME} 围绕 RAW+JPG 工作流设计，把快速看图、AI 复查线索、AI 精选、重复照片清理、人物分片、星级写入和导出整理放在一个轻量工作台里。AI 分析在本机运行，不上传照片，也不替你黑箱删除照片。`,
    tags: ['本地运行', '轻量快速', 'AI 精选', '图库整理', '专注筛片'],
    sections: [
      {
        icon: ShieldCheck,
        title: '核心优势',
        bullets: [
          '照片分析在本机完成，不上传客户照片，适合婚礼、写真、商业拍摄等隐私敏感场景。',
          '轻量快速：专注筛片核心功能，启动快、切图快、内存占用低。',
          '四种融合识别算法结合本地美学模型，同时看人物状态、画面质量、主体关系和整体观感。',
          '不只服务人像，也能辅助空镜、风景、背影、环境人像和个人图库清理。',
          '界面、快捷键、胶片栏、星级、筛选和导出逻辑贴近 Lightroom / Photoshop ACR。',
        ],
      },
      {
        icon: Cpu,
        title: 'AI 能力',
        bullets: [
          'AI 筛图融合 YuNet 人脸检测、MediaPipe Face Landmarker、SubjectRanker 和本地规则判据。',
          '失焦判断结合 Laplacian、Tenengrad、边缘密度、眼部/脸部 ROI 和局部 tile peak。',
          '曝光判断会区分可后期修正的偏差和大面积死黑、过曝、主体信息丢失等硬伤。',
          'NIMA MobileNet ONNX 美学模型帮助背影、空镜、环境人像获得更合理的观感评分。',
          '人物分片使用 YuNet、5 点人脸对齐、SFace ONNX embedding 和余弦距离聚类。',
        ],
      },
      {
        icon: WandSparkles,
        title: 'AI 筛图',
        description: 'AI 提供复查线索，最终取舍仍由摄影师决定。',
        bullets: [
          '识别疑似闭眼、失焦、曝光异常、合照主体问题和重复连拍。',
          '主体优先判断，减少背景人物、配角或前景遮挡造成的误报。',
          '右侧判据页展示 AI 为什么给出提示，方便快速复核。',
        ],
      },
      {
        icon: Sparkles,
        title: 'AI 精选与重复照片',
        description: '先给出值得优先看的候选片，而不是替你直接删除。',
        bullets: [
          '每张照片生成可解释的 100 分评分，综合技术质量、美学观感、场景适配、曝光余量和 AI 风险。',
          '重复/连拍组会优先推荐可用 best，明显糊片、闭眼硬伤或已弃用照片不会成为 best。',
          '普通单张再按保留比例补足，适合先拿到一批优先复看的照片。',
        ],
      },
      {
        icon: UsersRound,
        title: '人物分片',
        bullets: [
          '自动把同一人物聚成分组，支持命名、合并、拆分和手动移动人脸。',
          '同一张多人照片可同时归入多个人物组，方便按客户或人物整理交付。',
          '支持按人物筛选照片，并按人物导出 JPG 结果。',
        ],
      },
      {
        icon: FileImage,
        title: 'RAW+JPG 工作流',
        bullets: [
          '自动配对同名 RAW+JPG，也保留单独 RAW 或 JPG 文件。',
          'RAW 优先使用内嵌 JPG 预览，自动修正方向，并用本地缓存提升切图速度。',
          '支持 Canon CR2/CR3、Nikon NEF/NRW、Sony ARW/SRF/SR2、Fujifilm RAF、Olympus/OM ORF、Panasonic RW2、Samsung SRW、Adobe DNG。',
        ],
      },
      {
        icon: Palette,
        title: '星级、元数据与导出',
        bullets: [
          '支持 0-5 星级、精选、弃用、取消标记，以及多种组合筛选。',
          'JPEG 星级写入文件元数据；RAW 星级写入同名 .xmp sidecar。',
          '支持 JPEG/TIFF/PNG 渲染副本，可选择 sRGB 或 Adobe RGB (1998)。',
          'Lightroom Classic 交接会写入当前星级、启动 Lightroom 并打开照片所在文件夹，不直接修改 catalog。',
        ],
      },
      {
        icon: Film,
        title: '界面与操作',
        bullets: [
          '胶片栏、大图、直方图、EXIF、AI 总览和判据集中在同一界面。',
          '支持方向键切图、A/D/S 标记、0-5 星级、多选、筛选和批量导出。',
          '深浅色主题与克制动效适合长时间筛片。',
        ],
      },
      {
        icon: MonitorCog,
        title: '系统要求',
        bullets: [
          '当前主要验证平台为 Windows 10 / 11 64 位。',
          '最低建议 4 核 CPU、8GB 内存、2GB 可用磁盘空间，推荐 SSD。',
          '不强制独立显卡，支持系统 WebView 硬件加速即可运行。',
        ],
      },
      {
        icon: Rocket,
        title: '快速开始',
        bullets: [
          '导入照片文件或文件夹，应用会自动扫描、配对 RAW+JPG 并准备首屏预览。',
          '用方向键切图，按 A/D/S 标记，按 0-5 设置星级。',
          '运行 AI 筛图后，先复查 AI 待复查和 AI 精选，再导出或移动结果。',
        ],
      },
      {
        icon: Keyboard,
        title: '常用快捷键',
        bullets: [
          '← / →：上一张 / 下一张。',
          'A：精选；D：弃用；S：取消标记。',
          '/：切换 AI 判据叠加显示。',
          '0：清除星级；1-5：设置星级。',
          'Ctrl+A：全选当前筛选结果；Ctrl+D：取消多选。',
        ],
      },
      {
        icon: Wrench,
        title: '当前定位',
        bullets: [
          'Flash 专注轻量筛片和图库整理，不内置编辑类 RAW 调色或风格监看能力。',
          '更完整的调色预览会作为独立产品线推进，不影响 Flash 的速度和轻量性。',
        ],
      },
    ],
    contactTitle: '欢迎交流共建',
    contactDescription: '欢迎联系作者交流真实筛片需求、测试样片和工作流改进。',
    email: '邮箱：2923834023@qq.com',
  },
  en: {
    subtitle: 'A local AI culling and library assistant for photographers.',
    intro: `${PRODUCT_DISPLAY_NAME} is built around RAW+JPG shooting workflows, bringing fast review, AI review hints, AI Picks, duplicate cleanup, People Split, ratings, and export into one lightweight desktop tool. AI analysis runs locally and does not upload photos or delete them automatically.`,
    tags: ['Local AI', 'Lightweight', 'AI Picks', 'Library Cleanup', 'Focused Culling'],
    sections: [
      {
        icon: ShieldCheck,
        title: 'Why It Stands Out',
        bullets: [
          'AI analysis runs locally and does not upload client photos, suitable for weddings, portraits, and commercial shoots.',
          'Lightweight and fast: focused on culling essentials with quick startup, fast navigation, and low memory usage.',
          'Four-fusion AI plus aesthetics combines subject state, image quality, subject priority, and overall visual impression.',
          'Useful for portraits, groups, bursts, empty frames, landscapes, backs, environmental portraits, and personal library cleanup.',
          'Navigation, filmstrip, ratings, filters, metadata, and export stay close to Lightroom / Photoshop ACR workflows.',
        ],
      },
      {
        icon: Cpu,
        title: 'AI Capabilities',
        bullets: [
          'AI culling combines YuNet face detection, MediaPipe Face Landmarker, SubjectRanker, and local rule evaluation.',
          'Focus review combines Laplacian, Tenengrad, edge density, eye / face ROI, and local tile peaks.',
          'Exposure review separates recoverable drift from broad clipped highlights, dead shadows, or subject detail loss.',
          'A local NIMA MobileNet ONNX aesthetic model assists backs, empty frames, environmental portraits, and overall impression.',
          'People Split uses YuNet, 5-point alignment, SFace ONNX embeddings, and cosine-distance clustering.',
        ],
      },
      {
        icon: WandSparkles,
        title: 'AI Culling',
        description: 'AI provides review evidence while the photographer stays in control.',
        bullets: [
          'Flags likely closed eyes, soft focus, exposure issues, group-subject issues, and duplicate bursts.',
          'Subject-first logic reduces false positives from background people, secondary faces, or foreground occluders.',
          'The evidence panel explains why a hint was raised.',
        ],
      },
      {
        icon: Sparkles,
        title: 'AI Picks And Duplicates',
        description: 'A practical candidate set for photographers to review first.',
        bullets: [
          'Each photo gets an explainable 100-point score across technical quality, aesthetics, scene fit, exposure headroom, and AI risk.',
          'Duplicate / burst groups recommend a usable best; obvious blur, closed-eye hard issues, or rejected photos cannot become best.',
          'Single photos fill the remaining target ratio so you can start with a focused review set.',
        ],
      },
      {
        icon: UsersRound,
        title: 'People Split',
        bullets: [
          'Automatically clusters the same person and supports naming, merging, splitting, and manual adjustment.',
          'One group photo can belong to multiple people, which makes client-based delivery easier.',
          'Filter by person and export JPG results into person folders.',
        ],
      },
      {
        icon: FileImage,
        title: 'RAW+JPG Workflow',
        bullets: [
          'Automatically pairs matching RAW+JPG files while keeping standalone RAW or JPG visible.',
          'RAW browsing prefers embedded JPEG previews, orientation correction, and local preview cache.',
          'Supports Canon CR2/CR3, Nikon NEF/NRW, Sony ARW/SRF/SR2, Fujifilm RAF, Olympus/OM ORF, Panasonic RW2, Samsung SRW, and Adobe DNG.',
        ],
      },
      {
        icon: Palette,
        title: 'Ratings, Metadata, And Export',
        bullets: [
          'Supports 0-5 ratings, pick, reject, unmark, and combined filters.',
          'JPEG ratings write to metadata; RAW ratings write matching .xmp sidecars.',
          'JPEG/TIFF/PNG rendered copies can export as sRGB or Adobe RGB (1998).',
          'Lightroom Classic handoff writes current ratings, launches Lightroom, and opens the source folder without editing the catalog.',
        ],
      },
      {
        icon: Film,
        title: 'Interface And Operation',
        bullets: [
          'Filmstrip, large preview, histogram, EXIF, AI overview, and evidence live in one workspace.',
          'Supports arrow-key navigation, A/D/S marking, 0-5 ratings, multi-select, filters, and batch export.',
          'Dark/light themes and restrained motion are tuned for long review sessions.',
        ],
      },
      {
        icon: MonitorCog,
        title: 'System Requirements',
        bullets: [
          'Primary validated platform: Windows 10 / 11 64-bit.',
          'Minimum recommendation: 4-core CPU, 8GB RAM, 2GB free disk space, preferably SSD.',
          'No dedicated GPU is required; system WebView hardware acceleration is enough.',
        ],
      },
      {
        icon: Rocket,
        title: 'Quick Start',
        bullets: [
          'Import files or folders; the app scans, pairs RAW+JPG, and prepares the first preview.',
          'Use arrow keys to navigate, A/D/S to mark, and 0-5 to rate.',
          'Run AI culling, review AI Review and AI Picks, then export or move the results.',
        ],
      },
      {
        icon: Keyboard,
        title: 'Shortcuts',
        bullets: [
          'Left / Right: previous / next photo.',
          'A: Pick; D: Reject; S: Unmark.',
          '/: toggle AI evidence overlay.',
          '0: clear rating; 1-5: set rating.',
          'Ctrl+A: select all filtered results; Ctrl+D: clear multi-selection.',
        ],
      },
      {
        icon: Wrench,
        title: 'Current Positioning',
        bullets: [
          'Flash focuses on lightweight culling and library organization, without editing-style preview tools.',
          'Advanced preview tools stay in a separate product line so Flash remains fast and small.',
        ],
      },
    ],
    contactTitle: 'Contact And Co-Build',
    contactDescription: 'Contact the author to discuss real culling needs, test sessions, and workflow improvements.',
    email: 'Email: 2923834023@qq.com',
  },
};

function getAboutPanelContent(language: Language): AboutPanelContent {
  return extendAboutPanelContent(aboutReadmeContent[language], language, PRODUCT_DISPLAY_NAME);
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen,
  onClose,
  theme,
  themeMode,
  language,
  onThemeModeChange,
  onLanguageChange,
  orphanStats,
  onDeleteOrphanRaw,
  onDeleteOrphanJpg,
  onClearCaches,
  appCacheUsage,
  appCacheUsageBusy = false,
  onRefreshAppCacheUsage,
  rawEngineSettings,
  rawEngineBusy = false,
  rawMonitorProgress,
  rawMonitorCacheSizeBytes,
  rawMonitorCacheBusy = false,
  onDetectRawEngine,
  onChooseRawEngine,
  onClearRawEngine,
  onRefreshRawMonitorCacheSize,
  onCleanupRawMonitorCache,
  onClearRawMonitorCache,
}) => {
  const [view, setView] = useState<'settings' | 'about'>('settings');
  const [lightroomPath, setLightroomPath] = useState(() => readStorage(LIGHTROOM_PATH_STORAGE_KEY) || '');
  const [lightroomDetecting, setLightroomDetecting] = useState(false);
  const [lightroomStatus, setLightroomStatus] = useState<'idle' | 'detected' | 'manual' | 'notFound' | 'error'>(lightroomPath ? 'manual' : 'idle');
  const [proModelPath, setProModelPath] = useState(() => readStorage(PRO_MODEL_MANIFEST_STORAGE_KEY) || '');
  const [defaultProManifestPath, setDefaultProManifestPath] = useState('');
  const [proInferCapabilities, setProInferCapabilities] = useState<ProInferCapabilities | null>(() =>
    IS_PRO_EDITION ? getProInferCapabilities() : null,
  );
  const t = getTranslations(language);
  const text = settingsCopy[language];
  const showingAbout = view === 'about';
  const proFallbackSummary = proInferCapabilities?.epFallbackChain.find(item =>
    item.toLowerCase().includes('cuda') && !item.toLowerCase().includes('active'),
  ) ?? proInferCapabilities?.epFallbackChain.find(item => !item.toLowerCase().includes('active'));
  const appCacheUsageLabel = appCacheUsageBusy
    ? text.cacheCalculating
    : appCacheUsage
      ? formatPanelCacheSize(appCacheUsage.totalBytes)
      : text.cacheUnknown;
  const appCachePersistentLabel = appCacheUsage
    ? formatPanelCacheSize(appCacheUsage.persistentBytes)
    : text.cacheUnknown;
  const appCacheDiskLabel = appCacheUsage
    ? formatPanelCacheSize(appCacheUsage.diskBytes)
    : text.cacheUnknown;
  const cacheMaintenanceSection = (
    <SettingsSection theme={theme} icon={DatabaseZap} title={text.cacheTitle} description={text.cacheDescription} separated>
      <button
        type="button"
        onClick={onClearCaches}
        title={text.cacheClearHint}
        className={`flex w-full items-center justify-between rounded-lg border px-3 py-3 text-left transition-colors ${
          theme === 'dark'
            ? `${glassSubtle.dark} text-zinc-200 hover:bg-cyan-400/10`
            : 'border-slate-400/30 bg-slate-100/[0.62] text-slate-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] hover:border-cyan-400/40 hover:bg-cyan-100/56'
        }`}
      >
        <span className="flex items-center gap-2 text-xs font-semibold">
          <AppIcon icon={DatabaseZap} className={`h-4 w-4 ${theme === 'dark' ? 'text-cyan-200' : 'text-cyan-700'}`} />
          {text.clearCaches}
        </span>
        <span className={`shrink-0 pl-3 text-[11px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}`}>
          {text.cacheUsage}: <span className={`font-mono ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-900'}`}>{appCacheUsageLabel}</span>
        </span>
      </button>
      <div className={`mt-2 flex items-center gap-3 text-[10.5px] ${
        theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'
      }`}>
        <span className="min-w-0 shrink-0 whitespace-nowrap" title={text.cachePersistentHint}>
          {text.cachePersistent}: <span className={`font-mono font-semibold ${theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}`}>{appCachePersistentLabel}</span>
        </span>
        <span className="min-w-0 shrink-0 whitespace-nowrap" title={text.cacheDiskHint}>
          {text.cacheDisk}: <span className={`font-mono font-semibold ${theme === 'dark' ? 'text-zinc-300' : 'text-slate-700'}`}>{appCacheDiskLabel}</span>
        </span>
        <button
          type="button"
          onClick={onRefreshAppCacheUsage || (() => undefined)}
          disabled={appCacheUsageBusy}
          title={text.cacheRefresh}
          className={`ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-wait disabled:opacity-45 ${
            theme === 'dark'
              ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-cyan-200'
              : 'text-slate-500 hover:bg-white/70 hover:text-cyan-700'
          }`}
        >
          <AppIcon icon={RefreshCw} className={`h-3.5 w-3.5 ${appCacheUsageBusy ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </SettingsSection>
  );

  const handleClose = () => {
    setView('settings');
    onClose();
  };

  const detectLightroom = async () => {
    setLightroomDetecting(true);
    try {
      const detected = await invoke<string | null>('detect_lightroom_classic');
      if (detected) {
        localStorage.setItem(LIGHTROOM_PATH_STORAGE_KEY, detected);
        setLightroomPath(detected);
        setLightroomStatus('detected');
      } else {
        setLightroomStatus('notFound');
      }
    } catch {
      setLightroomStatus('error');
    } finally {
      setLightroomDetecting(false);
    }
  };

  const chooseLightroomPath = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [
        { name: 'Lightroom Classic', extensions: ['exe', 'app'] },
      ],
      title: text.lightroomChoose,
    });
    if (typeof selected === 'string') {
      localStorage.setItem(LIGHTROOM_PATH_STORAGE_KEY, selected);
      setLightroomPath(selected);
      setLightroomStatus('manual');
    }
  };

  const clearLightroomPath = () => {
    localStorage.removeItem(LIGHTROOM_PATH_STORAGE_KEY);
    setLightroomPath('');
    setLightroomStatus('idle');
  };

  React.useEffect(() => {
    if (!IS_PRO_EDITION) return;
    let cancelled = false;
    void getDefaultProManifestPath()
      .then(path => {
        if (!cancelled) setDefaultProManifestPath(path);
      })
      .catch(() => {
        if (!cancelled) setDefaultProManifestPath('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!IS_PRO_EDITION || !isOpen) return;
    setProInferCapabilities(getProInferCapabilities());
  }, [isOpen, proModelPath]);

  const chooseProModelPath = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [
        { name: 'FrameCull Pro manifest', extensions: ['json'] },
      ],
      title: text.proModelChoose,
    });
    if (typeof selected === 'string') {
      localStorage.setItem(PRO_MODEL_MANIFEST_STORAGE_KEY, selected);
      setProModelPath(selected);
      resetProInferState();
      setProInferCapabilities(null);
    }
  };

  const clearProModelPath = () => {
    localStorage.removeItem(PRO_MODEL_MANIFEST_STORAGE_KEY);
    setProModelPath('');
    resetProInferState();
    setProInferCapabilities(null);
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className={`fixed inset-0 z-40 ${modalBackdrop}`}
        onClick={handleClose}
      />

      <div className={`fixed top-16 right-6 z-50 flex max-h-[calc(100vh-5rem)] w-96 flex-col overflow-hidden rounded-lg border ${theme === 'dark' ? chromeGlass.dark : chromeGlass.light}`}>
        <div className={`flex shrink-0 items-center justify-between border-b px-6 py-4 ${theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-400/24'}`}>
          <div className="flex min-w-0 items-center gap-2">
            {showingAbout && (
              <button
                type="button"
                onClick={() => setView('settings')}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${theme === 'dark' ? glassInteractive.dark : glassInteractive.light}`}
                title={t.settings.title}
              >
                <AppIcon icon={ArrowLeft} className="h-4 w-4" />
              </button>
            )}
            <h3 className={`truncate text-[18px] font-semibold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              {showingAbout ? text.aboutTitle : t.settings.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${theme === 'dark' ? glassInteractive.dark : glassInteractive.light}`}
          >
            <AppIcon icon={X} className="h-4 w-4" />
          </button>
        </div>

        {showingAbout ? (
          <AboutPanelContent theme={theme} language={language} title={text.aboutTitle} />
        ) : (
          <div className="space-y-6 overflow-y-auto p-6">
            <button
              type="button"
              onClick={() => setView('about')}
              onPointerMove={updateSettingsSpotlight}
              className={`fc-spotlight-surface relative w-full rounded-lg border p-4 text-left transition-colors ${
                theme === 'dark'
                  ? `${glassSubtle.dark} hover:bg-white/[0.06]`
                  : 'border-slate-400/24 bg-slate-100/[0.62] shadow-[inset_0_1px_0_rgba(255,255,255,0.78)] hover:bg-white/68'
              }`}
            >
              <div className="flex items-start gap-3">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${theme === 'dark' ? 'bg-cyan-300/10 text-cyan-200' : 'bg-cyan-100/80 text-cyan-700'}`}>
                  <AppIcon icon={Info} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-bold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-950'}`}>
                    {text.aboutEntryTitle}
                  </span>
                  <span className={`mt-1 block text-xs leading-5 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
                    {text.aboutEntryDescription}
                  </span>
                  <span className={`mt-2 inline-flex rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${theme === 'dark' ? 'bg-white/[0.06] text-zinc-300' : 'bg-white/70 text-slate-600'}`}>
                    {APP_VERSION}
                  </span>
                </span>
              </div>
            </button>

            <SettingsSection theme={theme} icon={Palette} title={t.settings.theme}>
              <div className="flex gap-2">
                <SegmentButton active={themeMode === 'light'} theme={theme} onClick={() => onThemeModeChange('light')} icon={Sun}>
                  {t.settings.lightMode}
                </SegmentButton>
                <SegmentButton active={themeMode === 'dark'} theme={theme} onClick={() => onThemeModeChange('dark')} icon={Moon}>
                  {t.settings.darkMode}
                </SegmentButton>
                <SegmentButton active={themeMode === 'system'} theme={theme} onClick={() => onThemeModeChange('system')} icon={MonitorCog}>
                  {t.settings.systemMode}
                </SegmentButton>
              </div>
            </SettingsSection>

            <SettingsSection theme={theme} icon={Languages} title={t.settings.language}>
              <div className="flex gap-2">
                <SegmentButton active={language === 'zh'} theme={theme} onClick={() => onLanguageChange('zh')}>
                  {t.settings.chinese}
                </SegmentButton>
                <SegmentButton active={language === 'en'} theme={theme} onClick={() => onLanguageChange('en')}>
                  {t.settings.english}
                </SegmentButton>
              </div>
            </SettingsSection>

            {cacheMaintenanceSection}

            <SettingsSection theme={theme} icon={MonitorCog} title={text.lightroom} description={text.lightroomDescription} separated>
              <div
                onPointerMove={updateSettingsSpotlight}
                className={`fc-spotlight-surface relative rounded-lg border p-3 ${
                theme === 'dark'
                  ? glassSubtle.dark
                  : 'border-slate-400/30 bg-slate-100/[0.62] shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]'
              }`}>
                <div className={`text-xs font-semibold ${
                  lightroomStatus === 'detected' || lightroomStatus === 'manual'
                    ? theme === 'dark' ? 'text-emerald-300' : 'text-emerald-700'
                    : theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'
                }`}>
                  {lightroomStatus === 'detected' || lightroomStatus === 'manual'
                    ? (lightroomStatus === 'manual' ? text.lightroomManual : text.lightroomDetected)
                    : text.lightroomNotFound}
                </div>
                <div className={`mt-2 truncate font-mono text-[10px] ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
                  {lightroomPath || 'Lightroom.exe'}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <SmallSettingsButton theme={theme} onClick={detectLightroom} disabled={lightroomDetecting}>
                    {lightroomDetecting ? '...' : text.lightroomDetect}
                  </SmallSettingsButton>
                  <SmallSettingsButton theme={theme} onClick={() => { void chooseLightroomPath(); }}>
                    {text.lightroomChoose}
                  </SmallSettingsButton>
                  <SmallSettingsButton theme={theme} onClick={clearLightroomPath} disabled={!lightroomPath}>
                    {text.lightroomClear}
                  </SmallSettingsButton>
                </div>
              </div>
            </SettingsSection>

            {IS_PRO_EDITION && (
              <SettingsSection theme={theme} icon={Cpu} title={text.proModel} description={text.proModelDescription} separated>
                <div
                  onPointerMove={updateSettingsSpotlight}
                  className={`fc-spotlight-surface relative rounded-lg border p-3 ${
                  theme === 'dark'
                    ? glassSubtle.dark
                    : 'border-slate-400/30 bg-slate-100/[0.62] shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]'
                }`}>
                  <div className={`text-xs font-semibold ${
                    proModelPath
                      ? theme === 'dark' ? 'text-cyan-300' : 'text-cyan-700'
                      : theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'
                  }`}>
                    {proModelPath ? text.proModelDetected : text.proModelDefault}
                  </div>
                  <div className={`mt-2 break-all font-mono text-[10px] leading-5 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
                    {proModelPath || defaultProManifestPath || 'pro-models/semantic_student_v2_grounded_convnext_v14_five_mountain_region/manifest.int8.json'}
                  </div>
                  <div className={`mt-3 rounded-md px-2.5 py-2 text-[10.5px] leading-5 ${
                    theme === 'dark' ? 'bg-black/18 text-zinc-400' : 'bg-white/64 text-slate-600'
                  }`}>
                    <div className="flex items-center justify-between gap-3">
                      <span>{text.proModelEpActive}</span>
                      <span className={`font-mono font-semibold ${
                        proInferCapabilities?.activeEp === 'cuda'
                          ? theme === 'dark' ? 'text-emerald-300' : 'text-emerald-700'
                          : theme === 'dark' ? 'text-amber-300' : 'text-amber-700'
                      }`}>
                        {proInferCapabilities?.activeEp?.toUpperCase() ?? text.proModelEpIdle}
                      </span>
                    </div>
                    {proInferCapabilities && (
                      <>
                        <div className="mt-1 flex items-center justify-between gap-3">
                          <span>{proInferCapabilities.activeEp === 'cuda' ? text.proModelCudaReady : text.proModelCudaFallback}</span>
                          <span className="font-mono">{text.proModelWarmup} {Math.round(proInferCapabilities.warmupMs)}ms</span>
                        </div>
                        <div className="mt-1 truncate font-mono" title={proInferCapabilities.backboneVersion}>
                          {text.proModelBackbone}: {proInferCapabilities.backboneVersion}
                        </div>
                        {proInferCapabilities.activeEp !== 'cuda' && proFallbackSummary && (
                          <div className="mt-1 truncate" title={proInferCapabilities.epFallbackChain.join(' | ')}>
                            {text.proModelFallback}: {proFallbackSummary}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <SmallSettingsButton theme={theme} onClick={() => { void chooseProModelPath(); }}>
                      {text.proModelChoose}
                    </SmallSettingsButton>
                    <SmallSettingsButton theme={theme} onClick={clearProModelPath} disabled={!proModelPath}>
                      {text.proModelClear}
                    </SmallSettingsButton>
                  </div>
                </div>
              </SettingsSection>
            )}

            <RawEngineSection
              theme={theme}
              language={language}
              settings={rawEngineSettings}
              busy={rawEngineBusy}
              progress={rawMonitorProgress}
              cacheSizeBytes={rawMonitorCacheSizeBytes}
              cacheBusy={rawMonitorCacheBusy}
              onDetect={onDetectRawEngine}
              onChoose={onChooseRawEngine}
              onClear={onClearRawEngine}
              onRefreshCacheSize={onRefreshRawMonitorCacheSize}
              onCleanupCache={onCleanupRawMonitorCache}
              onClearCache={onClearRawMonitorCache}
            />

            <SettingsSection theme={theme} icon={Wrench} title={text.maintenance} description={text.maintenanceDescription} separated>
              <div className="grid grid-cols-2 gap-2">
                <MaintenanceButton
                  theme={theme}
                  icon={FileImage}
                  label={text.orphanRaw}
                  count={orphanStats.raw}
                  suffix={text.files}
                  onClick={onDeleteOrphanRaw}
                />
                <MaintenanceButton
                  theme={theme}
                  icon={Image}
                  label={text.orphanJpg}
                  count={orphanStats.jpg}
                  suffix={text.files}
                  onClick={onDeleteOrphanJpg}
                />
              </div>
            </SettingsSection>

            <div className={`border-t pt-6 ${theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-400/24'}`}>
              <ShortcutSettings theme={theme} language={language} />
            </div>
          </div>
        )}

        <div className={`shrink-0 border-t px-6 py-3 text-center text-[11px] font-semibold ${
          theme === 'dark'
            ? 'border-white/[0.055] bg-white/[0.018] text-zinc-500'
            : 'border-slate-400/22 bg-slate-100/[0.40] text-slate-500'
        }`}>
          {PRODUCT_FOOTER}
        </div>
      </div>
    </>
  );
};

function formatPanelCacheSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const SettingsSection = ({
  theme,
  icon,
  title,
  description,
  separated,
  children,
}: {
  theme: ResolvedTheme;
  icon: LucideIcon;
  title: string;
  description?: string;
  separated?: boolean;
  children: React.ReactNode;
}) => (
  <div className={separated ? `border-t pt-6 ${theme === 'dark' ? 'border-white/[0.06]' : 'border-slate-400/24'}` : undefined}>
    <label className={`mb-3 block text-[13px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-gray-600'}`}>
      <AppIcon icon={icon} className="mr-2 inline h-4 w-4 align-[-3px]" />
      {title}
    </label>
    {description && (
      <p className={`mb-3 text-xs leading-relaxed ${theme === 'dark' ? 'text-zinc-500' : 'text-gray-500'}`}>
        {description}
      </p>
    )}
    {children}
  </div>
);

const SegmentButton = ({
  active,
  theme,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  theme: ResolvedTheme;
  icon?: LucideIcon;
  children: React.ReactNode;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex-1 rounded-lg px-3 py-3 text-[13px] font-semibold transition-all ${
      active
        ? theme === 'dark'
          ? 'bg-cyan-300 text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]'
          : 'bg-slate-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]'
        : theme === 'dark'
          ? 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
          : 'bg-slate-100/[0.64] text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] hover:bg-white/72 hover:text-slate-900'
    }`}
  >
    {icon && <AppIcon icon={icon} className="mr-1.5 inline h-4 w-4 align-[-3px]" />}
    {children}
  </button>
);

const MaintenanceButton = ({
  theme,
  icon,
  label,
  count,
  suffix,
  onClick,
}: {
  theme: ResolvedTheme;
  icon: LucideIcon;
  label: string;
  count: number;
  suffix: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={count === 0}
    className={`min-h-20 rounded-lg border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-35 ${
      theme === 'dark'
        ? `${glassSubtle.dark} text-zinc-200 hover:bg-amber-400/10`
        : 'border-slate-400/30 bg-slate-100/[0.62] text-slate-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] hover:border-amber-400/40 hover:bg-amber-100/56'
    }`}
  >
    <div className="flex items-center justify-between gap-3">
      <AppIcon icon={icon} className={`h-4 w-4 ${theme === 'dark' ? 'text-amber-300' : 'text-amber-600'}`} />
      <span className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold">{count}</span>
    </div>
    <div className="mt-3 text-xs font-semibold">{label}</div>
    <div className={`mt-1 text-[10px] ${theme === 'dark' ? 'text-zinc-500' : 'text-gray-500'}`}>
      {count} {suffix}
    </div>
  </button>
);

const SmallSettingsButton = ({
  theme,
  children,
  disabled,
  onClick,
  className = '',
  title,
}: {
  theme: ResolvedTheme;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  title?: string;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    title={title}
    className={`min-h-8 whitespace-nowrap rounded-md px-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      theme === 'dark'
        ? 'bg-white/[0.06] text-zinc-200 hover:bg-white/[0.10]'
        : 'bg-white/70 text-slate-700 hover:bg-white'
    } ${className}`}
  >
    {children}
  </button>
);

const AboutPanelContent = ({
  theme,
  language,
  title,
}: {
  theme: ResolvedTheme;
  language: Language;
  title: string;
}) => {
  const content = getAboutPanelContent(language);

  return (
    <div className="overflow-y-auto p-6">
      <div className={`rounded-lg border p-4 ${
        theme === 'dark'
          ? 'border-white/[0.05] bg-white/[0.035]'
          : 'border-slate-400/24 bg-white/54 shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]'
      }`}>
        <div className={`text-[11px] font-semibold ${theme === 'dark' ? 'text-cyan-200' : 'text-cyan-700'}`}>
          {APP_VERSION}
        </div>
        <div className={`mt-1 text-[17px] font-bold ${theme === 'dark' ? 'text-zinc-50' : 'text-slate-950'}`}>
          {title}
        </div>
        <p className={`mt-2 text-[13px] leading-6 ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}`}>
          {content.subtitle}
        </p>
        <p className={`mt-3 text-[12px] leading-6 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {content.intro}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {content.tags.map(tag => (
            <span
              key={tag}
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                theme === 'dark' ? 'bg-white/[0.06] text-zinc-300' : 'bg-white/70 text-slate-600'
              }`}
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {content.sections.map(section => (
          <AboutSection
            key={section.title}
            theme={theme}
            icon={section.icon}
            title={section.title}
            description={section.description}
            bullets={section.bullets}
          />
        ))}
      </div>

      <RawEngineNotice theme={theme} language={language} />

      <div className={`mt-4 rounded-lg border p-4 ${
        theme === 'dark'
          ? 'border-white/[0.05] bg-white/[0.035]'
          : 'border-slate-400/24 bg-white/54 shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]'
      }`}>
        <div className={`text-sm font-bold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-950'}`}>
          {content.contactTitle}
        </div>
        <p className={`mt-1 text-xs leading-5 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
          {content.contactDescription}
        </p>
        <div className="mt-3 space-y-2">
          <ContactLine theme={theme} icon={Mail} value={content.email} />
        </div>
      </div>
    </div>
  );
};

const AboutSection = ({
  theme,
  icon,
  title,
  description,
  bullets,
}: {
  theme: ResolvedTheme;
  icon: LucideIcon;
  title: string;
  description?: string;
  bullets: string[];
}) => (
  <div className={`rounded-lg border p-3 ${
    theme === 'dark'
      ? 'border-white/[0.045] bg-white/[0.026]'
      : 'border-slate-400/20 bg-slate-100/[0.56]'
  }`}>
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
        theme === 'dark' ? 'bg-white/[0.055] text-cyan-200' : 'bg-white/72 text-cyan-700'
      }`}>
        <AppIcon icon={icon} className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className={`block text-[13px] font-bold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-900'}`}>
          {title}
        </span>
        {description && (
          <span className={`mt-1 block text-[12px] leading-5 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
            {description}
          </span>
        )}
        <ul className={`mt-2 space-y-1.5 text-[12px] leading-5 ${theme === 'dark' ? 'text-zinc-400' : 'text-slate-600'}`}>
          {bullets.map(bullet => (
            <li key={bullet} className="flex gap-2">
              <span className={`mt-[8px] h-1 w-1 shrink-0 rounded-full ${theme === 'dark' ? 'bg-cyan-300/70' : 'bg-cyan-700/65'}`} />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      </span>
    </div>
  </div>
);

const ContactLine = ({
  theme,
  icon,
  value,
}: {
  theme: ResolvedTheme;
  icon: LucideIcon;
  value: string;
}) => (
  <div className={`flex items-center gap-2 rounded-lg px-3 py-2 font-mono text-[12px] font-semibold ${
    theme === 'dark' ? 'bg-black/18 text-zinc-200' : 'bg-white/64 text-slate-800'
  }`}>
    <AppIcon icon={icon} className={`h-3.5 w-3.5 ${theme === 'dark' ? 'text-cyan-200' : 'text-cyan-700'}`} />
    <span>{value}</span>
  </div>
);

export default SettingsPanel;
