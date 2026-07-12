import { basename, dirname, join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const audit3groupsAuditPath = resolve(args.audit3groupsAudit ?? args.audit ?? 'output/ai-bench/ai-culling-bench-scene-aware-replay.json');
const phase0AllImagesPath = resolve(args.phase0AllImages ?? '/data/FrameCullModelLab/outputs/semantic-teacher-lab/phase0/all-images.json');
const outputPath = resolve(args.output ?? 'output/ai-bench/pro-semantic-student-eval/ai-culling-bench-pro-semantic-eval-input.json');
const metaOutputPath = resolve(args.metaOutput ?? join(dirname(outputPath), 'pro-semantic-eval-input-meta.json'));
const labelsOutputPath = resolve(args.labelsOutput ?? join(dirname(outputPath), 'pro-semantic-eval-labels.json'));
const includeCamera = parseBoolean(args.includeCamera ?? 'true');
const includeAudit3Groups = parseBoolean(args.includeAudit3groups ?? 'true');
const includeFiveMountain = parseBoolean(args.includeFiveMountain ?? 'false');
const fiveMountainLabelsPath = resolve(args.fiveMountainLabels ?? '/data/FrameCullModelLab/incoming/five-mountain-labels/five-mountain-labels.json');
const fiveMountainPreviewDir = resolve(args.fiveMountainPreviewDir ?? '/data/FrameCullModelLab/incoming/five-mountain-previews-384');

const audit3groupsAudit = includeAudit3Groups
  ? await readJson(audit3groupsAuditPath)
  : { photoSummaries: [] };
const phase0Images = normalizePhase0Images(await readJson(phase0AllImagesPath));
const phase0ByDatasetAndId = new Map(
  phase0Images.map(item => [`${item.dataset ?? 'unknown'}::${item.photoId ?? item.id ?? ''}`, item]),
);

const summaries = [];
const labels = {};
const sourceNames = {};
const usedIds = new Set();
const stats = {
  audit3groups: { input: 0, output: 0, positives: 0, negatives: 0, threshold: 3 },
  camera: { input: 0, output: 0, positives: 0, negatives: 0, threshold: 1 },
  five_mountain: { input: 0, output: 0, positives: 0, negatives: 0, threshold: 1 },
};

if (includeAudit3Groups) {
  for (const summary of audit3groupsAudit.photoSummaries ?? []) {
    const sourceId = summary.id ?? summary.photoId;
    if (!sourceId) continue;
    stats.audit3groups.input += 1;
    const phase0 = phase0ByDatasetAndId.get(`audit3groups::${sourceId}`) ?? {};
    const rating = finiteNumber(phase0.rating ?? summary.groundTruthRating);
    const outputSummary = {
      ...summary,
      dataset: 'audit3groups',
      sourceDataset: 'audit3groups',
      sourcePhotoId: sourceId,
      studentPreviewPath: phase0.studentPreviewPath ?? summary.studentPreviewPath ?? summary.previewPath,
      teacherImagePath: phase0.teacherImagePath ?? summary.teacherImagePath,
      teacherImageIsPreviewFallback: phase0.teacherImageIsPreviewFallback ?? summary.teacherImageIsPreviewFallback,
      groundTruthRating: rating,
      groundTruthPositive: rating === undefined ? undefined : rating >= 3,
      evalPositiveThreshold: 3,
      proSemanticEvalSource: 'full-audit3groups-audit',
    };
    summaries.push(outputSummary);
    usedIds.add(outputSummary.id);
    recordLabel(labels, sourceNames, outputSummary, rating);
    if (rating !== undefined && rating >= 3) stats.audit3groups.positives += 1;
    if (rating !== undefined && rating <= 0) stats.audit3groups.negatives += 1;
    stats.audit3groups.output += 1;
  }
}

if (includeCamera) {
  const cameraImages = phase0Images.filter(item => item.dataset === 'camera');
  stats.camera.input = cameraImages.length;
  for (const item of cameraImages) {
    const sourceId = item.photoId ?? item.id;
    if (!sourceId) continue;
    const id = usedIds.has(sourceId) ? `camera::${sourceId}` : sourceId;
    usedIds.add(id);
    const rating = finiteNumber(item.rating);
    const previewPath = item.studentPreviewPath ?? item.previewPath ?? item.imagePath;
    const sourceName = item.teacherImagePath ?? item.imagePath ?? previewPath ?? sourceId;
    const fileName = basename(previewPath || sourceName || sourceId);
    const outputSummary = {
      id,
      photoId: id,
      sourcePhotoId: sourceId,
      dataset: 'camera',
      sourceDataset: 'camera',
      fileName,
      sourceName,
      studentPreviewPath: previewPath,
      teacherImagePath: item.teacherImagePath,
      teacherImageIsPreviewFallback: item.teacherImageIsPreviewFallback,
      status: 'DONE',
      picked: false,
      inDuplicateGroup: false,
      formalBest: false,
      issueCodes: [],
      hardIssueCodes: [],
      reviewHintCodes: [],
      exclusionReasons: [],
      gateReasons: [],
      overall: 50,
      technical: 50,
      aesthetic: 50,
      scene: 50,
      focusTexture: 0,
      focusPeakTexture: 0,
      focusReliability: 0.5,
      focusReliable: false,
      duplicateSignature: null,
      groundTruthRating: rating,
      groundTruthPositive: rating === undefined ? undefined : rating >= 1,
      evalPositiveThreshold: 1,
      proSemanticEvalSource: 'pro-only-minimal-camera-audit',
    };
    summaries.push(outputSummary);
    recordLabel(labels, sourceNames, outputSummary, rating);
    if (rating !== undefined && rating >= 1) stats.camera.positives += 1;
    if (rating !== undefined && rating <= 0) stats.camera.negatives += 1;
    stats.camera.output += 1;
  }
}

if (includeFiveMountain) {
  const fiveLabels = await readJson(fiveMountainLabelsPath);
  const records = fiveLabels.records ?? {};
  stats.five_mountain.input = Object.keys(records).length;
  for (const [stem, record] of Object.entries(records)) {
    const sourceId = stem;
    const id = usedIds.has(sourceId) ? `five_mountain::${sourceId}` : sourceId;
    usedIds.add(id);
    const rating = finiteNumber(record?.rating);
    const previewPath = join(fiveMountainPreviewDir, `${stem}.jpg`);
    const fileName = basename(previewPath);
    const outputSummary = {
      id,
      photoId: id,
      sourcePhotoId: sourceId,
      dataset: 'five_mountain',
      sourceDataset: 'five_mountain',
      fileName,
      sourceName: previewPath,
      studentPreviewPath: previewPath,
      teacherImagePath: record?.teacherImagePath,
      teacherImageIsPreviewFallback: false,
      status: 'DONE',
      picked: false,
      inDuplicateGroup: false,
      formalBest: false,
      issueCodes: [],
      hardIssueCodes: [],
      reviewHintCodes: [],
      exclusionReasons: [],
      gateReasons: [],
      overall: 50,
      technical: 50,
      aesthetic: 50,
      scene: 50,
      focusTexture: 0,
      focusPeakTexture: 0,
      focusReliability: 0.5,
      focusReliable: false,
      duplicateSignature: null,
      groundTruthRating: rating,
      groundTruthPositive: rating === undefined ? undefined : rating >= 1,
      evalPositiveThreshold: 1,
      proSemanticEvalSource: 'pro-only-minimal-five-mountain-audit',
    };
    summaries.push(outputSummary);
    recordLabel(labels, sourceNames, outputSummary, rating);
    if (rating !== undefined && rating >= 1) stats.five_mountain.positives += 1;
    if (rating !== undefined && rating <= 0) stats.five_mountain.negatives += 1;
    stats.five_mountain.output += 1;
  }
}

const outputAudit = {
  ...audit3groupsAudit,
  mode: 'pro-semantic-eval-input',
  photoSummaries: summaries,
  proSemanticEvalMeta: {
    schemaVersion: 'framecull-pro-semantic-eval-audit-v1',
    evaluationScope: includeFiveMountain
      ? 'mixed-full-audit3groups-camera-and-five-mountain'
      : (includeCamera
        ? 'mixed-full-audit3groups-and-pro-only-minimal-camera-audit'
        : 'full-audit3groups-audit-only'),
    audit3groupsAuditPath: audit3groupsAuditPath,
    phase0AllImagesPath: phase0AllImagesPath,
    labelsOutputPath,
    warning: 'Camera records are minimal Pro-only scoring/ranking sanity records when no full Flash audit exists. Do not treat them as full production AI Pick replay.',
    datasetPolicies: {
      audit3groups: { positiveThreshold: 3, negativeThreshold: 0, missingAsNegative: true },
      camera: { positiveThreshold: 1, negativeThreshold: 0, missingAsNegative: true },
      five_mountain: { positiveThreshold: 1, negativeThreshold: 0, missingAsNegative: true },
    },
    stats,
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(outputAudit, null, 2), 'utf8');
await writeFile(metaOutputPath, JSON.stringify(outputAudit.proSemanticEvalMeta, null, 2), 'utf8');
await writeFile(labelsOutputPath, JSON.stringify({ labels, sourceNames }, null, 2), 'utf8');

console.log(`[pro-semantic-eval-audit] wrote ${summaries.length} summaries -> ${outputPath}`);
console.log(`[pro-semantic-eval-audit] labels -> ${labelsOutputPath}`);
console.log(`[pro-semantic-eval-audit] meta -> ${metaOutputPath}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[index + 1];
    parsed[key] = next && !next.startsWith('--') ? next : 'true';
    if (next && !next.startsWith('--')) index += 1;
  }
  return parsed;
}

function parseBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizePhase0Images(raw) {
  if (Array.isArray(raw)) return raw;
  for (const key of ['images', 'items', 'records', 'photoSummaries']) {
    if (Array.isArray(raw?.[key])) return raw[key];
  }
  throw new Error('Phase0 all-images JSON must be an array or contain images/items/records/photoSummaries.');
}

async function readJson(filePath) {
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function recordLabel(labels, sourceNames, summary, rating) {
  if (rating !== undefined) labels[summary.id] = { rating };
  sourceNames[summary.id] = summary.sourceName ?? summary.teacherImagePath ?? summary.studentPreviewPath ?? '';
}
