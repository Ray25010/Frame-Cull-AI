import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.output ?? 'output/semantic-false-face-diagnosis/v12-student');
const flatScenePath = path.resolve(args.flatScene ?? 'output/semantic-false-face-diagnosis/v11-final/reference/bench-flat.metrics-by-scene.csv');
const v1ScenePath = path.resolve(args.v1Scene ?? 'output/semantic-false-face-diagnosis/v11-final/reference/bench-grounded-v1.metrics-by-scene.csv');
const v11ScenePath = path.resolve(args.v11Scene ?? 'output/semantic-false-face-diagnosis/v11-final/metrics-by-scene.csv');
const v11RatioPath = path.resolve(args.v11Ratio ?? 'output/semantic-false-face-diagnosis/v11-final/metrics-by-ratio.csv');
const v12ScenePath = path.resolve(args.v12Scene ?? path.join(outputDir, 'metrics-by-scene.csv'));
const v12RatioPath = path.resolve(args.v12Ratio ?? path.join(outputDir, 'metrics-by-ratio.csv'));
const v11PhotoPath = path.resolve(args.v11Photo ?? 'output/semantic-false-face-diagnosis/v11-final/pro-infer-latency.csv');
const v12PhotoPath = path.resolve(args.v12Photo ?? path.join(outputDir, 'pro-infer-latency.csv'));
const positiveValidationPath = path.resolve(args.positiveValidation ?? path.join(outputDir, 'manual-review', 'v12-false-face-positive-validation.csv'));
const targetDelta = Number(args.targetDelta ?? 0.05);
const maxRecallDropAt45 = Number(args.maxRecallDropAt45 ?? 0.02);

mkdirSync(outputDir, { recursive: true });

const comparison = buildComparison();
writeFileSync(path.join(outputDir, 'false-face-scene-comparison-v12.csv'), comparisonCsv(comparison), 'utf8');
writeFileSync(path.join(outputDir, 'false-face-delta-summary-v12.json'), JSON.stringify(buildDeltaSummary(comparison), null, 2), 'utf8');
writeFileSync(path.join(outputDir, 'false-face-closure-report-v12.md'), reportMarkdown(comparison), 'utf8');
const positiveValidation = buildPositiveValidation();
writeFileSync(path.join(outputDir, 'false-face-positive-validation-v12.md'), positiveValidationMarkdown(positiveValidation), 'utf8');
writeFileSync(positiveValidationPath, positiveValidationCsv(positiveValidation), 'utf8');

console.log(`[false-face-v12] wrote ${outputDir}`);

function buildComparison() {
  const flat = loadSceneMap(flatScenePath);
  const v1 = loadSceneMap(v1ScenePath);
  const v11 = loadSceneMap(v11ScenePath);
  const v12 = loadSceneMap(v12ScenePath);
  const scenes = [...new Set([...flat.keys(), ...v1.keys(), ...v11.keys(), ...v12.keys()])].sort();

  return scenes.map(scene => {
    const flatRow = flat.get(scene);
    const v1Row = v1.get(scene);
    const v11Row = v11.get(scene);
    const v12Row = v12.get(scene);
    return {
      scene,
      flat: flatRow,
      v1: v1Row,
      v11: v11Row,
      v12: v12Row,
      v1MinusFlat: delta(v1Row?.falseFaceRiskMean, flatRow?.falseFaceRiskMean),
      v11MinusFlat: delta(v11Row?.falseFaceRiskMean, flatRow?.falseFaceRiskMean),
      v12MinusFlat: delta(v12Row?.falseFaceRiskMean, flatRow?.falseFaceRiskMean),
      v12MinusV11: delta(v12Row?.falseFaceRiskMean, v11Row?.falseFaceRiskMean),
    };
  });
}

