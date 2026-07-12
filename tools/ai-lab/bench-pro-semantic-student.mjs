import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_AUDIT = path.resolve('output/ai-bench/ai-culling-bench-scene-aware-replay.json');
const DEFAULT_LABELS = path.resolve('D:/FrameCullRawAudit/raw-audit-previews/labels.json');
const DEFAULT_PREVIEW_DIR = process.platform === 'win32'
  ? path.resolve('D:/FrameCullRawAudit/raw-audit-previews')
  : '/data/FrameCullModelLab/incoming/raw-audit-previews';
const DEFAULT_OUTPUT = path.resolve('output/ai-bench/pro-semantic-student-eval');
const DEFAULT_MODEL = path.resolve('output/pro-models/semantic_student_v2_convnext/manifest.int8.json');
const DEFAULT_SELECTED_CONFIG = path.resolve('output/ai-bench/ratio-aware-ai-picks/selected-config-by-ratio.json');
const DEFAULT_PHASE0_ALL_IMAGES = path.resolve('/data/FrameCullModelLab/outputs/semantic-teacher-lab/phase0/all-images.json');
const DEFAULT_RATIOS = '0.38,0.45,0.50,0.60';

const args = parseArgs(process.argv.slice(2));
let auditPath = path.resolve(args.evalAudit ?? args.audit ?? DEFAULT_AUDIT);
let labelsPath = path.resolve(args.labels ?? DEFAULT_LABELS);
const previewDir = path.resolve(args.previewDir ?? DEFAULT_PREVIEW_DIR);
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT);
const manifestPath = path.resolve(args.manifest ?? DEFAULT_MODEL);
const selectedConfigPath = path.resolve(args.selectedConfig ?? DEFAULT_SELECTED_CONFIG);
const baselinePersonaInferPath = args.baselinePersonaInferJson ? path.resolve(args.baselinePersonaInferJson) : null;
const ratiosText = args.ratios ?? DEFAULT_RATIOS;
const ratios = ratiosText.split(',').map(Number).filter(Number.isFinite);
const cargoProfile = normalizeCargoProfile(args.cargoProfile ?? 'release');
const batchSize = Number(args.batchSize ?? 8);
const positiveThreshold = Number(args.positiveThreshold ?? 3);
const negativeThreshold = Number(args.negativeThreshold ?? 0);
const missingAsNegative = parseBoolean(args.missingAsNegative ?? 'true');
const datasetLabelPolicies = parseDatasetLabelPolicies(args.datasetLabelPolicies);
const buildEvalAudit = parseBoolean(args.buildEvalAudit ?? (args.phase0AllImages ? 'true' : 'false'));
const skipInfer = parseBoolean(args.skipInfer ?? (args.inferJson ? 'true' : 'false'));

await mkdir(outputDir, { recursive: true });

let evalMeta = null;
if (buildEvalAudit) {
  const generatedAuditPath = path.resolve(args.evalAudit ?? path.join(outputDir, 'ai-culling-bench-pro-semantic-eval-input.json'));
  const generatedLabelsPath = path.resolve(args.evalLabels ?? args.labels ?? path.join(outputDir, 'pro-semantic-eval-labels.json'));
  const generatedMetaPath = path.resolve(args.evalMeta ?? path.join(outputDir, 'pro-semantic-eval-input-meta.json'));
  const buildArgs = [
    'tools/ai-lab/build-pro-semantic-eval-audit.mjs',
    '--audit3groups-audit', path.resolve(args.audit3groupsAudit ?? args.audit ?? DEFAULT_AUDIT),
    '--phase0-all-images', path.resolve(args.phase0AllImages ?? DEFAULT_PHASE0_ALL_IMAGES),
    '--output', generatedAuditPath,
    '--labels-output', generatedLabelsPath,
    '--meta-output', generatedMetaPath,
    '--include-camera', String(parseBoolean(args.includeCamera ?? 'true')),
  ];
  if (args.includeAudit3groups != null) buildArgs.push('--include-audit3groups', String(parseBoolean(args.includeAudit3groups)));
  if (args.includeFiveMountain != null) buildArgs.push('--include-five-mountain', String(parseBoolean(args.includeFiveMountain)));
  if (args.fiveMountainLabels) buildArgs.push('--five-mountain-labels', path.resolve(args.fiveMountainLabels));
  if (args.fiveMountainPreviewDir) buildArgs.push('--five-mountain-preview-dir', path.resolve(args.fiveMountainPreviewDir));
  await runNode(buildArgs);
  auditPath = generatedAuditPath;
  labelsPath = generatedLabelsPath;
  evalMeta = JSON.parse(await readFile(generatedMetaPath, 'utf8'));
}

