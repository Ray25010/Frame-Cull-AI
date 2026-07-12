import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_OUTPUT_DIR = path.join('output', 'ai-bench', 'supervised-ai-picks');
const DEFAULT_LABELS_PATH = 'D:\\FrameCullRawAudit\\raw-audit-previews\\labels.json';
const DEFAULT_MODEL_LAB_DIR = 'D:\\FrameCullModelLab';
const DEFAULT_RATIOS = [0.38, 0.45, 0.5, 0.6];
const DEFAULT_POSITIVE_THRESHOLD = 3;
const DEFAULT_NEGATIVE_THRESHOLD = 1;
const SCHEMA = 'framecull-supervised-ai-picks-v2';
const SOLO_SUPPRESSION_SIMILARITY = 0.82;
const SOLO_SUPPRESSION_NUMERIC_GAP = 3;
const RANK_FEATURES = [
  'overall',
  'technical',
  'aesthetic',
  'scene',
  'proAesthetic',
  'proPersonaScore',
  'proSceneConfidence',
  'baselineProAesthetic',
  'baselineProPersonaScore',
  'baselineProSceneConfidence',
  'proSemanticKeepScore',
  'proFaceValidityScore',
  'proCompositionScore',
  'proMomentScore',
  'proLightingMoodScore',
  'proFalseFaceRisk',
  'focusTexture',
  'focusPeakTexture',
  'focusReliability',
  'nimaScore',
  'musiqScore',
  'clipScore',
  'hasReviewHint',
  'hardIssueCount',
  'focusFail',
];

const args = parseArgs(process.argv.slice(2));
const auditPath = path.resolve(args.audit ?? latestFile(path.join('output', 'ai-bench'), /^ai-culling-bench-.*\.json$/));
const candidateCsvPath = path.resolve(args.candidates ?? latestFile(path.join('output', 'ai-bench', 'aesthetic-candidates'), /^aesthetic-candidates-.*\.csv$/));
const labelsPath = path.resolve(args.labels ?? DEFAULT_LABELS_PATH);
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT_DIR);
const modelLabDir = path.resolve(args.modelLabDir ?? DEFAULT_MODEL_LAB_DIR);
const ratios = (args.ratios ? args.ratios.split(',').map(Number) : DEFAULT_RATIOS).filter(Number.isFinite);
const mode = args.mode === 'ratio-aware' ? 'ratio-aware' : 'standard';
const positiveThreshold = numberArg(args.positiveThreshold, DEFAULT_POSITIVE_THRESHOLD);
const negativeThreshold = numberArg(args.negativeThreshold, DEFAULT_NEGATIVE_THRESHOLD);
const missingAsNegative = booleanArg(args.missingAsNegative, false);
const datasetLabelPolicies = parseDatasetLabelPolicies(args.datasetLabelPolicies);
const configFilePath = args.configFile ? path.resolve(args.configFile) : null;
const labelPolicy = {
  positiveThreshold,
  negativeThreshold,
  missingAsNegative,
  datasetLabelPolicies,
};

assertNoLabelLeakage();

const audit = await readJson(auditPath);
const labelsManifest = existsSync(labelsPath) ? await readJson(labelsPath) : {};
const labelsForEval = labelsManifest.labels ?? labelsManifest.records ?? labelsManifest;
const candidateRows = parseCsv(await readFile(candidateCsvPath, 'utf8'));
const candidateById = new Map(candidateRows.map(row => [row.photo_id, row]));
const records = buildRecords(
  audit.photoSummaries ?? [],
  labelsForEval,
  labelsManifest.sourceNames ?? {},
  candidateById,
  labelPolicy,
);
const gpu = probeGpu(modelLabDir);
const knownGroups = buildKnownDuplicateGroups(audit.duplicateStats?.supervisedGroups ?? [], records);
const formalDuplicateGroups = buildFormalDuplicateGroups(records);
const auditCompactGroups = buildAuditCompactDuplicateGroups(audit.compactDuplicateGroups ?? [], records);
const pairSimilarities = normalizePairSimilarities(audit.pairSimilarities ?? [], records);
const pairSimilarityMap = buildPairSimilarityMap(pairSimilarities);
const groupContext = {
  knownGroups: dedupeGroups([...formalDuplicateGroups, ...knownGroups]),
  formalDuplicateGroups,
  auditCompactGroups,
  pairSimilarities,
  pairSimilarityMap,
};
const configs = configFilePath
  ? readConfigFile(await readJson(configFilePath))
  : buildConfigs(ratios);
const baseline = evaluateSnapshot(records, groupContext);
const results = [baseline, ...configs.map(config => evaluateConfig(records, groupContext, config))];
const selected = chooseBest(results);
const falseNegatives = sampleFalseNegatives(records, selected.pickedIds, selected.config, 80);
const duplicatePollution = sampleDuplicatePollution(records, selected.pickedIds, selected.groups, 100, pairSimilarityMap);
const ratioAware = mode === 'ratio-aware'
  ? buildRatioAwareReport(records, groupContext, baseline, results, ratios, pairSimilarityMap)
  : null;
const report = buildReport({
  auditPath,
  candidateCsvPath,
  labelsPath,
  outputDir,
  modelLabDir,
  gpu,
  records,
  knownGroups,
  formalDuplicateGroups,
  auditCompactGroups,
  pairSimilarities,
  baseline,
  results,
  selected,
  falseNegatives,
  duplicatePollution,
  ratioAware,
  mode,
  labelPolicy,
});

await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'metrics.csv'), metricsCsv(results), 'utf8');
await writeFile(path.join(outputDir, 'selected-config.json'), JSON.stringify(selectedConfigPayload(selected, report), null, 2), 'utf8');
await writeFile(path.join(outputDir, 'false-negatives.csv'), recordsCsv(falseNegatives), 'utf8');
await writeFile(path.join(outputDir, 'duplicate-pollution.csv'), duplicatePollutionCsv(duplicatePollution), 'utf8');
if (ratioAware) {
  await writeFile(path.join(outputDir, 'metrics-by-ratio.csv'), metricsByRatioCsv(ratioAware), 'utf8');
  await writeFile(path.join(outputDir, 'selected-config-by-ratio.json'), JSON.stringify(ratioAwareSelectedPayload(ratioAware, report), null, 2), 'utf8');
  await writeFile(path.join(outputDir, 'false-negatives-by-ratio.csv'), recordsByRatioCsv(ratioAware.falseNegativesByRatio), 'utf8');
  await writeFile(path.join(outputDir, 'duplicate-pollution-by-ratio.csv'), duplicatePollutionByRatioCsv(ratioAware.duplicatePollutionByRatio), 'utf8');
}
await writeFile(path.join(outputDir, 'summary.md'), report.summaryMarkdown, 'utf8');
await writeFile(path.join(outputDir, 'supervised-ai-picks-result.json'), JSON.stringify(report.json, null, 2), 'utf8');

console.log(`FrameCull supervised AI Pick lab complete.`);
console.log(`Summary: ${path.join(outputDir, 'summary.md')}`);
console.log(`Selected config: ${selected.name}`);
console.log(`Recall: ${formatPct(selected.metrics.recall)} | Picked: ${selected.metrics.picked} | Adjacent pollution: ${selected.metrics.selectedAdjacentPairs}`);

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

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanArg(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseDatasetLabelPolicies(value) {
  if (!value) return {};
  const text = String(value).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const policies = {};
    for (const chunk of text.split(',')) {
      const [dataset, threshold] = chunk.split(':').map(part => part?.trim()).filter(Boolean);
      if (!dataset || !Number.isFinite(Number(threshold))) continue;
      policies[dataset] = {
        positiveThreshold: Number(threshold),
        negativeThreshold: 0,
        missingAsNegative: true,
      };
    }
    return policies;
  }
}

