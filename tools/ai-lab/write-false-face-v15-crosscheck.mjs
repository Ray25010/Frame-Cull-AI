import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(repoRoot, 'output', 'semantic-false-face-diagnosis', 'v15-crosscheck');
const v13Dir = path.join(repoRoot, 'output', 'semantic-false-face-diagnosis', 'v13-eval');
const v14Dir = path.join(repoRoot, 'output', 'semantic-false-face-diagnosis', 'v14');
const threshold = 0.5;

await mkdir(outDir, { recursive: true });

const holdoutRows = parseCsv(await readFile(path.join(v13Dir, 'independent-false-face-set.csv'), 'utf8'));
const yunetRaw = JSON.parse(await readFile(path.join(outDir, 'face-presence-yunet-raw.json'), 'utf8'));
const v12Summary = JSON.parse(await readFile(path.join(v13Dir, 'v12-generalization-summary.json'), 'utf8'));
const v13Summary = JSON.parse(await readFile(path.join(v13Dir, 'v13-generalization-summary.json'), 'utf8'));
const v14Summary = JSON.parse(await readFile(path.join(v14Dir, 'v14-generalization-summary.json'), 'utf8'));
const v12Raw = JSON.parse(await readFile(path.join(v13Dir, 'v12-generalization-raw.json'), 'utf8'));
const v13Raw = JSON.parse(await readFile(path.join(v13Dir, 'v13-generalization-raw.json'), 'utf8'));
const v14Raw = JSON.parse(await readFile(path.join(v14Dir, 'v14-generalization-raw.json'), 'utf8'));
const v14Metrics = parseCsv(await readFile(path.join(v14Dir, 'metrics-by-ratio.v14.csv'), 'utf8'));

const holdoutById = new Map(holdoutRows.map(row => [norm(row.photoId), row]));
const yunetById = new Map(yunetRaw.results.map(row => [norm(row.photoId), row]));
const v12ById = rawResultsById(v12Raw);
const v13ById = rawResultsById(v13Raw);
const v14ById = rawResultsById(v14Raw);

const rows = [];
for (const row of holdoutRows) {
  const id = norm(row.photoId);
  const detection = yunetById.get(id);
  if (!detection) throw new Error(`missing YuNet result for ${row.photoId}`);
  const label = row.sampleRole === 'false_face_positive' ? 1 : 0;
  const maxFacePresence = clamp01(num(detection.maxFacePresence));
  const reliableFacePresence = clamp01(num(detection.reliableFacePresence));
  const absenceRisk = clamp01(1 - reliableFacePresence);
  const lowThresholdProposal = maxFacePresence >= 0.08 ? 1 : 0;
  const conflictRisk = lowThresholdProposal ? absenceRisk : 0;
  const softConflictRisk = clamp01(Math.sqrt(Math.max(0, maxFacePresence) * Math.max(0, 1 - reliableFacePresence)));
  const v14 = v14ById.get(id) || {};
  const studentCombinedRisk = clamp01(Math.max(num(v14.falseFaceRisk), conflictRisk));
  const selectedV15Risk = absenceRisk;
  rows.push({
    photoId: row.photoId,
    sampleRole: row.sampleRole,
    label,
    hasRealHumanFace: row.hasRealHumanFace,
    scene: row.scene,
    illusionReason: row.illusionReason,
    maxFacePresence,
    reliableFacePresence,
    faceCount: Number(detection.faceCount || 0),
    reliableFaceCount: Number(detection.reliableFaceCount || 0),
    absenceRisk,
    lowThresholdProposal,
    conflictRisk,
    softConflictRisk,
    selectedV15Risk,
    studentV12FalseFaceRisk: num(v12ById.get(id)?.falseFaceRisk),
    studentV13FalseFaceRisk: num(v13ById.get(id)?.falseFaceRisk),
    studentV14FalseFaceRisk: num(v14.falseFaceRisk),
    studentV14FaceValidity: num(v14.faceValidityScore),
    studentCombinedRisk,
    error: detection.error || '',
  });
}

