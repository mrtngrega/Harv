import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type LightControl } from '@harv/shared';
import { ControlLog } from './controlLog.ts';
import type { LightsService } from './lights.ts';
import {
  ACTIVE_SEC,
  AutoLights,
  weatherDue,
  decide,
  FRESH_MEMORY,
  parsePresence,
  present,
  sunDark,
  sunOnly,
  WATCH_MAX_SEC,
  type AutoMemory,
  type Weather,
} from './autoLights.ts';

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
const run = (
  now: number,
  radiation: number,
  idleSec: number,
  on: boolean,
  prevWant: boolean | null = null,
  last: Last = null,
  mem: AutoMemory = FRESH_MEMORY,
) => decide({ now, idleSec, weather: weather(radiation), light: { on }, last, cfg }, mem, prevWant);
const dark = { dark: true };

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
  it('turns on at sunset when the user is at the computer, and remembers it’s dark', () => {
    const r = run(day(15, 50), 300, 20, false);
    expect(r.action).toBe('on');
    expect(r.why).toBe('sunset');
    expect(r.mem).toEqual({ dark: true });
    expect(r.want).toBe(true);
  });

  it('turns on on a dark cloudy afternoon, not on a bright one', () => {
    expect(run(day(13), 60, 5, false).action).toBe('on');
    expect(run(day(13), 400, 5, false).action).toBeNull();
  });

  it('waits until the user is back at the computer', () => {
    const r = run(day(18), 0, 400, false);
    expect(r.action).toBeNull();
    expect(r.why).toMatch(/waiting until you’re back/);
    expect(r.want).toBeNull();
    expect(run(day(18), 0, 30, false, r.want, null, r.mem).action).toBe('on');
  });

  it('turns the light off when the user leaves, and on again when they’re back', () => {
    const away = run(day(18, 20), 0, 11 * 60, true, true, { by: 'auto', on: true, at: day(18) }, dark);
    expect(away.action).toBe('off');
    expect(away.why).toBe('away for 11 min');
    expect(run(day(18, 40), 0, 5, false, away.want, { by: 'auto', on: false, at: day(18, 20) }, away.mem).action).toBe('on');
  });

  it('always in charge: off when the user leaves, whoever switched it on', () => {
    for (const by of ['you', 'chat', 'outside'] as const) {
      expect(run(day(18), 0, 20 * 60, true, true, { by, on: true, at: day(17) }, dark).action).toBe('off');
    }
    expect(run(day(18), 0, 20 * 60, true, true, null, dark).action).toBe('off');
  });

  it('a hand switch-off holds until the next change, then it works again', () => {
    const off = { by: 'you' as const, on: false, at: day(18, 5) };
    const r = run(day(18, 6), 0, 5, false, true, off, dark);
    expect(r.action).toBeNull();
    expect(r.why).toMatch(/you switched it off/);
    // The user leaves (nothing to do, it's off) and comes back: on again.
    const left = run(day(19), 0, 15 * 60, false, r.want, off, dark);
    expect(left.action).toBeNull();
    expect(left.want).toBe(false);
    expect(run(day(19, 30), 0, 3, false, left.want, off, dark).action).toBe('on');
  });

  it('a hand switch-on in daylight holds, and is turned off once it’s dark and the user leaves', () => {
    const on = { by: 'you' as const, on: true, at: day(12) };
    const noon = run(day(12), 400, 5, true, false, on);
    expect(noon.action).toBeNull();
    expect(noon.why).toMatch(/light outside, but you turned it on/);
    const evening = run(day(16), 300, 5, true, noon.want, on, noon.mem);
    expect(evening.action).toBeNull();
    expect(evening.want).toBe(true);
    expect(run(day(18), 0, 11 * 60, true, evening.want, on, evening.mem).action).toBe('off');
  });

  it('after a start or a resume it acts whatever the light is (the user’s wish: auto again)', () => {
    expect(run(day(18), 0, 5, false, null, { by: 'you', on: false, at: day(17) }, dark).action).toBe('on');
    expect(run(day(12), 400, 5, true, null, { by: 'you', on: true, at: day(11) }).action).toBe('off');
  });

  it('turns the light off when daylight is back, without flickering on a passing cloud', () => {
    const mem = run(day(13), 60, 5, false).mem;
    const mine = { by: 'auto' as const, on: true, at: day(13) };
    expect(run(day(13, 10), 120, 5, true, true, mine, mem).action).toBeNull();
    const bright = run(day(13, 20), 200, 5, true, true, mine, mem);
    expect(bright.action).toBe('off');
    expect(bright.why).toBe('daylight is back');
  });
});

