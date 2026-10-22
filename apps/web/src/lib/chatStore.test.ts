import { describe, expect, it } from 'vitest';
import { applyChatEvent, chat, getChatState } from './chatStore.ts';

function openTab(): string {
  chat.newTab();
  return getChatState().tabs.at(-1)!.id;
}

const tab = (id: string) => getChatState().tabs.find((t) => t.id === id)!;

describe('chat stream handling', () => {
  it('builds a reply from started → delta → tool → delta → done', () => {
    const tabId = openTab();
    applyChatEvent({ type: 'chat.started', tabId, model: 'Sonnet 5.5', effort: 'medium', auto: true });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'Let me ' });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'check.' });
    applyChatEvent({ type: 'chat.tool', tabId, name: 'Read', detail: 'notes.md' });
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
    applyChatEvent({ type: 'chat.started', tabId, model: 'Haiku 5.5', effort: 'low', auto: false });
    applyChatEvent({ type: 'chat.delta', tabId, text: 'Hel' });
    applyChatEvent({ type: 'chat.assistant', tabId, text: 'Hello!' });
    applyChatEvent({ type: 'chat.done', tabId, ok: true, stopped: false });
    expect(tab(tabId).lines.map((l) => l.text)).toEqual(['Hello!']);
  });

  it('drops the empty thinking line when a turn is stopped', () => {
    const tabId = openTab();
    applyChatEvent({ type: 'chat.started', tabId, model: 'Opus 5.5', effort: 'high', auto: false });
    applyChatEvent({ type: 'chat.done', tabId, ok: false, stopped: true });
    expect(tab(tabId).lines.map((l) => [l.kind, l.text])).toEqual([['notice', 'Stopped.']]);
  });
});
