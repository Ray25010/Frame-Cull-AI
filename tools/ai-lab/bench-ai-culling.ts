import AiAnalyzerWorker from '/src/workers/aiAnalyzer.worker.ts?worker';
import PeopleSplitWorker from '/src/workers/peopleSplit.worker.ts?worker';
import { DEFAULT_AI_SETTINGS } from '/src/utils/aiLabels';
import { classifyDuplicateGroups, compactDuplicateBuckets, duplicatePairSimilarities, duplicatePhotoIds, duplicateSimilarity } from '/src/utils/duplicateDetection';
import { buildAiPickDecisionReasons, buildAiPickedPhotoIds } from '/src/utils/photoScoring';
import {
  GroupStatus,
  SelectionState,
  type AiAnalysis,
  type AiIssueCode,
  type AiModelAssets,
  type AiPhotoScoreComponentKey,
  type AiSettings,
  type DuplicateSensitivity,
  type DuplicateGroup,
  type PhotoGroup,
} from '/src/types';

type OnnxBackend = NonNullable<AiModelAssets['onnxBackend']>;

type WorkerResponse = {
  type: 'result' | 'error';
  id: string;
  analysis?: AiAnalysis;
  error?: string;
};

type PeopleWorkerResponse = {
  type: 'result' | 'error' | 'progress';
  id: string;
  faces?: unknown[];
  error?: string;
  stage?: string;
};

type BenchOptions = {
  concurrencies?: number[];
  limit?: number;
  maxEdge?: number;
  prepareConcurrency?: number;
  collectAnalysisSummary?: boolean;
  backend?: OnnxBackend;
  disableAesthetic?: boolean;
  disableFaceChecks?: boolean;
  disableDuplicateSignature?: boolean;
};

type CombinedBenchOptions = {
  combos?: Array<{ aiConcurrency: number; peopleConcurrency: number }>;
  limit?: number;
  aiMaxEdge?: number;
  peopleMaxEdge?: number;
  aiBackend?: OnnxBackend;
  peopleBackend?: OnnxBackend;
};

type PeopleBenchOptions = {
  concurrencies?: number[];
  limit?: number;
  maxEdge?: number;
  backend?: OnnxBackend;
  logProgress?: boolean;
};

type AiPickAuditOptions = {
  limit?: number;
  maxEdge?: number;
  backend?: OnnxBackend;
  concurrency?: number;
  aiPickTargetRatio?: number;
  duplicateSensitivity?: DuplicateSensitivity;
  groundTruthRatings?: Record<string, number>;
  sourceNames?: Record<string, string>;
  mode?: 'pick-audit' | 'raw-pick-audit';
  prepareConcurrency?: number;
  auditBatchSize?: number;
  imageTimeoutMs?: number;
  collectPairSimilarities?: boolean;
  ratios?: number[];
};

type BenchRunResult = {
  concurrency: number;
  totalImages: number;
  totalMs: number;
  imagesPerSecond: number;
  averageMs: number;
  medianMs: number;
  p90Ms: number;
  averagePrepareMs: number;
  averagePrepareWorkMs: number;
  averageWorkerMs: number;
  prepareConcurrency: number;
  maxFrameGapMs: number;
  p95FrameGapMs: number;
  errors: string[];
  analysisSummary?: Record<string, AnalysisSummary>;
};

type AnalysisSummary = {
  faceCount?: number;
  faceCandidateCount?: number;
  landmarkedFaceCount?: number;
  primarySubjectCount?: number;
  subjectConfidence?: string;
  regionCount: number;
};

type BenchResult = {
  files: number;
  usedFiles: string[];
  hardwareConcurrency: number;
  maxEdge: number;
  backend: OnnxBackend;
  startedAt: string;
  runs: BenchRunResult[];
  best: BenchRunResult | null;
};

type CombinedRunResult = {
  aiConcurrency: number;
  peopleConcurrency: number;
  wallMs: number;
  aiImagesPerSecond: number;
  peopleImagesPerSecond: number;
  aiTotalMs: number;
  peopleTotalMs: number;
  aiErrors: number;
  peopleErrors: number;
};

type CombinedBenchResult = {
  files: number;
  usedFiles: string[];
  hardwareConcurrency: number;
  aiMaxEdge: number;
  peopleMaxEdge: number;
  aiBackend: OnnxBackend;
  peopleBackend: OnnxBackend;
  startedAt: string;
  runs: CombinedRunResult[];
  best: CombinedRunResult | null;
};

type PeopleBenchRunResult = {
  concurrency: number;
  totalImages: number;
  totalMs: number;
  imagesPerSecond: number;
  averageMs: number;
  errors: string[];
  progressEvents?: string[];
};

type PeopleBenchResult = {
  files: number;
  usedFiles: string[];
  hardwareConcurrency: number;
  maxEdge: number;
  backend: OnnxBackend;
  startedAt: string;
  runs: PeopleBenchRunResult[];
  best: PeopleBenchRunResult | null;
};

type AiPickAuditPhotoSummary = {
  id: string;
  fileName: string;
  sourceName?: string;
  groundTruthRating?: number;
  groundTruthPositive?: boolean;
  status: AiAnalysis['status'];
  picked: boolean;
  inDuplicateGroup: boolean;
  formalBest: boolean;
  issueCodes: string[];
  hardIssueCodes: string[];
  reviewHintCodes: string[];
  overall?: number;
  grade?: string;
  technical?: number;
  aesthetic?: number;
  scene?: number;
  scoreComponents?: Array<{
    key: string;
    label: string;
    score: number;
    weight: number;
    detail?: string;
  }>;
  focusTexture?: number;
  focusPeakTexture?: number;
  focusReliability?: number;
  focusReliable?: boolean;
  aestheticStatus?: string;
  proAesthetic?: number;
  proPersonaScore?: number;
  proSceneLabel?: string;
  proSceneConfidence?: number;
  proActiveEp?: string;
  proManifestPath?: string;
  gateReasons?: string[];
  exclusionReasons: string[];
  duplicateSignature?: AiAnalysis['duplicateSignature'];
  pickDecisionReasons?: string[];
  pickBucketKind?: 'duplicate' | 'burst' | 'solo';
  pickRepresentativeId?: string;
  pickRankScore?: number;
};

type AiPickAuditResult = {
  mode: 'pick-audit' | 'raw-pick-audit';
  files: number;
  usedFiles: string[];
  hardwareConcurrency: number;
  maxEdge: number;
  backend: OnnxBackend;
  concurrency: number;
  targetRatio: number;
  startedAt: string;
  totalMs: number;
  analysisMs: number;
  groupingMs: number;
  errors: string[];
  counts: {
    total: number;
    done: number;
    errors: number;
    hardIssuePhotos: number;
    reviewHintPhotos: number;
    noIssuePhotos: number;
    focusFailPhotos: number;
    scoreMissingPhotos: number;
    usableCandidatePhotos: number;
    targetCount: number;
    aiPicked: number;
    aiPickedDuplicateMembers: number;
    aiPickedFormalBest: number;
    aiPickedWithHardIssue: number;
    aiPickedWithAnyIssue: number;
  };
  issueCodeCounts: Partial<Record<AiIssueCode, number>>;
  exclusionReasonCounts: Record<string, number>;
  scoreDistribution: {
    overall: DistributionSummary;
    technical: DistributionSummary;
    aesthetic: DistributionSummary;
  };
  duplicateStats: {
    groupCount: number;
    duplicatePhotoCount: number;
    bestPhotoCount: number;
    maxGroupSize: number;
    averageGroupSize: number;
    groupsWithoutAnyAiPick: number;
    groupsWithMultipleAiPicks: number;
    selectedAdjacentSimilarPairs: number;
    selectedAdjacentSimilarSamples: Array<{
      left: string;
      right: string;
      similarity: number;
      gap: number;
    }>;
    largeGroups: Array<{
      id: string;
      size: number;
      selectedCount: number;
      bestPhotoId?: string;
      firstIds: string[];
    }>;
    supervisedGroups?: Array<{
      id: string;
      size: number;
      selectedCount: number;
      bestPhotoId?: string;
      positiveCount: number;
      negativeCount: number;
      usableCount: number;
      photos: Array<{
        id: string;
        rating?: number;
        picked: boolean;
        usable: boolean;
        overall?: number;
        technical?: number;
        issueCodes: string[];
        exclusionReasons: string[];
      }>;
    }>;
  };
  pairSimilarities: ReturnType<typeof duplicatePairSimilarities>;
  compactDuplicateGroups: ReturnType<typeof compactDuplicateBuckets>;
  burstGroups: Array<{
    kind: 'duplicate' | 'burst' | 'solo';
    representativeId: string;
    photoIds: string[];
    selectedCount: number;
  }>;
  pickDecisionReasons: ReturnType<typeof buildAiPickDecisionReasons>;
  supervised?: AiPickSupervisedMetrics;
  metricsByRatio?: AiPickRatioMetrics[];
  pickedSamples: AiPickAuditPhotoSummary[];
  excludedSamples: AiPickAuditPhotoSummary[];
  falseNegativeSamples?: AiPickAuditPhotoSummary[];
  falsePositiveSamples?: AiPickAuditPhotoSummary[];
  photoSummaries: AiPickAuditPhotoSummary[];
};

