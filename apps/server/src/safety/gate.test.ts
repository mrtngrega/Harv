import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SafetyServerMessage } from '@harv/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
/** These tests are about the approval cards, so "Ask before risky actions" is on unless a test says otherwise. */
const writeSettings = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ askRisky: true, ...extra }));
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
  beforeEach(() => writeSettings());

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
    writeSettings({ confirmYellow: true });
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
      writeSettings();
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
        writeSettings({ allowRules: rules });
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
      writeSettings();
    }
  });

  it('runs red commands without a card when "Ask before risky actions" is off, backed up and logged', async () => {
    writeSettings({ askRisky: false });
    const { gate, store, sent } = setup();
    const file = join(userDir, 'gone.txt');
    writeFileSync(file, 'keep a copy');
    const out = await gate.preToolUse('tab', 'PowerShell', { command: `Remove-Item "${file}"` }, 'q1', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    expect(store.get('q1')).toMatchObject({
      tier: 'red',
      status: 'running',
      backups: [file],
      result: 'Ran without asking (Settings › Safety).',
    });
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
    expect(await gate.canUseTool('PowerShell', { command: `Remove-Item "${file}"` }, 'q1', 'tab')).toMatchObject({ behavior: 'allow' });
    // Blocked stays blocked.
    expect(decision(await gate.preToolUse('tab', 'PowerShell', { command: 'format D:' }, 'q2', signal()))?.permissionDecision).toBe('deny');
  });
});

