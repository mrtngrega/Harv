import type { PlanUsage } from '@harv/shared';
import { pct, resetTime, tokens } from '../../lib/format.ts';
import { Bar, barColor, Card } from './parts.tsx';

const ago = (at: number) => {
  const min = Math.round((Date.now() - at) / 60_000);
  return min < 1 ? 'just now' : `${min} min ago`;
};

/** Claude plan meters (from `/usage`) and Harv's own tracking. */
export function PlanDetails({ usage }: { usage: PlanUsage | null }) {
  const harv = usage?.harv;
  const total = harv?.split.reduce((sum, r) => sum + r.turns, 0) ?? 0;

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

      <Card title="Usage" sub={usage?.fetchedAt ? `from /usage · ${ago(usage.fetchedAt)}` : 'session · weekly'}>
        {!usage || usage.meters.length === 0 ? (
          <p className="m-0 text-xs text-muted">Waiting for Claude to report usage…</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-xs">
            {usage.meters.map((m) => (
              <li key={`${m.kind}-${m.label}`} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  <span className="text-[11px] text-faint">resets {resetTime(m.resetsAt)}</span>
                  <span className="w-10 text-right font-semibold tabular-nums" style={{ color: barColor(m.percent) }}>
                    {pct(m.percent)}
                  </span>
                </div>
                <Bar value={m.percent} height={4} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {harv && (
        <Card title="Harv" sub="its own tracking" value={`${harv.turnsToday} today`}>
          <p className="m-0 text-xs text-muted">
            {tokens(harv.inputTokensToday)} in · {tokens(harv.outputTokensToday)} out today
          </p>
          {total > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs" aria-label="Routing split, last 7 days">
              {harv.split.map((r) => (
                <li key={`${r.model}-${r.effort}`} className="flex flex-col gap-1">
                  <div className="flex gap-2">
                    <span className="flex-1">
                      {r.model}·{r.effort}
                    </span>
                    {r.harder > 0 && <span className="text-[11px] text-faint">{r.harder}× harder</span>}
                    <span className="w-14 text-right tabular-nums">{r.turns} turns</span>
                  </div>
                  <Bar value={(r.turns / total) * 100} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