type AiPickRatioMetrics = {
  ratio: number;
  usableCandidatePhotos: number;
  targetCount: number;
  aiPicked: number;
  aiPickedDuplicateMembers: number;
  aiPickedFormalBest: number;
  aiPickedWithHardIssue: number;
  groupsWithoutAnyAiPick: number;
  groupsWithMultipleAiPicks: number;
  selectedAdjacentSimilarPairs: number;
  supervised?: AiPickSupervisedMetrics;
};

type AiPickSupervisedMetrics = {
  labeledCount: number;
  positiveCount: number;
  negativeCount: number;
  pickedLabeled: number;
  pickedPositive: number;
  pickedNegative: number;
  pickedUnlabeled: number;
  truePositive: number;
  falseNegative: number;
  falsePositive: number;
  recall: number;
  precisionOnLabeled: number;
  negativePickRate: number;
  recallByRating: Record<string, { total: number; picked: number; recall: number }>;
  positiveDuplicateGroups: number;
  positiveDuplicateGroupsWithoutPick: number;
  positiveDuplicateGroupsWithMultiplePicks: number;
  positiveFrameOrGroupCovered: number;
  positiveFrameOrGroupCoverage: number;
};

type DistributionSummary = {
  min: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  average: number;
};

const DEFAULT_CONCURRENCIES = [1, 2, 3, 4, 5, 6];
const DEFAULT_LIMIT = 36;
const DEFAULT_MAX_EDGE = 2200;
const DEFAULT_PEOPLE_MAX_EDGE = 1280;
const DEFAULT_COMBINED_COMBOS = [
  { aiConcurrency: 6, peopleConcurrency: 1 },
  { aiConcurrency: 6, peopleConcurrency: 2 },
  { aiConcurrency: 5, peopleConcurrency: 1 },
  { aiConcurrency: 5, peopleConcurrency: 2 },
];

const objectUrls: string[] = [];
let modelAssetsPromise: Promise<AiModelAssets> | null = null;

declare global {
  interface Window {
    runAiCullingBench?: (files: File[] | FileList, options?: BenchOptions) => Promise<BenchResult>;
    runCombinedAiPeopleBench?: (files: File[] | FileList, options?: CombinedBenchOptions) => Promise<CombinedBenchResult>;
    runPeopleSplitBench?: (files: File[] | FileList, options?: PeopleBenchOptions) => Promise<PeopleBenchResult>;
    runAiPickAuditBench?: (files: File[] | FileList, options?: AiPickAuditOptions) => Promise<AiPickAuditResult>;
  }
}

window.runAiCullingBench = runAiCullingBench;
window.runCombinedAiPeopleBench = runCombinedAiPeopleBench;
window.runPeopleSplitBench = runPeopleSplitBench;
window.runAiPickAuditBench = runAiPickAuditBench;

const fileInput = document.querySelector<HTMLInputElement>('#files');
const runButton = document.querySelector<HTMLButtonElement>('#run');
const output = document.querySelector<HTMLPreElement>('#output');

runButton?.addEventListener('click', () => {
  const files = Array.from(fileInput?.files ?? []);
  void runAiCullingBench(files).then(result => {
    writeOutput(JSON.stringify(result, null, 2));
  }).catch(error => {
    writeOutput(error instanceof Error ? error.stack || error.message : String(error));
  });
});

async function runAiCullingBench(filesLike: File[] | FileList, options: BenchOptions = {}): Promise<BenchResult> {
  const imageFiles = Array.from(filesLike)
    .filter(file => /\.(jpe?g|png)$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const limit = options.limit ?? DEFAULT_LIMIT;
  const files = imageFiles.slice(0, limit);
  if (files.length === 0) {
    throw new Error('No JPG/PNG files were provided for the benchmark.');
  }

  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const prepareConcurrency = normalizePrepareConcurrency(options.prepareConcurrency);
  const backend = normalizeBackend(options.backend);
  const concurrencies = (options.concurrencies ?? DEFAULT_CONCURRENCIES)
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => Math.max(1, Math.floor(value)));
  const modelAssets = await ensureModelAssets(backend);
  const startedAt = new Date().toISOString();
  const runs: BenchRunResult[] = [];

  writeOutput(`Loaded ${files.length} files. Testing ${backend} concurrency: ${concurrencies.join(', ')}; prepare=${Number.isFinite(prepareConcurrency) ? prepareConcurrency : 'unlimited'}`);

  for (const concurrency of concurrencies) {
    const result = await runConcurrencyBench(
      files,
      concurrency,
      maxEdge,
      prepareConcurrency,
      buildBenchAiSettings(options),
      buildBenchModelAssets(modelAssets, options),
      Boolean(options.collectAnalysisSummary)
    );
    runs.push(result);
    writeOutput(JSON.stringify({ finished: result, runs }, null, 2));
    await wait(350);
  }

  const best = runs.length > 0
    ? [...runs].sort((a, b) => b.imagesPerSecond - a.imagesPerSecond)[0]
    : null;

  return {
    files: imageFiles.length,
    usedFiles: files.map(file => file.name),
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    maxEdge,
    backend,
    startedAt,
    runs,
    best,
  };
}

function buildBenchAiSettings(options: Pick<BenchOptions, 'disableFaceChecks' | 'disableDuplicateSignature'>): AiSettings {
  return {
    ...DEFAULT_AI_SETTINGS,
    enabledChecks: {
      ...DEFAULT_AI_SETTINGS.enabledChecks,
      EYES_CLOSED: options.disableFaceChecks ? false : DEFAULT_AI_SETTINGS.enabledChecks.EYES_CLOSED,
    },
    duplicateSensitivity: options.disableDuplicateSignature ? 'off' : DEFAULT_AI_SETTINGS.duplicateSensitivity,
  };
}

function buildBenchModelAssets(modelAssets: AiModelAssets, options: Pick<BenchOptions, 'disableAesthetic' | 'disableFaceChecks'>): AiModelAssets {
  if (!options.disableAesthetic && !options.disableFaceChecks) return modelAssets;
  return {
    ...modelAssets,
    aestheticModelAssetCandidates: options.disableAesthetic ? [] : modelAssets.aestheticModelAssetCandidates,
    faceDetectorAssetCandidates: options.disableFaceChecks ? [] : modelAssets.faceDetectorAssetCandidates,
    yunetAssetCandidates: options.disableFaceChecks ? [] : modelAssets.yunetAssetCandidates,
    modelAssetCandidates: options.disableFaceChecks ? [] : modelAssets.modelAssetCandidates,
  };
}