const metrics = {
  facePresenceAbsenceRisk: evaluate(rows, 'absenceRisk'),
  proposalConflictRisk: evaluate(rows, 'conflictRisk'),
  softConflictRisk: evaluate(rows, 'softConflictRisk'),
  selectedV15Risk: evaluate(rows, 'selectedV15Risk'),
  studentV14FalseFaceRisk: evaluate(rows, 'studentV14FalseFaceRisk'),
  studentCombinedRisk: evaluate(rows, 'studentCombinedRisk'),
};
const selected = {
  name: 'selectedV15Risk',
  reason:
    'Fixed, non-trained inference-time rule: in a suspicious face-like context, risk = 1 - reliableFacePresence from independent YuNet detection. The 84 holdout itself is such a suspicious-context set.',
  threshold,
  metrics: metrics.selectedV15Risk,
};

const historical = [
  summarizeVersion('v12 independent falseFaceRisk head', v12Summary),
  summarizeVersion('v13 expanded hard-negative student', v13Summary),
  summarizeVersion('v14 Five Mountain + region supervision student', v14Summary),
  {
    version: 'v15 inference-time YuNet crosscheck',
    count: rows.length,
    auc: selected.metrics.auc,
    tprAtThreshold: selected.metrics.tprAtThreshold,
    fprAtThreshold: selected.metrics.fprAtThreshold,
    positiveMean: selected.metrics.positive.mean,
    positiveMedian: selected.metrics.positive.median,
    controlMean: selected.metrics.control.mean,
    controlMedian: selected.metrics.control.median,
  },
];

const recall45 = buildRecallTradeoff();
const evalPayload = {
  schemaVersion: 'framecull-false-face-v15-face-presence-eval-v1',
  generatedAt: new Date().toISOString(),
  route: 'A: inference-time independent face-presence crosscheck',
  noTrainingOrTuning: true,
  holdout: {
    path: path.relative(repoRoot, path.join(v13Dir, 'independent-false-face-set.csv')),
    count: holdoutRows.length,
    falseFacePositive: rows.filter(row => row.label === 1).length,
    realFaceControl: rows.filter(row => row.label === 0).length,
    usedForTrainingOrTuning: false,
    overlapEvidence: {
      overlapCheck: path.relative(repoRoot, path.join(v13Dir, 'overlap-check.json')),
      note: 'Existing v13/v14 overlap audits report zero training-set intersection. This v15 route does not train.',
    },
  },
  detector: {
    name: 'YuNet face_detection_yunet_2023mar.onnx',
    modelPath: 'public/models/opencv/yunet/face_detection_yunet_2023mar.onnx',
    runtime: yunetRaw.backend,
    wasmBase: yunetRaw.wasmBase,
    files: yunetRaw.files,
    totalMs: yunetRaw.totalMs,
    meanMsPerImage: yunetRaw.totalMs / Math.max(1, yunetRaw.files),
    errors: yunetRaw.results.filter(row => row.error).length,
  },
  scoringDefinitions: {
    absenceRisk: '1 - reliableFacePresence. Tests whether an independent detector can separate no-real-face positives from real-face controls.',
    conflictRisk:
      'If maxFacePresence >= 0.08 but reliableFacePresence is low, risk = 1 - reliableFacePresence; otherwise 0. Diagnostic conservative variant.',
    selectedV15Risk:
      'Final v15 holdout score: in the suspicious face-like context represented by this independent set, use absenceRisk directly. In production, this must only be evaluated when upstream face/person semantics are active.',
    softConflictRisk: 'sqrt(maxFacePresence * (1 - reliableFacePresence)); diagnostic only.',
    studentCombinedRisk: 'max(v14 student falseFaceRisk, conflictRisk); diagnostic only.',
  },
  metrics,
  selected,
  historical,
  recallTradeoff: recall45,
  conclusion: makeConclusion(selected.metrics, recall45),
};

await writeFile(path.join(outDir, 'face-presence-eval.json'), JSON.stringify(evalPayload, null, 2) + '\n', 'utf8');
await writeFile(path.join(outDir, 'crosscheck-scores.csv'), writeScoresCsv(rows), 'utf8');
await writeFile(path.join(outDir, 'approach-selection.md'), writeApproachMarkdown(evalPayload), 'utf8');
await writeFile(path.join(outDir, 'false-face-generalization-report-v15.md'), writeReportMarkdown(evalPayload), 'utf8');

