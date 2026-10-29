import { describe, expect, it, vi } from 'vitest';
import { answerStart, applyChatEvent, askOnStart, chat, getChatState, startQuestions, syncLayout } from './chatStore.ts';
import { getDrafts, getDraftTexts } from './drafts.ts';

vi.mock('./socket.ts', () => ({ onServerMessage: () => {}, sendMessage: () => true }));
function openTab(): string {
  chat.newTab();
  return getChatState().tabs.at(-1)!.id;
}

const tab = (id: string) => getChatState().tabs.find((t) => t.id === id)!;

describe('tab order', () => {
  it('moves a tab before or after another', () => {
    const [a, b, c] = [openTab(), openTab(), openTab()];
    const order = () =>
      getChatState()
        .tabs.map((t) => t.id)
        .filter((id) => [a, b, c].includes(id));
    expect(order()).toEqual([a, b, c]);
    chat.moveTab(c, a, false);
    expect(order()).toEqual([c, a, b]);
    chat.moveTab(c, b, true);
    expect(order()).toEqual([a, b, c]);
    chat.moveTab(a, a, true);
    chat.moveTab('missing', a, true);
    expect(order()).toEqual([a, b, c]);
  });
});

describe('chat stream handling', () => {
  it('builds a reply from started → delta → tool → delta → done', () => {
    const tabId = openTab();
    applyChatEvent({ type: 'chat.started', tabId, model: 'Sonnet 5.5', effort: 'medium', auto: true, reason: 'test' });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'Let me ' });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'check.' });
    applyChatEvent({ type: 'chat.tool', tabId, id: 'toolu_1', name: 'Read', detail: 'notes.md' });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'Done.' });
    applyChatEvent({ type: 'chat.done', tabId, ok: true, stopped: false });

    expect(tab(tabId).busy).toBe(false);
    expect(tab(tabId).lines.map((l) => [l.kind, l.text, l.tag])).toEqual([
      ['harv', 'Let me check.', 'sonnet·medium'],
      ['tool', 'Read · notes.md', undefined],
      ['harv', 'Done.', 'sonnet·medium'],
    ]);
    expect(tab(tabId).lines.every((l) => !l.streaming)).toBe(true);
  });

  it('puts a thought in front of the reply it led to', () => {
    const tabId = openTab();
    chat.send('why is the sky blue');
    applyChatEvent({ type: 'chat.started', tabId, model: 'Opus 5.5', effort: 'medium', auto: true, reason: 'test' });
    applyChatEvent({ type: 'chat.thinking', tabId, text: 'Rayleigh scattering…', seconds: 4 });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'Because of scattering.' });
    applyChatEvent({ type: 'chat.done', tabId, ok: true, stopped: false });
    expect(tab(tabId).lines.map((l) => [l.kind, l.tag])).toEqual([
      ['you', undefined],
      ['thinking', '4s'],
      ['harv', 'opus·medium'],
    ]);
  });

  it('lets the final assistant text replace streamed text', () => {
    const tabId = openTab();
    applyChatEvent({ type: 'chat.started', tabId, model: 'Haiku 5.5', effort: 'low', auto: false, reason: 'test' });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'Hel' });
    applyChatEvent({ type: 'chat.assistant', tabId, text: 'Hello!' });
    applyChatEvent({ type: 'chat.done', tabId, ok: true, stopped: false });
    expect(tab(tabId).lines.map((l) => l.text)).toEqual(['Hello!']);
  });

  it('drops the empty thinking line when a turn is stopped', () => {
    const tabId = openTab();
    applyChatEvent({ type: 'chat.started', tabId, model: 'Opus 5.5', effort: 'high', auto: false, reason: 'test' });
    applyChatEvent({ type: 'chat.done', tabId, ok: false, stopped: true });
    expect(tab(tabId).lines.map((l) => [l.kind, l.text])).toEqual([['notice', 'Stopped.']]);
  });
});

