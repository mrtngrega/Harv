import { describe, expect, it } from 'vitest';
import { speakable, splitSentences } from './voice.ts';

describe('voice mode', () => {
  it('reads plain words, not Markdown or code', () => {
    expect(speakable('**Done.** See `npm test`:\n```\nok\n```\n- [the docs](https://x.y)')).toBe('Done. See npm test: (code in the chat) the docs');
    expect(speakable('Open https://example.com/page now')).toBe('Open a link now');
  });

  it('speaks whole sentences as the reply streams and keeps the rest for later', () => {
    expect(splitSentences('The build passed. Two tests')).toEqual({ done: 'The build passed.', rest: ' Two tests' });
    expect(splitSentences('Still going')).toEqual({ done: '', rest: 'Still going' });
    // A number like 3.5 isn't a sentence end (no space after the dot).
    expect(splitSentences('It is 3.5 GB')).toEqual({ done: '', rest: 'It is 3.5 GB' });
  });
});
