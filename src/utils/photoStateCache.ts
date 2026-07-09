import { PhotoGroup, PhotoRating, SelectionState } from '../types';
import { readStorage } from './storage';

const PHOTO_STATE_CACHE_KEY = 'framecull-photo-state-cache-v1';
const MAX_PHOTO_STATE_CACHE_ENTRIES = 12_000;

type CachedPhotoState = {
  selection: SelectionState;
  rating: PhotoRating;
  updatedAt: number;
};

type PhotoStateCache = Record<string, CachedPhotoState>;

export function applyCachedPhotoState(group: PhotoGroup, cache: PhotoStateCache = loadPhotoStateCache()) {
  const cached = cache[buildPhotoStateCacheKey(group)];
  if (!cached) return group;
  return {
    ...group,
    selection: cached.selection,
    rating: cached.rating,
  };
}

export function loadPhotoStateCache(): PhotoStateCache {
  try {
    const raw = readStorage(PHOTO_STATE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<CachedPhotoState>>;
    return Object.fromEntries(Object.entries(parsed)
      .map(([key, value]) => [key, normalizeCachedPhotoState(value)])
      .filter((entry): entry is [string, CachedPhotoState] => Boolean(entry[1])));
  } catch {
    return {};
  }
}

export function savePhotoStateCache(cache: PhotoStateCache) {
  const entries = Object.entries(cache)
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
    .slice(0, MAX_PHOTO_STATE_CACHE_ENTRIES);
  try {
    localStorage.setItem(PHOTO_STATE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // User culling state is opportunistic. Metadata/XMP remains the source of truth for ratings.
  }
}

export function rememberPhotoState(groups: PhotoGroup | PhotoGroup[]) {
  const items = Array.isArray(groups) ? groups : [groups];
  if (items.length === 0) return;
  const cache = loadPhotoStateCache();
  const updatedAt = Date.now();
  items.forEach(group => {
    cache[buildPhotoStateCacheKey(group)] = {
      selection: group.selection,
      rating: group.rating ?? 0,
      updatedAt,
    };
  });
  savePhotoStateCache(cache);
}

export function forgetPhotoState(groups: PhotoGroup | PhotoGroup[]) {
  const items = Array.isArray(groups) ? groups : [groups];
  if (items.length === 0) return;
  const cache = loadPhotoStateCache();
  items.forEach(group => {
    delete cache[buildPhotoStateCacheKey(group)];
  });
  savePhotoStateCache(cache);
}

export function clearPhotoStateCache() {
  try {
    const existed = localStorage.getItem(PHOTO_STATE_CACHE_KEY) !== null;
    localStorage.removeItem(PHOTO_STATE_CACHE_KEY);
    return existed;
  } catch {
    return false;
  }
}

export function buildPhotoStateCacheKey(group: PhotoGroup) {
  const source = group.raw ?? group.jpg;
  return [
    source?.path ?? source?.name ?? group.id,
    source?.size ?? 0,
    source?.modifiedMs ?? 0,
  ].join('|');
}

function normalizeCachedPhotoState(value: Partial<CachedPhotoState> | undefined): CachedPhotoState | null {
  if (!value || !isSelectionState(value.selection)) return null;
  const rating = normalizeCachedRating(value.rating);
  if (rating === null) return null;
  return {
    selection: value.selection,
    rating,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : 0,
  };
}

function isSelectionState(value: unknown): value is SelectionState {
  return value === SelectionState.UNMARKED || value === SelectionState.PICKED || value === SelectionState.REJECTED;
}

function normalizeCachedRating(value: unknown): PhotoRating | null {
  const rating = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(rating)) return null;
  const rounded = Math.round(Math.max(0, Math.min(5, rating)));
  return rounded as PhotoRating;
}