function latestFile(dir, pattern) {
  if (!existsSync(dir)) throw new Error(`Missing directory: ${dir}`);
  const matches = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => {
      const fullPath = path.join(dir, entry.name);
      return { fullPath, mtimeMs: statMtimeMs(fullPath) };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (matches.length === 0) throw new Error(`No files matching ${pattern} in ${dir}`);
  return matches[0].fullPath;
}

function statMtimeMs(filePath) {
  return statSync(filePath).mtimeMs;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function parseCsv(text) {
  const rows = [];
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return rows;
  const headers = parseCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function readConfigFile(rawConfig) {
  const configs = Array.isArray(rawConfig)
    ? rawConfig
    : Array.isArray(rawConfig?.configs)
      ? rawConfig.configs
      : [];
  if (configs.length === 0) {
    throw new Error('Config file must be an array or an object with a non-empty configs array.');
  }
  return configs;
}

function buildRecords(photoSummaries, labels, sourceNames, candidateById, labelPolicy) {
  return photoSummaries.map(summary => {
    const candidate = candidateById.get(summary.id) ?? {};
    const rawLabelValue = labelRating(labels[summary.id]) ?? summary.groundTruthRating;
    const rating = Number.isFinite(Number(rawLabelValue)) ? Number(rawLabelValue) : undefined;
    const sourceName = summary.sourceName || sourceNames[summary.id] || '';
    const dataset = inferDataset(summary, sourceName);
    const recordPolicy = labelPolicyForDataset(dataset, labelPolicy);
    const evalRating = rating ?? (recordPolicy.missingAsNegative ? 0 : undefined);
    const positive = evalRating === undefined ? undefined : evalRating >= recordPolicy.positiveThreshold;
    const negative = evalRating === undefined ? undefined : evalRating <= recordPolicy.negativeThreshold;
    return {
      ...summary,
      dataset,
      sourceName,
      sourceFolder: sourceFolder(sourceName),
      numericId: trailingNumber(summary.id),
      rating,
      evalRating,
      evalPositiveThreshold: recordPolicy.positiveThreshold,
      evalNegativeThreshold: recordPolicy.negativeThreshold,
      evalMissingAsNegative: recordPolicy.missingAsNegative,
      positive,
      negative,
      labeledForEval: positive === true || negative === true,
      baselinePicked: Boolean(summary.picked),
      nimaScore: numberOr(candidate['nima-baseline_score'], summary.aesthetic),
      musiqScore: numberOr(candidate['musiq-ava-pyiqa_score'], undefined),
      clipScore: numberOr(candidate['clipiqa-pyiqa_score'], undefined),
      fusedBalancedScore: numberOr(candidate['fused-balanced_score'], undefined),
      fusedRecallScore: numberOr(candidate['fused-recall_score'], undefined),
      proAesthetic: numberOr(summary.proAesthetic, undefined),
      proPersonaScore: numberOr(summary.proPersonaScore, undefined),
      proSceneConfidence: numberOr(summary.proSceneConfidence, undefined),
      proSceneLabel: summary.proSceneLabel,
      baselineProAesthetic: numberOr(summary.baselineProAesthetic, undefined),
      baselineProPersonaScore: numberOr(summary.baselineProPersonaScore, undefined),
      baselineProSceneConfidence: numberOr(summary.baselineProSceneConfidence, undefined),
      baselineProSceneLabel: summary.baselineProSceneLabel,
      proSemanticKeepScore: numberOr(summary.proSemanticKeepScore, undefined),
      proFaceValidityScore: numberOr(summary.proFaceValidityScore, undefined),
      proCompositionScore: numberOr(summary.proCompositionScore, undefined),
      proMomentScore: numberOr(summary.proMomentScore, undefined),
      proLightingMoodScore: numberOr(summary.proLightingMoodScore, undefined),
      proFalseFaceRisk: numberOr(summary.proFalseFaceRisk, undefined),
      proActiveEp: summary.proActiveEp,
      proManifestPath: summary.proManifestPath,
      musiqLatencyMs: numberOr(candidate['musiq-ava-pyiqa_latency_ms'], undefined),
      clipLatencyMs: numberOr(candidate['clipiqa-pyiqa_latency_ms'], undefined),
    };
  }).sort(comparePhotoOrder);
}

function sourceFolder(sourceName) {
  const normalized = String(sourceName || '').replaceAll('/', '\\');
  const match = normalized.match(/(108NZ6_3|109NZ6_3|110NZ6_3)/);
  if (match) return match[1];
  const parts = normalized.split('\\').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildKnownDuplicateGroups(supervisedGroups, records) {
  const byId = new Map(records.map(record => [record.id, record]));
  return supervisedGroups
    .map((group, index) => {
      const ids = (group.photos ?? []).map(photo => photo.id).filter(id => byId.has(id));
      return {
        id: group.id ?? `known-${index + 1}`,
        source: 'audit-supervised-duplicate-group',
        photoIds: ids,
        bestPhotoId: group.bestPhotoId,
      };
    })
    .filter(group => group.photoIds.length >= 2);
}

function buildAuditCompactDuplicateGroups(compactGroups, records) {
  const byId = new Map(records.map(record => [record.id, record]));
  return compactGroups
    .map((group, index) => {
      const ids = (group.photoIds ?? [])
        .filter(id => byId.has(id))
        .sort((left, right) => comparePhotoOrder(byId.get(left), byId.get(right)));
      return {
        id: group.id ?? `audit-compact-${index + 1}`,
        source: 'audit-compact-duplicate',
        photoIds: ids,
        bestPhotoId: group.bestPhotoId,
        similarity: numberOr(group.similarity, undefined),
      };
    })
    .filter(group => group.photoIds.length >= 2);
}

function normalizePairSimilarities(pairs, records) {
  const byId = new Map(records.map(record => [record.id, record]));
  return pairs
    .map(pair => ({
      leftId: pair.leftId,
      rightId: pair.rightId,
      similarity: Number(pair.similarity),
      lumaHashDistance: numberOr(pair.lumaHashDistance, undefined),
      structureHashDistance: numberOr(pair.structureHashDistance, undefined),
      aspectDelta: numberOr(pair.aspectDelta, undefined),
      timeGapMs: numberOr(pair.timeGapMs, undefined),
      numericGap: numberOr(pair.numericGap, undefined),
      candidate: Boolean(pair.candidate),
    }))
    .filter(pair => byId.has(pair.leftId) && byId.has(pair.rightId) && Number.isFinite(pair.similarity))
    .sort((left, right) => (
      (left.numericGap ?? Number.POSITIVE_INFINITY) - (right.numericGap ?? Number.POSITIVE_INFINITY) ||
      right.similarity - left.similarity ||
      left.leftId.localeCompare(right.leftId, undefined, { numeric: true }) ||
      left.rightId.localeCompare(right.rightId, undefined, { numeric: true })
    ));
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

function buildFormalDuplicateGroups(records) {
  const groups = [];
  const byFolder = new Map();
  for (const record of records) {
    if (!record.inDuplicateGroup) continue;
    const key = record.sourceFolder ?? 'unknown';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(record);
  }
  for (const [folder, folderRecords] of byFolder.entries()) {
    const sorted = [...folderRecords].sort(comparePhotoOrder);
    let current = [];
    for (const record of sorted) {
      const previous = current[current.length - 1];
      const gap = previous && previous.numericId !== null && record.numericId !== null
        ? Math.abs(record.numericId - previous.numericId)
        : Number.POSITIVE_INFINITY;
      if (previous && gap > 0 && gap <= 6) {
        current.push(record);
      } else {
        pushFormalDuplicateGroup(groups, folder, current);
        current = [record];
      }
    }
    pushFormalDuplicateGroup(groups, folder, current);
  }
  return groups;
}

function dedupeGroups(groups) {
  const seen = new Set();
  const deduped = [];
  const byId = new Map(records.map(record => [record.id, record]));
  for (const group of groups) {
    const ids = [...new Set(group.photoIds)]
      .filter(id => byId.has(id))
      .sort((left, right) => comparePhotoOrder(byId.get(left), byId.get(right)));
    if (ids.length < 2) continue;
    const key = ids.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      ...group,
      photoIds: ids,
    });
  }
  return deduped;
}

function pushFormalDuplicateGroup(groups, folder, records) {
  if (records.length < 2) return;
  groups.push({
    id: `formal-duplicate-${folder}-${records[0].id}-${records[records.length - 1].id}`,
    source: 'reconstructed-formal-duplicate',
    photoIds: records.map(record => record.id),
  });
}

function labelRating(value) {
  if (value && typeof value === 'object') return value.rating ?? value.stars ?? value.xmpRating;
  return value;
}

function inferDataset(summary, sourceName = '') {
  const explicit = summary.dataset ?? summary.sourceDataset ?? summary.proDataset;
  if (explicit) return String(explicit);
  const source = String(sourceName || summary.sourceFolder || summary.sourceName || summary.fileName || summary.id || '').toLowerCase();
  if (source.includes('camera') || source.includes('相机')) return 'camera';
  return 'audit3groups';
}

function labelPolicyForDataset(dataset, globalPolicy) {
  const direct = globalPolicy.datasetLabelPolicies?.[dataset];
  return {
    positiveThreshold: Number(direct?.positiveThreshold ?? direct?.positive_threshold ?? globalPolicy.positiveThreshold),
    negativeThreshold: Number(direct?.negativeThreshold ?? direct?.negative_threshold ?? globalPolicy.negativeThreshold),
    missingAsNegative: direct?.missingAsNegative ?? direct?.missing_as_negative ?? globalPolicy.missingAsNegative,
  };
}

function mergeGroups(groups) {
  const parent = new Map();
  const groupIds = [];
  for (const group of groups) {
    const ids = [...new Set(group.photoIds)].sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));
    if (ids.length < 2) continue;
    groupIds.push(ids);
    for (const id of ids) {
      if (!parent.has(id)) parent.set(id, id);
    }
    for (const id of ids.slice(1)) {
      union(parent, ids[0], id);
    }
  }
  const components = new Map();
  for (const ids of groupIds) {
    for (const id of ids) {
      const root = find(parent, id);
      if (!components.has(root)) components.set(root, new Set());
      ids.forEach(value => components.get(root).add(value));
    }
  }
  return [...components.values()]
    .map((idSet, index) => {
      const ids = [...idSet].sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));
      return {
        id: `merged-duplicate-${index + 1}-${ids[0]}`,
        source: 'merged-formal-and-supervised-duplicate',
        photoIds: ids,
      };
    })
    .filter(group => group.photoIds.length >= 2)
    .sort((left, right) => left.photoIds[0].localeCompare(right.photoIds[0], undefined, { numeric: true }));
}

function find(parent, id) {
  const current = parent.get(id) ?? id;
  if (current === id) return id;
  const root = find(parent, current);
  parent.set(id, root);
  return root;
}

function union(parent, left, right) {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
}

function buildConfigs(ratioValues) {
  const rankModes = [
    'current',
    'technical-first',
    'musiq-assisted',
    'clip-assisted',
    'fused-technical',
    'ratio-precision',
    'ratio-balanced',
    'ratio-recall',
    'positive-rescue',
    'scene-rescue',
    'scene-aesthetic',
    'pro-persona',
    'pro-persona-scene',
    'pro-fused',
    'pro-semantic-v2-persona-only',
    'pro-semantic-v2-semantic-only',
    'pro-semantic-v2-fused',
    'pro-semantic-v2-face-guard',
    'pro-semantic-v2-flat-scalar',
  ];
  const configs = [];
  for (const ratio of ratioValues) {
    configs.push({
      name: `duplicate-only-current-r${ratio}`,
      family: 'duplicate-logic-only',
      ratio,
      rankMode: 'current',
      gateMode: 'strict',
      burstRadius: 0,
      maxBurstSize: 5,
      useKnownGroups: true,
      groupMode: 'known',
      inferAdjacentBursts: false,
    });
    for (const rankMode of rankModes) {
      configs.push({
        name: `formal-duplicates-${rankMode}-strict-r${ratio}`,
        family: familyFromRank(rankMode),
        ratio,
        rankMode,
        gateMode: 'strict',
        burstRadius: 0,
        maxBurstSize: 5,
        useKnownGroups: true,
        groupMode: 'known',
        inferAdjacentBursts: false,
      });
      configs.push({
        name: `formal-duplicates-${rankMode}-human-r${ratio}`,
        family: familyFromRank(rankMode),
        ratio,
        rankMode,
        gateMode: 'hard-only',
        burstRadius: 0,
        maxBurstSize: 5,
        useKnownGroups: true,
        groupMode: 'known',
        inferAdjacentBursts: false,
      });
      configs.push({
        name: `audit-compact-${rankMode}-human-r${ratio}`,
        family: familyFromRank(rankMode),
        ratio,
        rankMode,
        gateMode: 'hard-only',
        burstRadius: 0,
        maxBurstSize: 5,
        useKnownGroups: true,
        groupMode: 'audit-compact',
        inferAdjacentBursts: false,
      });
      for (const threshold of [0.84, 0.88, 0.92]) {
        configs.push({
          name: `pair-sim-${threshold}-${rankMode}-human-r${ratio}`,
          family: familyFromRank(rankMode),
          ratio,
          rankMode,
          gateMode: 'hard-only',
          burstRadius: 0,
          maxBurstSize: threshold >= 0.92 ? 4 : 5,
          useKnownGroups: true,
          groupMode: 'pair-threshold',
          similarityThreshold: threshold,
          maxNumericGap: threshold >= 0.92 ? 12 : 18,
          maxTimeGapMs: threshold >= 0.92 ? 1000 * 60 * 8 : 1000 * 60 * 30,
          requireCandidate: threshold < 0.92,
          inferAdjacentBursts: false,
        });
      }
      for (const threshold of [0.8, 0.82, 0.84, 0.88, 0.92]) {
        const lowRatio = ratio <= 0.45;
        configs.push({
          name: `ratio-aware-${threshold}-${rankMode}-r${ratio}`,
          family: ratioAwareFamilyFromRank(rankMode, ratio),
          ratio,
          rankMode,
          gateMode: 'hard-only',
          burstRadius: 0,
          maxBurstSize: lowRatio ? 4 : 5,
          useKnownGroups: true,
          groupMode: 'pair-threshold',
          similarityThreshold: threshold,
          maxNumericGap: lowRatio ? 12 : 18,
          maxTimeGapMs: lowRatio ? 1000 * 60 * 8 : 1000 * 60 * 30,
          requireCandidate: threshold < 0.92,
          inferAdjacentBursts: false,
          soloSuppressionSimilarity: lowRatio ? Math.min(0.9, threshold + 0.02) : 0.82,
          soloSuppressionNumericGap: lowRatio ? 5 : 3,
        });
      }
      configs.push({
        name: `adjacent-burst-r1-${rankMode}-human-r${ratio}`,
        family: familyFromRank(rankMode),
        ratio,
        rankMode,
        gateMode: 'hard-only',
        burstRadius: 1,
        maxBurstSize: 4,
        useKnownGroups: true,
        groupMode: 'known',
        inferAdjacentBursts: true,
      });
      configs.push({
        name: `rank-only-${rankMode}-strict-r${ratio}`,
        family: rankMode === 'current' ? 'current-ranking-ratio' : familyFromRank(rankMode),
        ratio,
        rankMode,
        gateMode: 'strict',
        burstRadius: 0,
        maxBurstSize: 5,
        useKnownGroups: false,
        groupMode: 'none',
        inferAdjacentBursts: false,
      });
      configs.push({
        name: `rank-only-${rankMode}-human-r${ratio}`,
        family: rankMode === 'current' ? 'current-ranking-ratio' : familyFromRank(rankMode),
        ratio,
        rankMode,
        gateMode: 'hard-only',
        burstRadius: 0,
        maxBurstSize: 5,
        useKnownGroups: false,
        groupMode: 'none',
        inferAdjacentBursts: false,
      });
    }
  }
  return configs;
}