describe('questions, plans and sending (docs/PLAN.md §6s)', () => {
  beforeEach(() => writeSettings({ askRisky: false }));
  const deny = (out: unknown) =>
    (out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? '';
  const question = {
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        multiSelect: false,
        options: [
          { label: 'Blue', description: 'cool' },
          { label: 'Amber', description: 'warm' },
        ],
      },
    ],
  };

  it("shows Claude's questions as a card and gives the answers back in the tool's input", async () => {
    const { gate, sent } = setup();
    const out = gate.preToolUse('tab', 'AskUserQuestion', question, 'ask1', signal());
    await Promise.resolve();
    const card = sent.find((m) => m.type === 'approval.request');
    expect(card?.type === 'approval.request' && card.approval).toMatchObject({
      kind: 'question',
      questions: [{ question: 'Which colour?' }],
    });
    gate.answer('ask1', true, undefined, false, false, { answers: { 'Which colour?': 'Amber' } });
    expect(decision(await out)).toMatchObject({
      permissionDecision: 'allow',
      updatedInput: { ...question, answers: { 'Which colour?': 'Amber' } },
    });
  });

  it('passes on what the user wrote instead of picking, and Stop is not a refusal', async () => {
    const { gate } = setup();
    const out = gate.preToolUse('tab', 'AskUserQuestion', question, 'ask2', signal());
    await Promise.resolve();
    gate.answer('ask2', false, undefined, false, false, { why: 'neither, use green' });
    expect(deny(await out)).toContain('neither, use green');
    const stopped = gate.preToolUse('tab', 'AskUserQuestion', question, 'ask3', signal());
    await Promise.resolve();
    gate.cancel('tab');
    expect(deny(await stopped)).toContain('pressed Stop');
  });

  it('keeps plan mode to reading and planning until the user approves the plan', async () => {
    const changes: [string, boolean][] = [];
    const store = new ActionStore(':memory:');
    const sent: SafetyServerMessage[] = [];
    const gate = new SafetyGate(store, {
      broadcast: (m) => sent.push(m),
      notice: () => {},
      onChange: () => {},
      onPlanMode: (tab, on) => changes.push([tab, on]),
    });
    expect(decision(await gate.preToolUse('tab', 'EnterPlanMode', {}, 'p0', signal()))?.permissionDecision).toBe('allow');
    expect(gate.isPlanning('tab')).toBe(true);
    const file = join(userDir, 'plan-target.txt');
    expect(decision(await gate.preToolUse('tab', 'Write', { file_path: file, content: 'x' }, 'p1', signal()))?.permissionDecision).toBe(
      'deny',
    );
    expect(decision(await gate.preToolUse('tab', 'Read', { file_path: file }, 'p2', signal()))?.permissionDecision).toBe('allow');
    const planFile = join(home, 'workspace', 'plans', 'plan.md');
    expect(
      decision(await gate.preToolUse('tab', 'Write', { file_path: planFile, content: '# Plan' }, 'p3', signal()))?.permissionDecision,
    ).toBe('allow');
    // Other chats aren't in plan mode.
    expect(decision(await gate.preToolUse('other', 'Write', { file_path: file, content: 'x' }, 'p4', signal()))?.permissionDecision).toBe(
      'allow',
    );

    const asked = gate.preToolUse('tab', 'ExitPlanMode', { plan: '1. Do it' }, 'p5', signal());
    await Promise.resolve();
    const card = sent.findLast((m) => m.type === 'approval.request');
    expect(card?.type === 'approval.request' && card.approval).toMatchObject({ kind: 'plan', plan: '1. Do it' });
    gate.answer('p5', false, undefined, false, false, { why: 'add tests' });
    expect(deny(await asked)).toContain('add tests');
    expect(gate.isPlanning('tab')).toBe(true);

    const again = gate.preToolUse('tab', 'ExitPlanMode', { plan: '1. Do it\n2. Test it' }, 'p6', signal());
    await Promise.resolve();
    gate.answer('p6', true);
    expect(decision(await again)?.permissionDecision).toBe('allow');
    expect(gate.isPlanning('tab')).toBe(false);
    expect(changes).toEqual([
      ['tab', true],
      ['tab', false],
    ]);
  });

  it("asks before sending something the user didn't ask to send, even with cards off", async () => {
    const { gate, sent } = setup();
    gate.setTurn('tab', 'summarize my inbox');
    const out = gate.preToolUse('tab', 'mcp__claude_ai_Gmail__send_message', { to: 'x@example.com' }, 's1', signal());
    await Promise.resolve();
    const card = sent.find((m) => m.type === 'approval.request');
    expect(card?.type === 'approval.request' && card.approval.sending).toBe(true);
    gate.answer('s1', false);
    expect(decision(await out)?.permissionDecision).toBe('deny');

    // Asked to send: it just sends (logged).
    gate.setTurn('tab', 'send Peter the summary by email');
    expect(
      decision(await gate.preToolUse('tab', 'mcp__claude_ai_Gmail__send_message', { to: 'peter@example.com' }, 's2', signal()))
        ?.permissionDecision,
    ).toBe('allow');
    // The turn is over: the next one is checked on its own words.
    gate.turnEnded('tab');
    void gate.preToolUse('tab', 'mcp__claude_ai_Gmail__send_message', { to: 'p@example.com' }, 's3', signal());
    await Promise.resolve();
    expect(gate.waiting).toBe(1);
    gate.cancel('tab');
  });
});

