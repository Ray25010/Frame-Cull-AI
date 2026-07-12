import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CubeLut3D } from '../types';
import type { Language } from '../i18n';
import { parseCubeLut } from '../utils/cubeLut';

export type MonitorLutState = {
  status: 'inactive' | 'loading' | 'ready' | 'error';
  lut: CubeLut3D | null;
  notice: string | null;
};

const lutCache = new Map<string, CubeLut3D>();

type ImportedMonitorLut = {
  path: string;
  name: string;
  content: string;
};

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

    const cacheKey = path;
    const cached = lutCache.get(cacheKey);
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

    const load = invoke<ImportedMonitorLut>('read_monitor_lut', { path }).then(result => ({
      content: result.content,
      name: name || result.name,
    }));

    void load
      .then(result => {
        if (cancelled) return;
        const lut = parseCubeLut(result.content, result.name || fileNameFromPath(path));
        lutCache.set(cacheKey, lut);
        setState({
          status: 'ready',
          lut,
          notice: `LUT: ${name || lut.title || result.name || fileNameFromPath(path)}`,
        });
      })
      .catch(error => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({
          status: 'error',
          lut: null,
          notice: /forbidden path/i.test(message)
            ? (language === 'zh' ? 'LUT 权限已失效，请重新导入 .cube' : 'LUT permission expired. Re-import the .cube file.')
            : message,
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
