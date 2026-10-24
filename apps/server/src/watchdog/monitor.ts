import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WatchdogAlert } from '@harv/shared';
import type { MetricsCollector } from '../metrics/collector.ts';
import { HARV_HOME } from '../paths.ts';
import { loadSettings } from '../settings.ts';
import { defenderReport, gpuByPid, windowedApps } from './probes.ts';
import { GPU_HOG_PCT, Watchdog, type ProcessSample } from './watchdog.ts';

const DEFENDER_MS = 10 * 60 * 1000;
const DEFENDER_FIRST_MS = 60 * 1000;
/** GPU use per program is only sampled while the whole GPU is busy, at most this often. */
const PMON_MS = 30 * 1000;
const WINDOWED_CACHE_MS = 30 * 1000;

/** ~/.harv/watchdog.json: the newest Defender detection already seen, so old ones never alert after a restart. */
const statePath = () => join(HARV_HOME, 'watchdog.json');
function readSeen(): number | undefined {
  try {
    if (!existsSync(statePath())) return undefined;
    const at = (JSON.parse(readFileSync(statePath(), 'utf8')) as { defenderSeen?: unknown }).defenderSeen;
    return typeof at === 'number' ? at : undefined;
  } catch {
    return undefined;
  }
}

/** Feeds the watchdog from the sensors, the process list, nvidia-smi and Windows Defender. */
export function startWatchdog(collector: MetricsCollector, emit: (alert: WatchdogAlert) => void): { watchdog: Watchdog; stop: () => void } {
  let seen = readSeen();
  let windowed: { at: number; names: Set<string> } | null = null;
  const watchdog = new Watchdog({
    emit,
    settings: loadSettings,
    windowed: async () => {
      if (!windowed || Date.now() - windowed.at > WINDOWED_CACHE_MS) windowed = { at: Date.now(), names: await windowedApps() };
      return windowed.names;
    },
    defenderSeen: {
      get: () => seen,
      set: (at) => {
        seen = at;
        try {
          writeFileSync(statePath(), JSON.stringify({ defenderSeen: at }));
        } catch {
          // Not critical: at worst an old detection shows once more.
        }
      },
    },
  });

  let processes: ProcessSample[] = [];
  let pmonAt = 0;
  let pmonRunning = false;
  const offProcesses = collector.onProcesses((list) => {
    processes = list;
    void watchdog.onProcesses(list);
  });
  const offMetrics = collector.onSnapshot((m) => {
    watchdog.onMetrics(m);
    // Per-program GPU use costs a call, so only while the GPU is busy enough for one program to be hogging it.
    if (!loadSettings().watchdog || pmonRunning || (m.gpu?.load ?? 0) < GPU_HOG_PCT || Date.now() - pmonAt < PMON_MS) return;
    pmonRunning = true;
    pmonAt = Date.now();
    void gpuByPid()
      .then((rows) => {
        const names = new Map(processes.map((p) => [p.pid, p.name]));
        return watchdog.onGpuProcesses(rows.flatMap((r) => (names.has(r.pid) ? [{ name: names.get(r.pid)!, sm: r.sm }] : [])));
      })
      .catch(() => {})
      .finally(() => (pmonRunning = false));
  });

  const checkDefender = () => {
    if (loadSettings().watchdog)
      void defenderReport().then(
        (r) => watchdog.onDefender(r),
        () => {},
      );
  };
  const first = setTimeout(checkDefender, DEFENDER_FIRST_MS);
  const every = setInterval(checkDefender, DEFENDER_MS);

  return {
    watchdog,
    stop: () => {
      offProcesses();
      offMetrics();
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
