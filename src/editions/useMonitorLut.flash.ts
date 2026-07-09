import type { CubeLut3D } from '../types';
import type { Language } from '../i18n';

export type MonitorLutState = {
  status: 'inactive' | 'loading' | 'ready' | 'error';
  lut: CubeLut3D | null;
  notice: string | null;
};

export function useMonitorLut(_options: {
  enabled?: boolean;
  path?: string;
  name?: string;
  language: Language;
}): MonitorLutState {
  return {
    status: 'inactive',
    lut: null,
    notice: null,
  };
}
