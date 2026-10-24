import { useEffect, useState } from 'react';
import type { WatchdogAlert } from '@harv/shared';
import { chat } from '../lib/chatStore.ts';
import { onServerMessage } from '../lib/socket.ts';
import { updateSettings, useSettings } from '../lib/useHarvSocket.ts';

/** Ordinary warnings fade after this; critical ones stay until dismissed. */
const WARN_SHOW_MS = 30_000;

/** Opens a chat that asks Harv about a warning (this one uses the plan, so only when the user asks). */
export function askHarvAbout(alert: WatchdogAlert) {
  chat.newTab();
  chat.send(`My PC watchdog just warned me: "${alert.title}". ${alert.detail} What is this, and should I do something about it?`);
}

/** The PC watchdog's warnings, top right (plan-usage warnings sit in the middle). */
export function WatchdogToast() {
  const [alert, setAlert] = useState<WatchdogAlert | null>(null);
  const { watchdogIgnored } = useSettings();

  useEffect(() => onServerMessage((msg) => msg.type === 'watchdog.alert' && setAlert(msg.alert)), []);

  useEffect(() => {
    if (!alert || alert.severity === 'critical') return;
    const timer = window.setTimeout(() => setAlert(null), WARN_SHOW_MS);
    return () => clearTimeout(timer);
  }, [alert]);

  if (!alert) return null;
  const critical = alert.severity === 'critical';
  const app = alert.app?.toLowerCase();
  return (
    <div
      role={critical ? 'alert' : 'status'}
      className={`animate-fade-in fixed top-20 right-4 z-50 flex w-[min(400px,calc(100vw-32px))] flex-col gap-2 rounded-xl border bg-[rgb(16_24_34/0.94)] px-4 py-3 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)] backdrop-blur-[22px] ${
        critical ? 'border-warn/60' : 'border-accent/40'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className={critical ? 'text-warn' : 'text-accent'}>
          {critical ? '!' : '◉'}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={critical ? 'text-warn' : 'text-ink'}>{alert.title}</span>
          <span className="text-muted">{alert.detail}</span>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setAlert(null)}
          className="-my-1 size-6 flex-none cursor-pointer rounded text-muted hover:bg-white/10 hover:text-ink"
        >
          ×
        </button>
      </div>
      <div className="flex flex-wrap gap-2 pl-5">
        <button
          type="button"
          onClick={() => {
            askHarvAbout(alert);
            setAlert(null);
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
              setAlert(null);
            }}
            className="cursor-pointer rounded-md border border-line px-2 py-1 text-muted hover:bg-white/10 hover:text-ink"
          >
            Don’t warn about {alert.app}
          </button>
        )}
      </div>
    </div>
  );
}
