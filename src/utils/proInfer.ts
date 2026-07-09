// Pro-only client for the native ONNX Runtime inference layer
// (PRO_MODEL_ARCHITECTURE.md §10). Every entry point hard-gates on
// IS_PRO_EDITION, so the Flash runtime never invokes `pro_infer_*` and never
// touches the native session. The wasm worker path (aiAnalyzer.worker.ts /
// peopleSplit.worker.ts) is left completely untouched; in Pro we re-run the
// aesthetic head natively in the main thread and feed it into photoScoring.
import { invoke } from '@tauri-apps/api/core';
import { resolveResource } from '@tauri-apps/api/path';
import { IS_PRO_EDITION } from './appInfo';
import { readStorage } from './storage';
import type { ProBatchRequest, ProBatchResponse, ProInferCapabilities } from '../types';

const DEFAULT_MANIFEST_RESOURCE = 'pro-models/semantic_student_v2_grounded_convnext_v14_five_mountain_region/manifest.int8.json';
export const PRO_MODEL_MANIFEST_STORAGE_KEY = 'framecull-pro-model-manifest-path';

let initPromise: Promise<ProInferCapabilities | null> | null = null;
let capabilities: ProInferCapabilities | null = null;
let activeManifestPath: string | null = null;

function configuredManifestPath() {
  const fromStorage = readStorage(PRO_MODEL_MANIFEST_STORAGE_KEY)?.trim();
  if (fromStorage) return fromStorage;
  const fromEnv = import.meta.env.VITE_FRAMECULL_PRO_MODEL_MANIFEST?.trim();
  return fromEnv || '';
}

async function resolveManifestPath() {
  const configured = configuredManifestPath();
  if (configured) return configured;
  return await resolveResource(DEFAULT_MANIFEST_RESOURCE);
}

/**
 * Probe + load the native session once. Returns the capabilities actually in
 * effect, or null when unavailable (non-Pro build, missing manifest, or an
 * init failure). Initialization failures never throw to the caller; the
 * culling pipeline keeps running and simply does not get a native aesthetic.
 */
export async function ensureProInfer(): Promise<ProInferCapabilities | null> {
  if (!IS_PRO_EDITION) return null;
  const manifestPath = await resolveManifestPath();
  if (capabilities && activeManifestPath === manifestPath) return capabilities;
  if (initPromise && activeManifestPath === manifestPath) return initPromise;

  activeManifestPath = manifestPath;
  capabilities = null;
  initPromise = (async () => {
    try {
      const caps = await invoke<ProInferCapabilities>('pro_infer_init', {
        manifestPath,
      });
      capabilities = caps;
      return caps;
    } catch (error) {
      console.warn('[pro-infer] native init failed; aesthetic falls back to worker', error);
      if (activeManifestPath === manifestPath) {
        capabilities = null;
      }
      return null;
    }
  })();
  return initPromise;
}

export function getProInferManifestPath() {
  return activeManifestPath;
}

export function getConfiguredProManifestPath() {
  return configuredManifestPath();
}

export async function getDefaultProManifestPath() {
  return await resolveResource(DEFAULT_MANIFEST_RESOURCE);
}

export function isUsingCustomProManifestPath() {
  return Boolean(configuredManifestPath());
}

export function getProInferCapabilities(): ProInferCapabilities | null {
  return capabilities;
}

/**
 * Run native batch inference for a set of image paths. Caller must have a
 * ready session (ensureProInfer resolved non-null). Returns null on any failure
 * so the pipeline degrades gracefully rather than aborting the run.
 */
export async function proInferBatch(
  imagePaths: string[],
  batchSize?: number,
): Promise<ProBatchResponse | null> {
  if (!IS_PRO_EDITION || imagePaths.length === 0) return null;
  const req: ProBatchRequest = { imagePaths, batchSize };
  try {
    return await invoke<ProBatchResponse>('pro_infer_batch', { req });
  } catch (error) {
    console.warn('[pro-infer] native batch failed', error);
    return null;
  }
}

/** Reset cached state (test/teardown helper). */
export function resetProInferState() {
  initPromise = null;
  capabilities = null;
  activeManifestPath = null;
}
