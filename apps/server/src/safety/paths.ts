import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { HARV_HOME } from '../paths.ts';

/** Harv's own working folder, the only place it may create and change files freely. */
export const WORKSPACE = join(HARV_HOME, 'workspace');
export const BACKUPS_DIR = join(HARV_HOME, 'backups');
const SETTINGS_PATH = join(HARV_HOME, 'settings.json');

/**
 * An absolute Windows path for comparisons. Accepts Git Bash paths (/c/Users),
 * forward slashes, `~` and paths relative to `cwd`.
 */
export function toWindowsPath(p: string, cwd = WORKSPACE): string {
  let path = p.trim().replace(/^["']|["']$/g, '');
  const bash = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(path);
  if (bash) path = `${bash[1]!.toUpperCase()}:\\${bash[3] ?? ''}`;
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = join(homedir(), path.slice(1));
  path = path.replace(/\//g, '\\');
  return win32.normalize(isAbsolute(path) || win32.isAbsolute(path) ? path : resolve(cwd, path));
}

/** Whether `child` is `parent` or inside it (case-insensitive, like Windows). */
export function isInside(child: string, parent: string): boolean {
  const c = toWindowsPath(child).toLowerCase().replace(/\\+$/, '');
  const p = toWindowsPath(parent).toLowerCase().replace(/\\+$/, '');
  return c === p || c.startsWith(`${p}\\`);
}

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';
const PROGRAM_DIRS = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter((d): d is string =>
  Boolean(d),
);

export const isWindowsDir = (p: string) => isInside(p, SYSTEM_ROOT);
export const isProgramDir = (p: string) => PROGRAM_DIRS.some((d) => isInside(p, d));
/** Harv's database, backups and memory: only Harv's own code changes them, never a tool call. */
export const isHarvData = (p: string) => isInside(p, HARV_HOME) && !isInside(p, WORKSPACE);

export interface HarvSettings {
  /** Folders Harv may read but never change (the user's read-only list). */
  protectedPaths: string[];
}

/** Read on every check, so edits to ~/.harv/settings.json apply at once. */
export function loadSettings(): HarvSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return { protectedPaths: [] };
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as Partial<HarvSettings>;
    return { protectedPaths: Array.isArray(raw.protectedPaths) ? raw.protectedPaths.filter((p) => typeof p === 'string') : [] };
  } catch {
    return { protectedPaths: [] };
  }
}
