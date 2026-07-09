import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupStatus, SelectionState, type PhotoGroup } from '../types';
import { applyCachedPhotoState, forgetPhotoState, loadPhotoStateCache, rememberPhotoState } from './photoStateCache';

function makePhoto(overrides: Partial<PhotoGroup> = {}): PhotoGroup {
  return {
    id: 'IMG_0001',
    status: GroupStatus.COMPLETE,
    selection: SelectionState.UNMARKED,
    rating: 0,
    jpg: {
      name: 'IMG_0001.JPG',
      extension: 'JPG',
      file: null as unknown as File,
      previewUrl: 'asset://IMG_0001.JPG',
      size: 2048,
      modifiedMs: 1710000000000,
      path: 'C:/photos/IMG_0001.JPG',
    },
    ...overrides,
  };
}

describe('photo state cache', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
    });
    vi.useFakeTimers();
    vi.setSystemTime(1711111111000);
  });

  it('restores cached selection and rating for the same file identity', () => {
    rememberPhotoState(makePhoto({
      selection: SelectionState.REJECTED,
      rating: 3,
    }));

    const restored = applyCachedPhotoState(makePhoto());

    expect(restored.selection).toBe(SelectionState.REJECTED);
    expect(restored.rating).toBe(3);
  });

  it('does not restore state when file mtime changes', () => {
    rememberPhotoState(makePhoto({
      selection: SelectionState.REJECTED,
      rating: 4,
    }));

    const restored = applyCachedPhotoState(makePhoto({
      jpg: {
        ...makePhoto().jpg!,
        modifiedMs: 1710000000001,
      },
    }));

    expect(restored.selection).toBe(SelectionState.UNMARKED);
    expect(restored.rating).toBe(0);
  });

  it('forgets deleted photo state', () => {
    const photo = makePhoto({
      selection: SelectionState.PICKED,
      rating: 5,
    });
    rememberPhotoState(photo);
    forgetPhotoState(photo);

    expect(loadPhotoStateCache()).toEqual({});
  });
});
