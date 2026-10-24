import type { DriveInfo } from '@harv/shared';
import { getPlatform } from '../../../lib/useHarvSocket.ts';

// Paths the server sends are Windows paths (C:\Users\me) on the PC and POSIX paths
// (/home/me) on the Linux notebook (docs/PLAN.md §6m). Each path tells its own kind.

const isPosix = (path: string) => path.startsWith('/');

/** The last part of a path: "notes.txt", or the path itself for a root. */
export function baseName(path: string): string {
  const sep = isPosix(path) ? '/' : '\\';
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
  return trimmed.slice(trimmed.lastIndexOf(sep) + 1) || trimmed;
}

/** The folder a path is in ("C:\" and "/" are their own folder). */
export function dirOf(path: string): string {
  if (isPosix(path)) {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
  }
  const i = path.lastIndexOf('\\');
  return i <= 2 ? path.slice(0, 3) : path.slice(0, i);
}

/** "Local Disk (C:)" on Windows; just the label ("Home", "USB STICK") on Linux. */
export const driveName = (d: DriveInfo) => (isPosix(d.path) ? d.label : `${d.label} (${d.path.slice(0, 2)})`);

/** Which drive a path is on: its letter, or the deepest mount point that holds it. */
export function driveOf(path: string, drives: DriveInfo[]): string {
  if (!isPosix(path)) return path.slice(0, 2).toLowerCase();
  const inside = (mount: string) => mount === '/' || path === mount || path.startsWith(`${mount}/`);
  return drives.filter((d) => inside(d.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path ?? '/';
}

/** The folders from the root down: [{ "C:\", "C:\Users", "C:\Users\me" }] or [{ "/", "/home", "/home/me" }]. */
export function pathParts(loc: string): { label: string; loc: string }[] {
  if (isPosix(loc)) {
    const out = [{ label: '/', loc: '/' }];
    let path = '';
    for (const segment of loc.split('/').filter(Boolean)) {
      path = `${path}/${segment}`;
      out.push({ label: segment, loc: path });
    }
    return out;
  }
  const [drive, ...rest] = loc.split('\\').filter(Boolean);
  let path = `${drive}\\`;
  const out = [{ label: path, loc: path }];
  for (const segment of rest) {
    path = path.endsWith('\\') ? `${path}${segment}` : `${path}\\${segment}`;
    out.push({ label: segment, loc: path });
  }
  return out;
}

/** A path typed into the address bar, in the server's own form. */
export const typedPath = (text: string) => (getPlatform() === 'windows' ? text.replace(/\//g, '\\') : text);

/** What things are called on the OS the server runs on. */
export function osWords() {
  return getPlatform() === 'windows'
    ? { computer: 'This PC', bin: 'the Recycle Bin', fileManager: 'Windows Explorer' }
    : { computer: 'Computer', bin: 'the Trash', fileManager: 'the file manager' };
}