async function runCombinedAiPeopleBench(filesLike: File[] | FileList, options: CombinedBenchOptions = {}): Promise<CombinedBenchResult> {
  const imageFiles = Array.from(filesLike)
    .filter(file => /\.(jpe?g|png)$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const limit = options.limit ?? DEFAULT_LIMIT;
  const files = imageFiles.slice(0, limit);
  if (files.length === 0) {
    throw new Error('No JPG/PNG files were provided for the benchmark.');
  }

  const aiMaxEdge = options.aiMaxEdge ?? 1800;
  const peopleMaxEdge = options.peopleMaxEdge ?? DEFAULT_PEOPLE_MAX_EDGE;
  const aiBackend = normalizeBackend(options.aiBackend);
  const peopleBackend = normalizeBackend(options.peopleBackend);
  const combos = (options.combos ?? DEFAULT_COMBINED_COMBOS).map(combo => ({
    aiConcurrency: Math.max(1, Math.floor(combo.aiConcurrency)),
    peopleConcurrency: Math.max(1, Math.floor(combo.peopleConcurrency)),
  }));
  const aiModelAssets = await ensureModelAssets(aiBackend);
  const peopleModelAssets = await ensureModelAssets(peopleBackend);
  const startedAt = new Date().toISOString();
  const runs: CombinedRunResult[] = [];

  writeOutput(`Loaded ${files.length} files. Testing combined AI ${aiBackend} + People Split ${peopleBackend} combos.`);
  const warmupFiles = files.slice(0, Math.min(2, files.length));
  await Promise.all([
    runConcurrencyBench(warmupFiles, 1, aiMaxEdge, DEFAULT_AI_SETTINGS, aiModelAssets, false),
    runPeopleConcurrencyBench(warmupFiles, 1, peopleMaxEdge, peopleModelAssets),
  ]);
  await wait(500);

  for (const combo of combos) {
    const started = performance.now();
    const [ai, people] = await Promise.all([
      runConcurrencyBench(files, combo.aiConcurrency, aiMaxEdge, DEFAULT_AI_SETTINGS, aiModelAssets, false),
      runPeopleConcurrencyBench(files, combo.peopleConcurrency, peopleMaxEdge, peopleModelAssets),
    ]);
    const wallMs = performance.now() - started;
    const result: CombinedRunResult = {
      ...combo,
      wallMs,
      aiImagesPerSecond: ai.totalImages / Math.max(0.001, wallMs / 1000),
      peopleImagesPerSecond: people.totalImages / Math.max(0.001, wallMs / 1000),
      aiTotalMs: ai.totalMs,
      peopleTotalMs: people.totalMs,
      aiErrors: ai.errors.length,
      peopleErrors: people.errors.length,
    };
    runs.push(result);
    writeOutput(JSON.stringify({ finished: result, runs }, null, 2));
    await wait(500);
  }

  const best = runs.length > 0
    ? [...runs].sort((a, b) => (
        (b.aiImagesPerSecond + b.peopleImagesPerSecond) -
        (a.aiImagesPerSecond + a.peopleImagesPerSecond)
      ))[0]
    : null;

  return {
    files: imageFiles.length,
    usedFiles: files.map(file => file.name),
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    aiMaxEdge,
    peopleMaxEdge,
    aiBackend,
    peopleBackend,
    startedAt,
    runs,
    best,
  };
}

async function runPeopleSplitBench(filesLike: File[] | FileList, options: PeopleBenchOptions = {}): Promise<PeopleBenchResult> {
  const imageFiles = Array.from(filesLike)
    .filter(file => /\.(jpe?g|png)$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const limit = options.limit ?? DEFAULT_LIMIT;
  const files = imageFiles.slice(0, limit);
  if (files.length === 0) {
    throw new Error('No JPG/PNG files were provided for the benchmark.');
  }

  const maxEdge = options.maxEdge ?? DEFAULT_PEOPLE_MAX_EDGE;
  const backend = normalizeBackend(options.backend);
  const concurrencies = (options.concurrencies ?? DEFAULT_CONCURRENCIES)
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => Math.max(1, Math.floor(value)));
  const modelAssets = await ensureModelAssets(backend);
  const startedAt = new Date().toISOString();
  const runs: PeopleBenchRunResult[] = [];

  writeOutput(`Loaded ${files.length} files. Testing People Split ${backend} concurrency: ${concurrencies.join(', ')}`);
  await runPeopleConcurrencyBench(files.slice(0, Math.min(2, files.length)), 1, maxEdge, modelAssets);
  await wait(350);

  for (const concurrency of concurrencies) {
    const result = await runPeopleConcurrencyBench(files, concurrency, maxEdge, modelAssets, options.logProgress === true);
    runs.push({
      concurrency,
      totalImages: result.totalImages,
      totalMs: result.totalMs,
      imagesPerSecond: result.imagesPerSecond,
      averageMs: result.averageMs,
      errors: result.errors,
      progressEvents: result.progressEvents,
    });
    writeOutput(JSON.stringify({ finished: runs[runs.length - 1], runs }, null, 2));
    await wait(350);
  }

  const best = runs.length > 0
    ? [...runs].sort((a, b) => b.imagesPerSecond - a.imagesPerSecond)[0]
    : null;

  return {
    files: imageFiles.length,
    usedFiles: files.map(file => file.name),
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    maxEdge,
    backend,
    startedAt,
    runs,
    best,
  };
}

async function runAiPickAuditBench(filesLike: File[] | FileList, options: AiPickAuditOptions = {}): Promise<AiPickAuditResult> {
  const imageFiles = Array.from(filesLike)
    .filter(file => /\.(jpe?g|png)$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const limit = options.limit ?? imageFiles.length;
  const files = imageFiles.slice(0, limit);
  if (files.length === 0) {
    throw new Error('No JPG/PNG files were provided for the AI Pick audit.');
  }

  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const backend = normalizeBackend(options.backend);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? Math.min(6, navigator.hardwareConcurrency || 4)));
  const prepareConcurrency = normalizePrepareConcurrency(options.prepareConcurrency ?? concurrency);
  const auditBatchSize = Math.max(0, Math.floor(options.auditBatchSize ?? 0));
  const imageTimeoutMs = Math.max(15_000, Math.floor(options.imageTimeoutMs ?? 120_000));
  const collectPairSimilarities = options.collectPairSimilarities === true;
  const targetRatio = normalizeTargetRatio(options.aiPickTargetRatio ?? DEFAULT_AI_SETTINGS.aiPickTargetRatio);
  const duplicateSensitivity = options.duplicateSensitivity === 'loose' || options.duplicateSensitivity === 'strict' || options.duplicateSensitivity === 'standard'
    ? options.duplicateSensitivity
    : DEFAULT_AI_SETTINGS.duplicateSensitivity === 'off' ? 'standard' : DEFAULT_AI_SETTINGS.duplicateSensitivity;
  const settings = {
    ...DEFAULT_AI_SETTINGS,
    duplicateSensitivity,
    duplicateAlwaysRecommendOne: true,
    aiPickTargetRatio: targetRatio,
  } satisfies AiSettings;
  const modelAssets = await ensureModelAssets(backend);
  const startedAt = new Date().toISOString();
  const started = performance.now();

  writeOutput(`Loaded ${files.length} files. Auditing AI Picks with ${backend}, concurrency ${concurrency}.`);
  const analysisStarted = performance.now();
  const analysis = await analyzeFilesForAudit(
    files,
    concurrency,
    maxEdge,
    settings,
    modelAssets,
    prepareConcurrency,
    auditBatchSize,
    imageTimeoutMs,
  );
  const analysisMs = performance.now() - analysisStarted;

  const photos = files.map((file, index) => makeAuditPhotoGroup(file, analysis.analyses[index], options));
  const groupingStarted = performance.now();
  const duplicateGroups = classifyDuplicateGroups(photos, settings.duplicateSensitivity, settings.duplicateAlwaysRecommendOne);
  const duplicateIds = duplicatePhotoIds(duplicateGroups);
  const duplicateBestIds = new Set(duplicateGroups.map(group => group.bestPhotoId).filter((id): id is string => Boolean(id)));
  const aiPickedIds = buildAiPickedPhotoIds(photos, duplicateBestIds, duplicateIds, targetRatio, duplicateGroups);
  const pickDecisionReasons = buildAiPickDecisionReasons(photos, duplicateBestIds, duplicateIds, targetRatio, duplicateGroups);
  const pickDecisionById = new Map(pickDecisionReasons.map(decision => [decision.photoId, decision]));
  const pairSimilarities = collectPairSimilarities ? duplicatePairSimilarities(photos, settings.duplicateSensitivity) : [];
  const compactDuplicateGroups = collectPairSimilarities ? compactDuplicateBuckets(photos, settings.duplicateSensitivity) : [];
  const groupingMs = performance.now() - groupingStarted;
  const photoSummaries = photos.map(photo => summarizeAuditPhoto(photo, aiPickedIds, duplicateIds, duplicateBestIds, options, pickDecisionById));
  const usableCandidatePhotos = photoSummaries.filter(summary => summary.exclusionReasons.length === 0).length;
  const targetCount = Math.ceil(usableCandidatePhotos * targetRatio);
  const supervised = summarizeSupervisedMetrics(photoSummaries, duplicateGroups, aiPickedIds, options.groundTruthRatings);

  // Recall is deterministic given the one-time analysis, so every additional
  // pick ratio is recomputed offline from the cached photo analyses instead of
  // re-running the browser AI pipeline.
  const ratioList = normalizeRatios(options.ratios, targetRatio);
  const metricsByRatio: AiPickRatioMetrics[] = ratioList.map(ratio => {
    const ratioPicked = ratio === targetRatio
      ? aiPickedIds
      : buildAiPickedPhotoIds(photos, duplicateBestIds, duplicateIds, ratio, duplicateGroups);
    const ratioSummaries = ratio === targetRatio
      ? photoSummaries
      : photos.map(photo => summarizeAuditPhoto(photo, ratioPicked, duplicateIds, duplicateBestIds, options, pickDecisionById));
    const ratioUsable = ratioSummaries.filter(summary => summary.exclusionReasons.length === 0).length;
    return {
      ratio,
      usableCandidatePhotos: ratioUsable,
      targetCount: Math.ceil(ratioUsable * ratio),
      aiPicked: ratioPicked.size,
      aiPickedDuplicateMembers: [...ratioPicked].filter(id => duplicateIds.has(id)).length,
      aiPickedFormalBest: [...ratioPicked].filter(id => duplicateBestIds.has(id)).length,
      aiPickedWithHardIssue: photos.filter(photo => ratioPicked.has(photo.id) && photo.ai?.issues?.some(issue => issue.level === 'ISSUE')).length,
      groupsWithoutAnyAiPick: duplicateGroups.filter(group => !group.photoIds.some(id => ratioPicked.has(id))).length,
      groupsWithMultipleAiPicks: duplicateGroups.filter(group => group.photoIds.filter(id => ratioPicked.has(id)).length > 1).length,
      selectedAdjacentSimilarPairs: selectedAdjacentSimilarPairs(photos, ratioPicked).length,
      supervised: summarizeSupervisedMetrics(ratioSummaries, duplicateGroups, ratioPicked, options.groundTruthRatings),
    };
  });

  const result: AiPickAuditResult = {
    mode: options.mode ?? 'pick-audit',
    files: imageFiles.length,
    usedFiles: files.map(file => file.name),
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    maxEdge,
    backend,
    concurrency,
    targetRatio,
    startedAt,
    totalMs: performance.now() - started,
    analysisMs,
    groupingMs,
    errors: analysis.errors,
    counts: {
      total: photos.length,
      done: photos.filter(photo => photo.ai?.status === 'DONE').length,
      errors: analysis.errors.length,
      hardIssuePhotos: photos.filter(photo => photo.ai?.issues?.some(issue => issue.level === 'ISSUE')).length,
      reviewHintPhotos: photos.filter(photo => photo.ai?.issues?.some(issue => issue.level === 'REVIEW_HINT')).length,
      noIssuePhotos: photos.filter(photo => (photo.ai?.issues?.length ?? 0) === 0).length,
      focusFailPhotos: photos.filter(photo => hasAuditFocusFail(photo.ai)).length,
      scoreMissingPhotos: photos.filter(photo => !photo.ai?.photoScore).length,
      usableCandidatePhotos,
      targetCount,
      aiPicked: aiPickedIds.size,
      aiPickedDuplicateMembers: [...aiPickedIds].filter(id => duplicateIds.has(id)).length,
      aiPickedFormalBest: [...aiPickedIds].filter(id => duplicateBestIds.has(id)).length,
      aiPickedWithHardIssue: photos.filter(photo => aiPickedIds.has(photo.id) && photo.ai?.issues?.some(issue => issue.level === 'ISSUE')).length,
      aiPickedWithAnyIssue: photos.filter(photo => aiPickedIds.has(photo.id) && (photo.ai?.issues?.length ?? 0) > 0).length,
    },
    issueCodeCounts: countIssueCodes(photos),
    exclusionReasonCounts: countExclusionReasons(photoSummaries),
    scoreDistribution: {
      overall: distribution(photoSummaries.map(summary => summary.overall)),
      technical: distribution(photoSummaries.map(summary => summary.technical)),
      aesthetic: distribution(photoSummaries.map(summary => summary.aesthetic)),
    },
    duplicateStats: summarizeDuplicateStats(duplicateGroups, aiPickedIds, photos, photoSummaries),
    pairSimilarities,
    compactDuplicateGroups,
    burstGroups: summarizeBurstGroups(pickDecisionReasons, aiPickedIds),
    pickDecisionReasons,
    supervised,
    metricsByRatio,
    pickedSamples: photoSummaries
      .filter(summary => summary.picked)
      .sort((left, right) => (right.overall ?? 0) - (left.overall ?? 0))
      .slice(0, 24),
    excludedSamples: photoSummaries
      .filter(summary => !summary.picked)
      .sort((left, right) => (right.overall ?? 0) - (left.overall ?? 0))
      .slice(0, 36),
    falseNegativeSamples: photoSummaries
      .filter(summary => summary.groundTruthPositive && !summary.picked)
      .sort((left, right) => (right.groundTruthRating ?? 0) - (left.groundTruthRating ?? 0) || (right.overall ?? 0) - (left.overall ?? 0))
      .slice(0, 36),
    falsePositiveSamples: photoSummaries
      .filter(summary => summary.groundTruthRating !== undefined && !summary.groundTruthPositive && summary.picked)
      .sort((left, right) => (right.overall ?? 0) - (left.overall ?? 0))
      .slice(0, 36),
    photoSummaries,
  };

  writeOutput(JSON.stringify({
    counts: result.counts,
    supervised: result.supervised,
    metricsByRatio: result.metricsByRatio?.map(entry => ({
      ratio: entry.ratio,
      aiPicked: entry.aiPicked,
      targetCount: entry.targetCount,
      recall: entry.supervised?.recall,
      recallByRating: entry.supervised?.recall === undefined ? undefined : entry.supervised?.recallByRating,
      negativePickRate: entry.supervised?.negativePickRate,
      positiveFrameOrGroupCoverage: entry.supervised?.positiveFrameOrGroupCoverage,
      groupsWithMultipleAiPicks: entry.groupsWithMultipleAiPicks,
      aiPickedDuplicateMembers: entry.aiPickedDuplicateMembers,
    })),
    duplicateStats: result.duplicateStats,
    exclusionReasonCounts: result.exclusionReasonCounts,
    scoreDistribution: result.scoreDistribution,
  }, null, 2));
  return result;
}