describe('watching without touching anything (a film, a controller game)', () => {
  const mine = { by: 'auto' as const, on: true, at: day(18) };
  const watch = (idleSec: number, watching?: string) =>
    decide(
      { now: day(20), idleSec, ...(watching ? { watching } : {}), weather: weather(0), light: { on: true }, last: mine, cfg },
      dark,
      true,
    );

  it('a video keeping the screen on or a full-screen app counts as being here', () => {
    expect(watch(40 * 60).action).toBe('off');
    const film = watch(40 * 60, 'something keeps the screen on, like a video');
    expect(film.action).toBeNull();
    expect(film.why).toMatch(/so you count as here/);
  });

  it('but not forever: an app that never lets the screen sleep can’t keep the strip on all night', () => {
    expect(watch(WATCH_MAX_SEC + 60, 'a full-screen app is in front').action).toBe('off');
  });

  it('turns on at sunset while a film plays, even with no input for a while', () => {
    const r = decide(
      {
        now: day(16),
        idleSec: 30 * 60,
        watching: 'a full-screen app is in front',
        weather: weather(300),
        light: { on: false },
        last: null,
        cfg,
      },
      FRESH_MEMORY,
      null,
    );
    expect(r.action).toBe('on');
    expect(r.why).toBe('sunset; a full-screen app is in front');
  });

  it('reads the probe: display requests, full screen, gamepads', () => {
    expect(parsePresence('42 2147483651 5 0:17,\r\n')).toEqual({ idleSec: 42, display: true, fullScreen: false, pads: '0:17,' });
    expect(parsePresence('5 0 3')).toEqual({ idleSec: 5, display: false, fullScreen: true, pads: '' });
    expect(parsePresence('oops')).toBeNull();
  });

  it('a gamepad press is input: idle counts from it', () => {
    const p = { idleSec: 1800, display: false, fullScreen: false, pads: '0:9,' };
    expect(present(p, null, day(20)).idleSec).toBe(1800);
    expect(present(p, day(20) - 30_000, day(20))).toEqual({ idleSec: 30 });
    expect(present({ ...p, display: true }, null, day(20)).watching).toMatch(/video/);
  });
});

describe('the moment the user is back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harv-autolights-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A fake strip and Windows: the user was away for 5 min after dark, then touches the mouse.
  const setup = (gate?: Promise<void>) => {
    const log = new ControlLog(join(dir, `${Math.random()}.json`));
    const light = { id: 'A', name: 'L.E.D', reachable: true, on: false };
    const sets: boolean[] = [];
    const lights = {
      log,
      refresh: async () => [light],
      set: async (_id: string, change: { on: boolean }) => {
        sets.push(change.on);
        light.on = change.on;
        return light;
      },
      status: () => ({ lights: [light] }),
      saveLeavingPlan: () => {},
    } as unknown as LightsService;
    let idleSec = 300;
    let back: (() => void) | null = null;
    let watchers = 0;
    const auto = new AutoLights(lights, {
      settings: () => ({ ...DEFAULT_SETTINGS, autoLights: true, autoLightsPlace: { name: 'Geča', lat: 48.6, lon: 21.3 } }),
      log: () => {},
      changed: () => {},
      now: () => day(17),
      weather: async () => ({ ...weather(0), at: day(17) }),
      presence: async () => {
        const seen = { idleSec, display: false, fullScreen: false, pads: '' };
        await gate;
        return seen;
      },
      inputWatch: (gapSec, onBack) => {
        expect(gapSec).toBe(ACTIVE_SEC);
        watchers++;
        back = onBack;
        return () => watchers--;
      },
    });
    return { auto, sets, light, here: () => (idleSec = 0), back: () => back?.(), watchers: () => watchers };
  };

  it('turns the light on at once when the user touches the mouse, without waiting for the minute', async () => {
    const t = setup();
    await t.auto.tick();
    expect(t.sets).toEqual([]);
    expect(t.watchers()).toBe(1);
    t.here();
    t.back();
    await vi.waitFor(() => expect(t.sets).toEqual([true]));
    t.auto.stop();
    expect(t.watchers()).toBe(0);
  });

  it('a "back" during a running check runs another one right after it', async () => {
    let open = () => {};
    const t = setup(new Promise((r) => (open = r)));
    const first = t.auto.tick();
    await vi.waitFor(() => expect(t.watchers()).toBe(1));
    // The first check has already read "away 5 min" when the mouse moves.
    await new Promise((r) => setTimeout(r, 10));
    t.here();
    t.back();
    open();
    await first;
    await vi.waitFor(() => expect(t.sets).toEqual([true]));
    t.auto.stop();
  });

  it('the AUTO button pauses it (no watcher, nothing switched) and back on it acts at once', async () => {
    const t = setup();
    t.here();
    t.auto.setPaused(true);
    await t.auto.tick();
    expect(t.sets).toEqual([]);
    expect(t.watchers()).toBe(0);
    expect(t.auto.status()).toMatchObject({ paused: true, why: expect.stringMatching(/paused/) });
    t.auto.setPaused(false);
    await vi.waitFor(() => expect(t.sets).toEqual([true]));
    expect(t.auto.status().paused).toBe(false);
    t.auto.stop();
  });

  it('sleep or shutdown turns the light off whoever switched it on, even while paused; back, it goes on again', async () => {
    const t = setup();
    t.light.on = true;
    t.auto.setPaused(true);
    expect(await t.auto.leaving('the computer is shutting down')).toBe(1);
    expect(t.sets).toEqual([false]);
    t.auto.setPaused(false);
    t.here();
    await vi.waitFor(() => expect(t.sets).toEqual([false, true]));
    t.auto.stop();
  });

  it('reads the sunlight a minute after each quarter hour, when Open-Meteo has a new value', () => {
    expect(weatherDue(day(15, 1), day(15, 14))).toBe(false);
    expect(weatherDue(day(15, 14), day(15, 16))).toBe(true);
    expect(weatherDue(day(15, 16), day(15, 30))).toBe(false);
    expect(weatherDue(day(15, 30), day(15, 31))).toBe(true);
  });
});

