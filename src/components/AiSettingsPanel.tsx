import React from 'react';
import { CopyCheck, Cpu, EyeOff, Focus, Moon, SunMedium, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AiIssueCode, AiSensitivity, AiSettings, DuplicateSensitivity } from '../types';
import { aiIssueLabel, aiSensitivityLabel, duplicateSensitivityLabel } from '../utils/aiLabels';
import { Language } from '../i18n';
import { AppIcon } from './ui/AppIcon';
import { chromeGlass, glassInteractive, glassSubtle, modalBackdrop } from './ui/chrome';
import { IS_PRO_EDITION } from '../utils/appInfo';

interface AiSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  language: Language;
  settings: AiSettings;
  onSettingsChange: (settings: AiSettings) => void;
}

const CHECKS: AiIssueCode[] = ['OUT_OF_FOCUS', 'UNDER_EXPOSED', 'OVER_EXPOSED', 'EYES_CLOSED'];
const SENSITIVITIES: AiSensitivity[] = ['weak', 'standard', 'strong'];
const DUPLICATE_SENSITIVITIES: DuplicateSensitivity[] = ['off', 'loose', 'standard', 'strict'];

const copy = {
  zh: {
    title: '\u672c\u5730 AI \u7b5b\u7247',
    subtitle: '\u5931\u7126 / \u66dd\u5149 / \u95ed\u773c',
    checks: '\u68c0\u6d4b\u9879',
    sensitivity: '\u654f\u611f\u5ea6',
    allSensitivity: '\u5168\u90e8\u540c\u6b65\u4e3a',
    itemSensitivity: '\u5355\u9879\u654f\u611f\u5ea6',
    aiPicks: 'AI\u7cbe\u9009',
    aiPickTarget: '\u7cbe\u9009\u4fdd\u7559\u6bd4\u4f8b',
    aiPickTargetHint: '\u91cd\u590d / \u8fde\u62cd\u5b50\u7ec4\u5148\u4fdd\u7559\u53ef\u7528\u4ee3\u8868\uff0c\u666e\u901a\u5355\u5f20\u518d\u6309\u6bd4\u4f8b\u8865\u8db3\u3002',
    proPersonaRanking: 'Pro persona 灰度排序',
    proPersonaRankingHint: '默认关闭。开启后仅 Pro 使用 student persona 分数参与 AI 精选排序，Flash 和旧规则不受影响。',
    duplicates: '重复照片',
    duplicateHint: '并入 AI 筛图流程，整批分析完成后生成重复组和奖杯推荐。',
    recommendBest: '每组推荐 1 张最佳',
    close: '\u5173\u95ed',
    enabled: '\u5f00',
    disabled: '\u5173',
    local: '\u672c\u5730\u6a21\u578b',
    footer: '\u4ec5\u6807\u8bb0\uff0c\u4e0d\u81ea\u52a8\u5220\u9664\u6216\u79fb\u52a8\u539f\u56fe',
  },
  en: {
    title: 'Local AI Culling',
    subtitle: 'Focus / Exposure / Eyes',
    checks: 'Checks',
    sensitivity: 'Sensitivity',
    allSensitivity: 'Set all to',
    itemSensitivity: 'Item sensitivity',
    aiPicks: 'AI Picks',
    aiPickTarget: 'Pick target',
    aiPickTargetHint: 'Duplicate and burst subgroups keep usable representatives first, then solo photos fill this target.',
    proPersonaRanking: 'Pro persona rollout ranking',
    proPersonaRankingHint: 'Off by default. Pro only; uses the student persona score in AI Pick ranking while Flash and default rules stay unchanged.',
    duplicates: 'Duplicates',
    duplicateHint: 'Runs inside AI culling, then creates duplicate groups and trophy recommendations.',
    recommendBest: 'Recommend one best per group',
    close: 'Close',
    enabled: 'On',
    disabled: 'Off',
    local: 'Local model',
    footer: 'Marks only. Original files are never deleted or moved automatically.',
  },
};