await copyOrPlaceholder(args.teacherQualityReport, path.join(outputDir, 'teacher-quality-report.md'), 'Teacher quality report was not supplied to this bench run.');
await copyOrPlaceholder(args.teacherLicenseReport, path.join(outputDir, 'teacher-license-clearance.md'), 'Teacher license clearance was not supplied to this bench run. Full annotation must not start without a real clearance report.');
await copyManifest(manifestPath, path.join(outputDir, 'selected-model-manifest.json'));

const inferJsonPath = path.join(outputDir, 'pro-infer-latency.json');
if (skipInfer) {
  const sourceInfer = path.resolve(args.inferJson ?? inferJsonPath);
  if (sourceInfer !== inferJsonPath) await copyFile(sourceInfer, inferJsonPath);
  console.log(`[pro-semantic] Reusing infer JSON: ${sourceInfer}`);
} else {
  const cargoArgs = [
    'run',
    '--manifest-path', 'src-tauri/Cargo.toml',
    '--features', 'pro-bench',
    '--bin', 'pro-infer-bench',
  ];
  if (cargoProfile === 'release') cargoArgs.push('--release');
  cargoArgs.push(
    '--',
    '--audit', auditPath,
    '--manifest', manifestPath,
    '--output', inferJsonPath,
    '--preview-dir', previewDir,
    '--batch-size', String(batchSize),
  );
  if (args.limit) cargoArgs.push('--limit', String(Number(args.limit)));

  console.log(`[pro-semantic] Running native infer bench: ${manifestPath}`);
  console.log(`[pro-semantic] Cargo profile: ${cargoProfile}`);
  await runCargo(cargoArgs);
}

const infer = JSON.parse(await readFile(inferJsonPath, 'utf8'));
const audit = JSON.parse(await readFile(auditPath, 'utf8'));
const baselinePersonaInfer = baselinePersonaInferPath && existsSync(baselinePersonaInferPath)
  ? JSON.parse(await readFile(baselinePersonaInferPath, 'utf8'))
  : null;
if (!evalMeta && audit.proSemanticEvalMeta) {
  evalMeta = audit.proSemanticEvalMeta;
}
if (!evalMeta && args.evalMeta && existsSync(path.resolve(args.evalMeta))) {
  evalMeta = JSON.parse(await readFile(path.resolve(args.evalMeta), 'utf8'));
}

const scoreById = new Map((infer.results ?? []).map(row => [row.photoId, row]));
const baselinePersonaById = new Map((baselinePersonaInfer?.results ?? []).map(row => [row.photoId, row]));
for (const summary of audit.photoSummaries ?? []) {
  const row = scoreById.get(summary.id);
  if (!row) continue;
  summary.proAesthetic = row.aesthetic;
  summary.proPersonaScore = row.personaScore;
  summary.proSceneLabel = row.sceneLabel;
  summary.proSceneConfidence = row.sceneConfidence;
  summary.proSemanticKeepScore = row.semanticKeepScore;
  summary.proFaceValidityScore = row.faceValidityScore;
  summary.proCompositionScore = row.compositionScore;
  summary.proMomentScore = row.momentScore;
  summary.proLightingMoodScore = row.lightingMoodScore;
  summary.proFalseFaceRisk = row.falseFaceRisk;
  summary.proActiveEp = infer.activeEp;
  summary.proManifestPath = infer.manifestPath;
  const baselineRow = baselinePersonaById.get(summary.id);
  if (baselineRow) {
    summary.baselineProAesthetic = baselineRow.aesthetic;
    summary.baselineProPersonaScore = baselineRow.personaScore;
    summary.baselineProSceneLabel = baselineRow.sceneLabel;
    summary.baselineProSceneConfidence = baselineRow.sceneConfidence;
    summary.baselineProActiveEp = baselinePersonaInfer.activeEp;
    summary.baselineProManifestPath = baselinePersonaInfer.manifestPath;
  }
}