function familyFromRank(rankMode) {
  if (rankMode === 'current') return 'duplicate-burst-logic';
  if (rankMode === 'musiq-assisted') return 'musiq-assisted-representative';
  if (rankMode === 'clip-assisted') return 'clip-assisted-representative';
  if (rankMode === 'fused-technical') return 'fused-technical-first';
  if (rankMode === 'ratio-precision') return 'ratio-aware-rank';
  if (rankMode === 'ratio-balanced') return 'ratio-aware-rank';
  if (rankMode === 'ratio-recall') return 'ratio-aware-rank';
  if (rankMode === 'positive-rescue') return 'positive-rescue-without-labels';
  if (rankMode === 'scene-rescue') return 'positive-rescue-without-labels';
  if (rankMode === 'scene-aesthetic') return 'ratio-aware-rank';
  if (rankMode === 'pro-persona') return 'pro-persona-experimental';
  if (rankMode === 'pro-persona-scene') return 'pro-persona-experimental';
  if (rankMode === 'pro-fused') return 'pro-persona-experimental';
  if (rankMode.startsWith('pro-semantic-v2-')) return 'pro-semantic-student-experimental';
  return 'scoring-weights';
}

function ratioAwareFamilyFromRank(rankMode, ratio) {
  if (rankMode === 'positive-rescue' || rankMode === 'scene-rescue') return 'positive-rescue-without-labels';
  if (rankMode === 'musiq-assisted' || rankMode === 'clip-assisted') return familyFromRank(rankMode);
  if (ratio <= 0.45) return 'strict-dedupe-low-ratio';
  return rankMode.startsWith('ratio-') ? 'ratio-aware-rank' : familyFromRank(rankMode);
}

function evaluateSnapshot(records, groupContext) {
  const pickedIds = new Set(records.filter(record => record.baselinePicked).map(record => record.id));
  const groups = buildAllGroups(records, groupContext, {
    groupMode: 'known',
    useKnownGroups: true,
    burstRadius: 0,
    maxBurstSize: 5,
    inferAdjacentBursts: false,
  });
  const metrics = computeMetrics(records, pickedIds, groups, {
    name: 'current-production-snapshot',
    family: 'current-production-rules',
    ratio: undefined,
    rankMode: 'production',
    gateMode: 'production',
    burstRadius: undefined,
  }, groupContext.pairSimilarityMap);
  return {
    name: 'current-production-snapshot',
    family: 'current-production-rules',
    config: {
      name: 'current-production-snapshot',
      note: 'Uses picked flags from the existing audit JSON.',
    },
    metrics,
    pickedIds,
    groups,
    perFolder: perFolderMetrics(records, pickedIds),
  };
}

function evaluateConfig(records, groupContext, config) {
  const usable = records.filter(record => isUsable(record, config.gateMode));
  const target = Math.ceil(usable.length * config.ratio);
  const selected = new Set();
  const groups = buildAllGroups(records, groupContext, config);
  const groupedIds = new Set(groups.flatMap(group => group.photoIds));
  const byId = new Map(records.map(record => [record.id, record]));
  let soloDeferredCount = 0;
  let soloReaddedDeferredCount = 0;

  for (const group of groups) {
    const candidates = group.photoIds
      .map(id => records.find(record => record.id === id))
      .filter(record => record && isUsable(record, config.gateMode));
    const representative = topByRank(candidates, config.rankMode);
    if (representative) selected.add(representative.id);
  }

  const solos = usable
    .filter(record => !groupedIds.has(record.id))
    .sort((left, right) => rank(right, config.rankMode) - rank(left, config.rankMode) || comparePhotoOrder(left, right));
  const deferredSolos = [];
  for (const record of solos) {
    if (selected.size >= target) break;
    if (isRedundantSoloRecord(record, selected, byId, groupContext.pairSimilarityMap, config)) {
      deferredSolos.push(record);
      soloDeferredCount += 1;
      continue;
    }
    selected.add(record.id);
  }

  for (const record of deferredSolos) {
    if (selected.size >= target) break;
    selected.add(record.id);
    soloReaddedDeferredCount += 1;
  }

  const metrics = {
    ...computeMetrics(records, selected, groups, config, groupContext.pairSimilarityMap),
    soloDeferredCount,
    soloReaddedDeferredCount,
  };
  return {
    name: config.name,
    family: config.family,
    config,
    metrics,
    pickedIds: selected,
    groups,
    perFolder: perFolderMetrics(records, selected),
  };
}

function isRedundantSoloRecord(record, selectedIds, byId, pairSimilarityMap, config = {}) {
  if (record.numericId === null) return false;
  const numericGapLimit = config.soloSuppressionNumericGap ?? SOLO_SUPPRESSION_NUMERIC_GAP;
  const similarityLimit = config.soloSuppressionSimilarity ?? SOLO_SUPPRESSION_SIMILARITY;
  for (const selectedId of selectedIds) {
    const selected = byId.get(selectedId);
    if (!selected || selected.sourceFolder !== record.sourceFolder || selected.numericId === null) continue;
    const gap = Math.abs(record.numericId - selected.numericId);
    if (gap <= 0 || gap > numericGapLimit) continue;
    const pair = pairSimilarityMap.get(pairKey(record.id, selected.id));
    if (pair && pair.similarity >= similarityLimit) return true;
  }
  return false;
}

function buildAllGroups(records, groupContext, config) {
  const groups = [];
  const knownMemberIds = new Set();
  const seedGroups = buildSeedGroups(records, groupContext, config);
  const maxBurstSize = config.maxBurstSize ?? 5;

  for (const known of seedGroups) {
    const freshIds = known.photoIds.filter(id => !knownMemberIds.has(id));
    if (freshIds.length < 2) continue;
    const chunks = splitIntoCompactChunks(freshIds, records, maxBurstSize);
    chunks.forEach((chunk, index) => {
      chunk.forEach(id => knownMemberIds.add(id));
      if (chunk.length >= 2) {
        groups.push({
          id: `${known.id}${chunks.length > 1 ? `-chunk-${index + 1}` : ''}`,
          source: known.source,
          photoIds: chunk,
        });
      }
    });
  }

  if (!config.inferAdjacentBursts || (config.burstRadius ?? 0) <= 0) return groups;

  const byFolder = new Map();
  for (const record of records) {
    if (knownMemberIds.has(record.id)) continue;
    if (record.numericId === null) continue;
    const key = record.sourceFolder ?? 'unknown';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(record);
  }

  for (const [folder, folderRecords] of byFolder.entries()) {
    const sorted = [...folderRecords].sort(comparePhotoOrder);
    let current = [];
    for (const record of sorted) {
      const previous = current[current.length - 1];
      const gap = previous ? Math.abs(record.numericId - previous.numericId) : Number.POSITIVE_INFINITY;
      if (previous && gap > 0 && gap <= config.burstRadius && current.length < maxBurstSize) {
        current.push(record);
      } else {
        pushBurstGroup(groups, folder, current, config.burstRadius);
        current = [record];
      }
    }
    pushBurstGroup(groups, folder, current, config.burstRadius);
  }
  return groups;
}

function buildSeedGroups(records, groupContext, config) {
  if (!config.useKnownGroups || config.groupMode === 'none') return [];
  if (config.groupMode === 'audit-compact') {
    return dedupeGroups([
      ...(groupContext.auditCompactGroups ?? []),
      ...(groupContext.knownGroups ?? []),
    ]);
  }
  if (config.groupMode === 'pair-threshold') {
    const pairGroups = buildPairSimilarityGroups(records, groupContext.pairSimilarities ?? [], config);
    return pairGroups.length > 0 ? dedupeGroups(pairGroups) : dedupeGroups(groupContext.auditCompactGroups ?? []);
  }
  return dedupeGroups(groupContext.knownGroups ?? []);
}

function buildPairSimilarityGroups(records, pairs, config) {
  const byId = new Map(records.map(record => [record.id, record]));
  const threshold = config.similarityThreshold ?? 0.88;
  const maxNumericGap = config.maxNumericGap ?? 18;
  const maxTimeGapMs = config.maxTimeGapMs ?? 1000 * 60 * 30;
  const usablePairs = pairs.filter(pair => {
    if (pair.similarity < threshold) return false;
    if (config.requireCandidate && !pair.candidate) return false;
    const numericGap = pair.numericGap ?? numericGapBetween(pair.leftId, pair.rightId);
    const timeGapMs = pair.timeGapMs;
    const nearbyByName = Number.isFinite(numericGap) && numericGap > 0 && numericGap <= maxNumericGap;
    const nearbyByTime = Number.isFinite(timeGapMs) && timeGapMs <= maxTimeGapMs;
    return nearbyByName || nearbyByTime;
  });

  const byFolder = new Map();
  for (const pair of usablePairs) {
    const left = byId.get(pair.leftId);
    const right = byId.get(pair.rightId);
    if (!left || !right || left.sourceFolder !== right.sourceFolder) continue;
    const key = left.sourceFolder ?? 'unknown';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(pair);
  }

  const groups = [];
  for (const [folder, folderPairs] of byFolder.entries()) {
    const photoIds = new Set(folderPairs.flatMap(pair => [pair.leftId, pair.rightId]));
    const sortedRecords = [...photoIds]
      .map(id => byId.get(id))
      .filter(Boolean)
      .sort(comparePhotoOrder);
    let current = [];
    for (const record of sortedRecords) {
      if (current.length === 0 || canJoinPairGroup(record, current, folderPairs, config)) {
        current.push(record);
        continue;
      }
      pushPairGroup(groups, folder, current, threshold);
      current = [record];
    }
    pushPairGroup(groups, folder, current, threshold);
  }
  return groups;
}

