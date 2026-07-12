import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE = '/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-grounded-v14-five-mountain-region';
const DEFAULT_OUTPUT = '/data/FrameCullModelLab/outputs/semantic-false-face-diagnosis/v15-replay';
const SOLO_SUPPRESSION_SIMILARITY = 0.82;
const SOLO_SUPPRESSION_NUMERIC_GAP = 3;
const GUARD_THRESHOLD = 0.5;
const DOWNWEIGHT_PENALTY = 28;
const HOLDOUT_AUC = 0.7506172839506173;
const HOLDOUT_FPR = 0.36666666666666664;
const HOLDOUT_TPR = 0.8703703703703703;

const args = parseArgs(process.argv.slice(2));
const baseDir = path.resolve(args.base ?? DEFAULT_BASE);
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT);
const auditPath = path.resolve(args.audit ?? path.join(baseDir, 'ai-culling-bench-pro-semantic.json'));
const labelsPath = path.resolve(args.labels ?? path.join(baseDir, 'pro-semantic-eval-labels.json'));
const selectedConfigPath = path.resolve(args.selectedConfigs ?? path.join(baseDir, 'selected-config-by-ratio.json'));
const guardPath = path.resolve(args.guard ?? path.join(outputDir, 'guard-full-scores.json'));

await mkdir(outputDir, { recursive: true });

const audit = await readJson(auditPath);
const labelsManifest = await readJson(labelsPath);
const selectedPayload = await readJson(selectedConfigPath);
const guardPayload = await readJson(guardPath);
const guardById = new Map((guardPayload.results ?? []).map(row => [String(row.photoId), row]));
const labels = labelsManifest.labels ?? labelsManifest.records ?? labelsManifest;
const sourceNames = labelsManifest.sourceNames ?? {};
const records = buildRecords(audit.photoSummaries ?? [], labels, sourceNames, guardById);
const groupContext = buildGroupContext(audit, records);
const baselineConfigs = (selectedPayload.selectedByRatio ?? [])
  .map(item => item.config)
  .filter(config => config && Number.isFinite(Number(config.ratio)))
  .sort((left, right) => Number(left.ratio) - Number(right.ratio));

if (baselineConfigs.length === 0) {
  throw new Error(`No selectedByRatio configs found in ${selectedConfigPath}`);
}

const results = [];
for (const baseConfig of baselineConfigs) {
  const ratio = Number(baseConfig.ratio);
  const baseline = {
    ...baseConfig,
    name: `v15-baseline-pro-persona-r${ratio}`,
    rankModeLabel: 'pro-persona-baseline',
    falseFaceGuardMode: 'none',
    falseFaceGuardThreshold: GUARD_THRESHOLD,
  };
  const exclude = {
    ...baseConfig,
    name: `v15-guard-exclude-r${ratio}`,
    rankModeLabel: 'pro-persona-v15-guard-exclude',
    falseFaceGuardMode: 'exclude',
    falseFaceGuardThreshold: GUARD_THRESHOLD,
  };
  const downweight = {
    ...baseConfig,
    name: `v15-guard-downweight-r${ratio}`,
    rankModeLabel: 'pro-persona-v15-guard-downweight',
    falseFaceGuardMode: 'downweight',
    falseFaceGuardThreshold: GUARD_THRESHOLD,
    falseFaceGuardPenalty: DOWNWEIGHT_PENALTY,
  };
  results.push(evaluateConfig(records, groupContext, baseline));
  results.push(evaluateConfig(records, groupContext, exclude));
  results.push(evaluateConfig(records, groupContext, downweight));
}

const ratioRows = buildRatioRows(results);
const injuryRows = buildFalseInjuryRows(records, results);
const guardTopRows = buildGuardTopRows(records);
const sceneRows = buildSceneRows(records, results);
const gateSampleRows = buildGateSampleRows(records);
const gateSampleSummary = summarizeGateSampleRows(gateSampleRows);
const verdict = buildVerdict(ratioRows);
const summary = buildSummaryMarkdown({
  auditPath,
  labelsPath,
  selectedConfigPath,
  guardPath,
  guardPayload,
  ratioRows,
  sceneRows,
  gateSampleSummary,
  verdict,
});

