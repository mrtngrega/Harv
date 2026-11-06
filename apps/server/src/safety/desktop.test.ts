import { describe, expect, it } from 'vitest';
import { actsOnDesktop, classifyDesktop, contains, DESKTOP_TOOLS, monitorLabel, namesAMonitor, pointsOf, workArea } from './desktop.ts';
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

describe('monitors', () => {
  // The user's PC: a big main monitor on the left, a smaller one on the right, a bit lower.
  const left = { device: 'D1', primary: true, left: 0, top: 0, right: 2560, bottom: 1440 };
  const right = { device: 'D2', primary: false, left: 2560, top: 147, right: 4480, bottom: 1227 };
  const both = [left, right];

  it('names monitors the way the user would', () => {
    expect(monitorLabel(left, both)).toBe('left · main');
    expect(monitorLabel(right, both)).toBe('right');
    expect(monitorLabel(left, [left])).toBe('your monitor');
  });

  it('works on the smallest monitor unless the user picked one', () => {
    expect(workArea(both)).toMatchObject({ device: 'D2', label: 'right', region: [2560, 147, 4480, 1227], count: 2 });
    expect(workArea(both, 'D1')?.device).toBe('D1');
    expect(workArea(both, 'gone')?.device).toBe('D2');
    expect(workArea([])).toBeNull();
  });

  it('finds every point an action lands on', () => {
    expect(pointsOf({ loc: [10, 20] })).toEqual([[10, 20]]);
    expect(pointsOf({ loc: '[3000, 400]', from_loc: '5,6' })).toEqual([
      [3000, 400],
      [5, 6],
    ]);
    expect(pointsOf({ locs: '[[1,2],[3,4]]' })).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(pointsOf({ mode: 'resize', window_loc: [100, 100] })).toEqual([[100, 100]]);
    expect(pointsOf({ label: 7 })).toEqual([]);
    expect(contains(right, [3000, 400])).toBe(true);
    expect(contains(right, [100, 100])).toBe(false);
  });

  it('notices when the user names a monitor (English and Slovak), not a left click', () => {
    for (const said of [
      'do it on the left monitor',
      'use the main screen',
      'both displays',
      'on monitor 1',
      'na ľavom monitore',
      'na hlavnej obrazovke',
    ])
      expect(namesAMonitor(said)).toBe(true);
    for (const said of ['left click the button', 'what is on my screen?', 'open Discord', 'take a screenshot'])
      expect(namesAMonitor(said)).toBe(false);
  });
});
