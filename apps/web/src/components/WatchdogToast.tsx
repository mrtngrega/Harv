import { useEffect, useState } from 'react';
import type { WatchdogAlert } from '@harv/shared';
import { chat } from '../lib/chatStore.ts';
import { onServerMessage } from '../lib/socket.ts';
import { updateSettings, useSettings } from '../lib/useHarvSocket.ts';

/** Ordinary warnings fade after this; critical ones stay until dismissed. */
const WARN_SHOW_MS = 30_000;
/** At most this many on screen; the oldest ordinary warning goes first. */
const MAX_SHOWN = 3;

/** Opens a chat that asks Harv about a warning (this one uses the plan, so only when the user asks). */
export function askHarvAbout(alert: WatchdogAlert) {
  chat.newTab();
  chat.send(`My PC watchdog just warned me: "${alert.title}". ${alert.detail} What is this, and should I do something about it?`);
}

/** The PC watchdog's warnings, top right (plan-usage warnings sit in the middle), newest on top. */
export function WatchdogToast() {
  const [alerts, setAlerts] = useState<WatchdogAlert[]>([]);
  const dismiss = (id: string) => setAlerts((list) => list.filter((a) => a.id !== id));

  useEffect(
    () =>
      onServerMessage((msg) => {
        if (msg.type !== 'watchdog.alert') return;
        setAlerts((list) => {
          const next = [msg.alert, ...list.filter((a) => a.id !== msg.alert.id)];
          while (next.length > MAX_SHOWN) {
            const oldWarning = next.findLastIndex((a) => a.severity !== 'critical');
            next.splice(oldWarning === -1 ? next.length - 1 : oldWarning, 1);
          }
          return next;
        });
      }),
    [],
  );

  if (alerts.length === 0) return null;
  return (
    <div className="fixed top-20 right-4 z-50 flex w-[min(400px,calc(100vw-32px))] flex-col gap-2">
      {alerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} onDismiss={() => dismiss(alert.id)} />
      ))}
    </div>
  );
}

function AlertCard({ alert, onDismiss }: { alert: WatchdogAlert; onDismiss: () => void }) {
  const { watchdogIgnored } = useSettings();
  const critical = alert.severity === 'critical';
  const app = alert.app?.toLowerCase();

  useEffect(() => {
    if (critical) return;
    const timer = window.setTimeout(onDismiss, WARN_SHOW_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per alert
  }, [alert.id, critical]);

  return (
    <div
      role={critical ? 'alert' : 'status'}
      className={`animate-fade-in flex min-w-0 flex-col gap-2 rounded-xl border bg-[rgb(16_24_34/0.94)] px-4 py-3 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)] backdrop-blur-[22px] ${
        critical ? 'border-warn/60' : 'border-accent/40'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className={critical ? 'text-warn' : 'text-accent'}>
          {critical ? '!' : '◉'}
        </span>
        {/* Defender names files by long paths with no spaces: let them wrap anywhere. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
          <span className={critical ? 'text-warn' : 'text-ink'}>{alert.title}</span>
          <span className="max-h-32 overflow-y-auto text-muted">{alert.detail}</span>
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
      <div className="flex flex-wrap gap-2 pl-5">
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
      </div>
    </div>
  );
}