const mergedAuditPath = path.join(outputDir, 'ai-culling-bench-pro-semantic.json');
await writeFile(mergedAuditPath, JSON.stringify(audit, null, 2), 'utf8');
await writeFile(path.join(outputDir, 'eval-run-meta.json'), JSON.stringify(await buildEvalRunMeta({
  manifestPath,
  inferJsonPath,
  mergedAuditPath,
  labelsPath,
  evalMeta,
  infer,
  batchSize,
  datasetLabelPolicies,
}), null, 2), 'utf8');

const selectedConfig = existsSync(selectedConfigPath)
  ? JSON.parse(await readFile(selectedConfigPath, 'utf8'))
  : null;
const fixedConfigs = buildFixedConfigs(selectedConfig, ratios);
const fixedConfigPath = path.join(outputDir, 'semantic-ab-configs.json');
await writeFile(fixedConfigPath, JSON.stringify({ configs: fixedConfigs }, null, 2), 'utf8');
const candidateCsvPath = path.resolve(args.candidates ?? path.join(outputDir, 'semantic-empty-candidates.csv'));
if (!existsSync(candidateCsvPath)) {
  await writeFile(candidateCsvPath, 'photo_id\n', 'utf8');
}

const tuneArgs = [
  'tools/ai-lab/tune-ai-picks-supervised.mjs',
  '--audit', mergedAuditPath,
  '--candidates', candidateCsvPath,
  '--labels', labelsPath,
  '--output', outputDir,
  '--ratios', ratiosText,
  '--mode', 'ratio-aware',
  '--config-file', fixedConfigPath,
  '--positive-threshold', String(positiveThreshold),
  '--negative-threshold', String(negativeThreshold),
  '--missing-as-negative', missingAsNegative ? 'true' : 'false',
  '--dataset-label-policies', JSON.stringify(datasetLabelPolicies),
];
await runNode(tuneArgs);

await writeFile(path.join(outputDir, 'pro-infer-latency.csv'), latencyCsv(infer), 'utf8');
await writeFile(path.join(outputDir, 'metrics-by-scene.csv'), sceneMetricsCsv(audit, labelsPath, {
  positiveThreshold,
  negativeThreshold,
  missingAsNegative,
  datasetLabelPolicies,
}), 'utf8');
await writeFile(path.join(outputDir, 'false-face-samples.csv'), falseFaceSamplesCsv(infer), 'utf8');
await writeFile(path.join(outputDir, 'grounded-vs-flat-ablation.md'), groundedAblationMarkdown(args.flatScalarOutput, outputDir), 'utf8');
await writeFile(path.join(outputDir, 'production-recommendation.md'), await productionRecommendation(outputDir), 'utf8');
await writeFile(path.join(outputDir, 'summary.md'), await summaryMarkdown(infer, outputDir, evalMeta), 'utf8');

console.log('[pro-semantic] Eval complete.');
console.log(`[pro-semantic] Merged audit: ${mergedAuditPath}`);
console.log(`[pro-semantic] Summary: ${path.join(outputDir, 'summary.md')}`);

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
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function parseDatasetLabelPolicies(value) {
  if (!value) {
    return {
      audit3groups: { positiveThreshold: 3, negativeThreshold: 0, missingAsNegative: true },
      camera: { positiveThreshold: 1, negativeThreshold: 0, missingAsNegative: true },
    };
  }
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

function normalizeCargoProfile(value) {
  return String(value ?? '').trim().toLowerCase() === 'dev' ? 'dev' : 'release';
}

function runCargo(cargoArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', cargoArgs, { cwd: process.cwd(), stdio: 'inherit', shell: false });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`cargo exited with code ${code}`)));
  });
}

function runNode(nodeArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, { cwd: process.cwd(), stdio: 'inherit', shell: false });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`node exited with code ${code}`)));
  });
}

async function copyOrPlaceholder(source, target, message) {
  if (source && existsSync(path.resolve(source))) {
    await copyFile(path.resolve(source), target);
    return;
  }
  await writeFile(target, [`# Missing Upstream Report`, '', message, ''].join('\n'), 'utf8');
}

async function copyManifest(source, target) {
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  await writeFile(target, JSON.stringify(manifest, null, 2), 'utf8');
}

