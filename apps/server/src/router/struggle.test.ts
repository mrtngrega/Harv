import { describe, expect, it } from 'vitest';
import { StruggleWatch } from './struggle.ts';

describe('noticing a reply going badly', () => {
  it('failing tests step up at once', () => {
    const w = new StruggleWatch();
    w.toolUse('1', 'npm test');
    expect(w.toolResult('1', true, ' Test Files  1 failed | 35 passed\n      Tests  2 failed | 600 passed')).toBe('the tests failed');
  });

  it('Node\'s own test runner failing steps up; "0 failed" doesn\'t', () => {
    const w = new StruggleWatch();
    w.toolUse('1', 'node --test t.mjs');
    expect(w.toolResult('1', false, '# tests 1\n# pass 1\n# fail 0\n 0 failed')).toBeNull();
    w.toolUse('2', 'node --test t.mjs');
    expect(w.toolResult('2', true, '# tests 1\n# pass 0\n# fail 1')).toBe('the tests failed');
  });

  it('a build error steps up at once', () => {
    const w = new StruggleWatch();
    w.toolUse('1', 'npx tsc --noEmit');
    expect(w.toolResult('1', true, "src/a.ts(3,1): error TS2304: Cannot find name 'x'.")).toBe('the build failed');
  });

  it('two failed calls in a row step up; a success in between resets', () => {
    const w = new StruggleWatch();
    w.toolUse('1', 'node run.js');
    expect(w.toolResult('1', true, 'Exit code 1')).toBeNull();
    w.toolUse('2', 'node fix.js');
    expect(w.toolResult('2', false, 'ok')).toBeNull();
    w.toolUse('3', 'node run.js');
    expect(w.toolResult('3', true, 'Exit code 1')).toBeNull();
    expect(w.toolResult('4', true, 'String to replace not found in file.')).toBe('2 tool calls failed in a row');
  });

  it('a search that finds nothing is not a failure', () => {
    const w = new StruggleWatch();
    for (const [id, cmd] of [
      ['1', 'grep -r foo src'],
      ['2', 'rg bar'],
      ['3', 'Select-String -Path x -Pattern y'],
    ]) {
      w.toolUse(id!, cmd);
      expect(w.toolResult(id!, true, 'Exit code 1')).toBeNull();
    }
  });

  it('a search printing a word like "failed" is not a failure either', () => {
    const w = new StruggleWatch();
    w.toolUse('1', 'grep -rn "3 failed" logs');
    expect(w.toolResult('1', false, 'logs/a.log:12: 3 failed')).toBeNull();
  });

  it('saying it is stuck counts only right after a failure', () => {
    const w = new StruggleWatch();
    expect(w.said("I'm not sure why this happens, let me look.")).toBeNull();
    w.toolUse('1', 'node run.js');
    w.toolResult('1', true, 'Exit code 1');
    expect(w.said("That didn't work. I'm not sure why the port is still taken.")).toBe('it got stuck after a failure');
  });

  it('a new reply starts from zero', () => {
    const w = new StruggleWatch();
    w.toolResult('1', true, 'x');
    w.reset();
    expect(w.toolResult('2', true, 'x')).toBeNull();
  });
});
