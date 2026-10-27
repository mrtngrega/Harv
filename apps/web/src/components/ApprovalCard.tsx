import { useState } from 'react';
import type { ActionEntry, ApprovalRequest, QuestionItem, Tier } from '@harv/shared';
import { safety } from '../lib/safetyStore.ts';
import { RichText } from './chat/RichText.tsx';

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

const BUTTON = 'min-h-10 cursor-pointer rounded-[10px] px-4 text-xs';
const PRIMARY = `${BUTTON} bg-accent font-semibold text-[#0f1620] disabled:cursor-default disabled:opacity-40`;
const SECONDARY = `${BUTTON} border border-[rgb(220_232_245/0.25)] bg-white/5 hover:bg-white/10`;

/** What waits for the user: a red action, Claude's questions, or a plan to approve. */
export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  if (approval.kind === 'question') return <QuestionCard approval={approval} />;
  if (approval.kind === 'plan') return <PlanCard approval={approval} />;
  return <ActionCard approval={approval} />;
}

/** One question: its options (one pick, or several), and Other for an answer of the user's own. */
function QuestionBlock({
  q,
  picked,
  other,
  onPick,
  onOther,
}: {
  q: QuestionItem;
  picked: string[];
  other: string;
  onPick: (label: string) => void;
  onOther: (text: string) => void;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const preview = q.options.find((o) => o.label === (focus ?? picked[0]))?.preview;
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 flex items-baseline gap-2">
        {q.header && (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] tracking-[1px] text-accent uppercase">{q.header}</span>
        )}
        <span className="text-ink">{q.question}</span>
        {q.multiSelect && <span className="text-[11px] text-faint">(pick any)</span>}
      </legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {q.options.map((o) => {
          const on = picked.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              onClick={() => onPick(o.label)}
              onMouseEnter={() => setFocus(o.label)}
              onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus(o.label)}
              onBlur={() => setFocus(null)}
              className={`flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left ${
                on ? 'border-accent/70 bg-accent/15' : 'border-line bg-black/20 hover:bg-white/5'
              }`}
            >
              <span className="text-xs text-ink">
                <span aria-hidden="true" className="mr-1.5 text-accent">
                  {q.multiSelect ? (on ? '☑' : '☐') : on ? '◉' : '○'}
                </span>
                {o.label}
              </span>
              {o.description && <span className="text-[11px] text-muted">{o.description}</span>}
            </button>
          );
        })}
      </div>
      {preview && (
        <pre className="m-0 max-h-48 overflow-auto rounded-lg border border-line bg-black/30 p-2 text-[11px] whitespace-pre-wrap text-muted">
          {preview}
        </pre>
      )}
      <input
        value={other}
        onChange={(e) => onOther(e.target.value)}
        placeholder="Other: write your own answer"
        className="rounded-lg border border-line bg-black/30 px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
      />
    </fieldset>
  );
}

/** Claude's multiple-choice questions (AskUserQuestion): the answers go straight back to it. */
function QuestionCard({ approval }: { approval: ApprovalRequest }) {
  const questions = approval.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answerOf = (q: QuestionItem) => other[q.question]?.trim() || (picked[q.question] ?? []).join(', ');
  const ready = questions.every((q) => answerOf(q));
  const pick = (q: QuestionItem, label: string) =>
    setPicked((p) => {
      const now = p[q.question] ?? [];
      const next = q.multiSelect ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label];
      return { ...p, [q.question]: next };
    });
  return (
    <section
      aria-label="Harv asks you"
      className="animate-fade-in flex flex-col gap-3 rounded-xl border border-accent/50 bg-accent/[0.06] p-3.5"
    >
      <span className="text-xs font-semibold tracking-[2px] text-accent">HARV ASKS</span>
      {questions.map((q) => (
        <QuestionBlock
          key={q.question}
          q={q}
          picked={picked[q.question] ?? []}
          other={other[q.question] ?? ''}
          onPick={(label) => {
            pick(q, label);
            if (!q.multiSelect) setOther((o) => ({ ...o, [q.question]: '' }));
          }}
          onOther={(text) => setOther((o) => ({ ...o, [q.question]: text }))}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() =>
            safety.answer(approval.id, true, undefined, { answers: Object.fromEntries(questions.map((q) => [q.question, answerOf(q)])) })
          }
          className={PRIMARY}
        >
          ANSWER
        </button>
        <button
          type="button"
          onClick={() => safety.answer(approval.id, false)}
          title="Harv goes on without your answers"
          className={SECONDARY}
        >
          SKIP
        </button>
      </div>
    </section>
  );
}

/** A plan Claude made in plan mode: approve it and Harv starts, or say what to change. */
function PlanCard({ approval }: { approval: ApprovalRequest }) {
  const [changes, setChanges] = useState('');
  return (
    <section
      aria-label="Harv's plan"
      className="animate-fade-in flex flex-col gap-2.5 rounded-xl border border-accent/50 bg-accent/[0.06] p-3.5"
    >
      <span className="text-xs font-semibold tracking-[2px] text-accent">PLAN READY</span>
      <div className="harv-md max-h-[50vh] overflow-auto rounded-lg border border-line bg-black/25 px-3 py-2">
        {approval.plan ? <RichText text={approval.plan} /> : <p className="text-muted">The plan is in Harv’s reply above.</p>}
      </div>
      <textarea
        value={changes}
        onChange={(e) => setChanges(e.target.value)}
        rows={2}
        placeholder="Changes you want (optional)"
        className="resize-y rounded-lg border border-line bg-black/30 p-2 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => safety.answer(approval.id, true)} disabled={!!changes.trim()} className={PRIMARY}>
          APPROVE PLAN
        </button>
        <button
          type="button"
          onClick={() => safety.answer(approval.id, false, undefined, { why: changes })}
          disabled={!changes.trim()}
          className={`${SECONDARY} disabled:cursor-default disabled:opacity-40`}
        >
          SEND CHANGES
        </button>
        <button type="button" onClick={() => safety.answer(approval.id, false)} className={SECONDARY}>
          KEEP PLANNING
        </button>
      </div>
    </section>
  );
}

/** A red action waiting for the user: exact preview, editable command, Approve / Deny. */
function ActionCard({ approval }: { approval: ApprovalRequest }) {
  const [command, setCommand] = useState(approval.command ?? '');
  const edited = approval.command !== undefined && command !== approval.command;

  return (
    <section
      aria-label="Harv needs your approval"
      className="animate-fade-in flex flex-col gap-2.5 rounded-xl border border-warn/60 bg-[rgb(242_184_128/0.08)] p-3.5"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold tracking-[2px] text-warn">{approval.sending ? 'SEND THIS?' : 'APPROVAL NEEDED'}</span>
        <span className="text-xs text-muted">
          {approval.sending ? 'Harv wants to send something you didn’t ask it to send.' : approval.reason}
        </span>
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
        <button
          type="button"
          onClick={() => safety.answer(approval.id, true, approval.command !== undefined ? command : undefined, { all: true })}
          title="Approve this and everything else Harv asks until this reply ends (each is still backed up and logged, with Undo). Blocked things stay blocked."
          className="min-h-10 cursor-pointer rounded-[10px] border border-warn/60 bg-warn/10 px-4 text-xs text-warn hover:bg-warn/20"
        >
          APPROVE ALL FOR THIS REPLY
        </button>
        {approval.rules && !edited && (
          <button
            type="button"
            onClick={() => safety.answer(approval.id, true, approval.command, { always: true })}
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
