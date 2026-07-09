import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));

const groundedOutput = path.resolve(args.groundedOutput ?? '');
const flatOutput = path.resolve(args.flatOutput ?? '');
const outputPath = path.resolve(args.output ?? path.join(groundedOutput || process.cwd(), 'grounded-vs-flat-ablation.md'));
const productionRecommendationPath = args.updateProductionRecommendation
  ? path.resolve(args.updateProductionRecommendation)
  : '';

const ablation = buildAblation(groundedOutput, flatOutput);
const markdown = ablation.markdown;
writeFileSync(outputPath, markdown, 'utf8');
if (productionRecommendationPath) {
  updateProductionRecommendation(productionRecommendationPath, ablation.productionSection);
}
console.log(`[semantic-ablation] wrote ${outputPath}`);

function buildAblation(groundedDir, flatDir) {
  const grounded = loadBench(groundedDir);
  const flat = loadBench(flatDir);
  const lines = ['# Grounded vs Flat-Scalar Ablation', ''];
  lines.push(`- Grounded output: \`${groundedDir || 'not supplied'}\``);
  lines.push(`- Flat-scalar output: \`${flatDir || 'not supplied'}\``);
  lines.push('');

  if (!grounded.ok || !flat.ok) {
    lines.push('## Status', '');
    if (!grounded.ok) lines.push(`- Grounded bench is incomplete: ${grounded.missing.join(', ') || 'missing output directory'}`);
    if (!flat.ok) lines.push(`- Flat-scalar bench is incomplete: ${flat.missing.join(', ') || 'missing output directory'}`);
    lines.push('');
    lines.push('This file stays provisional until both grounded and flat-scalar runs finish on the same dataset scope.');
    const productionSection = buildProductionSection({
      verdict: 'incomplete',
      message: 'Grounded vs flat-scalar is still incomplete, so there is no grounding-specific product verdict yet.',
      meanDelta: null,
      scenicDelta: null,
      falseFaceDelta: null,
    });
    return { markdown: lines.join('\n'), productionSection };
  }

  lines.push('## Model Inputs', '');
  lines.push(`- Grounded model: \`${grounded.manifest?.backboneVersion ?? 'unknown'}\` (teacherFlatScalar=\`${String(grounded.teacherFlatScalar)}\`)`);
  lines.push(`- Flat model: \`${flat.manifest?.backboneVersion ?? 'unknown'}\` (teacherFlatScalar=\`${String(flat.teacherFlatScalar)}\`)`);
  lines.push('');

  appendRatioSection(lines, grounded, flat, 'pro-semantic-v2-fused', 'Primary Comparison: Fused Semantic Ranker');
  appendRatioSection(lines, grounded, flat, 'pro-semantic-v2-persona-only', 'Secondary Comparison: Persona Head Only');
  appendRatioSection(lines, grounded, flat, 'pro-semantic-v2-semantic-only', 'Secondary Comparison: Semantic Keep Only');
  appendWinnerSection(lines, grounded, flat);
  appendSceneProxySection(lines, grounded, flat);
  const verdict = deriveVerdict(grounded, flat);
  appendConclusion(lines, grounded, flat, verdict);
  return {
    markdown: lines.join('\n'),
    productionSection: buildProductionSection(verdict),
  };
}

function appendRatioSection(lines, grounded, flat, rankMode, title) {
  const ratios = collectRatios(grounded.ratioRows, flat.ratioRows, rankMode);
  if (!ratios.length) return;
  lines.push(`## ${title}`, '');
  lines.push('| Ratio | Grounded Recall | Flat Recall | Delta | Grounded Negative Pick | Flat Negative Pick | Grounded Similar Adjacent | Flat Similar Adjacent |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const ratio of ratios) {
    const groundedRow = pickRow(grounded.ratioRows, rankMode, ratio);
    const flatRow = pickRow(flat.ratioRows, rankMode, ratio);
    lines.push([
      formatRatio(ratio),
      formatPercent(groundedRow?.recall),
      formatPercent(flatRow?.recall),
      formatSignedPercent(deltaNumber(groundedRow?.recall, flatRow?.recall)),
      formatPercent(groundedRow?.negativePickRate),
      formatPercent(flatRow?.negativePickRate),
      formatInt(groundedRow?.selectedSimilarAdjacentPairs),
      formatInt(flatRow?.selectedSimilarAdjacentPairs),
    ].join(' | ').replace(/^/, '| ').concat(' |'));
  }
  lines.push('');
}

