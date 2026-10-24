import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GpuMetrics, NetworkMetrics } from '@harv/shared';

// Linux readings straight from the kernel's files: cheap enough for every 1 s tick,
// where Windows gets the same from LibreHardwareMonitor.

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
};
const num = (path: string): number | undefined => {
  const v = Number(read(path));
  return read(path) !== undefined && Number.isFinite(v) ? v : undefined;
};

/** Interfaces that aren't real traffic: loopback, containers, VM bridges. */
const VIRTUAL = /^(lo|veth|docker|br-|virbr|vnet|podman|cni|flannel)/;

/** Byte counters per interface from /proc/net/dev. */
export function parseNetDev(text: string): Map<string, { rx: number; tx: number }> {
  const out = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split('\n').slice(2)) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m || VIRTUAL.test(m[1]!)) continue;
    const cols = m[2]!.trim().split(/\s+/).map(Number);
    out.set(m[1]!, { rx: cols[0] ?? 0, tx: cols[8] ?? 0 });
  }
  return out;
}

let lastNet: { at: number; counters: Map<string, { rx: number; tx: number }> } | null = null;

/** Download and upload speed per interface since the last call (undefined on the first one). */
export function readLinuxNetwork(now = Date.now(), text = read('/proc/net/dev')): NetworkMetrics | undefined {
  if (text === undefined) return undefined;
  const counters = parseNetDev(text);
  const prev = lastNet;
  lastNet = { at: now, counters };
  if (!prev || now <= prev.at) return undefined;
  const secs = (now - prev.at) / 1000;
  const adapters = [...counters].flatMap(([name, c]) => {
    const before = prev.counters.get(name);
    if (!before) return [];
    // A counter that went backwards was reset (the interface came back up).
    return [{ name, downBps: Math.max(0, c.rx - before.rx) / secs, upBps: Math.max(0, c.tx - before.tx) / secs }];
  });
  // Interfaces that have never moved data stay hidden, like unused adapters on Windows.
  const used = adapters.filter((a) => (counters.get(a.name)?.rx ?? 0) + (counters.get(a.name)?.tx ?? 0) > 0);
  return {
    downBps: used.reduce((s, a) => s + a.downBps, 0),
    upBps: used.reduce((s, a) => s + a.upBps, 0),
    adapters: used,
  };
}

/** The AMD GPU's sysfs folder (amdgpu reports gpu_busy_percent), if there is one. */
function amdgpuDir(root = '/sys/class/drm'): string | undefined {
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((d) => /^card\d+$/.test(d))
    .map((d) => join(root, d, 'device'))
    .find((d) => existsSync(join(d, 'gpu_busy_percent')));
}

let gpuDir: string | null | undefined;

/** Load, temperature, clock and VRAM of an AMD GPU (integrated Radeon included) from sysfs. */
export function readLinuxGpu(name: string, root?: string): GpuMetrics | undefined {
  if (gpuDir === undefined || root) gpuDir = amdgpuDir(root) ?? null;
  if (!gpuDir) return undefined;
  const load = num(join(gpuDir, 'gpu_busy_percent'));
  if (load === undefined) return undefined;
  const hwmonRoot = join(gpuDir, 'hwmon');
  const hwmon = existsSync(hwmonRoot) ? readdirSync(hwmonRoot).map((d) => join(hwmonRoot, d))[0] : undefined;
  const milli = hwmon ? num(join(hwmon, 'temp1_input')) : undefined;
  const hz = hwmon ? num(join(hwmon, 'freq1_input')) : undefined;
  const microW = hwmon ? (num(join(hwmon, 'power1_average')) ?? num(join(hwmon, 'power1_input'))) : undefined;
  const used = num(join(gpuDir, 'mem_info_vram_used'));
  const total = num(join(gpuDir, 'mem_info_vram_total'));
  return {
    name,
    load,
    tempC: milli !== undefined ? milli / 1000 : undefined,
    coreClockMhz: hz !== undefined ? hz / 1e6 : undefined,
    powerW: microW !== undefined ? microW / 1e6 : undefined,
    vramUsedMb: used !== undefined ? used / 2 ** 20 : undefined,
    vramTotalMb: total !== undefined ? total / 2 ** 20 : undefined,
    fanRpm: [],
  };
}
