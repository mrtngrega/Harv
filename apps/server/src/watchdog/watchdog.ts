import { randomUUID } from 'node:crypto';
import type { MetricsSnapshot, WatchdogAlert, WatchdogKind } from '@harv/shared';

// The PC watchdog (docs/PLAN.md §6j): overheating, background programs hogging the
// CPU or GPU for a long time, and dangerous software. The user's wish: useful, never
// annoying. So every check needs a condition that lasts, each alert has a long
// cooldown, ordinary warnings come at most one per WARN_GAP_MS, Windows' own
// maintenance and Harv itself are never reported, and any program can be ignored.

const MIN = 60 * 1000;

/** How long a temperature must stay high before a warning. */
export const HEAT_MS = 2 * MIN;
/** How long a background program must hog the CPU or GPU. */
export const HOG_MS = 5 * MIN;
/** How long a program from a Temp folder must keep using CPU. */
export const SUSPICIOUS_MS = 3 * MIN;
/** Short dips below a threshold don't reset the clock. */
const GRACE_MS = 45 * 1000;
/** Ordinary warnings: at most one per this (critical ones always show). */
export const WARN_GAP_MS = 10 * MIN;

/** Thresholds for the user's PC (Ryzen 7 5700X3D throttles near 90 °C, RTX 3060 Ti targets 83 °C). */
export const HEAT = [
  { key: 'cpu', label: 'CPU', warn: 85, critical: 92, why: 'it slows itself down near 90 °C' },
  { key: 'gpu', label: 'GPU', warn: 83, critical: 90, why: 'it slows itself down above 83 °C' },
  { key: 'hotspot', label: 'GPU hotspot', warn: 100, critical: 108, why: 'the hottest spot on the GPU chip' },
  { key: 'drive', label: 'Drive', warn: 65, critical: 75, why: 'drives wear faster above 65 °C' },
] as const;
const HEAT_COOLDOWN_MS = 30 * MIN;
/** A temperature counts as back to normal this far below its warning mark. */
const HEAT_RESET_C = 5;

/** Share of the whole CPU (all threads) that counts as hogging: about 3 of the 16 threads. */
export const CPU_HOG_PCT = 20;
/** GPU use (pmon "sm" %) by one program that counts as hogging. */
export const GPU_HOG_PCT = 40;
const HOG_COOLDOWN_MS = 2 * 60 * MIN;
const SECURITY_COOLDOWN_MS = 6 * 60 * MIN;

/** Never reported: Windows' own background work, drivers, Harv and its sensors. */
const BUILT_IN_IGNORED = new Set(
  [
    'system idle process',
    'idle',
    'system',
    'registry',
    'memory compression',
    'msmpeng.exe',
    'mpdefendercoreservice.exe',
    'nissrv.exe',
    'tiworker.exe',
    'trustedinstaller.exe',
    'searchindexer.exe',
    'searchprotocolhost.exe',
    'searchfilterhost.exe',
    'compattelrunner.exe',
    'mousocoreworker.exe',
    'wmiprvse.exe',
    'svchost.exe',
    'dwm.exe',
    'csrss.exe',
    'audiodg.exe',
    'explorer.exe',
    'node.exe',
    'librehardwaremonitor.exe',
    'nvidia-smi.exe',
    'claude.exe',
  ].map((n) => n.toLowerCase()),
);

/** Crypto miners and remote-access tools that are almost never wanted. */
const KNOWN_BAD =
  /^(xmrig|xmr-stak|nbminer|t-rex|lolminer|phoenixminer|nicehash\w*|ethminer|gminer|teamredminer|cpuminer|minerd|ccminer|bminer|nanominer|srbminer\w*|njrat|darkcomet|quasar|asyncrat|remcos|nanocore|netwire)(\.exe)?$/i;
/** Folders real programs rarely run from; malware often does. */
const ODD_FOLDER = /\\(appdata\\local\\temp|windows\\temp|users\\public|\$recycle\.bin)\\/i;

export interface ProcessSample {
  pid: number;
  name: string;
  /** Share of the whole CPU, 0–100. */
  cpu: number;
  path?: string | null;
}

export interface DefenderReport {
  realTime: boolean;
  /** Detections Windows Defender has on record, newest or not. */
  detections: { id: string; at: number; name?: string; resource?: string; removed: boolean }[];
}

export interface WatchdogHooks {
  emit: (alert: WatchdogAlert) => void;
  /** The user's settings: on/off and ignored programs (read on every check). */
  settings: () => { watchdog: boolean; watchdogIgnored: string[] };
  /** Lowercase exe names of programs with a visible window (in use, like a game): not "background". */
  windowed: () => Promise<Set<string>>;
  /** When the last Defender detection was already known (survives restarts, so old ones never alert). */
  defenderSeen: { get: () => number | undefined; set: (at: number) => void };
  now?: () => number;
}

