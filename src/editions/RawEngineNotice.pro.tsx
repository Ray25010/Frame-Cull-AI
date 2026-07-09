import type { Language } from '../i18n';
import type { ResolvedTheme } from '../hooks/useTheme';

export interface RawEngineNoticeProps {
  theme: ResolvedTheme;
  language: Language;
}

export const RawEngineNotice = ({ theme, language }: RawEngineNoticeProps) => (
  <div className={`mt-4 rounded-lg border p-4 ${
    theme === 'dark'
      ? 'border-white/[0.05] bg-white/[0.035]'
      : 'border-slate-400/24 bg-white/54 shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]'
  }`}>
    <div className={`text-sm font-bold ${theme === 'dark' ? 'text-zinc-100' : 'text-slate-950'}`}>
      {language === 'zh' ? '第三方 RAW 引擎' : 'Third-party RAW engine'}
    </div>
    <p className={`mt-1 text-xs leading-5 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
      {language === 'zh'
        ? 'FrameCull AI Pro 内置 RawTherapee 5.12 Windows x64 CLI，用于生成本地 RAW 监看缓存。RawTherapee 遵循 GPLv3，许可证、来源链接和构建信息随 Pro 安装包提供。'
        : 'FrameCull AI Pro bundles RawTherapee 5.12 Windows x64 CLI for local RAW monitor cache generation. RawTherapee is licensed under GPLv3; license, source, and build notices are included with the Pro package.'}
    </p>
    <div className={`mt-2 font-mono text-[10.5px] leading-5 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
      https://github.com/RawTherapee/RawTherapee/releases/tag/5.12
    </div>
  </div>
);
