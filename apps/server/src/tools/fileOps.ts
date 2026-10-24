import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import type { DriveInfo, FileEntry, FileProps } from '@harv/shared';
import { IS_WINDOWS, isUserMount, osPath, pathKey } from '../platform.ts';

// What the file explorer tab does to files, the way Windows Explorer does it.
// These are the user's own clicks, so they don't pass Harv's safety gate; Delete
// goes to the Recycle Bin like Explorer (the Trash on Linux), and only Shift+Delete
// removes for good.

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why the OS wouldn't accept this as a file name, or null if it's fine. */
export function badName(name: string): string | null {
  if (!name.trim()) return 'A name can’t be empty.';
  if (!IS_WINDOWS) {
    if (name.includes('/') || name.includes('\0')) return 'A name can’t contain a /.';
    if (name === '.' || name === '..') return `“${name}” isn’t a file name.`;
    return Buffer.byteLength(name) > 255 ? 'That name is too long.' : null;
  }
  if (/[\\/:*?"<>|]/.test(name)) return 'A name can’t contain any of these characters: \\ / : * ? " < > |';
  if (/[. ]$/.test(name)) return 'A name can’t end with a space or a dot.';
  if (RESERVED.test(name)) return `“${name}” is reserved by Windows.`;
  if (name.length > 255) return 'That name is too long.';
  return null;
}

const splitExt = (name: string, dir: boolean) => {
  const ext = dir ? '' : osPath.extname(name);
  return { stem: ext && ext !== name ? name.slice(0, -ext.length) : name, ext: ext === name ? '' : ext };
};

/** A free name in `dir`: "New folder", "New folder (2)"… or, for copies, "a - Copy.txt", "a - Copy (2).txt". */
export function freeName(dir: string, name: string, isDir: boolean, copy = false): string {
  const { stem, ext } = splitExt(name, isDir);
  const taken = new Set(existsSync(dir) ? readdirSync(dir).map((n) => pathKey(n)) : []);
  const candidates = copy
    ? (n: number) => (n === 1 ? `${stem} - Copy${ext}` : `${stem} - Copy (${n})${ext}`)
    : (n: number) => (n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`);
  for (let n = 1; ; n++) {
    const candidate = candidates(n);
    if (!taken.has(pathKey(candidate))) return candidate;
  }
}

const isInsideOrSame = (child: string, parent: string) => {
  const rel = osPath.relative(pathKey(parent), pathKey(child));
  return rel === '' || (!rel.startsWith('..') && !osPath.isAbsolute(rel));
};

export function newFolder(dir: string, name = 'New folder'): string {
  const path = osPath.join(dir, freeName(dir, name, true));
  mkdirSync(path);
  return path;
}

export function newFile(dir: string, name = 'New Text Document.txt'): string {
  const path = osPath.join(dir, freeName(dir, name, false));
  writeFileSync(path, '', { flag: 'wx' });
  return path;
}

export function renameItem(path: string, name: string): string {
  const problem = badName(name);
  if (problem) throw new Error(problem);
  const target = osPath.join(osPath.dirname(path), name);
  // Changing only the letter case is a rename of the same file.
  if (pathKey(target) !== pathKey(path) && existsSync(target)) throw new Error(`There's already a file called “${name}” here.`);
  renameSync(path, target);
  return target;
}

export interface OpResult {
  /** Where the items ended up. */
  paths: string[];
  errors: string[];
}

export function copyItems(paths: string[], dest: string): OpResult {
  const out: OpResult = { paths: [], errors: [] };
  for (const src of paths) {
    try {
      const isDir = statSync(src).isDirectory();
      if (isDir && isInsideOrSame(dest, src)) throw new Error('can’t copy a folder into itself');
      const sameFolder = pathKey(osPath.dirname(src)) === pathKey(dest);
      const name = freeName(dest, osPath.basename(src), isDir, sameFolder);
      const target = osPath.join(dest, name);
      cpSync(src, target, { recursive: true, errorOnExist: true, force: false });
      out.paths.push(target);
    } catch (err) {
      out.errors.push(`${osPath.basename(src)}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function moveItems(paths: string[], dest: string): OpResult {
  const out: OpResult = { paths: [], errors: [] };
  for (const src of paths) {
    try {
      if (pathKey(osPath.dirname(src)) === pathKey(dest)) {
        out.paths.push(src);
        continue;
      }
      const isDir = statSync(src).isDirectory();
      if (isDir && isInsideOrSame(dest, src)) throw new Error('can’t move a folder into itself');
      const target = osPath.join(dest, freeName(dest, osPath.basename(src), isDir));
      try {
        renameSync(src, target);
      } catch (err) {
        // Another drive: copy, then remove the original.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        cpSync(src, target, { recursive: true, errorOnExist: true, force: false });
        rmSync(src, { recursive: true, force: true });
      }
      out.paths.push(target);
    } catch (err) {
      out.errors.push(`${osPath.basename(src)}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Sends files and folders to the Recycle Bin, like Delete in Explorer (restorable from there). */
export function recycle(paths: string[]): Promise<OpResult> {
  if (!IS_WINDOWS) return Promise.resolve(trash(paths));
  // The paths travel as base64 JSON in an environment variable, so no quoting can go wrong.
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:HARV_PATHS)) | ConvertFrom-Json',
    'foreach ($p in $paths) {',
    '  try {',
    "    if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    "    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    '  } catch { Write-Output ("ERR " + $p + ": " + $_.Exception.Message) }',
    '}',
  ].join('\n');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, HARV_PATHS: Buffer.from(JSON.stringify(paths)).toString('base64') },
      windowsHide: true,
    });
    let output = '';
    ps.stdout.on('data', (d: Buffer) => (output += d.toString()));
    ps.stderr.on('data', (d: Buffer) => (output += d.toString()));
    ps.on('close', () => {
      const errors = output
        .split(/\r?\n/)
        .filter((l) => l.startsWith('ERR '))
        .map((l) => l.slice(4));
      const left = paths.filter((p) => existsSync(p));
      if (!errors.length && left.length) errors.push(`Couldn’t delete ${left.map((p) => osPath.basename(p)).join(', ')}.`);
      resolve({ paths: paths.filter((p) => !existsSync(p)), errors });
    });
  });
}

