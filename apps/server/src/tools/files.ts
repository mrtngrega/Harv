import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { IS_WINDOWS, osPath } from '../platform.ts';
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

/** A clean absolute path of this OS (C:\… on Windows, /… on Linux), or null for anything else. */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return null;
  if (!IS_WINDOWS) {
    const normal = osPath.normalize(p.trim());
    return osPath.isAbsolute(normal) && !normal.includes('\0') ? normal.replace(/(.)\/+$/, '$1') : null;
  }
  const normal = osPath.normalize(p.trim().replace(/\//g, '\\'));
  if (!osPath.isAbsolute(normal) || !/^[a-z]:\\/i.test(normal)) return null;
  // "C:" alone means the current folder on that drive; the root is meant.
  return normal;
}

export function places(): FilePlaces {
  const home = homedir();
  const named = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'].map((name) => ({
    name,
    path: osPath.join(home, name),
  }));
  const drives: string[] = IS_WINDOWS ? [] : ['/'];
  for (let c = 67; IS_WINDOWS && c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) drives.push(root);
  }
  return { places: [{ name: 'Home', path: home }, ...named.filter((p) => existsSync(p.path))], drives };
}

export function listFolder(path: string): FolderListing {
  const entries: FileEntry[] = [];
  for (const dirent of readdirSync(path, { withFileTypes: true })) {
    const full = osPath.join(path, dirent.name);
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
  const parent = osPath.dirname(path);
  return { path, parent: parent === path ? null : parent, entries };
}

/** Opens a file with its default app, or a folder in Windows Explorer (the desktop's file manager on Linux). */
export function openWithDefault(path: string, reveal = false): void {
  if (!IS_WINDOWS) {
    spawn('xdg-open', [reveal ? osPath.dirname(path) : path], { detached: true, stdio: 'ignore' })
      .on('error', () => {})
      .unref();
    return;
  }
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
  const ext = osPath.extname(path).toLowerCase();
  const mime = MIME[ext];
  if (ext === '.svg') return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  if (mime?.startsWith('image/')) return { kind: 'image', mime };
  if (mime === 'application/pdf') return { kind: 'pdf', mime };
  if (mime) return { kind: 'media', mime };
  return { kind: 'text', mime: 'text/plain; charset=utf-8' };
}
