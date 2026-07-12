import type { Language } from '../i18n';
import type { ResolvedTheme } from '../hooks/useTheme';

export interface RawEngineNoticeProps {
  theme: ResolvedTheme;
  language: Language;
}

export const RawEngineNotice = (_props: RawEngineNoticeProps) => null;
