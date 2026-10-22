import si from 'systeminformation';
import type { ProcessUsage, VolumeMetrics } from '@harv/shared';

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

export async function readProcesses(): Promise<{ byCpu: ProcessUsage[]; byMem: ProcessUsage[] }> {
  const { list } = await si.processes();
  return topProcesses(list);
}

export async function readVolumes(): Promise<VolumeMetrics[]> {
  const list = await si.fsSize();
  return list
    .filter((v) => v.size > 0)
    .map((v) => ({ mount: v.mount, usedBytes: v.used, totalBytes: v.size, load: v.use }))
    .sort((a, b) => a.mount.localeCompare(b.mount));
}

/** Fallback CPU + memory when LibreHardwareMonitor isn't running. */
export async function readCpuMemFallback() {
  const [load, mem] = await Promise.all([si.currentLoad(), si.mem()]);
  return {
    cpuLoad: load.currentLoad,
    perThread: load.cpus.map((c) => c.load),
    memUsed: mem.active,
    memAvailable: mem.available,
    memTotal: mem.total,
  };
}
