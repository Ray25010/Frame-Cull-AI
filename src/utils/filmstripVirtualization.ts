export const DEFAULT_FILMSTRIP_ITEM_HEIGHT = 108;
export const DEFAULT_FILMSTRIP_OVERSCAN = 18;

export interface VirtualRange {
  startIndex: number;
  endIndex: number;
}

export function getVirtualRange(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  itemHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT,
  overscan = DEFAULT_FILMSTRIP_OVERSCAN,
): VirtualRange {
  if (total <= 0 || viewportHeight <= 0 || itemHeight <= 0) {
    return { startIndex: 0, endIndex: 0 };
  }

  const visibleStart = Math.floor(Math.max(0, scrollTop) / itemHeight);
  const visibleEnd = Math.ceil((Math.max(0, scrollTop) + viewportHeight) / itemHeight);
  return {
    startIndex: clampIndex(visibleStart - overscan, total),
    endIndex: clampIndex(visibleEnd + overscan, total),
  };
}

export function getScrollRow(scrollTop: number, itemHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT) {
  if (itemHeight <= 0) return 0;
  return Math.max(0, Math.floor(Math.max(0, scrollTop) / itemHeight));
}

export function shouldSyncVirtualScroll(
  previousScrollTop: number,
  nextScrollTop: number,
  itemHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT,
) {
  return getScrollRow(previousScrollTop, itemHeight) !== getScrollRow(nextScrollTop, itemHeight);
}

export function getCenteredScrollTop(
  index: number,
  viewportHeight: number,
  total: number,
  itemHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT,
) {
  if (index < 0 || total <= 0 || viewportHeight <= 0 || itemHeight <= 0) return 0;
  const maxScrollTop = Math.max(0, total * itemHeight - viewportHeight);
  const itemCenter = index * itemHeight + itemHeight / 2;
  return clamp(itemCenter - viewportHeight / 2, 0, maxScrollTop);
}

export function getBufferedCenteredScrollTop(
  index: number,
  currentScrollTop: number,
  viewportHeight: number,
  total: number,
  itemHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT,
  centerBandRatio = 0.34,
) {
  if (index < 0 || total <= 0 || viewportHeight <= 0 || itemHeight <= 0) return 0;

  const itemCenter = index * itemHeight + itemHeight / 2;
  const safeBand = Math.max(0.12, Math.min(0.72, centerBandRatio));
  const bandStart = currentScrollTop + viewportHeight * (0.5 - safeBand / 2);
  const bandEnd = currentScrollTop + viewportHeight * (0.5 + safeBand / 2);

  if (itemCenter >= bandStart && itemCenter <= bandEnd) {
    return currentScrollTop;
  }

  return getCenteredScrollTop(index, viewportHeight, total, itemHeight);
}

export function getSelectionTrackingScrollTop(
  index: number,
  currentScrollTop: number,
  viewportHeight: number,
  total: number,
  itemHeight = DEFAULT_FILMSTRIP_ITEM_HEIGHT,
  centerBandRatio = 0.58,
  maxStepRows = 1.25,
) {
  if (index < 0 || total <= 0 || viewportHeight <= 0 || itemHeight <= 0) return 0;

  const maxScrollTop = Math.max(0, total * itemHeight - viewportHeight);
  const current = clamp(currentScrollTop, 0, maxScrollTop);
  const itemCenter = index * itemHeight + itemHeight / 2;
  const viewportStart = current;
  const viewportEnd = current + viewportHeight;

  if (itemCenter < viewportStart || itemCenter > viewportEnd) {
    return getCenteredScrollTop(index, viewportHeight, total, itemHeight);
  }

  const safeBand = Math.max(0.2, Math.min(0.76, centerBandRatio));
  const bandStart = current + viewportHeight * (0.5 - safeBand / 2);
  const bandEnd = current + viewportHeight * (0.5 + safeBand / 2);

  if (itemCenter >= bandStart && itemCenter <= bandEnd) {
    return current;
  }

  const centered = getCenteredScrollTop(index, viewportHeight, total, itemHeight);
  const maxDelta = Math.max(itemHeight, itemHeight * maxStepRows);
  return clamp(current + clamp(centered - current, -maxDelta, maxDelta), 0, maxScrollTop);
}

function clampIndex(index: number, total: number) {
  return Math.max(0, Math.min(total, index));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