function canJoinPairGroup(record, current, folderPairs, config) {
  if (current.length >= (config.maxBurstSize ?? 5)) return false;
  const anchor = current[0];
  const previous = current[current.length - 1];
  const anchorPair = findPair(folderPairs, anchor.id, record.id);
  const previousPair = findPair(folderPairs, previous.id, record.id);
  if (!anchorPair || !previousPair) return false;
  const threshold = config.similarityThreshold ?? 0.88;
  const anchorFloor = Math.max(0.8, threshold - 0.04);
  const numericSpan = numericGapBetween(anchor.id, record.id);
  if (Number.isFinite(numericSpan) && numericSpan > (config.maxNumericGap ?? 18)) return false;
  return previousPair.similarity >= threshold && anchorPair.similarity >= anchorFloor;
}

function findPair(pairs, leftId, rightId) {
  return pairs.find(pair => (
    (pair.leftId === leftId && pair.rightId === rightId) ||
    (pair.leftId === rightId && pair.rightId === leftId)
  ));
}

function pushPairGroup(groups, folder, current, threshold) {
  if (current.length < 2) return;
  groups.push({
    id: `pair-sim-${threshold}-${folder}-${current[0].id}-${current[current.length - 1].id}`,
    source: 'pair-similarity-compact',
    photoIds: current.map(record => record.id),
  });
}

function splitIntoCompactChunks(ids, records, maxSize) {
  if (ids.length <= maxSize) return [ids];
  const byId = new Map(records.map(record => [record.id, record]));
  const sorted = [...ids].sort((left, right) => comparePhotoOrder(byId.get(left), byId.get(right)));
  const chunks = [];
  for (let index = 0; index < sorted.length; index += maxSize) {
    chunks.push(sorted.slice(index, index + maxSize));
  }
  return chunks;
}

function pushBurstGroup(groups, folder, current, burstRadius) {
  if (current.length < 2) return;
  groups.push({
    id: `burst-${folder}-${current[0].id}-${current[current.length - 1].id}-r${burstRadius}`,
    source: 'inferred-adjacent-burst',
    photoIds: current.map(record => record.id),
  });
}

function isUsable(record, gateMode) {
  if (record.status !== 'DONE') return false;
  if ((record.hardIssueCodes ?? []).length > 0) return false;
  if (hasFocusFail(record)) return false;
  if ((record.exclusionReasons ?? []).includes('FOCUS_FAIL')) return false;
  if (gateMode === 'strict' && (record.issueCodes ?? []).length > 0) return false;
  if ((record.overall ?? 0) < 38) return false;
  if ((record.technical ?? 0) < 20) return false;
  return true;
}

function hasFocusFail(record) {
  const hard = record.hardIssueCodes ?? [];
  const issues = record.issueCodes ?? [];
  if (hard.includes('OUT_OF_FOCUS') || issues.includes('ISSUE:OUT_OF_FOCUS')) return true;
  const focusTexture = record.focusTexture ?? 100;
  const focusPeak = record.focusPeakTexture ?? 100;
  const reliability = record.focusReliability ?? (record.focusReliable === false ? 0.38 : 1);
  return focusTexture < 30 && focusPeak < 38 && reliability < 0.42;
}

function topByRank(records, rankMode) {
  return [...records].sort((left, right) => rank(right, rankMode) - rank(left, rankMode) || comparePhotoOrder(left, right))[0];
}

function rank(record, rankMode) {
  const overall = record.overall ?? 0;
  const technical = record.technical ?? 0;
  const aesthetic = record.aesthetic ?? 0;
  const scene = record.scene ?? 0;
  const focusTexture = record.focusTexture ?? 0;
  const focusPeak = record.focusPeakTexture ?? 0;
  const focusReliability = record.focusReliability ?? 0.5;
  const reviewPenalty = (record.reviewHintCodes ?? []).length * 4;
  const focusBase = Math.max(focusTexture, focusPeak);
  const musiq = record.musiqScore ?? aesthetic;
  const clip = record.clipScore ?? aesthetic;
  if (rankMode === 'technical-first') {
    return technical * 0.95 + overall * 0.62 + scene * 0.18 + Math.min(focusBase, 70) * 0.24 + focusReliability * 8 - reviewPenalty;
  }
  if (rankMode === 'musiq-assisted') {
    return overall * 0.88 + technical * 0.46 + scene * 0.18 + musiq * 0.36 + focusReliability * 5 - reviewPenalty;
  }
  if (rankMode === 'clip-assisted') {
    return overall * 0.82 + technical * 0.42 + scene * 0.24 + clip * 0.42 + focusReliability * 5 - reviewPenalty;
  }
  if (rankMode === 'fused-technical') {
    return overall * 0.72 + technical * 0.62 + scene * 0.18 + aesthetic * 0.18 + Math.min(focusBase, 65) * 0.22 + focusReliability * 6 - reviewPenalty;
  }
  if (rankMode === 'ratio-precision') {
    return technical * 1.08 + overall * 0.58 + scene * 0.16 + aesthetic * 0.08 + Math.min(focusBase, 75) * 0.3 + focusReliability * 9 - reviewPenalty * 1.35;
  }
  if (rankMode === 'ratio-balanced') {
    return technical * 0.82 + overall * 0.72 + scene * 0.28 + aesthetic * 0.16 + Math.min(focusBase, 70) * 0.24 + focusReliability * 7 - reviewPenalty * 1.1;
  }
  if (rankMode === 'ratio-recall') {
    return overall * 0.82 + technical * 0.58 + scene * 0.34 + aesthetic * 0.24 + Math.min(focusBase, 65) * 0.18 + focusReliability * 5 - reviewPenalty * 0.85;
  }
  if (rankMode === 'positive-rescue') {
    const stableGoodPhotoBonus = (
      technical >= 58 &&
      scene >= 70 &&
      overall >= 58 &&
      focusReliability >= 0.48
    ) ? 18 : 0;
    const scenicRescueBonus = (
      scene >= 78 &&
      aesthetic >= 70 &&
      technical >= 42 &&
      focusReliability >= 0.42
    ) ? 12 : 0;
    return overall * 0.7 + technical * 0.58 + scene * 0.42 + aesthetic * 0.22 + Math.min(focusBase, 70) * 0.18 + focusReliability * 6 + stableGoodPhotoBonus + scenicRescueBonus - reviewPenalty;
  }
  if (rankMode === 'scene-rescue') {
    const lowTechScenicBonus = (
      scene >= 78 &&
      aesthetic >= 72 &&
      overall >= 62 &&
      technical >= 28 &&
      focusReliability >= 0.44
    ) ? 24 : 0;
    const documentaryKeepBonus = (
      scene >= 82 &&
      aesthetic >= 70 &&
      overall >= 64 &&
      focusReliability >= 0.5
    ) ? 12 : 0;
    return overall * 0.78 + technical * 0.26 + scene * 0.72 + aesthetic * 0.38 + Math.min(focusBase, 58) * 0.1 + focusReliability * 5 + lowTechScenicBonus + documentaryKeepBonus - reviewPenalty * 0.85;
  }
  if (rankMode === 'scene-aesthetic') {
    return overall * 0.68 + technical * 0.34 + scene * 0.78 + aesthetic * 0.48 + Math.min(focusBase, 62) * 0.12 + focusReliability * 4.5 - reviewPenalty * 0.9;
  }
  if (rankMode === 'pro-persona') {
    const persona = record.baselineProPersonaScore ?? record.proPersonaScore ?? 0.5;
    const nativeAesthetic = (record.baselineProAesthetic ?? record.proAesthetic ?? (aesthetic / 100)) * 100;
    const personaBonus = persona >= 0.62 ? 18 : persona >= 0.56 ? 8 : 0;
    return overall * 0.56 + technical * 0.28 + scene * 0.34 + nativeAesthetic * 0.14 + persona * 42 + focusReliability * 4.5 + personaBonus - reviewPenalty;
  }
  if (rankMode === 'pro-persona-scene') {
    const persona = record.baselineProPersonaScore ?? record.proPersonaScore ?? 0.5;
    const nativeAesthetic = (record.baselineProAesthetic ?? record.proAesthetic ?? (aesthetic / 100)) * 100;
    const sceneConfidence = (record.baselineProSceneConfidence ?? record.proSceneConfidence ?? 0.5) * 100;
    const scenicPersonaRescue = (
      scene >= 76 &&
      persona >= 0.58 &&
      technical >= 26 &&
      focusReliability >= 0.42
    ) ? 16 : 0;
    return overall * 0.54 + technical * 0.22 + scene * 0.46 + nativeAesthetic * 0.16 + persona * 46 + sceneConfidence * 0.08 + focusReliability * 4.5 + scenicPersonaRescue - reviewPenalty * 0.9;
  }
  if (rankMode === 'pro-fused') {
    const persona = record.baselineProPersonaScore ?? record.proPersonaScore ?? 0.5;
    const nativeAesthetic = (record.baselineProAesthetic ?? record.proAesthetic ?? (aesthetic / 100)) * 100;
    const clipAssist = record.clipScore ?? aesthetic;
    return overall * 0.58 + technical * 0.34 + scene * 0.3 + nativeAesthetic * 0.12 + clipAssist * 0.1 + persona * 40 + focusReliability * 5 - reviewPenalty;
  }
  if (rankMode === 'pro-semantic-v2-persona-only') {
    const persona = record.proPersonaScore ?? 0.5;
    const nativeAesthetic = (record.proAesthetic ?? (aesthetic / 100)) * 100;
    return overall * 0.54 + technical * 0.28 + scene * 0.24 + nativeAesthetic * 0.14 + persona * 46 + focusReliability * 4.5 - reviewPenalty;
  }
  if (rankMode === 'pro-semantic-v2-flash-persona') {
    const persona = record.proPersonaScore ?? 0.5;
    const nativeAesthetic = (record.proAesthetic ?? (aesthetic / 100)) * 100;
    // Attribution-only rank mode: keep the Flash/current ranking spine and add the same v14 persona signal.
    // This isolates implementation/rank-profile delta from the semantic student score source.
    return overall * 1.2 + technical * 0.25 + scene * 0.12 + nativeAesthetic * 0.14 + persona * 46 + focusReliability * 3 - reviewPenalty;
  }
  if (rankMode === 'pro-semantic-v2-semantic-only' || rankMode === 'pro-semantic-v2-flat-scalar') {
    const keep = record.proSemanticKeepScore ?? 0.5;
    const composition = record.proCompositionScore ?? 0.5;
    const moment = record.proMomentScore ?? 0.5;
    const lighting = record.proLightingMoodScore ?? 0.5;
    const falseFaceRisk = record.proFalseFaceRisk ?? 0;
    const semanticScore = keep * 52 + composition * 12 + moment * 11 + lighting * 9;
    const scenicRescue = scene >= 74 && keep >= 0.58 && technical >= 24 && focusReliability >= 0.38 ? 14 : 0;
    return overall * 0.44 + technical * 0.24 + scene * 0.18 + semanticScore + focusReliability * 4 + scenicRescue - falseFaceRisk * 18 - reviewPenalty;
  }
  if (rankMode === 'pro-semantic-v2-fused') {
    const persona = record.proPersonaScore ?? 0.5;
    const nativeAesthetic = (record.proAesthetic ?? (aesthetic / 100)) * 100;
    const keep = record.proSemanticKeepScore ?? 0.5;
    const composition = record.proCompositionScore ?? 0.5;
    const moment = record.proMomentScore ?? 0.5;
    const lighting = record.proLightingMoodScore ?? 0.5;
    const falseFaceRisk = record.proFalseFaceRisk ?? 0;
    const faceValidity = record.proFaceValidityScore ?? 0.5;
    const semanticScore = keep * 36 + composition * 9 + moment * 9 + lighting * 7;
    const faceGuardPenalty = falseFaceRisk >= 0.62 && faceValidity <= 0.38 ? 22 : falseFaceRisk * 10;
    return overall * 0.5 + technical * 0.26 + scene * 0.28 + nativeAesthetic * 0.1 + persona * 24 + semanticScore + focusReliability * 4.5 - faceGuardPenalty - reviewPenalty;
  }
  if (rankMode === 'pro-semantic-v2-face-guard') {
    const persona = record.proPersonaScore ?? 0.5;
    const nativeAesthetic = (record.proAesthetic ?? (aesthetic / 100)) * 100;
    const keep = record.proSemanticKeepScore ?? 0.5;
    const composition = record.proCompositionScore ?? 0.5;
    const moment = record.proMomentScore ?? 0.5;
    const lighting = record.proLightingMoodScore ?? 0.5;
    const falseFaceRisk = record.proFalseFaceRisk ?? 0;
    const faceValidity = record.proFaceValidityScore ?? 0.5;
    const semanticScore = keep * 36 + composition * 9 + moment * 9 + lighting * 7;
    const faceGuardPenalty = falseFaceRisk >= 0.62 && faceValidity <= 0.38 ? 22 : falseFaceRisk * 10;
    const base = overall * 0.5 + technical * 0.26 + scene * 0.28 + nativeAesthetic * 0.1 + persona * 24 + semanticScore + focusReliability * 4.5 - faceGuardPenalty - reviewPenalty;
    const extraPenalty = falseFaceRisk >= 0.5 && faceValidity <= 0.45 ? 28 : falseFaceRisk * 8;
    return base - extraPenalty;
  }
  return overall * 1.2 + technical * 0.25 + scene * 0.12 + focusReliability * 3 - reviewPenalty;
}

