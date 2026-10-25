import type { BackgroundTask } from '@harv/shared';
import { useEffect, useState } from 'react';
import { chat, type Tab } from '../lib/chatStore.ts';
import { formatElapsed } from './StatusLine.tsx';

const GLYPH: Record<BackgroundTask['status'], string> = { running: '⟳', completed: '✓', failed: '✗', stopped: '■' };
const COLOR: Record<BackgroundTask['status'], string> = {
  running: 'text-accent',
  completed: 'text-ok',
  failed: 'text-warn',
  stopped: 'text-faint',
};

/** "general-purpose", "shell", "monitor": what kind of worker it is. */
function kindOf(task: BackgroundTask): string {
  if (task.kind === 'local_agent') return task.agent ?? 'agent';
  if (task.kind === 'local_bash') return 'shell';
  return task.kind.replace(/^local_/, '').replace(/_/g, ' ');
}

/**
 * The chat's background agents and shells, just above the status line:
 * "⟳ general-purpose · Find the radio API · 2m 05s · Grep ■". Ended ones stay a few
 * minutes with their outcome, and can be dismissed.
 */
export function TaskStrip({ tab }: { tab: Tab | undefined }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const tasks = (tab?.tasks ?? []).filter((t) => !hidden.has(t.id));
  const running = tasks.some((t) => t.status === 'running');

  useEffect(() => {
    if (!running) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [running]);

  if (!tab || tasks.length === 0) return null;
  return (
    <ul aria-label="Background tasks" className="max-h-24 overflow-y-auto border-t border-line px-5 pt-1.5 text-xs">
      {tasks.map((t) => {
        const took = formatElapsed((t.endedAt ?? now) - t.startedAt);
        const detail =
          t.status === 'running'
            ? [took, t.lastTool, t.summary]
            : [`${t.status === 'completed' ? 'done' : t.status} after ${took}`, t.summary];
        return (
          <li key={t.id} className="flex h-6 min-w-0 items-center gap-2 whitespace-nowrap" title={t.summary || t.description}>
            <span aria-hidden="true" className={`w-3 flex-none text-center ${COLOR[t.status]}`}>
              {GLYPH[t.status]}
            </span>
            <span className={`flex-none ${t.status === 'running' ? 'text-muted' : 'text-faint'}`}>{kindOf(t)}</span>
            <span className="min-w-0 truncate text-ink">{t.description}</span>
            <span className="min-w-0 flex-1 truncate text-faint">{detail.filter(Boolean).join(' · ')}</span>
            {t.status === 'running' ? (
              <button
                type="button"
                onClick={() => chat.stopTask(tab.id, t.id)}
                aria-label={`Stop ${t.description}`}
                className="flex-none cursor-pointer rounded px-1.5 text-faint hover:bg-white/10 hover:text-warn"
              >
                stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setHidden((h) => new Set(h).add(t.id))}
                aria-label={`Dismiss ${t.description}`}
                className="flex-none cursor-pointer rounded px-1.5 text-faint hover:bg-white/10 hover:text-ink"
              >
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
