import { readlinkSync } from 'node:fs';
import { basename } from 'node:path';
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
  /** Linux: the GPU read from sysfs (Windows gets its name from LibreHardwareMonitor or nvidia-smi). */
  gpuName?: string;
}

export async function readStaticInfo(): Promise<StaticInfo> {
  const [cpu, mem, gpuName] = await Promise.all([si.cpu(), si.mem(), IS_WINDOWS ? undefined : linuxGpuName()]);
  return {
    cpuName: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cores: cpu.physicalCores,
    threads: cpu.cores,
    totalMemBytes: mem.total,
    gpuName,
  };
}

/** Linux: the GPU's marketing name from lspci ("Cezanne [Radeon Vega Series / …]" → "Radeon Vega Series"), read once. */
async function linuxGpuName(): Promise<string> {
  const model = (await si.graphics().catch(() => null))?.controllers[0]?.model ?? '';
  return (/\[([^\]/]+)/.exec(model)?.[1] ?? model).trim() || 'GPU';
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

/**
 * Linux: the program a process runs, from /proc/<pid>/exe. systeminformation guesses it from
 * the command line, which programs can rewrite (a Chrome window showed up as its page's URL).
 * Other users' processes can't be read; for those systeminformation's guess stays (its `path`
 * is the program's folder there).
 */
export function linuxProgram(p: { pid: number; name: string; path: string }): { name: string; path: string } {
  try {
    const exe = readlinkSync(`/proc/${p.pid}/exe`).replace(/ \(deleted\)$/, '');
    return { name: basename(exe), path: exe };
  } catch {
    return { name: p.name, path: p.path && !p.path.includes(' ') ? `${p.path}/${p.name}` : p.path };
  }
}

/**
 * Without Harv's own short-lived helpers: on Linux systeminformation lists processes by running
 * `sh -c ps …`, which then shows up in its own list as a top CPU user.
 */
export function withoutOwnHelpers<T extends { pid: number; parentPid: number }>(list: T[], self = process.pid): T[] {
  const children = new Set(list.filter((p) => p.parentPid === self).map((p) => p.pid));
  return list.filter((p) => !children.has(p.pid) && !children.has(p.parentPid));
}

export async function readProcesses(): Promise<{ byCpu: ProcessUsage[]; byMem: ProcessUsage[]; all: ProcessInfo[] }> {
  const raw = (await si.processes()).list;
  const list = IS_WINDOWS ? raw : withoutOwnHelpers(raw).map((p) => ({ ...p, ...linuxProgram(p) }));
  const all = list.filter((p) => !IDLE.has(p.name)).map((p) => ({ pid: p.pid, name: p.name, cpu: p.cpu, path: p.path || null }));
  return { ...topProcesses(list), all };
}

export async function readVolumes(): Promise<VolumeMetrics[]> {
  const list = await si.fsSize();
  // Linux: the user's mounts, once per device (Fedora's / and /home share one btrfs disk).
  const devices = new Set<string>();
  const firstOfDevice = (fs: string) => !devices.has(fs) && devices.add(fs) !== undefined;
  return list
    .filter((v) => v.size > 0 && (IS_WINDOWS || (isUserMount(v.mount) && firstOfDevice(v.fs))))
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