/**
 * Linux: the desktop's Trash (the freedesktop.org layout that Dolphin and the other file
 * managers share, so items can be restored from there). Only the home Trash: a file on
 * another drive can't be moved there, and says so.
 */
export function trash(paths: string[], home = homedir()): OpResult {
  const out: OpResult = { paths: [], errors: [] };
  const base = osPath.join(process.env.XDG_DATA_HOME || osPath.join(home, '.local', 'share'), 'Trash');
  const files = osPath.join(base, 'files');
  const info = osPath.join(base, 'info');
  mkdirSync(files, { recursive: true });
  mkdirSync(info, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const src of paths) {
    try {
      let name = freeName(files, osPath.basename(src), statSync(src).isDirectory());
      for (let n = 2; existsSync(osPath.join(info, `${name}.trashinfo`)); n++) name = `${osPath.basename(src)}.${n}`;
      const d = new Date();
      const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const location = src.split('/').map(encodeURIComponent).join('/');
      writeFileSync(osPath.join(info, `${name}.trashinfo`), `[Trash Info]\nPath=${location}\nDeletionDate=${when}\n`, { flag: 'wx' });
      try {
        renameSync(src, osPath.join(files, name));
      } catch (err) {
        rmSync(osPath.join(info, `${name}.trashinfo`), { force: true });
        if ((err as NodeJS.ErrnoException).code === 'EXDEV')
          throw new Error('it’s on another drive, which has no Trash here (Shift+Delete removes it for good)', { cause: err });
        throw err;
      }
      out.paths.push(src);
    } catch (err) {
      out.errors.push(`${osPath.basename(src)}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Shift+Delete: gone for good, no Recycle Bin. */
export function deleteForever(paths: string[]): OpResult {
  const out: OpResult = { paths: [], errors: [] };
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
      out.paths.push(p);
    } catch (err) {
      out.errors.push(`${osPath.basename(p)}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** A file dropped in from Windows (or the dashboard), saved without overwriting anything. */
export function saveUpload(dir: string, name: string, data: Buffer): string {
  const clean = osPath.basename(name).replace(/[\\/:*?"<>|]/g, '_') || 'file';
  const path = osPath.join(dir, freeName(dir, clean, false));
  writeFileSync(path, data, { flag: 'wx' });
  return path;
}

const entry = (dir: string, d: Dirent): FileEntry => {
  const path = osPath.join(dir, d.name);
  try {
    const st = statSync(path);
    return {
      name: d.name,
      path,
      dir: st.isDirectory(),
      size: st.isDirectory() ? undefined : st.size,
      mtime: st.mtimeMs,
      hidden: d.name.startsWith('.'),
    };
  } catch {
    return { name: d.name, path, dir: d.isDirectory(), hidden: d.name.startsWith('.') };
  }
};

/** Search by name below `dir`, like Explorer's search box (stops at 500 results or 8 seconds). */
export function search(dir: string, query: string, limit = 500, timeMs = 8000): { results: FileEntry[]; complete: boolean } {
  const q = query.trim().toLowerCase();
  const results: FileEntry[] = [];
  if (!q) return { results, complete: true };
  const deadline = Date.now() + timeMs;
  const queue = [dir];
  while (queue.length) {
    if (results.length >= limit || Date.now() > deadline) return { results, complete: false };
    const current = queue.shift()!;
    let items: Dirent[];
    try {
      items = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of items) {
      if (d.name.toLowerCase().includes(q)) results.push(entry(current, d));
      if (d.isDirectory() && !d.isSymbolicLink()) queue.push(osPath.join(current, d.name));
    }
  }
  return { results, complete: true };
}

/** The Properties dialog: dates, size, and for folders what's inside (counted up to 20k items). */
export function properties(path: string): FileProps {
  const st = statSync(path);
  const props: FileProps = {
    path,
    name: osPath.basename(path) || path,
    dir: st.isDirectory(),
    size: st.size,
    created: st.birthtimeMs,
    modified: st.mtimeMs,
    accessed: st.atimeMs,
    readOnly: (st.mode & 0o200) === 0,
  };
  if (!props.dir) return props;
  let size = 0;
  let files = 0;
  let folders = 0;
  let seen = 0;
  const queue = [path];
  while (queue.length && seen < 20_000) {
    const current = queue.shift()!;
    let items: Dirent[];
    try {
      items = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of items) {
      seen++;
      const full = osPath.join(current, d.name);
      if (d.isDirectory() && !d.isSymbolicLink()) {
        folders++;
        queue.push(full);
      } else {
        files++;
        try {
          size += statSync(full).size;
        } catch {
          // Locked files don't count.
        }
      }
    }
  }
  return { ...props, size, files, folders, partial: seen >= 20_000 };
}

let drivesCache: { at: number; drives: DriveInfo[] } | null = null;

/** This PC: drives with their labels and space (PowerShell's Get-Volume, cached for 30 s). */
export function drives(): Promise<DriveInfo[]> {
  if (drivesCache && Date.now() - drivesCache.at < 30_000) return Promise.resolve(drivesCache.drives);
  if (!IS_WINDOWS) return linuxDrives();
  // UTF-8 out, or labels with accents ("Hračky") arrive garbled.
  const script =
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, Size, SizeRemaining, DriveType | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d: Buffer) => (out += d.toString()));
    ps.on('close', () => {
      let list: DriveInfo[];
      try {
        const raw = JSON.parse(out || '[]') as Record<string, unknown> | Record<string, unknown>[];
        list = (Array.isArray(raw) ? raw : [raw])
          .map((v) => ({
            path: `${String(v.DriveLetter)}:\\`,
            label: String(v.FileSystemLabel ?? '') || (v.DriveType === 'Removable' ? 'USB Drive' : 'Local Disk'),
            total: Number(v.Size) || 0,
            free: Number(v.SizeRemaining) || 0,
          }))
          .sort((a, b) => a.path.localeCompare(b.path));
      } catch {
        list = [];
      }
      if (list.length === 0) {
        // Fall back to just the drive letters.
        for (let c = 67; c <= 90; c++) {
          const root = `${String.fromCharCode(c)}:\\`;
          if (existsSync(root)) list.push({ path: root, label: 'Local Disk', total: 0, free: 0 });
        }
      }
      drivesCache = { at: Date.now(), drives: list };
      resolve(list);
    });
  });
}

/** File systems that hold the user's files (not memory, snapshots or system views). */
const REAL_FS = /^(ext[234]|btrfs|xfs|f2fs|zfs|vfat|exfat|ntfs3?|fuseblk|fuse\.\w+|nfs4?|cifs|smb3)$/;

/** Linux: the root, a separate /home, and drives mounted under /run/media, /media or /mnt (from df). */
export function parseDf(out: string, home = homedir()): DriveInfo[] {
  const list: DriveInfo[] = [];
  for (const line of out.trim().split('\n').slice(1)) {
    // df escapes nothing, so a mount point with spaces is everything before the three numbers.
    const m = /^(\S+)\s+(.+?)\s+(\d+)\s+(\d+)$/.exec(line.trim());
    if (!m) continue;
    const [, fstype, target, size, avail] = m as unknown as [string, string, string, string, string];
    if (!REAL_FS.test(fstype) || /^\/(boot|efi)(\/|$)/.test(target) || target.startsWith('/var/lib/')) continue;
    if (!isUserMount(target, home)) continue;
    if (list.some((d) => d.path === target)) continue;
    const label = target === '/' ? 'File System' : target === '/home' || target === home ? 'Home' : osPath.basename(target);
    list.push({ path: target, label, total: Number(size) * 1024, free: Number(avail) * 1024 });
  }
  return list;
}

function linuxDrives(): Promise<DriveInfo[]> {
  return new Promise((resolve) => {
    const df = spawn('df', ['-k', '--output=fstype,target,size,avail']);
    let out = '';
    df.stdout.on('data', (d: Buffer) => (out += d.toString()));
    df.on('error', () => resolve([{ path: '/', label: 'File System', total: 0, free: 0 }]));
    df.on('close', () => {
      const list = parseDf(out);
      if (!list.length) list.push({ path: '/', label: 'File System', total: 0, free: 0 });
      drivesCache = { at: Date.now(), drives: list };
      resolve(list);
    });
  });
}

const filesIn = (dir: string, keep: (d: Dirent) => boolean): FileEntry[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && keep(d))
      .map((d) => entry(dir, d));
  } catch {
    return [];
  }
};

/**
 * Recent files, from Windows' own Recent folder (shortcuts; opening one opens its file).
 * When Windows keeps no recent items (and on Linux), the newest files on the Desktop and in Downloads and Documents.
 */
export function recentFiles(limit = 20): FileEntry[] {
  const home = homedir();
  const newest = (list: FileEntry[]) => list.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(0, limit);
  if (IS_WINDOWS) {
    const shortcuts = filesIn(osPath.join(home, 'AppData\\Roaming\\Microsoft\\Windows\\Recent'), (d) =>
      d.name.toLowerCase().endsWith('.lnk'),
    );
    if (shortcuts.length) return newest(shortcuts);
  }
  const visible = (d: Dirent) => !d.name.startsWith('.') && !/^(desktop\.ini|thumbs\.db)$/i.test(d.name);
  return newest(['Desktop', 'Downloads', 'Documents'].flatMap((name) => filesIn(osPath.join(home, name), visible)));
}
