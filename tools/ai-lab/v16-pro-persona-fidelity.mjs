import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const DEFAULT_AUDIT = path.resolve('output/ai-bench/pro-semantic-student-bench-smoke/ai-culling-bench-pro-semantic.json');
const DEFAULT_OUTPUT = path.resolve('output/recall-productize/v16b-persona-only');
const DEFAULT_RANK_MODE = 'pro-semantic-v2-persona-only';
const RATIOS = [0.38, 0.45, 0.5, 0.6];
const SOLO_SUPPRESSION_SIMILARITY = 0.82;
const SUPPORTED_RANK_MODES = new Set([
  'pro-semantic-v2-flash-persona',
  'pro-semantic-v2-persona-only',
]);

const args = parseArgs(process.argv.slice(2));
const auditPath = path.resolve(args.audit ?? DEFAULT_AUDIT);
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT);
const ratios = String(args.ratios ?? RATIOS.join(',')).split(',').map(Number).filter(Number.isFinite);
const rankMode = String(args.rankMode ?? DEFAULT_RANK_MODE);

if (!SUPPORTED_RANK_MODES.has(rankMode)) {
  throw new Error(`Unsupported --rank-mode ${rankMode}. Supported: ${[...SUPPORTED_RANK_MODES].join(', ')}`);
}

await mkdir(outputDir, { recursive: true });

const audit = JSON.parse(await readFile(auditPath, 'utf8'));
const records = buildRecords(audit.photoSummaries ?? []);
const formalDuplicateGroups = buildFormalDuplicateGroups(records);
const knownGroups = buildKnownDuplicateGroups(audit.duplicateStats?.supervisedGroups ?? [], records);
const pairSimilarities = normalizePairSimilarities(audit.pairSimilarities ?? [], records);
const labGroupContext = {
  knownGroups: dedupeGroups(records, [...formalDuplicateGroups, ...knownGroups]),
  pairSimilarities,
  pairSimilarityMap: buildPairSimilarityMap(pairSimilarities),
};
const productionPhotos = records.map(record => toProductionPhoto(record));
const productionDuplicateGroups = labGroupContext.knownGroups.map(group => ({
  id: group.id,
  photoIds: group.photoIds,
  similarity: 1,
  sensitivity: 'standard',
  createdAt: 1,
  matches: [],
}));

const vite = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: {
    entries: [],
    noDiscovery: true,
  },
  server: { middlewareMode: true },
});

let productionModule;
try {
  productionModule = await vite.ssrLoadModule('/src/utils/proPersonaRanking.ts');
} finally {
  await vite.close();
}

const rows = [];
for (const ratio of ratios) {
  const config = configForRatio(ratio, rankMode);
  const lab = evaluateLabConfig(records, labGroupContext, config);
  const productionPicked = productionModule.buildProPersonaPickedPhotoIds(
    productionPhotos,
    ratio,
    productionDuplicateGroups,
    {
      settings: {
        enabled: true,
        rankMode: config.rankMode,
      },
      pairSimilarities,
    },
  );
  const comparison = compareSets(lab.pickedIds, productionPicked);
  rows.push({
    ratio,
    config,
    lab: {
      picked: lab.pickedIds.size,
      target: lab.target,
      groupCount: lab.groups.length,
      soloDeferredCount: lab.soloDeferredCount,
      soloReaddedDeferredCount: lab.soloReaddedDeferredCount,
      metrics: computeMetrics(records, lab.pickedIds, {
        groups: lab.groups,
        knownGroups: labGroupContext.knownGroups,
        pairSimilarityMap: labGroupContext.pairSimilarityMap,
      }),
      sceneBuckets: computeSceneBucketMetrics(records, lab.pickedIds),
    },
    production: {
      picked: productionPicked.size,
      metrics: computeMetrics(records, productionPicked, {
        groups: lab.groups,
        knownGroups: labGroupContext.knownGroups,
        pairSimilarityMap: labGroupContext.pairSimilarityMap,
      }),
      sceneBuckets: computeSceneBucketMetrics(records, productionPicked),
    },
    ...comparison,
  });
}