/** A condition that has to last: when it started, and when it was last true. */
interface Streak {
  since: number;
  last: number;
  value: number;
}

export class Watchdog {
  private streaks = new Map<string, Streak>();
  private cooldown = new Map<string, number>();
  /** Temperatures that already warned, until they drop back. */
  private hot = new Set<string>();
  private lastWarnAt = 0;

  constructor(private hooks: WatchdogHooks) {}

  private now() {
    return this.hooks.now?.() ?? Date.now();
  }

  private on() {
    return this.hooks.settings().watchdog;
  }

  private ignored(name: string) {
    const n = name.toLowerCase();
    return BUILT_IN_IGNORED.has(n) || this.hooks.settings().watchdogIgnored.includes(n);
  }

  /** Records that a condition holds now; returns how long it has held (short dips forgiven). */
  private hold(key: string, value: number): number {
    const now = this.now();
    const s = this.streaks.get(key);
    if (!s || now - s.last > GRACE_MS) {
      this.streaks.set(key, { since: now, last: now, value });
      return 0;
    }
    s.last = now;
    s.value = Math.max(s.value, value);
    return now - s.since;
  }

  private release(key: string) {
    const s = this.streaks.get(key);
    if (s && this.now() - s.last > GRACE_MS) this.streaks.delete(key);
  }

  /** Sends an alert unless it's cooling down, or it's an ordinary one too soon after the last. Returns whether it went out. */
  private alert(
    key: string,
    cooldownMs: number,
    a: { kind: WatchdogKind; severity: 'warn' | 'critical'; title: string; detail: string; app?: string },
  ): boolean {
    const now = this.now();
    if ((this.cooldown.get(key) ?? 0) > now) return false;
    if (a.severity === 'warn' && now - this.lastWarnAt < WARN_GAP_MS) return false;
    if (a.severity === 'warn') this.lastWarnAt = now;
    this.cooldown.set(key, now + cooldownMs);
    const alert: WatchdogAlert = { id: randomUUID(), at: now, ...a };
    this.hooks.emit(alert);
    return true;
  }

  // ── Heat ──

  onMetrics(m: MetricsSnapshot): void {
    if (!this.on()) return;
    const readings: { key: string; label: string; temp?: number }[] = [
      { key: 'cpu', label: 'CPU', temp: m.cpu.tempC },
      { key: 'gpu', label: 'GPU', temp: m.gpu?.tempC },
      { key: 'hotspot', label: 'GPU hotspot', temp: m.gpu?.hotspotC },
      ...m.drives.map((d) => ({ key: `drive:${d.name}`, label: d.name, temp: d.tempC })),
    ];
    for (const r of readings) {
      if (r.temp === undefined) continue;
      const limits = HEAT.find((h) => h.key === r.key.split(':')[0])!;
      const key = `heat:${r.key}`;
      if (r.temp < limits.warn - HEAT_RESET_C) this.hot.delete(key);
      if (r.temp < limits.warn) {
        this.release(key);
        continue;
      }
      const held = this.hold(key, r.temp);
      const critical = r.temp >= limits.critical;
      // Very hot warns after a short check (a sensor blip isn't a fire); hot has to last.
      if (this.hot.has(key) || held < (critical ? 20_000 : HEAT_MS)) continue;
      const minutes = Math.max(1, Math.round(held / MIN));
      const sent = this.alert(key, HEAT_COOLDOWN_MS, {
        kind: 'heat',
        severity: critical ? 'critical' : 'warn',
        title: `${r.label} is running hot`,
        detail: `${Math.round(r.temp)} °C for ${critical && held < MIN ? 'a while' : `over ${minutes} minute${minutes === 1 ? '' : 's'}`} (${limits.why}). Check the fans, the airflow, or what's running.`,
      });
      if (sent) this.hot.add(key);
    }
  }

  // ── Background hogs and odd programs ──

