import si from 'systeminformation';
import type { ProcessUsage, VolumeMetrics } from '@harv/shared';
import { IS_WINDOWS, isUserMount } from '../platform.ts';

// systeminformation shells out to PowerShell/WMI on Windows, so each call costs
// 0.5–5 s. It's only used for things LibreHardwareMonitor doesn't provide
// (processes, drive letters, static CPU info) and as a fallback.

export interface StaticInfo {
  cpuName: string;
  cores: number;
  threads: number;
  totalMemBytes: number;
}

export async function readStaticInfo(): Promise<StaticInfo> {
  const [cpu, mem] = await Promise.all([si.cpu(), si.mem()]);
  return {
    cpuName: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cores: cpu.physicalCores,
    threads: cpu.cores,
    totalMemBytes: mem.total,
  };
}

const IDLE = new Set(['System Idle Process', 'Idle']);

/** Groups processes by executable (chrome has dozens) and returns the top N by CPU and by memory. */
export function topProcesses(
  list: { name: string; cpu: number; memRss: number }[],
  n = 3,
): { byCpu: ProcessUsage[]; byMem: ProcessUsage[] } {
  const grouped = new Map<string, ProcessUsage>();
  for (const p of list) {
    if (IDLE.has(p.name)) continue;
    const g = grouped.get(p.name) ?? { name: p.name, cpu: 0, memBytes: 0 };
    g.cpu += p.cpu;
    g.memBytes += p.memRss * 1024; // memRss is reported in KB
    grouped.set(p.name, g);
  }
  const all = [...grouped.values()];
  return {
    byCpu: [...all].sort((a, b) => b.cpu - a.cpu).slice(0, n),
    byMem: [...all].sort((a, b) => b.memBytes - a.memBytes).slice(0, n),
  };
}

/** One running process, as the watchdog sees it. */
export interface ProcessInfo {
  pid: number;
  name: string;
  /** Share of the whole CPU, 0–100. */
  cpu: number;
  path: string | null;
}

export async function readProcesses(): Promise<{ byCpu: ProcessUsage[]; byMem: ProcessUsage[]; all: ProcessInfo[] }> {
  const { list } = await si.processes();
  const all = list.filter((p) => !IDLE.has(p.name)).map((p) => ({ pid: p.pid, name: p.name, cpu: p.cpu, path: p.path || null }));
  return { ...topProcesses(list), all };
}

export async function readVolumes(): Promise<VolumeMetrics[]> {
  const list = await si.fsSize();
  return list
    .filter((v) => v.size > 0 && (IS_WINDOWS || isUserMount(v.mount)))
    .map((v) => ({ mount: v.mount, usedBytes: v.used, totalBytes: v.size, load: v.use }))
    .sort((a, b) => a.mount.localeCompare(b.mount));
}

/** CPU temperature on Linux (read from /sys, cheap); Windows needs LibreHardwareMonitor for it. */
async function linuxCpuTemp(): Promise<number | undefined> {
  if (IS_WINDOWS) return undefined;
  const t = await si.cpuTemperature().catch(() => null);
  return t && typeof t.main === 'number' && t.main > 0 ? t.main : undefined;
}

/** Fallback CPU + memory when LibreHardwareMonitor isn't running (always on Linux). */
export async function readCpuMemFallback() {
  const [load, mem, tempC] = await Promise.all([si.currentLoad(), si.mem(), linuxCpuTemp()]);
  return {
    cpuLoad: load.currentLoad,
    perThread: load.cpus.map((c) => c.load),
    memUsed: mem.active,
    memAvailable: mem.available,
    memTotal: mem.total,
    tempC,
  };
}
