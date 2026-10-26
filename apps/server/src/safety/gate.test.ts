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
  it('deletes inside a folder the user attached to that chat without a card, backed up first', async () => {
    const store = new ActionStore(':memory:');
    const sent: SafetyServerMessage[] = [];
    const given = mkdtempSync(join(userDir, 'given-'));
    const file = join(given, 'old.txt');
    writeFileSync(file, 'keep a copy');
    const gate = new SafetyGate(store, {
      broadcast: (m) => sent.push(m),
      notice: () => {},
      onChange: () => {},
      attachedOf: (tabId) => (tabId === 'tab' ? [given] : []),
    });
    const out = await gate.preToolUse('tab', 'PowerShell', { command: `Remove-Item "${file}"` }, 'att1', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    expect(store.get('att1')?.tier).toBe('yellow');
    expect(store.get('att1')?.backups).toContain(file);
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
    // Another chat didn't get the folder: there it asks.
    const pending = gate.preToolUse('other', 'PowerShell', { command: `Remove-Item "${file}"` }, 'att2', signal());
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'approval.request')).toBe(true));
    gate.cancel('other');
    await pending;
  });

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
    // Harv is told it was an interruption, not a refusal (it once gave up on scans after Stop + "continue").
    const reason = ((await stopped) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput
      ?.permissionDecisionReason;
    expect(reason).toMatch(/not a refusal/);
  });

  it('"Approve all for this reply" lets the rest of the turn through, until it ends', async () => {
    const { gate, store } = setup();
    const first = gate.preToolUse('tab', 'Bash', { command: 'rm -rf ~/tmp/a' }, 'a1', signal());
    const second = gate.preToolUse('tab', 'Bash', { command: 'rm -rf ~/tmp/b' }, 'a2', signal());
    await Promise.resolve();
    expect(gate.waiting).toBe(2);
    gate.answer('a1', true, undefined, false, true);
    expect(decision(await first)?.permissionDecision).toBe('allow');
    expect(decision(await second)?.permissionDecision).toBe('allow');
    // Later calls in the same reply run without a card; other tabs still ask; blocked stays blocked.
    expect(decision(await gate.preToolUse('tab', 'Bash', { command: 'rm -rf ~/tmp/c' }, 'a3', signal()))?.permissionDecision).toBe('allow');
    expect(store.get('a3')?.status).toBe('running');
    expect(await gate.canUseTool('Bash', { command: 'rm -rf ~/tmp/c' }, 'a3', 'tab')).toMatchObject({ behavior: 'allow' });
    expect(decision(await gate.preToolUse('tab', 'Bash', { command: 'format D:' }, 'a4', signal()))?.permissionDecision).toBe('deny');
    void gate.preToolUse('other', 'Bash', { command: 'rm -rf ~/tmp/d' }, 'a5', signal());
    await Promise.resolve();
    expect(gate.waiting).toBe(1);
    gate.cancel('other');
    // The next reply asks again.
    gate.turnEnded('tab');
    void gate.preToolUse('tab', 'Bash', { command: 'rm -rf ~/tmp/e' }, 'a6', signal());
    await Promise.resolve();
    expect(gate.waiting).toBe(1);
    gate.cancel('tab');
  });

  it('asks before yellow edits too when "confirm changes" is on', async () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ confirmYellow: true }));
    try {
      const { gate, store, sent } = setup();
      const file = join(userDir, 'confirm.txt');
      writeFileSync(file, 'v1');
      const pending = gate.preToolUse('tab', 'Edit', { file_path: file, old_string: 'v1', new_string: 'v2' }, 't8', signal());
      await Promise.resolve();
      expect(gate.waiting).toBe(1);
      expect(store.get('t8')).toMatchObject({ tier: 'yellow', status: 'pending' });
      expect(sent.find((m) => m.type === 'approval.request')).toMatchObject({ approval: { id: 't8' } });
      gate.answer('t8', true);
      expect(decision(await pending)?.permissionDecision).toBe('allow');
      expect(store.get('t8')?.backups).toEqual([file]);
    } finally {
      rmSync(join(home, 'settings.json'), { force: true });
    }
  });

  it('Don’t ask again saves the rule, and the next such command runs without a card', async () => {
    const store = new ActionStore(':memory:');
    const sent: SafetyServerMessage[] = [];
    const saved: string[][] = [];
    const gate = new SafetyGate(store, {
      broadcast: (m) => sent.push(m),
      notice: () => {},
      onChange: () => {},
      allow: (rules) => {
        saved.push(rules);
        writeFileSync(join(home, 'settings.json'), JSON.stringify({ allowRules: rules }));
      },
    });
    try {
      const pending = gate.preToolUse('tab', 'PowerShell', { command: 'ollama rm qwen3:8b' }, 'r1', signal());
      await Promise.resolve();
      const request = sent.find((m) => m.type === 'approval.request');
      expect(request).toMatchObject({ approval: { rules: ['ollama rm'] } });
      gate.answer('r1', true, 'ollama rm qwen3:8b', true);
      expect(decision(await pending)?.permissionDecision).toBe('allow');
      expect(saved).toEqual([['ollama rm']]);

      const next = await gate.preToolUse('tab', 'PowerShell', { command: 'ollama rm llama3:8b' }, 'r2', signal());
      expect(decision(next)?.permissionDecision).toBe('allow');
      expect(store.get('r2')?.tier).toBe('yellow');
      // Another kind of command still asks.
      void gate.preToolUse('tab', 'PowerShell', { command: 'ollama pull llama3' }, 'r3', signal());
      await Promise.resolve();
      expect(gate.waiting).toBe(1);
      gate.cancel('tab');
    } finally {
      rmSync(join(home, 'settings.json'), { force: true });
    }
  });
});
