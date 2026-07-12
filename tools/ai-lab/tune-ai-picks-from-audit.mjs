import { readFile } from 'node:fs/promises';
import path from 'node:path';

const auditPath = process.argv[2];
if (!auditPath) {
  throw new Error('Usage: node tools/ai-lab/tune-ai-picks-from-audit.mjs <audit-json>');
}

const audit = JSON.parse(await readFile(auditPath, 'utf8'));
const photos = audit.photoSummaries || [];
const totalUsable = photos.filter(isUsableLoose).length;
const duplicateGroups = audit.duplicateStats?.largeGroups || [];
const configs = [
  { name: 'baseline-score-0.38', ratio: 0.38, scoreMode: 'current', groupRadius: 0 },
  { name: 'ratio-0.45-current', ratio: 0.45, scoreMode: 'current', groupRadius: 0 },
  { name: 'ratio-0.50-current', ratio: 0.50, scoreMode: 'current', groupRadius: 0 },
  { name: 'ratio-0.55-current', ratio: 0.55, scoreMode: 'current', groupRadius: 0 },
  { name: 'ratio-0.45-humanlike', ratio: 0.45, scoreMode: 'humanlike', groupRadius: 0 },
  { name: 'ratio-0.50-humanlike', ratio: 0.50, scoreMode: 'humanlike', groupRadius: 0 },
  { name: 'ratio-0.55-humanlike', ratio: 0.55, scoreMode: 'humanlike', groupRadius: 0 },
  { name: 'ratio-0.50-humanlike-neighbor-suppress', ratio: 0.50, scoreMode: 'humanlike', groupRadius: 2 },
  { name: 'ratio-0.55-humanlike-neighbor-suppress', ratio: 0.55, scoreMode: 'humanlike', groupRadius: 2 },
];

const results = configs.map(config => evaluateConfig(config));
console.log(JSON.stringify({
  auditPath: path.resolve(auditPath),
  total: photos.length,
  totalUsable,
  labeled: photos.filter(photo => photo.groundTruthRating !== undefined).length,
  positives: photos.filter(photo => photo.groundTruthPositive).length,
  results,
}, null, 2));

function evaluateConfig(config) {
  const target = Math.ceil(totalUsable * config.ratio);
  const picked = new Set();
  const ranked = photos
    .filter(isUsableLoose)
    .sort((left, right) => rank(right, config.scoreMode) - rank(left, config.scoreMode));

  for (const photo of ranked) {
    if (picked.size >= target) break;
    if (config.groupRadius > 0 && conflictsWithPicked(photo, picked, config.groupRadius)) continue;
    picked.add(photo.id);
  }

  const labeled = photos.filter(photo => photo.groundTruthRating !== undefined);
  const positives = labeled.filter(photo => photo.groundTruthPositive);
  const negatives = labeled.filter(photo => !photo.groundTruthPositive);
  const pickedPositive = positives.filter(photo => picked.has(photo.id));
  const pickedNegative = negatives.filter(photo => picked.has(photo.id));
  const pickedLabeled = labeled.filter(photo => picked.has(photo.id));
  const selectedAdjacentPairs = selectedAdjacentSimilarPairs([...picked]);
  return {
    ...config,
    target,
    picked: picked.size,
    truePositive: pickedPositive.length,
    falseNegative: positives.length - pickedPositive.length,
    falsePositive: pickedNegative.length,
    recall: round(pickedPositive.length / Math.max(1, positives.length)),
    precisionOnLabeled: round(pickedPositive.length / Math.max(1, pickedLabeled.length)),
    negativePickRate: round(pickedNegative.length / Math.max(1, negatives.length)),
    selectedAdjacentPairs,
    picked3: pickedPositive.filter(photo => photo.groundTruthRating === 3).length,
    total3: positives.filter(photo => photo.groundTruthRating === 3).length,
    picked4: pickedPositive.filter(photo => photo.groundTruthRating === 4).length,
    total4: positives.filter(photo => photo.groundTruthRating === 4).length,
  };
}

function isUsableLoose(photo) {
  if (photo.status !== 'DONE') return false;
  if ((photo.hardIssueCodes || []).length > 0) return false;
  if ((photo.issueCodes || []).length > 0) return false;
  if ((photo.exclusionReasons || []).includes('FOCUS_FAIL')) return false;
  if ((photo.exclusionReasons || []).includes('TECHNICAL_GATE_FAIL') && (photo.overall ?? 0) < 60) return false;
  return (photo.overall ?? 0) >= 54 && (photo.technical ?? 0) >= 15;
}

function rank(photo, mode) {
  const overall = photo.overall ?? 0;
  const technical = photo.technical ?? 0;
  const aesthetic = photo.aesthetic ?? 0;
  const scene = photo.scene ?? 0;
  const focus = photo.focusTexture ?? 0;
  const peak = photo.focusPeakTexture ?? 0;
  const focusReliability = photo.focusReliability ?? 0.5;
  if (mode === 'humanlike') {
    return (
      overall * 1.05 +
      aesthetic * 0.42 +
      scene * 0.32 +
      Math.min(technical, 55) * 0.16 +
      Math.min(Math.max(focus, peak), 48) * 0.08 +
      focusReliability * 4
    );
  }
  return overall * 1.2 + technical * 0.25 + scene * 0.12;
}

function conflictsWithPicked(photo, picked, radius) {
  const number = trailingNumber(photo.id);
  if (number === null) return false;
  const prefix = photo.id.replace(/\d+(?!.*\d)/, '');
  for (const id of picked) {
    const pickedNumber = trailingNumber(id);
    if (pickedNumber === null) continue;
    if (id.replace(/\d+(?!.*\d)/, '') !== prefix) continue;
    if (Math.abs(pickedNumber - number) <= radius) return true;
  }
  return false;
}

function selectedAdjacentSimilarPairs(selectedIds) {
  const selected = selectedIds
    .map(id => photos.find(photo => photo.id === id))
    .filter(Boolean)
    .sort((left, right) => (trailingNumber(left.id) ?? 0) - (trailingNumber(right.id) ?? 0));
  let count = 0;
  for (let index = 1; index < selected.length; index += 1) {
    const left = selected[index - 1];
    const right = selected[index];
    const leftNumber = trailingNumber(left.id);
    const rightNumber = trailingNumber(right.id);
    if (leftNumber === null || rightNumber === null) continue;
    if (Math.abs(rightNumber - leftNumber) <= 3) count += 1;
  }
  return count;
}

function trailingNumber(value) {
  const match = value.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

function round(value) {
  return Number(value.toFixed(4));
}
