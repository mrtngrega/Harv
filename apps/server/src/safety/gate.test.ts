import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SafetyServerMessage } from '@harv/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'harv-gate-'));
vi.stubEnv('HARV_HOME', home);
const { SafetyGate } = await import('./gate.ts');
const { createBackup, restoreBackup } = await import('./backup.ts');
const { ActionStore } = await import('../store/actions.ts');

const userDir = mkdtempSync(join(tmpdir(), 'harv-user-'));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

function setup() {
  const store = new ActionStore(':memory:');
  const sent: SafetyServerMessage[] = [];
  const notices: string[] = [];
  const gate = new SafetyGate(store, { broadcast: (m) => sent.push(m), notice: (_t, m) => notices.push(m), onChange: () => {} });
  return { store, gate, sent, notices };
}

const signal = () => new AbortController().signal;
const decision = (out: unknown) =>
  (out as { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } }).hookSpecificOutput;

describe('backups', () => {
  it('restores a changed file and keeps the newer version aside', () => {
    const file = join(userDir, 'a.txt');
    writeFileSync(file, 'original');
    const backup = createBackup('tool_1', [file]);
    writeFileSync(file, 'changed');
    restoreBackup(backup);
    expect(readFileSync(file, 'utf8')).toBe('original');
  });

  it('undoes a newly created file by moving it aside', () => {
    const file = join(userDir, 'new.txt');
    const backup = createBackup('tool_2', [file]);
    writeFileSync(file, 'created');
    restoreBackup(backup);
    expect(existsSync(file)).toBe(false);
  });
});

describe('SafetyGate', () => {
  it('lets green calls through and logs them quietly', async () => {
    const { gate, store, sent } = setup();
    const out = await gate.preToolUse('tab', 'Read', { file_path: 'C:\\x.txt' }, 't1', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    expect(store.get('t1')?.tier).toBe('green');
    expect(sent).toEqual([]);
  });

  it('blocks with a reason', async () => {
    const { gate, store } = setup();
    const out = await gate.preToolUse('tab', 'PowerShell', { command: 'format D:' }, 't2', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    expect(store.get('t2')?.status).toBe('blocked');
  });

  it('backs up a yellow edit, and Undo restores it', async () => {
    const { gate, store, notices } = setup();
    const file = join(userDir, 'doc.txt');
    writeFileSync(file, 'v1');
    const out = await gate.preToolUse('tab', 'Edit', { file_path: file, old_string: 'v1', new_string: 'v2' }, 't3', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    writeFileSync(file, 'v2');
    gate.done('Edit', { file_path: file }, 't3', {});
    expect(store.get('t3')).toMatchObject({ status: 'done', canUndo: true, backups: [file] });

    gate.undo('t3');
    expect(readFileSync(file, 'utf8')).toBe('v1');
    expect(store.get('t3')?.status).toBe('undone');
    expect(notices[0]).toMatch(/^Undone/);
  });

  it('holds a red command until the user approves, with their edit', async () => {
    const { gate, store, sent } = setup();
    const pending = gate.preToolUse('tab', 'PowerShell', { command: 'Stop-Process -Name notepad' }, 't4', signal());
    await Promise.resolve();
    expect(gate.waiting).toBe(1);
    const request = sent.find((m) => m.type === 'approval.request');
    expect(request).toMatchObject({ approval: { id: 't4', command: 'Stop-Process -Name notepad', reason: 'Stops running programs.' } });
    expect(await gate.canUseTool('PowerShell', { command: 'Stop-Process -Name notepad' }, 't4')).toMatchObject({ behavior: 'deny' });

    gate.answer('t4', true, 'Stop-Process -Name calc');
    const out = decision(await pending);
    expect(out?.permissionDecision).toBe('allow');
    expect(out?.updatedInput).toEqual({ command: 'Stop-Process -Name calc' });
    expect(gate.waiting).toBe(0);
    expect(store.get('t4')?.status).toBe('running');
    expect(await gate.canUseTool('PowerShell', { command: 'Stop-Process -Name calc' }, 't4')).toMatchObject({ behavior: 'allow' });
  });

  it('refuses an approved edit that turns into something blocked', async () => {
    const { gate } = setup();
    const pending = gate.preToolUse('tab', 'PowerShell', { command: 'Stop-Process -Name notepad' }, 't5', signal());
    await Promise.resolve();
    gate.answer('t5', true, 'format C:');
    expect(decision(await pending)?.permissionDecision).toBe('deny');
  });

  it('denies on Deny and on Stop', async () => {
    const { gate, store } = setup();
    const denied = gate.preToolUse('tab', 'Bash', { command: 'rm -rf ~/tmp' }, 't6', signal());
    await Promise.resolve();
    gate.answer('t6', false);
    expect(decision(await denied)?.permissionDecision).toBe('deny');
    expect(store.get('t6')?.status).toBe('denied');

    const stopped = gate.preToolUse('tab', 'Bash', { command: 'rm -rf ~/tmp' }, 't7', signal());
    await Promise.resolve();
    gate.cancel('tab');
    expect(decision(await stopped)?.permissionDecision).toBe('deny');
    expect(store.get('t7')?.result).toBe('Stopped by the user.');
  });
});
