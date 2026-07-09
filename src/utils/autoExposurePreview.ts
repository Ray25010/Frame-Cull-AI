export type AutoExposurePreviewStats = {
  sampleWidth: number;
  sampleHeight: number;
  samplePixels: number;
  p10Luma: number;
  p50Luma: number;
  p90Luma: number;
  p98Luma: number;
  meanLuma: number;
  shadowRatio: number;
  highlightRatio: number;
  clippedHighlightRatio: number;
};

export type AutoExposurePreviewAdjustment = {
  ev: number;
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  stats: AutoExposurePreviewStats;
  elapsedMs?: number;
};

const DEFAULT_TARGET_MEDIAN_LUMA = 0.42;

export function computeLumaStatsFromRgba(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): AutoExposurePreviewStats {
  const histogram = new Uint32Array(256);
  let samplePixels = 0;
  let lumaSum = 0;

  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = data[index + 3] ?? 255;
    if (alpha < 16) continue;

    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    const lumaByte = Math.max(0, Math.min(255, Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue)));
    histogram[lumaByte] += 1;
    samplePixels += 1;
    lumaSum += lumaByte / 255;
  }

  if (samplePixels === 0) {
    return {
      sampleWidth: width,
      sampleHeight: height,
      samplePixels: 0,
      p10Luma: 0,
      p50Luma: 0,
      p90Luma: 0,
      p98Luma: 0,
      meanLuma: 0,
      shadowRatio: 0,
      highlightRatio: 0,
      clippedHighlightRatio: 0,
    };
  }

  const countRange = (start: number, end: number) => {
    let count = 0;
    for (let value = start; value <= end; value += 1) count += histogram[value] ?? 0;
    return count;
  };

  return {
    sampleWidth: width,
    sampleHeight: height,
    samplePixels,
    p10Luma: percentileFromHistogram(histogram, samplePixels, 0.10),
    p50Luma: percentileFromHistogram(histogram, samplePixels, 0.50),
    p90Luma: percentileFromHistogram(histogram, samplePixels, 0.90),
    p98Luma: percentileFromHistogram(histogram, samplePixels, 0.98),
    meanLuma: lumaSum / samplePixels,
    shadowRatio: countRange(0, 26) / samplePixels,
    highlightRatio: countRange(230, 255) / samplePixels,
    clippedHighlightRatio: countRange(250, 255) / samplePixels,
  };
}

export function computeAutoExposureAdjustment(
  stats: AutoExposurePreviewStats,
): AutoExposurePreviewAdjustment {
  if (stats.samplePixels <= 0) {
    return {
      ev: 0,
      brightness: 1,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      confidence: 'low',
      reason: 'no-sample',
      stats,
    };
  }

  const median = clamp(stats.p50Luma, 0.03, 0.97);
  const rawEv = Math.log2(DEFAULT_TARGET_MEDIAN_LUMA / median) * 0.72;
  let ev = rawEv;
  let reason = 'median-target';

  const darkMood = stats.p50Luma < 0.16 && stats.p90Luma < 0.40;
  if (darkMood) {
    ev *= 0.55;
    ev = Math.min(ev, 0.65);
    reason = 'dark-scene-conservative';
  } else {
    ev = Math.min(ev, 1.35);
  }

  if (stats.p98Luma > 0.92) {
    ev = Math.min(ev, 0.35);
    reason = 'highlight-protected';
  }
  if (stats.clippedHighlightRatio > 0.015) {
    ev = Math.min(ev, 0.15);
    reason = 'clipped-highlight-protected';
  }
  if (stats.clippedHighlightRatio > 0.04) {
    ev = Math.min(ev, 0);
    reason = 'heavy-clipping-protected';
  }

  ev = clamp(ev, -0.60, 1.35);
  if (Math.abs(ev) < 0.08) ev = 0;

  const brightness = Math.pow(2, ev);
  const gamma = ev > 0 ? 1 - Math.min(0.10, ev * 0.08) : 1;
  const confidence = stats.samplePixels < 4096
    ? 'low'
    : stats.clippedHighlightRatio > 0.04 || darkMood
      ? 'medium'
      : 'high';

  return {
    ev,
    brightness,
    contrast: ev > 0.12 ? 1.03 : 1,
    saturation: ev > 0.12 ? 1.02 : 1,
    gamma,
    confidence,
    reason,
    stats,
  };
}

export async function computeAutoExposurePreviewFromImage(
  image: HTMLImageElement,
  options: { sampleMaxEdge?: number } = {},
): Promise<AutoExposurePreviewAdjustment> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    throw new Error('Image is not ready');
  }

  const sampleMaxEdge = options.sampleMaxEdge ?? 360;
  const longest = Math.max(naturalWidth, naturalHeight);
  const scale = longest > sampleMaxEdge ? sampleMaxEdge / longest : 1;
  const sampleWidth = Math.max(1, Math.round(naturalWidth * scale));
  const sampleHeight = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available');

  ctx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
  const adjustment = computeAutoExposureAdjustment(
    computeLumaStatsFromRgba(pixels.data, sampleWidth, sampleHeight),
  );
  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    ...adjustment,
    elapsedMs: Math.max(0, ended - started),
  };
}

export function buildAutoExposureCssFilter(adjustment: AutoExposurePreviewAdjustment | null) {
  if (!adjustment || adjustment.ev === 0) return undefined;
  return [
    `brightness(${formatCssNumber(adjustment.brightness)})`,
    `contrast(${formatCssNumber(adjustment.contrast)})`,
    `saturate(${formatCssNumber(adjustment.saturation)})`,
  ].join(' ');
}

function percentileFromHistogram(histogram: Uint32Array, total: number, percentile: number) {
  const target = Math.max(1, Math.ceil(total * percentile));
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value] ?? 0;
    if (cumulative >= target) return value / 255;
  }
  return 1;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatCssNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(3) : '1.000';
}
