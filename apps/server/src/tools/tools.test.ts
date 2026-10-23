import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { classifyBrowser } from '../safety/browser.ts';
import { isWebUrl, toUrl } from './browser.ts';
import { setBrowserRefs, type BrowserElement } from './browserRefs.ts';
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

describe('browser address bar', () => {
  it('turns addresses into URLs and anything else into a search', () => {
    expect(toUrl('example.com')).toBe('https://example.com');
    expect(toUrl('https://x.org/a?b=1')).toBe('https://x.org/a?b=1');
    expect(toUrl('localhost:5173')).toBe('https://localhost:5173');
    expect(toUrl('best gpu 2026')).toBe('https://www.google.com/search?q=best%20gpu%202026');
  });

  it('opens only web pages', () => {
    expect(isWebUrl('https://a.com')).toBe(true);
    expect(isWebUrl('file:///C:/Windows')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('chrome://settings')).toBe(false);
  });
});

describe('browser safety', () => {
  const el = (ref: number, extra: Partial<BrowserElement>): BrowserElement => ({
    ref,
    tag: 'button',
    role: '',
    text: '',
    type: '',
    name: '',
    formSubmit: '',
    ...extra,
  });
  setBrowserRefs('https://shop.example/cart', [
    el(1, { tag: 'a', text: 'Laptops' }),
    el(2, { text: 'Place order' }),
    el(3, { tag: 'input', type: 'password', name: 'pass' }),
    el(4, { tag: 'input', type: 'search', name: 'q' }),
    el(5, { tag: 'textarea', text: 'Write a comment', formSubmit: 'Post' }),
    el(6, { tag: 'input', type: 'text', name: 'cc-number' }),
  ]);
  const tier = (tool: string, input: Record<string, unknown>) => classifyBrowser(`mcp__harv__browser_${tool}`, input).tier;

  it('lets Harv look around freely', () => {
    expect(tier('open', { url: 'news.ycombinator.com' })).toBe('green');
    expect(tier('snapshot', {})).toBe('green');
    expect(tier('click', { ref: 1 })).toBe('green');
    expect(tier('type', { ref: 4, text: 'rtx 3060 ti', submit: true })).toBe('green');
    expect(tier('press', { key: 'Escape' })).toBe('green');
  });

  it('asks before anything that commits, or touches secrets', () => {
    expect(tier('click', { ref: 2 })).toBe('red');
    expect(tier('type', { ref: 3, text: 'hunter2' })).toBe('red');
    expect(tier('type', { ref: 6, text: '4111' })).toBe('red');
    expect(tier('type', { ref: 5, text: 'nice', submit: true })).toBe('red');
    expect(tier('press', { key: 'Enter' })).toBe('red');
    // Elements Harv hasn't seen: it can't tell, so it asks.
    expect(tier('click', { ref: 99 })).toBe('red');
  });

  it('names the site and the element in the summary', () => {
    expect(classifyBrowser('mcp__harv__browser_click', { ref: 2 }).summary).toBe('click button "Place order" on shop.example');
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
    const reg = new ToolRegistry({ browser: { open: () => Promise.reject(new Error('no chrome')), close: vi.fn() } }, vi.fn());
    await expect(reg.open('b1', 'browser')).rejects.toThrow('no chrome');
    expect(reg.has('b1')).toBe(false);
  });
});
