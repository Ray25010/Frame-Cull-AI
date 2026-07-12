import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POSITION,
  PANEL_WIDTH,
  clampPanelPosition,
  formatElapsedTime,
  getDisplayedElapsedMs,
  getEdgeForPosition,
  getRestoredPosition,
  parseStoredPanelState,
} from './AiFloatingPanel';

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

describe('AiFloatingPanel edge docking helpers', () => {
  it('returns left edge when dropped at the minimum x bound', () => {
    expect(getEdgeForPosition({ x: 8, y: 92 }, VIEWPORT_WIDTH, PANEL_WIDTH)).toBe('left');
  });

  it('returns right edge when dropped at the maximum x bound', () => {
    const clamped = clampPanelPosition({ x: 9999, y: 92 }, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, PANEL_WIDTH);
    expect(getEdgeForPosition(clamped, VIEWPORT_WIDTH, PANEL_WIDTH)).toBe('right');
  });

  it('does not auto-hide the default position', () => {
    expect(getEdgeForPosition(DEFAULT_POSITION, VIEWPORT_WIDTH, PANEL_WIDTH)).toBeNull();
  });

  it('restores from the left edge into a safe visible inset', () => {
    const restored = getRestoredPosition('left', 92, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, PANEL_WIDTH);
    expect(restored.x).toBeGreaterThan(8);
    expect(getEdgeForPosition(restored, VIEWPORT_WIDTH, PANEL_WIDTH)).toBeNull();
  });

  it('restores from the right edge into a safe visible inset', () => {
    const restored = getRestoredPosition('right', 92, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, PANEL_WIDTH);
    const clampedMax = clampPanelPosition({ x: 9999, y: 92 }, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, PANEL_WIDTH);
    expect(restored.x).toBeLessThan(clampedMax.x);
    expect(getEdgeForPosition(restored, VIEWPORT_WIDTH, PANEL_WIDTH)).toBeNull();
  });

  it('parses legacy stored positions without losing compatibility', () => {
    const parsed = parseStoredPanelState(JSON.stringify({ x: 18, y: 92 }), VIEWPORT_WIDTH, VIEWPORT_HEIGHT, PANEL_WIDTH);
    expect(parsed.position).toEqual(DEFAULT_POSITION);
    expect(parsed.hiddenEdge).toBeNull();
  });

  it('formats elapsed time as m:ss below one hour', () => {
    expect(formatElapsedTime(65_000)).toBe('1:05');
  });

  it('formats elapsed time as h:mm:ss at one hour and above', () => {
    expect(formatElapsedTime(3_665_000)).toBe('1:01:05');
  });

  it('uses live elapsed time while running and freezes elapsed time while paused', () => {
    expect(getDisplayedElapsedMs({
      total: 100,
      processed: 10,
      running: true,
      paused: false,
      startedAt: 1_000,
      pausedTotalMs: 200,
      elapsedMs: 500,
    }, 4_000)).toBe(2_800);

    expect(getDisplayedElapsedMs({
      total: 100,
      processed: 10,
      running: true,
      paused: true,
      startedAt: 1_000,
      pausedTotalMs: 200,
      elapsedMs: 1_750,
    }, 8_000)).toBe(1_750);
  });
});