async function runConcurrencyBench(
  files: File[],
  concurrency: number,
  maxEdge: number,
  prepareConcurrency: number,
  settings: AiSettings,
  modelAssets: AiModelAssets,
  collectAnalysisSummary: boolean,
): Promise<BenchRunResult> {
  const workers = Array.from({ length: concurrency }, () => new AiAnalyzerWorker());
  const prepareGate = createAsyncGate(prepareConcurrency);
  const frameSampler = startFrameSampler();
  const timings: Array<{ totalMs: number; prepareMs: number; prepareWorkMs: number; workerMs: number }> = [];
  const errors: string[] = [];
  const analysisSummary: Record<string, AnalysisSummary> = {};
  let nextIndex = 0;
  const started = performance.now();

  const runLane = async (worker: Worker) => {
    while (nextIndex < files.length) {
      const index = nextIndex;
      nextIndex += 1;
      const file = files[index];
      const itemStarted = performance.now();

      try {
        const prepareStarted = performance.now();
        let prepareWorkMs = 0;
        const imageData = await prepareGate(async () => {
          const workStarted = performance.now();
          const prepared = await prepareFileImage(file, maxEdge);
          prepareWorkMs = performance.now() - workStarted;
          return prepared;
        });
        const prepareMs = performance.now() - prepareStarted;
        const workerStarted = performance.now();
        const analysis = await analyzeWithWorker(worker, `${index}-${file.name}`, imageData, settings, modelAssets);
        const workerMs = performance.now() - workerStarted;
        if (collectAnalysisSummary) {
          analysisSummary[file.name] = {
            faceCount: analysis.metrics?.faceCount,
            faceCandidateCount: analysis.metrics?.faceCandidateCount,
            landmarkedFaceCount: analysis.metrics?.landmarkedFaceCount,
            primarySubjectCount: analysis.metrics?.primarySubjectCount,
            subjectConfidence: analysis.metrics?.subjectConfidence,
            regionCount: analysis.regions?.length ?? 0,
          };
        }
        timings.push({
          totalMs: performance.now() - itemStarted,
          prepareMs,
          prepareWorkMs,
          workerMs,
        });
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  await Promise.all(workers.map(worker => runLane(worker)));
  workers.forEach(worker => worker.terminate());
  const frameStats = frameSampler.stop();

  const totalMs = performance.now() - started;
  const totals = timings.map(item => item.totalMs).sort((a, b) => a - b);
  const averageMs = average(totals);
  const averagePrepareMs = average(timings.map(item => item.prepareMs));
  const averagePrepareWorkMs = average(timings.map(item => item.prepareWorkMs));
  const averageWorkerMs = average(timings.map(item => item.workerMs));

  return {
    concurrency,
    totalImages: timings.length,
    totalMs,
    imagesPerSecond: timings.length / Math.max(0.001, totalMs / 1000),
    averageMs,
    medianMs: percentile(totals, 0.5),
    p90Ms: percentile(totals, 0.9),
    averagePrepareMs,
    averagePrepareWorkMs,
    averageWorkerMs,
    prepareConcurrency: Number.isFinite(prepareConcurrency) ? prepareConcurrency : concurrency,
    maxFrameGapMs: frameStats.maxFrameGapMs,
    p95FrameGapMs: frameStats.p95FrameGapMs,
    errors,
    analysisSummary: collectAnalysisSummary ? analysisSummary : undefined,
  };
}

function normalizePrepareConcurrency(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(value));
}

function createAsyncGate(limit: number) {
  if (!Number.isFinite(limit)) {
    return async <T>(task: () => Promise<T>) => task();
  }

  let active = 0;
  const queue: Array<() => void> = [];
  const maxActive = Math.max(1, Math.floor(limit));

  const release = () => {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  };

  return async function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxActive) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function startFrameSampler() {
  const gaps: number[] = [];
  let disposed = false;
  let last = performance.now();
  let frame = 0;

  const tick = (now: number) => {
    if (disposed) return;
    gaps.push(now - last);
    last = now;
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);

  return {
    stop() {
      disposed = true;
      cancelAnimationFrame(frame);
      const sorted = gaps.slice().sort((a, b) => a - b);
      return {
        maxFrameGapMs: sorted.length > 0 ? sorted[sorted.length - 1] ?? 0 : 0,
        p95FrameGapMs: percentile(sorted, 0.95),
      };
    },
  };
}

async function analyzeFilesForAudit(
  files: File[],
  concurrency: number,
  maxEdge: number,
  settings: AiSettings,
  modelAssets: AiModelAssets,
  prepareConcurrency: number,
  auditBatchSize: number,
  imageTimeoutMs: number,
) {
  const analyses: Array<AiAnalysis | undefined> = new Array(files.length);
  const errors: string[] = [];
  const batchSize = auditBatchSize > 0 ? auditBatchSize : files.length;
  const prepareGate = createAsyncGate(prepareConcurrency);
  let completed = 0;

  for (let batchStart = 0; batchStart < files.length; batchStart += batchSize) {
    const batchEnd = Math.min(files.length, batchStart + batchSize);
    const workers = Array.from({ length: concurrency }, () => new AiAnalyzerWorker());
    let nextIndex = batchStart;

    const runLane = async (worker: Worker) => {
      while (nextIndex < batchEnd) {
        const index = nextIndex;
        nextIndex += 1;
        const file = files[index];
        try {
          const imageData = await withTimeout(
            prepareGate(() => prepareFileImage(file, maxEdge)),
            imageTimeoutMs,
            `${file.name}: image preparation timed out`,
          );
          analyses[index] = await withTimeout(
            analyzeWithWorker(worker, `${index}-${file.name}`, imageData, settings, modelAssets),
            imageTimeoutMs,
            `${file.name}: AI worker timed out`,
          );
        } catch (error) {
          errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          completed += 1;
          if (completed % 25 === 0 || completed === files.length) {
            writeOutput(`AI Pick audit analyzed ${completed}/${files.length}`);
            console.log(`AI Pick audit analyzed ${completed}/${files.length}`);
          }
        }
      }
    };

    try {
      await Promise.all(workers.map(worker => runLane(worker)));
    } finally {
      workers.forEach(worker => worker.terminate());
    }
    await wait(0);
  }

  return { analyses, errors };
}

async function runPeopleConcurrencyBench(
  files: File[],
  concurrency: number,
  maxEdge: number,
  modelAssets: AiModelAssets,
  logProgress = false,
) {
  const workers = Array.from({ length: concurrency }, () => new PeopleSplitWorker());
  const timings: number[] = [];
  const errors: string[] = [];
  const progressEvents: string[] = [];
  let nextIndex = 0;
  const started = performance.now();

  const runLane = async (worker: Worker) => {
    while (nextIndex < files.length) {
      const index = nextIndex;
      nextIndex += 1;
      const file = files[index];
      const itemStarted = performance.now();

      try {
        const imageUrl = URL.createObjectURL(file);
        objectUrls.push(imageUrl);
        await analyzePeopleWithWorker(worker, `${index}-${file.name}`, { imageUrl, maxEdge }, modelAssets, logProgress ? file.name : undefined, progressEvents);
        timings.push(performance.now() - itemStarted);
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  await Promise.all(workers.map(worker => runLane(worker)));
  workers.forEach(worker => worker.terminate());

  const totalMs = performance.now() - started;
  return {
    totalImages: timings.length,
    totalMs,
    imagesPerSecond: timings.length / Math.max(0.001, totalMs / 1000),
    averageMs: average(timings),
    errors,
    progressEvents: logProgress ? progressEvents : undefined,
  };
}

async function prepareFileImage(file: File, maxEdge: number) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('Canvas is unavailable for benchmark image preparation.');
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return context.getImageData(0, 0, width, height);
}

function analyzeWithWorker(
  worker: Worker,
  photoId: string,
  imageData: ImageData,
  settings: AiSettings,
  modelAssets: AiModelAssets,
): Promise<AiAnalysis> {
  const requestId = `${photoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== requestId) return;
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      if (event.data.type === 'result' && event.data.analysis) {
        resolve(event.data.analysis);
      } else {
        reject(new Error(event.data.error || 'AI worker failed.'));
      }
    };
    const handleError = (error: ErrorEvent) => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(error.error || new Error(error.message));
    };
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError, { once: true });
    worker.postMessage({ type: 'analyze', id: requestId, imageData, settings, modelAssets }, [imageData.data.buffer]);
  });
}

function analyzePeopleWithWorker(
  worker: Worker,
  photoId: string,
  image: { imageData?: ImageData; imageUrl?: string; maxEdge?: number },
  modelAssets: AiModelAssets,
  progressLabel?: string,
  progressEvents?: string[],
): Promise<unknown[]> {
  const requestId = `${photoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<PeopleWorkerResponse>) => {
      if (event.data.id !== requestId) return;
      if (event.data.type === 'progress') {
        if (progressLabel && event.data.stage) {
          const line = `[people-progress] ${progressLabel}: ${event.data.stage}`;
          console.log(line);
          writeOutput(line);
          progressEvents?.push(line);
        }
        return;
      }
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      if (event.data.type === 'result') {
        resolve(event.data.faces ?? []);
      } else {
        reject(new Error(event.data.error || 'People split worker failed.'));
      }
    };
    const handleError = (error: ErrorEvent) => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(error.error || new Error(error.message));
    };
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError, { once: true });
    const transfer = image.imageData ? [image.imageData.data.buffer] : [];
    worker.postMessage({
      type: 'analyze',
      id: requestId,
      photoId,
      imageData: image.imageData,
      imageUrl: image.imageUrl,
      maxEdge: image.maxEdge,
      modelAssets,
      preferInitialFaceBoxes: false,
    }, transfer);
  });
}