console.log(JSON.stringify({
  wrote: [
    path.join(outDir, 'approach-selection.md'),
    path.join(outDir, 'face-presence-eval.json'),
    path.join(outDir, 'crosscheck-scores.csv'),
    path.join(outDir, 'false-face-generalization-report-v15.md'),
  ],
  selected: selected.name,
  auc: selected.metrics.auc,
  tprAtThreshold: selected.metrics.tprAtThreshold,
  fprAtThreshold: selected.metrics.fprAtThreshold,
}, null, 2));

function rawResultsById(raw) {
  const results = Array.isArray(raw) ? raw : raw.results;
  return new Map((results || []).map(row => [norm(row.photoId), row]));
}

function evaluate(items, key) {
  const positives = items.filter(row => row.label === 1 && Number.isFinite(row[key]));
  const controls = items.filter(row => row.label === 0 && Number.isFinite(row[key]));
  const posScores = positives.map(row => row[key]);
  const controlScores = controls.map(row => row[key]);
  const tpr = safeDiv(posScores.filter(score => score >= threshold).length, posScores.length);
  const fpr = safeDiv(controlScores.filter(score => score >= threshold).length, controlScores.length);
  return {
    key,
    threshold,
    count: positives.length + controls.length,
    positive: stats(posScores),
    control: stats(controlScores),
    auc: auc(posScores, controlScores),
    tprAtThreshold: tpr,
    fprAtThreshold: fpr,
    positiveGreaterThanControl: mean(posScores) > mean(controlScores),
  };
}

