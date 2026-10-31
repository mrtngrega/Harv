import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AutoLightsStatus, HarvSettings, LightControl } from '@harv/shared';
import { IS_WINDOWS } from '../platform.ts';
import type { LightsService } from './lights.ts';

// Automatic lights (the user's wish, 2026-10-31; docs/PLAN.md §6z "Automatic lights"): the light
// goes on when it's dark outside (little sunlight on the ground: clouds, rain, dusk; or from a
// while before sunset until sunrise) and the user is at this computer; off when they leave, or when
// daylight is back, but only if Harv turned it on. Switched off by hand, it stays off until the
// next dark spell. No model calls: the weather is Open-Meteo (free, no key), presence is the time
// since the last mouse or keyboard input. Pure logic in `decide`, tested with a fake clock.

export interface Weather {
  /** Sunlight on the ground now, W/m². */
  radiation: number;
  /** Today's and tomorrow's, epoch ms. */
  sunrise: number[];
  sunset: number[];
  at: number;
}

/**
 * Automatic lights' own state, kept in the control log's file so it survives a restart. Whose the
 * light is comes from the log of who took control last (`LightControl`), not from here.
 */
export interface AutoMemory {
  /** It counted as dark at the last check (kept between the on and off thresholds). */
  dark: boolean;
  /** When this dark spell began (ms): switched off by the user since then, it stays off. */
  darkSince: number;
}

export const FRESH_MEMORY: AutoMemory = { dark: false, darkSince: 0 };

export interface AutoInput {
  now: number;
  /** Seconds since the last mouse or keyboard input on this computer. */
  idleSec: number;
  weather: Weather;
  light: { on: boolean };
  /** Who changed the light last (null: nobody Harv knows of). */
  last: Pick<LightControl, 'by' | 'on' | 'at'> | null;
  cfg: Pick<HarvSettings, 'autoLightsDark' | 'autoLightsSunset' | 'autoLightsAway'>;
}

/** Back at the computer: input within this long turns the light on (a longer pause is "maybe away"). */
export const ACTIVE_SEC = 120;
/** Daylight is back when sunlight is this much above the dark threshold (no flicker on a passing cloud). */
const BRIGHT_FACTOR = 1.5;

/** Between (sunset − the margin) and the next sunrise. */
export function sunDark(now: number, w: Weather, beforeMin: number): boolean {
  if (w.sunrise[0] !== undefined && now < w.sunrise[0]) return true;
  return w.sunset.some((set, i) => now >= set - beforeMin * 60_000 && (w.sunrise[i + 1] === undefined || now < w.sunrise[i + 1]!));
}

const WHO: Record<LightControl['by'], string> = { auto: 'automatic lights', you: 'you', chat: 'a chat', outside: 'outside Harv' };

export function decide(input: AutoInput, before: AutoMemory): { action: 'on' | 'off' | null; why: string; mem: AutoMemory } {
  const { now, idleSec, weather, light, last, cfg } = input;
  const mem = { ...before };
  const bySun = sunDark(now, weather, cfg.autoLightsSunset);
  if (bySun || weather.radiation < cfg.autoLightsDark) {
    // A new dark spell: it was light at the last check, or the sun rose since this one began (the PC
    // was off through the morning, so Harv never saw the daylight in between).
    const sunRoseSince = weather.sunrise.some((t) => t > mem.darkSince && t <= now);
    if (!mem.dark || sunRoseSince) mem.darkSince = now;
    mem.dark = true;
  } else if (weather.radiation > cfg.autoLightsDark * BRIGHT_FACTOR) mem.dark = false;
  // Harv's to turn off only while automatic lights were the last to change it.
  const mine = last?.by === 'auto';
  const away = idleSec >= cfg.autoLightsAway * 60;

  if (!mem.dark) {
    if (mine && light.on) return { action: 'off', why: 'daylight is back', mem };
    return { action: null, why: 'light outside', mem };
  }
  if (away) {
    if (mine && light.on) return { action: 'off', why: `away for ${Math.round(idleSec / 60)} min`, mem };
    return {
      action: null,
      why: light.on ? `dark, you’re away, but ${WHO[last?.by ?? 'outside']} turned it on` : 'dark, but you’re away',
      mem,
    };
  }
  if (light.on)
    return { action: null, why: mine ? 'dark, light on' : `dark, on (${last ? `${WHO[last.by]} turned it on` : 'it was on'})`, mem };
  // Switched off by someone else since it got dark: theirs until it gets light again.
  if (last && !mine && !last.on && last.at >= mem.darkSince) {
    return { action: null, why: `dark, but ${WHO[last.by]} switched it off (until it gets light)`, mem };
  }
  if (idleSec > ACTIVE_SEC) return { action: null, why: 'dark, waiting until you’re back at the computer', mem };
  return { action: 'on', why: bySun ? 'sunset' : `little sunlight (${Math.round(weather.radiation)} W/m²)`, mem };
}