const pass = rows.every(row => row.jaccard === 1 || row.diffRate < 0.005);
const payload = {
  schema: 'framecull-v16-pro-persona-fidelity',
  createdAt: new Date().toISOString(),
  auditPath,
  rankMode,
  recordCount: records.length,
  pairSimilarityCount: pairSimilarities.length,
  formalDuplicateGroupCount: formalDuplicateGroups.length,
  knownGroupCount: labGroupContext.knownGroups.length,
  pass,
  rows,
};

await writeFile(path.join(outputDir, 'fidelity-check.json'), JSON.stringify(payload, null, 2), 'utf8');
await writeFile(path.join(outputDir, 'fidelity-report.md'), buildMarkdown(payload), 'utf8');

console.log(`v16 fidelity ${pass ? 'PASS' : 'FAIL'} (${rankMode}): ${path.join(outputDir, 'fidelity-report.md')}`);
if (!pass) process.exitCode = 1;

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

function buildRecords(photoSummaries) {
  return photoSummaries.map(summary => ({
    ...summary,
    sourceFolder: sourceFolder(summary.sourceName || summary.fileName || summary.id),
    numericId: trailingNumber(summary.id),
  })).sort(comparePhotoOrder);
}

function toProductionPhoto(record) {
  const hardIssueCodes = new Set(record.hardIssueCodes ?? []);
  const reviewHintCodes = new Set(record.reviewHintCodes ?? []);
  if ((record.exclusionReasons ?? []).includes('FOCUS_FAIL')) hardIssueCodes.add('OUT_OF_FOCUS');
  const issues = [
    ...[...hardIssueCodes].map(code => issue(String(code).replace(/^ISSUE:/, ''), 'ISSUE')),
    ...[...reviewHintCodes].map(code => issue(String(code).replace(/^REVIEW:/, ''), 'REVIEW_HINT')),
  ];
  const sourceName = record.sourceName || record.fileName || `${record.id}.jpg`;
  return {
    id: record.id,
    status: 'COMPLETE',
    selection: 'UNMARKED',
    rating: 0,
    jpg: {
      name: record.fileName || `${record.id}.jpg`,
      extension: 'JPG',
      file: null,
      previewUrl: `asset://${record.id}`,
      size: 1,
      modifiedMs: 1_710_000_000_000 + ((record.numericId ?? 0) * 1000),
      path: sourceName,
    },
    ai: {
      status: record.status,
      issues,
      confidence: 1,
      preset: 'standard',
      reviewed: false,
      modelVersion: 'v16-fidelity',
      metrics: {
        focusTextureScore: numberOr(record.focusTexture, 100),
        focusPeakTextureScore: numberOr(record.focusPeakTexture, 100),
        focusReliabilityScore: numberOr(record.focusReliability, record.focusReliable === false ? 0.38 : 0.5),
        focusReliable: record.focusReliable,
        tenengrad: numberOr(record.tenengrad, 100),
      },
      duplicateSignature: record.duplicateSignature,
      photoScore: {
        version: 'v16-fidelity',
        overall: numberOr(record.overall, 0),
        grade: record.grade || 'REVIEW',
        summary: 'v16 fidelity record',
        components: [
          { key: 'TECHNICAL_QUALITY', label: 'Technical', score: numberOr(record.technical, 0), weight: 35 },
          { key: 'AESTHETIC_QUALITY', label: 'Aesthetic', score: numberOr(record.aesthetic, 0), weight: 25 },
          { key: 'SCENE_FIT', label: 'Scene', score: numberOr(record.scene, 0), weight: 15 },
          { key: 'EXPOSURE_LATITUDE', label: 'Exposure', score: numberOr(record.exposure, 0), weight: 15 },
          { key: 'AI_RISK', label: 'Risk', score: issues.some(item => item.level === 'ISSUE') ? 30 : 100, weight: 10 },
        ],
        gates: {
          aiPickedEligible: true,
          technicalPass: true,
          duplicateBestPass: true,
          reasons: [],
        },
      },
      proScores: {
        aesthetic: numberOr(record.proAesthetic, undefined),
        personaScore: numberOr(record.proPersonaScore, undefined),
        sceneLabel: record.proSceneLabel,
        sceneConfidence: numberOr(record.proSceneConfidence, undefined),
        semanticKeepScore: numberOr(record.proSemanticKeepScore, undefined),
        faceValidityScore: numberOr(record.proFaceValidityScore, undefined),
        compositionScore: numberOr(record.proCompositionScore, undefined),
        momentScore: numberOr(record.proMomentScore, undefined),
        lightingMoodScore: numberOr(record.proLightingMoodScore, undefined),
      },
    },
  };
}