function computeMetrics(records, pickedIds, groups, config, pairSimilarityMap = new Map()) {
  const labeled = records.filter(record => record.labeledForEval);
  const positives = labeled.filter(record => record.positive);
  const negatives = labeled.filter(record => record.negative);
  const picked = records.filter(record => pickedIds.has(record.id));
  const pickedPositive = positives.filter(record => pickedIds.has(record.id));
  const pickedNegative = negatives.filter(record => pickedIds.has(record.id));
  const pickedLabeled = labeled.filter(record => pickedIds.has(record.id));
  const groupStats = groupedMetrics(records, pickedIds, groups);
  const formalGroupStats = groupedMetrics(records, pickedIds, groups.filter(group => group.source !== 'inferred-adjacent-burst'));
  return {
    family: config.family,
    ratio: config.ratio ?? null,
    rankMode: config.rankMode,
    gateMode: config.gateMode,
    groupMode: config.groupMode ?? null,
    burstRadius: config.burstRadius ?? null,
    similarityThreshold: config.similarityThreshold ?? null,
    target: config.ratio ? Math.ceil(records.filter(record => isUsable(record, config.gateMode)).length * config.ratio) : null,
    picked: picked.length,
    pickedLabeled: pickedLabeled.length,
    truePositive: pickedPositive.length,
    falseNegative: positives.length - pickedPositive.length,
    falsePositive: pickedNegative.length,
    recall: safeRatio(pickedPositive.length, positives.length),
    precisionOnLabeled: safeRatio(pickedPositive.length, pickedLabeled.length),
    negativePickRate: safeRatio(pickedNegative.length, negatives.length),
    picked1Plus: pickedPositive.filter(record => (record.evalRating ?? 0) >= 1).length,
    total1Plus: positives.filter(record => (record.evalRating ?? 0) >= 1).length,
    picked3: pickedPositive.filter(record => record.rating === 3).length,
    total3: positives.filter(record => record.rating === 3).length,
    picked4Plus: pickedPositive.filter(record => (record.evalRating ?? 0) >= 4).length,
    total4Plus: positives.filter(record => (record.evalRating ?? 0) >= 4).length,
    picked4: pickedPositive.filter(record => record.rating === 4).length,
    total4: positives.filter(record => record.rating === 4).length,
    picked5: pickedPositive.filter(record => record.rating === 5).length,
    total5: positives.filter(record => record.rating === 5).length,
    selectedAdjacentPairs: selectedAdjacentPairs(records, pickedIds).length,
    selectedSimilarAdjacentPairs: selectedSimilarAdjacentPairs(records, pickedIds, pairSimilarityMap).length,
    formalDuplicateGroupsWithMultiplePicks: formalGroupStats.groupsWithMultiplePicks,
    formalDuplicateGroupCoverage: formalGroupStats.usableGroupCoverage,
    visualDuplicateGroupsWithMultiplePicks: groupStats.groupsWithMultiplePicks,
    ...groupStats,
  };
}

function groupedMetrics(records, pickedIds, groups) {
  const byId = new Map(records.map(record => [record.id, record]));
  const usableGroups = groups.filter(group => group.photoIds.some(id => {
    const record = byId.get(id);
    return record && isUsable(record, 'hard-only');
  }));
  const positiveGroups = groups.filter(group => group.photoIds.some(id => byId.get(id)?.positive));
  const groupsWithPick = usableGroups.filter(group => group.photoIds.some(id => pickedIds.has(id)));
  const positiveGroupsWithPick = positiveGroups.filter(group => group.photoIds.some(id => pickedIds.has(id)));
  const groupsWithMultiplePicks = groups.filter(group => group.photoIds.filter(id => pickedIds.has(id)).length > 1);
  return {
    groupCount: groups.length,
    usableGroupCount: usableGroups.length,
    usableGroupCoverage: safeRatio(groupsWithPick.length, usableGroups.length),
    positiveGroupCount: positiveGroups.length,
    positiveGroupCoverage: safeRatio(positiveGroupsWithPick.length, positiveGroups.length),
    groupsWithMultiplePicks: groupsWithMultiplePicks.length,
  };
}

function selectedAdjacentPairs(records, pickedIds) {
  const selected = records
    .filter(record => pickedIds.has(record.id) && record.numericId !== null)
    .sort(comparePhotoOrder);
  const pairs = [];
  for (let index = 1; index < selected.length; index += 1) {
    const left = selected[index - 1];
    const right = selected[index];
    if (left.sourceFolder !== right.sourceFolder) continue;
    const gap = Math.abs(right.numericId - left.numericId);
    if (gap > 0 && gap <= 3) pairs.push({ left, right, gap });
  }
  return pairs;
}

function selectedSimilarAdjacentPairs(records, pickedIds, pairSimilarityMap) {
  return selectedAdjacentPairs(records, pickedIds).filter(pair => {
    const similarPair = pairSimilarityMap.get(pairKey(pair.left.id, pair.right.id));
    return similarPair && similarPair.similarity >= SOLO_SUPPRESSION_SIMILARITY;
  });
}

function perFolderMetrics(records, pickedIds) {
  const folders = [...new Set(records.map(record => record.sourceFolder))].sort();
  return folders.map(folder => {
    const folderRecords = records.filter(record => record.sourceFolder === folder);
    return {
      folder,
      ...computeBasicLabelMetrics(folderRecords, pickedIds),
    };
  });
}

function perDatasetMetrics(records, pickedIds) {
  const datasets = [...new Set(records.map(record => record.dataset ?? 'unknown'))].sort();
  return datasets.map(dataset => {
    const datasetRecords = records.filter(record => (record.dataset ?? 'unknown') === dataset);
    const first = datasetRecords[0] ?? {};
    return {
      dataset,
      positiveThreshold: first.evalPositiveThreshold ?? '',
      negativeThreshold: first.evalNegativeThreshold ?? '',
      missingAsNegative: Boolean(first.evalMissingAsNegative),
      ...computeBasicLabelMetrics(datasetRecords, pickedIds),
    };
  });
}

function computeBasicLabelMetrics(records, pickedIds) {
  const labeled = records.filter(record => record.labeledForEval);
  const positives = labeled.filter(record => record.positive);
  const negatives = labeled.filter(record => record.negative);
  const picked = records.filter(record => pickedIds.has(record.id));
  const pickedPositive = positives.filter(record => pickedIds.has(record.id));
  const pickedNegative = negatives.filter(record => pickedIds.has(record.id));
  return {
    total: records.length,
    picked: picked.length,
    labeled: labeled.length,
    positives: positives.length,
    negatives: negatives.length,
    truePositive: pickedPositive.length,
    falsePositive: pickedNegative.length,
    recall: safeRatio(pickedPositive.length, positives.length),
    negativePickRate: safeRatio(pickedNegative.length, negatives.length),
  };
}