async function buildEvalRunMeta({
  manifestPath,
  inferJsonPath,
  mergedAuditPath,
  labelsPath,
  evalMeta,
  infer,
  batchSize,
  datasetLabelPolicies,
}) {
  const exportDir = path.dirname(manifestPath);
  const trainingReportPath = path.join(exportDir, 'training-report.json');
  const trainingReport = await safeReadJson(trainingReportPath);
  const phase0AllImagesPath = evalMeta?.phase0AllImagesPath ? path.resolve(evalMeta.phase0AllImagesPath) : null;
  const phase0AllImages = phase0AllImagesPath && existsSync(phase0AllImagesPath)
    ? JSON.parse(await readFile(phase0AllImagesPath, 'utf8'))
    : null;
  const phase0TeacherItemCount = Array.isArray(phase0AllImages)
    ? phase0AllImages.filter(item => item?.teacherImagePath).length
    : null;
  return {
    schemaVersion: 'framecull-pro-semantic-eval-run-meta-v1',
    createdAt: new Date().toISOString(),
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    exportDir,
    trainingReportPath,
    trainingReportSha256: trainingReport ? await sha256File(trainingReportPath) : null,
    semanticTeacherPath: trainingReport?.semanticTeacher ?? null,
    semanticTeacherSha256: trainingReport?.semanticTeacherSha256 ?? null,
    semanticTeacherRecordCount: Number.isFinite(Number(trainingReport?.semanticTeacherRecordCount))
      ? Number(trainingReport.semanticTeacherRecordCount)
      : null,
    teacherFlatScalar: trainingReport?.teacherFlatScalar ?? null,
    phase0AllImagesPath,
    phase0AllImagesSha256: phase0AllImagesPath && existsSync(phase0AllImagesPath) ? await sha256File(phase0AllImagesPath) : null,
    phase0TeacherItemCount,
    evalAuditPath: mergedAuditPath,
    evalAuditSha256: await sha256File(mergedAuditPath),
    labelsPath,
    labelsSha256: existsSync(labelsPath) ? await sha256File(labelsPath) : null,
    inferJsonPath,
    inferJsonSha256: await sha256File(inferJsonPath),
    resultCount: Array.isArray(infer?.results) ? infer.results.length : 0,
    batchSize,
    activeEp: infer?.activeEp ?? null,
    datasetLabelPolicies,
  };
}