function appendWinnerSection(lines, grounded, flat) {
  const groundedProfiles = grounded.selected?.recommendation?.profiles ?? [];
  const flatProfiles = flat.selected?.recommendation?.profiles ?? [];
  if (!groundedProfiles.length && !flatProfiles.length) return;
  const ratios = [...new Set([...groundedProfiles.map(p => Number(p.ratio)), ...flatProfiles.map(p => Number(p.ratio))])].sort((a, b) => a - b);
  lines.push('## Best Config Snapshot', '');
  lines.push('| Ratio | Grounded Winner | Grounded Recall | Flat Winner | Flat Recall |');
  lines.push('|---|---|---:|---|---:|');
  for (const ratio of ratios) {
    const g = groundedProfiles.find(item => Number(item.ratio) === ratio);
    const f = flatProfiles.find(item => Number(item.ratio) === ratio);
    lines.push([
      formatRatio(ratio),
      g?.name ?? 'n/a',
      formatPercent(g?.recall),
      f?.name ?? 'n/a',
      formatPercent(f?.recall),
    ].join(' | ').replace(/^/, '| ').concat(' |'));
  }
  lines.push('');
}

function appendSceneProxySection(lines, grounded, flat) {
  const scenes = ['landscape', 'documentary_moment', 'group', 'portrait', 'product_object'];
  const rows = scenes
    .map(scene => ({
      scene,
      grounded: aggregateScene(grounded.sceneRows, scene),
      flat: aggregateScene(flat.sceneRows, scene),
    }))
    .filter(item => item.grounded || item.flat);
  if (!rows.length) return;
  lines.push('## Scene Proxy Signals', '');
  lines.push('These are score proxies from `metrics-by-scene.csv`, not final recall metrics. They are useful for spotting whether grounded labels change scenic keep bias or false-face caution.');
  lines.push('');
  lines.push('| Scene | Grounded Keep Mean | Flat Keep Mean | Delta | Grounded False-Face Mean | Flat False-Face Mean | Delta |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    lines.push([
      row.scene,
      formatDecimal(row.grounded?.semanticKeepMean),
      formatDecimal(row.flat?.semanticKeepMean),
      formatSignedDecimal(deltaNumber(row.grounded?.semanticKeepMean, row.flat?.semanticKeepMean)),
      formatDecimal(row.grounded?.falseFaceRiskMean),
      formatDecimal(row.flat?.falseFaceRiskMean),
      formatSignedDecimal(deltaNumber(row.grounded?.falseFaceRiskMean, row.flat?.falseFaceRiskMean)),
    ].join(' | ').replace(/^/, '| ').concat(' |'));
  }
  lines.push('');
}

function appendConclusion(lines, grounded, flat, verdict) {
  lines.push('## Conclusion', '');
  if (verdict.meanDelta == null) {
    lines.push('- Fused semantic rows are missing from one side, so the grounded-vs-flat semantic ablation is still incomplete.');
  } else if (verdict.meanDelta > 0) {
    lines.push(`- Grounded fused semantic recall is higher on average by ${formatSignedPercent(verdict.meanDelta)} across the comparable ratios.`);
  } else if (verdict.meanDelta < 0) {
    lines.push(`- Flat-scalar fused semantic recall is currently higher on average by ${formatSignedPercent(-verdict.meanDelta)} across the comparable ratios.`);
  } else {
    lines.push('- Grounded and flat-scalar fused semantic recall are currently tied on the comparable ratios.');
  }
  if (verdict.scenicDelta != null) {
    lines.push(`- Landscape/documentary semantic-keep proxy delta: ${formatSignedDecimal(verdict.scenicDelta)} (grounded minus flat).`);
  }
  if (verdict.falseFaceDelta != null) {
    lines.push(`- Landscape/documentary false-face proxy delta: ${formatSignedDecimal(verdict.falseFaceDelta)} (grounded minus flat; lower is better).`);
  }
  if (verdict.verdict === 'grounded_adds_value') {
    lines.push('- Verdict: grounded labels are showing real content-aware gain beyond plain flat VLM scoring.');
  } else if (verdict.verdict === 'no_grounding_specific_gain') {
    lines.push('- Verdict: current gains look like they come from having a VLM teacher at all, not specifically from grounded region-level reasoning.');
  } else if (verdict.verdict === 'flat_currently_stronger') {
    lines.push('- Verdict: flat-scalar is currently stronger overall, so grounded reasoning has not yet paid for its complexity.');
  } else if (verdict.verdict === 'mixed') {
    lines.push('- Verdict: grounded vs flat is mixed right now; some signals improve, but the grounding-specific gain is not yet decisive.');
  }
  const groundedBest = grounded.selected?.recommendation?.profiles ?? [];
  if (groundedBest.length) {
    const nonSemanticWinner = groundedBest.every(item => String(item.name ?? '').includes('pro-persona-v1'));
    if (nonSemanticWinner) {
      lines.push('- Even with grounded labels, the overall full-benchmark winner is still `pro-persona-v1`, so Semantic Student V2 remains experimental.');
    }
  }
}