await writeFile(path.join(outputDir, 'metrics-by-ratio.csv'), csvRows(ratioRows), 'utf8');
await writeFile(path.join(outputDir, 'false-injury-top.csv'), csvRows(injuryRows), 'utf8');
await writeFile(path.join(outputDir, 'guard-triggered-top.csv'), csvRows(guardTopRows), 'utf8');
await writeFile(path.join(outputDir, 'scene-distribution.csv'), csvRows(sceneRows), 'utf8');
await writeFile(path.join(outputDir, 'gate-sample-teacher-proxy.csv'), csvRows(gateSampleRows), 'utf8');
await writeFile(path.join(outputDir, 'false-face-v15-replay-report.md'), summary, 'utf8');
await writeFile(path.join(outputDir, 'replay-summary.json'), JSON.stringify({
  schemaVersion: 'framecull-v15-false-face-guard-replay-v1',
  createdAt: new Date().toISOString(),
  auditPath,
  labelsPath,
  selectedConfigPath,
  guardPath,
  holdout: {
    usedForTrainingTuningOrThresholdFitting: false,
    conditionalAuc: HOLDOUT_AUC,
    tprAt05: HOLDOUT_TPR,
    fprAt05: HOLDOUT_FPR,
    note: 'The 84-image holdout is a suspicious-context conditional check, not full-set performance.',
  },
  fixedGuard: {
    upstreamGate: 'lowThresholdProposal = maxFacePresence >= 0.08',
    risk: 'conflictRisk = upstreamGate ? 1 - reliableFacePresence : 0',
    threshold: GUARD_THRESHOLD,
    downweightPenalty: DOWNWEIGHT_PENALTY,
    thresholdTunedOnThisReplay: false,
  },
  verdict,
  guardSummary: guardPayload.summary,
  gateSampleSummary,
  metrics: ratioRows,
}, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  outputDir,
  verdict,
  rows: ratioRows.length,
  guardSummary: guardPayload.summary,
}, null, 2));

function buildRecords(photoSummaries, labels, sourceNames, guardByIdMap) {
  return photoSummaries.map(summary => {
    const rawLabelValue = labelRating(labels[summary.id]) ?? summary.groundTruthRating;
    const rating = Number.isFinite(Number(rawLabelValue)) ? Number(rawLabelValue) : undefined;
    const sourceName = summary.sourceName || sourceNames[summary.id] || '';
    const dataset = inferDataset(summary, sourceName);
    const policy = labelPolicyForDataset(dataset);
    const evalRating = rating ?? (policy.missingAsNegative ? 0 : undefined);
    const positive = evalRating === undefined ? undefined : evalRating >= policy.positiveThreshold;
    const negative = evalRating === undefined ? undefined : evalRating <= policy.negativeThreshold;
    const guard = guardByIdMap.get(String(summary.id)) ?? {};
    return {
      ...summary,
      dataset,
      sourceName,
      sourceFolder: sourceFolder(sourceName, dataset),
      numericId: trailingNumber(summary.id),
      rating,
      evalRating,
      evalPositiveThreshold: policy.positiveThreshold,
      evalNegativeThreshold: policy.negativeThreshold,
      evalMissingAsNegative: policy.missingAsNegative,
      positive,
      negative,
      labeledForEval: positive === true || negative === true,
      baselinePicked: Boolean(summary.picked),
      proAesthetic: numberOr(summary.proAesthetic, undefined),
      proPersonaScore: numberOr(summary.proPersonaScore, undefined),
      baselineProAesthetic: numberOr(summary.baselineProAesthetic, undefined),
      baselineProPersonaScore: numberOr(summary.baselineProPersonaScore, undefined),
      proSceneLabel: summary.proSceneLabel ?? guard.proSceneLabel,
      proSemanticKeepScore: numberOr(summary.proSemanticKeepScore, undefined),
      proFaceValidityScore: numberOr(summary.proFaceValidityScore, undefined),
      proFalseFaceRisk: numberOr(summary.proFalseFaceRisk, undefined),
      v15MaxFacePresence: numberOr(guard.maxFacePresence, 0),
      v15ReliableFacePresence: numberOr(guard.reliableFacePresence, 0),
      v15SelectedRisk: numberOr(guard.selectedV15Risk, 0),
      v15ConflictRisk: numberOr(guard.conflictRisk, 0),
      v15UpstreamGateTriggered: Boolean(guard.upstreamGateTriggered),
      v15GuardTriggered: Boolean(guard.guardTriggered),
      v15FaceCount: numberOr(guard.faceCount, 0),
      v15ReliableFaceCount: numberOr(guard.reliableFaceCount, 0),
      teacherSceneType: guard.teacherSceneType,
      teacherSubjectType: guard.teacherSubjectType,
      teacherHasRealHumanFace: guard.teacherHasRealHumanFace,
      teacherFalseFaceRisk: numberOr(guard.teacherFalseFaceRisk, undefined),
      teacherFaceRelevant: guard.teacherFaceRelevant,
      v15GuardError: guard.error,
    };
  }).sort(comparePhotoOrder);
}

