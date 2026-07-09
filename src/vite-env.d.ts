/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRAMECULL_PRO_MODEL_MANIFEST?: string;
}

declare const __FRAMECULL_EDITION__: 'FLASH' | 'PRO';
declare const __FRAMECULL_PRODUCT_DISPLAY_NAME__: string;
declare const __FRAMECULL_PRODUCT_EDITION_NAME__: 'Flash' | 'Pro';

declare module 'libraw-wasm' {
  export default any;
}
