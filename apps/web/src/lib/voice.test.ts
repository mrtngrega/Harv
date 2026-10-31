import { describe, expect, it } from 'vitest';
import { lastReply, speakable, splitSentences } from './voice.ts';

describe('voice mode', () => {
  it('reads plain words, not Markdown or code', () => {
    expect(speakable('**Done.** See `npm test`:\n```\nok\n```\n- [the docs](https://x.y)')).toBe(
      'Done. See npm test: (code in the chat) the docs',
    );
    expect(speakable('Open https://example.com/page now')).toBe('Open a link now');
  });

  it('speaks whole sentences as the reply streams and keeps the rest for later', () => {
    expect(splitSentences('The build passed. Two tests')).toEqual({ done: 'The build passed.', rest: ' Two tests' });
    expect(splitSentences('Still going')).toEqual({ done: '', rest: 'Still going' });
    // A number like 3.5 isn't a sentence end (no space after the dot).
    expect(splitSentences('It is 3.5 GB')).toEqual({ done: '', rest: 'It is 3.5 GB' });
  });
});

describe('lastReply', () => {
  it('reads Harv’s text after the last message, skipping tools and thinking', () => {
    const lines = [
      { kind: 'you', text: 'old question' },
      { kind: 'harv', text: 'old answer' },
      { kind: 'you', text: 'where did we end?' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'harv', text: 'Let me look.' },
      { kind: 'tool', text: 'Read PLAN.md' },
      { kind: 'harv', text: 'We stopped at the radio app.' },
    ];
    expect(lastReply(lines)).toBe('Let me look. We stopped at the radio app.');
    expect(lastReply([])).toBe('');
  });
});
