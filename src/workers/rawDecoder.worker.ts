import LibRaw from 'libraw-wasm';
import type { RawMetadata } from '../utils/rawDecodeLayout';
import { extractPixelData, resolveImageLayout, writeRgba } from '../utils/rawDecodeLayout';

interface DecodeRequest {
  type: 'decode';
  id: string;
  fileBuffer: ArrayBuffer;
  thumbnail: boolean;
}

interface DecodeResponse {
  type: 'success' | 'error';
  id: string;
  dataUrl?: string;
  error?: string;
  timing?: {
    total: number;
    fileRead: number;
    decode: number;
    conversion: number;
  };
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { type, id, fileBuffer, thumbnail } = event.data;
  if (type !== 'decode') return;

  const startTime = performance.now();
  const timing = {
    total: 0,
    fileRead: 0,
    decode: 0,
    conversion: 0,
  };

  try {
    const t1 = performance.now();
    const raw = new LibRaw();
    timing.fileRead = performance.now() - t1;

    const settings = {
      halfSize: true,
      outputBps: 8,
      useAutoWb: false,
      useCameraWb: true,
      outputColor: 1,
      userQual: thumbnail ? 0 : 1,
      medPasses: 0,
      fbddNoiserd: 0,
    };

    const t2 = performance.now();
    await raw.open(new Uint8Array(fileBuffer), settings);
    timing.decode = performance.now() - t2;

    const t3 = performance.now();
    const imageData = await raw.imageData();
    const metadata = await raw.metadata(false);
    const pixelData = extractPixelData(imageData);
    const { width, height, channels } = resolveImageLayout(pixelData, metadata as RawMetadata, imageData);

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');

    const output = ctx.createImageData(width, height);
    writeRgba(pixelData, output.data, width * height, channels);
    ctx.putImageData(output, 0, 0);

    const finalCanvas = scaleCanvas(canvas, thumbnail ? 360 : 3000);
    const blob = await finalCanvas.convertToBlob({ type: 'image/jpeg', quality: thumbnail ? 0.72 : 0.92 });
    const dataUrl = await blobToDataURL(blob);

    timing.conversion = performance.now() - t3;
    timing.total = performance.now() - startTime;

    const response: DecodeResponse = {
      type: 'success',
      id,
      dataUrl,
      timing,
    };
    self.postMessage(response);
  } catch (error) {
    const response: DecodeResponse = {
      type: 'error',
      id,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    self.postMessage(response);
  }
};
function scaleCanvas(canvas: OffscreenCanvas, maxEdge: number) {
  const longEdge = Math.max(canvas.width, canvas.height);
  if (longEdge <= maxEdge) return canvas;

  const scale = maxEdge / longEdge;
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const output = new OffscreenCanvas(width, height);
  const ctx = output.getContext('2d');
  if (!ctx) return canvas;
  ctx.drawImage(canvas, 0, 0, width, height);
  return output;
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export {};