  /** The process list (every ~5 s): CPU hogs, known miners and remote-access tools, programs running from Temp. */
  async onProcesses(list: ProcessSample[]): Promise<void> {
    if (!this.on()) return;
    const byName = new Map<string, { cpu: number; path?: string | null }>();
    for (const p of list) {
      const g = byName.get(p.name) ?? { cpu: 0, path: p.path };
      g.cpu += p.cpu;
      g.path ??= p.path;
      byName.set(p.name, g);
    }
    const hogs: { name: string; held: number; cpu: number }[] = [];
    for (const [name, { cpu, path }] of byName) {
      if (this.ignored(name)) continue;
      if (KNOWN_BAD.test(name)) {
        this.alert(`bad:${name.toLowerCase()}`, SECURITY_COOLDOWN_MS, {
          kind: 'suspicious',
          severity: 'critical',
          title: `${name} is running`,
          detail: `That name belongs to a crypto miner or a remote-control tool, which is almost never something you want.${path ? ` It runs from ${path}.` : ''} If you didn't install it, run a Windows Security scan.`,
          app: name,
        });
        continue;
      }
      const key = `cpu:${name.toLowerCase()}`;
      const oddKey = `odd:${name.toLowerCase()}`;
      if (cpu < CPU_HOG_PCT) this.release(key);
      else hogs.push({ name, held: this.hold(key, cpu), cpu });
      if (path && ODD_FOLDER.test(path) && cpu >= 10) {
        if (this.hold(oddKey, cpu) >= SUSPICIOUS_MS) {
          this.alert(oddKey, SECURITY_COOLDOWN_MS, {
            kind: 'suspicious',
            severity: 'warn',
            title: `A program from a temporary folder keeps working`,
            detail: `${name} runs from ${path} and has used CPU for minutes. Installers do that briefly; anything else running from there is worth a look.`,
            app: name,
          });
        }
      } else this.release(oddKey);
    }
    await this.reportHogs(hogs, 'cpu');
  }

  /** Per-program GPU use (nvidia-smi pmon, sampled while the GPU is busy). */
  async onGpuProcesses(list: { name: string; sm: number }[]): Promise<void> {
    if (!this.on()) return;
    const hogs: { name: string; held: number; cpu: number }[] = [];
    const seen = new Set<string>();
    for (const { name, sm } of list) {
      if (this.ignored(name) || seen.has(name)) continue;
      seen.add(name);
      const key = `gpu:${name.toLowerCase()}`;
      if (sm < GPU_HOG_PCT) this.release(key);
      else hogs.push({ name, held: this.hold(key, sm), cpu: sm });
    }
    await this.reportHogs(hogs, 'gpu');
  }

  private async reportHogs(hogs: { name: string; held: number; cpu: number }[], what: 'cpu' | 'gpu') {
    const due = hogs.filter((h) => h.held >= HOG_MS && (this.cooldown.get(`${what}:${h.name.toLowerCase()}`) ?? 0) <= this.now());
    if (due.length === 0) return;
    // Only background programs: one with a window open is in use (a game, a render, a video call).
    const windowed = await this.hooks.windowed().catch(() => new Set<string>());
    for (const h of due) {
      const key = `${what}:${h.name.toLowerCase()}`;
      if (windowed.has(h.name.toLowerCase())) {
        this.streaks.delete(key);
        continue;
      }
      const streak = this.streaks.get(key);
      const minutes = Math.round(h.held / MIN);
      this.alert(key, HOG_COOLDOWN_MS, {
        kind: what === 'cpu' ? 'cpu-hog' : 'gpu-hog',
        severity: 'warn',
        title: `${h.name} is working hard in the background`,
        detail: `It has used about ${Math.round(streak?.value ?? h.cpu)}% of your ${what.toUpperCase()} for ${minutes} minutes, with no window open.${
          what === 'gpu' ? ' Programs that secretly mine crypto look like this.' : ''
        }`,
        app: h.name,
      });
    }
  }

  // ── Windows Defender ──

  onDefender(report: DefenderReport): void {
    if (!this.on()) return;
    if (!report.realTime) {
      this.alert('defender:off', SECURITY_COOLDOWN_MS, {
        kind: 'protection-off',
        severity: 'critical',
        title: 'Windows Defender real-time protection is off',
        detail:
          'Your PC isn’t scanning files as they arrive. Turn it back on in Windows Security › Virus & threat protection, unless you switched it off on purpose.',
      });
    }
    const newest = Math.max(0, ...report.detections.map((d) => d.at));
    const seen = this.hooks.defenderSeen.get();
    // The first look only learns what's already there: old detections never alert.
    if (seen === undefined) {
      this.hooks.defenderSeen.set(newest);
      return;
    }
    for (const d of report.detections.filter((x) => x.at > seen).sort((a, b) => a.at - b.at)) {
      this.alert(`threat:${d.id}:${d.at}`, SECURITY_COOLDOWN_MS, {
        kind: 'threat',
        severity: 'critical',
        title: `Windows Defender found ${d.name ?? 'a threat'}`,
        detail: `${d.resource ? `In ${d.resource}. ` : ''}${
          d.removed ? 'Defender dealt with it.' : 'It isn’t removed yet: open Windows Security › Protection history.'
        }`,
      });
    }
    if (newest > seen) this.hooks.defenderSeen.set(newest);
  }
}
