import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILMSTRIP_ITEM_HEIGHT,
  getCenteredScrollTop,
  getScrollRow,
  getSelectionTrackingScrollTop,
  getVirtualRange,
  shouldSyncVirtualScroll,
} from './filmstripVirtualization';

describe('filmstrip virtualization helpers', () => {
  it('adds overscan around the visible range', () => {
    expect(getVirtualRange(100, DEFAULT_FILMSTRIP_ITEM_HEIGHT * 20, DEFAULT_FILMSTRIP_ITEM_HEIGHT * 5, DEFAULT_FILMSTRIP_ITEM_HEIGHT, 3)).toEqual({
      startIndex: 17,
      endIndex: 28,
    });
  });

  it('clamps the virtual range at list edges', () => {
    expect(getVirtualRange(12, 0, DEFAULT_FILMSTRIP_ITEM_HEIGHT * 4, DEFAULT_FILMSTRIP_ITEM_HEIGHT, 10)).toEqual({
      startIndex: 0,
      endIndex: 12,
    });
  });

  it('centers the selected item when there is room', () => {
    const viewportHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT * 6;
    const scrollTop = getCenteredScrollTop(20, viewportHeight, 100);
    const viewportCenter = scrollTop + viewportHeight / 2;
    const itemCenter = 20 * DEFAULT_FILMSTRIP_ITEM_HEIGHT + DEFAULT_FILMSTRIP_ITEM_HEIGHT / 2;

    expect(viewportCenter).toBe(itemCenter);
  });

  it('does not scroll beyond the first or last item', () => {
    const viewportHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT * 6;

    expect(getCenteredScrollTop(0, viewportHeight, 100)).toBe(0);
    expect(getCenteredScrollTop(99, viewportHeight, 100)).toBe(DEFAULT_FILMSTRIP_ITEM_HEIGHT * 100 - viewportHeight);
  });

  it('derives a stable scroll row for virtualization updates', () => {
    expect(getScrollRow(0)).toBe(0);
    expect(getScrollRow(DEFAULT_FILMSTRIP_ITEM_HEIGHT - 1)).toBe(0);
    expect(getScrollRow(DEFAULT_FILMSTRIP_ITEM_HEIGHT)).toBe(1);
  });

  it('only syncs virtual scroll when the list crosses into a new row', () => {
    expect(shouldSyncVirtualScroll(12, DEFAULT_FILMSTRIP_ITEM_HEIGHT - 8)).toBe(false);
    expect(shouldSyncVirtualScroll(12, DEFAULT_FILMSTRIP_ITEM_HEIGHT + 8)).toBe(true);
  });

  it('keeps the current scroll when selected item is inside the center comfort band', () => {
    const viewportHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT * 8;
    const currentScrollTop = DEFAULT_FILMSTRIP_ITEM_HEIGHT * 10;

    expect(getSelectionTrackingScrollTop(13, currentScrollTop, viewportHeight, 100)).toBe(currentScrollTop);
  });

  it('tracks toward center in bounded steps instead of forcing exact centering', () => {
    const viewportHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT * 8;
    const currentScrollTop = DEFAULT_FILMSTRIP_ITEM_HEIGHT * 10;
    const nextScrollTop = getSelectionTrackingScrollTop(17, currentScrollTop, viewportHeight, 100);

    expect(nextScrollTop).toBeGreaterThan(currentScrollTop);
    expect(nextScrollTop - currentScrollTop).toBeLessThanOrEqual(DEFAULT_FILMSTRIP_ITEM_HEIGHT * 1.25);
    expect(nextScrollTop).not.toBe(getCenteredScrollTop(17, viewportHeight, 100));
  });

  it('centers directly when selected item is outside the viewport', () => {
    const viewportHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT * 8;
    const currentScrollTop = DEFAULT_FILMSTRIP_ITEM_HEIGHT * 10;

    expect(getSelectionTrackingScrollTop(60, currentScrollTop, viewportHeight, 100)).toBe(
      getCenteredScrollTop(60, viewportHeight, 100),
    );
  });
});