function chooseBest(results) {
  const candidates = results.filter(result => result.name !== 'current-production-snapshot');
  const baseline = results.find(result => result.name === 'current-production-snapshot');
  const baselineRecall = baseline?.metrics.recall ?? 0;
  const baselinePollution = baseline?.metrics.selectedAdjacentPairs ?? 0;
  const recallSafeCandidates = candidates.filter(result => result.metrics.recall >= baselineRecall - 0.01);
  const pool = recallSafeCandidates.length > 0 ? recallSafeCandidates : candidates;
  const scored = pool.map(result => {
    const metrics = result.metrics;
    const baselineMetrics = baseline?.metrics;
    const targetBonus = metrics.ratio === 0.5 ? 0.02 : metrics.ratio === 0.45 ? 0.01 : 0;
    const modelPenalty = result.config.rankMode === 'musiq-assisted' || result.config.rankMode === 'clip-assisted' ? 0.015 : 0;
    const recallLift = metrics.recall - baselineRecall;
    const pollutionPenalty = Math.max(0, metrics.selectedAdjacentPairs - baselinePollution) / Math.max(1, baselinePollution) * 0.04;
    const similarAdjacentPenalty = Math.max(0, metrics.selectedSimilarAdjacentPairs ?? 0) / Math.max(1, metrics.selectedAdjacentPairs) * 0.03;
    const formalDuplicatePenalty = Math.max(0, metrics.formalDuplicateGroupsWithMultiplePicks) * 0.0025;
    const visualDuplicatePenalty = Math.max(0, metrics.visualDuplicateGroupsWithMultiplePicks) * 0.004;
    const score = (
      metrics.recall * 0.62 +
      Math.max(0, recallLift) * 0.2 +
      metrics.positiveGroupCoverage * 0.12 +
      metrics.usableGroupCoverage * 0.12 +
      (1 - Math.min(1, metrics.negativePickRate)) * 0.08 +
      (1 - normalizedPollution(metrics.selectedAdjacentPairs, baselineMetrics?.selectedAdjacentPairs ?? metrics.selectedAdjacentPairs)) * 0.06 +
      targetBonus -
      modelPenalty -
      pollutionPenalty -
      similarAdjacentPenalty -
      formalDuplicatePenalty -
      visualDuplicatePenalty
    );
    return { result, score };
  }).sort((left, right) => right.score - left.score);
  return scored[0]?.result ?? baseline;
}

function buildRatioAwareReport(records, groupContext, baseline, results, ratioValues, pairSimilarityMap) {
  const ratioRows = [];
  const selectedByRatio = [];
  const falseNegativesByRatio = [];
  const duplicatePollutionByRatio = [];

  for (const ratio of ratioValues) {
    const ratioResults = results
      .filter(result => result.name !== 'current-production-snapshot')
      .filter(result => Number(result.metrics.ratio) === Number(ratio));
    if (ratioResults.length === 0) continue;
    const selected = chooseBestForRatio(ratioResults, baseline, ratio);
    selectedByRatio.push(selected);
    ratioRows.push(...ratioResults);
    falseNegativesByRatio.push(...sampleFalseNegatives(records, selected.pickedIds, selected.config, 80).map(record => ({
      ratio,
      selectedConfig: selected.name,
      ...sampleRecord(record),
    })));
    duplicatePollutionByRatio.push(...sampleDuplicatePollution(records, selected.pickedIds, selected.groups, 100, pairSimilarityMap).map(sample => ({
      ratio,
      selectedConfig: selected.name,
      ...sample,
    })));
  }

  return {
    schema: `${SCHEMA}-ratio-aware`,
    selectedByRatio,
    ratioRows,
    falseNegativesByRatio,
    duplicatePollutionByRatio,
    recommendation: ratioAwareRecommendation(selectedByRatio, baseline, groupContext),
  };
}

function chooseBestForRatio(ratioResults, baseline, ratio) {
  const target = ratioTargets(ratio);
  const lightCandidates = ratioResults.filter(result => !isHeavyRankMode(result.config.rankMode));
  const pool = lightCandidates.length > 0 ? lightCandidates : ratioResults;
  const maxRecall = Math.max(...pool.map(result => result.metrics.recall));
  const recallViable = pool.filter(result => result.metrics.recall >= maxRecall - target.recallTolerance);
  const finalPool = recallViable.length > 0 ? recallViable : pool;
  const scored = finalPool.map(result => {
    const metrics = result.metrics;
    const heavyModelPenalty = isHeavyRankMode(result.config.rankMode) ? 0.08 : 0;
    const duplicatePenalty = metrics.formalDuplicateGroupsWithMultiplePicks * 0.02 + metrics.visualDuplicateGroupsWithMultiplePicks * 0.02;
    const similarPenalty = Math.min(0.08, (metrics.selectedSimilarAdjacentPairs ?? 0) / Math.max(1, metrics.picked) * target.similarWeight);
    const negativePenalty = Math.min(0.1, metrics.negativePickRate * target.negativeWeight);
    const groupCoverageBonus = metrics.positiveGroupCoverage * target.groupWeight;
    const recallBonus = metrics.recall * target.recallWeight;
    const precisionBonus = metrics.precisionOnLabeled * target.precisionWeight;
    const targetRecallBonus = metrics.recall >= target.recallGoal ? 0.03 : 0;
    const lowRatioPreference = ratio <= 0.45 && result.family === 'strict-dedupe-low-ratio' ? 0.012 : 0;
    const score = recallBonus + precisionBonus + groupCoverageBonus + targetRecallBonus + lowRatioPreference -
      heavyModelPenalty - duplicatePenalty - similarPenalty - negativePenalty;
    return { result, score };
  }).sort((left, right) => (
    right.score - left.score ||
    right.result.metrics.recall - left.result.metrics.recall ||
    left.result.metrics.selectedSimilarAdjacentPairs - right.result.metrics.selectedSimilarAdjacentPairs
  ));
  return scored[0]?.result ?? ratioResults[0] ?? baseline;
}

function isHeavyRankMode(rankMode) {
  return rankMode === 'musiq-assisted' || rankMode === 'clip-assisted';
}

function ratioTargets(ratio) {
  if (ratio <= 0.38) {
    return {
      recallGoal: 0.5,
      recallTolerance: 0.01,
      recallWeight: 0.78,
      precisionWeight: 0.1,
      groupWeight: 0.08,
      similarWeight: 2.2,
      negativeWeight: 0.08,
    };
  }
  if (ratio <= 0.45) {
    return {
      recallGoal: 0.56,
      recallTolerance: 0.01,
      recallWeight: 0.8,
      precisionWeight: 0.08,
      groupWeight: 0.08,
      similarWeight: 1.9,
      negativeWeight: 0.07,
    };
  }
  if (ratio <= 0.5) {
    return {
      recallGoal: 0.62,
      recallTolerance: 0.008,
      recallWeight: 0.82,
      precisionWeight: 0.06,
      groupWeight: 0.08,
      similarWeight: 1.6,
      negativeWeight: 0.06,
    };
  }
  return {
    recallGoal: 0.68,
    recallTolerance: 0.008,
    recallWeight: 0.82,
    precisionWeight: 0.05,
    groupWeight: 0.08,
    similarWeight: 1.3,
    negativeWeight: 0.05,
  };
}

function ratioAwareRecommendation(selectedByRatio, baseline) {
  return {
    useRatioProfiles: true,
    defaultHeavyModels: false,
    baselineRecall: baseline.metrics.recall,
    profiles: selectedByRatio.map(result => ({
      ratio: result.metrics.ratio,
      name: result.name,
      family: result.family,
      recall: result.metrics.recall,
      picked: result.metrics.picked,
      negativePickRate: result.metrics.negativePickRate,
      selectedSimilarAdjacentPairs: result.metrics.selectedSimilarAdjacentPairs,
      formalDuplicateGroupsWithMultiplePicks: result.metrics.formalDuplicateGroupsWithMultiplePicks,
      config: result.config,
    })),
  };
}

function normalizedPollution(value, baselineValue) {
  const denominator = Math.max(1, baselineValue, value);
  return value / denominator;
}

function sampleFalseNegatives(records, pickedIds, config, limit) {
  return records
    .filter(record => record.positive && !pickedIds.has(record.id))
    .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0) || rank(right, config?.rankMode ?? 'current') - rank(left, config?.rankMode ?? 'current'))
    .slice(0, limit);
}

function sampleDuplicatePollution(records, pickedIds, groups, limit, pairSimilarityMap = new Map()) {
  const byId = new Map(records.map(record => [record.id, record]));
  const visualSamples = (groups ?? [])
    .map(group => {
      const picked = group.photoIds.filter(id => pickedIds.has(id));
      if (picked.length < 2) return null;
      const first = byId.get(picked[0]);
      const second = byId.get(picked[1]);
      if (!first || !second) return null;
      return {
        leftId: first.id,
        rightId: second.id,
        folder: first.sourceFolder,
        gap: numericGapBetween(first.id, second.id),
        groupId: group.id,
        groupSource: group.source,
        leftRating: first.rating,
        rightRating: second.rating,
        leftOverall: first.overall,
        rightOverall: second.overall,
        leftTechnical: first.technical,
        rightTechnical: second.technical,
        similarity: pairSimilarityMap.get(pairKey(first.id, second.id))?.similarity,
      };
    })
    .filter(Boolean);
  const adjacentSamples = selectedAdjacentPairs(records, pickedIds).map(pair => ({
    leftId: pair.left.id,
    rightId: pair.right.id,
    folder: pair.left.sourceFolder,
    gap: pair.gap,
    groupId: '',
    groupSource: 'adjacent-file-number',
    leftRating: pair.left.rating,
    rightRating: pair.right.rating,
    leftOverall: pair.left.overall,
    rightOverall: pair.right.overall,
    leftTechnical: pair.left.technical,
    rightTechnical: pair.right.technical,
    similarity: pairSimilarityMap.get(pairKey(pair.left.id, pair.right.id))?.similarity,
  }));
  return [...visualSamples, ...adjacentSamples].slice(0, limit);
}

function buildReport({ auditPath, candidateCsvPath, labelsPath, outputDir, modelLabDir, gpu, records, knownGroups, formalDuplicateGroups, auditCompactGroups, pairSimilarities, baseline, results, selected, falseNegatives, duplicatePollution, ratioAware, mode, labelPolicy }) {
  const top = [...results].sort((left, right) => compareResultQuality(right, left)).slice(0, 12);
  const hasPairSimilarities = pairSimilarities.length > 0;
  const hasCompactGroups = auditCompactGroups.length > 0;
  const json = {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    inputs: { auditPath, candidateCsvPath, labelsPath, outputDir, modelLabDir },
    labelPolicy,
    gpu,
    records: {
      total: records.length,
      labeled: records.filter(record => record.labeledForEval).length,
      positive: records.filter(record => record.positive).length,
      negative: records.filter(record => record.negative).length,
    },
    knownGroups: {
      count: knownGroups.length,
      formalDuplicateCount: formalDuplicateGroups.length,
      auditCompactCount: auditCompactGroups.length,
      pairSimilarityCount: pairSimilarities.length,
      limitation: hasPairSimilarities
        ? 'This run uses audit pair similarities and compact duplicate groups, so it can search perceptual-similarity thresholds without using XMP ratings as ranking input.'
        : 'The audit JSON does not contain pair similarities, so this run tunes representative/fill logic and adjacent burst grouping, not low-level perceptual-hash thresholds.',
    },
    baseline: serializableResult(baseline),
    selected: serializableResult(selected),
    topResults: top.map(serializableResult),
    perFolder: selected.perFolder,
    perDataset: perDatasetMetrics(records, selected.pickedIds),
    falseNegatives: falseNegatives.map(sampleRecord),
    duplicatePollution,
    productionRecommendation: productionRecommendation(selected, baseline),
    ratioAware,
    mode,
  };
  return {
    json,
    summaryMarkdown: summaryMarkdown(json),
  };
}