/** Open-Meteo: sunlight now, sunrise and sunset (free, no key; only the coordinates leave). */
export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    '&current=shortwave_radiation&daily=sunrise,sunset&timezone=auto&timeformat=unixtime&forecast_days=2';
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const data = (await res.json()) as { current?: { shortwave_radiation?: number }; daily?: { sunrise?: number[]; sunset?: number[] } };
  const radiation = data.current?.shortwave_radiation;
  if (typeof radiation !== 'number' || !data.daily?.sunrise?.length || !data.daily.sunset?.length)
    throw new Error('Open-Meteo sent no sunlight data');
  return { radiation, sunrise: data.daily.sunrise.map((s) => s * 1000), sunset: data.daily.sunset.map((s) => s * 1000), at: Date.now() };
}

/** A place by name, for Settings (Open-Meteo's geocoding, free). */
export async function findPlace(name: string): Promise<HarvSettings['autoLightsPlace']> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.trim())}&count=1&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = (await res.json()) as {
    results?: { name: string; latitude: number; longitude: number; admin1?: string; country_code?: string }[];
  };
  const hit = data.results?.[0];
  return hit ? { name: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', '), lat: hit.latitude, lon: hit.longitude } : null;
}

// Seconds since the last input in the user's session (Windows' GetLastInputInfo). A small C# type,
// compiled once per PowerShell start; about a third of a second each minute.
const IDLE_PS = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class HarvIdle {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  public static uint Seconds() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return ((uint)Environment.TickCount - l.dwTime) / 1000; }
}
'@
[HarvIdle]::Seconds()`;

export async function idleSeconds(): Promise<number | null> {
  if (!IS_WINDOWS) return null;
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', IDLE_PS], {
      windowsHide: true,
      timeout: 15_000,
    });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface AutoDeps {
  settings: () => HarvSettings;
  log: (message: string) => void;
  /** Changed: the dashboards hear it with the lights. */
  changed: () => void;
  idle?: () => Promise<number | null>;
  weather?: (lat: number, lon: number) => Promise<Weather>;
  now?: () => number;
}

const TICK_MS = 60_000;
const WEATHER_MS = 10 * 60_000;

export class AutoLights {
  private mem: AutoMemory;
  private weather: Weather | null = null;
  private weatherFor = '';
  private idleSec: number | null = null;
  private why = '';
  private last: { action: 'on' | 'off'; why: string; at: number } | null = null;
  private problem: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private lights: LightsService,
    private deps: AutoDeps,
  ) {
    this.mem = lights.log.autoState() ?? { ...FRESH_MEMORY };
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): AutoLightsStatus {
    const s = this.deps.settings();
    return {
      enabled: s.autoLights,
      supported: IS_WINDOWS,
      ...(this.weather ? { sunlight: Math.round(this.weather.radiation), sunset: this.nextSunset(), weatherAt: this.weather.at } : {}),
      ...(this.idleSec !== null ? { idleSec: this.idleSec } : {}),
      dark: this.mem.dark,
      why: this.why,
      ...(this.last ? { last: this.last } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  private nextSunset(): number | undefined {
    const now = (this.deps.now ?? Date.now)();
    return this.weather?.sunset.find((t) => t > now - 3 * 3600_000);
  }

  /** One check: weather (every 10 min), presence, the light, then what to do. */
  async tick(): Promise<void> {
    const s = this.deps.settings();
    if (!s.autoLights || !s.autoLightsPlace || this.running) {
      return;
    }
    this.running = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      const place = `${s.autoLightsPlace.lat},${s.autoLightsPlace.lon}`;
      if (!this.weather || this.weatherFor !== place || now - this.weather.at > WEATHER_MS) {
        try {
          this.weather = await (this.deps.weather ?? fetchWeather)(s.autoLightsPlace.lat, s.autoLightsPlace.lon);
          this.weatherFor = place;
          this.problem = undefined;
        } catch (err) {
          this.problem = `No weather: ${(err as Error).message}`;
          if (!this.weather || now - this.weather.at > 3 * WEATHER_MS) return;
        }
      }
      this.idleSec = await (this.deps.idle ?? idleSeconds)();
      if (this.idleSec === null) {
        this.why = 'can’t tell whether you’re at this computer';
        return;
      }
      const [light] = (await this.lights.refresh()).filter((l) => l.reachable);
      if (!light) {
        this.why = 'the light isn’t reachable';
        return;
      }
      const result = decide(
        { now, idleSec: this.idleSec, weather: this.weather!, light: { on: !!light.on }, last: light.control ?? null, cfg: s },
        this.mem,
      );
      this.mem = result.mem;
      this.lights.log.setAutoState(this.mem);
      this.why = result.why;
      if (result.action) {
        try {
          await this.lights.set(light.id, { on: result.action === 'on' }, 'auto', `${result.action} (${result.why})`);
          this.last = { action: result.action, why: result.why, at: now };
          this.deps.log(`Automatic lights: ${light.name} ${result.action} (${result.why})`);
        } catch (err) {
          this.problem = (err as Error).message;
        }
      }
    } finally {
      this.running = false;
      this.deps.changed();
    }
  }
}
