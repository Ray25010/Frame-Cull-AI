import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = parseArgs(process.argv.slice(2));
const inputDir = path.resolve(args.input || '');
if (!inputDir || !existsSync(inputDir)) throw new Error(`Input directory not found: ${inputDir}`);
const outputDir = path.resolve(args.output || path.join(repoRoot, 'output', 'people-split-precision', 'run'));
const label = args.label || path.basename(outputDir);
const limit = positiveInteger(args.limit, Number.POSITIVE_INFINITY);
const concurrency = positiveInteger(args.concurrency, 1);
const maxEdge = positiveInteger(args.maxEdge, 1280);
const timeoutMs = positiveInteger(args.timeoutMs, 90 * 60 * 1000);
const browserPath = process.env.FRAMECULL_BENCH_BROWSER
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const cdpPort = 9600 + Math.floor(Math.random() * 300);
const vitePort = 3400 + Math.floor(Math.random() * 300);
const benchUrl = `http://127.0.0.1:${vitePort}/tools/ai-lab/people-split-precision.html`;

await mkdir(outputDir, { recursive: true });
const files = (await listJpegs(inputDir)).slice(0, limit);
if (files.length === 0) throw new Error(`No JPG files found under ${inputDir}`);
console.log(`people-split input=${inputDir} files=${files.length} label=${label}`);

const vite = spawnVite(['--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stdout.on('data', chunk => process.stdout.write(`[vite] ${chunk}`));
vite.stderr.on('data', chunk => process.stderr.write(`[vite] ${chunk}`));

const userDataDir = path.join(tmpdir(), `framecull-people-split-${Date.now()}`);
const edge = spawn(browserPath, [
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${userDataDir}`,
  '--headless=new',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-component-update',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
edge.stderr.on('data', chunk => {
  const message = String(chunk).trim();
  if (message && !message.includes('DevTools listening')) console.warn(`[edge] ${message}`);
});

try {
  await waitForHttp(benchUrl, 60_000);
  const page = await waitForPage(cdpPort);
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.navigate', { url: benchUrl });
  await waitForReady(cdp);

  const document = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const input = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#files' });
  if (!input.nodeId) throw new Error('file input not found');
  await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files });

  const expression = `window.runFrameCullPeopleSplitPrecision(${JSON.stringify({ concurrency, maxEdge })})`;
  const result = await evaluateAwaitedWithProgress(cdp, expression, timeoutMs);
  const enriched = {
    ...result,
    label,
    inputDir,
    expectedFiles: files.length,
  };
  const rawPath = path.join(outputDir, 'people-split-raw.json');
  await writeFile(rawPath, JSON.stringify(enriched, null, 2), 'utf8');
  await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(enriched.summary, null, 2), 'utf8');
  await writeFile(path.join(outputDir, 'contact-sheet.html'), buildContactSheet(enriched), 'utf8');
  console.log(`wrote ${rawPath}`);
  console.log(JSON.stringify(enriched.summary, null, 2));
  cdp.close();
} finally {
  edge.kill();
  vite.kill();
}

async function listJpegs(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listJpegs(fullPath);
    if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) return [fullPath];
    return [];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
}

function buildContactSheet(run) {
  const faceByKey = new Map(run.results.flatMap(result => result.faces.map(face => [face.key, { ...face, fileName: result.fileName }])));
  const clusterSections = run.clusters.map(cluster => {
    const faces = cluster.memberFaceKeys.map(key => faceByKey.get(key)).filter(Boolean);
    return `<section><h2>${escapeHtml(cluster.id)} <small>${faces.length} faces / ${cluster.photoCount} photos</small></h2><div class="grid">${faces.map(faceCard).join('')}</div></section>`;
  }).join('');
  const unassigned = run.unassignedFaceKeys.map(key => faceByKey.get(key)).filter(Boolean);
  const errors = run.results.filter(result => result.error);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(run.label)} People Split</title><style>
body{margin:0;padding:24px;background:#101115;color:#eee;font:14px system-ui}header{position:sticky;top:0;background:#101115;padding:10px 0;z-index:2}pre{white-space:pre-wrap}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.face{background:#1c1d21;border:1px solid #333;padding:8px}.face img{width:100%;aspect-ratio:1;object-fit:cover;background:#080808}.meta{font-size:11px;line-height:1.45;overflow-wrap:anywhere}section{border-top:1px solid #333;margin-top:24px;padding-top:8px}small{color:#aaa;font-weight:400}.error{color:#fca5a5}
</style></head><body><header><h1>${escapeHtml(run.label)}</h1><pre>${escapeHtml(JSON.stringify(run.summary, null, 2))}</pre></header>${clusterSections}<section><h2>Unassigned <small>${unassigned.length}</small></h2><div class="grid">${unassigned.map(faceCard).join('')}</div></section><section><h2>Errors <small>${errors.length}</small></h2>${errors.map(error => `<p class="error">${escapeHtml(error.fileName)}: ${escapeHtml(error.error)}</p>`).join('')}</section></body></html>`;
}

function faceCard(face) {
  return `<article class="face"><img src="${face.thumbnail || ''}" alt=""><div class="meta"><b>${escapeHtml(face.fileName)}</b><br>key=${escapeHtml(face.key)}<br>conf=${format(face.confidence)} quality=${format(face.quality)}<br>visual=${format(face.visualQuality)} structure=${format(face.structureQuality)}<br>distance=${format(face.nearestDistance)} margin=${format(face.ambiguityMargin)}<br>${escapeHtml(face.admission)} ${escapeHtml(face.reason || '')}</div></article>`;
}

function format(value) {
  return Number.isFinite(value) ? Number(value).toFixed(3) : '-';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    const next = inlineValue ?? values[index + 1];
    if (inlineValue === undefined && next && !next.startsWith('--')) index += 1;
    parsed[rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next ?? true;
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function spawnVite(args, options) {
  const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (existsSync(viteBin)) return spawn(process.execPath, [viteBin, ...args], options);
  if (process.platform === 'win32') return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm', 'exec', 'vite', ...args], options);
  return spawn('pnpm', ['exec', 'vite', ...args], options);
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || lastError}`);
}

async function waitForPage(debugPort, timeoutMs = 60_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const pages = await response.json();
      const page = pages.find(item => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for CDP page: ${lastError?.message || lastError}`);
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((sendResolve, sendReject) => pending.set(id, { resolve: sendResolve, reject: sendReject }));
      },
      close() { socket.close(); },
    }));
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket error')));
  });
}

async function waitForReady(cdp, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send('Runtime.evaluate', { expression: 'Boolean(window.__FRAMECULL_PEOPLE_SPLIT_READY)', returnByValue: true });
    if (result.result?.value === true) return;
    await sleep(250);
  }
  throw new Error('people split runner did not become ready');
}

async function evaluateAwaitedWithProgress(cdp, expression, timeoutMs) {
  const progressTimer = setInterval(async () => {
    try {
      const result = await cdp.send('Runtime.evaluate', { expression: 'window.__FRAMECULL_PEOPLE_SPLIT_STATUS || "waiting"', returnByValue: true });
      console.log(`[progress] ${result.result?.value || 'waiting'}`);
    } catch {
      // The main evaluation reports the actionable error.
    }
  }, 10_000);
  try {
    const evaluation = cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs));
    const result = await Promise.race([evaluation, timeout]);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  } finally {
    clearInterval(progressTimer);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