const AiSettingsPanel: React.FC<AiSettingsPanelProps> = ({
  isOpen,
  onClose,
  theme,
  language,
  settings,
  onSettingsChange,
}) => {
  if (!isOpen) return null;

  const text = copy[language];

  const updateEnabled = (code: AiIssueCode, enabled: boolean) => {
    onSettingsChange({
      ...settings,
      enabledChecks: {
        ...settings.enabledChecks,
        [code]: enabled,
      },
    });
  };

  const updateAllSensitivity = (sensitivity: AiSensitivity) => {
    onSettingsChange({
      ...settings,
      sensitivity,
      sensitivityByCheck: {
        OUT_OF_FOCUS: sensitivity,
        UNDER_EXPOSED: sensitivity,
        OVER_EXPOSED: sensitivity,
        EYES_CLOSED: sensitivity,
      },
    });
  };

  const updateCheckSensitivity = (code: AiIssueCode, sensitivity: AiSensitivity) => {
    onSettingsChange({
      ...settings,
      sensitivityByCheck: {
        ...settings.sensitivityByCheck,
        [code]: sensitivity,
      },
    });
  };

  const updateDuplicateSensitivity = (duplicateSensitivity: DuplicateSensitivity) => {
    onSettingsChange({
      ...settings,
      duplicateSensitivity,
    });
  };

  const updateDuplicateRecommendation = (duplicateAlwaysRecommendOne: boolean) => {
    onSettingsChange({
      ...settings,
      duplicateAlwaysRecommendOne,
    });
  };

  const updateAiPickTargetRatio = (value: number) => {
    onSettingsChange({
      ...settings,
      aiPickTargetRatio: Math.max(0.1, Math.min(0.7, value)),
    });
  };

  const updateProPersonaRanking = (enabled: boolean) => {
    onSettingsChange({
      ...settings,
      proPersonaRanking: {
        ...settings.proPersonaRanking,
        enabled,
      },
    });
  };

  return (
    <>
      <div className={`fixed inset-0 z-40 ${modalBackdrop}`} onClick={onClose} />
      <aside className={`fixed top-16 right-6 z-50 flex max-h-[calc(100vh-5rem)] w-[28rem] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-lg border ${
        theme === 'dark' ? chromeGlass.dark : chromeGlass.light
      }`}>
        <header className={`px-6 py-5 border-b flex items-start justify-between gap-4 ${
          theme === 'dark' ? 'border-white/[0.06] bg-white/[0.025]' : 'border-slate-400/24 bg-slate-100/[0.44]'
        }`}>
          <div className="min-w-0">
            <div className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-md text-[11px] font-medium ${
              theme === 'dark' ? 'bg-cyan-500/10 text-cyan-300' : 'bg-cyan-100/55 text-cyan-700'
            }`}>
              <AppIcon icon={Cpu} className="h-3.5 w-3.5" />
              {text.local}
            </div>
            <h3 className={`mt-3 text-[18px] font-semibold leading-tight ${theme === 'dark' ? 'text-white' : 'text-gray-950'}`}>
              {text.title}
            </h3>
            <p className={`mt-1 text-[13px] font-normal ${theme === 'dark' ? 'text-zinc-500' : 'text-gray-500'}`}>
              {text.subtitle}
            </p>
          </div>
          <button
            onClick={onClose}
            className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-lg transition-colors ${
              theme === 'dark' ? glassInteractive.dark : glassInteractive.light
            }`}
            title={text.close}
          >
            <AppIcon icon={X} className="h-4 w-4" />
          </button>
        </header>

        <div className="p-5 space-y-5 overflow-y-auto">
          <section>
            <div className="flex items-center justify-between mb-3">
              <h4 className={`text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-gray-600'}`}>
                {text.sensitivity}
              </h4>
              <span className={`text-[10px] font-semibold ${theme === 'dark' ? 'text-zinc-600' : 'text-gray-500'}`}>
                {text.allSensitivity}
              </span>
            </div>
            <div className={`grid grid-cols-3 gap-1 p-1 rounded-lg border ${
              theme === 'dark' ? glassSubtle.dark : 'bg-slate-100/[0.58] border-slate-400/24 shadow-[inset_0_1px_0_rgba(255,255,255,0.70)]'
            }`}>
              {SENSITIVITIES.map(value => (
                <button
                  key={value}
                  onClick={() => updateAllSensitivity(value)}
                  className={`h-10 rounded-md text-[13px] font-medium transition-all ${
                    settings.sensitivity === value
                      ? (theme === 'dark' ? 'bg-cyan-300 text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]' : 'bg-slate-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]')
                      : (theme === 'dark' ? 'text-zinc-500 hover:text-zinc-200 hover:bg-white/10' : 'text-slate-500 hover:text-slate-800 hover:bg-white/55')
                  }`}
                >
                  {aiSensitivityLabel(value, language)}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4 className={`mb-3 text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-400' : 'text-gray-600'}`}>
              {text.checks}
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {CHECKS.map(code => {
                const enabled = settings.enabledChecks[code];
                const itemSensitivity = settings.sensitivityByCheck[code];
                return (
                  <div
                    key={code}
                    className={`p-4 rounded-lg border transition-colors ${
                      enabled
                      ? (theme === 'dark' ? glassSubtle.dark : 'bg-slate-100/[0.62] border-slate-400/24')
                        : (theme === 'dark' ? 'bg-white/[0.02] border-white/[0.05] opacity-70' : 'bg-slate-100/[0.42] border-slate-400/20 opacity-75')
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                          enabled
                            ? (theme === 'dark' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-cyan-100/55 text-cyan-700')
                            : (theme === 'dark' ? 'bg-zinc-800 text-zinc-500' : 'bg-slate-200/80 text-slate-500')
                        }`}>
                          <AppIcon icon={iconForCheck(code)} className="h-4 w-4" />
                        </div>
                        <span className={`truncate text-[14px] font-semibold ${theme === 'dark' ? 'text-zinc-100' : 'text-gray-900'}`}>
                          {aiIssueLabel(code, language)}
                        </span>
                      </div>
                      <button
                        onClick={() => updateEnabled(code, !enabled)}
                        className={`w-12 h-7 rounded-full p-1 transition-colors ${
                          enabled ? 'bg-cyan-500' : (theme === 'dark' ? 'bg-zinc-700' : 'bg-slate-300')
                        }`}
                        title={enabled ? text.enabled : text.disabled}
                      >
                        <span className={`block w-5 h-5 bg-white rounded-full shadow transition-transform ${
                          enabled ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>
                    <div className={`mt-4 grid grid-cols-3 gap-1 p-1 rounded-md border ${
                      theme === 'dark' ? 'bg-black/[0.16] border-white/[0.05]' : 'bg-slate-100/[0.56] border-slate-400/24'
                    }`}>
                      {SENSITIVITIES.map(value => (
                        <button
                          key={value}
                          onClick={() => updateCheckSensitivity(code, value)}
                          className={`h-8 rounded text-[11px] font-medium transition-all ${
                            itemSensitivity === value
                              ? (theme === 'dark' ? 'bg-zinc-100 text-zinc-950' : 'bg-gray-950 text-white')
                              : (theme === 'dark' ? 'text-zinc-500 hover:text-zinc-200 hover:bg-white/10' : 'text-slate-500 hover:text-slate-800 hover:bg-white/55')
                          }`}
                          title={text.itemSensitivity}
                        >
                          {aiSensitivityLabel(value, language)}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-start gap-3">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                theme === 'dark' ? 'bg-cyan-500/12 text-cyan-200' : 'bg-cyan-100/65 text-cyan-700'
              }`}>
                <AppIcon icon={CopyCheck} className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h4 className={`text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {text.duplicates}
                </h4>
                <p className={`mt-1 text-[12px] leading-5 ${theme === 'dark' ? 'text-zinc-500' : 'text-gray-500'}`}>
                  {text.duplicateHint}
                </p>
              </div>
            </div>
            <div className={`grid grid-cols-4 gap-1 p-1 rounded-lg border ${
              theme === 'dark' ? glassSubtle.dark : 'bg-slate-100/[0.58] border-slate-400/24 shadow-[inset_0_1px_0_rgba(255,255,255,0.70)]'
            }`}>
              {DUPLICATE_SENSITIVITIES.map(value => (
                <button
                  key={value}
                  onClick={() => updateDuplicateSensitivity(value)}
                  className={`h-10 rounded-md text-[12px] font-medium transition-all ${
                    settings.duplicateSensitivity === value
                      ? (theme === 'dark' ? 'bg-cyan-300 text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]' : 'bg-slate-950 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]')
                      : (theme === 'dark' ? 'text-zinc-500 hover:text-zinc-200 hover:bg-white/10' : 'text-slate-500 hover:text-slate-800 hover:bg-white/55')
                  }`}
                >
                  {duplicateSensitivityLabel(value, language)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => updateDuplicateRecommendation(!settings.duplicateAlwaysRecommendOne)}
              className={`mt-3 flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors ${
                theme === 'dark' ? glassSubtle.dark : 'bg-slate-100/[0.62] border-slate-400/24 text-slate-800'
              }`}
            >
              <span className={`text-[13px] font-medium ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-800'}`}>
                {text.recommendBest}
              </span>
              <span className={`h-6 w-11 rounded-full p-1 transition-colors ${
                settings.duplicateAlwaysRecommendOne ? 'bg-cyan-500' : (theme === 'dark' ? 'bg-zinc-700' : 'bg-slate-300')
              }`}>
                <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  settings.duplicateAlwaysRecommendOne ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </span>
            </button>
          </section>

          <section>
            <div className="mb-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h4 className={`text-[12px] font-semibold ${theme === 'dark' ? 'text-zinc-300' : 'text-gray-700'}`}>
                  {text.aiPickTarget}
                </h4>
                <p className={`mt-1 text-[12px] leading-5 ${theme === 'dark' ? 'text-zinc-500' : 'text-gray-500'}`}>
                  {text.aiPickTargetHint}
                </p>
              </div>
              <span className={`shrink-0 rounded-md px-2 py-1 font-mono text-[13px] font-semibold tabular-nums ${
                theme === 'dark'
                  ? 'bg-cyan-400/12 text-cyan-200 ring-1 ring-cyan-200/16'
                  : 'bg-cyan-100/70 text-cyan-800 ring-1 ring-cyan-300/30'
              }`}>
                {Math.round(settings.aiPickTargetRatio * 100)}%
              </span>
            </div>
            <div className={`rounded-lg border px-3 py-3 ${
              theme === 'dark' ? glassSubtle.dark : 'bg-slate-100/[0.62] border-slate-400/24'
            }`}>
              <input
                type="range"
                min={10}
                max={70}
                step={5}
                value={Math.round(settings.aiPickTargetRatio * 100)}
                onChange={event => updateAiPickTargetRatio(Number(event.currentTarget.value) / 100)}
                className={`h-1.5 w-full cursor-pointer appearance-none rounded-full accent-cyan-400 ${
                  theme === 'dark' ? 'bg-white/10' : 'bg-slate-300/80'
                }`}
                style={{
                  background: `linear-gradient(90deg, ${
                    theme === 'dark' ? 'rgba(34,211,238,0.88)' : 'rgba(8,145,178,0.82)'
                  } 0%, ${
                    theme === 'dark' ? 'rgba(34,211,238,0.88)' : 'rgba(8,145,178,0.82)'
                  } ${((settings.aiPickTargetRatio - 0.1) / 0.6) * 100}%, ${
                    theme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(148,163,184,0.45)'
                  } ${((settings.aiPickTargetRatio - 0.1) / 0.6) * 100}%, ${
                    theme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(148,163,184,0.45)'
                  } 100%)`,
                }}
                aria-label={text.aiPickTarget}
              />
              <div className={`mt-2 flex items-center justify-between text-[10px] font-semibold tabular-nums ${
                theme === 'dark' ? 'text-zinc-600' : 'text-slate-500'
              }`}>
                <span>10%</span>
                <span>38%</span>
                <span>70%</span>
              </div>
            </div>
            {IS_PRO_EDITION && (
              <button
                type="button"
                onClick={() => updateProPersonaRanking(!settings.proPersonaRanking.enabled)}
                className={`mt-3 flex w-full items-center justify-between gap-4 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  theme === 'dark' ? glassSubtle.dark : 'bg-slate-100/[0.62] border-slate-400/24 text-slate-800'
                }`}
              >
                <span className="min-w-0">
                  <span className={`block text-[13px] font-semibold ${theme === 'dark' ? 'text-zinc-200' : 'text-slate-800'}`}>
                    {text.proPersonaRanking}
                  </span>
                  <span className={`mt-0.5 block text-[11px] leading-4 ${theme === 'dark' ? 'text-zinc-500' : 'text-slate-500'}`}>
                    {text.proPersonaRankingHint}
                  </span>
                </span>
                <span className={`h-6 w-11 shrink-0 rounded-full p-1 transition-colors ${
                  settings.proPersonaRanking.enabled ? 'bg-cyan-500' : (theme === 'dark' ? 'bg-zinc-700' : 'bg-slate-300')
                }`}>
                  <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    settings.proPersonaRanking.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </span>
              </button>
            )}
          </section>
        </div>

        <footer className={`px-6 py-4 border-t text-xs font-semibold ${
          theme === 'dark' ? 'border-white/[0.06] text-zinc-500 bg-white/[0.025]' : 'border-slate-400/24 text-slate-500 bg-slate-100/[0.44]'
        }`}>
          {text.footer}
        </footer>
      </aside>
    </>
  );
};

function iconForCheck(code: AiIssueCode): LucideIcon {
  if (code === 'OUT_OF_FOCUS') return Focus;
  if (code === 'UNDER_EXPOSED') return Moon;
  if (code === 'OVER_EXPOSED') return SunMedium;
  return EyeOff;
}

export default AiSettingsPanel;