function labelPolicyForDataset(dataset) {
  if (dataset === 'camera' || dataset === 'five_mountain') {
    return { positiveThreshold: 1, negativeThreshold: 0, missingAsNegative: true };
  }
  return { positiveThreshold: 3, negativeThreshold: 0, missingAsNegative: true };
}

function buildGroupContext(audit, records) {
  const knownGroups = buildKnownDuplicateGroups(audit.duplicateStats?.supervisedGroups ?? [], records);
  const formalDuplicateGroups = buildFormalDuplicateGroups(records);
  const auditCompactGroups = buildAuditCompactDuplicateGroups(audit.compactDuplicateGroups ?? [], records);
  const pairSimilarities = normalizePairSimilarities(audit.pairSimilarities ?? [], records);
  return {
    knownGroups: dedupeGroups([...formalDuplicateGroups, ...knownGroups], records),
    formalDuplicateGroups,
    auditCompactGroups,
    pairSimilarities,
    pairSimilarityMap: buildPairSimilarityMap(pairSimilarities),
  };
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

function dedupeGroups(groups, records) {
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
    deduped.push({ ...group, photoIds: ids });
  }
  return deduped;
}

function evaluateConfig(records, groupContext, config) {
  const usable = records.filter(record => isUsable(record, config));
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
      .filter(record => record && isUsable(record, config));
    const representative = topByRank(candidates, config);
    if (representative) selected.add(representative.id);
  }

  const solos = usable
    .filter(record => !groupedIds.has(record.id))
    .sort((left, right) => rank(right, config) - rank(left, config) || comparePhotoOrder(left, right));
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
  return {
    name: config.name,
    family: config.family,
    config,
    metrics: computeMetrics(records, selected, groups, config, groupContext.pairSimilarityMap, {
      soloDeferredCount,
      soloReaddedDeferredCount,
    }),
    pickedIds: selected,
    groups,
  };
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
  if (!config.useKnownGroups || config.groupMode === 'none') return [];
  if (config.groupMode === 'audit-compact') {
    return dedupeGroups([...(groupContext.auditCompactGroups ?? []), ...(groupContext.knownGroups ?? [])], records);
  }
  if (config.groupMode === 'pair-threshold') {
    const pairGroups = buildPairSimilarityGroups(records, groupContext.pairSimilarities ?? [], config);
    return pairGroups.length > 0 ? dedupeGroups(pairGroups, records) : dedupeGroups(groupContext.auditCompactGroups ?? [], records);
  }
  return dedupeGroups(groupContext.knownGroups ?? [], records);
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

function isUsable(record, config) {
  const gateMode = typeof config === 'string' ? config : config.gateMode;
  if (record.status !== 'DONE') return false;
  if ((record.hardIssueCodes ?? []).length > 0) return false;
  if (hasFocusFail(record)) return false;
  if ((record.exclusionReasons ?? []).includes('FOCUS_FAIL')) return false;
  if (gateMode === 'strict' && (record.issueCodes ?? []).length > 0) return false;
  if ((record.overall ?? 0) < 38) return false;
  if ((record.technical ?? 0) < 20) return false;
  if (typeof config === 'object' && config.falseFaceGuardMode === 'exclude' && isGuardTriggered(record, config)) return false;
  return true;
}

