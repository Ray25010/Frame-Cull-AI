import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_AUDIT = path.resolve('output/ai-bench/ai-culling-bench-scene-aware-replay.json');
const DEFAULT_LABELS = path.resolve('D:/FrameCullRawAudit/raw-audit-previews/labels.json');
const DEFAULT_PREVIEW_DIR = path.resolve('D:/FrameCullRawAudit/raw-audit-previews');
const DEFAULT_OUTPUT = path.resolve('output/ai-bench/pro-persona-eval');
const DEFAULT_MODEL = path.resolve('output/pro-models/convnext_persona_v1_linear_int8_final/manifest.int8.json');
const DEFAULT_SELECTED_CONFIG = path.resolve('output/ai-bench/ratio-aware-ai-picks/selected-config-by-ratio.json');
const DEFAULT_RATIOS = '0.38,0.45,0.50,0.60';
const DEFAULT_POSITIVE_THRESHOLD = 1;
const DEFAULT_NEGATIVE_THRESHOLD = 0;
const DEFAULT_CARGO_PROFILE = 'release';

const args = parseArgs(process.argv.slice(2));
const auditPath = path.resolve(args.audit ?? DEFAULT_AUDIT);
const labelsPath = path.resolve(args.labels ?? DEFAULT_LABELS);
const previewDir = path.resolve(args.previewDir ?? DEFAULT_PREVIEW_DIR);
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT);
const manifestPath = path.resolve(args.manifest ?? DEFAULT_MODEL);
const selectedConfigPath = path.resolve(args.selectedConfig ?? DEFAULT_SELECTED_CONFIG);
const ratiosText = args.ratios ?? DEFAULT_RATIOS;
const ratios = ratiosText.split(',').map(Number).filter(Number.isFinite);
const mode = args.mode ?? 'cpu';
const batchSize = Number(args.batchSize ?? (mode === 'cpu' ? 1 : 8));
const positiveThreshold = Number(args.positiveThreshold ?? DEFAULT_POSITIVE_THRESHOLD);
const negativeThreshold = Number(args.negativeThreshold ?? DEFAULT_NEGATIVE_THRESHOLD);
const missingAsNegative = parseBoolean(args.missingAsNegative ?? 'true');
const cargoProfile = normalizeCargoProfile(args.cargoProfile ?? DEFAULT_CARGO_PROFILE);

await mkdir(outputDir, { recursive: true });

const cargoArgs = [
  'run',
  '--manifest-path', 'src-tauri/Cargo.toml',
  '--features', 'pro-bench',
  '--bin', 'pro-infer-bench',
];

if (cargoProfile === 'release') {
  cargoArgs.push('--release');
}

cargoArgs.push(
  '--',
  '--audit', auditPath,
  '--manifest', manifestPath,
  '--output', path.join(outputDir, 'pro-infer-latency.json'),
  '--preview-dir', previewDir,
  '--batch-size', String(batchSize),
);

if (args.limit) cargoArgs.push('--limit', String(Number(args.limit)));

console.log(`[pro-persona] Running native infer bench: ${manifestPath}`);
console.log(`[pro-persona] Cargo profile: ${cargoProfile}`);
await runCargo(cargoArgs);

const inferJsonPath = path.join(outputDir, 'pro-infer-latency.json');
const infer = JSON.parse(await readFile(inferJsonPath, 'utf8'));
const audit = JSON.parse(await readFile(auditPath, 'utf8'));

const scoreById = new Map((infer.results ?? []).map(row => [row.photoId, row]));
for (const summary of audit.photoSummaries ?? []) {
  const row = scoreById.get(summary.id);
  if (!row) continue;
  summary.proAesthetic = row.aesthetic;
  summary.proPersonaScore = row.personaScore;
  summary.proSceneLabel = row.sceneLabel;
  summary.proSceneConfidence = row.sceneConfidence;
  summary.proActiveEp = infer.activeEp;
  summary.proManifestPath = infer.manifestPath;
}

const mergedAuditPath = path.join(outputDir, 'ai-culling-bench-pro-persona.json');
await writeFile(mergedAuditPath, JSON.stringify(audit, null, 2), 'utf8');

const selectedConfig = existsSync(selectedConfigPath)
  ? JSON.parse(await readFile(selectedConfigPath, 'utf8'))
  : null;
const fixedConfigs = buildFixedConfigs(selectedConfig, ratios);
const fixedConfigPath = path.join(outputDir, 'persona-ab-configs.json');
await writeFile(fixedConfigPath, JSON.stringify({ configs: fixedConfigs }, null, 2), 'utf8');