function loadSceneMap(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`missing scene metrics: ${filePath}`);
  }
  const rows = parseCsv(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  const grouped = new Map();

  for (const row of rows) {
    const scene = String(row.scene ?? '').trim();
    if (!scene) continue;
    const current = grouped.get(scene) ?? { scene, total: 0, falseFaceRiskWeighted: 0 };
    const total = toNumber(row.total);
    const risk = toNumber(row.false_face_risk_mean);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(risk)) {
      current.total += total;
      current.falseFaceRiskWeighted += total * risk;
    }
    grouped.set(scene, current);
  }

  const out = new Map();
  for (const [scene, row] of grouped.entries()) {
    out.set(scene, {
      scene,
      total: row.total,
      falseFaceRiskMean: row.total > 0 ? row.falseFaceRiskWeighted / row.total : null,
    });
  }
  return out;
}

function comparisonCsv(rows) {
  const header = [
    'scene',
    'flat_false_face_risk_mean',
    'grounded_v1_false_face_risk_mean',
    'grounded_v11_false_face_risk_mean',
    'grounded_v12_false_face_risk_mean',
    'v1_minus_flat',
    'v11_minus_flat',
    'v12_minus_flat',
    'v12_minus_v11',
    'flat_total',
    'grounded_v1_total',
    'grounded_v11_total',
    'grounded_v12_total',
  ];
  return [
    header.join(','),
    ...rows.map(row => [
      csv(row.scene),
      num(row.flat?.falseFaceRiskMean),
      num(row.v1?.falseFaceRiskMean),
      num(row.v11?.falseFaceRiskMean),
      num(row.v12?.falseFaceRiskMean),
      num(row.v1MinusFlat),
      num(row.v11MinusFlat),
      num(row.v12MinusFlat),
      num(row.v12MinusV11),
      num(row.flat?.total),
      num(row.v1?.total),
      num(row.v11?.total),
      num(row.v12?.total),
    ].join(',')),
  ].join('\n');
}

function buildDeltaSummary(rows) {
  const scenes = ['landscape', 'documentary_moment'];
  const selected = rows.filter(row => scenes.includes(row.scene));
  const v1Delta = mean(selected.map(row => row.v1MinusFlat).filter(Number.isFinite));
  const v11Delta = mean(selected.map(row => row.v11MinusFlat).filter(Number.isFinite));
  const v12Delta = mean(selected.map(row => row.v12MinusFlat).filter(Number.isFinite));
  const v12MinusV11 = mean(selected.map(row => row.v12MinusV11).filter(Number.isFinite));
  const recall = recallTradeoff();
  const deltaComparable = false;
  const closureStatus = deltaComparable
    ? (
      Number.isFinite(v12Delta) && v12Delta < targetDelta && (recall?.recallDropVsV11 == null || recall.recallDropVsV11 <= maxRecallDropAt45)
        ? 'closed'
        : (Number.isFinite(v12Delta) && Number.isFinite(v11Delta) && v12Delta < v11Delta ? 'partial' : 'not_closed')
    )
    : 'not_closed';

  return {
    schemaVersion: 'framecull-false-face-closure-v12',
    createdAt: new Date().toISOString(),
    sourceFiles: {
      flatScenePath,
      v1ScenePath,
      v11ScenePath,
      v12ScenePath,
      v11RatioPath,
      v12RatioPath,
      v11PhotoPath,
      v12PhotoPath,
    },
    aggregation: 'weighted by dataset rows within each scene, then unweighted scene mean across landscape + documentary_moment',
    targetDeltaLt: targetDelta,
    maxRecallDropAt45,
    deltaComparable,
    studentLayerFullDatasetOriginalMetric: {
      scenes,
      v1Delta,
      v11Delta,
      v12Delta,
      v12MinusV11,
      v12PassesTarget: deltaComparable && Number.isFinite(v12Delta) ? v12Delta < targetDelta : false,
      v12RecallTradeoffAt45: recall,
      v12RecallDropWithinGateAt45: recall?.recallDropVsV11 != null ? recall.recallDropVsV11 <= maxRecallDropAt45 : null,
      closureStatus,
      closureEvidence: deltaComparable ? 'same-metric comparison available' : 'flat baseline uses 1-faceValidity while v12 uses independent falseFaceRisk head; delta is not comparable',
    },
    positiveValidation: buildPositiveValidation(),
    sceneRows: rows,
  };
}

