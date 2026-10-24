import { describe, expect, it, vi } from 'vitest';
import { applyChatEvent, chat, getChatState } from './chatStore.ts';

vi.mock('./socket.ts', () => ({ onServerMessage: () => {}, sendMessage: () => true }));

function openTab(): string {
  chat.newTab();
  return getChatState().tabs.at(-1)!.id;
}

const tab = (id: string) => getChatState().tabs.find((t) => t.id === id)!;

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
    expect(getChatState().routed).toBe('Sonnet 5.5 · medium');
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