function makeAuditPhotoGroup(file: File, ai: AiAnalysis | undefined, options: AiPickAuditOptions = {}): PhotoGroup {
  const previewUrl = URL.createObjectURL(file);
  objectUrls.push(previewUrl);
  const id = file.name.replace(/\.[^.]+$/, '');
  return {
    id,
    jpg: {
      name: file.name,
      extension: file.name.split('.').pop()?.toUpperCase() || 'JPG',
      file,
      previewUrl,
      size: file.size,
      modifiedMs: file.lastModified,
      path: options.sourceNames?.[id] ?? file.name,
    },
    status: GroupStatus.JPG_ONLY,
    selection: SelectionState.UNMARKED,
    rating: 0,
    ai,
  };
}

function summarizeAuditPhoto(
  photo: PhotoGroup,
  aiPickedIds: ReadonlySet<string>,
  duplicateIds: ReadonlySet<string>,
  duplicateBestIds: ReadonlySet<string>,
  options: AiPickAuditOptions = {},
  pickDecisionById: ReadonlyMap<string, ReturnType<typeof buildAiPickDecisionReasons>[number]> = new Map(),
): AiPickAuditPhotoSummary {
  const score = photo.ai?.photoScore;
  const technical = componentScore(score?.components, 'TECHNICAL_QUALITY');
  const aesthetic = componentScore(score?.components, 'AESTHETIC_QUALITY');
  const scene = componentScore(score?.components, 'SCENE_FIT');
  const issues = photo.ai?.issues ?? [];
  const hardIssueCodes = issues.filter(issue => issue.level === 'ISSUE').map(issue => issue.code);
  const reviewHintCodes = issues.filter(issue => issue.level === 'REVIEW_HINT').map(issue => issue.code);
  const exclusionReasons = auditExclusionReasons(photo);
  const groundTruthRating = options.groundTruthRatings?.[photo.id];
  const pickDecision = pickDecisionById.get(photo.id);
  return {
    id: photo.id,
    fileName: photo.jpg?.name ?? photo.raw?.name ?? photo.id,
    sourceName: options.sourceNames?.[photo.id],
    groundTruthRating,
    groundTruthPositive: groundTruthRating !== undefined ? groundTruthRating >= 3 : undefined,
    status: photo.ai?.status ?? 'PENDING',
    picked: aiPickedIds.has(photo.id),
    inDuplicateGroup: duplicateIds.has(photo.id),
    formalBest: duplicateBestIds.has(photo.id),
    issueCodes: issues.map(issue => `${issue.level}:${issue.code}`),
    hardIssueCodes,
    reviewHintCodes,
    overall: score?.overall,
    grade: score?.grade,
    technical,
    aesthetic,
    scene,
    scoreComponents: score?.components.map(component => ({
      key: component.key,
      label: component.label,
      score: component.score,
      weight: component.weight,
      detail: component.detail,
    })),
    focusTexture: photo.ai?.metrics?.focusTextureScore,
    focusPeakTexture: photo.ai?.metrics?.focusPeakTextureScore,
    focusReliability: photo.ai?.metrics?.focusReliabilityScore,
    focusReliable: photo.ai?.metrics?.focusReliable,
    aestheticStatus: score?.aesthetic?.status,
    proAesthetic: photo.ai?.proScores?.aesthetic,
    proPersonaScore: photo.ai?.proScores?.personaScore,
    proSceneLabel: photo.ai?.proScores?.sceneLabel,
    proSceneConfidence: photo.ai?.proScores?.sceneConfidence,
    proActiveEp: photo.ai?.proScores?.activeEp,
    proManifestPath: photo.ai?.proScores?.manifestPath,
    gateReasons: score?.gates?.reasons,
    exclusionReasons,
    duplicateSignature: photo.ai?.duplicateSignature,
    pickDecisionReasons: pickDecision?.reasons,
    pickBucketKind: pickDecision?.bucketKind,
    pickRepresentativeId: pickDecision?.representativeId,
    pickRankScore: pickDecision?.rankScore,
  };
}

