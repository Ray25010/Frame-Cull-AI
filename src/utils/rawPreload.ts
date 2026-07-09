import { PhotoGroup } from '../types';

export function normalizeExifOrientation(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const rounded = Math.round(numeric);
  return rounded >= 1 && rounded <= 8 ? rounded : 1;
}

export function getRawPreloadWindowPaths(
  photos: PhotoGroup[],
  currentIndex: number,
  ahead: number,
  behindOrIsCached: number | ((path: string) => boolean) = 0,
  maybeIsCached?: (path: string) => boolean,
) {
  const behind = typeof behindOrIsCached === 'number' ? behindOrIsCached : 0;
  const isCached = typeof behindOrIsCached === 'function' ? behindOrIsCached : maybeIsCached || (() => false);
  const result: string[] = [];
  const seen = new Set<string>();
  const start = Math.max(0, currentIndex - Math.max(0, behind));
  const end = Math.min(photos.length - 1, currentIndex + Math.max(0, ahead));

  for (let index = Math.max(0, currentIndex); index <= end; index += 1) {
    const photo = photos[index];
    if (!photo || photo.jpg || !photo.raw?.path) continue;
    if (seen.has(photo.raw.path) || isCached(photo.raw.path)) continue;
    seen.add(photo.raw.path);
    result.push(photo.raw.path);
  }

  for (let index = currentIndex - 1; index >= start; index -= 1) {
    const photo = photos[index];
    if (!photo || photo.jpg || !photo.raw?.path) continue;
    if (seen.has(photo.raw.path) || isCached(photo.raw.path)) continue;
    seen.add(photo.raw.path);
    result.push(photo.raw.path);
  }

  return result;
}
