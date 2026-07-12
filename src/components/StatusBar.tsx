import React from 'react';
import { Language } from '../i18n';

interface StatusBarProps {
  theme: 'light' | 'dark';
  t: any;
  language: Language;
  stats: {
    total: number;
    picked: number;
    rejected: number;
    orphans: number;
    aiReview: number;
    aiNormal: number;
  };
}

const labels = {
  zh: {
    aiReview: 'AI\u5f85\u590d\u67e5',
    aiNormal: 'AI\u6b63\u5e38',
  },
  en: {
    aiReview: 'AI REVIEW',
    aiNormal: 'AI CLEAR',
  },
};

export const StatusBar: React.FC<StatusBarProps> = ({ theme, t, language, stats }) => {
  const text = labels[language];

  return (
    <footer className={`h-10 border-t px-6 flex items-center justify-between text-[10px] z-20 backdrop-blur-xl ${theme === 'dark' ? 'bg-zinc-950/90 border-white/10 text-zinc-500' : 'bg-white/90 border-black/10 text-gray-500'}`}>
      <div className="flex min-w-0 gap-4 overflow-x-auto whitespace-nowrap [scrollbar-width:thin]">
        <span>{stats.total} {t.footer.total}</span>
        <span className="text-emerald-500 font-bold">{stats.picked} {t.footer.picked}</span>
        <span className="text-rose-500 font-bold">{stats.rejected} {t.footer.stagedForTrash}</span>
        <span className="text-amber-500 font-bold">{stats.orphans} {t.footer.orphans}</span>
        <span className="text-amber-400 font-bold">{stats.aiReview} {text.aiReview}</span>
        <span className="text-emerald-400 font-bold">{stats.aiNormal} {text.aiNormal}</span>
      </div>
    </footer>
  );
};
