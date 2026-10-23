import type { PlanMeter, PlanUsage } from '@harv/shared';
import { useChat } from '../../lib/chatStore.ts';
import { lineTime, pace, pct, PLAN_WINDOW_MS, resetTime, tokens, until } from '../../lib/format.ts';
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
      <div className="mt-1 border-t border-line px-1 pt-2.5 text-[11px] tracking-[2px] text-muted">CLAUDE PLAN</div>

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
    </>
  );
}