const tuneArgs = [
  'tools/ai-lab/tune-ai-picks-supervised.mjs',
  '--audit', mergedAuditPath,
  '--labels', labelsPath,
  '--output', outputDir,
  '--ratios', ratiosText,
  '--mode', 'ratio-aware',
  '--config-file', fixedConfigPath,
  '--positive-threshold', String(positiveThreshold),
  '--negative-threshold', String(negativeThreshold),
  '--missing-as-negative', missingAsNegative ? 'true' : 'false',
];

await runNode(tuneArgs);

const latencyCsvPath = path.join(outputDir, 'pro-infer-latency.csv');
await writeFile(latencyCsvPath, latencyCsv(infer), 'utf8');

const summaryMdPath = path.join(outputDir, 'summary.md');
const selectedPath = path.join(outputDir, 'selected-config-by-ratio.json');
const selected = existsSync(selectedPath)
  ? JSON.parse(await readFile(selectedPath, 'utf8'))
  : JSON.parse(await readFile(path.join(outputDir, 'selected-config.json'), 'utf8'));

const summary = [
  '# FrameCull Pro Persona Eval',
  '',
  `- Audit: \`${auditPath}\``,
  `- Labels: \`${labelsPath}\``,
  `- Preview dir: \`${previewDir}\``,
  `- Manifest: \`${manifestPath}\``,
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
  `- Label policy: \`rating >= ${positiveThreshold}\` keep, \`rating <= ${negativeThreshold}\` reject, \`missing => ${missingAsNegative ? 'reject' : 'ignored'}\``,
  '',
  '## Recommendation',
  '',
  'This run remains a Pro experimental evaluation and does not change the default AI Pick behavior.',
  '',
  '```json',
  JSON.stringify(selected.recommendation ?? selected.productionRecommendation ?? selected.selected ?? selected, null, 2),
  '```',
  '',
  `Detailed files: \`${path.join(outputDir, 'metrics-by-ratio.csv')}\`, \`${latencyCsvPath}\`, \`${path.join(outputDir, 'false-negatives-by-ratio.csv')}\`.`,
].join('\n');
await writeFile(summaryMdPath, summary, 'utf8');

console.log('[pro-persona] Eval complete.');
console.log(`[pro-persona] Merged audit: ${mergedAuditPath}`);
console.log(`[pro-persona] Summary: ${summaryMdPath}`);

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

function normalizeCargoProfile(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'dev' ? 'dev' : 'release';
}

function runCargo(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`cargo exited with code ${code}`));
    });
  });
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`node exited with code ${code}`));
    });
  });
}

function buildFixedConfigs(selectedConfig, ratios) {
  const profiles = Array.isArray(selectedConfig?.recommendation?.profiles)
    ? selectedConfig.recommendation.profiles
    : [];
  const profileByRatio = new Map(
    profiles
      .map(profile => [Number(profile.ratio), profile.config])
      .filter(([, config]) => config && Number.isFinite(config.ratio ?? NaN)),
  );

  const configs = [];
  for (const ratio of ratios) {
    const base = profileByRatio.get(ratio) ?? fallbackConfig(ratio);
    configs.push(configVariant(base, ratio, 'current'));
    configs.push(configVariant(base, ratio, 'aesthetic'));
    configs.push(configVariant(base, ratio, 'pro-persona'));
    configs.push(configVariant(base, ratio, 'pro-persona-scene'));
    configs.push(configVariant(base, ratio, 'pro-fused'));
  }
  return configs;
}

function fallbackConfig(ratio) {
  return {
    name: `fallback-r${ratio}`,
    family: 'ratio-aware-rank',
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
  const config = {
    ...base,
    ratio,
  };

  if (variant === 'current') {
    return {
      ...config,
      name: `ab-current-r${ratio}`,
      family: 'current-production-rules',
      rankMode: 'current',
    };
  }

  if (variant === 'aesthetic') {
    return {
      ...config,
      name: `ab-aesthetic-r${ratio}`,
      family: 'scoring-weights',
      rankMode: config.rankMode ?? 'scene-rescue',
    };
  }

  return {
    ...config,
    name: `ab-${variant}-r${ratio}`,
    family: 'pro-persona-experimental',
    rankMode: variant,
  };
}

function latencyCsv(infer) {
  const rows = [
    ['photo_id', 'image_path', 'aesthetic', 'persona_score', 'scene_label', 'scene_confidence', 'error'].join(','),
  ];
  for (const row of infer.results ?? []) {
    rows.push([
      csv(row.photoId),
      csv(row.imagePath),
      num(row.aesthetic),
      num(row.personaScore),
      csv(row.sceneLabel),
      num(row.sceneConfidence),
      csv(row.error),
    ].join(','));
  }
  return rows.join('\n');
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
