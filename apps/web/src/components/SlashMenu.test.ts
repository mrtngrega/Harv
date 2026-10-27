import { describe, expect, it } from 'vitest';
import { matchCommands } from './SlashMenu.tsx';

const cc = [
  { name: 'compact', description: 'Free up context', argumentHint: '' },
  { name: 'context', description: 'Show context usage', argumentHint: '' },
  { name: 'code-review', description: 'Review the diff', argumentHint: '[level]' },
];

describe('slash menu', () => {
  it('lists commands while a /name is typed, name matches first', () => {
    expect(matchCommands('/co', cc).map((c) => c.name)).toEqual(['compact', 'context', 'code-review']);
    expect(matchCommands('/view', cc).map((c) => c.name)).toEqual(['code-review']);
    expect(
      matchCommands('/', cc)
        .map((c) => c.name)
        .slice(0, 6),
    ).toEqual(['model', 'attach', 'new', 'plan', 'rewind', 'help']);
  });

  it('closes once arguments start, and for normal text or paths', () => {
    expect(matchCommands('/compact keep', cc)).toEqual([]);
    expect(matchCommands('hello /co', cc)).toEqual([]);
    expect(matchCommands('/c/Users', cc)).toEqual([]);
  });
});
