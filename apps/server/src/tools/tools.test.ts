import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanPath, listFolder, previewType } from './files.ts';
import { ToolRegistry } from './registry.ts';

const dir = mkdtempSync(join(tmpdir(), 'harv-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('file explorer', () => {
  it('accepts only absolute Windows paths', () => {
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

describe('tool tabs', () => {
  it('numbers repeated titles and closes the backend with the tab', async () => {
    const backend = { open: vi.fn(), close: vi.fn() };
    const onChange = vi.fn();
    const reg = new ToolRegistry({ terminal: backend }, onChange);
    await reg.open('t1', 'terminal');
    await reg.open('t2', 'terminal');
    await reg.open('f1', 'files');
    expect(reg.list().map((t) => t.title)).toEqual(['PowerShell', 'PowerShell 2', 'Files']);
    reg.close('t1');
    expect(backend.close).toHaveBeenCalledWith('t1');
    await expect(reg.open('bad id!', 'files')).rejects.toThrow();
  });

  it('drops a tab whose backend fails to start', async () => {
    const reg = new ToolRegistry({ terminal: { open: () => Promise.reject(new Error('no shell')), close: vi.fn() } }, vi.fn());
    await expect(reg.open('b1', 'terminal')).rejects.toThrow('no shell');
    expect(reg.has('b1')).toBe(false);
  });
});
