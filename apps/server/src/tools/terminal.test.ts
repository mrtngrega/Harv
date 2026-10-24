import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { onlyPrompts, promptFolder, restoredLines, TerminalManager } from './terminal.ts';
import { cleanUi } from '../ui.ts';

const dir = mkdtempSync(join(tmpdir(), 'harv-terms-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const waitFor = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('terminal restore', () => {
  it('finds the folder of the last PowerShell prompt', () => {
    expect(promptFolder(['PS C:\\Users\\me> cd ..', 'PS C:\\Users> ls', 'output'])).toBe('C:\\Users');
    expect(promptFolder(['PS D:\\> '])).toBe('D:\\');
    expect(promptFolder(['no prompt here'])).toBeUndefined();
  });

  it('ends the old lines with a divider saying when they are from', () => {
    const lines = restoredLines(['PS C:\\> echo hi', 'hi'], new Date(2026, 9, 24, 13, 5).getTime());
    expect(lines.slice(0, 2)).toEqual(['PS C:\\> echo hi', 'hi']);
    expect(lines.at(-1)).toMatch(/^── restored from 24 Oct, 13:05/);
  });

  it('tells a shell nobody typed in from one with output', () => {
    expect(onlyPrompts(['PS C:\\Users\\me> ', ''])).toBe(true);
    expect(onlyPrompts(['PS C:\\Users\\me> ls', 'file.txt'])).toBe(false);
  });

  it('only accepts terminal ids', () => {
    const terms = new TerminalManager({ data: () => {}, exit: () => {} }, dir);
    expect(terms.attach('../evil')).toBeUndefined();
    expect(TerminalManager.validId('terminal-abc-123')).toBe(true);
    expect(TerminalManager.validId('terminal-../x')).toBe(false);
    terms.closeAll();
  });

  it('comes back after a restart in the same folder with its old output', { timeout: 40_000 }, async () => {
    const id = 'terminal-test1';
    let out = '';
    const first = new TerminalManager({ data: (_, d) => (out += d), exit: () => {} }, dir);
    first.attach(id, tmpdir());
    await waitFor(() => out.includes('PS '));
    first.input(id, 'echo harv-was-here\r');
    await waitFor(() => (out.match(/harv-was-here/g) ?? []).length >= 2);
    // Give the headless screen a moment to parse the last output.
    await new Promise((r) => setTimeout(r, 300));
    first.closeAll();

    let again = '';
    const second = new TerminalManager({ data: (_, d) => (again += d), exit: () => {} }, dir);
    const replay = second.attach(id)!;
    expect(replay.restored.join('\n')).toContain('harv-was-here');
    expect(replay.restored.at(-1)).toContain('restored from');
    await waitFor(() => again.includes('PS '));
    second.input(id, '(Get-Location).Path\r');
    const folder = tmpdir().replace(/\\$/, '').toLowerCase();
    await waitFor(() => again.toLowerCase().split(folder).length > 2);

    // Closing it for good forgets the saved text.
    second.close(id);
    const third = new TerminalManager({ data: () => {}, exit: () => {} }, dir);
    expect(third.attach(id)!.restored).toEqual([]);
    third.close(id);
    third.closeAll();
    second.closeAll();
  });

  it('forgets saved terminals of chats that are gone', async () => {
    const terms = new TerminalManager({ data: () => {}, exit: () => {} }, dir);
    terms.attach('terminal-keep');
    terms.attach('terminal-drop');
    await new Promise((r) => setTimeout(r, 1500));
    terms.closeAll();
    const next = new TerminalManager({ data: () => {}, exit: () => {} }, dir);
    next.prune((id) => id === 'terminal-keep');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).some((f) => f.startsWith('terminal-drop'))).toBe(false);
    next.close('terminal-keep');
    next.closeAll();
  });
});

describe('dashboard layout (ui.json)', () => {
  it('keeps only well-formed parts', () => {
    const ui = cleanUi({
      activeId: 'abc',
      settingsOpen: 'yes',
      order: ['a', 'a', 'b', 5, '../x'],
      tools: { a: ['files', 'browser'], '../x': ['terminal'] },
      views: { a: 'files', b: 'nope' },
      explorer: { a: 'C:\\Users' },
      drafts: { a: 'half a thought', b: '' },
      attachments: { a: [{ id: 'f1', name: 'x.png', size: 3, mime: 'image/png' }, { id: 1 }] },
    });
    expect(ui).toEqual({
      activeId: 'abc',
      settingsOpen: false,
      order: ['a', 'b'],
      blanks: [],
      tools: { a: ['files'] },
      views: { a: 'files' },
      explorer: { a: 'C:\\Users' },
      drafts: { a: 'half a thought' },
      attachments: { a: [{ id: 'f1', name: 'x.png', size: 3, mime: 'image/png' }] },
    });
    expect(cleanUi(null).order).toEqual([]);
  });
});
