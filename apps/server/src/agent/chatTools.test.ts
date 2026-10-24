import { describe, expect, it } from 'vitest';
import { ChatStore } from '../store/chats.ts';
import { chatList, formatTranscript, recentChatsContext } from './chatTools.ts';

describe('chat tools', () => {
  it('lists chats with their state and marks this one', () => {
    const at = new Date(2026, 9, 22).getTime();
    const list = chatList(
      [
        { id: 'a', title: 'Weather', updatedAt: at, open: true },
        { id: 'b', title: 'Old one', updatedAt: at, open: false, snippet: '…rain…' },
      ],
      'a',
    );
    expect(list).toBe('- a · "Weather" · 22 Oct 2026 · open tab · this chat\n- b · "Old one" · 22 Oct 2026 · closed\n  match: …rain…');
  });

  it('formats a transcript and keeps the newest lines when it is long', () => {
    expect(
      formatTranscript([
        { kind: 'you', text: 'look', files: ['shot.png'] },
        { kind: 'tool', text: 'Read · a.txt' },
        { kind: 'harv', text: 'Done.' },
      ]),
    ).toBe('user: look [attached: shot.png]\n  tool: Read · a.txt\nharv: Done.');

    const long = Array.from({ length: 40 }, (_, i) => ({ kind: 'harv' as const, text: `${i} ${'x'.repeat(1990)}` }));
    const out = formatTranscript(long);
    expect(out.startsWith('(…earlier lines left out)')).toBe(true);
    expect(out.endsWith(`39 ${'x'.repeat(1990)}`)).toBe(true);
    expect(out.length).toBeLessThan(17_000);
  });

  it('leaves the current chat out of the recent list', () => {
    const store = new ChatStore(':memory:');
    store.ensureChat('a', 'This one');
    store.addLine('a', { kind: 'you', text: 'hi' });
    store.ensureChat('b', 'Other one');
    store.addLine('b', { kind: 'you', text: 'hi' });
    const context = recentChatsContext(store, 'a');
    expect(context).toContain('"Other one"');
    expect(context).not.toContain('"This one"');
    store.close();
  });
});