function reportMarkdown(rows) {
  const summary = buildDeltaSummary(rows);
  const metric = summary.studentLayerFullDatasetOriginalMetric;
  const statusText = metric.closureStatus === 'closed'
    ? '已闭环'
    : (metric.closureStatus === 'partial' ? '部分闭环' : '未闭环');
  const recall = metric.v12RecallTradeoffAt45;
  const positive = summary.positiveValidation;

  const lines = [
    '# FrameCull Semantic False-Face v12 闭环验证报告',
    '',
    '## 结论',
    '',
    `v12 判定：**${statusText}**。`,
    '',
    `口径说明：v12 使用独立 \`falseFaceRisk\` 头，flat 仍是旧的 \`1-faceValidity\` 派生量，因此当前 \`grounded - flat\` delta **不可比**，不能拿 \`-0.1104\` 当闭环证据。`,
  ];

  if (recall) {
    lines.push(`45% recall trade-off：v11 = \`${pct(recall.v11Recall)}\`，v12 = \`${pct(recall.v12Recall)}\`，回退 = \`${pct(recall.recallDropVsV11)}\`，允许回退不超过 \`${pct(maxRecallDropAt45)}\``);
  }

  lines.push(
    '',
    '## 已补证',
    '',
    `- teacher hasRealHumanFace=false 样本：\`${positive.teacherFalseFaceCount}\``,
    `- 人工挑出的真·假脸强正样本：\`${positive.strongPositiveCount}\``,
    `- 其中 v12 高风险命中：\`${positive.strongPositiveHighRiskCount}\``,
    `- 其中 v12 漏判低风险：\`${positive.strongPositiveLowRiskCount}\``,
    `- 结论：v12 能抓住部分强正样本，但样本太少，不能证明它已经完整闭环。`,
  );

  lines.push(
    '',
    '## 数据来源',
    '',
    `- Flat: \`${flatScenePath}\``,
    `- Grounded v1: \`${v1ScenePath}\``,
    `- Grounded v11: \`${v11ScenePath}\``,
    `- Grounded v12: \`${v12ScenePath}\``,
    `- 对比表: \`${path.join(outputDir, 'false-face-scene-comparison-v12.csv')}\``,
    `- Delta 摘要: \`${path.join(outputDir, 'false-face-delta-summary-v12.json')}\``,
    '',
    '聚合口径：先在同一 scene 内按 `total` 对各 dataset 行做加权平均，再对 `landscape` 和 `documentary_moment` 两个 scene 做等权平均。',
    '',
    '## Scene 对比',
    '',
    '| Scene | Flat | Grounded v1 | Grounded v11 | Grounded v12 | v12 vs Flat | v12 vs v11 |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );

  for (const row of rows) {
    lines.push([
      row.scene,
      fmt(row.flat?.falseFaceRiskMean),
      fmt(row.v1?.falseFaceRiskMean),
      fmt(row.v11?.falseFaceRiskMean),
      fmt(row.v12?.falseFaceRiskMean),
      signed(row.v12MinusFlat),
      signed(row.v12MinusV11),
    ].join(' | ').replace(/^/, '| ').concat(' |'));
  }

  lines.push(
    '',
    '## 原始口径 Delta',
    '',
    '| Metric | v1 Grounded - Flat | v11 Grounded - Flat | v12 Grounded - Flat | 目标 | 结论 |',
    '|---|---:|---:|---:|---:|---|',
    `| landscape/documentary scene-mean false-face delta | ${signed(metric.v1Delta)} | ${signed(metric.v11Delta)} | ${signed(metric.v12Delta)} | < ${targetDelta} | ${metric.v12PassesTarget ? 'PASS' : 'N/A'} |`,
    '',
    '## 场景判断',
    '',
  );

  for (const scene of ['landscape', 'documentary_moment', 'product_object', 'event', 'group', 'portrait', 'other']) {
    const row = rows.find(item => item.scene === scene);
    if (!row) continue;
    lines.push(`- \`${scene}\`: v12 false-face risk = \`${fmt(row.v12?.falseFaceRiskMean)}\`，vs flat = \`${signed(row.v12MinusFlat)}\`，vs v11 = \`${signed(row.v12MinusV11)}\``);
  }

  lines.push(
    '',
    '## 诚实说明',
    '',
    metric.closureStatus === 'closed'
      ? '- v12 达到 false-face 原始口径目标，并且 45% recall 没有超过允许回退。可以进入下一轮产品候选验证。'
      : '- v12 方向正确，但闭环证据不足。现在只能写成“独立头有效、但不能宣称已完全闭环”。',
    '',
  );

  return lines.join('\n');
}

function recallTradeoff() {
  if (!existsSync(v11RatioPath) || !existsSync(v12RatioPath)) return null;
  const v11Rows = parseCsv(readFileSync(v11RatioPath, 'utf8').replace(/^\uFEFF/, ''));
  const v12Rows = parseCsv(readFileSync(v12RatioPath, 'utf8').replace(/^\uFEFF/, ''));
  const v11 = bestSemanticRecall(v11Rows, 0.45);
  const v12 = bestSemanticRecall(v12Rows, 0.45);
  if (v11 == null || v12 == null) return null;
  return { ratio: 0.45, v11Recall: v11, v12Recall: v12, recallDropVsV11: v11 - v12 };
}

function buildPositiveValidation() {
  const candidates = [
    { photoId: 'DSC08173', scene: 'event', teacherRisk: 0.9, note: 'teacher 强正样本，但 v12 低风险漏判' },
    { photoId: 'DSC08858', scene: 'other', teacherRisk: 0.9, note: 'teacher 强正样本，v12 也高风险命中' },
    { photoId: '_DSC0523', scene: 'group', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC0524', scene: 'group', teacherRisk: 0.05, note: 'teacher 轻正样本' },
    { photoId: '_DSC7706', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC0527', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC0169', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC7315', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC9871', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC9073', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC0531', scene: 'environmental_portrait', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC0533', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC0294', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC7347', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC7529', scene: 'documentary_moment', teacherRisk: 0.1, note: 'teacher 轻正样本' },
    { photoId: '_DSC8998', scene: 'landscape', teacherRisk: 0.05, note: 'teacher 轻正样本' },
    { photoId: '_DSC8999', scene: 'landscape', teacherRisk: 0.05, note: 'teacher 轻正样本' },
  ];
  const v12Map = loadRiskMap(v12PhotoPath);
  const v11Map = loadRiskMap(v11PhotoPath);
  const enriched = candidates.map(candidate => ({
    ...candidate,
    v11Risk: v11Map.get(candidate.photoId.toLowerCase()) ?? null,
    v12Risk: v12Map.get(candidate.photoId.toLowerCase()) ?? null,
  }));
  const strong = enriched.filter(item => item.teacherRisk >= 0.5);
  const strongPositiveHighRiskCount = strong.filter(item => Number.isFinite(item.v12Risk) && item.v12Risk >= 0.5).length;
  const strongPositiveLowRiskCount = strong.filter(item => Number.isFinite(item.v12Risk) && item.v12Risk < 0.1).length;
  const v12StrongRiskMean = mean(strong.map(item => item.v12Risk).filter(Number.isFinite));
  const v12WeakRiskMean = mean(enriched.filter(item => item.teacherRisk < 0.5).map(item => item.v12Risk).filter(Number.isFinite));
  return {
    teacherFalseFaceCount: 1632,
    teacherRiskGe005Count: 129,
    strongPositiveCount: strong.length,
    strongPositiveHighRiskCount,
    strongPositiveLowRiskCount,
    strongPositiveMeanV12Risk: v12StrongRiskMean,
    weakPositiveCount: enriched.length - strong.length,
    weakPositiveMeanV12Risk: v12WeakRiskMean,
    selectedSamples: enriched,
  };
}

function loadRiskMap(filePath) {
  if (!existsSync(filePath)) return new Map();
  const rows = parseCsv(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  const map = new Map();
  for (const row of rows) {
    const id = String(row.photo_id ?? '').trim().toLowerCase();
    const risk = toNumber(row.false_face_risk);
    if (!id || !Number.isFinite(risk)) continue;
    map.set(id, risk);
  }
  return map;
}

function positiveValidationMarkdown(validation) {
  const lines = [
    '# FrameCull v12 真·假脸正样本补证',
    '',
    '## 口径',
    '',
    '- 只看 teacher `hasRealHumanFace=false` 的样本。',
    '- 这里的“强正样本”指人工肉眼确认真的容易幻视人脸的图。',
    '- 目的不是再跑训练，而是区分“会判别”还是“只是贴低先验”。',
    '',
    '## 汇总',
    '',
    `- teacher hasRealHumanFace=false 样本：\`${validation.teacherFalseFaceCount}\``,
    `- teacher risk >= 0.05 的无人脸样本：\`${validation.teacherRiskGe005Count}\``,
    `- 人工补证强正样本：\`${validation.strongPositiveCount}\``,
    `- 其中 v12 risk >= 0.5：\`${validation.strongPositiveHighRiskCount}\``,
    `- 其中 v12 risk < 0.1：\`${validation.strongPositiveLowRiskCount}\``,
    `- 强正样本 v12 平均 risk：\`${fmt(validation.strongPositiveMeanV12Risk)}\``,
    `- 其余弱正样本 v12 平均 risk：\`${fmt(validation.weakPositiveMeanV12Risk)}\``,
    '',
    '## 结论',
    '',
    '- v12 对少数真强正样本有明显拉高，例如 `DSC08858`。',
    '- 但 `DSC08173` 这种同样 teacher 高风险的样本却被压得很低。',
    '- 所以当前更像是“方向正确的独立头”，还不是能宣称闭环的证据链。',
    '',
    '## 样本表',
    '',
    '| photoId | scene | teacherRisk | v11Risk | v12Risk | note |',
    '|---|---|---:|---:|---:|---|',
  ];

  for (const sample of validation.selectedSamples) {
    lines.push([
      sample.photoId,
      sample.scene,
      fmt(sample.teacherRisk),
      fmt(sample.v11Risk),
      fmt(sample.v12Risk),
      sample.note,
    ].join(' | ').replace(/^/, '| ').concat(' |'));
  }

  return lines.join('\n');
}

function positiveValidationCsv(validation) {
  const header = ['photoId', 'scene', 'teacherRisk', 'v11Risk', 'v12Risk', 'note'];
  const rows = validation.selectedSamples.map(sample => [
    csv(sample.photoId),
    csv(sample.scene),
    num(sample.teacherRisk),
    num(sample.v11Risk),
    num(sample.v12Risk),
    csv(sample.note),
  ].join(','));
  return [header.join(','), ...rows].join('\n');
}

function bestSemanticRecall(rows, ratio) {
  const matched = rows
    .map(row => ({ ratio: toNumber(row.ratio), recall: toNumber(row.recall), rankMode: String(row.rankMode ?? '') }))
    .filter(row => Math.abs(row.ratio - ratio) < 1e-9 && row.rankMode.startsWith('pro-semantic') && Number.isFinite(row.recall));
  if (!matched.length) return null;
  return Math.max(...matched.map(row => row.recall));
}

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

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return rows;
  const headers = splitCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function delta(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
}

function csv(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function num(value) {
  return Number.isFinite(value) ? String(value) : '';
}

function fmt(value) {
  return Number.isFinite(value) ? Number(value).toFixed(4) : 'n/a';
}

function signed(value) {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${Number(value).toFixed(4)}` : 'n/a';
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'n/a';
}