describe('waiting for the router', () => {
  it('tags the thinking line shown on send once AUTO decides', () => {
    const tabId = openTab();
    chat.harder(tabId);
    applyChatEvent({ type: 'chat.started', tabId, model: 'Opus 5.5', effort: 'high', auto: true, reason: 'you asked to try harder' });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'Better.' });
    applyChatEvent({ type: 'chat.done', tabId, ok: true, stopped: false });
    expect(tab(tabId).lines.map((l) => [l.kind, l.text, l.tag, l.reason])).toEqual([
      ['you', 'Try harder.', undefined, undefined],
      ['harv', 'Better.', 'opus·high', 'you asked to try harder'],
    ]);
  });
});

describe('the Settings tab', () => {
  it('opens next to the chats, and sending from it goes to a chat', () => {
    const tabId = openTab();
    chat.openSettings();
    expect(getChatState()).toMatchObject({ settingsOpen: true, activeId: 'settings' });
    // A file dropped or a message sent while Settings is showing lands in the last chat.
    expect(chat.ensureTab()).toBe(getChatState().tabs.at(-1)!.id);
    expect(getChatState().activeId).not.toBe('settings');

    chat.openSettings();
    chat.closeSettings();
    expect(getChatState().settingsOpen).toBe(false);
    expect(getChatState().tabs.some((t) => t.id === getChatState().activeId)).toBe(true);
    expect(tab(tabId)).toBeDefined();
  });
});

describe('chat views (files and terminal inside a chat)', () => {
  it('opens a tool in a chat, switches back, and forgets it when the chat closes', () => {
    const tabId = openTab();
    expect(getChatState().views[tabId]).toBeUndefined();
    chat.setView(tabId, 'files');
    chat.setView(tabId, 'terminal');
    chat.setView(tabId, 'chat');
    expect(getChatState().tools[tabId]).toEqual(['files', 'terminal']);
    expect(getChatState().views[tabId]).toBe('chat');

    chat.setView(tabId, 'terminal');
    chat.closeTool(tabId, 'terminal');
    expect(getChatState().tools[tabId]).toEqual(['files']);
    expect(getChatState().views[tabId]).toBe('chat');

    chat.closeTab(tabId);
    expect(getChatState().tools[tabId]).toBeUndefined();
    expect(getChatState().views[tabId]).toBeUndefined();
  });

  it('can open a new chat straight into its explorer', () => {
    const tabId = chat.newTab('files');
    expect(getChatState()).toMatchObject({ activeId: tabId, views: { [tabId]: 'files' }, tools: { [tabId]: ['files'] } });
  });
});

describe('blank tabs', () => {
  it('stay blank (only the dashboard knows them) until a message is sent, even with notes in them', () => {
    const tabId = openTab();
    chat.noticeInActive('Heads up: 90% of your Claude session limit is used.');
    expect(tab(tabId).lines).toHaveLength(1);
    expect(tab(tabId).stored).toBeFalsy();
    chat.send('hello');
    expect(tab(tabId).stored).toBe(true);
  });
});

