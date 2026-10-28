import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanPath, kdePlaces, listFolder, previewType, suggestPaths } from './files.ts';

const dir = mkdtempSync(join(tmpdir(), 'harv-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('file explorer', () => {
  it.runIf(process.platform !== 'win32')('accepts only absolute Linux paths', () => {
    expect(cleanPath('/home/me/../me/Docs/')).toBe('/home/me/Docs');
    expect(cleanPath('/')).toBe('/');
    expect(cleanPath('relative/path')).toBeNull();
    expect(cleanPath(42)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('accepts only absolute Windows paths', () => {
    expect(cleanPath('C:/Users/me/../me/Docs')).toBe('C:\\Users\\me\\Docs');
    expect(cleanPath('relative\\path')).toBeNull();
    expect(cleanPath('\\\\server\\share')).toBeNull();
    expect(cleanPath(42)).toBeNull();
  });

  it('lists folders first, then files by name, marking hidden ones', () => {
    mkdirSync(join(dir, 'b-folder'));
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, 'file10.txt'), '');
    writeFileSync(join(dir, 'file9.txt'), '');
    writeFileSync(join(dir, '.secret'), '');
    const listing = listFolder(dir);
    expect(listing.entries.map((e) => e.name)).toEqual(['b-folder', '.secret', 'a.txt', 'file9.txt', 'file10.txt']);
    expect(listing.entries.find((e) => e.name === 'a.txt')).toMatchObject({ dir: false, size: 5, hidden: false });
    expect(listing.entries.find((e) => e.name === '.secret')?.hidden).toBe(true);
    expect(listing.parent).toBe(join(dir, '..'));
  });

  it.runIf(process.platform !== 'win32')("shows Dolphin's places, in its order, with the Trash", () => {
    mkdirSync(join(dir, 'Code'));
    mkdirSync(join(dir, 'Downloads'));
    const xml = `<xbel>
      <bookmark href="file://${dir}"><title>Home</title></bookmark>
      <bookmark href="file://${dir}/Downloads"><title>Downloads</title></bookmark>
      <bookmark href="file://${dir}/Gone"><title>Gone</title></bookmark>
      <bookmark href="file://${dir}/Code"><title>Code &amp; stuff</title><info><metadata><IsHidden>true</IsHidden></metadata></info></bookmark>
      <bookmark href="remote:/"><title>Network</title></bookmark>
      <bookmark href="trash:/"><title>Trash</title></bookmark>
    </xbel>`;
    const kde = kdePlaces(xml, dir)!;
    expect(kde.places).toEqual([
      { name: 'Home', path: dir },
      { name: 'Downloads', path: `${dir}/Downloads` },
    ]);
    expect(kde.trash).toMatch(/Trash\/files$/);
    expect(kdePlaces('<xbel></xbel>', dir)).toBeNull();
  });

  it('previews SVG and HTML as text, never rendered', () => {
    expect(previewType('x.svg').kind).toBe('text');
    expect(previewType('x.html')).toEqual({ kind: 'text', mime: 'text/plain; charset=utf-8' });
    expect(previewType('x.PNG').kind).toBe('image');
    expect(previewType('x.pdf').kind).toBe('pdf');
  });
});

describe('@ path suggestions', () => {
  const root = mkdtempSync(join(tmpdir(), 'harv-at-'));
  mkdirSync(join(root, 'Reports'));
  mkdirSync(join(root, 'recipes'));
  writeFileSync(join(root, 'readme.txt'), 'hi');
  writeFileSync(join(root, 'old-report.txt'), 'x');
  writeFileSync(join(root, '.hidden'), 'x');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists the typed folder: names that start with the last part first (folders first), then names that contain it', () => {
    const names = suggestPaths(join(root, 're')).map((s) => s.name);
    expect(names.slice(0, 2).sort()).toEqual(['Reports', 'recipes'].sort());
    expect(names).toContain('readme.txt');
    expect(names.indexOf('old-report.txt')).toBeGreaterThan(names.indexOf('readme.txt'));
  });

  it('lists a whole folder after a separator, without hidden names unless asked', () => {
    const all = suggestPaths(root + sep);
    expect(all.map((s) => s.name)).not.toContain('.hidden');
    expect(all.find((s) => s.name === 'Reports')).toMatchObject({ folder: true, path: join(root, 'Reports') });
    expect(suggestPaths(join(root, '.h')).map((s) => s.name)).toEqual(['.hidden']);
  });

  it('suggests the usual places for an empty @, and nothing for a folder that isn’t there', () => {
    expect(suggestPaths('').length).toBeGreaterThan(0);
    expect(suggestPaths(join(root, 'nope', 'x'))).toEqual([]);
  });
});
