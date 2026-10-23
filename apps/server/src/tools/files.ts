import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import type { FileEntry, FilePlaces, FolderListing } from '@harv/shared';

// The file explorer tab. These are the user's own clicks in their own dashboard
// (the server refuses other origins), so they don't pass Harv's safety gate.
// Harv itself reads files through its Read tool and changes them through the gate.

/** Names Windows hides that would only clutter the list. */
const SYSTEM_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'desktop.ini',
  'thumbs.db',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log.tmp',
]);

/** A clean absolute Windows path, or null for anything else. */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return null;
  const normal = win32.normalize(p.trim().replace(/\//g, '\\'));
  if (!win32.isAbsolute(normal) || !/^[a-z]:\\/i.test(normal)) return null;
  // "C:" alone means the current folder on that drive; the root is meant.
  return normal;
}

export function places(): FilePlaces {
  const home = homedir();
  const named = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'].map((name) => ({
    name,
    path: win32.join(home, name),
  }));
  const drives: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) drives.push(root);
  }
  return { places: [{ name: 'Home', path: home }, ...named.filter((p) => existsSync(p.path))], drives };
}

export function listFolder(path: string): FolderListing {
  const entries: FileEntry[] = [];
  for (const dirent of readdirSync(path, { withFileTypes: true })) {
    const full = win32.join(path, dirent.name);
    let dir = dirent.isDirectory();
    let size: number | undefined;
    let mtime: number | undefined;
    try {
      const st = statSync(full);
      dir = st.isDirectory();
      size = dir ? undefined : st.size;
      mtime = st.mtimeMs;
    } catch {
      // Locked or no permission: list it without details.
    }
    const lower = dirent.name.toLowerCase();
    entries.push({ name: dirent.name, path: full, dir, size, mtime, hidden: dirent.name.startsWith('.') || SYSTEM_NAMES.has(lower) });
  }
  // Folders first, then by name like Explorer.
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = win32.dirname(path);
  return { path, parent: parent === path ? null : parent, entries };
}

/** Opens a file with its default app, or a folder in Windows Explorer. */
export function openWithDefault(path: string, reveal = false): void {
  const args = reveal ? [`/select,${path}`] : [path];
  spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** What the preview should treat the file as. SVG is sent as text, never rendered, since it can carry scripts. */
export function previewType(path: string): { kind: 'image' | 'pdf' | 'media' | 'text' | 'none'; mime: string } {
  const ext = win32.extname(path).toLowerCase();
  const mime = MIME[ext];
  if (ext === '.svg') return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  if (mime?.startsWith('image/')) return { kind: 'image', mime };
  if (mime === 'application/pdf') return { kind: 'pdf', mime };
  if (mime) return { kind: 'media', mime };
  return { kind: 'text', mime: 'text/plain; charset=utf-8' };
}