function isGuardTriggered(record, config) {
  const threshold = config.falseFaceGuardThreshold ?? GUARD_THRESHOLD;
  return record.v15UpstreamGateTriggered && record.v15ConflictRisk >= threshold;
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

function topByRank(records, config) {
  return [...records].sort((left, right) => rank(right, config) - rank(left, config) || comparePhotoOrder(left, right))[0];
}

function rank(record, config) {
  const rankMode = config.rankMode;
  const overall = record.overall ?? 0;
  const technical = record.technical ?? 0;
  const aesthetic = record.aesthetic ?? 0;
  const scene = record.scene ?? 0;
  const focusTexture = record.focusTexture ?? 0;
  const focusPeak = record.focusPeakTexture ?? 0;
  const focusReliability = record.focusReliability ?? 0.5;
  const reviewPenalty = (record.reviewHintCodes ?? []).length * 4;
  const focusBase = Math.max(focusTexture, focusPeak);
  let score;
  if (rankMode === 'pro-persona') {
    const persona = record.baselineProPersonaScore ?? record.proPersonaScore ?? 0.5;
    const nativeAesthetic = (record.baselineProAesthetic ?? record.proAesthetic ?? (aesthetic / 100)) * 100;
    const personaBonus = persona >= 0.62 ? 18 : persona >= 0.56 ? 8 : 0;
    score = overall * 0.56 + technical * 0.28 + scene * 0.34 + nativeAesthetic * 0.14 + persona * 42 + focusReliability * 4.5 + personaBonus - reviewPenalty;
  } else {
    score = overall * 1.2 + technical * 0.25 + scene * 0.12 + Math.min(focusBase, 70) * 0.08 + focusReliability * 3 - reviewPenalty;
  }
  if (config.falseFaceGuardMode === 'downweight' && isGuardTriggered(record, config)) {
    score -= (config.falseFaceGuardPenalty ?? DOWNWEIGHT_PENALTY) * Math.max(0.5, record.v15ConflictRisk);
  }
  return score;
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

function computeMetrics(records, pickedIds, groups, config, pairSimilarityMap, extra) {
  const labeled = records.filter(record => record.labeledForEval);
  const positives = labeled.filter(record => record.positive);
  const negatives = labeled.filter(record => record.negative);
  const picked = records.filter(record => pickedIds.has(record.id));
  const pickedPositive = positives.filter(record => pickedIds.has(record.id));
  const pickedNegative = negatives.filter(record => pickedIds.has(record.id));
  const pickedLabeled = labeled.filter(record => pickedIds.has(record.id));
  const guardTriggered = records.filter(record => isGuardTriggered(record, config));
  const pickedGuardTriggered = picked.filter(record => isGuardTriggered(record, config));
  const pickedPositiveGuardTriggered = pickedPositive.filter(record => isGuardTriggered(record, config));
  const groupStats = groupedMetrics(records, pickedIds, groups);
  const formalGroupStats = groupedMetrics(records, pickedIds, groups.filter(group => group.source !== 'inferred-adjacent-burst'));
  return {
    family: config.family,
    ratio: config.ratio ?? null,
    rankMode: config.rankModeLabel ?? config.rankMode,
    baseRankMode: config.rankMode,
    guardMode: config.falseFaceGuardMode ?? 'none',
    gateMode: config.gateMode,
    groupMode: config.groupMode ?? null,
    similarityThreshold: config.similarityThreshold ?? null,
    target: config.ratio ? Math.ceil(records.filter(record => isUsable(record, config)).length * config.ratio) : null,
    picked: picked.length,
    pickedLabeled: pickedLabeled.length,
    truePositive: pickedPositive.length,
    falseNegative: positives.length - pickedPositive.length,
    falsePositive: pickedNegative.length,
    recall: safeRatio(pickedPositive.length, positives.length),
    precisionOnLabeled: safeRatio(pickedPositive.length, pickedLabeled.length),
    negativePickRate: safeRatio(pickedNegative.length, negatives.length),
    pickedGuardTriggered: pickedGuardTriggered.length,
    pickedPositiveGuardTriggered: pickedPositiveGuardTriggered.length,
    guardTriggeredTotal: guardTriggered.length,
    selectedAdjacentPairs: selectedAdjacentPairs(records, pickedIds).length,
    selectedSimilarAdjacentPairs: selectedSimilarAdjacentPairs(records, pickedIds, pairSimilarityMap).length,
    formalDuplicateGroupsWithMultiplePicks: formalGroupStats.groupsWithMultiplePicks,
    visualDuplicateGroupsWithMultiplePicks: groupStats.groupsWithMultiplePicks,
    groupCount: groups.length,
    ...extra,
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

function buildRatioRows(results) {
  const baselines = new Map(results.filter(result => result.config.falseFaceGuardMode === 'none').map(result => [Number(result.config.ratio), result]));
  return results.map(result => {
    const baseline = baselines.get(Number(result.config.ratio));
    return {
      ratio: result.metrics.ratio,
      variant: result.config.falseFaceGuardMode,
      name: result.name,
      rankMode: result.metrics.rankMode,
      baseRankMode: result.metrics.baseRankMode,
      guardThreshold: result.config.falseFaceGuardThreshold ?? '',
      downweightPenalty: result.config.falseFaceGuardPenalty ?? '',
      gateMode: result.metrics.gateMode,
      groupMode: result.metrics.groupMode,
      similarityThreshold: result.metrics.similarityThreshold ?? '',
      target: result.metrics.target,
      picked: result.metrics.picked,
      truePositive: result.metrics.truePositive,
      falseNegative: result.metrics.falseNegative,
      falsePositive: result.metrics.falsePositive,
      recall: result.metrics.recall,
      recallDropPp: baseline ? round2((baseline.metrics.recall - result.metrics.recall) * 100) : 0,
      negativePickRate: result.metrics.negativePickRate,
      negativePickDeltaPp: baseline ? round2((result.metrics.negativePickRate - baseline.metrics.negativePickRate) * 100) : 0,
      pickedGuardTriggered: result.metrics.pickedGuardTriggered,
      pickedPositiveGuardTriggered: result.metrics.pickedPositiveGuardTriggered,
      guardTriggeredTotal: result.metrics.guardTriggeredTotal,
      selectedSimilarAdjacentPairs: result.metrics.selectedSimilarAdjacentPairs,
      formalDuplicateGroupsWithMultiplePicks: result.metrics.formalDuplicateGroupsWithMultiplePicks,
      visualDuplicateGroupsWithMultiplePicks: result.metrics.visualDuplicateGroupsWithMultiplePicks,
    };
  });
}

function buildFalseInjuryRows(records, results) {
  const rows = [];
  const baselines = results.filter(result => result.config.falseFaceGuardMode === 'none');
  for (const baseline of baselines) {
    for (const variant of results.filter(result => Number(result.config.ratio) === Number(baseline.config.ratio) && result.config.falseFaceGuardMode !== 'none')) {
      for (const record of records) {
        if (!record.positive || !baseline.pickedIds.has(record.id) || variant.pickedIds.has(record.id)) continue;
        rows.push({
          ratio: baseline.config.ratio,
          variant: variant.config.falseFaceGuardMode,
          photoId: record.id,
          fileName: record.fileName,
          dataset: record.dataset,
          rating: record.evalRating ?? '',
          scene: record.proSceneLabel ?? record.teacherSceneType ?? '',
          sourceName: record.sourceName,
          guardTriggered: isGuardTriggered(record, variant),
          upstreamGateTriggered: record.v15UpstreamGateTriggered,
          conflictRisk: round4(record.v15ConflictRisk),
          selectedV15Risk: round4(record.v15SelectedRisk),
          maxFacePresence: round4(record.v15MaxFacePresence),
          reliableFacePresence: round4(record.v15ReliableFacePresence),
          teacherHasRealHumanFace: record.teacherHasRealHumanFace ?? '',
          teacherFalseFaceRisk: round4(record.teacherFalseFaceRisk ?? 0),
          baselineScore: round4(rank(record, baseline.config)),
          variantScore: round4(rank(record, variant.config)),
        });
      }
    }
  }
  return rows
    .sort((left, right) => Number(right.guardTriggered) - Number(left.guardTriggered) || Number(right.rating) - Number(left.rating) || Number(right.conflictRisk) - Number(left.conflictRisk))
    .slice(0, 300);
}

function buildGuardTopRows(records) {
  return records
    .filter(record => record.v15GuardTriggered)
    .sort((left, right) => right.v15ConflictRisk - left.v15ConflictRisk || rank(right, { rankMode: 'pro-persona' }) - rank(left, { rankMode: 'pro-persona' }))
    .slice(0, 300)
    .map(record => ({
      photoId: record.id,
      fileName: record.fileName,
      dataset: record.dataset,
      rating: record.evalRating ?? '',
      positive: record.positive ?? '',
      scene: record.proSceneLabel ?? record.teacherSceneType ?? '',
      sourceName: record.sourceName,
      conflictRisk: round4(record.v15ConflictRisk),
      selectedV15Risk: round4(record.v15SelectedRisk),
      maxFacePresence: round4(record.v15MaxFacePresence),
      reliableFacePresence: round4(record.v15ReliableFacePresence),
      faceCount: record.v15FaceCount,
      reliableFaceCount: record.v15ReliableFaceCount,
      teacherHasRealHumanFace: record.teacherHasRealHumanFace ?? '',
      teacherFalseFaceRisk: round4(record.teacherFalseFaceRisk ?? 0),
      teacherFaceRelevant: record.teacherFaceRelevant ?? '',
    }));
}

function buildSceneRows(records, results) {
  const scenes = new Map();
  for (const record of records) {
    const scene = record.proSceneLabel ?? record.teacherSceneType ?? 'unknown';
    if (!scenes.has(scene)) {
      scenes.set(scene, {
        scene,
        total: 0,
        positives: 0,
        negatives: 0,
        upstreamGateTriggered: 0,
        guardTriggered: 0,
        guardTriggeredPositive: 0,
        guardTriggeredNegative: 0,
        teacherProxyGuardRealFace: 0,
        teacherProxyGuardFalseFaceHighRisk: 0,
      });
    }
    const row = scenes.get(scene);
    row.total += 1;
    if (record.positive) row.positives += 1;
    if (record.negative) row.negatives += 1;
    if (record.v15UpstreamGateTriggered) row.upstreamGateTriggered += 1;
    if (record.v15GuardTriggered) {
      row.guardTriggered += 1;
      if (record.positive) row.guardTriggeredPositive += 1;
      if (record.negative) row.guardTriggeredNegative += 1;
      if (record.teacherHasRealHumanFace === true) row.teacherProxyGuardRealFace += 1;
      if (record.teacherHasRealHumanFace === false && (record.teacherFalseFaceRisk ?? 0) >= GUARD_THRESHOLD) {
        row.teacherProxyGuardFalseFaceHighRisk += 1;
      }
    }
  }
  const byScene = [...scenes.values()].map(row => ({
    ...row,
    upstreamGateRate: safeRatio(row.upstreamGateTriggered, row.total),
    guardTriggerRate: safeRatio(row.guardTriggered, row.total),
    guardPositiveShare: safeRatio(row.guardTriggeredPositive, row.guardTriggered),
  }));

  const ratios45 = results.filter(result => Number(result.config.ratio) === 0.45);
  for (const sceneRow of byScene) {
    for (const result of ratios45) {
      const picked = records.filter(record => (record.proSceneLabel ?? record.teacherSceneType ?? 'unknown') === sceneRow.scene && result.pickedIds.has(record.id));
      sceneRow[`picked_${result.config.falseFaceGuardMode}`] = picked.length;
      sceneRow[`pickedPositive_${result.config.falseFaceGuardMode}`] = picked.filter(record => record.positive).length;
    }
  }
  return byScene.sort((left, right) => right.guardTriggered - left.guardTriggered || right.total - left.total);
}

function buildGateSampleRows(records) {
  const gate = records.filter(record => record.v15UpstreamGateTriggered);
  const nonGate = records.filter(record => !record.v15UpstreamGateTriggered);
  const topGuard = [...records].sort((left, right) => right.v15ConflictRisk - left.v15ConflictRisk).slice(0, 40);
  const sample = [
    ...deterministicSample(gate, 80, 'gate'),
    ...deterministicSample(nonGate, 40, 'nongate'),
    ...topGuard,
  ];
  const seen = new Set();
  return sample
    .filter(record => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    })
    .map(record => ({
      photoId: record.id,
      fileName: record.fileName,
      dataset: record.dataset,
      sourceName: record.sourceName,
      sampledBucket: record.v15UpstreamGateTriggered ? 'upstream-gate' : 'not-gate',
      scene: record.proSceneLabel ?? record.teacherSceneType ?? '',
      upstreamGateTriggered: record.v15UpstreamGateTriggered,
      guardTriggered: record.v15GuardTriggered,
      conflictRisk: round4(record.v15ConflictRisk),
      reliableFacePresence: round4(record.v15ReliableFacePresence),
      teacherHasRealHumanFace: record.teacherHasRealHumanFace ?? '',
      teacherFalseFaceRisk: round4(record.teacherFalseFaceRisk ?? 0),
      teacherFaceRelevant: record.teacherFaceRelevant ?? '',
      teacherProxyGateCorrect: record.v15UpstreamGateTriggered ? Boolean(record.teacherFaceRelevant) : !Boolean(record.teacherFaceRelevant),
      note: 'teacher-proxy only; not manual human audit',
    }));
}

function summarizeGateSampleRows(rows) {
  const scored = rows.filter(row => row.teacherProxyGateCorrect !== '');
  const gateRows = scored.filter(row => row.upstreamGateTriggered === true || row.upstreamGateTriggered === 'true');
  return {
    sampleCount: rows.length,
    teacherProxyScoredCount: scored.length,
    teacherProxySampleAccuracy: safeRatio(scored.filter(row => row.teacherProxyGateCorrect === true).length, scored.length),
    teacherProxyGateSamplePrecision: safeRatio(gateRows.filter(row => row.teacherFaceRelevant === true || row.teacherFaceRelevant === 'true').length, gateRows.length),
    note: 'teacher-proxy only; not manual human audit',
  };
}

function deterministicSample(items, count, salt) {
  return [...items]
    .sort((left, right) => hash(`${salt}:${left.id}`) - hash(`${salt}:${right.id}`))
    .slice(0, count);
}

function buildVerdict(ratioRows) {
  const row45Exclude = ratioRows.find(row => Number(row.ratio) === 0.45 && row.variant === 'exclude');
  const row45Downweight = ratioRows.find(row => Number(row.ratio) === 0.45 && row.variant === 'downweight');
  const excludeDrop = Number(row45Exclude?.recallDropPp ?? 0);
  const downweightDrop = Number(row45Downweight?.recallDropPp ?? 0);
  const autoExcludeAllowed = excludeDrop < 2;
  const autoDownweightAllowed = downweightDrop < 2;
  let verdict = 'guard-only';
  let text = 'v15 guard 仍应只作为诊断/审核提示，不应自动剔除。';
  if (autoExcludeAllowed && autoDownweightAllowed) {
    verdict = 'eligible-for-discussion-but-fpr-still-needs-route-b';
    text = '召回回退低于 2pp，可以讨论受限自动策略；但 holdout FPR 36.7%，仍建议先走路线 B 降误伤。';
  } else if (!autoExcludeAllowed && autoDownweightAllowed) {
    verdict = 'downweight-only-discussion-exclude-blocked';
    text = '自动剔除不通过 2pp 门槛；降权可以继续讨论，但仍不能宣传为已解决假脸。';
  }
  return {
    verdict,
    text,
    recallDropPpAt45: {
      exclude: excludeDrop,
      downweight: downweightDrop,
    },
    autoExcludeAllowedByRecallGate: autoExcludeAllowed,
    autoDownweightAllowedByRecallGate: autoDownweightAllowed,
    holdoutFprAt05: HOLDOUT_FPR,
    routeBRecommendation: '如果误伤或 teacher-proxy 假阳性仍高，下一步应训练独立 crop 判别器降低 FPR，而不是继续重训 semantic student。',
  };
}

function buildSummaryMarkdown({ auditPath, labelsPath, selectedConfigPath, guardPath, guardPayload, ratioRows, sceneRows, gateSampleSummary, verdict }) {
  const lines = [];
  const gate = guardPayload.summary ?? {};
  lines.push('# v15 假脸 guard 全量 replay 报告');
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 判定：${verdict.text}`);
  lines.push(`- @45 自动剔除 recall 回退：${fmtPp(verdict.recallDropPpAt45.exclude)}；@45 降权 recall 回退：${fmtPp(verdict.recallDropPpAt45.downweight)}。`);
  lines.push('- 本轮没有重训 student，没有改 backbone / teacher prompt / YuNet，也没有用 84 张 holdout 做训练、调参或阈值拟合。');
  lines.push(`- 84 holdout 的 AUC ${fmt(HOLDOUT_AUC)} 是“疑似脸上下文”的条件表现，不是 7692 全量真实表现；同一 holdout 上 FPR@0.5 为 ${pct(HOLDOUT_FPR)}。`);
  lines.push('');
  lines.push('## 输入与固定口径');
  lines.push('');
  lines.push(`- Audit: \`${auditPath}\``);
  lines.push(`- Labels: \`${labelsPath}\``);
  lines.push(`- v14 selected configs: \`${selectedConfigPath}\``);
  lines.push(`- v15 full YuNet scores: \`${guardPath}\``);
  lines.push('- 上游疑似脸 gate 固定为：`maxFacePresence >= 0.08`。');
  lines.push('- guard 风险固定为：`conflictRisk = upstreamGate ? 1 - reliableFacePresence : 0`，阈值固定 `>= 0.5`。');
  lines.push(`- 降权版本固定扣分：\`${DOWNWEIGHT_PENALTY} * max(0.5, conflictRisk)\`，没有根据结果调参。`);
  lines.push('');
  lines.push('## 上游 gate 全量刻画');
  lines.push('');
  lines.push(`- 全量图片：${gate.total ?? guardPayload.count}`);
  lines.push(`- 上游 gate 触发：${gate.upstreamGateTriggered ?? 0}，触发率 ${pct(gate.upstreamGateTriggerRate)}`);
  lines.push(`- 最终 guard 触发：${gate.guardTriggered ?? 0}，触发率 ${pct(gate.guardTriggerRate)}`);
  lines.push(`- teacher-proxy gate precision：${pct(gate.teacherProxyGatePrecision)}；teacher-proxy gate recall：${pct(gate.teacherProxyGateRecall)}。`);
  lines.push(`- teacher-proxy 抽样准确率：${pct(gateSampleSummary.teacherProxySampleAccuracy)}（n=${gateSampleSummary.teacherProxyScoredCount}）；gate 样本 precision：${pct(gateSampleSummary.teacherProxyGateSamplePrecision)}。`);
  lines.push(`- teacher-proxy 中，guard 打到真人脸的数量：${gate.teacherProxyGuardRealFaceCount ?? 0}；打到 high-risk 假脸的数量：${gate.teacherProxyGuardFalseFaceHighRiskCount ?? 0}。`);
  lines.push('- 上面是 teacher-proxy 抽样/统计，不等同于人工审核准确率；详见 `gate-sample-teacher-proxy.csv`。');
  lines.push('');
  lines.push('## Replay 指标');
  lines.push('');
  lines.push('| Ratio | Variant | Rank mode | Picked | Recall | Recall drop | Negative pick rate | Guard picked | Similar pairs |');
  lines.push('| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of ratioRows) {
    lines.push(`| ${pct(row.ratio)} | ${row.variant} | \`${row.rankMode}\` | ${row.picked} | ${pct(row.recall)} | ${fmtPp(row.recallDropPp)} | ${pct(row.negativePickRate)} | ${row.pickedGuardTriggered} | ${row.selectedSimilarAdjacentPairs} |`);
  }
  lines.push('');
  lines.push('## Scene 分布');
  lines.push('');
  lines.push('| Scene | Total | Gate | Guard | Guard positives | Teacher-proxy real-face guard |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of sceneRows.slice(0, 16)) {
    lines.push(`| ${row.scene} | ${row.total} | ${row.upstreamGateTriggered} | ${row.guardTriggered} | ${row.guardTriggeredPositive} | ${row.teacherProxyGuardRealFace} |`);
  }
  lines.push('');
  lines.push('## 误伤检查文件');
  lines.push('');
  lines.push('- `false-injury-top.csv`：baseline 会选、guard 版本漏掉的正样本 top 列表。');
  lines.push('- `guard-triggered-top.csv`：guard 触发样本 top 列表，含 teacher-proxy 真人脸/假脸字段。');
  lines.push('- `scene-distribution.csv`：不同 scene 的 gate/guard 分布。');
  lines.push('');
  lines.push('## 生产建议');
  lines.push('');
  if (verdict.verdict === 'guard-only') {
    lines.push('- 当前不建议接入自动剔除/降权作为默认生产逻辑。保留为诊断 guard。');
    lines.push('- 下一步建议路线 B：独立 crop 判别器，目标是把 holdout FPR 从 36.7% 明显压低后再 replay。');
  } else if (verdict.verdict === 'downweight-only-discussion-exclude-blocked') {
    lines.push('- 自动剔除不通过；降权可继续小范围实验，但不能进入默认自动拦截。');
    lines.push('- 仍建议路线 B 降低真人脸误伤。');
  } else {
    lines.push('- 召回门槛允许继续讨论受限自动策略，但 FPR 仍高，进入生产前必须补人工误伤审核。');
  }
  return lines.join('\n') + '\n';
}

function pairKey(leftId, rightId) {
  return [leftId, rightId].sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true })).join('::');
}

