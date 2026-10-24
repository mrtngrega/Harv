import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DefenderReport } from './watchdog.ts';

// Cheap Windows checks for the watchdog. None needs admin rights or uses Claude.

const run = promisify(execFile);

async function powershell(script: string, timeout = 20_000): Promise<string> {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/** Lowercase exe names of programs with a visible window (in use by the user). */
export async function windowedApps(): Promise<Set<string>> {
  const out = await powershell('Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName }');
  return new Set(
    out
      .split(/\r?\n/)
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean)
      .map((n) => `${n}.exe`),
  );
}

/** GPU use per process id (`nvidia-smi pmon`, one sample). Its names are cut to 15 characters, so ids map them. */
export function parsePmon(out: string): { pid: number; sm: number }[] {
  const rows: { pid: number; sm: number }[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[1]);
    const sm = Number(cols[3]);
    if (Number.isInteger(pid) && pid > 0 && Number.isFinite(sm)) rows.push({ pid, sm });
  }
  return rows;
}

export async function gpuByPid(): Promise<{ pid: number; sm: number }[]> {
  const { stdout } = await run('nvidia-smi', ['pmon', '-c', '1', '-s', 'u'], { timeout: 10_000, windowsHide: true });
  return parsePmon(stdout);
}

/** "/Date(1791478301578)/" (PowerShell's JSON dates) or an ISO string → epoch ms. */
const toMs = (v: unknown): number => {
  if (typeof v !== 'string') return 0;
  const m = /\/Date\((\d+)\)\//.exec(v);
  return m ? Number(m[1]) : Date.parse(v) || 0;
};

/** Windows Defender: is real-time protection on, and what has it detected (with threat names)? */
export function parseDefender(json: string): DefenderReport {
  const raw = JSON.parse(json) as {
    rt?: boolean;
    d?: { ThreatID?: number; InitialDetectionTime?: unknown; ActionSuccess?: boolean; Resources?: string[] | null }[] | null;
    t?: { ThreatID?: number; ThreatName?: string }[] | null;
  };
  const names = new Map((raw.t ?? []).map((t) => [t.ThreatID, t.ThreatName]));
  return {
    realTime: raw.rt !== false,
    detections: (raw.d ?? []).map((d) => ({
      id: String(d.ThreatID ?? '?'),
      at: toMs(d.InitialDetectionTime),
      ...(names.get(d.ThreatID) ? { name: names.get(d.ThreatID)! } : {}),
      ...(d.Resources?.[0] ? { resource: d.Resources[0].replace(/^\w+:_/, '') } : {}),
      removed: d.ActionSuccess === true,
    })),
  };
}

export async function defenderReport(): Promise<DefenderReport> {
  const out = await powershell(
    '$s = Get-MpComputerStatus; ' +
      '$d = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Select-Object ThreatID, InitialDetectionTime, ActionSuccess, Resources); ' +
      '$t = @(Get-MpThreat -ErrorAction SilentlyContinue | Select-Object ThreatID, ThreatName); ' +
      '@{ rt = $s.RealTimeProtectionEnabled; d = $d; t = $t } | ConvertTo-Json -Depth 4 -Compress',
    30_000,
  );
  return parseDefender(out);
}
