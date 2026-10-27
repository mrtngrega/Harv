import type { ReactNode } from 'react';
import { WARN_AT } from '../../lib/format.ts';

export const barColor = (value: number | undefined) => ((value ?? 0) >= WARN_AT ? 'var(--color-warn)' : 'var(--color-accent)');

/**
 * A bar that slides to each new value. It scales (a transform the compositor animates by itself)
 * instead of changing its width: a width animation repaints every frame, and under the frosted
 * glass that kept the laptop's GPU at ~50% while Harv sat idle (2026-10-27). On a battery even that
 * cost ~30% of a core (WebKitGTK composites the whole window per frame), so there it jumps (`.battery`).
 */
export function Bar({ value, height = 3, color }: { value: number | undefined; height?: number; color?: string }) {
  const share = Math.max(0, Math.min(100, value ?? 0)) / 100;
  return (
    <div className="overflow-hidden rounded-full bg-white/10" style={{ height }}>
      <div
        className="h-full origin-left rounded-full bar-slide will-change-transform"
        style={{ transform: `scaleX(${share})`, background: color ?? barColor(value) }}
      />
    </div>
  );
}

export function Card({
  title,
  sub,
  value,
  load,
  children,
}: {
  title: string;
  sub?: string;
  value?: string;
  load?: number;
  children?: ReactNode;
}) {
  return (
    <section className="animate-fade-in @container flex flex-col gap-2 rounded-xl bg-black/20 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
        <span className="flex-1 truncate text-[11px] text-muted">{sub}</span>
        {value !== undefined && (
          <span className="font-semibold tabular-nums" style={{ color: barColor(load) }}>
            {value}
          </span>
        )}
      </div>
      {load !== undefined && <Bar value={load} height={4} />}
      {children}
    </section>
  );
}

/** Two-column key/value grid; rows whose value is undefined are skipped. */
export function Rows({ rows }: { rows: [string, string | undefined][] }) {
  const shown = rows.filter((r): r is [string, string] => r[1] !== undefined && r[1] !== '—');
  if (shown.length === 0) return null;
  return (
    // Fixed equal columns and one line per row, so a value getting longer never moves or wraps the others.
    <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-xs @[23rem]:grid-cols-[repeat(2,minmax(0,1fr))]">
      {shown.map(([k, v]) => (
        <div key={k} className="flex min-w-0 justify-between gap-2">
          <dt className="flex-none whitespace-nowrap text-muted">{k}</dt>
          <dd className="m-0 min-w-0 truncate text-right whitespace-nowrap tabular-nums" title={v}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ThreadBars({ loads }: { loads: number[] }) {
  return (
    <div role="img" aria-label="Load per CPU thread" className="flex h-[30px] items-end gap-0.5">
      {loads.map((load, i) => (
        <div
          key={i}
          className="h-full flex-1 origin-bottom rounded-[2px] bar-slide will-change-transform"
          style={{ transform: `scaleY(${Math.max(4, load) / 100})`, background: barColor(load), opacity: 0.85 }}
        />
      ))}
    </div>
  );
}

/** A small titled list with a bar per item (top processes, volumes). */
export function BarList({ title, items }: { title: string; items: { name: string; value: string; share: number }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="text-[11px] text-muted">{title}</div>
      {items.map((it) => (
        <div key={it.name} className="flex items-center gap-2">
          <span className="w-28 flex-none truncate">{it.name}</span>
          <div className="flex-1">
            <Bar value={it.share} color="var(--color-accent)" />
          </div>
          <span className="w-24 flex-none text-right whitespace-nowrap tabular-nums">{it.value}</span>
        </div>
      ))}
    </div>
  );
}
