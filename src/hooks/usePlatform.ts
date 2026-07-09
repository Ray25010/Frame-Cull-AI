import { useState, useEffect } from 'react';
import { hasTauriOsPlugin } from '../utils/tauriRuntime';

export function usePlatform() {
  const [currentPlatform, setCurrentPlatform] = useState<string>('');
  const [isMacOS, setIsMacOS] = useState(false);
  const [isWindows, setIsWindows] = useState(false);
  const [isLinux, setIsLinux] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const useBrowserPlatform = () => {
      const browserPlatform = navigator.platform.toLowerCase();
      if (cancelled) return;
      setIsMacOS(browserPlatform.includes('mac'));
      setIsWindows(browserPlatform.includes('win'));
      setIsLinux(browserPlatform.includes('linux'));
      setCurrentPlatform(browserPlatform);
    };

    const detectPlatform = async () => {
      if (!hasTauriOsPlugin()) {
        useBrowserPlatform();
        return;
      }

      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        const p = platform();
        if (cancelled) return;
        setCurrentPlatform(p);
        setIsMacOS(p === 'macos');
        setIsWindows(p === 'windows');
        setIsLinux(p === 'linux');
      } catch {
        useBrowserPlatform();
      }
    };

    void detectPlatform();

    return () => {
      cancelled = true;
    };
  }, []);

  return { platform: currentPlatform, isMacOS, isWindows, isLinux };
}
