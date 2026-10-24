import type { MetricsSnapshot, WatchdogAlert } from '@harv/shared';
import { describe, expect, it } from 'vitest';
import { parseDefender, parsePmon } from './probes.ts';
import { CPU_HOG_PCT, HEAT_MS, HOG_MS, WARN_GAP_MS, Watchdog, type DefenderReport } from './watchdog.ts';

const SEC = 1000;
const MIN = 60 * SEC;

function setup(opts: { windowed?: string[]; ignored?: string[]; on?: boolean } = {}) {
  let now = 1_000_000;
  let seen: number | undefined;
  const alerts: WatchdogAlert[] = [];
  const settings = { watchdog: opts.on ?? true, watchdogIgnored: opts.ignored ?? [] };
  const wd = new Watchdog({
    emit: (a) => alerts.push(a),
    settings: () => settings,
    windowed: async () => new Set(opts.windowed ?? []),
    defenderSeen: { get: () => seen, set: (at) => (seen = at) },
    now: () => now,
  });
  const advance = (ms: number) => (now += ms);
  return { wd, alerts, advance, settings, now: () => now };
}

const metrics = (cpuTemp: number, gpuTemp = 50): MetricsSnapshot =>
  ({
    at: 0,
    uptimeSec: 0,
    cpu: { name: 'cpu', cores: 8, threads: 16, load: 10, perThread: [], tempC: cpuTemp, topByCpu: [] },
    gpu: { name: 'gpu', load: 10, tempC: gpuTemp, fanRpm: [] },
    memory: { load: 0, usedBytes: 0, totalBytes: 0, availableBytes: 0, modules: [], topByMem: [] },
    volumes: [],
    drives: [],
    sources: { lhm: true, nvidiaSmi: false },
  }) as MetricsSnapshot;

/** Feeds the same reading every `step` for `ms`. */
async function feed(advance: (ms: number) => void, ms: number, step: number, fn: () => unknown) {
  for (let t = 0; t <= ms; t += step) {
    await fn();
    advance(step);
  }
}

describe('heat', () => {
  it('warns only when a temperature stays high, once until it cools down', async () => {
    const { wd, alerts, advance } = setup();
    await feed(advance, HEAT_MS - 10 * SEC, SEC, () => wd.onMetrics(metrics(87)));
    expect(alerts).toHaveLength(0);
    await feed(advance, 20 * SEC, SEC, () => wd.onMetrics(metrics(87)));
    expect(alerts.map((a) => a.title)).toEqual(['CPU is running hot']);
    await feed(advance, 40 * MIN, SEC * 5, () => wd.onMetrics(metrics(87)));
    expect(alerts).toHaveLength(1);
  });

  it('ignores short spikes, and warns about real overheating fast', async () => {
    const { wd, alerts, advance } = setup();
    for (let i = 0; i < 10; i++) {
      await feed(advance, 30 * SEC, SEC, () => wd.onMetrics(metrics(88)));
      await feed(advance, 60 * SEC, SEC, () => wd.onMetrics(metrics(60)));
    }
    expect(alerts).toHaveLength(0);
    await feed(advance, 25 * SEC, SEC, () => wd.onMetrics(metrics(60, 91)));
    expect(alerts[0]).toMatchObject({ title: 'GPU is running hot', severity: 'critical' });
  });
});

