import { useEffect, useState } from 'react';
import type { UsageWarning } from '@harv/shared';
import { chat } from '../lib/chatStore.ts';
import { resetTime } from '../lib/format.ts';
import { onServerMessage } from '../lib/socket.ts';

/** "Heads up: 90% of your Claude Pro session is used. It resets at 18:40." */
export function warningText(w: UsageWarning): string {
  const what = w.kind === 'session' ? 'session (5-hour) limit' : 'weekly limit';
  const reset = w.resetsAt ? ` It resets ${w.kind === 'session' ? 'at' : 'on'} ${resetTime(w.resetsAt)}.` : '';
  return `Heads up: ${w.percent}% of your Claude ${what} is used.${reset}`;
}

/** Shows plan-usage warnings as a toast (and a note in the active chat). */
export function UsageToast() {
  const [warning, setWarning] = useState<UsageWarning | null>(null);

  useEffect(
    () =>
      onServerMessage((msg) => {
        if (msg.type !== 'usage.warning') return;
        setWarning(msg.warning);
        chat.noticeInActive(warningText(msg.warning));
      }),
    [],
  );

  useEffect(() => {
    if (!warning) return;
    const timer = window.setTimeout(() => setWarning(null), 15_000);
    return () => clearTimeout(timer);
  }, [warning]);

  if (!warning) return null;
  const urgent = warning.percent >= 90;
  return (
    <div
      role="status"
      className={`animate-fade-in fixed top-20 left-1/2 z-50 flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-start gap-3 rounded-xl border bg-[rgb(16_24_34/0.94)] px-4 py-3 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)] backdrop-blur-[22px] ${
        urgent ? 'border-warn/60 text-warn' : 'border-accent/40 text-ink'
      }`}
    >
      <span aria-hidden="true">{urgent ? '!' : '◔'}</span>
      <span className="flex-1">{warningText(warning)}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setWarning(null)}
        className="-my-1 size-6 flex-none cursor-pointer rounded text-muted hover:bg-white/10 hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
