import { useState } from 'react';

// Live values arrive in M1 (hardware) and M7 (Claude plan); until then rows show placeholders.
const ROWS = ['CPU', 'GPU', 'RAM', 'DISK', 'NET'];
const PLAN_ROWS = ['SESSION', 'WEEKLY'];

function CompactRow({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-1.5 px-2">
      <div className="flex justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="text-faint">—</span>
      </div>
      <div className="h-[3px] rounded-full bg-white/10" />
    </div>
  );
}

export function StatsPanel() {
  const [wide, setWide] = useState(false);

  if (!wide) {
    return (
      <aside aria-label="System and plan" className="glass flex w-[150px] flex-none flex-col gap-3 rounded-2xl px-2 py-2.5">
        <button
          type="button"
          onClick={() => setWide(true)}
          aria-label="Expand system panel"
          className="flex min-h-8 cursor-pointer items-center justify-between rounded-lg px-2 text-[11px] tracking-[2px] text-muted hover:bg-white/5"
        >
          <span>LIVE</span>
          <span className="text-[15px] text-ink">‹</span>
        </button>
        {ROWS.map((r) => (
          <CompactRow key={r} label={r} />
        ))}
        <div className="mx-2 border-t border-line" />
        {PLAN_ROWS.map((r) => (
          <CompactRow key={r} label={r} />
        ))}
      </aside>
    );
  }

  return (
    <aside
      aria-label="System and plan, expanded"
      className="glass animate-fade-in flex max-w-[470px] flex-[1_1_420px] flex-col gap-2.5 rounded-2xl p-3"
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] tracking-[2px] text-muted">SYSTEM · LIVE</span>
        <button
          type="button"
          onClick={() => setWide(false)}
          aria-label="Collapse system panel"
          className="size-8 cursor-pointer rounded-lg text-[15px] hover:bg-white/5"
        >
          ›
        </button>
      </div>
      <p className="rounded-xl bg-black/20 p-3 text-xs leading-relaxed text-muted">
        Full hardware details (per-core load, temperatures, fans, clocks, power, top processes) arrive in M1. Claude plan usage arrives in
        M7.
      </p>
    </aside>
  );
}
