export const APP_VERSION = 'v0.1.6';
export type FrameCullEdition = 'FLASH' | 'PRO';
export const FRAMECULL_EDITION: FrameCullEdition = __FRAMECULL_EDITION__;
export const IS_PRO_EDITION = FRAMECULL_EDITION === 'PRO';
export const PRODUCT_DISPLAY_NAME = __FRAMECULL_PRODUCT_DISPLAY_NAME__;
export const PRODUCT_EDITION_NAME = __FRAMECULL_PRODUCT_EDITION_NAME__;
export const PRODUCT_STORAGE_PREFIX = IS_PRO_EDITION ? 'framecull-pro' : 'framecull-flash';
export const PRODUCT_SIGNATURE = 'Produce BY Ray_Frame \u00a92026';
export const PRODUCT_FOOTER = `${PRODUCT_DISPLAY_NAME} ${APP_VERSION} | ${PRODUCT_SIGNATURE}`;
