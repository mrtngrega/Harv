import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LightControl } from '@harv/shared';
import { ControlLog } from './controlLog.ts';
import { decide, FRESH_MEMORY, sunDark, type AutoMemory, type Weather } from './autoLights.ts';

// A day in Geča: sunrise 06:19, sunset 16:16 (31 Oct), the next sunrise 06:20.
const day = (h: number, m = 0) => Date.UTC(2026, 9, 31, h - 1, m); // CET = UTC+1
const weather = (radiation: number): Weather => ({
  radiation,
  sunrise: [day(6, 19), day(24 + 6, 20)],
  sunset: [day(16, 16), day(24 + 16, 15)],
  at: 0,
});
const cfg = { autoLightsDark: 100, autoLightsSunset: 30, autoLightsAway: 10 };
type Last = Pick<LightControl, 'by' | 'on' | 'at'> | null;
const run = (now: number, radiation: number, idleSec: number, on: boolean, last: Last = null, mem: AutoMemory = FRESH_MEMORY) =>
  decide({ now, idleSec, weather: weather(radiation), light: { on }, last, cfg }, mem);

describe('dark by the sun', () => {
  it('from 30 min before sunset until sunrise', () => {
    expect(sunDark(day(12), weather(500), 30)).toBe(false);
    expect(sunDark(day(15, 50), weather(500), 30)).toBe(true);
    expect(sunDark(day(23), weather(500), 30)).toBe(true);
    expect(sunDark(day(5), weather(500), 30)).toBe(true);
    expect(sunDark(day(24 + 7), weather(500), 30)).toBe(false);
  });
});

describe('automatic lights', () => {
  it('turns on at sunset when the user is at the computer, and remembers when it got dark', () => {
    const r = run(day(15, 50), 300, 20, false);
    expect(r.action).toBe('on');
    expect(r.why).toBe('sunset');
    expect(r.mem).toEqual({ dark: true, darkSince: day(15, 50) });
  });

  it('turns on on a dark cloudy afternoon, not on a bright one', () => {
    expect(run(day(13), 60, 5, false).action).toBe('on');
    expect(run(day(13), 400, 5, false).action).toBeNull();
  });

  it('waits until the user is back at the computer', () => {
    const r = run(day(18), 0, 400, false);
    expect(r.action).toBeNull();
    expect(r.why).toMatch(/waiting until you’re back/);
    expect(run(day(18), 0, 30, false, null, r.mem).action).toBe('on');
  });

  it('turns its own light off when the user leaves, and on again when they’re back', () => {
    const mem = run(day(18), 0, 10, false).mem;
    const away = run(day(18, 20), 0, 11 * 60, true, { by: 'auto', on: true, at: day(18) }, mem);
    expect(away.action).toBe('off');
    expect(away.why).toBe('away for 11 min');
    expect(run(day(18, 40), 0, 5, false, { by: 'auto', on: false, at: day(18, 20) }, away.mem).action).toBe('on');
  });

  it('leaves a light on that someone else switched on last, whoever it was', () => {
    for (const by of ['you', 'chat', 'outside'] as const) {
      const r = run(day(18), 0, 20 * 60, true, { by, on: true, at: day(17) });
      expect(r.action).toBeNull();
    }
    // Nobody Harv knows of (it was on before Harv logged anything): left alone too.
    expect(run(day(18), 0, 20 * 60, true).action).toBeNull();
  });

  it('a light automatic lights turned on is still theirs after a restart (it’s in the log)', () => {
    const r = run(day(19), 0, 15 * 60, true, { by: 'auto', on: true, at: day(16) }, { dark: true, darkSince: day(15, 46) });
    expect(r.action).toBe('off');
  });

  it('switched off by someone else since it got dark: stays off until it gets light, then works again', () => {
    const mem = { dark: true, darkSince: day(15, 46) };
    const off = { by: 'you' as const, on: false, at: day(18, 5) };
    const r = run(day(22), 0, 10, false, off, mem);
    expect(r.action).toBeNull();
    expect(r.why).toMatch(/you switched it off/);
    // Morning: light again; the next dark spell starts later than that switch-off.
    const morning = run(day(24 + 9), 400, 10, false, off, r.mem);
    expect(morning.mem.dark).toBe(false);
    const evening = run(day(24 + 16), 300, 10, false, off, morning.mem);
    expect(evening.action).toBe('on');
  });

  it('the user’s night: switched off by hand, the PC off overnight, on again after dark the next day', () => {
    // Tonight: dark since 15:46, the user switches the strip off at 22:00 and shuts the PC down.
    const tonight = { dark: true, darkSince: day(15, 46) };
    const off = { by: 'you' as const, on: false, at: day(22) };
    expect(run(day(22, 1), 0, 5, false, off, tonight).action).toBeNull();
    // Tomorrow at 18:00 the PC starts again: Harv never saw the morning, but the sun rose since.
    const tomorrow = run(day(24 + 18), 0, 5, false, off, tonight);
    expect(tomorrow.mem.darkSince).toBe(day(24 + 18));
    expect(tomorrow.action).toBe('on');
    // Started during the day instead: also on once it gets dark.
    const noon = run(day(24 + 12), 400, 5, false, off, tonight);
    expect(noon.action).toBeNull();
    expect(run(day(24 + 16), 300, 5, false, off, noon.mem).action).toBe('on');
  });

  it('a hand switch-off earlier the same night still holds after a Harv restart', () => {
    const tonight = { dark: true, darkSince: day(15, 46) };
    const r = run(day(23), 0, 5, false, { by: 'you', on: false, at: day(21) }, tonight);
    expect(r.action).toBeNull();
    expect(r.mem.darkSince).toBe(day(15, 46));
  });

  it('a switch-off from before it got dark doesn’t keep it off', () => {
    const r = run(day(16), 300, 10, false, { by: 'you', on: false, at: day(10) }, { dark: false, darkSince: 0 });
    expect(r.action).toBe('on');
  });

  it('turns its own light off when daylight is back, without flickering on a passing cloud', () => {
    const mem = run(day(13), 60, 5, false).mem;
    const mine = { by: 'auto' as const, on: true, at: day(13) };
    expect(run(day(13, 10), 120, 5, true, mine, mem).action).toBeNull();
    const bright = run(day(13, 20), 200, 5, true, mine, mem);
    expect(bright.action).toBe('off');
    expect(bright.why).toBe('daylight is back');
  });
});

describe('the log of who took control', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harv-lightlog-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the latest per light, newest first, and automatic lights’ state', () => {
    const log = new ControlLog(join(dir, 'log.json'));
    expect(log.last('A')).toBeNull();
    log.record('A', 'auto', true, 'on (sunset)', 1);
    log.record('B', 'you', false, 'off', 2);
    log.record('A', 'outside', false, 'off', 3);
    expect(log.last('A')).toMatchObject({ by: 'outside', on: false, at: 3 });
    expect(log.recent(2).map((e) => e.at)).toEqual([3, 2]);
    log.setAutoState({ dark: true, darkSince: 5 });
    // A fresh reader (a restart) sees all of it.
    const again = new ControlLog(join(dir, 'log.json'));
    expect(again.autoState()).toEqual({ dark: true, darkSince: 5 });
    expect(again.last('B')?.by).toBe('you');
  });

  it('keeps only the latest 60 changes', () => {
    const log = new ControlLog(join(dir, 'many.json'));
    for (let i = 0; i < 70; i++) log.record('A', 'chat', i % 2 === 0, 'x', i);
    expect(log.recent(100)).toHaveLength(60);
    expect(log.recent(1)[0]?.at).toBe(69);
  });
});
