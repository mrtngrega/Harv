import { describe, expect, it } from 'vitest';
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
const run = (now: number, radiation: number, idleSec: number, on: boolean, mem: AutoMemory = FRESH_MEMORY) =>
  decide({ now, idleSec, weather: weather(radiation), light: { on }, cfg }, mem);

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
  it('turns on at sunset when the user is at the computer', () => {
    const r = run(day(15, 50), 300, 20, false);
    expect(r.action).toBe('on');
    expect(r.why).toBe('sunset');
    expect(r.mem.owned).toBe(true);
  });

  it('turns on on a dark cloudy afternoon, not on a bright one', () => {
    expect(run(day(13), 60, 5, false).action).toBe('on');
    expect(run(day(13), 400, 5, false).action).toBeNull();
  });

  it('waits until the user is back at the computer', () => {
    const r = run(day(18), 0, 400, false);
    expect(r.action).toBeNull();
    expect(r.why).toMatch(/waiting until you’re back/);
    expect(run(day(18), 0, 30, false, r.mem).action).toBe('on');
  });

  it('turns off when the user leaves, and on again when they’re back', () => {
    const on = run(day(18), 0, 10, false).mem;
    const away = run(day(18, 20), 0, 11 * 60, true, on);
    expect(away.action).toBe('off');
    expect(away.why).toBe('away for 11 min');
    expect(run(day(18, 40), 0, 5, false, away.mem).action).toBe('on');
  });

  it('never turns off a light the user switched on', () => {
    const r = run(day(18), 0, 20 * 60, true);
    expect(r.action).toBeNull();
    expect(r.mem.owned).toBe(false);
  });

  it('switched off by hand: stays off until it gets light, then works again', () => {
    const on = run(day(18), 0, 10, false).mem;
    const byHand = run(day(18, 5), 0, 10, false, on);
    expect(byHand.action).toBeNull();
    expect(byHand.mem.suppressed).toBe(true);
    expect(run(day(22), 0, 10, false, byHand.mem).action).toBeNull();
    // Morning: light again, the hand switch is forgotten.
    const morning = run(day(24 + 9), 400, 10, false, byHand.mem);
    expect(morning.mem.suppressed).toBe(false);
    expect(run(day(24 + 16), 300, 10, false, morning.mem).action).toBe('on');
  });

  it('turns its own light off when daylight is back, without flickering on a passing cloud', () => {
    const on = run(day(13), 60, 5, false).mem;
    // 120 W/m²: above the threshold but not clearly bright: stays.
    expect(run(day(13, 10), 120, 5, true, on).action).toBeNull();
    const bright = run(day(13, 20), 200, 5, true, on);
    expect(bright.action).toBe('off');
    expect(bright.why).toBe('daylight is back');
  });

  it('a change by hand from on to on (colour, brightness) keeps it Harv’s', () => {
    const on = run(day(18), 0, 10, false).mem;
    expect(run(day(18, 1), 0, 10, true, on).mem.owned).toBe(true);
  });
});
