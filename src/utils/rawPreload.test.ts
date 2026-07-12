import { describe, expect, it } from 'vitest';
import { GroupStatus, PhotoGroup, SelectionState } from '../types';
import { getRawPreloadWindowPaths, normalizeExifOrientation } from './rawPreload';

function photo(id: string, rawPath?: string, hasJpg = false): PhotoGroup {
  return {
    id,
    status: hasJpg && rawPath ? GroupStatus.COMPLETE : rawPath ? GroupStatus.RAW_ONLY : GroupStatus.JPG_ONLY,
    selection: SelectionState.UNMARKED,
    rating: 0,
    jpg: hasJpg ? {
      name: `${id}.jpg`,
      extension: 'JPG',
      file: null as never,
      previewUrl: `asset://${id}.jpg`,
      size: 100,
      path: `C:/photos/${id}.jpg`,
    } : undefined,
    raw: rawPath ? {
      name: `${id}.nef`,
      extension: 'NEF',
      file: null as never,
      previewUrl: rawPath,
      size: 100,
      path: rawPath,
    } : undefined,
  };
}

describe('normalizeExifOrientation', () => {
  it('keeps valid EXIF orientation values', () => {
    expect(normalizeExifOrientation(1)).toBe(1);
    expect(normalizeExifOrientation(6)).toBe(6);
    expect(normalizeExifOrientation('8')).toBe(8);
  });

  it('falls back to normal orientation for invalid values', () => {
    expect(normalizeExifOrientation(undefined)).toBe(1);
    expect(normalizeExifOrientation(0)).toBe(1);
    expect(normalizeExifOrientation(9)).toBe(1);
    expect(normalizeExifOrientation('sideways')).toBe(1);
  });
});

describe('getRawPreloadWindowPaths', () => {
  it('returns only RAW-only photos from current through the lookahead window', () => {
    const photos = [
      photo('jpg-only'),
      photo('raw-1', 'C:/photos/raw-1.nef'),
      photo('complete', 'C:/photos/complete.nef', true),
      photo('raw-2', 'C:/photos/raw-2.nef'),
      photo('raw-3', 'C:/photos/raw-3.nef'),
    ];

    expect(getRawPreloadWindowPaths(photos, 1, 2)).toEqual([
      'C:/photos/raw-1.nef',
      'C:/photos/raw-2.nef',
    ]);
  });

  it('skips cached paths and duplicate raw files', () => {
    const photos = [
      photo('raw-1', 'C:/photos/raw-1.nef'),
      photo('raw-1-copy', 'C:/photos/raw-1.nef'),
      photo('raw-2', 'C:/photos/raw-2.nef'),
    ];

    expect(getRawPreloadWindowPaths(photos, 0, 20, path => path.endsWith('raw-2.nef'))).toEqual([
      'C:/photos/raw-1.nef',
    ]);
  });

  it('adds previous RAW-only photos after the current and forward window', () => {
    const photos = [
      photo('raw-0', 'C:/photos/raw-0.nef'),
      photo('raw-1', 'C:/photos/raw-1.nef'),
      photo('raw-2', 'C:/photos/raw-2.nef'),
      photo('raw-3', 'C:/photos/raw-3.nef'),
      photo('raw-4', 'C:/photos/raw-4.nef'),
    ];

    expect(getRawPreloadWindowPaths(photos, 2, 1, 2)).toEqual([
      'C:/photos/raw-2.nef',
      'C:/photos/raw-3.nef',
      'C:/photos/raw-1.nef',
      'C:/photos/raw-0.nef',
    ]);
  });
});