describe('desktop control (docs/PLAN.md §6t item 1)', () => {
  const click = 'mcp__desktop__Click';

  it('asks once per reply before using the mouse or keyboard, even with cards off', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    gate.setTurn('tab', 'open Discord and click the general channel');
    // Looking is free.
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'd0', signal()))?.permissionDecision).toBe('allow');
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);

    const first = gate.preToolUse('tab', click, { label: 4 }, 'd1', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    const card = sent.find((m) => m.type === 'approval.request');
    expect(card?.type === 'approval.request' && card.approval.desktop).toBe(true);
    gate.answer('d1', true);
    expect(decision(await first)?.permissionDecision).toBe('allow');
    expect(await gate.canUseTool(click, { label: 4 }, 'd1', 'tab')).toMatchObject({ behavior: 'allow' });

    // The rest of the reply goes on without a card.
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Type', { text: 'hi' }, 'd2', signal()))?.permissionDecision).toBe('allow');
    expect(await gate.canUseTool('mcp__desktop__Type', { text: 'hi' }, 'd2', 'tab')).toMatchObject({ behavior: 'allow' });

    // A new reply asks again.
    gate.turnEnded('tab');
    gate.setTurn('tab', 'and now the next one');
    const again = gate.preToolUse('tab', click, { label: 5 }, 'd3', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.answer('d3', false);
    expect(decision(await again)?.permissionDecision).toBe('deny');
  });

  it('asks only once per reply with cards on too, not on every click', async () => {
    const { gate } = setup();
    gate.setTurn('tab', 'click it');
    const first = gate.preToolUse('tab', click, { label: 1 }, 'e1', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.answer('e1', true);
    await first;
    expect(decision(await gate.preToolUse('tab', click, { label: 2 }, 'e2', signal()))?.permissionDecision).toBe('allow');
  });

  it('a denied card keeps asking for the rest of the reply, and Stop clears the OK', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    gate.setTurn('tab', 'click it');
    const denied = gate.preToolUse('tab', click, { label: 1 }, 'f1', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.answer('f1', false);
    await denied;
    const next = gate.preToolUse('tab', click, { label: 1 }, 'f2', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.answer('f2', true);
    await next;
    gate.cancel('tab');
    gate.setTurn('tab', 'go on');
    void gate.preToolUse('tab', click, { label: 1 }, 'f3', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.cancel('tab');
  });

  it('refuses scheduled and background turns, where nobody may be at the computer', async () => {
    writeSettings({ askRisky: false });
    const { gate, store, sent } = setup();
    gate.setTurn('tab', '[Scheduled task "Morning"] click the button');
    expect(decision(await gate.preToolUse('tab', click, { label: 1 }, 'g1', signal()))?.permissionDecision).toBe('deny');
    expect(store.get('g1')?.status).toBe('blocked');
    // A turn Claude started by itself has no turn text.
    gate.turnEnded('tab');
    expect(decision(await gate.preToolUse('tab', click, { label: 1 }, 'g2', signal()))?.permissionDecision).toBe('deny');
    // Reading the screen is still fine.
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'g3', signal()))?.permissionDecision).toBe('allow');
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it('blocks launch_executable even after the OK', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    gate.setTurn('tab', 'run it');
    const out = await gate.preToolUse('tab', 'mcp__desktop__App', { mode: 'launch_executable', executable: 'x.exe' }, 'h1', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
  });
});

describe('desktop control signal (the pill)', () => {
  const controls = (sent: SafetyServerMessage[]) =>
    sent.flatMap((m) => (m.type === 'desktop.control' ? [{ tabId: m.tabId, action: m.action }] : []));

  it('says which chat uses the desktop and what it does, until the reply ends', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    gate.setTurn('tab', 'click the button');
    await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'p0', signal());
    expect(controls(sent)).toEqual([]);
    expect(gate.desktopControl()).toBeNull();

    const first = gate.preToolUse('tab', 'mcp__desktop__Click', { label: 3 }, 'p1', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    // Not before the user said yes.
    expect(controls(sent)).toEqual([]);
    gate.answer('p1', true);
    await first;
    await gate.preToolUse('tab', 'mcp__desktop__Type', { text: 'hi' }, 'p2', signal());
    expect(controls(sent)).toEqual([
      { tabId: 'tab', action: 'click element #3 from the last snapshot' },
      { tabId: 'tab', action: 'type “hi”' },
    ]);
    const since = gate.desktopControl()!.since;
    expect(gate.desktopControl()).toMatchObject({ tabId: 'tab', action: 'type “hi”' });
    expect(sent.filter((m) => m.type === 'desktop.control').every((m) => m.type === 'desktop.control' && m.since === since)).toBe(true);

    gate.turnEnded('tab');
    expect(controls(sent).at(-1)).toEqual({ tabId: 'tab', action: null });
    expect(gate.desktopControl()).toBeNull();
  });

  it('Stop ends it, and another chat ending changes nothing', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    gate.setTurn('tab', 'click it');
    const first = gate.preToolUse('tab', 'mcp__desktop__Click', { label: 1 }, 'q1', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.answer('q1', true);
    await first;
    gate.turnEnded('other');
    expect(gate.desktopControl()?.tabId).toBe('tab');
    gate.cancel('tab');
    expect(gate.desktopControl()).toBeNull();
    expect(controls(sent).at(-1)).toEqual({ tabId: 'tab', action: null });
  });

  it('a denied card never starts it', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    gate.setTurn('tab', 'click it');
    const first = gate.preToolUse('tab', 'mcp__desktop__Click', { label: 1 }, 'r1', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.answer('r1', false);
    await first;
    expect(controls(sent)).toEqual([]);
  });
});