function labelRating(value) {
  if (value && typeof value === 'object') return value.rating ?? value.stars ?? value.xmpRating;
  return value;
}

function inferDataset(summary, sourceName = '') {
  const explicit = summary.dataset ?? summary.sourceDataset ?? summary.proDataset;
  if (explicit) return String(explicit);
  const source = String(sourceName || summary.sourceFolder || summary.sourceName || summary.fileName || summary.id || '').toLowerCase();
  if (source.includes('five_mountain') || source.includes('five-mountain') || source.includes('五台山')) return 'five_mountain';
  if (source.includes('camera') || source.includes('相机')) return 'camera';
  return 'audit3groups';
}

function sourceFolder(sourceName, dataset) {
  const normalized = String(sourceName || '').replaceAll('/', '\\');
  const match = normalized.match(/(108NZ6_3|109NZ6_3|110NZ6_3)/);
  if (match) return match[1];
  if (dataset === 'camera') return 'camera';
  if (dataset === 'five_mountain') return 'five_mountain';
  const parts = normalized.split('\\').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
}

function comparePhotoOrder(left, right) {
  const folder = String(left?.sourceFolder).localeCompare(String(right?.sourceFolder), undefined, { numeric: true });
  if (folder !== 0) return folder;
  return (left?.numericId ?? Number.MAX_SAFE_INTEGER) - (right?.numericId ?? Number.MAX_SAFE_INTEGER) ||
    String(left?.id).localeCompare(String(right?.id), undefined, { numeric: true });
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

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function round4(value) {
  return Number(Number(value || 0).toFixed(4));
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function fmt(value) {
  return Number(value || 0).toFixed(4);
}

function fmtPp(value) {
  return `${Number(value || 0).toFixed(2)}pp`;
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

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function csvRows(rows) {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return [
    columns.join(','),
    ...rows.map(row => columns.map(column => csvValue(row[column])).join(',')),
  ].join('\n') + '\n';
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') value = JSON.stringify(value);
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function hash(value) {
  let out = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    out ^= value.charCodeAt(index);
    out = Math.imul(out, 16777619);
  }
  return out >>> 0;
}
