import { useEffect, useState } from 'react';
import type { Tab } from '../lib/chatStore.ts';
import { resetTime, tokens } from '../lib/format.ts';
import { useSafety } from '../lib/safetyStore.ts';
import { useConnection, useSettings, useUsage } from '../lib/useHarvSocket.ts';

/** Claude Code's spinner glyphs. */
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

const COLOR = {
  ok: 'var(--color-ok)',
  accent: 'var(--color-accent)',
  warn: 'var(--color-warn)',
  faint: 'var(--color-faint)',
};

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Harv's status for this chat, just above the command line, like Claude Code's:
 * "✻ thinking… (12s · ↓ 340 tokens · esc to stop)". Offline and plan pauses show here too.
 */
export function StatusLine({ tab }: { tab: Tab | undefined }) {
  const conn = useConnection();
  const usage = useUsage();
  const { motion } = useSettings();
  const waiting = useSafety().approvals.some((a) => a.tabId === tab?.id);
  const busy = Boolean(tab?.busy);
  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);

  // The clock ticks while a turn runs; the spinner turns only with motion on.
  useEffect(() => {
    if (!busy) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const spin = motion ? window.setInterval(() => setFrame((f) => f + 1), 120) : undefined;
    return () => {
      clearInterval(clock);
      clearInterval(spin);
    };
  }, [busy, motion]);

  let glyph = '●';
  let color = COLOR.ok;
  let label: string;
  let extra = '';
  if (!conn.connected) {
    color = COLOR.faint;
    label = 'offline · reconnecting…';
  } else if (conn.status === 'paused') {
    color = COLOR.warn;
    label = usage?.pausedUntil ? `paused · Claude Pro limit until ${resetTime(usage.pausedUntil)}` : 'paused · Claude Pro limit';
  } else if (busy && tab) {
    glyph = motion ? SPIN[frame % SPIN.length]! : '✻';
    color = waiting ? COLOR.warn : tab.activity ? COLOR.warn : COLOR.accent;
    label = waiting ? 'needs you · approve or deny above' : tab.activity ? `working · ${tab.activity}` : 'thinking…';
    const parts = [tab.startedAt ? formatElapsed(now - tab.startedAt) : '', tab.outTokens ? `↓ ${tokens(tab.outTokens)} tokens` : ''];
    extra = `(${[...parts.filter(Boolean), 'esc to stop'].join(' · ')})`;
  } else {
    label = 'idle';
    if (tab?.lastTurn) extra = `last reply ${formatElapsed(tab.lastTurn.ms)} · ↓ ${tokens(tab.lastTurn.tokens)} tokens`;
  }

  return (
    <div
      role="status"
      aria-label={`Harv is ${label}`}
      className="flex h-7 min-w-0 items-center gap-2 border-t border-line px-5 pt-1.5 text-xs whitespace-nowrap"
    >
      <span aria-hidden="true" className="w-3 flex-none text-center" style={{ color }}>
        {glyph}
      </span>
      <span className="truncate" style={{ color: busy || color !== COLOR.ok ? color : undefined }}>
        {label}
      </span>
      {extra && <span className="truncate text-faint">{extra}</span>}
    </div>
  );
}
