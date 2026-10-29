import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackupInfo } from '@harv/shared';
import { BACKUPS_DIR } from './paths.ts';

// Before Harv changes or deletes user files they're copied to
// ~/.harv/backups/<time>-<action>/, with a manifest that Undo uses to put
// everything back exactly where it was.

/** Bigger backups are skipped (the approval card says so) rather than filling the disk. */
const MAX_BACKUP_BYTES = 500 * 1024 * 1024;
const MAX_BACKUP_FILES = 5000;

export interface BackupEntry {
  original: string;
  /** Path of the copy inside the backup folder; absent when the original didn't exist yet. */
  copy?: string;
  isDir: boolean;
}

export interface Backup {
  dir: string;
  entries: BackupEntry[];
  /** Paths that were too big to back up. */
  skipped: string[];
}

/** Size and file count of a path, stopping early once it's over the limits. */
function measure(path: string): { bytes: number; files: number } {
  const total = { bytes: 0, files: 0 };
  const walk = (p: string) => {
    if (total.bytes > MAX_BACKUP_BYTES || total.files > MAX_BACKUP_FILES) return;
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
    } else {
      total.bytes += st.size;
      total.files += 1;
    }
  };
  walk(path);
  return total;
}

/** "C:\Users\me\a.txt" → "C\Users\me\a.txt", so every original keeps a unique place in the backup. */
const relativeCopy = (original: string) => original.replace(/^([a-zA-Z]):/, '$1').replace(/^[\\/]+/, '');

export function createBackup(actionId: string, paths: string[], now = new Date()): Backup {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = join(BACKUPS_DIR, `${stamp}-${actionId.slice(-8).replace(/[^\w-]/g, '')}`);
  const backup: Backup = { dir, entries: [], skipped: [] };
  let bytes = 0;
  let files = 0;
  for (const original of paths) {
    const st = statSync(original, { throwIfNoEntry: false });
    if (!st) {
      // A file that doesn't exist yet: Undo removes whatever gets created there.
      backup.entries.push({ original, isDir: false });
      continue;
    }
    const size = measure(original);
    if (bytes + size.bytes > MAX_BACKUP_BYTES || files + size.files > MAX_BACKUP_FILES) {
      backup.skipped.push(original);
      continue;
    }
    const copy = join(dir, 'files', relativeCopy(original));
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(original, copy, { recursive: true, preserveTimestamps: true });
    bytes += size.bytes;
    files += size.files;
    backup.entries.push({ original, copy, isDir: st.isDirectory() });
  }
  if (backup.entries.length > 0) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(backup, null, 2));
  }
  return backup;
}

/**
 * Puts the backed-up files back. Whatever is there now is first moved aside to
 * <backup>/replaced-<time>/, so an Undo can never lose anything either.
 */
export function restoreBackup(backup: Backup, now = new Date()): { restored: string[]; removed: string[] } {
  const aside = join(backup.dir, `replaced-${now.toISOString().replace(/[:.]/g, '-')}`);
  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of backup.entries) {
    if (existsSync(entry.original)) {
      const moved = join(aside, relativeCopy(entry.original));
      mkdirSync(dirname(moved), { recursive: true });
      try {
        renameSync(entry.original, moved);
      } catch {
        // Different drive: copy then remove.
        cpSync(entry.original, moved, { recursive: true });
        rmSync(entry.original, { recursive: true, force: true });
      }
    }
    if (entry.copy && existsSync(entry.copy)) {
      mkdirSync(dirname(entry.original), { recursive: true });
      cpSync(entry.copy, entry.original, { recursive: true, preserveTimestamps: true });
      restored.push(entry.original);
    } else {
      // It didn't exist before the action, so undoing it means taking it away (kept in the backup folder).
      removed.push(entry.original);
    }
  }
  return { restored, removed };
}

export function readBackup(dir: string): Backup | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Backup;
  } catch {
    return null;
  }
}

/** What a cleanup did: the backup folders it deleted, and how much is left. */
export interface PruneResult {
  removed: string[];
  freedBytes: number;
  keptBytes: number;
}

/** A backup folder's time, from its name (`2026-10-25T11-33-19-592Z-…`), else its modified time. */
function backupTime(dir: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(dir.split(/[\\/]/).at(-1) ?? '');
  if (m) return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/** A folder's size on disk (all of it). */
function folderBytes(path: string): number {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + folderBytes(join(path, name)), 0);
}

/** A backup marked "keep forever" (Settings › Safety › Backups) has this file; the cleanup never deletes it. */
const KEEP_FILE = 'keep';

const isKept = (dir: string) => existsSync(join(dir, KEEP_FILE));

/** Every backup, newest first. */
export function listBackups(root = BACKUPS_DIR): BackupInfo[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name), { throwIfNoEntry: false })?.isDirectory())
    .map((name) => {
      const dir = join(root, name);
      return {
        name,
        at: backupTime(dir),
        bytes: folderBytes(dir),
        originals: readBackup(dir)?.entries?.map((e) => e.original) ?? [],
        kept: isKept(dir),
      };
    })
    .sort((a, b) => b.at - a.at);
}

/** Marks a backup to keep forever, or gives it back to the cleanup. False when there's no such backup. */
export function keepBackup(name: string, keep: boolean, root = BACKUPS_DIR): boolean {
  // Only a plain folder name inside the backups folder, never a path somewhere else.
  if (!/^[\w-]+$/.test(name)) return false;
  const dir = join(root, name);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
  if (keep) writeFileSync(join(dir, KEEP_FILE), `Kept forever from Settings, ${new Date().toISOString()}`);
  else rmSync(join(dir, KEEP_FILE), { force: true });
  return true;
}

/**
 * Deletes backups older than `days`, then the oldest ones while all of them together are over
 * `maxBytes` (the user's wish: backups don't pile up forever). Their actions lose Undo; the log stays.
 * Kept backups are never deleted and don't count toward `maxBytes`.
 */
export function pruneBackups(days: number, maxBytes: number, now = Date.now(), root = BACKUPS_DIR): PruneResult {
  const result: PruneResult = { removed: [], freedBytes: 0, keptBytes: 0 };
  if (!existsSync(root)) return result;
  const all = readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() && !isKept(dir))
    .map((dir) => ({ dir, at: backupTime(dir), bytes: folderBytes(dir) }))
    .sort((a, b) => a.at - b.at);
  let total = all.reduce((sum, b) => sum + b.bytes, 0);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  for (const b of all) {
    if (b.at >= cutoff && total <= maxBytes) break;
    rmSync(b.dir, { recursive: true, force: true });
    result.removed.push(b.dir);
    result.freedBytes += b.bytes;
    total -= b.bytes;
  }
  result.keptBytes = total;
  return result;
}