describe('background hogs', () => {
  const hog = (name: string, cpu: number) => [{ pid: 1, name, cpu, path: `C:\\Program Files\\x\\${name}` }];

  it('warns about a background program hogging the CPU for minutes', async () => {
    const { wd, alerts, advance } = setup();
    await feed(advance, HOG_MS - 10 * SEC, 5 * SEC, () => wd.onProcesses(hog('miner-ish.exe', CPU_HOG_PCT + 15)));
    expect(alerts).toHaveLength(0);
    await feed(advance, 15 * SEC, 5 * SEC, () => wd.onProcesses(hog('miner-ish.exe', CPU_HOG_PCT + 15)));
    expect(alerts[0]).toMatchObject({ kind: 'cpu-hog', app: 'miner-ish.exe' });
    expect(alerts[0]!.detail).toMatch(/35% of your CPU for 5 minutes/);
  });

  it('leaves alone programs with a window, ignored ones, Windows and Harv', async () => {
    const { wd, alerts, advance } = setup({ windowed: ['game.exe'], ignored: ['blender.exe'] });
    for (const name of ['game.exe', 'blender.exe', 'TiWorker.exe', 'node.exe']) {
      await feed(advance, HOG_MS + MIN, 5 * SEC, () => wd.onProcesses(hog(name, 80)));
    }
    expect(alerts).toHaveLength(0);
  });

  it('spaces ordinary warnings out', async () => {
    const { wd, alerts, advance } = setup();
    const both = [...hog('a.exe', 40), ...hog('b.exe', 40)];
    await feed(advance, HOG_MS + 10 * SEC, 5 * SEC, () => wd.onProcesses(both));
    expect(alerts).toHaveLength(1);
    await feed(advance, WARN_GAP_MS, 5 * SEC, () => wd.onProcesses(both));
    expect(alerts.map((a) => a.app)).toEqual(['a.exe', 'b.exe']);
  });

  it('flags GPU hogs from per-program GPU use', async () => {
    const { wd, alerts, advance } = setup();
    await feed(advance, HOG_MS + 30 * SEC, 30 * SEC, () => wd.onGpuProcesses([{ name: 'svc.exe', sm: 95 }]));
    expect(alerts[0]).toMatchObject({ kind: 'gpu-hog', app: 'svc.exe' });
  });
});

describe('dangerous software', () => {
  it('names known miners and remote-control tools at once', async () => {
    const { wd, alerts } = setup();
    await wd.onProcesses([{ pid: 9, name: 'xmrig.exe', cpu: 1, path: 'C:\\Users\\me\\AppData\\Roaming\\x\\xmrig.exe' }]);
    expect(alerts[0]).toMatchObject({ kind: 'suspicious', severity: 'critical', app: 'xmrig.exe' });
  });

  it('warns about a program from a Temp folder that keeps working', async () => {
    const { wd, alerts, advance } = setup();
    const odd = [{ pid: 3, name: 'upd.exe', cpu: 12, path: 'C:\\Users\\me\\AppData\\Local\\Temp\\upd.exe' }];
    await feed(advance, 3 * MIN + 10 * SEC, 5 * SEC, () => wd.onProcesses(odd));
    expect(alerts[0]).toMatchObject({ kind: 'suspicious', app: 'upd.exe' });
  });

  it('reports new Defender detections only, and protection turned off', () => {
    const { wd, alerts, advance, now } = setup();
    const report = (extra: DefenderReport['detections'] = [], realTime = true): DefenderReport => ({
      realTime,
      detections: [{ id: '1', at: 500, name: 'PUA:Win32/Old', removed: true }, ...extra],
    });
    wd.onDefender(report());
    expect(alerts).toHaveLength(0);
    advance(MIN);
    wd.onDefender(report([{ id: '2', at: now(), name: 'Trojan:Win32/New', resource: 'C:\\x.exe', removed: false }]));
    expect(alerts[0]).toMatchObject({ kind: 'threat', title: 'Windows Defender found Trojan:Win32/New' });
    expect(alerts[0]!.detail).toMatch(/isn’t removed yet/);
    wd.onDefender(report([], false));
    expect(alerts.at(-1)).toMatchObject({ kind: 'protection-off' });
    expect(alerts).toHaveLength(2);
  });

  it('stays quiet when turned off', async () => {
    const { wd, alerts } = setup({ on: false });
    await wd.onProcesses([{ pid: 9, name: 'xmrig.exe', cpu: 1 }]);
    expect(alerts).toHaveLength(0);
  });
});

describe('probe parsing', () => {
  it('reads nvidia-smi pmon', () => {
    const out = '# gpu   pid  type  sm  mem\n# Idx   #    C/G   %   %\n    0   3136  C+G   1   0   -  brave.exe\n    0   3684  C+G   -   -   -  SystemSettings.\n';
    expect(parsePmon(out)).toEqual([{ pid: 3136, sm: 1 }]);
  });

  it("reads Defender's report", () => {
    const json =
      '{"rt":true,"d":[{"ThreatID":5,"InitialDetectionTime":"\\/Date(1791478301578)\\/","ActionSuccess":true,"Resources":["file:_C:\\\\x.exe"]}],"t":[{"ThreatID":5,"ThreatName":"PUA:Win32/X"}]}';
    expect(parseDefender(json)).toEqual({
      realTime: true,
      detections: [{ id: '5', at: 1791478301578, name: 'PUA:Win32/X', resource: 'C:\\x.exe', removed: true }],
    });
  });
});
