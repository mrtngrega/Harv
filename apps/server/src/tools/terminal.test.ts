import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cdCommand, onlyPrompts, promptFolder, restoredLines, TerminalManager } from './terminal.ts';
import { IS_WINDOWS } from '../platform.ts';
import { cleanUi } from '../ui.ts';

const dir = mkdtempSync(join(tmpdir(), 'harv-terms-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The shell has shown its prompt: PowerShell's "PS C:\…>", or bash's "…$ ". */
const prompted = (out: string) => (IS_WINDOWS ? out.includes('PS ') : /[$#] /.test(out));
/** A command that prints the shell's folder. */
const PWD = IS_WINDOWS ? '(Get-Location).Path' : 'pwd';
const TMP = tmpdir()
  .replace(/[\\/]$/, '')
  .toLowerCase();

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

  it('moves a shell to a folder in its own syntax', () => {
    expect(cdCommand('powershell.exe', "C:\\it's")).toBe("Set-Location -LiteralPath 'C:\\it''s'");
    expect(cdCommand('/bin/bash', "/home/me/it's")).toBe("cd -- '/home/me/it'\\''s'");
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
    await waitFor(() => prompted(out));
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
    await waitFor(() => prompted(again));
    second.input(id, `${PWD}\r`);
    await waitFor(() => again.toLowerCase().split(TMP).length > 2);

    // Closing it for good forgets the saved text.
    second.close(id);
    const third = new TerminalManager({ data: () => {}, exit: () => {} }, dir);
    expect(third.attach(id)!.restored).toEqual([]);
    third.close(id);
    third.closeAll();
    second.closeAll();
  });

  it('"Open in Terminal" moves a running shell, and restarts an exited one, in that folder', { timeout: 40_000 }, async () => {
    const id = 'terminal-cd';
    let out = '';
    const terms = new TerminalManager({ data: (_, d) => (out += d), exit: () => {} }, dir);
    terms.attach(id, tmpdir());
    await waitFor(() => prompted(out));
    const target = mkdtempSync(join(tmpdir(), 'harv-cd-'));
    const name = target.split(/[\\/]/).at(-1)!.toLowerCase();
    terms.attach(id, target);
    terms.input(id, `${PWD}\r`);
    // The name shows once in the typed cd, and again in pwd's answer (or the prompt).
    await waitFor(() => out.toLowerCase().split(name).length > 2);
    terms.input(id, 'exit\r');
    await new Promise((r) => setTimeout(r, 1500));
    out = '';
    terms.attach(id, tmpdir());
    await waitFor(() => prompted(out));
    terms.input(id, `${PWD}\r`);
    await waitFor(() => out.toLowerCase().split(TMP).length > 2);
    expect(out.toLowerCase()).not.toContain(name);
    terms.close(id);
    terms.closeAll();
    rmSync(target, { recursive: true, force: true });
  });

  it("Harv's terminal_run types a command in the visible terminal and gets its output back", { timeout: 40_000 }, async () => {
    const id = 'terminal-run';
    let out = '';
    const terms = new TerminalManager({ data: (_, d) => (out += d), exit: () => {} }, dir);
    // Starts the shell itself, in the folder asked for.
    const first = await terms.run(id, 'echo harv-one', { cwd: tmpdir(), quietMs: 1000 });
    expect(first.output).toContain('harv-one');
    expect(first.running).toBe(false);
    // The dashboard sees it too (the same output stream).
    expect(out).toContain('harv-one');
    // Only what came after the command: not the earlier one.
    const second = await terms.run(id, PWD, { quietMs: 1000 });
    expect(second.output.toLowerCase()).toContain(TMP);
    expect(second.output).not.toContain('harv-one');
    expect(terms.read(id, 50)).toContain('harv-one');
    // A closed shell starts again.
    await terms.run(id, 'exit', { quietMs: 500, waitMs: 3000 });
    await new Promise((r) => setTimeout(r, 500));
    const again = await terms.run(id, 'echo harv-two', { quietMs: 1000 });
    expect(again.output).toContain('harv-two');
    expect(terms.read('terminal-none')).toBeUndefined();
    terms.close(id);
    terms.closeAll();
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
