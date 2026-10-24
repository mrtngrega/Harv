import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  badName,
  copyItems,
  deleteForever,
  freeName,
  moveItems,
  newFile,
  newFolder,
  parseDf,
  properties,
  renameItem,
  saveUpload,
  search,
  trash,
} from './fileOps.ts';

const root = mkdtempSync(join(tmpdir(), 'harv-ops-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(root, `t${n++}`);
  mkdirSync(dir);
  return dir;
};

const onWindows = process.platform === 'win32';

describe('names like Windows', () => {
  it.runIf(!onWindows)('allows everything but / on Linux', () => {
    expect(badName('a:b?.txt')).toBeNull();
    expect(badName('a/b')).toMatch(/\//);
    expect(badName('..')).toMatch(/isn’t/);
    expect(badName('  ')).toMatch(/empty/);
  });

  it.runIf(onWindows)('rejects what Windows rejects', () => {
    expect(badName('report.txt')).toBeNull();
    expect(badName('a:b')).toMatch(/characters/);
    expect(badName('notes.')).toMatch(/end/);
    expect(badName('CON')).toMatch(/reserved/);
    expect(badName('nul.txt')).toMatch(/reserved/);
    expect(badName('  ')).toMatch(/empty/);
  });

  it('numbers new items and names copies like Explorer', () => {
    const dir = fresh();
    expect(freeName(dir, 'New folder', true)).toBe('New folder');
    mkdirSync(join(dir, 'New folder'));
    expect(freeName(dir, 'New folder', true)).toBe('New folder (2)');
    writeFileSync(join(dir, 'a.txt'), '');
    expect(freeName(dir, 'a.txt', false, true)).toBe('a - Copy.txt');
    writeFileSync(join(dir, 'a - Copy.txt'), '');
    expect(freeName(dir, 'a.txt', false, true)).toBe('a - Copy (2).txt');
  });
});

describe('file operations', () => {
  it('makes new folders and text files', () => {
    const dir = fresh();
    expect(newFolder(dir)).toBe(join(dir, 'New folder'));
    expect(newFolder(dir)).toBe(join(dir, 'New folder (2)'));
    expect(newFile(dir)).toBe(join(dir, 'New Text Document.txt'));
  });

  it('renames, refusing clashes but allowing a case change', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'a.txt'), 'x');
    writeFileSync(join(dir, 'b.txt'), 'y');
    expect(() => renameItem(join(dir, 'a.txt'), 'b.txt')).toThrow(/already/);
    expect(renameItem(join(dir, 'a.txt'), 'A.txt')).toBe(join(dir, 'A.txt'));
    expect(() => renameItem(join(dir, 'b.txt'), onWindows ? 'bad|name' : 'bad/name')).toThrow(onWindows ? /characters/ : /\//);
  });

  it('copies into the same folder as "- Copy" and elsewhere keeping both', () => {
    const dir = fresh();
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(dir, 'a.txt'), 'hello');
    expect(copyItems([join(dir, 'a.txt')], dir).paths).toEqual([join(dir, 'a - Copy.txt')]);
    expect(copyItems([join(dir, 'a.txt')], sub).paths).toEqual([join(sub, 'a.txt')]);
    expect(copyItems([join(dir, 'a.txt')], sub).paths).toEqual([join(sub, 'a (2).txt')]);
    expect(readFileSync(join(sub, 'a (2).txt'), 'utf8')).toBe('hello');
  });

  it('moves, and never puts a folder inside itself', () => {
    const dir = fresh();
    const box = join(dir, 'box');
    mkdirSync(join(box, 'inner'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), '');
    expect(moveItems([join(dir, 'a.txt')], box).paths).toEqual([join(box, 'a.txt')]);
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
    expect(moveItems([box], join(box, 'inner')).errors[0]).toMatch(/into itself/);
    expect(copyItems([box], box).errors[0]).toMatch(/into itself/);
  });

  it('deletes for good, saves dropped files, searches and counts folders', () => {
    const dir = fresh();
    mkdirSync(join(dir, 'deep', 'er'), { recursive: true });
    writeFileSync(join(dir, 'deep', 'er', 'Report-2026.pdf'), '12345');
    writeFileSync(join(dir, 'report.txt'), '12');
    expect(
      search(dir, 'report')
        .results.map((r) => r.name)
        .sort(),
    ).toEqual(['Report-2026.pdf', 'report.txt']);
    expect(saveUpload(dir, 'report.txt', Buffer.from('new'))).toBe(join(dir, 'report (2).txt'));
    const props = properties(dir);
    expect(props).toMatchObject({ dir: true, files: 3, folders: 2, size: 10 });
    expect(deleteForever([join(dir, 'deep')]).paths).toEqual([join(dir, 'deep')]);
    expect(existsSync(join(dir, 'deep'))).toBe(false);
  });
});

describe('Linux: the Trash and the drives', () => {
  it('moves items to the freedesktop Trash with a note of where they were', () => {
    vi.stubEnv('XDG_DATA_HOME', '');
    const home = fresh();
    const file = join(home, 'old notes.txt');
    writeFileSync(file, 'x');
    expect(trash([file], home)).toEqual({ paths: [file], errors: [] });
    expect(existsSync(file)).toBe(false);
    const bin = join(home, '.local', 'share', 'Trash');
    expect(readFileSync(join(bin, 'files', 'old notes.txt'), 'utf8')).toBe('x');
    const info = readFileSync(join(bin, 'info', 'old notes.txt.trashinfo'), 'utf8');
    expect(info).toMatch(/^\[Trash Info\]\nPath=.*old%20notes\.txt\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
    // A second item with the same name gets its own.
    writeFileSync(file, 'y');
    trash([file], home);
    expect(readFileSync(join(bin, 'files', 'old notes (2).txt'), 'utf8')).toBe('y');
    vi.unstubAllEnvs();
  });

  it('lists the root, home and plugged-in drives from df, nothing else', () => {
    const out = [
      'Type     Mounted on                       1024-blocks      Available',
      'btrfs    /                                  243000000      183000000',
      'tmpfs    /tmp                                 8000000        7900000',
      'ext4     /boot                                 1000000         600000',
      'vfat     /boot/efi                              600000         580000',
      'btrfs    /home                              243000000      183000000',
      'exfat    /run/media/me/USB STICK             30000000       20000000',
      'squashfs /var/lib/snapd/snap/core/1               1000              0',
    ].join('\n');
    expect(parseDf(out, '/home/me')).toEqual([
      { path: '/', label: 'File System', total: 243000000 * 1024, free: 183000000 * 1024 },
      { path: '/home', label: 'Home', total: 243000000 * 1024, free: 183000000 * 1024 },
      { path: '/run/media/me/USB STICK', label: 'USB STICK', total: 30000000 * 1024, free: 20000000 * 1024 },
    ]);
  });
});
