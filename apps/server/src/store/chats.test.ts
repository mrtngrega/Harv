import { afterEach, describe, expect, it } from 'vitest';
import { ChatStore, snippetAround } from './chats.ts';

let store: ChatStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

function fresh(): ChatStore {
  store = new ChatStore(':memory:');
  return store;
}

describe('ChatStore', () => {
  it('saves chats and restores open ones with their lines', () => {
    const s = fresh();
    s.ensureChat('a', 'Weather');
    s.addLine('a', { kind: 'you', text: 'rain tomorrow?' });
    s.addLine('a', { kind: 'harv', text: 'Light rain after 3pm.', tag: 'haiku·low' });
    s.ensureChat('b', 'Closed one');
    s.setOpen('b', false);

    expect(s.openChats()).toEqual([
      {
        id: 'a',
        title: 'Weather',
        lines: [
          { kind: 'you', text: 'rain tomorrow?', at: expect.any(Number) },
          { kind: 'harv', text: 'Light rain after 3pm.', tag: 'haiku·low', at: expect.any(Number) },
        ],
      },
    ]);
  });

  it('keeps the context size and routing reason', () => {
    const s = fresh();
    s.ensureChat('a', 'Ctx');
    s.addLine('a', { kind: 'harv', text: 'ok', tag: 'sonnet·medium', reason: 'question, difficulty 3' });
    s.setContext('a', 4600);
    const snap = s.snapshot('a')!;
    expect(snap.context).toBe(4600);
    expect(snap.lines[0]).toMatchObject({ tag: 'sonnet·medium', reason: 'question, difficulty 3' });
  });

  it('keeps the first title when a chat is ensured again', () => {
    const s = fresh();
    s.ensureChat('a', 'First');
    s.ensureChat('a', 'Second');
    expect(s.snapshot('a')!.title).toBe('First');
  });

  it('remembers the Claude session id for resuming', () => {
    const s = fresh();
    s.ensureChat('a', 'x');
    expect(s.getSession('a')).toBeNull();
    s.setSession('a', 'sess-1');
    expect(s.getSession('a')).toBe('sess-1');
  });

  it('searches titles and line text, with a snippet', () => {
    const s = fresh();
    s.ensureChat('a', 'GPU temps');
    s.addLine('a', { kind: 'you', text: 'how hot?' });
    s.ensureChat('b', 'Shopping');
    s.addLine('b', { kind: 'harv', text: 'Buy a new thermal paste for the GPU cooler.' });
    s.ensureChat('c', 'Unrelated');
    s.addLine('c', { kind: 'you', text: 'hello' });

    const hits = s.history('gpu');
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b']);
    expect(hits.find((h) => h.id === 'b')!.snippet).toContain('GPU cooler');
  });

  it('treats % and _ in searches literally', () => {
    const s = fresh();
    s.ensureChat('a', '100% done');
    s.addLine('a', { kind: 'you', text: 'x' });
    s.ensureChat('b', '100 done');
    s.addLine('b', { kind: 'you', text: 'x' });
    expect(s.history('100%').map((h) => h.id)).toEqual(['a']);
  });

  it('leaves chats without messages out of history (tabs used only for their terminal or files)', () => {
    const s = fresh();
    s.ensureChat('talk', 'Weather');
    s.addLine('talk', { kind: 'you', text: 'rain?' });
    s.ensureChat('term', 'Terminal');
    s.setOpen('term', false);
    expect(s.history().map((h) => h.id)).toEqual(['talk']);
    expect(s.history('terminal')).toEqual([]);
  });

  it('deletes a chat with its lines', () => {
    const s = fresh();
    s.ensureChat('a', 'x');
    s.addLine('a', { kind: 'you', text: 'hi' });
    s.delete('a');
    expect(s.exists('a')).toBe(false);
    expect(s.history()).toEqual([]);
  });
});

describe('snippetAround', () => {
  it('centres on the match and marks cut-offs', () => {
    const text = `${'a'.repeat(100)} needle ${'b'.repeat(100)}`;
    const snip = snippetAround(text, 'needle');
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('needle');
  });

  it('keeps the names of attached files with the line', () => {
    const s = fresh();
    s.ensureChat('a', 'Files');
    s.addLine('a', { kind: 'you', text: 'look', files: ['shot.png', 'report.pdf'] });
    expect(s.snapshot('a')!.lines).toEqual([{ kind: 'you', text: 'look', files: ['shot.png', 'report.pdf'], at: expect.any(Number) }]);
  });
});