function auditExclusionReasons(photo: PhotoGroup) {
  const reasons: string[] = [];
  if (photo.ai?.status !== 'DONE') reasons.push('AI_NOT_DONE');
  if (photo.selection === SelectionState.REJECTED) reasons.push('USER_REJECTED');
  const issues = photo.ai?.issues ?? [];
  if (issues.some(issue => issue.level === 'ISSUE')) reasons.push('HAS_HARD_ISSUE');
  if (issues.some(issue => issue.level === 'REVIEW_HINT')) reasons.push('HAS_REVIEW_HINT');
  if (!photo.ai?.photoScore) reasons.push('NO_SCORE');
  const overall = photo.ai?.photoScore?.overall ?? 0;
  const technical = componentScore(photo.ai?.photoScore?.components, 'TECHNICAL_QUALITY');
  if (overall < 38) reasons.push('LOW_OVERALL');
  if (technical < 20) reasons.push('LOW_TECHNICAL');
  if (photo.ai?.photoScore?.gates && !photo.ai.photoScore.gates.technicalPass) reasons.push('TECHNICAL_GATE_FAIL');
  if (hasAuditFocusFail(photo.ai)) reasons.push('FOCUS_FAIL');
  return reasons;
}

function countIssueCodes(photos: PhotoGroup[]) {
  const counts: Partial<Record<AiIssueCode, number>> = {};
  for (const photo of photos) {
    const codes = new Set((photo.ai?.issues ?? []).map(issue => issue.code));
    for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function countExclusionReasons(photoSummaries: AiPickAuditPhotoSummary[]) {
  const counts: Record<string, number> = {};
  for (const summary of photoSummaries) {
    for (const reason of summary.exclusionReasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}

function summarizeDuplicateStats(
  groups: DuplicateGroup[],
  aiPickedIds: ReadonlySet<string>,
  photos: PhotoGroup[],
  photoSummaries: AiPickAuditPhotoSummary[] = [],
) {
  const duplicateIds = duplicatePhotoIds(groups);
  const bestIds = new Set(groups.map(group => group.bestPhotoId).filter((id): id is string => Boolean(id)));
  const selectedPairs = selectedAdjacentSimilarPairs(photos, aiPickedIds);
  const groupSizes = groups.map(group => group.photoIds.length);
  const summaryById = new Map(photoSummaries.map(summary => [summary.id, summary]));
  return {
    groupCount: groups.length,
    duplicatePhotoCount: duplicateIds.size,
    bestPhotoCount: bestIds.size,
    maxGroupSize: groupSizes.length > 0 ? Math.max(...groupSizes) : 0,
    averageGroupSize: average(groupSizes),
    groupsWithoutAnyAiPick: groups.filter(group => !group.photoIds.some(id => aiPickedIds.has(id))).length,
    groupsWithMultipleAiPicks: groups.filter(group => group.photoIds.filter(id => aiPickedIds.has(id)).length > 1).length,
    selectedAdjacentSimilarPairs: selectedPairs.length,
    selectedAdjacentSimilarSamples: selectedPairs.slice(0, 24),
    largeGroups: [...groups]
      .sort((left, right) => right.photoIds.length - left.photoIds.length)
      .slice(0, 16)
      .map(group => ({
        id: group.id,
        size: group.photoIds.length,
        selectedCount: group.photoIds.filter(id => aiPickedIds.has(id)).length,
        bestPhotoId: group.bestPhotoId,
        firstIds: group.photoIds.slice(0, 18),
      })),
    supervisedGroups: photoSummaries.length > 0
      ? groups
        .filter(group => group.photoIds.some(id => summaryById.get(id)?.groundTruthRating !== undefined))
        .map(group => {
          const summaries = group.photoIds
            .map(id => summaryById.get(id))
            .filter((summary): summary is AiPickAuditPhotoSummary => Boolean(summary));
          return {
            id: group.id,
            size: group.photoIds.length,
            selectedCount: summaries.filter(summary => aiPickedIds.has(summary.id)).length,
            bestPhotoId: group.bestPhotoId,
            positiveCount: summaries.filter(summary => summary.groundTruthPositive).length,
            negativeCount: summaries.filter(summary => summary.groundTruthRating !== undefined && !summary.groundTruthPositive).length,
            usableCount: summaries.filter(summary => summary.exclusionReasons.length === 0).length,
            photos: summaries.map(summary => ({
              id: summary.id,
              rating: summary.groundTruthRating,
              picked: aiPickedIds.has(summary.id),
              usable: summary.exclusionReasons.length === 0,
              overall: summary.overall,
              technical: summary.technical,
              issueCodes: summary.issueCodes,
              exclusionReasons: summary.exclusionReasons,
            })),
          };
        })
      : undefined,
  };
}

function summarizeBurstGroups(
  decisions: ReturnType<typeof buildAiPickDecisionReasons>,
  aiPickedIds: ReadonlySet<string>,
) {
  const byRepresentative = new Map<string, ReturnType<typeof buildAiPickDecisionReasons>>();
  for (const decision of decisions) {
    const key = `${decision.bucketKind}:${decision.representativeId}:${decision.bucketPhotoIds.join('|')}`;
    const group = byRepresentative.get(key) ?? [];
    group.push(decision);
    byRepresentative.set(key, group);
  }

  return [...byRepresentative.values()]
    .map(group => {
      const first = group[0];
      return {
        kind: first.bucketKind,
        representativeId: first.representativeId,
        photoIds: first.bucketPhotoIds,
        selectedCount: first.bucketPhotoIds.filter(id => aiPickedIds.has(id)).length,
      };
    })
    .sort((left, right) => left.photoIds[0].localeCompare(right.photoIds[0], undefined, { numeric: true }));
}

function summarizeSupervisedMetrics(
  photoSummaries: AiPickAuditPhotoSummary[],
  groups: DuplicateGroup[],
  aiPickedIds: ReadonlySet<string>,
  groundTruthRatings?: Record<string, number>,
): AiPickSupervisedMetrics | undefined {
  if (!groundTruthRatings || Object.keys(groundTruthRatings).length === 0) return undefined;

  const labeled = photoSummaries.filter(summary => summary.groundTruthRating !== undefined);
  const positives = labeled.filter(summary => (summary.groundTruthRating ?? 0) >= 3);
  const negatives = labeled.filter(summary => (summary.groundTruthRating ?? 0) < 3);
  const pickedLabeled = labeled.filter(summary => summary.picked);
  const pickedPositive = positives.filter(summary => summary.picked);
  const pickedNegative = negatives.filter(summary => summary.picked);
  const pickedUnlabeled = photoSummaries.filter(summary => summary.picked && summary.groundTruthRating === undefined);
  const falseNegative = positives.filter(summary => !summary.picked);
  const falsePositive = negatives.filter(summary => summary.picked);
  const recallByRating: Record<string, { total: number; picked: number; recall: number }> = {};

  for (const summary of labeled) {
    const key = String(summary.groundTruthRating ?? 0);
    const entry = recallByRating[key] ?? { total: 0, picked: 0, recall: 0 };
    entry.total += 1;
    if (summary.picked) entry.picked += 1;
    recallByRating[key] = entry;
  }
  for (const entry of Object.values(recallByRating)) {
    entry.recall = entry.total > 0 ? entry.picked / entry.total : 0;
  }

  const positiveIdSet = new Set(positives.map(summary => summary.id));
  const positiveGroups = groups.filter(group => group.photoIds.some(id => positiveIdSet.has(id)));
  const positiveDuplicateGroupsWithoutPick = positiveGroups.filter(group => !group.photoIds.some(id => aiPickedIds.has(id))).length;
  const positiveDuplicateGroupsWithMultiplePicks = positiveGroups.filter(group => group.photoIds.filter(id => aiPickedIds.has(id)).length > 1).length;
  const duplicateCoveredPositiveIds = new Set(
    positiveGroups
      .filter(group => group.photoIds.some(id => aiPickedIds.has(id)))
      .flatMap(group => group.photoIds.filter(id => positiveIdSet.has(id)))
  );
  const positiveFrameOrGroupCovered = positives.filter(summary => (
    aiPickedIds.has(summary.id) || duplicateCoveredPositiveIds.has(summary.id)
  )).length;

  return {
    labeledCount: labeled.length,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    pickedLabeled: pickedLabeled.length,
    pickedPositive: pickedPositive.length,
    pickedNegative: pickedNegative.length,
    pickedUnlabeled: pickedUnlabeled.length,
    truePositive: pickedPositive.length,
    falseNegative: falseNegative.length,
    falsePositive: falsePositive.length,
    recall: positives.length > 0 ? pickedPositive.length / positives.length : 0,
    precisionOnLabeled: pickedLabeled.length > 0 ? pickedPositive.length / pickedLabeled.length : 0,
    negativePickRate: negatives.length > 0 ? pickedNegative.length / negatives.length : 0,
    recallByRating,
    positiveDuplicateGroups: positiveGroups.length,
    positiveDuplicateGroupsWithoutPick,
    positiveDuplicateGroupsWithMultiplePicks,
    positiveFrameOrGroupCovered,
    positiveFrameOrGroupCoverage: positives.length > 0 ? positiveFrameOrGroupCovered / positives.length : 0,
  };
}

function selectedAdjacentSimilarPairs(photos: PhotoGroup[], aiPickedIds: ReadonlySet<string>) {
  const selected = photos
    .filter(photo => aiPickedIds.has(photo.id) && photo.ai?.duplicateSignature)
    .sort((left, right) => fileOrder(left.id) - fileOrder(right.id));
  const pairs: Array<{ left: string; right: string; similarity: number; gap: number }> = [];
  for (let index = 1; index < selected.length; index += 1) {
    const left = selected[index - 1];
    const right = selected[index];
    const leftSignature = left.ai?.duplicateSignature;
    const rightSignature = right.ai?.duplicateSignature;
    if (!leftSignature || !rightSignature) continue;
    const gap = filenameNumericGap(left.id, right.id);
    if (gap > 18) continue;
    const similarity = duplicateSimilarity(leftSignature, rightSignature);
    if (similarity >= 0.88) {
      pairs.push({
        left: left.id,
        right: right.id,
        similarity: Number(similarity.toFixed(3)),
        gap,
      });
    }
  }
  return pairs;
}

function distribution(values: Array<number | undefined>): DistributionSummary {
  const sorted = values
    .filter((value): value is number => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { min: 0, p10: 0, p25: 0, median: 0, p75: 0, p90: 0, max: 0, average: 0 };
  }
  return {
    min: sorted[0],
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1],
    average: average(sorted),
  };
}

function componentScore(
  components: AiAnalysis['photoScore']['components'] | undefined,
  key: AiPhotoScoreComponentKey,
) {
  return components?.find(component => component.key === key)?.score ?? 0;
}

function hasAuditFocusFail(ai: PhotoGroup['ai']) {
  if (!ai) return false;
  if (ai.issues.some(issue => issue.code === 'OUT_OF_FOCUS' && issue.level === 'ISSUE')) return true;
  const focusTexture = ai.metrics?.focusTextureScore ?? 100;
  const peakTexture = ai.metrics?.focusPeakTextureScore ?? 100;
  const tenengrad = ai.metrics?.tenengrad ?? 100;
  const reliability = ai.metrics?.focusReliabilityScore ?? (ai.metrics?.focusReliable === false ? 0.38 : 1);
  return focusTexture < 30 && peakTexture < 38 && tenengrad < 40 && reliability < 0.42;
}

function normalizeTargetRatio(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_AI_SETTINGS.aiPickTargetRatio;
  return Math.max(0.1, Math.min(0.7, value));
}

function normalizeRatios(values: number[] | undefined, fallback: number): number[] {
  const source = Array.isArray(values) && values.length > 0 ? values : [fallback];
  const seen = new Set<number>();
  const ratios: number[] = [];
  for (const value of source) {
    const normalized = normalizeTargetRatio(value);
    const rounded = Math.round(normalized * 1000) / 1000;
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    ratios.push(rounded);
  }
  return ratios.sort((left, right) => left - right);
}

function filenameNumericGap(left: string, right: string) {
  const leftNumber = trailingNumber(left);
  const rightNumber = trailingNumber(right);
  if (leftNumber === null || rightNumber === null) return Number.POSITIVE_INFINITY;
  return Math.abs(leftNumber - rightNumber);
}

function trailingNumber(value: string) {
  const match = value.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

function fileOrder(value: string) {
  return trailingNumber(value) ?? Number.MAX_SAFE_INTEGER;
}

async function ensureModelAssets(backend: OnnxBackend = 'wasm') {
  if (!modelAssetsPromise) {
    modelAssetsPromise = buildModelAssets();
  }
  return {
    ...(await modelAssetsPromise),
    onnxBackend: backend,
  } satisfies AiModelAssets;
}

async function buildModelAssets() {
  const candidates = {
    wasmBaseCandidates: collectCandidateUrls([
      './models/mediapipe/wasm',
      '/models/mediapipe/wasm',
    ]),
    wasmModuleLoaderCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_module_internal.js',
      '/models/mediapipe/wasm/vision_wasm_module_internal.js',
    ]),
    wasmModuleBinaryCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_module_internal.wasm',
      '/models/mediapipe/wasm/vision_wasm_module_internal.wasm',
    ]),
    wasmLoaderCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_internal.js',
      '/models/mediapipe/wasm/vision_wasm_internal.js',
    ]),
    wasmBinaryCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_internal.wasm',
      '/models/mediapipe/wasm/vision_wasm_internal.wasm',
    ]),
    wasmNoSimdLoaderCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_nosimd_internal.js',
      '/models/mediapipe/wasm/vision_wasm_nosimd_internal.js',
    ]),
    wasmNoSimdBinaryCandidates: collectCandidateUrls([
      './models/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
      '/models/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
    ]),
    modelAssetCandidates: collectCandidateUrls([
      './models/mediapipe/face_landmarker/face_landmarker.task',
      '/models/mediapipe/face_landmarker/face_landmarker.task',
    ]),
    faceDetectorAssetCandidates: collectCandidateUrls([
      './models/mediapipe/face_detector/blaze_face_short_range.tflite',
      '/models/mediapipe/face_detector/blaze_face_short_range.tflite',
    ]),
    yunetAssetCandidates: collectCandidateUrls([
      './models/opencv/yunet/face_detection_yunet_2023mar.onnx',
      '/models/opencv/yunet/face_detection_yunet_2023mar.onnx',
    ]),
    onnxWasmBaseCandidates: collectCandidateUrls([
      './models/onnxruntime/',
      '/models/onnxruntime/',
    ]),
  };

  const [wasmModuleLoaderBlob, wasmModuleBinaryBlob, modelBlob, faceDetectorBlob, yunetBlob] = await Promise.all([
    fetchBlobCandidate(candidates.wasmModuleLoaderCandidates, 'text/javascript'),
    fetchBlobCandidate(candidates.wasmModuleBinaryCandidates, 'application/wasm'),
    fetchBlobCandidate(candidates.modelAssetCandidates, 'application/octet-stream'),
    fetchBlobCandidate(candidates.faceDetectorAssetCandidates, 'application/octet-stream'),
    fetchBlobCandidate(candidates.yunetAssetCandidates, 'application/octet-stream'),
  ]);

  return {
    wasmBaseCandidates: candidates.wasmBaseCandidates,
    wasmModuleLoaderCandidates: wasmModuleLoaderBlob
      ? [...candidates.wasmModuleLoaderCandidates, wasmModuleLoaderBlob]
      : candidates.wasmModuleLoaderCandidates,
    wasmModuleBinaryCandidates: wasmModuleBinaryBlob
      ? [...candidates.wasmModuleBinaryCandidates, wasmModuleBinaryBlob]
      : candidates.wasmModuleBinaryCandidates,
    wasmLoaderCandidates: candidates.wasmLoaderCandidates,
    wasmBinaryCandidates: candidates.wasmBinaryCandidates,
    wasmNoSimdLoaderCandidates: candidates.wasmNoSimdLoaderCandidates,
    wasmNoSimdBinaryCandidates: candidates.wasmNoSimdBinaryCandidates,
    modelAssetCandidates: modelBlob ? [modelBlob, ...candidates.modelAssetCandidates] : candidates.modelAssetCandidates,
    faceDetectorAssetCandidates: faceDetectorBlob
      ? [faceDetectorBlob, ...candidates.faceDetectorAssetCandidates]
      : candidates.faceDetectorAssetCandidates,
    yunetAssetCandidates: yunetBlob
      ? [yunetBlob, ...candidates.yunetAssetCandidates]
      : candidates.yunetAssetCandidates,
    onnxWasmBaseCandidates: candidates.onnxWasmBaseCandidates,
  } satisfies AiModelAssets;
}

function collectCandidateUrls(paths: string[]) {
  const urls = paths.flatMap(path => {
    const values = [path];
    try {
      values.push(new URL(path, window.location.href).toString());
    } catch {
      // keep the raw path candidate
    }
    return values;
  });
  return Array.from(new Set(urls.filter(Boolean)));
}

function normalizeBackend(value: unknown): OnnxBackend {
  return value === 'webgpu' ? 'webgpu' : 'wasm';
}

async function fetchBlobCandidate(candidates: string[], mimeType: string) {
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);
      if (!response.ok) continue;
      const bytes = await response.arrayBuffer();
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      objectUrls.push(objectUrl);
      return objectUrl;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function fitWithin(width: number, height: number, maxEdge: number) {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return { width, height };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * ratio)));
  return sortedValues[index] ?? 0;
}

function writeOutput(value: string) {
  if (output) output.textContent = value;
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}
