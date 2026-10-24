import { useState } from 'react';
import type { ActionEntry, ApprovalRequest, Tier } from '@harv/shared';
import { safety } from '../lib/safetyStore.ts';

export const TIER_COLOR: Record<Tier, string> = {
  green: 'var(--color-ok)',
  yellow: '#e8d58a',
  red: 'var(--color-warn)',
  blocked: '#f08a8a',
};

const STATUS_LABEL: Record<ActionEntry['status'], string> = {
  pending: 'waiting for you',
  running: 'running',
  done: 'done',
  failed: 'failed',
  denied: 'denied',
  blocked: 'blocked',
  undone: 'undone',
};

/** A red action waiting for the user: exact preview, editable command, Approve / Deny. */
export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const [command, setCommand] = useState(approval.command ?? '');
  const edited = approval.command !== undefined && command !== approval.command;

  return (
    <section
      aria-label="Harv needs your approval"
      className="animate-fade-in flex flex-col gap-2.5 rounded-xl border border-warn/60 bg-[rgb(242_184_128/0.08)] p-3.5"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold tracking-[2px] text-warn">APPROVAL NEEDED</span>
        <span className="text-xs text-muted">{approval.reason}</span>
      </div>
      <div className="text-ink">{approval.summary}</div>

      {approval.command !== undefined ? (
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Exact command (you can edit it before approving)
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={Math.min(8, Math.max(2, command.split('\n').length))}
            spellCheck={false}
            className="resize-y rounded-lg border border-line bg-black/30 p-2 text-xs text-ink outline-none focus:border-accent/60"
          />
        </label>
      ) : null}

      <pre className="m-0 max-h-56 overflow-auto rounded-lg border border-line bg-black/30 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
        {approval.preview}
      </pre>

      <div className="text-[11px] text-muted">
        {approval.backups.length > 0 && <div>Backed up first: {approval.backups.join(', ')}</div>}
        {approval.backupNote && <div className="text-warn">{approval.backupNote}</div>}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => safety.answer(approval.id, true, approval.command !== undefined ? command : undefined)}
          className="min-h-10 cursor-pointer rounded-[10px] bg-warn px-4 text-xs font-semibold text-[#0f1620]"
        >
          {edited ? 'APPROVE EDITED' : 'APPROVE'}
        </button>
        {approval.rules && !edited && (
          <button
            type="button"
            onClick={() => safety.answer(approval.id, true, approval.command, true)}
            title={`Approve, and from now on run ${approval.rules.map((r) => `"${r}"`).join(' and ')} commands without asking (backed up first, with Undo). Settings › Safety lists these rules.`}
            className="min-h-10 cursor-pointer rounded-[10px] border border-warn/60 bg-warn/10 px-4 text-xs text-warn hover:bg-warn/20"
          >
            APPROVE · DON’T ASK AGAIN FOR {approval.rules.map((r) => r.toUpperCase()).join(' + ')}
          </button>
        )}
        <button
          type="button"
          onClick={() => safety.answer(approval.id, false)}
          className="min-h-10 cursor-pointer rounded-[10px] border border-[rgb(220_232_245/0.25)] bg-white/5 px-4 text-xs hover:bg-white/10"
        >
          DENY
        </button>
      </div>
    </section>
  );
}

/** Tier dot, status and Undo for a tool line or a log row. */
export function ActionBadge({ action }: { action: ActionEntry }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: TIER_COLOR[action.tier] }} />
      <span
        className="text-[11px]"
        style={{ color: action.status === 'failed' || action.status === 'blocked' ? TIER_COLOR.blocked : undefined }}
      >
        {action.tier} · {STATUS_LABEL[action.status]}
      </span>
      {action.canUndo && (
        <button
          type="button"
          onClick={() => safety.undo(action.id)}
          title={`Restore ${action.backups.join(', ')}`}
          className="cursor-pointer rounded-md border border-line px-1.5 py-0.5 text-[11px] text-accent hover:bg-white/10"
        >
          undo
        </button>
      )}
    </span>
  );
}
