import type { PlanMeter, PlanUsage } from '@harv/shared';
import { useChat } from '../../lib/chatStore.ts';
import { useSync } from '../../lib/useHarvSocket.ts';
import { ago, lineTime, pace, pct, PLAN_WINDOW_MS, resetTime, tokens, until } from '../../lib/format.ts';
import { BarList, Card, Rows } from './parts.tsx';

function MeterCard({ m }: { m: PlanMeter }) {
  const session = m.kind === 'session';
  const sub = session ? 'current 5-hour window' : m.kind === 'weekly_all' ? 'all models' : m.label.replace(/^Weekly · /, '');
  const rows: [string, string | undefined][] = session
    ? [
        ['Resets in', until(m.resetsAt)],
        ['Started', m.resetsAt ? lineTime(m.resetsAt - PLAN_WINDOW_MS.session) : undefined],
      ]
    : [
        ['Resets', resetTime(m.resetsAt)],
        ['Pace', pace(m)],
      ];
  return (
    <Card title={session ? 'Session' : 'Weekly'} sub={sub} value={pct(m.percent)} load={m.percent}>
      <Rows rows={rows} />
    </Card>
  );
}

/** Claude plan meters (from `/usage`) and Harv's own tracking, laid out like the mockup. */
export function PlanDetails({ usage }: { usage: PlanUsage | null }) {
  const { tabs, activeId } = useChat();
  const context = tabs.find((t) => t.id === activeId)?.context;
  const harv = usage?.harv;
  const byModel = new Map<string, number>();
  for (const r of harv?.split ?? []) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.turns);
  const total = [...byModel.values()].reduce((a, b) => a + b, 0);
  const harder = harv?.split.reduce((sum, r) => sum + r.harder, 0) ?? 0;
  const name = (model: string) => model.charAt(0).toUpperCase() + model.slice(1);

  return (
    <>
      <div className="mt-1 flex items-baseline justify-between border-t border-line px-1 pt-2.5 text-[11px] text-muted">
        <span className="tracking-[2px]">CLAUDE PLAN</span>
        {usage?.fetchedAt && (
          <span className="text-faint" title="Checked every 2 minutes while you chat, every 10 when idle, and after each reply">
            updated {ago(usage.fetchedAt)}
          </span>
        )}
      </div>

      {usage?.pausedUntil && (
        <div className="rounded-xl border border-warn/40 bg-black/20 p-3 text-xs leading-relaxed text-ink">
          Limit reached. Harv is paused until <span className="text-warn">{resetTime(usage.pausedUntil)}</span>
          {usage.queued > 0 && <>, with {usage.queued} queued</>}. Nothing paid is ever used.
        </div>
      )}
      {usage?.extraUsageOn && (
        <div className="rounded-xl border border-warn/40 bg-black/20 p-3 text-xs leading-relaxed text-muted">
          Extra usage is switched on for your Claude account, so a limit could start billing. Harv stops before that happens, but turning it
          off at claude.ai › Settings › Usage is safer.
        </div>
      )}

      {!usage || usage.meters.length === 0 ? (
        <Card title="Usage" sub="session · weekly">
          <p className="m-0 text-xs text-muted">Waiting for Claude to report usage…</p>
        </Card>
      ) : (
        usage.meters.map((m) => <MeterCard key={`${m.kind}-${m.label}`} m={m} />)
      )}

      {harv && (
        <Card title="Harv today" sub="tracked by Harv" value={`${harv.turnsToday} msgs`}>
          <Rows
            rows={[
              ['Tokens in', tokens(harv.inputTokensToday)],
              ['Tokens out', tokens(harv.outputTokensToday)],
              ['Open tabs', String(tabs.length)],
              ['Context', context ? `${tokens(context)} tokens` : undefined],
              ['Try harder', harder ? `${harder}× this week` : undefined],
            ]}
          />
          <BarList
            title="Routing · last 7 days"
            items={[...byModel].map(([model, turns]) => ({
              name: name(model),
              value: `${turns} · ${Math.round((turns / total) * 100)}%`,
              share: (turns / total) * 100,
            }))}
          />
        </Card>
      )}

      <SyncCard />
    </>
  );
}

/** Sync with the user's other devices (Settings › Sync), when it's on. */
function SyncCard() {
  const sync = useSync();
  if (!sync?.enabled) return null;
  const peers = sync.peers.map((p) => p.name).join(', ');
  const newest = Math.max(0, ...sync.peers.map((p) => p.lastChange ?? 0));
  const state = sync.busy ? 'syncing…' : sync.error ? 'problem' : sync.lastSync ? 'synced' : 'waiting';
  return (
    <Card title="Sync" sub={peers ? `with ${peers}` : 'no other device yet'} value={state}>
      <Rows
        rows={[
          ['Last sync', sync.lastSync ? ago(sync.lastSync) : undefined],
          ['To send', sync.pending ? `${sync.pending} changes` : undefined],
          ['Their last change', newest ? ago(newest) : undefined],
        ]}
      />
      {sync.error && <p className="m-0 text-[11px] leading-snug text-warn">{sync.error}</p>}
    </Card>
  );
}
