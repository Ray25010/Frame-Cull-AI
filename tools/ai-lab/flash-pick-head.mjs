import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AUDIT_PATH = path.join('output', 'ai-bench', 'ai-culling-bench-scene-aware-replay.json');
const DEFAULT_OUTPUT_DIR = path.join('output', 'ai-bench', 'flash-pick-head');
const DEFAULT_GDRIVE_LABELS_PATH = 'D:\\FrameCullRawAudit\\raw-audit-previews\\labels.json';
const DEFAULT_CAMERA_LABELS_PATH = 'D:\\FrameCullRawAudit\\camera-labels\\camera-labels-final.json';
const DEFAULT_RATIOS = [0.38, 0.45, 0.5, 0.6];
const SCHEMA = 'framecull-flash-pick-head-v1';
const AI_PICK_MIN_OVERALL = 38;
const AI_PICK_MIN_TECHNICAL = 20;
const SOLO_SUPPRESSION_SIMILARITY = 0.82;
const SOLO_SUPPRESSION_NUMERIC_GAP = 3;
const MAX_GROUP_SIZE = 5;

export const FLASH_PICK_HEAD_FEATURES = [
  'overall',
  'technical',
  'aesthetic',
  'scene',
  'focusTextureCapped',
  'focusPeakTextureCapped',
  'focusReliability',
  'reviewHintCount',
  'hardIssueCount',
  'focusFail',
  'lowTexture',
  'scenicStrength',
  'stableTechnical',
  'aestheticSceneBlend',
];

const FORBIDDEN_FEATURE_WORDS = [
  'rating',
  'groundtruth',
  'positive',
  'negative',
  'label',
  'folder',
  'source',
  'file',
  'path',
  'name',
  'id',
  'selection',
  'picked',
  'manual',
];

const HEAD_PROFILES = [
  { name: 'flash-linear-balanced', positiveScale: 1, negativeScale: 1, l2: 0.04, learningRate: 0.09, epochs: 900 },
  { name: 'flash-linear-recall', positiveScale: 1.35, negativeScale: 0.8, l2: 0.035, learningRate: 0.08, epochs: 900 },
  { name: 'flash-linear-precision', positiveScale: 0.9, negativeScale: 1.45, l2: 0.05, learningRate: 0.08, epochs: 900 },
  { name: 'flash-linear-scene-rescue', positiveScale: 1.15, negativeScale: 1, l2: 0.03, learningRate: 0.08, epochs: 1000 },
];

const args = parseArgs(process.argv.slice(2));

if (isMainModule()) {
  await main(args);
}

export async function main(cliArgs = {}) {
  assertNoForbiddenFeatureLeakage(FLASH_PICK_HEAD_FEATURES);

  const auditPaths = parsePathList(cliArgs.audit ?? latestAuditPath()).map(item => path.resolve(item));
  const outputDir = path.resolve(cliArgs.output ?? DEFAULT_OUTPUT_DIR);
  const ratios = parseRatios(cliArgs.ratios ?? DEFAULT_RATIOS.join(','));
  const gdriveLabelsPath = path.resolve(cliArgs.gdriveLabels ?? DEFAULT_GDRIVE_LABELS_PATH);
  const cameraLabelsPath = path.resolve(cliArgs.cameraLabels ?? DEFAULT_CAMERA_LABELS_PATH);
  const audits = await Promise.all(auditPaths.map(async filePath => ({
    filePath,
    audit: await readJson(filePath),
  })));
  const records = buildRecordsFromAudits(audits);
  const labelSets = await loadDefaultLabelSets({ gdriveLabelsPath, cameraLabelsPath });
  attachLabels(records, labelSets);
  const supervisedRecords = records.filter(record => record.trainingLabel);

  if (supervisedRecords.length === 0) {
    throw new Error('No matched labels found for the audit records. Check label paths or audit source.');
  }

  const groupContext = buildGroupContext(audits, records);
  const heads = HEAD_PROFILES.map(profile => trainLinearHead(supervisedRecords, profile));
  const evaluations = evaluateAll(records, groupContext, heads, ratios);
  const selectedByRatio = chooseHeadsByRatio(evaluations, ratios);
  const report = buildReport({
    auditPaths,
    outputDir,
    ratios,
    records,
    labelSets,
    groupContext,
    heads,
    evaluations,
    selectedByRatio,
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'summary.md'), report.summaryMarkdown, 'utf8');
  await writeFile(path.join(outputDir, 'metrics-by-ratio.csv'), metricsCsv(evaluations), 'utf8');
  await writeFile(path.join(outputDir, 'selected-head.json'), JSON.stringify(report.selectedHeadPayload, null, 2), 'utf8');
  await writeFile(path.join(outputDir, 'false-negatives-by-ratio.csv'), falseNegativesCsv(report.falseNegativesByRatio), 'utf8');
  await writeFile(path.join(outputDir, 'duplicate-pollution-by-ratio.csv'), duplicatePollutionCsv(report.duplicatePollutionByRatio), 'utf8');
  await writeFile(path.join(outputDir, 'flash-pick-head-result.json'), JSON.stringify(report.json, null, 2), 'utf8');

  console.log('FrameCull Flash pick head lab complete.');
  console.log(`Summary: ${path.join(outputDir, 'summary.md')}`);
  for (const ratio of ratios) {
    const selected = selectedByRatio.get(ratio);
    if (!selected) continue;
    const combined = selected.metrics.combined;
    console.log(`ratio=${ratio}: ${selected.rankMode} recall=${formatPct(combined.recall)} picked=${selected.metrics.picked}`);
  }
}