describe('start question (continue or new session)', () => {
  it('asks only chats Harv answered in: one with just /report notes has no session to continue', () => {
    const line = (kind: 'you' | 'harv' | 'notice', text: string) => ({ kind, text, at: 0 });
    askOnStart(
      [
        { id: 'talk', title: 'Weather', resumable: true, lines: [line('you', 'rain?'), line('harv', 'No.')] },
        { id: 'notes', title: '/report x', lines: [line('you', '/report x'), line('notice', 'Noted in harv_report.md.')] },
        { id: 'empty', title: 'New chat', lines: [] },
        // From the other device: no Claude session here to continue.
        { id: 'synced', title: 'From the notebook', lines: [line('you', 'hi'), line('harv', 'Hello.')] },
      ],
      1234,
    );
    expect(startQuestions.get()).toEqual(['talk']);
    // A turn in it answers the question.
    applyChatEvent({ type: 'chat.started', tabId: 'talk', model: 'Haiku', effort: 'low', auto: true, reason: 'x' });
    expect(startQuestions.get()).toEqual([]);
  });

  it('after a page reload in the same server run, a chat first used after the start does not ask', async () => {
    const line = (kind: 'you' | 'harv', text: string) => ({ kind, text, at: 0 });
    const old = { id: 'old', title: 'Old', resumable: true, lines: [line('you', 'a'), line('harv', 'b')] };
    const fresh = { id: 'fresh', title: 'Fresh', resumable: true, lines: [line('you', 'c'), line('harv', 'd')] };
    // What survives the reload (the tests run without a browser's localStorage).
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v) });
    vi.resetModules();
    const first = await import('./chatStore.ts');
    first.askOnStart([old], 5000);
    expect(first.startQuestions.get()).toEqual(['old']);
    // The page reloads (a fresh module), same server start; "fresh" got its first reply in between.
    vi.resetModules();
    const reloaded = await import('./chatStore.ts');
    reloaded.askOnStart([old, fresh], 5000);
    expect(reloaded.startQuestions.get()).toEqual(['old']);
    // A real restart asks both.
    reloaded.askOnStart([old, fresh], 6000);
    expect(reloaded.startQuestions.get()).toEqual(['old', 'fresh']);
    vi.unstubAllGlobals();
  });

  it('asks each chat on its own; "new" swaps just that tab for a blank chat in the same place', () => {
    const [a, b, c] = [openTab(), openTab(), openTab()];
    startQuestions.set([a, b]);
    answerStart(a, 'continue');
    expect(startQuestions.get()).toEqual([b]);
    expect(tab(a)).toBeDefined();

    const ids = () => getChatState().tabs.map((t) => t.id);
    const at = ids().indexOf(b);
    answerStart(b, 'new');
    expect(startQuestions.get()).toEqual([]);
    expect(ids()).not.toContain(b);
    const blank = ids()[at]!;
    expect(tab(blank).lines).toEqual([]);
    expect(getChatState().activeId).toBe(blank);
    expect(ids()[at + 1]).toBe(c);
  });
});

describe('messages typed while Harv answers', () => {
  it('sends them for the queue without adding a line, and shows the queue the server reports', () => {
    const id = openTab();
    chat.send('first');
    expect(tab(id).busy).toBe(true);
    const lines = tab(id).lines.length;
    chat.send('second');
    expect(tab(id).lines.length).toBe(lines);
    applyChatEvent({ type: 'chat.queued', tabId: id, items: [{ id: 'q1', text: 'second' }] });
    expect(tab(id).queued).toEqual([{ id: 'q1', text: 'second' }]);
    chat.unqueue(id, 'q1');
    expect(tab(id).queued).toEqual([]);
  });

  it('takes a queued message back into the input to edit, with its files', () => {
    const id = openTab();
    chat.send('first');
    const file = { id: 'f1', name: 'car.png', size: 10, type: 'image/png', path: 'x/car.png' } as never;
    applyChatEvent({
      type: 'chat.queued',
      tabId: id,
      items: [{ id: 'q1', text: 'fix the wheel', files: ['car.png'], attachments: [file] }],
    });
    chat.editQueued(id, 'q1');
    expect(tab(id).queued).toEqual([]);
    expect(getDraftTexts()[id]).toBe('fix the wheel');
    expect(getDrafts()[id]?.map((p) => p.file)).toEqual([file]);
  });
});

describe("the other device's tabs (sync)", () => {
  it('takes its blank tabs, order and drafts', () => {
    const a = openTab();
    applyChatEvent({ type: 'chat.renamed', tabId: a, title: 'kept' });
    chat.setActive(a);
    syncLayout({
      order: ['remote-blank', a],
      blanks: ['remote-blank'],
      drafts: { 'remote-blank': 'typed on the laptop' },
      attachments: {},
    });
    const s = getChatState();
    // Blank tabs are as on the laptop (saved chats open and close through the server).
    expect(s.tabs.filter((t) => !t.stored && !t.busy).map((t) => t.id)).toEqual(['remote-blank']);
    expect(s.tabs[0]!.id).toBe('remote-blank');
    expect(getDraftTexts()['remote-blank']).toBe('typed on the laptop');
    expect(s.tabs.some((t) => t.id === s.activeId)).toBe(true);
  });
});
