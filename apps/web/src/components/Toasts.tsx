import { useEffect, useState, type ReactNode } from 'react';
import type { UsageWarning, WatchdogAlert } from '@harv/shared';
import { chat } from '../lib/chatStore.ts';
import { resetTime } from '../lib/format.ts';
import { onServerMessage } from '../lib/socket.ts';
import { updateSettings, useSettings } from '../lib/useHarvSocket.ts';

/** Info fades after this; warnings stay until dismissed. */
const SHOW_MS = 30_000;
/** At most this many on screen; the oldest info goes first, then the oldest warning. */
const MAX_SHOWN = 4;

/** "Heads up: 90% of your Claude session (5-hour) limit is used. It resets at 18:40." */
export function warningText(w: UsageWarning): string {
  const what = w.kind === 'session' ? 'session (5-hour) limit' : 'weekly limit';
  const reset = w.resetsAt ? ` It resets ${w.kind === 'session' ? 'at' : 'on'} ${resetTime(w.resetsAt)}.` : '';
  return `Heads up: ${w.percent}% of your Claude ${what} is used.${reset}`;
}

/** Opens a chat that asks Harv about a warning (this one uses the plan, so only when the user asks). */
export function askHarvAbout(alert: WatchdogAlert) {
  chat.newTab();
  chat.send(`My PC watchdog just warned me: "${alert.title}". ${alert.detail} What is this, and should I do something about it?`);
}

type Toast =
  | { key: string; kind: 'usage'; warning: UsageWarning }
  | { key: string; kind: 'watchdog'; alert: WatchdogAlert }
  | { key: string; kind: 'project'; text: string };

/** Warnings stay until dismissed: a critical watchdog alert, or plan usage at 90% and up. */
const isWarning = (t: Toast) =>
  (t.kind === 'watchdog' && t.alert.severity === 'critical') || (t.kind === 'usage' && t.warning.percent >= 90);

/** Newest on top, the same toast replaced rather than repeated, at most MAX_SHOWN. */
export function addToast(list: Toast[], toast: Toast): Toast[] {
  const next = [toast, ...list.filter((t) => t.key !== toast.key)];
  while (next.length > MAX_SHOWN) {
    const oldInfo = next.findLastIndex((t) => !isWarning(t));
    next.splice(oldInfo === -1 ? next.length - 1 : oldInfo, 1);
  }
  return next;
}

/**
 * Every popup in one place and one look (the user's wish): plan-usage warnings, the PC
 * watchdog and project sync's notes, stacked top right below the tab bar so the chat's
 * context label stays visible.
 */
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (key: string) => setToasts((list) => list.filter((t) => t.key !== key));

  useEffect(
    () =>
      onServerMessage((msg) => {
        if (msg.type === 'usage.warning') {
          setToasts((list) => addToast(list, { key: `usage:${msg.warning.kind}`, kind: 'usage', warning: msg.warning }));
          chat.noticeInActive(warningText(msg.warning));
        } else if (msg.type === 'watchdog.alert') {
          setToasts((list) => addToast(list, { key: `watchdog:${msg.alert.id}`, kind: 'watchdog', alert: msg.alert }));
        } else if (msg.type === 'project.notice') {
          setToasts((list) => addToast(list, { key: `project:${msg.message}`, kind: 'project', text: msg.message }));
        } else if (msg.type === 'schedule.ran') {
          const text = `⏰ Running “${msg.task.title}”${msg.late ? ' (late: it was due while Harv was off)' : ''} in its chat.`;
          setToasts((list) => addToast(list, { key: `schedule:${msg.task.id}`, kind: 'project', text }));
        }
      }),
    [],
  );

  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-36 right-4 z-50 flex w-[min(400px,calc(100vw-32px))] flex-col gap-2">
      {toasts.map((t) => (
        <ToastView key={t.key} toast={t} onDismiss={() => dismiss(t.key)} />
      ))}
    </div>
  );
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  switch (toast.kind) {
    case 'usage':
      return <Card warn={isWarning(toast)} icon="◔" title={warningText(toast.warning)} onDismiss={onDismiss} />;
    case 'project':
      return <Card icon="⇅" title={toast.text} onDismiss={onDismiss} />;
    case 'watchdog':
      return <WatchdogCard alert={toast.alert} warn={isWarning(toast)} onDismiss={onDismiss} />;
  }
}

/** The one toast look: icon, title, optional detail and buttons, ×. Info fades by itself. */
function Card({
  warn = false,
  icon,
  title,
  detail,
  actions,
  onDismiss,
}: {
  warn?: boolean;
  icon: string;
  title: string;
  detail?: string;
  actions?: ReactNode;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (warn) return;
    const timer = window.setTimeout(onDismiss, SHOW_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per toast
  }, [warn]);

  return (
    <div
      role={warn ? 'alert' : 'status'}
      className={`animate-fade-in flex min-w-0 flex-col gap-2 rounded-xl border bg-[rgb(16_24_34/0.94)] px-4 py-3 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)] backdrop-blur-[22px] ${
        warn ? 'border-warn/60' : 'border-accent/40'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className={warn ? 'text-warn' : 'text-accent'}>
          {warn ? '!' : icon}
        </span>
        {/* Defender names files by long paths with no spaces: let them wrap anywhere. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
          <span className={warn ? 'text-warn' : 'text-ink'}>{title}</span>
          {detail && <span className="max-h-32 overflow-y-auto text-muted">{detail}</span>}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-my-1 size-6 flex-none cursor-pointer rounded text-muted hover:bg-white/10 hover:text-ink"
        >
          ×
        </button>
      </div>
      {actions && <div className="flex flex-wrap gap-2 pl-5">{actions}</div>}
    </div>
  );
}

function WatchdogCard({ alert, warn, onDismiss }: { alert: WatchdogAlert; warn: boolean; onDismiss: () => void }) {
  const { watchdogIgnored } = useSettings();
  const app = alert.app?.toLowerCase();
  return (
    <Card
      warn={warn}
      icon="◉"
      title={alert.title}
      detail={alert.detail}
      onDismiss={onDismiss}
      actions={
        <>
          <button
            type="button"
            onClick={() => {
              askHarvAbout(alert);
              onDismiss();
            }}
            className="cursor-pointer rounded-md border border-accent/50 px-2 py-1 text-accent hover:bg-accent/15"
          >
            Ask Harv
          </button>
          {app && (
            <button
              type="button"
              onClick={() => {
                updateSettings({ watchdogIgnored: [...watchdogIgnored, app] });
                onDismiss();
              }}
              className="cursor-pointer rounded-md border border-line px-2 py-1 text-muted hover:bg-white/10 hover:text-ink"
            >
              Don’t warn about {alert.app}
            </button>
          )}
        </>
      }
    />
  );
}