function isMainModule() {
  const modulePath = fileURLToPath(import.meta.url);
  return process.argv[1] && path.resolve(process.argv[1]) === modulePath;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, value) => value.toUpperCase());
    const next = argv[index + 1];
    parsed[key] = next && !next.startsWith('--') ? next : 'true';
    if (next && !next.startsWith('--')) index += 1;
  }
  return parsed;
}

function latestAuditPath() {
  if (existsSync(DEFAULT_AUDIT_PATH)) return DEFAULT_AUDIT_PATH;
  const dir = path.join('output', 'ai-bench');
  const matches = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^ai-culling-bench-.*\.json$/.test(entry.name))
    .map(entry => {
      const fullPath = path.join(dir, entry.name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (matches.length === 0) throw new Error(`No ai-culling-bench JSON found in ${dir}`);
  return matches[0].fullPath;
}

function parseRatios(value) {
  return String(value)
    .split(',')
    .map(item => Number(item.trim()))
    .filter(value => Number.isFinite(value) && value > 0 && value <= 1);
}

function parsePathList(value) {
  return String(value)
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function loadDefaultLabelSets({ gdriveLabelsPath, cameraLabelsPath }) {
  const labelSets = [];
  if (existsSync(gdriveLabelsPath)) {
    labelSets.push(parseGdriveLabels(await readJson(gdriveLabelsPath), gdriveLabelsPath));
  }
  if (existsSync(cameraLabelsPath)) {
    labelSets.push(parseCameraLabels(await readJson(cameraLabelsPath), cameraLabelsPath));
  }
  if (labelSets.length === 0) {
    throw new Error('No label files were found.');
  }
  return labelSets;
}

function parseGdriveLabels(raw, filePath) {
  const labels = new Map();
  for (const [key, value] of Object.entries(raw.labels ?? {})) {
    const rating = Number(value);
    if (Number.isFinite(rating)) labels.set(normalizeKey(key), rating);
  }
  return {
    name: 'gdrive-rating-ge3',
    filePath,
    positiveThreshold: 3,
    negativeThreshold: 1,
    missingAsNegative: false,
    labels,
  };
}

function parseCameraLabels(raw, filePath) {
  const labels = new Map();
  const source = raw.records ?? raw.labels ?? {};
  for (const [key, value] of Object.entries(source)) {
    const rating = Number(typeof value === 'object' && value ? value.rating ?? value.label : value);
    if (Number.isFinite(rating)) labels.set(normalizeKey(key), rating);
  }
  return {
    name: 'camera-rating-ge1',
    filePath,
    positiveThreshold: 1,
    negativeThreshold: 0,
    missingAsNegative: false,
    labels,
  };
}

function buildRecordsFromAudits(audits) {
  const seen = new Map();
  const records = [];
  for (const { filePath, audit } of audits) {
    const summaries = audit.photoSummaries ?? [];
    for (const summary of summaries) {
      const record = buildRecord(summary, filePath);
      const baseId = record.id;
      const seenCount = seen.get(baseId) ?? 0;
      seen.set(baseId, seenCount + 1);
      if (seenCount > 0) {
        record.id = `${record.sourceFolder}:${baseId}`;
        record.originalId = baseId;
      }
      records.push(record);
    }
  }
  return records.sort(comparePhotoOrder);
}

function buildRecord(summary, auditPath) {
    const record = {
      ...summary,
      id: String(summary.id ?? stripExtension(summary.fileName ?? '')),
      originalId: String(summary.id ?? stripExtension(summary.fileName ?? '')),
      auditPath,
      fileBaseName: stripExtension(summary.fileName ?? ''),
      sourceBaseName: stripExtension(path.basename(String(summary.sourceName ?? ''))),
      sourceFolder: sourceFolder(summary.sourceName),
      numericId: trailingNumber(summary.id ?? summary.fileName ?? summary.sourceName ?? ''),
      labels: new Map(),
      trainingLabel: undefined,
    };
    return record;
}

function attachLabels(records, labelSets) {
  for (const record of records) {
    const keys = candidateLabelKeys(record);
    for (const labelSet of labelSets) {
      const rating = firstMatchedRating(keys, labelSet.labels);
      if (rating === undefined) continue;
      const label = {
        labelSet: labelSet.name,
        rating,
        positive: rating >= labelSet.positiveThreshold,
        negative: rating <= labelSet.negativeThreshold,
      };
      record.labels.set(labelSet.name, label);
      if (!record.trainingLabel) record.trainingLabel = label;
    }
  }
}

function candidateLabelKeys(record) {
  return [
    record.id,
    record.fileBaseName,
    record.sourceBaseName,
    stripExtension(record.sourceName ?? ''),
  ]
    .filter(Boolean)
    .map(normalizeKey);
}

function firstMatchedRating(keys, labels) {
  for (const key of keys) {
    if (labels.has(key)) return labels.get(key);
  }
  return undefined;
}

function normalizeKey(value) {
  return stripExtension(String(value).trim())
    .replaceAll('/', '\\')
    .split('\\')
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase() ?? '';
}

function stripExtension(value) {
  const text = String(value ?? '').trim();
  return text.replace(/\.[^.\\/]+$/, '');
}

function sourceFolder(sourceName) {
  const normalized = String(sourceName || '').replaceAll('/', '\\');
  const parts = normalized.split('\\').filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return 'unknown';
}

function buildGroupContext(audits, records) {
  const pairSimilarities = audits.flatMap(({ audit }) => normalizePairSimilarities(audit.pairSimilarities ?? [], records));
  const groups = dedupeGroups([
    ...audits.flatMap(({ audit, filePath }) => parseCompactGroups(audit.compactDuplicateGroups ?? [], records, filePath)),
    ...audits.flatMap(({ audit, filePath }) => parseSupervisedGroups(audit.duplicateStats?.supervisedGroups ?? [], records, filePath)),
  ], records);
  return {
    groups,
    pairSimilarities,
    pairSimilarityMap: buildPairSimilarityMap(pairSimilarities),
  };
}

function parseCompactGroups(groups, records, auditPath) {
  const byKey = recordLookup(records);
  return groups
    .map((group, index) => ({
      id: group.id ?? `compact-${index + 1}`,
      source: 'audit-compact-duplicate',
      photoIds: unique(group.photoIds ?? []).map(id => resolveRecordId(id, auditPath, byKey)).filter(Boolean),
    }))
    .filter(group => group.photoIds.length >= 2);
}

function parseSupervisedGroups(groups, records, auditPath) {
  const byKey = recordLookup(records);
  return groups
    .map((group, index) => ({
      id: group.id ?? `supervised-${index + 1}`,
      source: 'audit-supervised-duplicate',
      photoIds: unique((group.photos ?? []).map(photo => photo.id)).map(id => resolveRecordId(id, auditPath, byKey)).filter(Boolean),
    }))
    .filter(group => group.photoIds.length >= 2);
}

function dedupeGroups(groups, records) {
  const byId = new Map(records.map(record => [record.id, record]));
  const seenMembers = new Set();
  const output = [];
  for (const group of groups) {
    const fresh = unique(group.photoIds)
      .filter(id => byId.has(id))
      .filter(id => !seenMembers.has(id))
      .sort((left, right) => comparePhotoOrder(byId.get(left), byId.get(right)));
    for (let index = 0; index < fresh.length; index += MAX_GROUP_SIZE) {
      const chunk = fresh.slice(index, index + MAX_GROUP_SIZE);
      if (chunk.length < 2) continue;
      chunk.forEach(id => seenMembers.add(id));
      output.push({
        id: `${group.id}${fresh.length > MAX_GROUP_SIZE ? `-chunk-${Math.floor(index / MAX_GROUP_SIZE) + 1}` : ''}`,
        source: group.source,
        photoIds: chunk,
      });
    }
  }
  return output;
}

function recordLookup(records) {
  const byId = new Map(records.map(record => [record.id, record.id]));
  const byAuditOriginal = new Map(records.map(record => [`${record.auditPath}::${record.originalId}`, record.id]));
  return { byId, byAuditOriginal };
}

function resolveRecordId(id, auditPath, lookup) {
  return lookup.byAuditOriginal.get(`${auditPath}::${id}`) ?? lookup.byId.get(id);
}

function normalizePairSimilarities(pairs, records) {
  const byId = new Map(records.map(record => [record.id, record]));
  return pairs
    .map(pair => ({
      leftId: pair.leftId,
      rightId: pair.rightId,
      similarity: Number(pair.similarity),
      numericGap: numberOr(pair.numericGap, undefined),
      timeGapMs: numberOr(pair.timeGapMs, undefined),
    }))
    .filter(pair => byId.has(pair.leftId) && byId.has(pair.rightId) && Number.isFinite(pair.similarity));
}

function buildPairSimilarityMap(pairs) {
  const map = new Map();
  for (const pair of pairs) {
    map.set(pairKey(pair.leftId, pair.rightId), pair);
  }
  return map;
}

function pairKey(leftId, rightId) {
  return [leftId, rightId]
    .sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }))
    .join('::');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function assertNoForbiddenFeatureLeakage(features = FLASH_PICK_HEAD_FEATURES) {
  const leaked = features.filter(feature => {
    const normalized = feature.toLowerCase();
    return FORBIDDEN_FEATURE_WORDS.some(word => normalized.includes(word));
  });
  if (leaked.length > 0) {
    throw new Error(`Flash pick head feature leakage: ${leaked.join(', ')}`);
  }
}

export function featureVectorFromRecord(record) {
  const overall = numberOr(record.overall, 0);
  const technical = numberOr(record.technical, 0);
  const aesthetic = numberOr(record.aesthetic, 0);
  const scene = numberOr(record.scene, 0);
  const focusTexture = numberOr(record.focusTexture, 0);
  const focusPeakTexture = numberOr(record.focusPeakTexture, 0);
  const focusReliability = numberOr(record.focusReliability, record.focusReliable === false ? 0.38 : 0.5);
  const reviewHintCount = (record.reviewHintCodes ?? []).length;
  const hardIssueCount = (record.hardIssueCodes ?? []).length;
  const focusFail = hasFocusFail(record) ? 1 : 0;
  const focusBase = Math.max(focusTexture, focusPeakTexture);
  const lowTexture = focusBase < 35 ? 1 : 0;
  const scenicStrength = scene * 0.65 + aesthetic * 0.35;
  const stableTechnical = Math.min(technical, 88) * 0.7 + Math.min(focusBase, 80) * 0.3;
  const aestheticSceneBlend = Math.sqrt(Math.max(0, aesthetic) * Math.max(0, scene));

  return [
    overall,
    technical,
    aesthetic,
    scene,
    Math.min(focusTexture, 80),
    Math.min(focusPeakTexture, 85),
    focusReliability,
    reviewHintCount,
    hardIssueCount,
    focusFail,
    lowTexture,
    scenicStrength,
    stableTechnical,
    aestheticSceneBlend,
  ];
}

export function trainLinearHead(records, profile = HEAD_PROFILES[0]) {
  const rows = records
    .filter(record => record.trainingLabel)
    .map(record => ({
      features: featureVectorFromRecord(record),
      y: record.trainingLabel.positive ? 1 : 0,
    }));
  if (rows.length === 0) throw new Error('Cannot train Flash pick head without labels.');

  const positiveCount = rows.filter(row => row.y === 1).length;
  const negativeCount = rows.length - positiveCount;
  if (positiveCount === 0 || negativeCount === 0) {
    throw new Error(`Need both positive and negative labels. pos=${positiveCount}, neg=${negativeCount}`);
  }

  const stats = featureStats(rows.map(row => row.features));
  const weights = Array(FLASH_PICK_HEAD_FEATURES.length).fill(0);
  let bias = Math.log(positiveCount / negativeCount);
  const positiveWeight = (rows.length / (2 * positiveCount)) * profile.positiveScale;
  const negativeWeight = (rows.length / (2 * negativeCount)) * profile.negativeScale;

  for (let epoch = 0; epoch < profile.epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    let biasGradient = 0;
    for (const row of rows) {
      const x = normalizeFeatures(row.features, stats);
      const z = bias + dot(weights, x);
      const prediction = sigmoid(z);
      const sampleWeight = row.y === 1 ? positiveWeight : negativeWeight;
      const error = (prediction - row.y) * sampleWeight;
      biasGradient += error;
      for (let index = 0; index < weights.length; index += 1) {
        gradient[index] += error * x[index];
      }
    }
    const scale = 1 / rows.length;
    bias -= profile.learningRate * biasGradient * scale;
    for (let index = 0; index < weights.length; index += 1) {
      const regularized = gradient[index] * scale + profile.l2 * weights[index];
      weights[index] -= profile.learningRate * regularized;
    }
  }

  return {
    schema: `${SCHEMA}-linear-head`,
    name: profile.name,
    profile,
    features: FLASH_PICK_HEAD_FEATURES,
    means: stats.means,
    scales: stats.scales,
    weights,
    bias,
    training: {
      rows: rows.length,
      positiveCount,
      negativeCount,
    },
  };
}

function featureStats(rows) {
  const count = rows.length;
  const means = Array(FLASH_PICK_HEAD_FEATURES.length).fill(0);
  for (const row of rows) {
    row.forEach((value, index) => {
      means[index] += value / count;
    });
  }
  const variances = Array(FLASH_PICK_HEAD_FEATURES.length).fill(0);
  for (const row of rows) {
    row.forEach((value, index) => {
      variances[index] += ((value - means[index]) ** 2) / count;
    });
  }
  const scales = variances.map(value => Math.max(Math.sqrt(value), 1e-6));
  return { means, scales };
}

function normalizeFeatures(features, stats) {
  return features.map((value, index) => (value - stats.means[index]) / stats.scales[index]);
}

export function scoreLinearHead(record, head) {
  return head.bias + dot(head.weights, normalizeFeatures(featureVectorFromRecord(record), head));
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function evaluateAll(records, groupContext, heads, ratios) {
  const rankers = [
    {
      rankMode: 'current-lightweight-rules',
      family: 'baseline',
      score: rankCurrent,
    },
    {
      rankMode: 'ratio-aware-precision',
      family: 'ratio-aware-rules',
      score: rankRatioPrecision,
    },
    {
      rankMode: 'ratio-aware-balanced',
      family: 'ratio-aware-rules',
      score: rankRatioBalanced,
    },
    {
      rankMode: 'ratio-aware-recall',
      family: 'ratio-aware-rules',
      score: rankRatioRecall,
    },
    ...heads.map(head => ({
      rankMode: head.name,
      family: 'flash-tiny-head',
      head,
      score: record => scoreLinearHead(record, head),
    })),
  ];

  const evaluations = [];
  for (const ratio of ratios) {
    for (const ranker of rankers) {
      const pickedIds = selectAiPicksForRecords(records, groupContext, ranker.score, ratio);
      evaluations.push({
        ratio,
        rankMode: ranker.rankMode,
        family: ranker.family,
        headName: ranker.head?.name,
        pickedIds,
        metrics: computeAllMetrics(records, pickedIds, groupContext, ratio, ranker),
      });
    }
  }
  return evaluations;
}

export function selectAiPicksForRecords(records, groupContext, scoreRecord, ratio) {
  const usable = records.filter(isUsable);
  const target = Math.ceil(usable.length * ratio);
  const byId = new Map(records.map(record => [record.id, record]));
  const selected = new Set();
  const groupedIds = new Set();

  for (const group of groupContext.groups ?? []) {
    const groupRecords = group.photoIds
      .map(id => byId.get(id))
      .filter(record => record && isUsable(record));
    group.photoIds.forEach(id => groupedIds.add(id));
    if (groupRecords.length === 0) continue;
    const representative = topByScore(groupRecords, scoreRecord);
    if (representative) selected.add(representative.id);
  }

  const solos = usable
    .filter(record => !groupedIds.has(record.id))
    .sort((left, right) => scoreRecord(right) - scoreRecord(left) || comparePhotoOrder(left, right));
  const deferred = [];
  for (const record of solos) {
    if (selected.size >= target) break;
    if (isRedundantSolo(record, selected, byId, groupContext.pairSimilarityMap)) {
      deferred.push(record);
      continue;
    }
    selected.add(record.id);
  }
  for (const record of deferred) {
    if (selected.size >= target) break;
    selected.add(record.id);
  }
  return selected;
}

function topByScore(records, scoreRecord) {
  return [...records].sort((left, right) => scoreRecord(right) - scoreRecord(left) || comparePhotoOrder(left, right))[0];
}

function isRedundantSolo(record, selectedIds, byId, pairSimilarityMap) {
  if (record.numericId === null) return false;
  for (const selectedId of selectedIds) {
    const selected = byId.get(selectedId);
    if (!selected || selected.sourceFolder !== record.sourceFolder || selected.numericId === null) continue;
    const gap = Math.abs(record.numericId - selected.numericId);
    if (gap <= 0 || gap > SOLO_SUPPRESSION_NUMERIC_GAP) continue;
    const pair = pairSimilarityMap.get(pairKey(record.id, selected.id));
    if (pair && pair.similarity >= SOLO_SUPPRESSION_SIMILARITY) return true;
  }
  return false;
}

function isUsable(record) {
  if (record.status !== 'DONE') return false;
  if ((record.hardIssueCodes ?? []).length > 0) return false;
  if ((record.exclusionReasons ?? []).includes('FOCUS_FAIL')) return false;
  if (hasFocusFail(record)) return false;
  if (numberOr(record.overall, 0) < AI_PICK_MIN_OVERALL) return false;
  if (numberOr(record.technical, 0) < AI_PICK_MIN_TECHNICAL) return false;
  return true;
}

function hasFocusFail(record) {
  const hard = record.hardIssueCodes ?? [];
  const issues = record.issueCodes ?? [];
  if (hard.includes('OUT_OF_FOCUS') || issues.includes('ISSUE:OUT_OF_FOCUS')) return true;
  const focusTexture = numberOr(record.focusTexture, 100);
  const focusPeak = numberOr(record.focusPeakTexture, 100);
  const reliability = numberOr(record.focusReliability, record.focusReliable === false ? 0.38 : 1);
  return focusTexture < 30 && focusPeak < 38 && reliability < 0.42;
}

function rankCurrent(record) {
  const reviewPenalty = (record.reviewHintCodes ?? []).length * 4;
  return (
    numberOr(record.overall, 0) * 1.2 +
    numberOr(record.technical, 0) * 0.25 +
    numberOr(record.scene, 0) * 0.12 +
    numberOr(record.focusReliability, 0.5) * 3 -
    reviewPenalty
  );
}

function rankRatioPrecision(record) {
  const focusBase = Math.max(numberOr(record.focusTexture, 0), numberOr(record.focusPeakTexture, 0));
  const reviewPenalty = (record.reviewHintCodes ?? []).length * 4;
  return (
    numberOr(record.technical, 0) * 1.08 +
    numberOr(record.overall, 0) * 0.58 +
    numberOr(record.scene, 0) * 0.16 +
    numberOr(record.aesthetic, 0) * 0.08 +
    Math.min(focusBase, 75) * 0.3 +
    numberOr(record.focusReliability, 0.5) * 9 -
    reviewPenalty * 1.35
  );
}

function rankRatioBalanced(record) {
  const focusBase = Math.max(numberOr(record.focusTexture, 0), numberOr(record.focusPeakTexture, 0));
  const reviewPenalty = (record.reviewHintCodes ?? []).length * 4;
  return (
    numberOr(record.technical, 0) * 0.82 +
    numberOr(record.overall, 0) * 0.72 +
    numberOr(record.scene, 0) * 0.28 +
    numberOr(record.aesthetic, 0) * 0.16 +
    Math.min(focusBase, 70) * 0.24 +
    numberOr(record.focusReliability, 0.5) * 7 -
    reviewPenalty * 1.1
  );
}

function rankRatioRecall(record) {
  const focusBase = Math.max(numberOr(record.focusTexture, 0), numberOr(record.focusPeakTexture, 0));
  const reviewPenalty = (record.reviewHintCodes ?? []).length * 4;
  return (
    numberOr(record.overall, 0) * 0.82 +
    numberOr(record.technical, 0) * 0.58 +
    numberOr(record.scene, 0) * 0.34 +
    numberOr(record.aesthetic, 0) * 0.24 +
    Math.min(focusBase, 65) * 0.18 +
    numberOr(record.focusReliability, 0.5) * 5 -
    reviewPenalty * 0.85
  );
}

function computeAllMetrics(records, pickedIds, groupContext, ratio, ranker) {
  const labelSetNames = unique(records.flatMap(record => [...record.labels.keys()]));
  const byLabelSet = Object.fromEntries(labelSetNames.map(name => [
    name,
    computeLabelMetrics(records, pickedIds, name),
  ]));
  const combined = computeCombinedMetrics(records, pickedIds);
  const duplicate = duplicateMetrics(records, pickedIds, groupContext);
  const blockedPicked = records.filter(record => pickedIds.has(record.id) && !isUsable(record)).length;
  return {
    ratio,
    rankMode: ranker.rankMode,
    family: ranker.family,
    picked: pickedIds.size,
    target: Math.ceil(records.filter(isUsable).length * ratio),
    blockedPicked,
    combined,
    byLabelSet,
    duplicate,
  };
}

function computeCombinedMetrics(records, pickedIds) {
  const labeled = records.filter(record => record.trainingLabel);
  return computeMetricsForLabels(labeled, pickedIds, record => record.trainingLabel);
}

function computeLabelMetrics(records, pickedIds, labelSetName) {
  const labeled = records.filter(record => record.labels.has(labelSetName));
  return computeMetricsForLabels(labeled, pickedIds, record => record.labels.get(labelSetName));
}

function computeMetricsForLabels(labeled, pickedIds, labelForRecord) {
  const positives = labeled.filter(record => labelForRecord(record)?.positive);
  const negatives = labeled.filter(record => labelForRecord(record)?.negative);
  const picked = labeled.filter(record => pickedIds.has(record.id));
  const pickedPositive = positives.filter(record => pickedIds.has(record.id));
  const pickedNegative = negatives.filter(record => pickedIds.has(record.id));
  const picked4Plus = positives.filter(record => pickedIds.has(record.id) && (labelForRecord(record)?.rating ?? 0) >= 4);
  const total4Plus = positives.filter(record => (labelForRecord(record)?.rating ?? 0) >= 4);
  return {
    labeled: labeled.length,
    positives: positives.length,
    negatives: negatives.length,
    pickedLabeled: picked.length,
    truePositive: pickedPositive.length,
    falseNegative: positives.length - pickedPositive.length,
    falsePositive: pickedNegative.length,
    recall: safeRatio(pickedPositive.length, positives.length),
    precisionOnLabeled: safeRatio(pickedPositive.length, picked.length),
    negativePickRate: safeRatio(pickedNegative.length, negatives.length),
    picked4Plus: picked4Plus.length,
    total4Plus: total4Plus.length,
    recall4Plus: safeRatio(picked4Plus.length, total4Plus.length),
  };
}

function duplicateMetrics(records, pickedIds, groupContext) {
  const groups = groupContext.groups ?? [];
  const groupsWithMultiplePicks = groups.filter(group => group.photoIds.filter(id => pickedIds.has(id)).length > 1);
  const usableGroups = groups.filter(group => group.photoIds.some(id => {
    const record = records.find(item => item.id === id);
    return record && isUsable(record);
  }));
  const groupsWithPick = usableGroups.filter(group => group.photoIds.some(id => pickedIds.has(id)));
  const selectedSimilarAdjacentPairs = selectedSimilarAdjacentPairsFor(records, pickedIds, groupContext.pairSimilarityMap);
  return {
    groupCount: groups.length,
    usableGroupCount: usableGroups.length,
    usableGroupCoverage: safeRatio(groupsWithPick.length, usableGroups.length),
    groupsWithMultiplePicks: groupsWithMultiplePicks.length,
    selectedSimilarAdjacentPairs: selectedSimilarAdjacentPairs.length,
  };
}

function selectedSimilarAdjacentPairsFor(records, pickedIds, pairSimilarityMap) {
  const selected = records
    .filter(record => pickedIds.has(record.id) && record.numericId !== null)
    .sort(comparePhotoOrder);
  const pairs = [];
  for (let index = 1; index < selected.length; index += 1) {
    const left = selected[index - 1];
    const right = selected[index];
    if (left.sourceFolder !== right.sourceFolder) continue;
    const gap = Math.abs(right.numericId - left.numericId);
    if (gap <= 0 || gap > SOLO_SUPPRESSION_NUMERIC_GAP) continue;
    const pair = pairSimilarityMap.get(pairKey(left.id, right.id));
    if (pair && pair.similarity >= SOLO_SUPPRESSION_SIMILARITY) {
      pairs.push({ left, right, similarity: pair.similarity, gap });
    }
  }
  return pairs;
}

function chooseHeadsByRatio(evaluations, ratios) {
  const selected = new Map();
  for (const ratio of ratios) {
    const baseline = evaluations.find(result => result.ratio === ratio && result.rankMode === 'current-lightweight-rules');
    const candidates = evaluations.filter(result => result.ratio === ratio && result.family === 'flash-tiny-head');
    const scored = candidates.map(result => ({
      result,
      score: selectionScore(result, baseline),
    })).sort((left, right) => right.score - left.score);
    const bestHead = scored[0]?.result;
    selected.set(ratio, headPassesGate(bestHead, baseline) ? bestHead : baseline);
  }
  return selected;
}

function headPassesGate(result, baseline) {
  if (!result || !baseline) return false;
  const recallLift = result.metrics.combined.recall - baseline.metrics.combined.recall;
  const negativePickRateDelta = result.metrics.combined.negativePickRate - baseline.metrics.combined.negativePickRate;
  return (
    recallLift >= 0.03 &&
    negativePickRateDelta <= 0.005 &&
    result.metrics.duplicate.groupsWithMultiplePicks <= baseline.metrics.duplicate.groupsWithMultiplePicks &&
    result.metrics.blockedPicked === 0
  );
}

function selectionScore(result, baseline) {
  const metrics = result.metrics;
  const combined = metrics.combined;
  const baselineCombined = baseline?.metrics.combined;
  const recallLift = combined.recall - (baselineCombined?.recall ?? 0);
  const negativeRegression = Math.max(0, combined.negativePickRate - (baselineCombined?.negativePickRate ?? 0));
  const duplicateRegression = Math.max(0, metrics.duplicate.groupsWithMultiplePicks - (baseline?.metrics.duplicate.groupsWithMultiplePicks ?? 0));
  return (
    combined.recall * 100 +
    recallLift * 60 +
    combined.precisionOnLabeled * 10 -
    negativeRegression * 80 -
    duplicateRegression * 2 -
    metrics.blockedPicked * 1000
  );
}

function buildReport({ auditPaths, outputDir, ratios, records, labelSets, groupContext, heads, evaluations, selectedByRatio }) {
  const baselinesByRatio = new Map(ratios.map(ratio => [
    ratio,
    evaluations.find(result => result.ratio === ratio && result.rankMode === 'current-lightweight-rules'),
  ]));
  const falseNegativesByRatio = [];
  const duplicatePollutionByRatio = [];
  for (const ratio of ratios) {
    const selected = selectedByRatio.get(ratio);
    if (!selected) continue;
    falseNegativesByRatio.push(...sampleFalseNegatives(records, selected.pickedIds, ratio, selected.rankMode));
    duplicatePollutionByRatio.push(...sampleDuplicatePollution(records, selected.pickedIds, groupContext, ratio, selected.rankMode));
  }

  const selectedPayload = buildSelectedHeadPayload({
    ratios,
    heads,
    selectedByRatio,
    baselinesByRatio,
    labelSets,
    records,
  });
  const summaryMarkdown = buildSummaryMarkdown({
    auditPaths,
    outputDir,
    records,
    labelSets,
    groupContext,
    evaluations,
    selectedByRatio,
    baselinesByRatio,
    selectedPayload,
  });

  return {
    summaryMarkdown,
    selectedHeadPayload: selectedPayload,
    falseNegativesByRatio,
    duplicatePollutionByRatio,
    json: {
      schema: SCHEMA,
      createdAt: new Date().toISOString(),
      auditPaths,
      outputDir,
      featureNames: FLASH_PICK_HEAD_FEATURES,
      leakageAudit: selectedPayload.leakageAudit,
      labelSets: selectedPayload.labelSets,
      selectedByRatio: selectedPayload.selectedByRatio,
      metrics: evaluations.map(result => serializableEvaluation(result)),
    },
  };
}

function buildSelectedHeadPayload({ ratios, heads, selectedByRatio, baselinesByRatio, labelSets, records }) {
  const selected = {};
  for (const ratio of ratios) {
    const result = selectedByRatio.get(ratio);
    const baseline = baselinesByRatio.get(ratio);
    const head = heads.find(head => head.name === result?.headName);
    const recallLift = result && baseline ? result.metrics.combined.recall - baseline.metrics.combined.recall : 0;
    const negativePickRateDelta = result && baseline ? result.metrics.combined.negativePickRate - baseline.metrics.combined.negativePickRate : 0;
    selected[ratio] = {
      rankMode: result?.rankMode,
      family: result?.family,
      passedGate: headPassesGate(result, baseline),
      recallLift,
      negativePickRateDelta,
      metrics: result?.metrics,
      head: head ? {
        name: head.name,
        features: head.features,
        means: head.means,
        scales: head.scales,
        weights: head.weights,
        bias: head.bias,
        training: head.training,
      } : null,
    };
  }
  return {
    schema: `${SCHEMA}-selected-head`,
    version: 1,
    featureNames: FLASH_PICK_HEAD_FEATURES,
    leakageAudit: {
      forbiddenWords: FORBIDDEN_FEATURE_WORDS,
      passed: true,
    },
    labelSets: labelSets.map(labelSet => ({
      name: labelSet.name,
      filePath: labelSet.filePath,
      positiveThreshold: labelSet.positiveThreshold,
      negativeThreshold: labelSet.negativeThreshold,
      matched: records.filter(record => record.labels.has(labelSet.name)).length,
    })),
    selectedByRatio: selected,
    recommendation: Object.values(selected).some(item => item.passedGate)
      ? 'candidate-for-flash-production-after-code-review'
      : 'no-production-change-yet',
  };
}

function buildSummaryMarkdown({ auditPaths, records, labelSets, groupContext, evaluations, selectedByRatio, baselinesByRatio, selectedPayload }) {
  const labelStats = labelSets.map(labelSet => {
    const metrics = computeLabelMetrics(records, new Set(), labelSet.name);
    return {
      name: labelSet.name,
      matched: metrics.labeled,
      positives: metrics.positives,
      negatives: metrics.negatives,
      policy: `rating >= ${labelSet.positiveThreshold}`,
    };
  });
  const selectedRows = [...selectedByRatio.entries()].map(([ratio, result]) => {
    const baseline = baselinesByRatio.get(ratio);
    const recallLift = result.metrics.combined.recall - (baseline?.metrics.combined.recall ?? 0);
    const negDelta = result.metrics.combined.negativePickRate - (baseline?.metrics.combined.negativePickRate ?? 0);
    return `| ${ratio} | \`${result.rankMode}\` | ${result.metrics.picked} | ${formatPct(result.metrics.combined.recall)} | ${formatSignedPct(recallLift)} | ${formatPct(result.metrics.combined.negativePickRate)} | ${formatSignedPct(negDelta)} | ${result.metrics.duplicate.groupsWithMultiplePicks} | ${result.metrics.blockedPicked} |`;
  });
  const baselineRows = evaluations
    .filter(result => result.rankMode === 'current-lightweight-rules')
    .map(result => `| ${result.ratio} | ${result.metrics.picked} | ${formatPct(result.metrics.combined.recall)} | ${formatPct(result.metrics.combined.negativePickRate)} | ${result.metrics.duplicate.groupsWithMultiplePicks} | ${result.metrics.blockedPicked} |`);
  const topRows = [...evaluations]
    .sort((left, right) => {
      if (left.ratio !== right.ratio) return left.ratio - right.ratio;
      return right.metrics.combined.recall - left.metrics.combined.recall;
    })
    .slice(0, 32)
    .map(result => `| ${result.ratio} | \`${result.rankMode}\` | ${result.family} | ${result.metrics.picked} | ${formatPct(result.metrics.combined.recall)} | ${formatPct(result.metrics.combined.precisionOnLabeled)} | ${formatPct(result.metrics.combined.negativePickRate)} | ${result.metrics.duplicate.groupsWithMultiplePicks} |`);

  return `# FrameCull Flash Tiny Pick Head Lab

## Summary
- Schema: \`${SCHEMA}\`
- Audits: \`${auditPaths.join('`, `')}\`
- Records: \`${records.length}\`
- Usable records: \`${records.filter(isUsable).length}\`
- Duplicate groups: \`${groupContext.groups.length}\`
- Feature count: \`${FLASH_PICK_HEAD_FEATURES.length}\`
- Recommendation: \`${selectedPayload.recommendation}\`

## Label Sets
| Label set | Matched | Positive | Negative | Policy |
|---|---:|---:|---:|---|
${labelStats.map(row => `| \`${row.name}\` | ${row.matched} | ${row.positives} | ${row.negatives} | ${row.policy} |`).join('\n')}

## Current Lightweight Baseline
| Ratio | Picked | Recall | Negative pick rate | Duplicate multi-pick groups | Blocked picked |
|---:|---:|---:|---:|---:|---:|
${baselineRows.join('\n')}

## Selected Flash Head By Ratio
| Ratio | Selected ranker | Picked | Recall | Recall lift | Negative pick rate | Negative delta | Duplicate multi-pick groups | Blocked picked |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
${selectedRows.join('\n')}

## Top Results
| Ratio | Ranker | Family | Picked | Recall | Precision | Negative pick rate | Duplicate multi-pick groups |
|---:|---|---|---:|---:|---:|---:|---:|
${topRows.join('\n')}

## Feature Governance
- Allowed features: \`${FLASH_PICK_HEAD_FEATURES.join(', ')}\`
- Forbidden feature audit: passed.
- This runner does not use rating, folder, source path, file name, manual pick state, Pro persona, CLIP, MUSIQ, ONNX, or native runtime as rank inputs.
- Hard faults, focus fail, and duplicate non-representative suppression remain outside the head and cannot be overridden by the head.
`;
}

