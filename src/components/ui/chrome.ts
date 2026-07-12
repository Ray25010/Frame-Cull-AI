export const chromeSolid = {
  dark: 'border-white/[0.055] bg-[#17191d] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]',
  light: 'border-slate-300/70 bg-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.74)]',
} as const;

export const chromeGlass = {
  dark: 'border-white/[0.06] bg-[#17191d]/[0.84] shadow-[0_10px_24px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.055)] backdrop-blur-[36px] backdrop-saturate-150',
  light: 'border-slate-400/24 bg-slate-200/[0.84] shadow-[0_8px_18px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-[32px] backdrop-saturate-150',
} as const;

export const chromePopover = {
  dark: 'border-white/[0.07] bg-[#1b1d21]/[0.92] shadow-[0_14px_34px_rgba(0,0,0,0.30),inset_0_1px_0_rgba(255,255,255,0.045)] backdrop-blur-[40px] backdrop-saturate-150',
  light: 'border-slate-400/28 bg-slate-100/[0.93] shadow-[0_12px_26px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.76)] backdrop-blur-[36px] backdrop-saturate-150',
} as const;

export const glassInteractive = {
  dark: 'text-zinc-300 hover:bg-white/[0.05] hover:text-zinc-50',
  light: 'text-slate-700 hover:bg-white/[0.46] hover:text-slate-950',
} as const;

export const chromeActive = {
  dark: 'bg-cyan-300/[0.11] text-zinc-50 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.13),inset_0_1px_0_rgba(255,255,255,0.08)]',
  light: 'bg-white/68 text-slate-950 shadow-[inset_0_0_0_1px_rgba(8,145,178,0.16),inset_0_1px_0_rgba(255,255,255,0.86)]',
} as const;

export const chromeSubtle = {
  dark: 'border-white/[0.05] bg-white/[0.045]',
  light: 'border-slate-400/24 bg-slate-100/[0.66]',
} as const;

export const photoOverlay = {
  dark: 'border-white/[0.06] bg-[#17191d]/[0.86] shadow-[0_10px_24px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-[24px] backdrop-saturate-150',
  light: 'border-slate-400/28 bg-slate-100/[0.84] shadow-[0_8px_18px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.76)] backdrop-blur-[22px] backdrop-saturate-150',
} as const;

export const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/45 focus-visible:ring-offset-0';

export const glassSurface = chromeGlass;
export const glassPopover = chromePopover;
export const glassActive = chromeActive;
export const glassSubtle = chromeSubtle;

export const modalBackdrop = 'bg-black/50 backdrop-blur-sm';
