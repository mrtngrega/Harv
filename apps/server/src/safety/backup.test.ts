import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { keepBackup, listBackups, pruneBackups } from './backup.ts';
import { backupTargets } from './classify.ts';

const root = mkdtempSync(join(tmpdir(), 'harv-backups-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A backup folder named like the real ones, with `mb` megabytes in it. */
function backup(dir: string, at: Date, mb: number) {
  const path = join(dir, `${at.toISOString().replace(/[:.]/g, '-')}-abcd1234`);
  mkdirSync(join(path, 'files'), { recursive: true });
  writeFileSync(join(path, 'files', 'data'), Buffer.alloc(mb * 1024 * 1024));
  writeFileSync(join(path, 'manifest.json'), '{}');
  return path;
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-29T12:00:00Z');

describe('backup cleanup', () => {
  it('deletes backups older than the days kept, and keeps the rest', () => {
    const dir = join(root, 'age');
    const old = backup(dir, new Date(now - 40 * DAY), 1);
    const recent = backup(dir, new Date(now - 5 * DAY), 1);
    const done = pruneBackups(30, 1024 ** 3, now, dir);
    expect(done.removed).toEqual([old]);
    expect(done.freedBytes).toBeGreaterThan(1024 * 1024 - 1);
    expect(pruneBackups(30, 1024 ** 3, now, dir).removed).toEqual([]);
    expect(recent).toBeTruthy();
  });

  it('over the size cap, the oldest go first until it fits', () => {
    const dir = join(root, 'size');
    const a = backup(dir, new Date(now - 3 * DAY), 2);
    const b = backup(dir, new Date(now - 2 * DAY), 2);
    backup(dir, new Date(now - 1 * DAY), 2);
    const done = pruneBackups(30, 4.5 * 1024 * 1024, now, dir);
    expect(done.removed).toEqual([a]);
    expect(done.removed).not.toContain(b);
    expect(done.keptBytes).toBeLessThanOrEqual(4.5 * 1024 * 1024);
  });

  it('never deletes a kept backup, and it doesn’t count toward the cap', () => {
    const dir = join(root, 'kept');
    const radio = backup(dir, new Date(now - 90 * DAY), 3);
    const old = backup(dir, new Date(now - 40 * DAY), 1);
    const recent = backup(dir, new Date(now - 1 * DAY), 1);
    const name = radio.split(/[\\/]/).at(-1)!;
    expect(keepBackup(name, true, dir)).toBe(true);
    const done = pruneBackups(30, 2 * 1024 * 1024, now, dir);
    expect(done.removed).toEqual([old]);
    expect(existsSync(radio)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(listBackups(dir).map((b) => [b.name, b.kept])).toEqual([
      [recent.split(/[\\/]/).at(-1), false],
      [name, true],
    ]);
    // Given back to the cleanup, it goes on the next run.
    expect(keepBackup(name, false, dir)).toBe(true);
    expect(pruneBackups(30, 2 * 1024 * 1024, now, dir).removed).toEqual([radio]);
  });

  it('keep only takes a backup folder’s own name', () => {
    const dir = join(root, 'names');
    backup(dir, new Date(now), 0);
    expect(keepBackup('..', true, dir)).toBe(false);
    expect(keepBackup('../age', true, dir)).toBe(false);
    expect(keepBackup('missing', true, dir)).toBe(false);
  });

  it('does nothing when there are no backups yet', () => {
    expect(pruneBackups(30, 1, now, join(root, 'missing')).removed).toEqual([]);
  });
});

describe('what a command backs up', () => {
  // Outside the temp folder (folders there are scratch and never backed up).
  const work = mkdtempSync(join(process.cwd(), 'node_modules', '.harv-backup-test-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const folder = join(work, 'Projects');
  const scratch = join(root, 'scratch');
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(folder, 'site'), { recursive: true });
  const file = join(folder, 'notes.txt');
  writeFileSync(file, 'x');

  it('a folder only when the command deletes, moves or resets it as a whole', () => {
    expect(backupTargets([folder], `rm -rf "${folder}"`)).toEqual([folder]);
    expect(backupTargets([folder], `Remove-Item -Recurse "${folder}"`)).toEqual([folder]);
    expect(backupTargets([folder], `mv "${folder}" "${folder}-old"`)).toEqual([folder]);
  });

  it('not a folder it only looks into or makes something inside', () => {
    expect(backupTargets([folder], `cd "${folder}" && git status`)).toEqual([]);
    expect(backupTargets([folder], `New-Item -ItemType Directory -Path "${folder}" -Name kosice-weather`)).toEqual([]);
    expect(backupTargets([folder], `ls "${folder}"; echo hi > "${file}"`)).toEqual([]);
  });

  // These tests' own folders live in the temp folder, so "temp is scratch" is checked on a folder made for it.
  it('files are always backed up; a whole folder in the temp folder never', () => {
    expect(backupTargets([file], `echo hi > "${file}"`)).toEqual([file]);
    expect(backupTargets([scratch], `rm -rf "${scratch}"`)).toEqual([]);
  });

  it('file tools (Edit, Write) keep every file target', () => {
    expect(backupTargets([file])).toEqual([file]);
  });
});
