import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuMetrics } from '@harv/shared';

const run = promisify(execFile);

const FIELDS = [
  'name',
  'utilization.gpu',
  'temperature.gpu',
  'memory.used',
  'memory.total',
  'power.draw',
  'clocks.gr',
  'clocks.mem',
  'fan.speed',
] as const;

/** Parses one CSV line from `nvidia-smi --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(line: string): GpuMetrics | null {
  const cols = line.split(',').map((c) => c.trim());
  if (cols.length < FIELDS.length) return null;
  const num = (i: number) => {
    const n = Number(cols[i]);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    name: cols[0]!,
    load: num(1) ?? 0,
    tempC: num(2),
    vramUsedMb: num(3),
    vramTotalMb: num(4),
    powerW: num(5),
    coreClockMhz: num(6),
    memClockMhz: num(7),
    fanPct: num(8),
    fanRpm: [],
  };
}

/** GPU fallback when LibreHardwareMonitor isn't running (NVIDIA only). */
export async function readNvidiaSmi(): Promise<GpuMetrics | null> {
  try {
    const { stdout } = await run('nvidia-smi', [`--query-gpu=${FIELDS.join(',')}`, '--format=csv,noheader,nounits'], {
      timeout: 2000,
      windowsHide: true,
    });
    return parseNvidiaSmi(stdout.split(/\r?\n/)[0] ?? '');
  } catch {
    return null;
  }
}