function compareResultQuality(left, right) {
  return (
    left.metrics.recall - right.metrics.recall ||
    left.metrics.positiveGroupCoverage - right.metrics.positiveGroupCoverage ||
    right.metrics.selectedAdjacentPairs - left.metrics.selectedAdjacentPairs ||
    right.metrics.negativePickRate - left.metrics.negativePickRate
  );
}

function serializableResult(result) {
  return {
    name: result.name,
    family: result.family,
    config: result.config,
    metrics: result.metrics,
    perFolder: result.perFolder,
  };
}

function productionRecommendation(selected, baseline) {
  const recallLift = selected.metrics.recall - baseline.metrics.recall;
  const groupLift = selected.metrics.positiveGroupCoverage - baseline.metrics.positiveGroupCoverage;
  const duplicatePollutionDelta = selected.metrics.selectedAdjacentPairs - baseline.metrics.selectedAdjacentPairs;
  const usesHeavyModel = selected.config?.rankMode === 'musiq-assisted' || selected.config?.rankMode === 'clip-assisted';
  return {
    decision: usesHeavyModel
      ? 'Do not ship as default; keep heavy aesthetic model as optional/lab-assisted unless repeated validation proves the lift is worth package size.'
      : 'Use lightweight rule changes as the first production candidate.',
    recallLift,
    positiveGroupCoverageLift: groupLift,
    duplicatePollutionDelta,
    formalDuplicateMultiPickDelta: selected.metrics.formalDuplicateGroupsWithMultiplePicks - baseline.metrics.formalDuplicateGroupsWithMultiplePicks,
    productionConstants: {
      aiPickTargetRatio: selected.config?.ratio ?? 0.5,
      gateMode: selected.config?.gateMode,
      groupMode: selected.config?.groupMode,
      similarityThreshold: selected.config?.similarityThreshold ?? null,
      maxNumericGap: selected.config?.maxNumericGap ?? null,
      maxTimeGapMs: selected.config?.maxTimeGapMs ?? null,
      burstRadius: selected.config?.burstRadius,
      maxBurstSize: selected.config?.maxBurstSize,
      rankMode: selected.config?.rankMode,
      enableMusiqDefault: false,
      enableClipIqaDefault: false,
    },
    passesPlanGate: recallLift >= -0.005 &&
      (recallLift >= 0.05 || groupLift >= 0.08) &&
      selected.metrics.formalDuplicateGroupsWithMultiplePicks <= baseline.metrics.formalDuplicateGroupsWithMultiplePicks &&
      !usesHeavyModel,
  };
}

function summaryMarkdown(report) {
  const selected = report.selected;
  const baseline = report.baseline;
  const recommendation = report.productionRecommendation;
  return `# FrameCull AI Supervised AI Pick Tuning

- Created: \`${report.createdAt}\`
- Records: \`${report.records.total}\` total, \`${report.records.labeled}\` labeled, \`${report.records.positive}\` positive, \`${report.records.negative}\` negative
- Label policy: ${labelPolicySummary(report.labelPolicy)}
- Selected config: \`${selected.name}\`
- Recommendation: **${recommendation.decision}**

## GPU / Lab Status

- Model lab: \`${report.inputs.modelLabDir}\`
- CUDA available: \`${report.gpu.cudaAvailable}\`
- GPU: \`${report.gpu.gpuName ?? 'unknown'}\`
- Torch: \`${report.gpu.torchVersion ?? 'unknown'}\`
- Fallback reason: \`${report.gpu.fallbackReason ?? 'none'}\`

## Baseline vs Selected

| Config | Picked | Recall | Positive group cov | Negative pick | Adjacent density | Similar adjacent | Formal dup multi-pick |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| \`${baseline.name}\` | ${baseline.metrics.picked} | ${formatPct(baseline.metrics.recall)} | ${formatPct(baseline.metrics.positiveGroupCoverage)} | ${formatPct(baseline.metrics.negativePickRate)} | ${baseline.metrics.selectedAdjacentPairs} | ${baseline.metrics.selectedSimilarAdjacentPairs} | ${baseline.metrics.formalDuplicateGroupsWithMultiplePicks} |
| \`${selected.name}\` | ${selected.metrics.picked} | ${formatPct(selected.metrics.recall)} | ${formatPct(selected.metrics.positiveGroupCoverage)} | ${formatPct(selected.metrics.negativePickRate)} | ${selected.metrics.selectedAdjacentPairs} | ${selected.metrics.selectedSimilarAdjacentPairs} | ${selected.metrics.formalDuplicateGroupsWithMultiplePicks} |

## Top Results

| Config | Family | Ratio | Group | Sim | Rank | Gate | Picked | Recall | Group cov | Neg pick | Visual dup multi-pick |
| --- | --- | ---: | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
${report.topResults.map(result => `| \`${result.name}\` | ${result.family} | ${result.metrics.ratio ?? ''} | ${result.metrics.groupMode ?? ''} | ${result.metrics.similarityThreshold ?? ''} | ${result.metrics.rankMode} | ${result.metrics.gateMode} | ${result.metrics.picked} | ${formatPct(result.metrics.recall)} | ${formatPct(result.metrics.positiveGroupCoverage)} | ${formatPct(result.metrics.negativePickRate)} | ${result.metrics.visualDuplicateGroupsWithMultiplePicks} |`).join('\n')}

${report.ratioAware ? ratioAwareSummaryMarkdown(report.ratioAware) : ''}

## Solo Similarity Suppression

- Similar adjacent threshold: \`${SOLO_SUPPRESSION_SIMILARITY}\`
- Numeric gap: \`${SOLO_SUPPRESSION_NUMERIC_GAP}\`
- Selected similar adjacent pairs: \`${selected.metrics.selectedSimilarAdjacentPairs}\`
- Deferred solo candidates: \`${selected.metrics.soloDeferredCount ?? 0}\`
- Deferred candidates re-added to fill target: \`${selected.metrics.soloReaddedDeferredCount ?? 0}\`

## Per Folder Validation

| Folder | Total | Picked | Positives | Recall | Neg pick |
| --- | ---: | ---: | ---: | ---: | ---: |
${report.perFolder.map(row => `| \`${row.folder}\` | ${row.total} | ${row.picked} | ${row.positives} | ${formatPct(row.recall)} | ${formatPct(row.negativePickRate)} |`).join('\n')}

## Per Dataset Validation

| Dataset | Pos threshold | Neg threshold | Missing | Total | Picked | Positives | Recall | Neg pick |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
${report.perDataset.map(row => `| \`${row.dataset}\` | ${row.positiveThreshold} | ${row.negativeThreshold} | ${row.missingAsNegative ? 'negative' : 'ignored'} | ${row.total} | ${row.picked} | ${row.positives} | ${formatPct(row.recall)} | ${formatPct(row.negativePickRate)} |`).join('\n')}

## Exact Production Changes Suggested

- Default AI Pick ratio candidate: \`${recommendation.productionConstants.aiPickTargetRatio}\`
- Gate mode candidate: \`${recommendation.productionConstants.gateMode}\`
- Group mode candidate: \`${recommendation.productionConstants.groupMode}\`
- Pair similarity threshold candidate: \`${recommendation.productionConstants.similarityThreshold}\`
- Max numeric gap candidate: \`${recommendation.productionConstants.maxNumericGap}\`
- Burst radius candidate: \`${recommendation.productionConstants.burstRadius}\`
- Max burst size candidate: \`${recommendation.productionConstants.maxBurstSize}\`
- Rank mode candidate: \`${recommendation.productionConstants.rankMode}\`
- MUSIQ default: \`false\`
- CLIP-IQA default: \`false\`
- Passes production gate: \`${recommendation.passesPlanGate}\`
- Visual duplicate multi-pick: \`${selected.metrics.visualDuplicateGroupsWithMultiplePicks}\`
- Pair similarities available: \`${report.knownGroups.pairSimilarityCount}\`

## Important Limitation

${report.knownGroups.limitation}

## Failure Samples

- False negatives written to \`false-negatives.csv\`
- Duplicate pollution samples written to \`duplicate-pollution.csv\`
`;
}

function ratioAwareSummaryMarkdown(ratioAware) {
  const bestLightweight = ratioAwareBestByRatio(ratioAware, false);
  const bestAnyModel = ratioAwareBestByRatio(ratioAware, true);
  return `## Ratio-Aware Selected Profiles

| Ratio | Config | Family | Picked | Recall | Neg pick | Similar adjacent | Formal dup multi-pick |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
${ratioAware.selectedByRatio.map(result => `| ${Math.round(result.metrics.ratio * 100)}% | \`${result.name}\` | ${result.family} | ${result.metrics.picked} | ${formatPct(result.metrics.recall)} | ${formatPct(result.metrics.negativePickRate)} | ${result.metrics.selectedSimilarAdjacentPairs} | ${result.metrics.formalDuplicateGroupsWithMultiplePicks} |`).join('\n')}

Recommendation: ${ratioAware.recommendation.useRatioProfiles ? 'use per-ratio lightweight profiles; keep MUSIQ/CLIP as lab-only comparisons.' : 'keep one shared profile.'}

## Best Recall Ceiling By Ratio

