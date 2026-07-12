import type { Language } from '../i18n';
import type { AboutPanelContent } from '../types/aboutPanelContent';

export function extendAboutPanelContent(
  base: AboutPanelContent,
  _language: Language,
  _productDisplayName: string,
): AboutPanelContent {
  return base;
}