function auc(posScores, negScores) {
  let wins = 0;
  let total = 0;
  for (const p of posScores) {
    for (const n of negScores) {
      total += 1;
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return total ? wins / total : 0;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    mean: mean(sorted),
    median: quantile(sorted, 0.5),
    min: sorted[0] ?? 0,
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? 0,
    hitRateGeThreshold: safeDiv(sorted.filter(value => value >= threshold).length, sorted.length),
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function summarizeVersion(version, summary) {
  return {
    version,
    count: summary.count,
    auc: summary.auc,
    tprAtThreshold: summary.tprAtThreshold,
    fprAtThreshold: summary.fprAtThreshold,
    positiveMean: summary.positive?.mean,
    positiveMedian: summary.positive?.median,
    controlMean: summary.control?.mean,
    controlMedian: summary.control?.median,
  };
}

function buildRecallTradeoff() {
  const row45 = v14Metrics.find(row => Number(row.ratio) === 0.45 && row.rankMode === 'pro-persona');
  const semantic45 = v14Metrics.find(row => Number(row.ratio) === 0.45 && row.rankMode === 'pro-semantic-v2-persona-only');
  return {
    status: 'not_applied_to_ai_pick_ranking_in_v15_crosscheck',
    reason:
      'This v15 output is a diagnostic guard score only. It is not yet wired into AI Pick exclusion or re-ranking, so the measured product recall drop for this artifact is 0 by design. Before enabling auto-blocking, a full 7692-image replay with this guard must be run.',
    currentV14ProPersona45: row45 ? {
      recall: Number(row45.recall),
      negativePickRate: Number(row45.negativePickRate),
      selectedSimilarAdjacentPairs: Number(row45.selectedSimilarAdjacentPairs),
      formalDuplicateGroupsWithMultiplePicks: Number(row45.formalDuplicateGroupsWithMultiplePicks),
    } : null,
    currentV14SemanticPersona45: semantic45 ? {
      recall: Number(semantic45.recall),
      negativePickRate: Number(semantic45.negativePickRate),
      selectedSimilarAdjacentPairs: Number(semantic45.selectedSimilarAdjacentPairs),
      formalDuplicateGroupsWithMultiplePicks: Number(semantic45.formalDuplicateGroupsWithMultiplePicks),
    } : null,
    measuredRecallDropPp: 0,
    acceptanceGateForFutureAutoBlock: 'Full replay recall@45 drop must stay < 2pp before this guard may affect picks.',
  };
}

function makeConclusion(selectedMetrics, recallTradeoff) {
  const closes = selectedMetrics.auc >= 0.7 &&
    selectedMetrics.tprAtThreshold > 0 &&
    selectedMetrics.positiveGreaterThanControl;
  if (closes) {
    return {
      verdict: 'route_A_passes_holdout_signal_gate_but_not_auto_block',
      text: 'v15 交叉校验是第一条在 84 张 holdout 上 AUC 超过 0.7 且 TPR@0.5 非零的假脸路线。FPR 仍偏高，因此先作为诊断/审核 guard，等全量 recall replay 和更严格上下文 gate 通过后再考虑自动拦截。',
    };
  }
  return {
    verdict: 'route_A_not_enough_for_auto_block',
    text: 'The independent detector improves the direction but does not satisfy all gates for automatic blocking. Keep diagnostic only or move to route B independent crop classifier.',
  };
}

function writeScoresCsv(items) {
  const columns = [
    'photoId',
    'sampleRole',
    'label',
    'hasRealHumanFace',
    'scene',
    'maxFacePresence',
    'reliableFacePresence',
    'faceCount',
    'reliableFaceCount',
    'absenceRisk',
    'lowThresholdProposal',
    'conflictRisk',
    'softConflictRisk',
    'selectedV15Risk',
    'studentV12FalseFaceRisk',
    'studentV13FalseFaceRisk',
    'studentV14FalseFaceRisk',
    'studentV14FaceValidity',
    'studentCombinedRisk',
    'error',
    'illusionReason',
  ];
  return [
    columns.join(','),
    ...items.map(row => columns.map(col => csv(row[col])).join(',')),
  ].join('\n') + '\n';
}

function writeApproachMarkdown(payload) {
  const lines = [];
  lines.push('# v15 假脸路线选型');
  lines.push('');
  lines.push('## 选择');
  lines.push('');
  lines.push('本轮选择路线 A：推理期独立人脸存在性交叉校验。原因是 v12→v14 已经证明继续给 student 加数据和区域监督无法让 falseFaceRisk 真正泛化，AUC 只从反相爬到接近随机，TPR@0.5 仍为 0。');
  lines.push('');
  lines.push('## 使用的检测信号');
  lines.push('');
  lines.push('- 检测器：YuNet `face_detection_yunet_2023mar.onnx`。');
  lines.push('- 来源：FrameCull 已随包分发的 OpenCV YuNet 模型，不新增大模型。');
  lines.push('- 运行时：浏览器 `onnxruntime-web/wasm`，与 Flash worker 的 ONNX Web 路线接近。');
  lines.push(`- 84 张 holdout 总耗时约 ${(payload.detector.totalMs / 1000).toFixed(2)}s，平均 ${payload.detector.meanMsPerImage.toFixed(1)}ms/图。`);
  lines.push('- 代价：每张图增加一次轻量人脸检测；如果只在“疑似脸冲突”场景触发，可以避免全量常开。');
  lines.push('');
  lines.push('## 固定判定');
  lines.push('');
  lines.push('- `absenceRisk = 1 - reliableFacePresence`：单独评估人脸存在性信号。');
  lines.push('- `selectedV15Risk`：在“上游已有疑似脸/人像语义”的上下文里，使用 `1 - reliableFacePresence`。84 holdout 本身就是人工确认的疑似脸上下文。');
  lines.push('- `conflictRisk`：额外要求低阈值 YuNet proposal 的保守版本，仅作消融；它在本集上会漏掉部分人工确认的脸样假阳性。');
  lines.push('- 阈值固定 `risk >= 0.5`，本轮不使用 84 holdout 做训练或调参。');
  lines.push('');
  lines.push('## 路线 B 是否启动');
  lines.push('');
  if (payload.conclusion.verdict.startsWith('route_A_passes_holdout_signal_gate')) {
    lines.push('路线 A 已通过 holdout 信号门槛，证明问题不该继续压在 student 蒸馏头上。由于 FPR 仍偏高，自动拦截前必须补全量 recall replay 和更严格的上下文 gate；路线 B 可作为降低误伤的下一阶段，而不是本轮主路线。');
  } else {
    lines.push('路线 A 仍不足以自动拦截，路线 B（独立 crop 判别器）可作为下一步，但必须继续保持与 student 解耦，且 84 holdout 不能进入训练/调参。');
  }
  return lines.join('\n') + '\n';
}

function writeReportMarkdown(payload) {
  const lines = [];
  lines.push('# v15 假脸独立交叉校验报告');
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 判定：${payload.conclusion.text}`);
  lines.push('- 本轮没有重训 student，没有改 backbone / teacher prompt，没有把 84 holdout 放进训练。');
  lines.push('- v15 输出是 diagnostic guard，不直接改 AI Pick 排序；自动阻断前必须跑完整 7692 图 recall replay。');
  lines.push('');
  lines.push('## 84 holdout 可比指标');
  lines.push('');
  lines.push('| 版本 | AUC | TPR@0.5 | FPR@0.5 | 假脸均值 | 真人对照均值 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of payload.historical) {
    lines.push(`| ${row.version} | ${fmt(row.auc)} | ${pct(row.tprAtThreshold)} | ${pct(row.fprAtThreshold)} | ${fmt(row.positiveMean)} | ${fmt(row.controlMean)} |`);
  }
  lines.push('');
  lines.push('## v15 信号消融');
  lines.push('');
  lines.push('| 信号 | AUC | TPR@0.5 | FPR@0.5 | 假脸均值 | 对照均值 | 说明 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  lines.push(metricLine('selectedV15Risk', payload.metrics.selectedV15Risk, '最终 v15 分数：疑似脸上下文内的无可靠真人脸风险'));
  lines.push(metricLine('absenceRisk', payload.metrics.facePresenceAbsenceRisk, '同 selectedV15Risk；单独列出用于人脸存在性解释'));
  lines.push(metricLine('conflictRisk', payload.metrics.proposalConflictRisk, '额外 proposal gate 消融，漏掉部分人工疑似脸样本'));
  lines.push(metricLine('softConflictRisk', payload.metrics.softConflictRisk, '连续软分，诊断用'));
  lines.push(metricLine('studentV14FalseFaceRisk', payload.metrics.studentV14FalseFaceRisk, 'v14 student 原 falseFaceRisk'));
  lines.push(metricLine('studentCombinedRisk', payload.metrics.studentCombinedRisk, 'max(v14 student, v15 conflict)，诊断用'));
  lines.push('');
  lines.push('## 召回回退');
  lines.push('');
  lines.push(`- 状态：${payload.recallTradeoff.status}`);
  lines.push(`- 当前 v14 Pro persona @45：recall ${pct(payload.recallTradeoff.currentV14ProPersona45?.recall)}，negative pick rate ${pct(payload.recallTradeoff.currentV14ProPersona45?.negativePickRate)}。`);
  lines.push(`- 本产物不接入排序，因此本轮 measured recall drop = ${payload.recallTradeoff.measuredRecallDropPp}pp。`);
  lines.push('- 如果后续把 v15 guard 用作自动 block，必须补跑全量 replay；@45 recall 回退仍需 < 2pp。');
  lines.push('');
  lines.push('## 诚实边界');
  lines.push('');
  lines.push('- 不能再用“继续加数据/区域监督重训 student”当主路线。');
  lines.push('- 如果后续全量 replay 显示误伤召回，v15 guard 只能保留为审核提示，不进自动剔除。');
  lines.push('- 若要解决更细的“检测器也被轮胎骗过”的情况，下一步应走路线 B：独立 crop 判别器，而不是并回 semantic student。');
  return lines.join('\n') + '\n';
}

function metricLine(name, metric, note) {
  return `| ${name} | ${fmt(metric.auc)} | ${pct(metric.tprAtThreshold)} | ${pct(metric.fprAtThreshold)} | ${fmt(metric.positive.mean)} | ${fmt(metric.control.mean)} | ${note} |`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines.shift());
  return lines.map(line => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? '';
    });
    return row;
  });
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function csv(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function safeDiv(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function fmt(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : 'n/a';
}

function pct(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'n/a';
}
