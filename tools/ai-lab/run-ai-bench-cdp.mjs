import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultImageDir = 'C:\\Users\\29238\\Desktop\\新建文件夹 (4)';
const defaultEdgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browserPath = process.env.FRAMECULL_BENCH_BROWSER || defaultEdgePath;
const port = Number(process.env.FRAMECULL_BENCH_CDP_PORT || (9300 + Math.floor(Math.random() * 400)));
const imageDir = process.argv[2] || defaultImageDir;
const limit = Number(process.env.FRAMECULL_BENCH_LIMIT || 36);
const maxEdge = Number(process.env.FRAMECULL_BENCH_MAX_EDGE || 2200);
const prepareConcurrency = Number(process.env.FRAMECULL_BENCH_PREPARE_CONCURRENCY || 0);
const collectAnalysisSummary = process.env.FRAMECULL_BENCH_COLLECT_SUMMARY === '1';
const mode = process.env.FRAMECULL_BENCH_MODE || 'ai';
const backend = normalizeBackend(process.env.FRAMECULL_BENCH_BACKEND);
const aiBackend = normalizeBackend(process.env.FRAMECULL_BENCH_AI_BACKEND || process.env.FRAMECULL_BENCH_BACKEND);
const peopleBackend = normalizeBackend(process.env.FRAMECULL_BENCH_PEOPLE_BACKEND || process.env.FRAMECULL_BENCH_BACKEND);
const auditConcurrency = Number(process.env.FRAMECULL_BENCH_AUDIT_CONCURRENCY || process.env.FRAMECULL_BENCH_CONCURRENCY || 6);
const aiPickTargetRatio = Number(process.env.FRAMECULL_AI_PICK_TARGET_RATIO || 0.38);
const rawAuditContextRadius = Number(process.env.FRAMECULL_RAW_AUDIT_CONTEXT_RADIUS ?? 3);
const benchmarkTimeoutMs = Number(process.env.FRAMECULL_BENCH_TIMEOUT_MS || 20 * 60 * 1000);
const auditBatchSize = Number(process.env.FRAMECULL_BENCH_AUDIT_BATCH_SIZE || 0);
const imageTimeoutMs = Number(process.env.FRAMECULL_BENCH_IMAGE_TIMEOUT_MS || 120_000);
const collectPairSimilarities = process.env.FRAMECULL_BENCH_COLLECT_PAIR_SIMILARITIES === '1';
const logPeopleProgress = process.env.FRAMECULL_BENCH_PEOPLE_PROGRESS === '1';
const disableAesthetic = process.env.FRAMECULL_BENCH_DISABLE_AESTHETIC === '1';
const disableFaceChecks = process.env.FRAMECULL_BENCH_DISABLE_FACE_CHECKS === '1';
const disableDuplicateSignature = process.env.FRAMECULL_BENCH_DISABLE_DUPLICATE_SIGNATURE === '1';
const ratios = (process.env.FRAMECULL_BENCH_RATIOS || '')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0);
const concurrencies = (process.env.FRAMECULL_BENCH_CONCURRENCIES || '1,2,3,4,5,6')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0);
const combinedCombos = (process.env.FRAMECULL_BENCH_COMBOS || '6x1,6x2,5x1,5x2')
  .split(',')
  .map(value => value.trim().match(/^(\d+)x(\d+)$/))
  .filter(Boolean)
  .map(match => ({
    aiConcurrency: Number(match?.[1]),
    peopleConcurrency: Number(match?.[2]),
  }));

const outputDir = path.join(repoRoot, 'output', 'ai-bench');
const outputPath = path.join(outputDir, `ai-culling-bench-${Date.now()}.json`);
const benchUrl = `http://127.0.0.1:3000/tools/ai-lab/bench-ai-culling.html`;
const rawAuditPreviewDir = process.env.FRAMECULL_RAW_AUDIT_PREVIEW_DIR || path.join(repoRoot, 'output', 'raw-audit-previews');
const rawAuditLabelsPath = process.env.FRAMECULL_RAW_AUDIT_LABELS || path.join(rawAuditPreviewDir, 'labels.json');

await mkdir(outputDir, { recursive: true });

const rawAuditLabels = mode === 'raw-pick-audit'
  ? await loadRawAuditLabels(rawAuditLabelsPath)
  : null;
