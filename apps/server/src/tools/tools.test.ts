import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanPath, listFolder, previewType } from './files.ts';

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

  it('previews SVG and HTML as text, never rendered', () => {
    expect(previewType('x.svg').kind).toBe('text');
    expect(previewType('x.html')).toEqual({ kind: 'text', mime: 'text/plain; charset=utf-8' });
    expect(previewType('x.PNG').kind).toBe('image');
    expect(previewType('x.pdf').kind).toBe('pdf');
  });
});
