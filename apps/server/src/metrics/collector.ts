import { uptime } from 'node:os';
import type { MetricsSnapshot, ProcessUsage, VolumeMetrics } from '@harv/shared';
import { IS_WINDOWS } from '../platform.ts';
import { readingsFromLhm } from './fromLhm.ts';
import { fetchLhm } from './lhm.ts';
import { readLinuxCpuClock, readLinuxGpu, readLinuxNetwork } from './linux.ts';
import { readNvidiaSmi } from './nvidia.ts';
import { readCpuMemFallback, readProcesses, readStaticInfo, readVolumes, type ProcessInfo, type StaticInfo } from './system.ts';

const TICK_MS = 1000;
const FALLBACK_TICK_MS = 2000;
const PROCESSES_MS = 5000;
const VOLUMES_MS = 30_000;

type Listener = (snapshot: MetricsSnapshot) => void;

/**
 * Polls the sensor sources and emits one merged snapshot per tick.
 * LibreHardwareMonitor is the fast path; slow systeminformation calls run on
 * their own timers and their latest results are merged in.
 */
export class MetricsCollector {
  private listeners = new Set<Listener>();
  private processListeners = new Set<(list: ProcessInfo[]) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private staticInfo: StaticInfo | null = null;
  private processes: { byCpu: ProcessUsage[]; byMem: ProcessUsage[] } = { byCpu: [], byMem: [] };
  private volumes: VolumeMetrics[] = [];
  private peakCpuTemp: number | undefined;
  private lastFallbackAt = 0;
  private fallbackCache: Awaited<ReturnType<typeof readCpuMemFallback>> | null = null;
  private stopped = false;
  latest: MetricsSnapshot | null = null;

  onSnapshot(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every running process, each time the list refreshes (~5 s; the watchdog reads it). */
  onProcesses(listener: (list: ProcessInfo[]) => void): () => void {
    this.processListeners.add(listener);
    return () => this.processListeners.delete(listener);
  }

  /** `tickMs`: how often a snapshot is pushed (the user's "stats update" setting); read before every tick. */
  constructor(private tickMs: () => number = () => TICK_MS) {}

  async start(): Promise<void> {
    this.staticInfo = await readStaticInfo();
    this.loop(() => this.refreshProcesses(), PROCESSES_MS);
    this.loop(() => this.refreshVolumes(), VOLUMES_MS);
    this.loop(() => this.tick(), this.tickMs);
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
  }

  /** Runs `fn` now and then every `ms` after it finishes, so slow calls never pile up. */
  private loop(fn: () => Promise<void>, ms: number | (() => number)): void {
    const run = async () => {
      try {
        await fn();
      } catch {
        // A failed read just skips this round; the next one retries.
      }
      if (!this.stopped) this.timers.push(setTimeout(run, typeof ms === 'number' ? ms : ms()));
    };
    void run();
  }

  private async refreshProcesses() {
    const { byCpu, byMem, all } = await readProcesses();
    this.processes = { byCpu, byMem };
    for (const listener of this.processListeners) listener(all);
  }

  private async refreshVolumes() {
    this.volumes = await readVolumes();
  }

  private async tick() {
    const info = this.staticInfo!;
    // LibreHardwareMonitor only exists on Windows.
    const sensors = IS_WINDOWS ? await fetchLhm() : null;
    const lhm = sensors ? readingsFromLhm(sensors) : null;

    // Linux: an AMD GPU from sysfs (integrated Radeon included).
    let gpu = lhm?.gpu ?? (IS_WINDOWS ? undefined : readLinuxGpu(info.gpuName ?? 'GPU'));
    let nvidiaSmi = false;
    if (!gpu) {
      gpu = (await readNvidiaSmi()) ?? undefined;
      nvidiaSmi = gpu !== undefined;
    }

    let cpu = lhm?.cpu;
    let memory = lhm?.memory;
    if (!cpu || !memory) {
      // Without LHM, systeminformation is too slow for 1 s ticks; refresh it every 2 s.
      if (!this.fallbackCache || Date.now() - this.lastFallbackAt >= FALLBACK_TICK_MS) {
        this.fallbackCache = await readCpuMemFallback();
        this.lastFallbackAt = Date.now();
      }
      const fb = this.fallbackCache;
      cpu ??= {
        name: info.cpuName,
        load: fb.cpuLoad,
        perThread: fb.perThread,
        tempC: fb.tempC,
        ...(IS_WINDOWS ? {} : { clockMhz: readLinuxCpuClock() }),
      };
      memory ??= {
        load: (fb.memUsed / fb.memTotal) * 100,
        usedBytes: fb.memUsed,
        availableBytes: fb.memAvailable,
        modules: [],
      };
    }

    if (cpu.tempC !== undefined) this.peakCpuTemp = Math.max(this.peakCpuTemp ?? 0, cpu.tempC);

    const snapshot: MetricsSnapshot = {
      at: Date.now(),
      uptimeSec: uptime(),
      cpu: {
        ...cpu,
        name: info.cpuName || cpu.name,
        cores: info.cores,
        threads: info.threads,
        peakTempC: this.peakCpuTemp,
        topByCpu: this.processes.byCpu,
      },
      gpu,
      memory: {
        ...memory,
        totalBytes: info.totalMemBytes,
        topByMem: this.processes.byMem,
      },
      volumes: this.volumes,
      drives: lhm?.drives ?? [],
      network: lhm?.network ?? (IS_WINDOWS ? undefined : readLinuxNetwork()),
      cooling: lhm?.cooling,
      sources: { lhm: lhm !== null, nvidiaSmi },
    };

    this.latest = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