const files = await listImageFiles(mode === 'raw-pick-audit' ? rawAuditPreviewDir : imageDir, limit, rawAuditLabels);
if (files.length === 0) {
  throw new Error(`No JPG files found in ${mode === 'raw-pick-audit' ? rawAuditPreviewDir : imageDir}`);
}

console.log(`Running FrameCull ${mode} benchmark with ${files.length} JPG files`);
if (rawAuditLabels) {
  console.log(`Raw audit labels: ${Object.keys(rawAuditLabels.labels || {}).length} labeled NEF previews from ${rawAuditLabelsPath}`);
}
console.log(`Backends: backend=${backend}; ai=${aiBackend}; people=${peopleBackend}`);
console.log(`Concurrencies: ${concurrencies.join(', ')}; combos=${combinedCombos.map(combo => `${combo.aiConcurrency}x${combo.peopleConcurrency}`).join(', ')}; maxEdge=${maxEdge}; prepareConcurrency=${prepareConcurrency || 'unlimited'}`);

const userDataDir = path.join(tmpdir(), `framecull-ai-bench-${Date.now()}`);
const edge = spawn(browserPath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--headless=new',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-features=msEdgeEnableNurturingFramework,msEdgeOnRampFRE',
  '--no-service-autorun',
  '--disable-component-update',
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  'about:blank',
], {
  stdio: ['ignore', 'ignore', 'pipe'],
});

edge.stderr.on('data', chunk => {
  const line = String(chunk).trim();
  if (line && !line.includes('DevTools listening')) console.warn(line);
});

