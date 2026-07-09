import { useEffect, useState } from 'react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import type { CubeLut3D } from '../types';
import type { Language } from '../i18n';
import { parseCubeLut } from '../utils/cubeLut';

export type MonitorLutState = {
  status: 'inactive' | 'loading' | 'ready' | 'error';
  lut: CubeLut3D | null;
  notice: string | null;
};

const lutCache = new Map<string, CubeLut3D>();

export function useMonitorLut({
  enabled,
  path,
  name,
  language,
}: {
  enabled?: boolean;
  path?: string;
  name?: string;
  language: Language;
}): MonitorLutState {
  const [state, setState] = useState<MonitorLutState>({
    status: 'inactive',
    lut: null,
    notice: null,
  });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'inactive', lut: null, notice: null });
      return;
    }

    if (!path) {
      setState({
        status: 'error',
        lut: null,
        notice: language === 'zh' ? '请选择 .cube LUT' : 'Choose a .cube LUT',
      });
      return;
    }

    const cached = lutCache.get(path);
    if (cached) {
      setState({
        status: 'ready',
        lut: cached,
        notice: `LUT: ${name || cached.title || fileNameFromPath(path)}`,
      });
      return;
    }

    let cancelled = false;
    setState({
      status: 'loading',
      lut: null,
      notice: language === 'zh' ? '正在读取 LUT' : 'Loading LUT',
    });

    void readTextFile(path)
      .then(content => {
        if (cancelled) return;
        const lut = parseCubeLut(content, name || fileNameFromPath(path));
        lutCache.set(path, lut);
        setState({
          status: 'ready',
          lut,
          notice: `LUT: ${name || lut.title || fileNameFromPath(path)}`,
        });
      })
      .catch(error => {
        if (cancelled) return;
        setState({
          status: 'error',
          lut: null,
          notice: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, language, name, path]);

  return state;
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || 'LUT';
}
