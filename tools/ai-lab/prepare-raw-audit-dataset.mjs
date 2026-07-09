import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSources = [
  'G:\\DCIM\\108NZ6_3',
  'G:\\DCIM\\109NZ6_3',
  'G:\\DCIM\\110NZ6_3',
];
const sourceDirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultSources;
const outputDir = process.env.FRAMECULL_RAW_AUDIT_PREVIEW_DIR || path.join(repoRoot, 'output', 'raw-audit-previews');
const externalLabelsPath = process.env.FRAMECULL_RAW_AUDIT_EXTERNAL_LABELS || '';
const labelsPath = path.join(outputDir, 'labels.json');
const rawExtensions = new Set(['.nef', '.arw']);

await mkdir(outputDir, { recursive: true });

const externalLabels = externalLabelsPath ? await loadExternalLabels(externalLabelsPath) : new Map();
const labels = {};
const sourceNames = {};
const failures = [];
let rawCount = 0;
const rawExtensionCounts = {};
let xmpCount = 0;
let writtenCount = 0;
let reusedCount = 0;

for (const sourceDir of sourceDirs) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const xmpRatings = new Map();

  for (const name of files) {
    if (!/\.xmp$/i.test(name)) continue;
    xmpCount += 1;
    const fullPath = path.join(sourceDir, name);
    const text = await readFile(fullPath, 'utf8').catch(() => '');
    const rating = parseXmpRating(text);
    if (rating !== null) {
      xmpRatings.set(baseName(name), rating);
    }
  }

  for (const name of files) {
    const extension = path.extname(name).toLowerCase();
    if (!rawExtensions.has(extension)) continue;
    rawCount += 1;
    rawExtensionCounts[extension.slice(1)] = (rawExtensionCounts[extension.slice(1)] ?? 0) + 1;
    const id = baseName(name);
    const fullPath = path.join(sourceDir, name);
    const previewName = `${id}.jpg`;
    const previewPath = path.join(outputDir, previewName);
    sourceNames[id] = fullPath;
    if (externalLabels.has(id)) {
      labels[id] = externalLabels.get(id);
    } else if (xmpRatings.has(id)) {
      labels[id] = xmpRatings.get(id);
    }

    try {
      const existing = await stat(previewPath).catch(() => null);
      if (existing?.isFile() && existing.size > 0) {
        reusedCount += 1;
      } else {
        const buffer = await readFile(fullPath);
        const preview = findLargestEmbeddedJpeg(buffer);
        if (!preview) {
          failures.push({ file: fullPath, error: 'No embedded JPEG preview found.' });
          continue;
        }
        await writeFile(previewPath, buffer.subarray(preview.start, preview.end));
        writtenCount += 1;
      }
    } catch (error) {
      failures.push({
        file: fullPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if ((writtenCount + reusedCount + failures.length) % 100 === 0) {
      console.log(`Prepared ${writtenCount + reusedCount}/${rawCount} RAW previews...`);
    }
  }
}

const labelDistribution = Object.values(labels).reduce((counts, rating) => {
  counts[rating] = (counts[rating] ?? 0) + 1;
  return counts;
}, {});
const manifest = {
  createdAt: new Date().toISOString(),
  sourceDirs,
  outputDir,
  rawCount,
  rawExtensionCounts,
  nefCount: rawExtensionCounts.nef ?? 0,
  arwCount: rawExtensionCounts.arw ?? 0,
  xmpCount,
  externalLabelsPath: externalLabelsPath || undefined,
  externalLabelCount: externalLabels.size,
  previewCount: writtenCount + reusedCount,
  writtenCount,
  reusedCount,
  failures,
  labels,
  sourceNames,
  labelDistribution,
};

await writeFile(labelsPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({
  outputDir,
  labelsPath,
  rawCount,
  rawExtensionCounts,
  xmpCount,
  externalLabelCount: externalLabels.size,
  previewCount: manifest.previewCount,
  writtenCount,
  reusedCount,
  failureCount: failures.length,
  labelDistribution,
}, null, 2));

function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

async function loadExternalLabels(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  const source = parsed.records ?? parsed.labels ?? {};
  const ratings = new Map();
  for (const [key, value] of Object.entries(source)) {
    const rating = typeof value === 'object' && value
      ? clampRating(Number(value.rating ?? value.label))
      : clampRating(Number(value));
    if (rating !== null) ratings.set(baseName(key), rating);
  }
  return ratings;
}

function parseXmpRating(text) {
  const attribute = text.match(/\bxmp:Rating\s*=\s*["'](-?\d+)["']/i);
  if (attribute) return clampRating(Number(attribute[1]));
  const element = text.match(/<xmp:Rating>\s*(-?\d+)\s*<\/xmp:Rating>/i);
  if (element) return clampRating(Number(element[1]));
  return null;
}

function clampRating(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(5, Math.round(value)));
}

function findLargestEmbeddedJpeg(buffer) {
  let best = null;
  let position = 0;

  while (position + 4 < buffer.length) {
    const start = findJpegStart(buffer, position);
    if (start < 0) break;
    const end = findJpegEnd(buffer, start + 3);
    if (end < 0) {
      position = start + 3;
      continue;
    }
    if (!best || end - start > best.end - best.start) {
      best = { start, end };
    }
    position = end;
  }

  return best;
}

function findJpegStart(buffer, from) {
  for (let index = from; index + 2 < buffer.length; index += 1) {
    if (buffer[index] === 0xff && buffer[index + 1] === 0xd8 && buffer[index + 2] === 0xff) {
      return index;
    }
  }
  return -1;
}

function findJpegEnd(buffer, from) {
  for (let index = from; index + 1 < buffer.length; index += 1) {
    if (buffer[index] === 0xff && buffer[index + 1] === 0xd9) {
      return index + 2;
    }
  }
  return -1;
}