describe('no internet', () => {
  it('the last sun times carry on, moved to today', () => {
    const w = sunOnly({ sunrise: weather(0).sunrise, sunset: weather(0).sunset }, day(3 * 24 + 12), 0);
    expect(w.radiation).toBeNull();
    expect(w.sunrise[0]).toBe(day(3 * 24 + 6, 19));
    expect(sunDark(day(3 * 24 + 12), w, 30)).toBe(false);
    expect(sunDark(day(3 * 24 + 16), w, 30)).toBe(true);
    expect(sunDark(day(3 * 24 + 23), w, 30)).toBe(true);
  });

  it('without a sunlight reading it goes on at sunset and its light goes off at sunrise', () => {
    const noLight = (now: number, on: boolean, last: Last, mem: AutoMemory) =>
      decide({ now, idleSec: 10, weather: sunOnly(weather(0), now, 0), light: { on }, last, cfg }, mem, want);
    let want: boolean | null = null;
    const noon = noLight(day(12), false, null, FRESH_MEMORY);
    expect(noon.action).toBeNull();
    want = noon.want;
    const evening = noLight(day(15, 50), false, null, noon.mem);
    expect(evening.action).toBe('on');
    expect(evening.why).toBe('sunset');
    want = evening.want;
    const morning = noLight(day(24 + 7), true, { by: 'auto', on: true, at: day(15, 50) }, evening.mem);
    expect(morning.action).toBe('off');
    expect(morning.mem.dark).toBe(false);
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
    log.setAutoState({ dark: true });
    // A fresh reader (a restart) sees all of it.
    const again = new ControlLog(join(dir, 'log.json'));
    expect(again.autoState()).toEqual({ dark: true });
    expect(again.last('B')?.by).toBe('you');
  });

  it('a change noticed at startup keeps when it was noticed, for showing', () => {
    const log = new ControlLog(join(dir, 'seen.json'));
    log.record('A', 'auto', true, 'on (sunset)', 100);
    log.record('A', 'outside', false, 'off (while Harv wasn’t running)', 101, 5000);
    const again = new ControlLog(join(dir, 'seen.json'));
    expect(again.last('A')).toMatchObject({ at: 101, seenAt: 5000, by: 'outside' });
    expect(again.recent(2)[1]).not.toHaveProperty('seenAt');
  });

  it('keeps the last sun times for days without internet', () => {
    const log = new ControlLog(join(dir, 'sun.json'));
    expect(log.sunTimes()).toBeNull();
    log.setSunTimes({ place: '48.1,18.2', sunrise: [1, 3], sunset: [2, 4] });
    expect(new ControlLog(join(dir, 'sun.json')).sunTimes()).toEqual({ place: '48.1,18.2', sunrise: [1, 3], sunset: [2, 4] });
  });

  it('keeps only the latest 60 changes', () => {
    const log = new ControlLog(join(dir, 'many.json'));
    for (let i = 0; i < 70; i++) log.record('A', 'chat', i % 2 === 0, 'x', i);
    expect(log.recent(100)).toHaveLength(60);
    expect(log.recent(1)[0]?.at).toBe(69);
  });
});