describe('desktop control on one monitor', () => {
  // The user's smaller right monitor, the one Harv works on by default.
  const right = { device: 'D2', primary: false, left: 2560, top: 147, right: 4480, bottom: 1227 };
  const area = { ...right, label: 'right', region: [2560, 147, 4480, 1227] as [number, number, number, number], count: 2 };
  function setupOn() {
    const store = new ActionStore(':memory:');
    const sent: SafetyServerMessage[] = [];
    const gate = new SafetyGate(store, { broadcast: (m) => sent.push(m), notice: () => {}, onChange: () => {}, desktopArea: () => area });
    return { gate, store, sent };
  }

  it('limits looking to the work monitor unless the call already says where', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setupOn();
    gate.setTurn('tab', 'what does Discord show?');
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'm1', signal()))?.updatedInput).toEqual({
      region: [2560, 147, 4480, 1227],
    });
    expect(
      decision(await gate.preToolUse('tab', 'mcp__desktop__Screenshot', { display: [0] }, 'm2', signal()))?.updatedInput,
    ).toBeUndefined();
    // The user named a monitor: the whole desktop.
    gate.setTurn('tab', 'look at both monitors');
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'm3', signal()))?.updatedInput).toBeUndefined();
  });

  it('refuses acting on another monitor unless the message names it, before any card', async () => {
    writeSettings({ askRisky: false });
    const { gate, store, sent } = setupOn();
    gate.setTurn('tab', 'click the start button');
    const out = await gate.preToolUse('tab', 'mcp__desktop__Click', { loc: [100, 1400] }, 'n1', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    expect(store.get('n1')?.status).toBe('blocked');
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
    // Moving a window onto another monitor counts too.
    expect(
      decision(await gate.preToolUse('tab', 'mcp__desktop__App', { mode: 'resize', name: 'X', window_loc: [10, 10] }, 'n2', signal()))
        ?.permissionDecision,
    ).toBe('deny');

    gate.setTurn('tab', 'click the start button on the left monitor');
    const named = gate.preToolUse('tab', 'mcp__desktop__Click', { loc: [100, 1400] }, 'n3', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.answer('n3', true);
    expect(decision(await named)?.permissionDecision).toBe('allow');
  });

  it('tells the pill where Harv acts: the point, else the last one, else the middle of the work monitor', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setupOn();
    gate.setTurn('tab', 'type into it');
    const first = gate.preToolUse('tab', 'mcp__desktop__Shortcut', { shortcut: 'ctrl+l' }, 'o1', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.answer('o1', true);
    await first;
    await gate.preToolUse('tab', 'mcp__desktop__Click', { loc: [3000, 500] }, 'o2', signal());
    await gate.preToolUse('tab', 'mcp__desktop__Type', { text: 'x', label: 4 }, 'o3', signal());
    const ats = sent.flatMap((m) => (m.type === 'desktop.control' && m.action ? [m.at] : []));
    expect(ats).toEqual([
      [3520, 687],
      [3000, 500],
      [3000, 500],
    ]);
  });
});