function serializableEvaluation(result) {
  return {
    ratio: result.ratio,
    rankMode: result.rankMode,
    family: result.family,
    headName: result.headName,
    metrics: result.metrics,
  };
}

function metricsCsv(evaluations) {
  const headers = [
    'ratio',
    'rankMode',
    'family',
    'picked',
    'target',
    'blockedPicked',
    'combinedLabeled',
    'combinedPositive',
    'combinedNegative',
    'combinedRecall',
    'combinedPrecision',
    'combinedNegativePickRate',
    'picked4Plus',
    'total4Plus',
    'recall4Plus',
    'duplicateGroupsWithMultiplePicks',
    'selectedSimilarAdjacentPairs',
  ];
  const rows = evaluations.map(result => {
    const combined = result.metrics.combined;
    const duplicate = result.metrics.duplicate;
    return [
      result.ratio,
      result.rankMode,
      result.family,
      result.metrics.picked,
      result.metrics.target,
      result.metrics.blockedPicked,
      combined.labeled,
      combined.positives,
      combined.negatives,
      combined.recall,
      combined.precisionOnLabeled,
      combined.negativePickRate,
      combined.picked4Plus,
      combined.total4Plus,
      combined.recall4Plus,
      duplicate.groupsWithMultiplePicks,
      duplicate.selectedSimilarAdjacentPairs,
    ];
  });
  return csv([headers, ...rows]);
}

