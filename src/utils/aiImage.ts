import { ExportColorSpace, ExportMetadataMode, PhotoGroup } from '../types';
import { readFile } from '@tauri-apps/plugin-fs';
import { decodeRawFile } from './rawLoader';
import { hasTauriRuntime } from './tauriRuntime';
import ExportRendererWorker from '../workers/exportRenderer.worker.ts?worker';

const ANALYSIS_MAX_EDGE = 1400;

type RenderedExportFile = {
  fileName: string;
  dataUrl: string;
  rating?: number;
  metadataMode?: ExportMetadataMode;
  metadataSourcePath?: string;
};
type RenderResponse = {
  type: 'success' | 'error';
  id: string;
  fileName?: string;
  dataUrl?: string;
  error?: string;
};

let exportWorker: Worker | null = null;

export async function prepareAnalysisImage(group: PhotoGroup, options: { maxEdge?: number } = {}): Promise<ImageData> {
  const source = await loadDisplaySource(group, { silentRawPreview: true });
  const bitmap = await createImageBitmap(source);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, options.maxEdge ?? ANALYSIS_MAX_EDGE);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error('Canvas is unavailable for local AI analysis.');
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

export async function renderGroupForExport(
  group: PhotoGroup,
  format: 'jpeg' | 'tiff' | 'png',
  options: { jpegQuality?: number; fileNameBase?: string; metadataMode?: ExportMetadataMode; colorSpace?: ExportColorSpace } = {},
): Promise<RenderedExportFile> {
  const source = await loadDisplaySource(group);
  const extension = format === 'tiff' ? 'tiff' : format === 'png' ? 'png' : 'jpg';
  const fileName = `${safeBaseName(options.fileNameBase || group.id)}.${extension}`;
  const rendered = await renderWithWorker(
    source,
    fileName,
    format,
    options.jpegQuality ?? 100,
    options.colorSpace ?? 'SRGB',
  );
  return {
    ...rendered,
    rating: group.rating,
    metadataMode: options.metadataMode ?? 'NONE',
    metadataSourcePath: group.jpg?.path,
  };
}

async function loadDisplaySource(group: PhotoGroup, options: { silentRawPreview?: boolean } = {}): Promise<Blob> {
  if (group.jpg?.previewUrl) {
    try {
      const response = await fetch(group.jpg.previewUrl);
      if (!response.ok) throw new Error(`Failed to load JPG preview: ${response.status}`);
      return response.blob();
    } catch (error) {
      if (!group.jpg.path || !hasTauriRuntime()) throw error;
    }
  }

  if (group.jpg?.path && hasTauriRuntime()) {
    const bytes = await readFile(group.jpg.path);
    return new Blob([bytes], { type: mimeTypeForExtension(group.jpg.extension) });
  }

  if (group.raw?.path) {
    const dataUrl = await decodeRawFile(group.raw.path, false, {
      priority: options.silentRawPreview ? 'low' : 'high',
      silent: options.silentRawPreview,
    });
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error('Failed to load RAW preview for analysis.');
    return response.blob();
  }

  throw new Error('No image preview available.');
}

function fitWithin(width: number, height: number, maxEdge: number) {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return { width, height };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function safeBaseName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'export';
}

function mimeTypeForExtension(extension: string) {
  const value = extension.toLowerCase();
  if (value === 'jpg' || value === 'jpeg') return 'image/jpeg';
  if (value === 'png') return 'image/png';
  if (value === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

function getExportWorker() {
  if (!exportWorker) {
    exportWorker = new ExportRendererWorker();
  }
  return exportWorker;
}

async function renderWithWorker(
  source: Blob,
  fileName: string,
  format: 'jpeg' | 'tiff' | 'png',
  jpegQuality: number,
  colorSpace: ExportColorSpace,
): Promise<RenderedExportFile> {
  const worker = getExportWorker();
  const id = `${fileName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sourceBuffer = await source.arrayBuffer();
  const mimeType = source.type || 'application/octet-stream';

  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<RenderResponse>) => {
      if (event.data.id !== id) return;
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);

      if (event.data.type === 'success' && event.data.fileName && event.data.dataUrl) {
        resolve({
          fileName: event.data.fileName,
          dataUrl: event.data.dataUrl,
        });
      } else {
        reject(new Error(event.data.error || 'Rendered export failed.'));
      }
    };

    const handleError = (error: ErrorEvent) => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(error.error || new Error(error.message));
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError, { once: true });
    worker.postMessage({
      type: 'render',
      id,
      fileName,
      format,
      sourceBuffer,
      mimeType,
      jpegQuality,
      colorSpace,
    }, [sourceBuffer]);
  });
}
