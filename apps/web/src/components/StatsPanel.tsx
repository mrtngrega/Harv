import { useState } from 'react';
import type { MetricsSnapshot, PlanUsage } from '@harv/shared';
import { pct, rate } from '../lib/format.ts';
import { useMetrics, useUsage } from '../lib/useHarvSocket.ts';
import { Bar, barColor } from './stats/parts.tsx';
import { PlanDetails } from './stats/PlanDetails.tsx';
import { StatsDetails } from './stats/StatsDetails.tsx';

interface CompactItem {
  label: string;
  value: string;
  load: number | undefined;
}

function compactItems(m: MetricsSnapshot | null): CompactItem[] {
  const system = m ? (m.volumes.find((v) => v.mount.toUpperCase().startsWith('C')) ?? m.volumes[0]) : undefined;
  return [
    { label: 'CPU', value: pct(m?.cpu.load), load: m?.cpu.load },
    { label: 'GPU', value: pct(m?.gpu?.load), load: m?.gpu?.load },
    { label: 'RAM', value: pct(m?.memory.load), load: m?.memory.load },
    { label: system ? `DISK ${system.mount}` : 'DISK', value: pct(system?.load), load: system?.load },
    { label: 'NET', value: m?.network ? rate(m.network.downBps) : '—', load: m?.network?.utilization },
  ];
}

function planItems(u: PlanUsage | null): CompactItem[] {
  const meter = (kind: string) => u?.meters.find((m) => m.kind === kind)?.percent;
  const session = meter('session');
  const weekly = meter('weekly_all');
  return [
    { label: 'SESSION', value: pct(session), load: session },
    { label: 'WEEKLY', value: pct(weekly), load: weekly },
  ];
}

function CompactRow({ item }: { item: CompactItem }) {
  return (
    <div className="flex flex-col gap-1.5 px-2">
      <div className="flex justify-between gap-1 text-[11px]">
        <span className="truncate text-muted">{item.label}</span>
        <span className="tabular-nums" style={{ color: item.load === undefined ? 'var(--color-faint)' : barColor(item.load) }}>
          {item.value}
        </span>
      </div>
      <Bar value={item.load} />
    </div>
  );
}

export function StatsPanel() {
  const [wide, setWide] = useState(false);
  const metrics = useMetrics();
  const usage = useUsage();

  if (!wide) {
    return (
      <aside aria-label="System and plan" className="glass flex w-full flex-col gap-3 rounded-2xl px-2 py-2.5 sm:w-[150px] sm:flex-none">
        <button
          type="button"
          onClick={() => setWide(true)}
          aria-label="Expand system panel"
          className="flex min-h-8 cursor-pointer items-center justify-between rounded-lg px-2 text-[11px] tracking-[2px] text-muted hover:bg-white/5"
        >
          <span>LIVE</span>
          <span className="text-[15px] text-ink">‹</span>
        </button>
        {compactItems(metrics).map((item) => (
          <CompactRow key={item.label} item={item} />
        ))}
        <div className="mx-2 border-t border-line" />
        {planItems(usage).map((item) => (
          <CompactRow key={item.label} item={item} />
        ))}
      </aside>
    );
  }

  return (
    <aside
      aria-label="System and plan, expanded"
      className="glass animate-fade-in flex max-h-[calc(100vh-110px)] max-w-[470px] flex-[1_1_420px] flex-col gap-2.5 overflow-y-auto rounded-2xl p-3"
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] tracking-[2px] text-muted">SYSTEM · LIVE · 1s</span>
        <button
          type="button"
          onClick={() => setWide(false)}
          aria-label="Collapse system panel"
          className="size-8 cursor-pointer rounded-lg text-[15px] hover:bg-white/5"
        >
          ›
        </button>
      </div>
      {metrics ? <StatsDetails m={metrics} /> : <p className="m-0 p-2 text-xs text-muted">Waiting for sensors…</p>}
      <PlanDetails usage={usage} />
    </aside>
  );
}
