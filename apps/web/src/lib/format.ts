const GB = 1024 ** 3;

export const pct = (n: number | undefined) => (n === undefined ? '—' : `${Math.round(n)}%`);

export const celsius = (n: number | undefined) => (n === undefined ? '—' : `${Math.round(n)}°C`);

export const watts = (n: number | undefined) => (n === undefined ? '—' : `${Math.round(n)} W`);

export const ghz = (mhz: number | undefined) => (mhz === undefined ? '—' : `${(mhz / 1000).toFixed(2)} GHz`);

export const gb = (bytes: number | undefined, digits = 1) => (bytes === undefined ? '—' : `${(bytes / GB).toFixed(digits)} GB`);

/** Compact size for drives: 412 GB, 1.8 TB. */
export function size(bytes: number): string {
  const tb = bytes / 1024 ** 4;
  return tb >= 1 ? `${tb.toFixed(1)} TB` : `${Math.round(bytes / GB)} GB`;
}

/** "752 / 931 GB" or "1.2 / 1.8 TB": both sides in the total's unit. */
export function sizePair(used: number, total: number): string {
  return total >= 1024 ** 4
    ? `${(used / 1024 ** 4).toFixed(1)} / ${(total / 1024 ** 4).toFixed(1)} TB`
    : `${Math.round(used / GB)} / ${Math.round(total / GB)} GB`;
}

/** Collapses repeats: ["A", "A", "B"] → ["2× A", "B"]. */
export function countDuplicates(items: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].map(([item, n]) => (n > 1 ? `${n}× ${item}` : item));
}

/** Throughput: 0 B/s, 17 KB/s, 1.6 MB/s. */
export function rate(bps: number | undefined): string {
  if (bps === undefined) return '—';
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

export function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

/** Bars turn amber from this load or temperature share. */
export const WARN_AT = 85;

/** When a plan meter resets: "23:40" today, "Mon 08:00" later in the week. */
export function resetTime(at: number | null, now = Date.now()): string {
  if (at === null) return '—';
  const d = new Date(at);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (at - now < 20 * 60 * 60 * 1000 && d.getDate() === new Date(now).getDate()) return hm;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

/** Token counts: 820, 12.4k, 1.3M. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