function falseNegativesCsv(rows) {
  return csv([
    ['ratio', 'rankMode', 'labelSet', 'id', 'fileName', 'sourceName', 'rating', 'overall', 'technical', 'aesthetic', 'scene'],
    ...rows.map(row => [
      row.ratio,
      row.rankMode,
      row.labelSet,
      row.id,
      row.fileName,
      row.sourceName,
      row.rating,
      row.overall,
      row.technical,
      row.aesthetic,
      row.scene,
    ]),
  ]);
}

function duplicatePollutionCsv(rows) {
  return csv([
    ['ratio', 'rankMode', 'groupId', 'photoIds', 'pickedIds'],
    ...rows.map(row => [
      row.ratio,
      row.rankMode,
      row.groupId,
      row.photoIds.join('|'),
      row.pickedIds.join('|'),
    ]),
  ]);
}

function sampleFalseNegatives(records, pickedIds, ratio, rankMode) {
  const rows = [];
  for (const record of records) {
    if (pickedIds.has(record.id)) continue;
    for (const [labelSet, label] of record.labels.entries()) {
      if (!label.positive) continue;
      rows.push({
        ratio,
        rankMode,
        labelSet,
        id: record.id,
        fileName: record.fileName ?? '',
        sourceName: record.sourceName ?? '',
        rating: label.rating,
        overall: record.overall ?? '',
        technical: record.technical ?? '',
        aesthetic: record.aesthetic ?? '',
        scene: record.scene ?? '',
      });
    }
  }
  return rows
    .sort((left, right) => Number(right.rating) - Number(left.rating) || Number(right.overall) - Number(left.overall))
    .slice(0, 80);
}

function sampleDuplicatePollution(records, pickedIds, groupContext, ratio, rankMode) {
  const rows = [];
  for (const group of groupContext.groups) {
    const picked = group.photoIds.filter(id => pickedIds.has(id));
    if (picked.length <= 1) continue;
    rows.push({
      ratio,
      rankMode,
      groupId: group.id,
      photoIds: group.photoIds,
      pickedIds: picked,
    });
  }
  return rows.slice(0, 100);
}

function csv(rows) {
  return rows.map(row => row.map(csvValue).join(',')).join('\n') + '\n';
}

function csvValue(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPct(value) {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function trailingNumber(value) {
  const match = String(value ?? '').match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

function comparePhotoOrder(left, right) {
  return (
    String(left?.sourceFolder ?? '').localeCompare(String(right?.sourceFolder ?? ''), undefined, { numeric: true }) ||
    ((left?.numericId ?? Number.POSITIVE_INFINITY) - (right?.numericId ?? Number.POSITIVE_INFINITY)) ||
    String(left?.id ?? '').localeCompare(String(right?.id ?? ''), undefined, { numeric: true })
  );
}
