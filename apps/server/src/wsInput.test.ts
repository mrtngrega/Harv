import { describe, expect, it } from 'vitest';
import { malformed } from './wsInput.ts';

describe('dashboard messages', () => {
  it('lets real ones through', () => {
    expect(malformed({ type: 'ping' })).toBeNull();
    expect(malformed({ type: 'chat.send', tabId: 'a', text: 'hi', attachments: [] })).toBeNull();
    expect(malformed({ type: 'chat.rewind', tabId: 'a', fromEnd: 2 })).toBeNull();
    expect(malformed({ type: 'history.search', query: 'x' })).toBeNull();
    expect(malformed({ type: 'term.resize', id: 't', cols: 80, rows: 24 })).toBeNull();
    expect(malformed({ type: 'lights.get' })).toBeNull();
  });

  it('refuses the ones that crashed into the chat code (the test pass)', () => {
    expect(malformed({ type: 'chat.send' })).toBe('no tab');
    expect(malformed({ type: 'chat.send', tabId: 5, text: null })).toBe("tabId isn't text");
    expect(malformed({ type: 'chat.send', tabId: 'a', text: null })).toBe("text isn't text");
    expect(malformed({ type: 'chat.send', tabId: 'a' })).toBe('no text');
  });

  it('refuses odd shapes', () => {
    expect(malformed(null)).toBe('not an object');
    expect(malformed([1])).toBe('not an object');
    expect(malformed({ type: 3 })).toBe('no type');
    expect(malformed({ type: 'chat.stop', tabId: '' })).toBe('no tab');
    expect(malformed({ type: 'term.resize', id: 't', cols: 'wide', rows: 24 })).toBe("cols isn't a number");
    expect(malformed({ type: 'lights.set', id: { mac: 1 }, change: {} })).toBe("id isn't text");
  });
});
