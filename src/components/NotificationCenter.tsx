import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { AppIcon } from './ui/AppIcon';
import { glassPopover } from './ui/chrome';
import { getNotificationEnterDelay } from './ui/reactBitsPilot';

export type NotificationKind = 'success' | 'info' | 'warning' | 'error';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  message?: string;
  detail?: string;
  createdAt: number;
  autoDismissMs?: number;
}

interface NotificationCenterProps {
  theme: 'light' | 'dark';
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
}

const tone = {
  success: {
    icon: CheckCircle2,
    dark: 'text-emerald-200 drop-shadow-[0_0_8px_rgba(110,231,183,0.35)]',
    light: 'text-emerald-700 drop-shadow-[0_0_6px_rgba(5,150,105,0.18)]',
    accent: 'from-emerald-300/0 via-emerald-300/45 to-emerald-300/0',
  },
  info: {
    icon: Info,
    dark: 'text-sky-200 drop-shadow-[0_0_8px_rgba(125,211,252,0.38)]',
    light: 'text-sky-700 drop-shadow-[0_0_6px_rgba(2,132,199,0.18)]',
    accent: 'from-sky-300/0 via-sky-300/45 to-sky-300/0',
  },
  warning: {
    icon: AlertTriangle,
    dark: 'text-amber-200 drop-shadow-[0_0_8px_rgba(251,191,36,0.34)]',
    light: 'text-amber-700 drop-shadow-[0_0_6px_rgba(217,119,6,0.18)]',
    accent: 'from-amber-300/0 via-amber-300/50 to-amber-300/0',
  },
  error: {
    icon: AlertTriangle,
    dark: 'text-rose-200 drop-shadow-[0_0_8px_rgba(251,113,133,0.34)]',
    light: 'text-rose-700 drop-shadow-[0_0_6px_rgba(225,29,72,0.18)]',
    accent: 'from-rose-300/0 via-rose-300/50 to-rose-300/0',
  },
} as const;

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  theme,
  notifications,
  onDismiss,
}) => {
  const isDark = theme === 'dark';
  if (notifications.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-3 top-[58px] z-[130] flex w-[min(330px,calc(100vw-24px))] flex-col gap-2">
      {notifications.map((notification, index) => {
        const itemTone = tone[notification.kind];
        const message = getNotificationMessage(notification);
        const hasDetail = Boolean(notification.detail);
        const usesChinese = prefersChinese(notification);
        return (
          <section
            key={notification.id}
            className={`fc-notification-enter pointer-events-auto relative overflow-hidden rounded-[14px] border px-3 py-2.5 ${
              isDark ? glassPopover.dark : glassPopover.light
            }`}
            style={{ animationDelay: getNotificationEnterDelay(index) }}
            role={notification.kind === 'error' || notification.kind === 'warning' ? 'alert' : 'status'}
          >
            <div className={`absolute left-3 right-3 top-0 h-px bg-gradient-to-r ${itemTone.accent}`} />
            <div className="flex min-w-0 items-start gap-2.5">
              <span className={`mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center ${
                isDark ? itemTone.dark : itemTone.light
              }`}>
                <AppIcon icon={itemTone.icon} className="h-4 w-4" />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start gap-2">
                  <div className={`min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 ${isDark ? 'text-zinc-50' : 'text-slate-950'}`}>
                    {notification.title}
                  </div>
                  <button
                    type="button"
                    onClick={() => onDismiss(notification.id)}
                    className={`-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                      isDark ? 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100' : 'text-slate-500 hover:bg-white/60 hover:text-slate-900'
                    }`}
                    aria-label="Dismiss notification"
                  >
                    <AppIcon icon={X} className="h-3.5 w-3.5" />
                  </button>
                </div>

                {message && (
                  <div className={`mt-0.5 text-[12px] leading-5 ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                    {message}
                  </div>
                )}

                {hasDetail && (
                  <details className="group mt-1.5">
                    <summary className={`inline-flex cursor-pointer select-none items-center rounded-md text-[11px] font-medium leading-4 transition-colors marker:content-[''] [&::-webkit-details-marker]:hidden ${
                      isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-slate-500 hover:text-slate-700'
                    }`}>
                      {usesChinese ? '技术细节' : 'Technical details'}
                    </summary>
                    <div className={`mt-1.5 max-h-20 overflow-auto rounded-lg px-2 py-1.5 font-mono text-[10.5px] leading-4 ${
                      isDark ? 'bg-black/18 text-zinc-500' : 'bg-white/56 text-slate-500'
                    }`}>
                      {notification.detail}
                    </div>
                  </details>
                )}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
};

function prefersChinese(notification: AppNotification) {
  return /[\u3400-\u9fff]/.test(`${notification.title} ${notification.message || ''}`);
}

function getNotificationMessage(notification: AppNotification) {
  if (notification.message) return notification.message;
  if (!notification.detail || notification.kind !== 'error') return undefined;

  const usesChinese = prefersChinese(notification);
  if (/reading ['"]invoke['"]|cannot read properties of undefined/i.test(notification.detail)) {
    return usesChinese
      ? '浏览器预览不能打开系统文件选择器，请在桌面应用中导入。'
      : 'The browser preview cannot open the desktop file picker. Use the desktop app to import.';
  }

  return usesChinese
    ? '操作没有完成，可以展开查看技术细节。'
    : 'The action did not complete. Expand for technical details.';
}
