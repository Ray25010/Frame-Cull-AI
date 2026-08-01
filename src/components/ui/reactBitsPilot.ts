import type { ImportProgressPhase } from '../../types';

export type ImportStageState = 'waiting' | 'active' | 'done' | 'error';

const STAGES = ['scan', 'pair', 'metadata', 'preload'] as const;

export function buildImportStageModel(phase: ImportProgressPhase) {
  if (phase === 'error') {
    return {
      railProgress: 0,
      states: STAGES.map(() => 'error' as const),
    };
  }

  if (phase === 'done') {
    return {
      railProgress: 100,
      states: STAGES.map(() => 'done' as const),
    };
  }

  const activeIndex = STAGES.indexOf(phase as (typeof STAGES)[number]);
  const states: ImportStageState[] = STAGES.map((_, index) => {
    if (index < activeIndex) return 'done';
    if (index === activeIndex) return 'active';
    return 'waiting';
  });
  const railProgress = activeIndex <= 0
    ? 0
    : activeIndex === 1
      ? 33.333
      : activeIndex === 2
        ? 66.666
        : 100;

  return { railProgress, states };
}

export function getNotificationEnterDelay(index: number) {
  return `${Math.min(Math.max(index, 0), 4) * 45}ms`;
}

interface SpotlightTarget {
  getBoundingClientRect(): { left: number; top: number };
  style: { setProperty(name: string, value: string): void };
}

export function updateSpotlightPosition(
  target: SpotlightTarget,
  clientX: number,
  clientY: number,
) {
  const bounds = target.getBoundingClientRect();
  target.style.setProperty('--fc-spotlight-x', `${clientX - bounds.left}px`);
  target.style.setProperty('--fc-spotlight-y', `${clientY - bounds.top}px`);
}
