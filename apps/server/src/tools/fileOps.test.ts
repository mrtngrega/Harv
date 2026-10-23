import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  badName,
  copyItems,
  deleteForever,
  freeName,
  moveItems,
  newFile,
  newFolder,
  properties,
  renameItem,
  saveUpload,
  search,
} from './fileOps.ts';

const root = mkdtempSync(join(tmpdir(), 'harv-ops-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(root, `t${n++}`);
  mkdirSync(dir);
  return dir;
};

describe('names like Windows', () => {
  it('rejects what Windows rejects', () => {
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
    expect(() => renameItem(join(dir, 'b.txt'), 'bad|name')).toThrow(/characters/);
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
