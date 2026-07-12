type RawMetadata = Record<string, any>;

type ImageLayout = {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
};

export function extractPixelData(imageData: unknown): Uint8Array | number[] {
  if (Array.isArray(imageData)) {
    if (imageData.length === 0) {
      throw new Error('No image data returned from RAW decoder');
    }
    return imageData;
  }

  if (isByteView(imageData)) {
    if (imageData.byteLength === 0) {
      throw new Error('No image data returned from RAW decoder');
    }
    return new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength);
  }

  if (imageData && typeof imageData === 'object') {
    const candidate = (imageData as any).data ?? (imageData as any).pixels;
    if (Array.isArray(candidate)) {
      if (candidate.length === 0) {
        throw new Error('No image data returned from RAW decoder');
      }
      return candidate;
    }

    if (isByteView(candidate)) {
      if (candidate.byteLength === 0) {
        throw new Error('No image data returned from RAW decoder');
      }
      return new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength);
    }

    if (candidate && typeof candidate.length === 'number' && candidate.length > 0) {
      return candidate as Uint8Array | number[];
    }

    const bufferCandidate = (imageData as any).buffer;
    const length = Number((imageData as any).length);
    if (bufferCandidate instanceof ArrayBuffer && Number.isFinite(length) && length > 0) {
      const offset = Number((imageData as any).byteOffset ?? 0);
      return new Uint8Array(bufferCandidate, offset, length);
    }
  }

  throw new Error('No image data returned from RAW decoder');
}

export function resolveImageLayout(
  pixelData: Uint8Array | number[],
  metadata: RawMetadata,
  imageData: unknown,
): ImageLayout {
  const candidates = collectDimensionCandidates(metadata, imageData);

  for (const { width, height } of candidates) {
    const pixels = width * height;
    if (pixelData.length === pixels * 4) return { width, height, channels: 4 };
    if (pixelData.length === pixels * 3) return { width, height, channels: 3 };
    if (pixelData.length === pixels) return { width, height, channels: 1 };
  }

  throw new Error(
    `Unsupported RAW pixel layout (${pixelData.length} samples). ` +
    `Metadata candidates: ${candidates.map(({ width, height }) => `${width}x${height}`).join(', ') || 'none'}`,
  );
}

export function collectDimensionCandidates(metadata: RawMetadata, imageData: unknown) {
  const unique = new Map<string, { width: number; height: number }>();
  const sources = [
    [metadata?.width, metadata?.height],
    [metadata?.sizes?.width, metadata?.sizes?.height],
    [metadata?.sizes?.iwidth, metadata?.sizes?.iheight],
    [metadata?.sizes?.raw_width, metadata?.sizes?.raw_height],
    [(imageData as any)?.width, (imageData as any)?.height],
  ] as const;

  for (const [rawWidth, rawHeight] of sources) {
    addDimensionCandidate(unique, Number(rawWidth), Number(rawHeight));
  }

  for (const { width, height } of Array.from(unique.values())) {
    addDimensionCandidate(unique, height, width);
    addDimensionCandidate(unique, Math.floor(width / 2), Math.floor(height / 2));
    addDimensionCandidate(unique, Math.ceil(width / 2), Math.ceil(height / 2));
    addDimensionCandidate(unique, Math.floor(height / 2), Math.floor(width / 2));
    addDimensionCandidate(unique, Math.ceil(height / 2), Math.ceil(width / 2));
  }

  return Array.from(unique.values());
}

export function writeRgba(
  pixelData: Uint8Array | number[],
  rgbaData: Uint8ClampedArray,
  pixels: number,
  channels: 1 | 3 | 4,
) {
  let sourceIndex = 0;
  let destIndex = 0;

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const r = pixelData[sourceIndex++] ?? 0;
    const g = channels === 1 ? r : pixelData[sourceIndex++] ?? 0;
    const b = channels === 1 ? r : pixelData[sourceIndex++] ?? 0;
    const a = channels === 4 ? pixelData[sourceIndex++] ?? 255 : 255;

    rgbaData[destIndex++] = r;
    rgbaData[destIndex++] = g;
    rgbaData[destIndex++] = b;
    rgbaData[destIndex++] = a;
  }
}

function isByteView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function addDimensionCandidate(
  candidates: Map<string, { width: number; height: number }>,
  width: number,
  height: number,
) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (width <= 0 || height <= 0) return;
  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  const key = `${roundedWidth}x${roundedHeight}`;
  if (!candidates.has(key)) {
    candidates.set(key, { width: roundedWidth, height: roundedHeight });
  }
}

export type { ImageLayout, RawMetadata };
