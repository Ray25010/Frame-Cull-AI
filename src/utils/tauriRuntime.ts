type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    metadata?: {
      currentWindow?: {
        label?: string;
      };
    };
  };
  __TAURI_OS_PLUGIN_INTERNALS__?: {
    platform?: string;
  };
};

export function hasTauriRuntime() {
  if (typeof window === 'undefined') return false;
  const tauriWindow = window as TauriWindow;
  return Boolean(tauriWindow.__TAURI_INTERNALS__?.metadata?.currentWindow?.label);
}

export function hasTauriOsPlugin() {
  if (typeof window === 'undefined') return false;
  const tauriWindow = window as TauriWindow;
  return Boolean(tauriWindow.__TAURI_OS_PLUGIN_INTERNALS__?.platform);
}
