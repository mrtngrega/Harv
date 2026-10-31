import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AutoLightsStatus, HarvSettings } from '@harv/shared';
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

export interface AutoMemory {
  /** It counted as dark at the last check (kept between the on and off thresholds). */
  dark: boolean;
  /** Harv turned the light on, so Harv may turn it off. */
  owned: boolean;
  /** The user switched it off while dark: left alone until it gets light again. */
  suppressed: boolean;
  /** The light's on/off as last seen (after Harv's own change), to notice a change by hand. */
  seenOn: boolean | null;
}

export const FRESH_MEMORY: AutoMemory = { dark: false, owned: false, suppressed: false, seenOn: null };

export interface AutoInput {
  now: number;
  /** Seconds since the last mouse or keyboard input on this computer. */
  idleSec: number;
  weather: Weather;
  light: { on: boolean };
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

export function decide(input: AutoInput, before: AutoMemory): { action: 'on' | 'off' | null; why: string; mem: AutoMemory } {
  const { now, idleSec, weather, light, cfg } = input;
  const mem = { ...before };
  const byHand = mem.seenOn !== null && mem.seenOn !== light.on;
  mem.seenOn = light.on;
  if (byHand) {
    // Switched by hand (the app, a chat, the card): it's the user's now.
    mem.owned = false;
    if (!light.on && mem.dark) mem.suppressed = true;
  }

  const bySun = sunDark(now, weather, cfg.autoLightsSunset);
  if (bySun || weather.radiation < cfg.autoLightsDark) mem.dark = true;
  else if (weather.radiation > cfg.autoLightsDark * BRIGHT_FACTOR) mem.dark = false;
  const away = idleSec >= cfg.autoLightsAway * 60;

  if (!mem.dark) {
    mem.suppressed = false;
    if (mem.owned && light.on) return off(mem, 'daylight is back');
    return { action: null, why: 'light outside', mem };
  }
  if (away) {
    if (mem.owned && light.on) return off(mem, `away for ${Math.round(idleSec / 60)} min`);
    return { action: null, why: 'dark, but you’re away', mem };
  }
  if (light.on) return { action: null, why: mem.owned ? 'dark, light on' : 'dark, already on (by hand)', mem };
  if (mem.suppressed) return { action: null, why: 'dark, but you switched it off (until it gets light)', mem };
  if (idleSec > ACTIVE_SEC) return { action: null, why: 'dark, waiting until you’re back at the computer', mem };
  mem.owned = true;
  mem.seenOn = true;
  return { action: 'on', why: bySun ? 'sunset' : `little sunlight (${Math.round(weather.radiation)} W/m²)`, mem };
}

function off(mem: AutoMemory, why: string) {
  return { action: 'off' as const, why, mem: { ...mem, owned: false, seenOn: false } };
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
  private mem: AutoMemory = { ...FRESH_MEMORY };
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
  ) {}

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
      if (!s.autoLights) this.mem = { ...FRESH_MEMORY };
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
      const result = decide({ now, idleSec: this.idleSec, weather: this.weather!, light: { on: !!light.on }, cfg: s }, this.mem);
      this.mem = result.mem;
      this.why = result.why;
      if (result.action) {
        try {
          await this.lights.set(light.id, { on: result.action === 'on' });
          this.last = { action: result.action, why: result.why, at: now };
          this.deps.log(`Automatic lights: ${light.name} ${result.action} (${result.why})`);
        } catch (err) {
          this.problem = (err as Error).message;
          // Not done: next time it's seen as it really is, not as a change by hand.
          this.mem.seenOn = !!light.on;
          if (result.action === 'on') this.mem.owned = false;
        }
      }
    } finally {
      this.running = false;
      this.deps.changed();
    }
  }
}
