import { describe, expect, it } from 'vitest';
import { actsOnDesktop, classifyDesktop, DESKTOP_TOOLS } from './desktop.ts';
import { classify, isSending } from './classify.ts';

const d = (name: string) => `mcp__desktop__${name}`;
const tier = (name: string, input: Record<string, unknown> = {}) => classifyDesktop(d(name), input).tier;

describe('desktop control (Windows-MCP)', () => {
  it('lets looking at the screen through without asking', () => {
    for (const name of ['Snapshot', 'Screenshot', 'DisplayInventory', 'Wait', 'WaitFor', 'ControlStatus']) expect(tier(name)).toBe('green');
    expect(tier('Clipboard', { mode: 'get' })).toBe('green');
    // Plan mode lets connector reads through by this reason.
    expect(classifyDesktop(d('Snapshot'), {}).reason.startsWith('Only reads')).toBe(true);
  });

  it('treats the mouse, the keyboard and switching windows as acting', () => {
    for (const name of ['Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'MultiSelect', 'MultiEdit']) {
      expect(tier(name, { text: 'x', shortcut: 'ctrl+c' })).toBe('red');
      expect(actsOnDesktop(d(name), {})).toBe(true);
    }
    expect(tier('Clipboard', { mode: 'set', text: 'hi' })).toBe('red');
    expect(tier('App', { mode: 'switch', name: 'Discord' })).toBe('red');
    expect(tier('App', { name: 'Notepad' })).toBe('red');
    expect(actsOnDesktop(d('Snapshot'), {})).toBe(false);
  });

  it('blocks running a program by path and any tool Harv never enabled', () => {
    expect(tier('App', { mode: 'launch_executable', executable: 'C:\\x\\evil.exe' })).toBe('blocked');
    for (const name of ['PowerShell', 'FileSystem', 'Registry', 'Process', 'Scrape', 'SomethingNew']) expect(tier(name)).toBe('blocked');
    expect(actsOnDesktop(d('PowerShell'), {})).toBe(false);
  });

  it('only starts tools it knows how to judge', () => {
    for (const name of DESKTOP_TOOLS) expect(tier(name, { mode: 'get' })).not.toBe('blocked');
  });

  it('says what it will do in plain words', () => {
    expect(classifyDesktop(d('Click'), { label: 12 }).summary).toBe('click element #12 from the last snapshot');
    expect(classifyDesktop(d('Click'), { loc: [10, 20], button: 'right', clicks: 2 }).summary).toBe('right-click (10, 20) ×2');
    expect(classifyDesktop(d('Type'), { text: 'hello', label: 3, press_enter: true }).summary).toBe(
      'type “hello” into element #3 from the last snapshot and press Enter',
    );
    expect(classifyDesktop(d('Shortcut'), { shortcut: 'ctrl+v' }).summary).toBe('press ctrl+v');
    expect(classifyDesktop(d('App'), { mode: 'switch', name: 'Discord' }).summary).toBe('switch to Discord');
  });

  it('goes through classify, and never counts as sending (it has its own card)', () => {
    expect(classify(d('Click'), { label: 1 }).tier).toBe('red');
    expect(classify(d('Snapshot'), {}).tier).toBe('green');
    expect(isSending(d('Notification'), {})).toBe(false);
    expect(isSending(d('Type'), { text: 'send it' })).toBe(false);
  });
});
