import { describe, expect, it } from 'vitest';
import { atToken, insideFolder, withoutToken } from './PathMenu.tsx';

describe('@ paths in the command line', () => {
  it('finds the @path being typed at the end, spaces included', () => {
    expect(atToken('look at @C:\\My files\\Co')).toEqual({ start: 8, query: 'C:\\My files\\Co' });
    expect(atToken('@~/Doc')).toEqual({ start: 0, query: '~/Doc' });
    expect(atToken('@')).toEqual({ start: 0, query: '' });
  });

  it('ignores an @ inside a word, an earlier line, and text with no @', () => {
    expect(atToken('mail me at martin@example.com')).toBeNull();
    expect(atToken('@C:\\x\nnow something else')).toBeNull();
    expect(atToken('no path here')).toBeNull();
  });

  it('takes the @path out of the draft once it becomes a chip', () => {
    expect(withoutToken('tidy up @C:\\Users\\me\\Rep', 8)).toBe('tidy up ');
    expect(withoutToken('@C:\\x', 0)).toBe('');
  });

  it('walks into a folder with the separator of its OS', () => {
    expect(insideFolder('C:\\Users\\me')).toBe('C:\\Users\\me\\');
    expect(insideFolder('C:\\')).toBe('C:\\');
    expect(insideFolder('/home/me')).toBe('/home/me/');
  });
});