try {
  const page = await waitForPage(port);
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.navigate', { url: benchUrl });
  await waitForReady(cdp);

  const root = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const input = await cdp.send('DOM.querySelector', {
    nodeId: root.root.nodeId,
    selector: '#files',
  });
  if (!input.nodeId) throw new Error('Benchmark file input was not found.');

  await cdp.send('DOM.setFileInputFiles', {
    nodeId: input.nodeId,
    files,
  });

  const result = await evaluateAwaited(cdp, benchmarkExpression(), benchmarkTimeoutMs);

  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Benchmark saved: ${outputPath}`);
  console.log(JSON.stringify(summarizeResult(result), null, 2));
} finally {
  edge.kill();
}

function summarizeResult(result) {
  if (mode === 'probe') {
    return result;
  }

  if (mode === 'combined') {
    return {
      best: result.best,
      runs: result.runs?.map(run => ({
        aiConcurrency: run.aiConcurrency,
        peopleConcurrency: run.peopleConcurrency,
        wallMs: Math.round(run.wallMs),
        aiImagesPerSecond: Number(run.aiImagesPerSecond.toFixed(3)),
        peopleImagesPerSecond: Number(run.peopleImagesPerSecond.toFixed(3)),
        aiErrors: run.aiErrors,
        peopleErrors: run.peopleErrors,
      })),
    };
  }

  if (mode === 'people') {
    return {
      best: result.best,
      runs: result.runs?.map(run => ({
        concurrency: run.concurrency,
        imagesPerSecond: Number(run.imagesPerSecond.toFixed(3)),
        totalMs: Math.round(run.totalMs),
        averageMs: Math.round(run.averageMs),
        errors: run.errors.length,
      })),
    };
  }

  if (mode === 'pick-audit' || mode === 'raw-pick-audit') {
    return {
      counts: result.counts,
      supervised: result.supervised,
      metricsByRatio: result.metricsByRatio?.map(entry => ({
        ratio: entry.ratio,
        aiPicked: entry.aiPicked,
        targetCount: entry.targetCount,
        recall: entry.supervised?.recall,
        recallByRating: entry.supervised?.recallByRating,
        negativePickRate: entry.supervised?.negativePickRate,
        positiveFrameOrGroupCoverage: entry.supervised?.positiveFrameOrGroupCoverage,
        groupsWithMultipleAiPicks: entry.groupsWithMultipleAiPicks,
        aiPickedDuplicateMembers: entry.aiPickedDuplicateMembers,
      })),
      duplicateStats: result.duplicateStats,
      exclusionReasonCounts: result.exclusionReasonCounts,
      scoreDistribution: result.scoreDistribution,
      totalMs: Math.round(result.totalMs),
      analysisMs: Math.round(result.analysisMs),
      groupingMs: Math.round(result.groupingMs),
      backend: result.backend,
      concurrency: result.concurrency,
      targetRatio: result.targetRatio,
    };
  }

  return {
    best: result.best,
    runs: result.runs?.map(run => ({
      concurrency: run.concurrency,
      imagesPerSecond: Number(run.imagesPerSecond.toFixed(3)),
        totalMs: Math.round(run.totalMs),
        averagePrepareMs: Math.round(run.averagePrepareMs),
        averagePrepareWorkMs: Math.round(run.averagePrepareWorkMs ?? run.averagePrepareMs),
        averageWorkerMs: Math.round(run.averageWorkerMs),
        prepareConcurrency: run.prepareConcurrency,
        maxFrameGapMs: Math.round(run.maxFrameGapMs ?? 0),
        p95FrameGapMs: Math.round(run.p95FrameGapMs ?? 0),
        errors: run.errors.length,
      })),
      backend: result.backend,
    };
  }

function benchmarkExpression() {
  if (mode === 'probe') {
    return `
      (async () => {
        const hasNavigatorGpu = Boolean(navigator.gpu);
        const adapter = hasNavigatorGpu ? await navigator.gpu.requestAdapter() : null;
        const highPerformanceAdapter = hasNavigatorGpu ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
        const lowPowerAdapter = hasNavigatorGpu ? await navigator.gpu.requestAdapter({ powerPreference: 'low-power' }) : null;
        let info = null;
        let highPerformanceInfo = null;
        let lowPowerInfo = null;
        try {
          info = adapter?.info ?? (adapter?.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
        } catch (error) {
          info = { error: error instanceof Error ? error.message : String(error) };
        }
        try {
          highPerformanceInfo = highPerformanceAdapter?.info ?? (highPerformanceAdapter?.requestAdapterInfo ? await highPerformanceAdapter.requestAdapterInfo() : null);
        } catch (error) {
          highPerformanceInfo = { error: error instanceof Error ? error.message : String(error) };
        }
        try {
          lowPowerInfo = lowPowerAdapter?.info ?? (lowPowerAdapter?.requestAdapterInfo ? await lowPowerAdapter.requestAdapterInfo() : null);
        } catch (error) {
          lowPowerInfo = { error: error instanceof Error ? error.message : String(error) };
        }
        return {
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency || 0,
          hasNavigatorGpu,
          hasAdapter: Boolean(adapter),
          hasHighPerformanceAdapter: Boolean(highPerformanceAdapter),
          hasLowPowerAdapter: Boolean(lowPowerAdapter),
          adapterInfo: info ? JSON.parse(JSON.stringify(info)) : null,
          highPerformanceAdapterInfo: highPerformanceInfo ? JSON.parse(JSON.stringify(highPerformanceInfo)) : null,
          lowPowerAdapterInfo: lowPowerInfo ? JSON.parse(JSON.stringify(lowPowerInfo)) : null,
        };
      })()
    `;
  }

  if (mode === 'combined') {
    return `
      window.runCombinedAiPeopleBench(
        Array.from(document.querySelector('#files').files),
        {
          limit: ${JSON.stringify(limit)},
          aiMaxEdge: ${JSON.stringify(maxEdge)},
          peopleMaxEdge: 1280,
          aiBackend: ${JSON.stringify(aiBackend)},
          peopleBackend: ${JSON.stringify(peopleBackend)},
          combos: ${JSON.stringify(combinedCombos)}
        }
      )
    `;
  }

  if (mode === 'people') {
    return `
      window.runPeopleSplitBench(
        Array.from(document.querySelector('#files').files),
        {
          limit: ${JSON.stringify(limit)},
          maxEdge: 1280,
          backend: ${JSON.stringify(backend)},
          concurrencies: ${JSON.stringify(concurrencies)},
          logProgress: ${JSON.stringify(logPeopleProgress)}
        }
      )
    `;
  }

  if (mode === 'pick-audit' || mode === 'raw-pick-audit') {
    return `
      window.runAiPickAuditBench(
        Array.from(document.querySelector('#files').files),
        {
          limit: ${JSON.stringify(limit)},
          maxEdge: ${JSON.stringify(maxEdge)},
          backend: ${JSON.stringify(backend)},
          concurrency: ${JSON.stringify(auditConcurrency)},
          prepareConcurrency: ${JSON.stringify(prepareConcurrency)},
          auditBatchSize: ${JSON.stringify(auditBatchSize)},
          imageTimeoutMs: ${JSON.stringify(imageTimeoutMs)},
          collectPairSimilarities: ${JSON.stringify(collectPairSimilarities)},
          aiPickTargetRatio: ${JSON.stringify(aiPickTargetRatio)},
          ratios: ${JSON.stringify(ratios.length > 0 ? ratios : undefined)},
          duplicateSensitivity: ${JSON.stringify(process.env.FRAMECULL_DUPLICATE_SENSITIVITY || undefined)},
          groundTruthRatings: ${JSON.stringify(rawAuditLabels?.labels || undefined)},
          sourceNames: ${JSON.stringify(rawAuditLabels?.sourceNames || undefined)},
          mode: ${JSON.stringify(mode)}
        }
      )
    `;
  }

  return `
    window.runAiCullingBench(
      Array.from(document.querySelector('#files').files),
      {
        limit: ${JSON.stringify(limit)},
        maxEdge: ${JSON.stringify(maxEdge)},
        concurrencies: ${JSON.stringify(concurrencies)},
        prepareConcurrency: ${JSON.stringify(prepareConcurrency || undefined)},
        backend: ${JSON.stringify(backend)},
        collectAnalysisSummary: ${JSON.stringify(collectAnalysisSummary)},
        disableAesthetic: ${JSON.stringify(disableAesthetic)},
        disableFaceChecks: ${JSON.stringify(disableFaceChecks)},
        disableDuplicateSignature: ${JSON.stringify(disableDuplicateSignature)}
      }
    )
  `;
}

async function listImageFiles(dir, maxFiles) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  let files = entries
    .filter(entry => entry.isFile() && /\.(jpe?g)$/i.test(entry.name))
    .map(entry => path.join(dir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));

  if (mode === 'raw-pick-audit' && rawAuditLabels) {
    files = selectRawAuditFiles(files, rawAuditLabels.labels || {}, rawAuditContextRadius);
  }

  return files.slice(0, maxFiles);
}

function selectRawAuditFiles(files, labels, contextRadius) {
  const labeledIds = new Set(Object.keys(labels));
  if (labeledIds.size === 0) return files;
  const radius = Math.max(0, Math.floor(Number.isFinite(contextRadius) ? contextRadius : 0));
  if (radius === 0) {
    return files.filter(file => labeledIds.has(baseName(path.basename(file))));
  }

  const labelKeys = [...labeledIds].map(id => ({
    id,
    prefix: id.replace(/\d+(?!.*\d)/, ''),
    number: trailingNumber(id),
  }));

  return files.filter(file => {
    const id = baseName(path.basename(file));
    if (labeledIds.has(id)) return true;
    const number = trailingNumber(id);
    if (number === null) return false;
    const prefix = id.replace(/\d+(?!.*\d)/, '');
    return labelKeys.some(label => (
      label.number !== null &&
      label.prefix === prefix &&
      Math.abs(label.number - number) <= radius
    ));
  });
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

function trailingNumber(value) {
  const match = value.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

async function loadRawAuditLabels(labelsPath) {
  const text = await readFile(labelsPath, 'utf8');
  const parsed = JSON.parse(text);
  return {
    labels: parsed.labels || {},
    sourceNames: parsed.sourceNames || {},
  };
}

function normalizeBackend(value) {
  return value === 'webgpu' ? 'webgpu' : 'wasm';
}

async function waitForPage(debugPort) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const pages = await response.json();
      const page = pages.find(item => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Edge is still starting.
    }
    await wait(150);
  }
  throw new Error('Timed out waiting for Edge DevTools page.');
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const payload = JSON.stringify({ id, method, params });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(payload);
      });
    },
  };
}

async function waitForReady(cdp) {
  const started = Date.now();
  const runnerName = mode === 'combined'
    ? 'runCombinedAiPeopleBench'
    : mode === 'people'
      ? 'runPeopleSplitBench'
      : mode === 'pick-audit' || mode === 'raw-pick-audit'
        ? 'runAiPickAuditBench'
        : 'runAiCullingBench';
  while (Date.now() - started < 30_000) {
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `({
          readyState: document.readyState,
          hasInput: Boolean(document.querySelector('#files')),
          hasRunner: typeof window.${runnerName} === 'function',
          title: document.title,
          bodyText: document.body?.innerText?.slice(0, 240) || ''
        })`,
        returnByValue: true,
      });
      const value = result.result?.value;
      if (value?.readyState === 'complete' && value?.hasInput && value?.hasRunner) {
        await wait(300);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Execution context was destroyed')) throw error;
    }
    await wait(100);
  }
  throw new Error('Benchmark page did not finish loading.');
}

async function evaluateAwaited(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Benchmark evaluation failed.');
  }
  return result.result.value;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