function issue(code, level) {
  return {
    code,
    level,
    confidence: 1,
    score: 0,
    threshold: 0,
    message: code,
  };
}

function configForRatio(ratio, rankMode) {
  if (ratio < 0.5) {
    return {
      ratio,
      rankMode,
      gateMode: 'hard-only',
      groupMode: 'known',
      maxBurstSize: 5,
    };
  }
  return {
    ratio,
    rankMode,
    gateMode: 'hard-only',
    groupMode: 'pair-threshold',
    maxBurstSize: 4,
    similarityThreshold: 0.92,
    maxNumericGap: 12,
    maxTimeGapMs: 480000,
    requireCandidate: false,
  };
}

function evaluateLabConfig(records, groupContext, config) {
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
      .map(id => byId.get(id))
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
    if (isRedundantSoloRecord(record, selected, byId, groupContext.pairSimilarityMap)) {
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

  return { pickedIds: selected, target, groups, soloDeferredCount, soloReaddedDeferredCount };
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
  return groups;
}

function buildSeedGroups(records, groupContext, config) {
  if (config.groupMode === 'pair-threshold') {
    const pairGroups = buildPairSimilarityGroups(records, groupContext.pairSimilarities ?? [], config);
    return pairGroups.length > 0 ? dedupeGroups(records, pairGroups) : dedupeGroups(records, groupContext.knownGroups ?? []);
  }
  return dedupeGroups(records, groupContext.knownGroups ?? []);
}

function buildPairSimilarityGroups(records, pairs, config) {
  const byId = new Map(records.map(record => [record.id, record]));
  const threshold = config.similarityThreshold ?? 0.92;
  const maxNumericGap = config.maxNumericGap ?? 12;
  const maxTimeGapMs = config.maxTimeGapMs ?? 480000;
  const usablePairs = pairs.filter(pair => {
    if (pair.similarity < threshold) return false;
    if (config.requireCandidate && !pair.candidate) return false;
    const numericGap = pair.numericGap ?? numericGapBetween(pair.leftId, pair.rightId);
    const nearbyByName = Number.isFinite(numericGap) && numericGap > 0 && numericGap <= maxNumericGap;
    const nearbyByTime = Number.isFinite(pair.timeGapMs) && pair.timeGapMs <= maxTimeGapMs;
    return nearbyByName || nearbyByTime;
  });

  const byFolder = new Map();
  for (const pair of usablePairs) {
    const left = byId.get(pair.leftId);
    const right = byId.get(pair.rightId);
    if (!left || !right || left.sourceFolder !== right.sourceFolder) continue;
    if (!byFolder.has(left.sourceFolder)) byFolder.set(left.sourceFolder, []);
    byFolder.get(left.sourceFolder).push(pair);
  }

  const groups = [];
  for (const [folder, folderPairs] of byFolder.entries()) {
    const photoIds = new Set(folderPairs.flatMap(pair => [pair.leftId, pair.rightId]));
    const sortedRecords = [...photoIds].map(id => byId.get(id)).filter(Boolean).sort(comparePhotoOrder);
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
  const threshold = config.similarityThreshold ?? 0.92;
  const anchorFloor = Math.max(0.8, threshold - 0.04);
  const numericSpan = numericGapBetween(anchor.id, record.id);
  if (Number.isFinite(numericSpan) && numericSpan > (config.maxNumericGap ?? 12)) return false;
  return previousPair.similarity >= threshold && anchorPair.similarity >= anchorFloor;
}

function isRedundantSoloRecord(record, selectedIds, byId, pairSimilarityMap) {
  if (record.numericId === null) return false;
  for (const selectedId of selectedIds) {
    const selected = byId.get(selectedId);
    if (!selected || selected.sourceFolder !== record.sourceFolder || selected.numericId === null) continue;
    const gap = Math.abs(record.numericId - selected.numericId);
    if (gap <= 0 || gap > 3) continue;
    const pair = pairSimilarityMap.get(pairKey(record.id, selected.id));
    if (pair && pair.similarity >= 0.82) return true;
  }
  return false;
}

function buildKnownDuplicateGroups(supervisedGroups, records) {
  const byId = new Map(records.map(record => [record.id, record]));
  return supervisedGroups
    .map((group, index) => ({
      id: group.id ?? `known-${index + 1}`,
      source: 'audit-supervised-duplicate-group',
      photoIds: (group.photos ?? []).map(photo => photo.id).filter(id => byId.has(id)),
    }))
    .filter(group => group.photoIds.length >= 2);
}

function buildFormalDuplicateGroups(records) {
  const groups = [];
  const byFolder = new Map();
  for (const record of records) {
    if (!record.inDuplicateGroup) continue;
    if (!byFolder.has(record.sourceFolder)) byFolder.set(record.sourceFolder, []);
    byFolder.get(record.sourceFolder).push(record);
  }
  for (const [folder, folderRecords] of byFolder.entries()) {
    const sorted = [...folderRecords].sort(comparePhotoOrder);
    let current = [];
    for (const record of sorted) {
      const previous = current[current.length - 1];
      const gap = previous && previous.numericId !== null && record.numericId !== null
        ? Math.abs(record.numericId - previous.numericId)
        : Number.POSITIVE_INFINITY;
      if (previous && gap > 0 && gap <= 6) current.push(record);
      else {
        pushFormalDuplicateGroup(groups, folder, current);
        current = [record];
      }
    }
    pushFormalDuplicateGroup(groups, folder, current);
  }
  return groups;
}

function pushFormalDuplicateGroup(groups, folder, records) {
  if (records.length < 2) return;
  groups.push({
    id: `formal-duplicate-${folder}-${records[0].id}-${records[records.length - 1].id}`,
    source: 'reconstructed-formal-duplicate',
    photoIds: records.map(record => record.id),
  });
}

function normalizePairSimilarities(pairs, records) {
  const byId = new Set(records.map(record => record.id));
  return pairs
    .map(pair => ({
      leftId: pair.leftId,
      rightId: pair.rightId,
      similarity: Number(pair.similarity),
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
  for (const pair of pairs) map.set(pairKey(pair.leftId, pair.rightId), pair);
  return map;
}

function dedupeGroups(records, groups) {
  const seen = new Set();
  const byId = new Map(records.map(record => [record.id, record]));
  const deduped = [];
  for (const group of groups) {
    const ids = [...new Set(group.photoIds)]
      .filter(id => byId.has(id))
      .sort((left, right) => comparePhotoOrder(byId.get(left), byId.get(right)));
    if (ids.length < 2) continue;
    const key = ids.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...group, photoIds: ids });
  }
  return deduped;
}

function splitIntoCompactChunks(ids, records, maxSize) {
  if (ids.length <= maxSize) return [ids];
  const byId = new Map(records.map(record => [record.id, record]));
  const sorted = [...ids].sort((left, right) => comparePhotoOrder(byId.get(left), byId.get(right)));
  const chunks = [];
  for (let index = 0; index < sorted.length; index += maxSize) chunks.push(sorted.slice(index, index + maxSize));
  return chunks;
}

function topByRank(records, rankMode) {
  return [...records].sort((left, right) => rank(right, rankMode) - rank(left, rankMode) || comparePhotoOrder(left, right))[0];
}

function rank(record, rankMode) {
  const overall = record.overall ?? 0;
  const technical = record.technical ?? 0;
  const aesthetic = record.aesthetic ?? 0;
  const scene = record.scene ?? 0;
  const focusReliability = record.focusReliability ?? 0.5;
  const reviewPenalty = (record.reviewHintCodes ?? []).length * 4;
  const persona = record.proPersonaScore ?? 0.5;
  const nativeAesthetic = (record.proAesthetic ?? (aesthetic / 100)) * 100;
  if (rankMode === 'pro-semantic-v2-persona-only') {
    return overall * 0.54 + technical * 0.28 + scene * 0.24 + nativeAesthetic * 0.14 + persona * 46 + focusReliability * 4.5 - reviewPenalty;
  }
  return overall * 1.2 + technical * 0.25 + scene * 0.12 + nativeAesthetic * 0.14 + persona * 46 + focusReliability * 3 - reviewPenalty;
}

function isUsable(record) {
  if (record.status !== 'DONE') return false;
  if ((record.hardIssueCodes ?? []).length > 0) return false;
  if (hasFocusFail(record)) return false;
  if ((record.exclusionReasons ?? []).includes('FOCUS_FAIL')) return false;
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

function sourceFolder(sourceName) {
  const normalized = String(sourceName || '').replace(/\//g, '\\');
  const match = normalized.match(/(108NZ6_3|109NZ6_3|110NZ6_3|camera-teacher-jpegs|five-mountain-previews-384)/i);
  if (match) return match[1];
  const parts = normalized.split('\\').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
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

function pairKey(leftId, rightId) {
  return [leftId, rightId]
    .sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }))
    .join('::');
}

function compareSets(left, right) {
  const intersection = [...left].filter(id => right.has(id));
  const leftOnly = [...left].filter(id => !right.has(id));
  const rightOnly = [...right].filter(id => !left.has(id));
  const unionSize = new Set([...left, ...right]).size;
  return {
    jaccard: unionSize > 0 ? Number((intersection.length / unionSize).toFixed(6)) : 1,
    diffCount: leftOnly.length + rightOnly.length,
    diffRate: unionSize > 0 ? Number(((leftOnly.length + rightOnly.length) / unionSize).toFixed(6)) : 0,
    labOnlySample: leftOnly.slice(0, 30),
    productionOnlySample: rightOnly.slice(0, 30),
  };
}

function computeMetrics(records, pickedIds, context = {}) {
  const labeled = records.map(record => ({ record, label: labelForRecord(record) }));
  const positives = labeled.filter(item => item.label.positive);
  const negatives = labeled.filter(item => item.label.negative);
  const picked = records.filter(record => pickedIds.has(record.id));
  const pickedPositive = positives.filter(item => pickedIds.has(item.record.id));
  const pickedNegative = negatives.filter(item => pickedIds.has(item.record.id));
  const selectedAdjacent = selectedAdjacentPairs(records, pickedIds);
  const selectedSimilarAdjacent = selectedSimilarAdjacentPairs(records, pickedIds, context.pairSimilarityMap ?? new Map());
  const visualGroupStats = groupedMetrics(records, pickedIds, context.groups ?? []);
  const knownGroupStats = groupedMetrics(records, pickedIds, context.knownGroups ?? []);
  return {
    picked: picked.length,
    positives: positives.length,
    negatives: negatives.length,
    truePositive: pickedPositive.length,
    falsePositive: pickedNegative.length,
    recall: safeRatio(pickedPositive.length, positives.length),
    negativePickRate: safeRatio(pickedNegative.length, negatives.length),
    selectedAdjacentPairs: selectedAdjacent.length,
    selectedSimilarAdjacentPairs: selectedSimilarAdjacent.length,
    visualDuplicateGroupsWithMultiplePicks: visualGroupStats.groupsWithMultiplePicks,
    knownFormalDuplicateGroupsWithMultiplePicks: knownGroupStats.groupsWithMultiplePicks,
    knownFormalDuplicateGroupCoverage: knownGroupStats.usableGroupCoverage,
  };
}

function groupedMetrics(records, pickedIds, groups) {
  const byId = new Map(records.map(record => [record.id, record]));
  const usableGroups = groups.filter(group => group.photoIds.some(id => {
    const record = byId.get(id);
    return record && isUsable(record, 'hard-only');
  }));
  const groupsWithPick = usableGroups.filter(group => group.photoIds.some(id => pickedIds.has(id)));
  const groupsWithMultiplePicks = groups.filter(group => group.photoIds.filter(id => pickedIds.has(id)).length > 1);
  return {
    groupCount: groups.length,
    usableGroupCount: usableGroups.length,
    usableGroupCoverage: safeRatio(groupsWithPick.length, usableGroups.length),
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

function computeSceneBucketMetrics(records, pickedIds) {
  const buckets = new Map();
  for (const record of records) {
    const bucket = sceneBucket(record);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(record);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, bucketRecords]) => ({
      bucket,
      total: bucketRecords.length,
      ...computeMetrics(bucketRecords, pickedIds),
    }));
}

function labelForRecord(record) {
  const dataset = inferDataset(record);
  const rating = Number(record.groundTruthRating ?? 0);
  const positiveThreshold = dataset === 'audit3groups' ? 3 : 1;
  return {
    dataset,
    rating,
    positive: rating >= positiveThreshold,
    negative: rating <= 0,
  };
}

function inferDataset(record) {
  const source = String(record.sourceName || record.sourceFolder || record.fileName || record.id || '').toLowerCase();
  if (source.includes('camera') || source.includes('相机')) return 'camera';
  if (source.includes('five-mountain') || source.includes('五台山')) return 'five_mountain';
  return 'audit3groups';
}

function sceneBucket(record) {
  const label = String(record.proSceneLabel || '').toLowerCase();
  if (label === 'group') return 'group_portrait';
  if (label === 'portrait' || label === 'environmental_portrait') return 'portrait';
  if (label === 'documentary_moment' || label === 'event') return 'documentary_activity';
  if (label === 'landscape' || label === 'empty_scene') return 'scenic_empty';
  if (label === 'product_object' || label === 'food' || label === 'animal') return 'object_other';
  return 'other_unknown';
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildMarkdown(payload) {
  const lines = [
    payload.rankMode === 'pro-semantic-v2-persona-only'
      ? '# v16b Pro Persona-Only Fidelity Report'
      : '# v16 Pro Persona Fidelity Report',
    '',
    `- Audit: \`${payload.auditPath}\``,
    `- Rank mode: \`${payload.rankMode}\``,
    `- Records: \`${payload.recordCount}\``,
    `- Pair similarities: \`${payload.pairSimilarityCount}\``,
    `- Known/formal groups: \`${payload.knownGroupCount}\``,
    `- Verdict: **${payload.pass ? 'PASS' : 'FAIL'}**`,
    '',
    '| Ratio | Lab picked | Production picked | Jaccard | Diff | Diff rate |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    ...payload.rows.map(row => `| ${row.ratio} | ${row.lab.picked} | ${row.production.picked} | ${row.jaccard} | ${row.diffCount} | ${(row.diffRate * 100).toFixed(3)}% |`),
    '',
    '## Notes',
    '',
    '- Production path is loaded from `src/utils/proPersonaRanking.ts` through Vite SSR.',
    '- Lab truth in this runner mirrors `tools/ai-lab/tune-ai-picks-supervised.mjs` for the selected rank profile.',
    '- This check uses fixed student scores from the audit JSON; it does not retrain or re-run inference.',
  ];
  const primaryRows = payload.rows.filter(row => row.ratio === 0.45 || row.ratio === 0.5);
  if (primaryRows.length > 0) {
    lines.push('', '## Primary Ratio Metrics', '');
    lines.push('| Ratio | Recall | Negative pick | True positive | False positive | Similar adjacent | Compact group multi-pick |');
    lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of primaryRows) {
      const metrics = row.production.metrics;
      lines.push(`| ${row.ratio} | ${(metrics.recall * 100).toFixed(2)}% | ${(metrics.negativePickRate * 100).toFixed(2)}% | ${metrics.truePositive} | ${metrics.falsePositive} | ${metrics.selectedSimilarAdjacentPairs} | ${metrics.visualDuplicateGroupsWithMultiplePicks} |`);
    }
    lines.push('', '## Scene Bucket Metrics At 45/50', '');
    lines.push('| Ratio | Bucket | Total | Picked | Recall | Negative pick |');
    lines.push('| ---: | --- | ---: | ---: | ---: | ---: |');
    for (const row of primaryRows) {
      for (const bucket of row.production.sceneBuckets) {
        lines.push(`| ${row.ratio} | ${bucket.bucket} | ${bucket.total} | ${bucket.picked} | ${(bucket.recall * 100).toFixed(2)}% | ${(bucket.negativePickRate * 100).toFixed(2)}% |`);
      }
    }
  }
  const failed = payload.rows.filter(row => row.diffCount > 0);
  if (failed.length > 0) {
    lines.push('', '## Difference Samples', '');
    for (const row of failed) {
      lines.push(`### Ratio ${row.ratio}`, '');
      lines.push(`- Lab only: \`${row.labOnlySample.join('`, `')}\``);
      lines.push(`- Production only: \`${row.productionOnlySample.join('`, `')}\``);
      lines.push('');
    }
  }
  return lines.join('\n');
}
