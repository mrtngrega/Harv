import { homedir, tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { HARV_HOME } from '../paths.ts';
import { IS_WINDOWS, osPath, pathKey } from '../platform.ts';

/** Harv's own working folder, the only place it may create and change files freely. */
export const WORKSPACE = join(HARV_HOME, 'workspace');
/** Where Claude Code writes its plans (options.ts), so plan mode can write only there. */
export const PLANS_DIR = join(WORKSPACE, 'plans');
export const BACKUPS_DIR = join(HARV_HOME, 'backups');

/**
 * An absolute path of this OS, for comparisons. Accepts `~` and paths relative to
 * `cwd`; on Windows also Git Bash paths (/c/Users) and forward slashes.
 */
export function fullPath(p: string, cwd = WORKSPACE): string {
  let path = p.trim().replace(/^["']|["']$/g, '');
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = join(homedir(), path.slice(1));
  if (!IS_WINDOWS) return osPath.normalize(resolve(cwd, path));
  // Git Bash's /tmp is the Windows temp folder.
  if (/^\/tmp(\/|$)/.test(path)) path = join(tempDirs()[0]!, path.slice(4));
  const bash = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(path);
  if (bash) path = `${bash[1]!.toUpperCase()}:\\${bash[3] ?? ''}`;
  path = path.replace(/\//g, '\\');
  return win32.normalize(win32.isAbsolute(path) ? path : resolve(cwd, path));
}

/** Whether `child` is `parent` or inside it (without case on Windows). */
export function isInside(child: string, parent: string): boolean {
  const sep = osPath.sep;
  const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
  const c = trim(pathKey(fullPath(child)));
  const p = trim(pathKey(fullPath(parent)));
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

/** Where the OS lives: never written (C:\Windows; /usr, /etc and the other system folders on Linux). */
const SYSTEM_DIRS = IS_WINDOWS
  ? [process.env.SystemRoot ?? 'C:\\Windows']
  : ['/boot', '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev', '/root'];
/** Installed programs and their data: changing them asks first. */
const PROGRAM_DIRS = (
  IS_WINDOWS ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData] : ['/opt', '/var', '/srv', '/snap']
).filter((d): d is string => Boolean(d));

export const isSystemDir = (p: string) => SYSTEM_DIRS.some((d) => isInside(p, d));
export const isProgramDir = (p: string) => PROGRAM_DIRS.some((d) => isInside(p, d));
/** Harv's database, backups and memory: only Harv's own code changes them, never a tool call. */
export const isHarvData = (p: string) => isInside(p, HARV_HOME) && !isInside(p, WORKSPACE);

/** The temp folders, scratch space for project chats (`HARV_TEMP` replaces them in tests). */
export const tempDirs = () => (process.env.HARV_TEMP ? [process.env.HARV_TEMP] : [tmpdir(), ...(IS_WINDOWS ? [] : ['/tmp', '/var/tmp'])]);
export const isTempDir = (p: string) => tempDirs().some((d) => isInside(p, d));

/** Settings (protectedPaths and the rest) live in ../settings.ts; re-exported for the gate. */
export { loadSettings } from '../settings.ts';