function loadBench(dir) {
  if (!dir || !existsSync(dir)) {
    return { ok: false, missing: ['output directory'], ratioRows: [], sceneRows: [], selected: null, manifest: null, teacherFlatScalar: null };
  }
  const ratioPath = path.join(dir, 'metrics-by-ratio.csv');
  const scenePath = path.join(dir, 'metrics-by-scene.csv');
  const selectedPath = path.join(dir, 'selected-config-by-ratio.json');
  const manifestPath = path.join(dir, 'selected-model-manifest.json');
  const missing = [ratioPath, scenePath].filter(file => !existsSync(file)).map(file => path.basename(file));
  return {
    ok: missing.length === 0,
    missing,
    ratioRows: existsSync(ratioPath) ? parseCsv(readText(ratioPath)).map(normalizeRatioRow) : [],
    sceneRows: existsSync(scenePath) ? parseCsv(readText(scenePath)).map(normalizeSceneRow) : [],
    selected: existsSync(selectedPath) ? JSON.parse(readText(selectedPath)) : null,
    manifest: existsSync(manifestPath) ? JSON.parse(readText(manifestPath)) : null,
    teacherFlatScalar: existsSync(manifestPath) ? Boolean(JSON.parse(readText(manifestPath)).labNotes?.teacherFlatScalar) : null,
  };
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

function normalizeRatioRow(row) {
  return {
    ...row,
    ratio: toNumber(row.ratio),
    recall: toNumber(row.recall),
    negativePickRate: toNumber(row.negativePickRate),
    selectedSimilarAdjacentPairs: toNumber(row.selectedSimilarAdjacentPairs),
    selected: toBoolean(row.selected),
  };
}

function normalizeSceneRow(row) {
  return {
    ...row,
    total: toNumber(row.total),
    semanticKeepMean: toNumber(row.semantic_keep_mean),
    falseFaceRiskMean: toNumber(row.false_face_risk_mean),
  };
}

function aggregateScene(rows, scene) {
  const matched = rows.filter(row => row.scene === scene && row.total > 0);
  if (!matched.length) return null;
  const total = matched.reduce((sum, row) => sum + row.total, 0);
  const semanticKeepMean = matched.reduce((sum, row) => sum + row.semanticKeepMean * row.total, 0) / total;
  const falseFaceRiskMean = matched.reduce((sum, row) => sum + row.falseFaceRiskMean * row.total, 0) / total;
  return { total, semanticKeepMean, falseFaceRiskMean };
}

function deriveVerdict(grounded, flat) {
  const fusedRatios = collectRatios(grounded.ratioRows, flat.ratioRows, 'pro-semantic-v2-fused');
  const fusedDeltas = fusedRatios
    .map(ratio => deltaNumber(
      pickRow(grounded.ratioRows, 'pro-semantic-v2-fused', ratio)?.recall,
      pickRow(flat.ratioRows, 'pro-semantic-v2-fused', ratio)?.recall,
    ))
    .filter(value => value != null);
  const meanDelta = fusedDeltas.length ? fusedDeltas.reduce((sum, value) => sum + value, 0) / fusedDeltas.length : null;
  const scenicScenes = ['landscape', 'documentary_moment'];
  const scenicKeepDeltas = scenicScenes
    .map(scene => deltaNumber(aggregateScene(grounded.sceneRows, scene)?.semanticKeepMean, aggregateScene(flat.sceneRows, scene)?.semanticKeepMean))
    .filter(value => value != null);
  const falseFaceDeltas = scenicScenes
    .map(scene => deltaNumber(aggregateScene(grounded.sceneRows, scene)?.falseFaceRiskMean, aggregateScene(flat.sceneRows, scene)?.falseFaceRiskMean))
    .filter(value => value != null);
  const scenicDelta = scenicKeepDeltas.length
    ? scenicKeepDeltas.reduce((sum, value) => sum + value, 0) / scenicKeepDeltas.length
    : null;
  const falseFaceDelta = falseFaceDeltas.length
    ? falseFaceDeltas.reduce((sum, value) => sum + value, 0) / falseFaceDeltas.length
    : null;

  let verdict = 'mixed';
  let message = 'Grounded and flat-scalar are showing mixed signals; keep Semantic Student V2 in experimental review.';
  if (meanDelta == null) {
    verdict = 'incomplete';
    message = 'Grounded vs flat-scalar is still incomplete, so there is no grounding-specific product verdict yet.';
  } else if (meanDelta > 0.005 && (scenicDelta == null || scenicDelta >= 0) && (falseFaceDelta == null || falseFaceDelta <= 0)) {
    verdict = 'grounded_adds_value';
    message = 'Grounded labels show real content-aware gain over flat-scalar on the comparable ratios, without a worse scenic proxy or false-face proxy.';
  } else if (Math.abs(meanDelta) <= 0.003 && (scenicDelta == null || Math.abs(scenicDelta) <= 0.01) && (falseFaceDelta == null || Math.abs(falseFaceDelta) <= 0.01)) {
    verdict = 'no_grounding_specific_gain';
    message = 'Current gains look like generic VLM-teacher benefit rather than grounding-specific benefit; grounded and flat-scalar are effectively tied.';
  } else if (meanDelta < -0.005) {
    verdict = 'flat_currently_stronger';
    message = 'Flat-scalar is currently stronger than grounded on the comparable ratios, so grounding has not justified its extra complexity yet.';
  }
  return { verdict, message, meanDelta, scenicDelta, falseFaceDelta };
}

function buildProductionSection(verdict) {
  const lines = [
    '## Grounded vs Flat-Scalar Verdict',
    '',
    '<!-- framecull-semantic-ablation:start -->',
    `- Verdict: ${verdict.message}`,
  ];
  if (verdict.meanDelta != null) {
    lines.push(`- Mean fused recall delta: ${formatSignedPercent(verdict.meanDelta)} (grounded minus flat).`);
  }
  if (verdict.scenicDelta != null) {
    lines.push(`- Scenic keep proxy delta: ${formatSignedDecimal(verdict.scenicDelta)} (grounded minus flat).`);
  }
  if (verdict.falseFaceDelta != null) {
    lines.push(`- False-face proxy delta: ${formatSignedDecimal(verdict.falseFaceDelta)} (grounded minus flat; lower is better).`);
  }
  if (verdict.verdict === 'no_grounding_specific_gain') {
    lines.push('- Product implication: current value appears to come from having a VLM teacher, not specifically from grounded reasoning. Keep grounded training experimental until it beats flat-scalar decisively.');
  } else if (verdict.verdict === 'grounded_adds_value') {
    lines.push('- Product implication: grounded reasoning is earning its keep and can remain the preferred Semantic Teacher path for future Pro experiments.');
  } else if (verdict.verdict === 'flat_currently_stronger') {
    lines.push('- Product implication: do not claim content-aware gain yet; fix grounded labels or training before promoting this path.');
  } else if (verdict.verdict === 'mixed') {
    lines.push('- Product implication: keep collecting evidence; the grounding-specific gain is not yet clean enough for product messaging.');
  }
  lines.push('<!-- framecull-semantic-ablation:end -->');
  return lines.join('\n');
}

function updateProductionRecommendation(filePath, section) {
  const markerStart = '<!-- framecull-semantic-ablation:start -->';
  const markerEnd = '<!-- framecull-semantic-ablation:end -->';
  const current = existsSync(filePath) ? readText(filePath) : '# Production Recommendation\n';
  const start = current.indexOf(markerStart);
  const end = current.indexOf(markerEnd);
  let next = current;
  if (start >= 0 && end > start) {
    next = `${current.slice(0, start)}${section}${current.slice(end + markerEnd.length)}`;
  } else {
    next = `${current.trimEnd()}\n\n${section}\n`;
  }
  writeFileSync(filePath, next, 'utf8');
}

function collectRatios(groundedRows, flatRows, rankMode) {
  return [...new Set(
    [...groundedRows, ...flatRows]
      .filter(row => row.rankMode === rankMode && Number.isFinite(row.ratio))
      .map(row => row.ratio),
  )].sort((a, b) => a - b);
}

function pickRow(rows, rankMode, ratio) {
  return rows.find(row => row.rankMode === rankMode && nearlyEqual(row.ratio, ratio))
    ?? rows.find(row => row.name === `ab-${rankMode}-r${ratio}`);
}

function nearlyEqual(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
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
  const lines = text.split(/\r?\n/).filter(Boolean);
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
  return Number.isFinite(number) ? number : null;
}

function toBoolean(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function deltaNumber(a, b) {
  return a == null || b == null ? null : a - b;
}

function formatRatio(value) {
  return value == null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function formatPercent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatSignedPercent(value) {
  return value == null ? 'n/a' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function formatDecimal(value) {
  return value == null ? 'n/a' : value.toFixed(4);
}

function formatSignedDecimal(value) {
  return value == null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function formatInt(value) {
  return value == null ? 'n/a' : String(Math.round(value));
}
