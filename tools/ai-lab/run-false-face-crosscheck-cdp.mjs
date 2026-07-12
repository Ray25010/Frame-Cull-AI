import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(repoRoot, 'output', 'semantic-false-face-diagnosis', 'v15-crosscheck');
const previewDir = process.env.FRAMECULL_FALSE_FACE_PREVIEW_DIR
  || path.join(repoRoot, 'output', 'semantic-false-face-diagnosis', 'v13-eval', 'upload-previews-384');
const independentSet = process.env.FRAMECULL_FALSE_FACE_HOLDOUT
  || path.join(repoRoot, 'output', 'semantic-false-face-diagnosis', 'v13-eval', 'independent-false-face-set.csv');
const browserPath = process.env.FRAMECULL_BENCH_BROWSER
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const cdpPort = Number(process.env.FRAMECULL_FALSE_FACE_CDP_PORT || (9600 + Math.floor(Math.random() * 400)));
const vitePort = Number(process.env.FRAMECULL_FALSE_FACE_VITE_PORT || (3400 + Math.floor(Math.random() * 400)));
const benchUrl = `http://127.0.0.1:${vitePort}/tools/ai-lab/false-face-crosscheck.html`;

await mkdir(outDir, { recursive: true });

const holdoutRows = parseCsv(await readFile(independentSet, 'utf8'));
const previewFiles = await resolvePreviewFiles(holdoutRows);
if (previewFiles.length !== holdoutRows.length) {
  throw new Error(`Preview coverage mismatch: ${previewFiles.length}/${holdoutRows.length}`);
}

const vite = spawnVite(['--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
});
vite.stdout.on('data', chunk => process.stdout.write(`[vite] ${chunk}`));
vite.stderr.on('data', chunk => process.stderr.write(`[vite] ${chunk}`));

const userDataDir = path.join(tmpdir(), `framecull-false-face-crosscheck-${Date.now()}`);
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
], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
edge.stderr.on('data', chunk => {
  const text = String(chunk).trim();
  if (text && !text.includes('DevTools listening')) console.warn(`[edge] ${text}`);
});

try {
  await waitForHttp(`http://127.0.0.1:${vitePort}/tools/ai-lab/false-face-crosscheck.html`, 60_000);
  const page = await waitForPage(cdpPort);
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
  if (!input.nodeId) throw new Error('file input not found');
  await cdp.send('DOM.setFileInputFiles', {
    nodeId: input.nodeId,
    files: previewFiles,
  });

  const result = await evaluateAwaited(
    cdp,
    'window.runFrameCullFalseFaceCrosscheck()',
    Number(process.env.FRAMECULL_FALSE_FACE_TIMEOUT_MS || 10 * 60 * 1000)
  );
  const enriched = {
    schemaVersion: 'framecull-false-face-crosscheck-browser-yunet-v1',
    generatedAt: new Date().toISOString(),
    independentSet,
    previewDir,
    expectedRows: holdoutRows.length,
    files: previewFiles.length,
    ...result,
  };
  const rawPath = path.join(outDir, 'face-presence-yunet-raw.json');
  await writeFile(rawPath, JSON.stringify(enriched, null, 2), 'utf8');
  console.log(`wrote ${rawPath}`);
  console.log(JSON.stringify({
    rows: enriched.results.length,
    totalMs: Math.round(enriched.totalMs),
    meanMs: Math.round(enriched.totalMs / Math.max(1, enriched.results.length)),
    errors: enriched.results.filter(row => row.error).length,
  }, null, 2));
} finally {
  edge.kill();
  vite.kill();
}

async function resolvePreviewFiles(rows) {
  const entries = await readdir(previewDir, { withFileTypes: true });
  const byStem = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stem = path.parse(entry.name).name.toLowerCase();
    byStem.set(stem, path.join(previewDir, entry.name));
  }
  return rows.map(row => {
    const stem = safeStem(row.photoId).toLowerCase();
    const file = byStem.get(stem);
    if (!file || !existsSync(file)) {
      throw new Error(`missing preview for ${row.photoId}`);
    }
    return file;
  });
}

function parseCsv(text) {
  const rows = [];
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines.shift());
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
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

function safeStem(value) {
  return path.parse(String(value || '').trim().replace(/^["']|["']$/g, '')).name;
}

function spawnVite(args, options) {
  const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (existsSync(viteBin)) {
    return spawn(process.execPath, [viteBin, ...args], options);
  }
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm', 'exec', 'vite', ...args], options);
  }
  return spawn('pnpm', ['exec', 'vite', ...args], options);
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? lastError}`);
}

async function waitForPage(debugPort, timeoutMs = 60_000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
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
  throw new Error(`Timed out waiting for CDP page: ${lastError?.message ?? lastError}`);
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((sendResolve, sendReject) => {
            pending.set(id, { resolve: sendResolve, reject: sendReject });
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket error')));
  });
}

async function waitForReady(cdp, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'Boolean(window.__FRAMECULL_FALSE_FACE_READY)',
      returnByValue: true,
    });
    if (result.result?.value === true) return;
    await sleep(250);
  }
  throw new Error('runner did not become ready');
}

async function evaluateAwaited(cdp, expression, timeoutMs) {
  const evalPromise = cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms evaluating expression`)), timeoutMs);
  });
  const result = await Promise.race([evalPromise, timeoutPromise]);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
