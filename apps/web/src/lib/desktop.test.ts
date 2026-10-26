import { describe, expect, it } from 'vitest';
import { comboOf } from './desktop.ts';

const key = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe('comboOf (the app hotkey recorder)', () => {
  it('names letters, digits and other keys the way the app parses them', () => {
    expect(comboOf(key('KeyH', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+H');
    expect(comboOf(key('Digit1', { meta: true, shift: true }))).toBe('Shift+Super+1');
    expect(comboOf(key('Space', { ctrl: true }))).toBe('Ctrl+Space');
  });

  it('waits while only modifiers are held', () => {
    expect(comboOf(key('ControlLeft', { ctrl: true }))).toBeNull();
    expect(comboOf(key('AltRight', { ctrl: true, alt: true }))).toBeNull();
  });

  it('refuses combinations that would fire while typing', () => {
    expect(comboOf(key('KeyH'))).toBeNull();
    expect(comboOf(key('KeyH', { shift: true }))).toBeNull();
  });
});