async function safeReadJson(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function buildFixedConfigs(selectedConfig, ratioValues) {
  const profiles = Array.isArray(selectedConfig?.recommendation?.profiles)
    ? selectedConfig.recommendation.profiles
    : [];
  const profileByRatio = new Map(
    profiles
      .map(profile => [Number(profile.ratio), profile.config])
      .filter(([, config]) => config && Number.isFinite(Number(config.ratio))),
  );
  const variants = [
    'current',
    'pro-persona-v1',
    'pro-semantic-v2-persona-only',
    'pro-semantic-v2-semantic-only',
    'pro-semantic-v2-fused',
    'pro-semantic-v2-face-guard',
    'pro-semantic-v2-flat-scalar',
  ];
  const configs = [];
  for (const ratio of ratioValues) {
    const base = profileByRatio.get(ratio) ?? fallbackConfig(ratio);
    for (const variant of variants) configs.push(configVariant(base, ratio, variant));
  }
  return configs;
}

function fallbackConfig(ratio) {
  return {
    name: `fallback-r${ratio}`,
    family: 'pro-semantic-student-experimental',
    ratio,
    rankMode: ratio >= 0.6 ? 'ratio-recall' : 'scene-rescue',
    gateMode: 'hard-only',
    burstRadius: 0,
    maxBurstSize: ratio <= 0.45 ? 4 : 5,
    useKnownGroups: true,
    groupMode: 'pair-threshold',
    similarityThreshold: ratio <= 0.45 ? 0.84 : 0.92,
    maxNumericGap: ratio <= 0.45 ? 18 : 12,
    maxTimeGapMs: ratio <= 0.45 ? 1800000 : 480000,
    requireCandidate: ratio <= 0.45,
    inferAdjacentBursts: false,
  };
}

function configVariant(base, ratio, variant) {
  const config = { ...base, ratio };
  if (variant === 'current') {
    return { ...config, name: `ab-current-r${ratio}`, family: 'current-production-rules', rankMode: 'current' };
  }
  if (variant === 'pro-persona-v1') {
    return { ...config, name: `ab-pro-persona-v1-r${ratio}`, family: 'pro-persona-experimental', rankMode: 'pro-persona' };
  }
  return {
    ...config,
    name: `ab-${variant}-r${ratio}`,
    family: 'pro-semantic-student-experimental',
    rankMode: variant,
  };
}

function latencyCsv(infer) {
  const rows = [[
    'photo_id', 'image_path', 'aesthetic', 'persona_score', 'scene_label', 'scene_confidence',
    'semantic_keep_score', 'face_validity_score', 'composition_score', 'moment_score',
    'lighting_mood_score', 'false_face_risk', 'error',
  ].join(',')];
  for (const row of infer.results ?? []) {
    rows.push([
      csv(row.photoId),
      csv(row.imagePath),
      num(row.aesthetic),
      num(row.personaScore),
      csv(row.sceneLabel),
      num(row.sceneConfidence),
      num(row.semanticKeepScore),
      num(row.faceValidityScore),
      num(row.compositionScore),
      num(row.momentScore),
      num(row.lightingMoodScore),
      num(row.falseFaceRisk),
      csv(row.error),
    ].join(','));
  }
  return rows.join('\n');
}

function sceneMetricsCsv(audit, labelsPath, labelPolicy) {
  let labels = {};
  try {
    const raw = JSON.parse(readFileSync(labelsPath, 'utf8'));
    labels = raw.labels ?? raw.records ?? raw;
  } catch {
    labels = {};
  }
  const byScene = new Map();
  for (const summary of audit.photoSummaries ?? []) {
    const scene = summary.proSceneLabel ?? 'unknown';
    const dataset = inferDataset(summary);
    const policy = labelPolicyForDataset(dataset, labelPolicy);
    const ratingRaw = labels[summary.id]?.rating ?? labels[summary.id] ?? summary.groundTruthRating;
    const rating = Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : (policy.missingAsNegative ? 0 : undefined);
    const key = `${dataset}::${scene}`;
    const row = byScene.get(key) ?? {
      dataset,
      scene,
      positiveThreshold: policy.positiveThreshold,
      negativeThreshold: policy.negativeThreshold,
      total: 0,
      labeled: 0,
      positives: 0,
      negatives: 0,
      keepMean: [],
      falseFaceRiskMean: [],
    };
    row.total += 1;
    if (rating !== undefined) {
      row.labeled += 1;
      if (rating >= policy.positiveThreshold) row.positives += 1;
      if (rating <= policy.negativeThreshold) row.negatives += 1;
    }
    if (Number.isFinite(Number(summary.proSemanticKeepScore))) row.keepMean.push(Number(summary.proSemanticKeepScore));
    if (Number.isFinite(Number(summary.proFalseFaceRisk))) row.falseFaceRiskMean.push(Number(summary.proFalseFaceRisk));
    byScene.set(key, row);
  }
  const rows = [['dataset', 'scene', 'positive_threshold', 'negative_threshold', 'total', 'labeled', 'positives', 'negatives', 'semantic_keep_mean', 'false_face_risk_mean']];
  for (const row of [...byScene.values()].sort((a, b) => b.total - a.total)) {
    rows.push([
      csv(row.dataset),
      csv(row.scene),
      row.positiveThreshold,
      row.negativeThreshold,
      row.total,
      row.labeled,
      row.positives,
      row.negatives,
      num(mean(row.keepMean)),
      num(mean(row.falseFaceRiskMean)),
    ]);
  }
  return rows.map(row => row.join(',')).join('\n');
}

function inferDataset(summary) {
  const explicit = summary.dataset ?? summary.sourceDataset ?? summary.proDataset;
  if (explicit) return String(explicit);
  const source = String(summary.sourceFolder ?? summary.sourceName ?? summary.fileName ?? summary.id ?? '').toLowerCase();
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

function falseFaceSamplesCsv(infer) {
  const rows = [['photo_id', 'image_path', 'false_face_risk', 'face_validity_score', 'scene_label', 'error'].join(',')];
  const sorted = [...(infer.results ?? [])]
    .filter(row => Number.isFinite(Number(row.falseFaceRisk)))
    .sort((a, b) => Number(b.falseFaceRisk) - Number(a.falseFaceRisk))
    .slice(0, 200);
  for (const row of sorted) {
    rows.push([csv(row.photoId), csv(row.imagePath), num(row.falseFaceRisk), num(row.faceValidityScore), csv(row.sceneLabel), csv(row.error)].join(','));
  }
  return rows.join('\n');
}

function groundedAblationMarkdown(flatScalarOutput, currentOutputDir) {
  const lines = ['# Grounded vs Flat-Scalar Ablation', ''];
  lines.push(`- Grounded output: \`${currentOutputDir}\``);
  if (flatScalarOutput && existsSync(path.resolve(flatScalarOutput))) {
    lines.push(`- Flat-scalar output: \`${path.resolve(flatScalarOutput)}\``);
    lines.push('');
    lines.push('Compare `metrics-by-ratio.csv`, `metrics-by-scene.csv`, and `false-face-samples.csv` between these two directories. Grounded labels should win on scenic/documentary recall and false-face risk before product adoption.');
  } else {
    lines.push('- Flat-scalar output: not supplied in this run.');
    lines.push('');
    lines.push('This file is a placeholder until the flat-scalar arm is run with the same teacher/images.');
  }
  return lines.join('\n');
}

async function productionRecommendation(outDir) {
  const selectedPath = path.join(outDir, 'selected-config-by-ratio.json');
  let selected = null;
  if (existsSync(selectedPath)) selected = JSON.parse(await readFile(selectedPath, 'utf8'));
  const ratioRows = await loadRatioRows(path.join(outDir, 'metrics-by-ratio.csv'));
  const analysis = analyzeSemanticBench(ratioRows);
  return [
    '# Production Recommendation',
    '',
    'This Semantic Student run is Pro-only experimental evidence. It must not change Flash or default AI Pick behavior until all gates pass.',
    '',
    '## Current Result',
    '',
    '```json',
    JSON.stringify(selected?.recommendation ?? selected ?? { status: 'pending' }, null, 2),
    '```',
    '',
    '## Bench Verdict',
    '',
    ...semanticBenchVerdict(analysis),
    '',
    '## Ratio Snapshot',
    '',
    ...semanticBenchTable(analysis),
    '',
    '## Gate',
    '',
    '- Enter Pro gated ranking only if low-ratio recall or 4/5-star coverage improves without worse duplicate pollution, hard issue picks, or false-face errors.',
  ].join('\n');
}

async function summaryMarkdown(infer, outDir, evalMeta) {
  let selected = null;
  const selectedPath = path.join(outDir, 'selected-config-by-ratio.json');
  if (existsSync(selectedPath)) selected = JSON.parse(await readFile(selectedPath, 'utf8'));
  const ratioRows = await loadRatioRows(path.join(outDir, 'metrics-by-ratio.csv'));
  const analysis = analyzeSemanticBench(ratioRows);
  const lines = [
    '# FrameCull Pro Semantic Student Eval',
    '',
    `- Audit: \`${auditPath}\``,
    `- Labels: \`${labelsPath}\``,
    `- Preview dir: \`${previewDir}\``,
    `- Manifest: \`${manifestPath}\``,
    `- Baseline persona infer: \`${baselinePersonaInferPath && existsSync(baselinePersonaInferPath) ? baselinePersonaInferPath : 'not supplied'}\``,
    `- Cargo profile: \`${cargoProfile}\``,
    `- Backbone: \`${infer.backboneVersion ?? 'unknown'}\``,
    `- Active EP: \`${infer.activeEp}\``,
    `- EP fallback chain: \`${Array.isArray(infer.epFallbackChain) ? infer.epFallbackChain.join(' | ') : 'n/a'}\``,
    `- Warmup: \`${formatMs(infer.warmupMs)}\``,
    `- Batch size: \`${infer.batchSize}\``,
    `- Images: \`${infer.count}\``,
    `- Mean latency / image: \`${formatMs(infer.meanPerImageMs)}\``,
    `- Total elapsed: \`${formatMs(infer.elapsedMs)}\``,
    `- Ratios: \`${ratiosText}\``,
    `- Label policy: ${labelPolicySummary({ positiveThreshold, negativeThreshold, missingAsNegative, datasetLabelPolicies })}`,
  ];
  if (evalMeta) {
    lines.push(
      `- Evaluation scope: \`${evalMeta.evaluationScope ?? 'unknown'}\``,
      `- Evaluation warning: ${evalMeta.warning ?? 'n/a'}`,
      `- Dataset stats: \`${JSON.stringify(evalMeta.stats ?? {})}\``,
    );
  }
  lines.push(
    '',
    '## Recommendation Snapshot',
    '',
    '```json',
    JSON.stringify(selected?.recommendation ?? selected ?? { status: 'pending' }, null, 2),
    '```',
  );
  if (analysis.rows.length) {
    lines.push(
      '',
      '## Model Comparison',
      '',
      ...semanticBenchTable(analysis),
    );
  }
  lines.push(
    '',
    '## Files',
    '',
    '- `teacher-quality-report.md`',
    '- `teacher-license-clearance.md`',
    '- `metrics-by-ratio.csv`',
    '- `metrics-by-scene.csv`',
    '- `false-negatives-by-ratio.csv`',
    '- `duplicate-pollution-by-ratio.csv`',
    '- `false-face-samples.csv`',
    '- `grounded-vs-flat-ablation.md`',
    '- `pro-infer-latency.csv`',
    '- `selected-config-by-ratio.json`',
    '- `selected-model-manifest.json`',
    '- `production-recommendation.md`',
  );
  return lines.join('\n');
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function labelPolicySummary(policy) {
  const fallback = `fallback \`rating >= ${policy.positiveThreshold}\` keep, \`rating <= ${policy.negativeThreshold}\` reject, \`missing => ${policy.missingAsNegative ? 'reject' : 'ignored'}\``;
  const datasetEntries = Object.entries(policy.datasetLabelPolicies ?? {});
  if (datasetEntries.length === 0) return fallback;
  const datasets = datasetEntries.map(([dataset, datasetPolicy]) => {
    const positive = datasetPolicy.positiveThreshold ?? datasetPolicy.positive_threshold ?? policy.positiveThreshold;
    const negative = datasetPolicy.negativeThreshold ?? datasetPolicy.negative_threshold ?? policy.negativeThreshold;
    const missing = datasetPolicy.missingAsNegative ?? datasetPolicy.missing_as_negative ?? policy.missingAsNegative;
    return `\`${dataset}: rating >= ${positive}, rating <= ${negative}, missing => ${missing ? 'reject' : 'ignored'}\``;
  });
  return `${datasets.join('; ')}; ${fallback}`;
}

function csv(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function num(value) {
  if (value == null || value === '') return '';
  return Number.isFinite(Number(value)) ? String(Number(value)) : '';
}

function formatMs(value) {
  return `${Number(value ?? 0).toFixed(2)} ms`;
}

async function loadRatioRows(filePath) {
  if (!existsSync(filePath)) return [];
  return parseCsv(await readFile(filePath, 'utf8')).map(normalizeRatioRow);
}

function analyzeSemanticBench(rows) {
  const ratios = [...new Set(rows.map(row => row.ratio).filter(Number.isFinite))].sort((a, b) => a - b);
  const analyzed = ratios.map(ratio => {
    const current = bestBenchRow(rows, row => row.rankMode === 'current', ratio);
    const persona = bestBenchRow(rows, row => row.rankMode === 'pro-persona', ratio);
    const semantic = bestBenchRow(rows, row => isSemanticRankMode(row.rankMode), ratio);
    return { ratio, current, persona, semantic };
  }).filter(row => row.current || row.persona || row.semantic);
  const lowRatioRows = analyzed.filter(row => row.ratio <= 0.5 + 1e-9);
  const gatePassingRows = lowRatioRows.filter(row => semanticPassesGate(row));
  const semanticBeatsPersonaRows = analyzed.filter(row => row.semantic && row.persona && deltaNumber(row.semantic.recall, row.persona.recall) > 0);
  return {
    rows: analyzed,
    gatePassingRows,
    semanticBeatsPersonaRows,
  };
}

function semanticBenchVerdict(analysis) {
  if (!analysis.rows.length) {
    return ['- 当前目录还没有可解析的 `metrics-by-ratio.csv`，暂时无法给出 semantic student 的产品建议。'];
  }
  const lines = [];
  if (analysis.gatePassingRows.length === 0) {
    lines.push('- 这轮 Semantic Student V2 还没有在低比例档位稳定达到进入 Pro 的门槛，当前结论仍是“保留实验态”。');
  } else {
    const ratios = analysis.gatePassingRows.map(row => formatRatio(row.ratio)).join(' / ');
    lines.push(`- Semantic Student V2 在低比例档位中通过门槛的比例有：${ratios}。它可以继续作为 Pro 实验候选，但还不能直接改默认路线。`);
  }
  if (analysis.semanticBeatsPersonaRows.length === 0) {
    lines.push('- 当前各比例的最终胜者仍是 `pro-persona-v1`，说明 semantic teacher/student 已经有增益，但还没有超过现有 persona 路线。');
  } else {
    const ratios = analysis.semanticBeatsPersonaRows.map(row => formatRatio(row.ratio)).join(' / ');
    lines.push(`- Semantic Student V2 已在这些比例上超过 \`pro-persona-v1\`：${ratios}。这些比例值得优先做下一轮融合或 gated A/B。`);
  }
  const strongest = analysis.rows
    .filter(row => row.semantic?.recall != null && row.current?.recall != null)
    .map(row => ({
      ratio: row.ratio,
      semantic: row.semantic,
      current: row.current,
      recallDelta: deltaNumber(row.semantic?.recall, row.current?.recall),
      negativeDelta: deltaNumber(row.semantic?.negativePickRate, row.current?.negativePickRate),
    }))
    .sort((left, right) => (right.recallDelta ?? -Infinity) - (left.recallDelta ?? -Infinity))[0];
  if (strongest) {
    lines.push(`- 当前 semantic 提升最明显的是 ${formatRatio(strongest.ratio)}：相对当前生产规则召回 ${formatSignedPercent(strongest.recallDelta)}，负样本混入 ${formatSignedPercent(strongest.negativeDelta)}。`);
  }
  return lines;
}

function semanticBenchTable(analysis) {
  if (!analysis.rows.length) {
    return ['- 暂无比例对照数据。'];
  }
  const lines = [
    '| Ratio | Current Recall | Pro Persona Recall | Best Semantic | Semantic Recall | Δ vs Current | Δ vs Persona | Semantic Negative Pick |',
    '|---|---:|---:|---|---:|---:|---:|---:|',
  ];
  for (const row of analysis.rows) {
    lines.push([
      formatRatio(row.ratio),
      formatPercent(row.current?.recall),
      formatPercent(row.persona?.recall),
      row.semantic?.name ?? 'n/a',
      formatPercent(row.semantic?.recall),
      formatSignedPercent(deltaNumber(row.semantic?.recall, row.current?.recall)),
      formatSignedPercent(deltaNumber(row.semantic?.recall, row.persona?.recall)),
      formatPercent(row.semantic?.negativePickRate),
    ].join(' | ').replace(/^/, '| ').concat(' |'));
  }
  return lines;
}

function bestBenchRow(rows, predicate, ratio) {
  return rows
    .filter(row => predicate(row) && nearlyEqual(row.ratio, ratio))
    .sort((left, right) => {
      const recallDelta = (right.recall ?? -Infinity) - (left.recall ?? -Infinity);
      if (Math.abs(recallDelta) > 1e-9) return recallDelta;
      const negativeDelta = (left.negativePickRate ?? Infinity) - (right.negativePickRate ?? Infinity);
      if (Math.abs(negativeDelta) > 1e-9) return negativeDelta;
      return (left.selectedSimilarAdjacentPairs ?? Infinity) - (right.selectedSimilarAdjacentPairs ?? Infinity);
    })[0] ?? null;
}

function isSemanticRankMode(rankMode) {
  return typeof rankMode === 'string'
    && rankMode.startsWith('pro-semantic-v2-')
    && rankMode !== 'pro-semantic-v2-flat-scalar';
}

function semanticPassesGate(row) {
  if (!row.current || !row.semantic) return false;
  const recallDelta = deltaNumber(row.semantic.recall, row.current.recall);
  const negativeDelta = deltaNumber(row.semantic.negativePickRate, row.current.negativePickRate);
  const semanticDup = Number(row.semantic.formalDuplicateGroupsWithMultiplePicks ?? 0);
  const currentDup = Number(row.current.formalDuplicateGroupsWithMultiplePicks ?? 0);
  return recallDelta != null
    && recallDelta >= 0.05
    && negativeDelta != null
    && negativeDelta <= 0.02
    && semanticDup <= currentDup;
}

function normalizeRatioRow(row) {
  return {
    ...row,
    ratio: toNumber(row.ratio),
    recall: toNumber(row.recall),
    negativePickRate: toNumber(row.negativePickRate),
    selectedSimilarAdjacentPairs: toNumber(row.selectedSimilarAdjacentPairs),
    formalDuplicateGroupsWithMultiplePicks: toNumber(row.formalDuplicateGroupsWithMultiplePicks),
    selected: toBoolean(row.selected),
  };
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === ',') {
      values.push(current);
      current = '';
    } else if (char === '"') {
      quoted = true;
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function toBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function nearlyEqual(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
}

function deltaNumber(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : undefined;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}
