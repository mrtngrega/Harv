import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

// Files that follow the user between devices (docs/PLAN.md §6m "Files"): attachments and
// what Harv makes in its workspace, the background photo, and Claude Code's memory notes
// of each project. Plain helpers here; the engine decides what goes out and comes in.

/** Bigger files stay on their device: git keeps every version forever. */
export const MAX_SYNC_FILE_BYTES = 10 * 1024 * 1024;
/** A runaway folder can't flood the repo: this many files per folder at most. */
const MAX_FILES = 5000;
/** Folders that are rebuilt, not made: installs, caches, virtual environments, git internals. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache', 'startup-backup']);

export const hashBytes = (data: Buffer | string) => createHash('sha256').update(data).digest('hex').slice(0, 32);

/**
 * Claude Code's memory folder for a project: ~/.claude/projects/<folder>/memory, where
 * <folder> is the project's path with every character that isn't a letter or digit turned
 * into "-" (so it differs between Windows and Linux, and sync matches projects by name).
 */
export function claudeMemoryDir(projectPath: string, home = homedir()): string {
  return join(home, '.claude', 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}

/** A path from the other device: relative, forward slashes, no `..`, no odd names. */
export function safeRelPath(rel: string): boolean {
  if (rel.length === 0 || rel.length > 400 || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.includes('\\')) return false;
  return rel
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !/[<>:"|?*]/.test(part) &&
        ![...part].some((c) => c.charCodeAt(0) < 32) &&
        !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
    );
}

export interface FileState {
  hash: string;
  size: number;
  mtime: number;
}

/**
 * The files under `dir` that can travel, by path relative to it (forward slashes). `known`
 * is the last scan: a file whose size and time haven't changed isn't read again. `shallow`: only
 * the folder's own files (~/.harv itself, for the background photo).
 */
export function scanFolder(
  dir: string,
  accept: (rel: string) => boolean,
  known: Record<string, FileState>,
  shallow = false,
): Record<string, FileState> {
  const out: Record<string, FileState> = {};
  if (!existsSync(dir)) return out;
  let count = 0;
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (count >= MAX_FILES) return;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!shallow && !SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(dir, full).split(sep).join('/');
      if (!safeRelPath(rel) || !accept(rel)) continue;
      const st = statSync(full);
      if (st.size > MAX_SYNC_FILE_BYTES) continue;
      count++;
      const before = known[rel];
      out[rel] =
        before && before.size === st.size && before.mtime === st.mtimeMs
          ? before
          : { hash: hashBytes(readFileSync(full)), size: st.size, mtime: st.mtimeMs };
    }
  };
  walk(dir);
  return out;
}

/** Both sides changed a text file: the newer one, plus the other's lines it lacks (no note is lost). */
export function mergeLines(winner: string, loser: string): string {
  const have = new Set(winner.split(/\r?\n/));
  const extra = loser.split(/\r?\n/).filter((l) => l.trim() && !have.has(l));
  return extra.length ? `${winner.replace(/\s*$/, '')}\n${extra.join('\n')}\n` : winner;
}
