import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { IS_WINDOWS } from '../platform.ts';

const run = promisify(execFile);
/** Git for Windows' own `ps`: it knows how its processes belong together (Windows doesn't, see below). */
const MSYS_PS = 'C:\\Program Files\\Git\\usr\\bin\\ps.exe';

/**
 * The part of a background command that is sure to appear in the command line of Claude
 * Code's wrapper shell (`bash -c "… eval '<command>' …"`, with quotes escaped): the
 * longest stretch without quotes or backslashes. Null when there is nothing safe to match.
 */
export function wrapperFragment(command: string): string | null {
  const parts = command.split(/['"\\`]/).map((p) => p.trim());
  const best = parts.sort((a, b) => b.length - a.length)[0] ?? '';
  return best.length >= 6 ? best : null;
}

/**
 * Windows PIDs of everything the wrapper shells started, from `ps -l` (PID PPID PGID WINPID …):
 * Git Bash's forks leave Windows' parent links pointing at processes that are gone, so the
 * MSYS process groups and parents are the only reliable tree.
 */
export function msysTree(psOutput: string, wrapperWinPids: number[]): number[] {
  const rows = psOutput
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/).slice(0, 4).map(Number))
    .filter((r) => r.length === 4 && r.every((n) => Number.isInteger(n)))
    .map(([pid, ppid, pgid, winpid]) => ({ pid: pid!, ppid: ppid!, pgid: pgid!, winpid: winpid! }));
  const tree = new Set(rows.filter((r) => wrapperWinPids.includes(r.winpid)).map((r) => r.pid));
  if (!tree.size) return [];
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) {
      if (!tree.has(r.pid) && (tree.has(r.ppid) || tree.has(r.pgid))) {
        tree.add(r.pid);
        grew = true;
      }
    }
  }
  return [...new Set(rows.filter((r) => tree.has(r.pid)).map((r) => r.winpid))];
}

/**
 * Windows only: stopping a background shell kills Claude Code's wrapper bash, but not
 * what it started, so a dev server or a long sleep kept running with nothing to stop it
 * (found in the test pass of 2026-10-25). This ends the wrapper and everything under it
 * first. It only looks at Claude Code's Bash-tool wrappers (their command line sources a
 * shell snapshot), never the user's own shells. Returns how many processes it ended.
 */
export async function killShellTree(command: string): Promise<number> {
  const fragment = IS_WINDOWS ? wrapperFragment(command) : null;
  if (!fragment) return 0;
  const script = [
    '$f = $env:HARV_KILL_FRAGMENT',
    "Get-CimInstance Win32_Process -Filter \"Name = 'bash.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('shell-snapshots') -and $_.CommandLine.Contains($f) } | ForEach-Object { $_.ProcessId }",
  ].join('; ');
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, HARV_KILL_FRAGMENT: fragment },
    });
    const wrappers = stdout
      .split(/\s+/)
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    if (!wrappers.length) return 0;
    const ps = existsSync(MSYS_PS) ? (await run(MSYS_PS, ['-l'], { windowsHide: true, timeout: 10_000 })).stdout : '';
    const pids = [...new Set([...msysTree(ps, wrappers), ...wrappers])];
    for (const pid of pids) await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    return pids.length;
  } catch {
    return 0;
  }
}