| Ratio | Best lightweight | Recall | Best any model | Recall |
| ---: | --- | ---: | --- | ---: |
${bestLightweight.map((light, index) => {
  const any = bestAnyModel[index] ?? light;
  return `| ${Math.round(light.metrics.ratio * 100)}% | \`${light.name}\` | ${formatPct(light.metrics.recall)} | \`${any.name}\` | ${formatPct(any.metrics.recall)} |`;
}).join('\n')}
`;
}

function metricsCsv(results) {
  const headers = [
    'name', 'family', 'ratio', 'rankMode', 'gateMode', 'groupMode', 'similarityThreshold', 'burstRadius', 'picked', 'target',
    'recall', 'precisionOnLabeled', 'negativePickRate', 'positiveGroupCoverage',
    'usableGroupCoverage', 'selectedAdjacentPairs', 'selectedSimilarAdjacentPairs', 'soloDeferredCount', 'soloReaddedDeferredCount', 'groupsWithMultiplePicks',
    'visualDuplicateGroupsWithMultiplePicks', 'formalDuplicateGroupsWithMultiplePicks', 'formalDuplicateGroupCoverage',
    'picked1Plus', 'total1Plus', 'picked4Plus', 'total4Plus', 'picked5', 'total5',
    'truePositive', 'falseNegative', 'falsePositive',
  ];
  return [headers.join(','), ...results.map(result => headers.map(header => csvValue(valueForMetric(result, header))).join(','))].join('\n');
}

function valueForMetric(result, header) {
  if (header in result.metrics) return result.metrics[header];
  if (header in result.config) return result.config[header];
  if (header in result) return result[header];
  return '';
}

function selectedConfigPayload(selected, report) {
  return {
    schema: SCHEMA,
    selected: serializableResult(selected),
    productionRecommendation: report.json.productionRecommendation,
    labelPolicy: report.json.labelPolicy,
    noLabelLeakage: {
      rankingFeatures: RANK_FEATURES,
      note: 'XMP ratings are only used by evaluation metrics and sample reports.',
    },
    heavyModels: {
      musiqDefault: false,
      clipIqaDefault: false,
      reason: 'Candidate models did not meet default-production gates and remain lab/optional only.',
    },
  };
}

function ratioAwareSelectedPayload(ratioAware, report) {
  return {
    schema: ratioAware.schema,
    createdAt: report.json.createdAt,
    recommendation: ratioAware.recommendation,
    labelPolicy: report.json.labelPolicy,
    bestLightweightByRatio: ratioAwareBestByRatio(ratioAware, false).map(serializableResult),
    bestAnyModelByRatio: ratioAwareBestByRatio(ratioAware, true).map(serializableResult),
    selectedByRatio: ratioAware.selectedByRatio.map(serializableResult),
    noLabelLeakage: {
      rankingFeatures: RANK_FEATURES,
      note: 'XMP ratings are only used by evaluation metrics and sample reports.',
    },
    heavyModels: {
      musiqDefault: false,
      clipIqaDefault: false,
      reason: 'MUSIQ and CLIP-IQA remain lab comparisons and are not default app dependencies.',
    },
  };
}

function ratioAwareBestByRatio(ratioAware, allowHeavyModels) {
  const grouped = new Map();
  for (const result of ratioAware.ratioRows) {
    if (!allowHeavyModels && isHeavyRankMode(result.config.rankMode)) continue;
    const ratio = result.metrics.ratio;
    if (!grouped.has(ratio)) grouped.set(ratio, []);
    grouped.get(ratio).push(result);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, results]) => [...results].sort((left, right) => (
      right.metrics.recall - left.metrics.recall ||
      left.metrics.selectedSimilarAdjacentPairs - right.metrics.selectedSimilarAdjacentPairs ||
      left.metrics.negativePickRate - right.metrics.negativePickRate
    ))[0])
    .filter(Boolean);
}

function metricsByRatioCsv(ratioAware) {
  const headers = [
    'ratio', 'selected', 'name', 'family', 'rankMode', 'gateMode', 'groupMode', 'similarityThreshold',
    'picked', 'target', 'recall', 'precisionOnLabeled', 'negativePickRate', 'positiveGroupCoverage',
    'selectedAdjacentPairs', 'selectedSimilarAdjacentPairs', 'visualDuplicateGroupsWithMultiplePicks',
    'formalDuplicateGroupsWithMultiplePicks', 'soloDeferredCount', 'soloReaddedDeferredCount',
  ];
  const selectedNames = new Set(ratioAware.selectedByRatio.map(result => result.name));
  return [headers.join(','), ...ratioAware.ratioRows.map(result => headers.map(header => {
    if (header === 'selected') return selectedNames.has(result.name) ? 'true' : 'false';
    return csvValue(valueForMetric(result, header));
  }).join(','))].join('\n');
}

function recordsByRatioCsv(records) {
  const headers = [
    'ratio', 'selectedConfig', 'id', 'fileName', 'sourceFolder', 'rating', 'overall', 'technical',
    'aesthetic', 'scene', 'focusTexture', 'focusPeakTexture', 'focusReliability', 'musiqScore',
    'clipScore', 'issueCodes', 'exclusionReasons',
  ];
  return [headers.join(','), ...records.map(record => headers.map(header => csvValue(Array.isArray(record[header]) ? record[header].join('|') : record[header])).join(','))].join('\n');
}

function duplicatePollutionByRatioCsv(samples) {
  const headers = ['ratio', 'selectedConfig', 'leftId', 'rightId', 'folder', 'gap', 'similarity', 'groupId', 'groupSource', 'leftRating', 'rightRating', 'leftOverall', 'rightOverall', 'leftTechnical', 'rightTechnical'];
  return [headers.join(','), ...samples.map(sample => headers.map(header => csvValue(sample[header])).join(','))].join('\n');
}

function recordsCsv(records) {
  const headers = [
    'id', 'fileName', 'sourceFolder', 'rating', 'overall', 'technical', 'aesthetic',
    'scene', 'focusTexture', 'focusPeakTexture', 'focusReliability', 'musiqScore',
    'clipScore', 'issueCodes', 'exclusionReasons',
  ];
  return [headers.join(','), ...records.map(record => headers.map(header => csvValue(Array.isArray(record[header]) ? record[header].join('|') : record[header])).join(','))].join('\n');
}

function duplicatePollutionCsv(samples) {
  const headers = ['leftId', 'rightId', 'folder', 'gap', 'similarity', 'groupId', 'groupSource', 'leftRating', 'rightRating', 'leftOverall', 'rightOverall', 'leftTechnical', 'rightTechnical'];
  return [headers.join(','), ...samples.map(sample => headers.map(header => csvValue(sample[header])).join(','))].join('\n');
}

function labelPolicySummary(policy) {
  const fallback = `fallback \`rating >= ${policy.positiveThreshold}\` positive, \`rating <= ${policy.negativeThreshold}\` negative, \`missing => ${policy.missingAsNegative ? 'negative' : 'ignored'}\``;
  const datasetEntries = Object.entries(policy.datasetLabelPolicies ?? {});
  if (datasetEntries.length === 0) return fallback;
  const datasets = datasetEntries.map(([dataset, datasetPolicy]) => {
    const positive = datasetPolicy.positiveThreshold ?? datasetPolicy.positive_threshold ?? policy.positiveThreshold;
    const negative = datasetPolicy.negativeThreshold ?? datasetPolicy.negative_threshold ?? policy.negativeThreshold;
    const missing = datasetPolicy.missingAsNegative ?? datasetPolicy.missing_as_negative ?? policy.missingAsNegative;
    return `\`${dataset}: rating >= ${positive}, rating <= ${negative}, missing => ${missing ? 'negative' : 'ignored'}\``;
  });
  return `${datasets.join('; ')}; ${fallback}`;
}

function sampleRecord(record) {
  return {
    id: record.id,
    fileName: record.fileName,
    sourceFolder: record.sourceFolder,
    rating: record.rating,
    overall: record.overall,
    technical: record.technical,
    aesthetic: record.aesthetic,
    scene: record.scene,
    focusTexture: record.focusTexture,
    focusPeakTexture: record.focusPeakTexture,
    focusReliability: record.focusReliability,
    musiqScore: record.musiqScore,
    clipScore: record.clipScore,
    issueCodes: record.issueCodes,
    exclusionReasons: record.exclusionReasons,
  };
}

function csvValue(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function probeGpu(modelLabDir) {
  const python = path.join(modelLabDir, '.venv', 'Scripts', 'python.exe');
  if (!existsSync(python)) {
    return {
      cudaAvailable: false,
      gpuName: null,
      torchVersion: null,
      fallbackReason: `Missing Python venv at ${python}`,
    };
  }
  const code = [
    'import json',
    'try:',
    ' import torch',
    ' data={"torchVersion":torch.__version__,"cudaAvailable":bool(torch.cuda.is_available()),"gpuName":torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,"cudaVersion":getattr(torch.version,"cuda",None),"deviceCount":torch.cuda.device_count() if torch.cuda.is_available() else 0}',
    ' if torch.cuda.is_available():',
    '  torch.cuda.reset_peak_memory_stats()',
    '  x=torch.zeros((256,256),device="cuda")',
    '  y=x @ x',
    '  torch.cuda.synchronize()',
    '  data["peakCudaAllocatedBytes"]=int(torch.cuda.max_memory_allocated())',
    ' print(json.dumps(data))',
    'except Exception as exc:',
    ' print(json.dumps({"cudaAvailable":False,"fallbackReason":str(exc)}))',
  ].join('\n');
  const result = spawnSync(python, ['-c', code], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FRAMECULL_MODEL_LAB_DIR: modelLabDir,
      HF_HOME: path.join(modelLabDir, 'cache', 'huggingface'),
      HUGGINGFACE_HUB_CACHE: path.join(modelLabDir, 'cache', 'huggingface', 'hub'),
      TRANSFORMERS_CACHE: path.join(modelLabDir, 'cache', 'huggingface', 'transformers'),
      TORCH_HOME: path.join(modelLabDir, 'cache', 'torch'),
      XDG_CACHE_HOME: path.join(modelLabDir, 'cache', 'xdg'),
      PIP_CACHE_DIR: path.join(modelLabDir, 'cache', 'pip'),
      PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
    },
  });
  if (result.status !== 0) {
    return {
      cudaAvailable: false,
      gpuName: null,
      torchVersion: null,
      fallbackReason: result.stderr || result.stdout || `python exited with ${result.status}`,
    };
  }
  try {
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  } catch (error) {
    return {
      cudaAvailable: false,
      gpuName: null,
      torchVersion: null,
      fallbackReason: `Unable to parse GPU probe output: ${error.message}`,
    };
  }
}

function assertNoLabelLeakage() {
  const forbidden = ['rating', 'groundTruth', 'positive', 'negative', 'label'];
  const leaked = RANK_FEATURES.filter(feature => forbidden.some(word => feature.toLowerCase().includes(word.toLowerCase())));
  if (leaked.length > 0) {
    throw new Error(`Ranking feature list leaks labels: ${leaked.join(', ')}`);
  }
}

function comparePhotoOrder(left, right) {
  const folder = String(left.sourceFolder).localeCompare(String(right.sourceFolder), undefined, { numeric: true });
  if (folder !== 0) return folder;
  return (left.numericId ?? Number.MAX_SAFE_INTEGER) - (right.numericId ?? Number.MAX_SAFE_INTEGER) ||
    String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
}

function trailingNumber(value) {
  const match = String(value ?? '').match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

function numericGapBetween(left, right) {
  const leftNumber = trailingNumber(left);
  const rightNumber = trailingNumber(right);
  if (leftNumber === null || rightNumber === null) return Number.POSITIVE_INFINITY;
  return Math.abs(leftNumber - rightNumber);
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function formatPct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}
