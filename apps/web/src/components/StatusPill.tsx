import type { HarvConnection } from '../lib/useHarvSocket.ts';

const LOOK = {
  idle: { label: 'idle', color: 'var(--color-ok)' },
  thinking: { label: 'thinking…', color: 'var(--color-accent)' },
  working: { label: 'working', color: 'var(--color-warn)' },
  offline: { label: 'offline', color: 'var(--color-faint)' },
} as const;

export function StatusPill({ conn }: { conn: HarvConnection }) {
  const look = conn.connected ? LOOK[conn.status] : LOOK.offline;

  return (
    <div
      role="status"
      aria-label={`Harv is ${look.label}`}
      className="flex min-h-9 items-center gap-2.5 rounded-full border border-line bg-white/5 py-0 pr-3 pl-2 text-xs"
    >
      <span
        className={`inline-block size-3.5 rounded-full ${conn.connected ? 'animate-pulse-ring' : ''}`}
        style={{ background: look.color }}
      />
      <span>{look.label}</span>
    </div>
  );
}
