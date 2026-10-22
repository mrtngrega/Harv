import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LhmLaunchResult } from '@harv/shared';
import { fetchLhm } from './lhm.ts';

const run = promisify(execFile);
const EXE = 'LibreHardwareMonitor.exe';

/** Finds LibreHardwareMonitor: HARV_LHM_PATH, else the winget install folder. */
export function findLhmExe(): string | null {
  const override = process.env.HARV_LHM_PATH;
  if (override) return existsSync(override) ? override : null;
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (!existsSync(packages)) return null;
  const dir = readdirSync(packages).find((d) => d.startsWith('LibreHardwareMonitor.LibreHardwareMonitor_'));
  const exe = dir ? join(packages, dir, EXE) : null;
  return exe && existsSync(exe) ? exe : null;
}

async function isProcessRunning(): Promise<boolean> {
  try {
    const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH'], { windowsHide: true });
    return stdout.includes(EXE);
  } catch {
    return false;
  }
}

/**
 * Starts LibreHardwareMonitor with admin rights (it needs them to read sensors),
 * which shows a Windows UAC prompt. Does nothing if it's already running.
 */
export async function ensureLhmRunning(): Promise<LhmLaunchResult> {
  if ((await fetchLhm()) || (await isProcessRunning())) return 'already-running';
  const exe = findLhmExe();
  if (!exe) return 'not-installed';
  try {
    // Start-Process -Verb RunAs is the standard way to request elevation; the user approves it in the UAC prompt.
    await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs`],
      {
        windowsHide: true,
        timeout: 120_000,
      },
    );
    return 'started';
  } catch (err) {
    return /cancel/i.test(String((err as { stderr?: string }).stderr ?? err)) ? 'declined' : 'failed';
  }
}
