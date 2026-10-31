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
  /** Sunlight on the ground now, W/m²; null without a fresh reading (no internet: the sun times only). */
  radiation: number | null;
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
  /** Seconds since the last mouse, keyboard or gamepad input on this computer. */
  idleSec: number;
  /**
   * Something says the user is watching without touching anything: a playing video keeps the
   * screen on, or a full-screen app is in front ("a video keeps the screen on"). Counts as being
   * here, for up to `WATCH_MAX_SEC` without input.
   */
  watching?: string;
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
/**
 * Watching counts as being here for at most this long without any input: a film is over by then,
 * and an app that keeps the screen on forever (or a video playlist to an empty room) can't keep
 * the strip on all night.
 */
export const WATCH_MAX_SEC = 4 * 3600;
const DAY_MS = 24 * 3600_000;

/**
 * The sun times without fresh weather (no internet): the last ones Harv read, moved on by whole
 * days so today's sunrise comes first (they drift only a minute or two a day). No sunlight
 * reading, so only the sunset part of automatic lights works until the weather is back.
 */
export function sunOnly(sun: Pick<Weather, 'sunrise' | 'sunset'>, now: number, at: number): Weather {
  const first = sun.sunrise[0] ?? now;
  const days = Math.max(0, Math.floor((now - first) / DAY_MS));
  const move = (list: number[]) => list.map((t) => t + days * DAY_MS);
  return { radiation: null, sunrise: move(sun.sunrise), sunset: move(sun.sunset), at };
}

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
  const sunlight = weather.radiation;
  if (bySun || (sunlight !== null && sunlight < cfg.autoLightsDark)) {
    // A new dark spell: it was light at the last check, or the sun rose since this one began (the PC
    // was off through the morning, so Harv never saw the daylight in between).
    const sunRoseSince = weather.sunrise.some((t) => t > mem.darkSince && t <= now);
    if (!mem.dark || sunRoseSince) mem.darkSince = now;
    mem.dark = true;
    // Without a sunlight reading only the sun decides (a cloudy-day spell ends with no way to tell).
  } else if (sunlight === null || sunlight > cfg.autoLightsDark * BRIGHT_FACTOR) mem.dark = false;
  // Harv's to turn off only while automatic lights were the last to change it.
  const mine = last?.by === 'auto';
  const idleAway = idleSec >= cfg.autoLightsAway * 60;
  const watched = !!input.watching && idleSec < WATCH_MAX_SEC;
  const away = idleAway && !watched;

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
  const seen = idleAway && watched ? ` (${input.watching}, so you count as here)` : '';
  if (light.on)
    return { action: null, why: mine ? `dark, light on${seen}` : `dark, on (${last ? `${WHO[last.by]} turned it on` : 'it was on'})`, mem };
  // Switched off by someone else since it got dark: theirs until it gets light again.
  if (last && !mine && !last.on && last.at >= mem.darkSince) {
    return { action: null, why: `dark, but ${WHO[last.by]} switched it off (until it gets light)`, mem };
  }
  if (idleSec > ACTIVE_SEC && !watched) return { action: null, why: 'dark, waiting until you’re back at the computer', mem };
  const reason = bySun || sunlight === null ? 'sunset' : `little sunlight (${Math.round(sunlight)} W/m²)`;
  return { action: 'on', why: idleSec > ACTIVE_SEC ? `${reason}; ${input.watching}` : reason, mem };
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

/** What Windows says about the user being here, read once a minute. */
export interface Presence {
  /** Seconds since the last mouse or keyboard input (GetLastInputInfo). */
  idleSec: number;
  /** Some program keeps the display on (a playing video, a game): ES_DISPLAY_REQUIRED in the system's state. */
  display: boolean;
  /** A full-screen app or presentation is in front (SHQueryUserNotificationState). */
  fullScreen: boolean;
  /** The connected XInput gamepads' packet numbers ("0:1234"): any change is gamepad input. */
  pads: string;
}

// A small C# type, compiled once per PowerShell start; about a third of a second each minute. None
// of it needs admin: the system's execution state is everyone's display requests together
// (powercfg /requests, which names them, does need it).
const PRESENCE_PS = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class HarvHere {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  [DllImport("powrprof.dll")] static extern uint CallNtPowerInformation(int level, IntPtr inBuf, uint inLen, out uint outBuf, uint outLen);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [StructLayout(LayoutKind.Sequential)] struct XS { public uint packet; public ushort buttons; public byte lt, rt; public short lx, ly, rx, ry; }
  [DllImport("xinput1_4.dll")] static extern uint XInputGetState(uint idx, out XS s);
  public static string Read() {
    var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l);
    uint idle = ((uint)Environment.TickCount - l.dwTime) / 1000;
    uint exec = 0; try { CallNtPowerInformation(16, IntPtr.Zero, 0, out exec, 4); } catch {}
    int quns = 0; try { SHQueryUserNotificationState(out quns); } catch {}
    var pads = ""; try { for (uint i = 0; i < 4; i++) { XS s; if (XInputGetState(i, out s) == 0) pads += i + ":" + s.packet + ","; } } catch {}
    return idle + " " + exec + " " + quns + " " + pads;
  }
}
'@
[HarvHere]::Read()`;

/** "idle exec quns pads" from the probe. QUNS 2 busy (full screen), 3 D3D full screen, 4 presentation. */
export function parsePresence(line: string): Presence | null {
  const [idle, exec, quns, pads = ''] = line.trim().split(/\s+/);
  const idleSec = Number(idle);
  if (!Number.isFinite(idleSec)) return null;
  return { idleSec, display: (Number(exec) & 0x2) !== 0, fullScreen: [2, 3, 4].includes(Number(quns)), pads };
}

export async function readPresence(): Promise<Presence | null> {
  if (!IS_WINDOWS) return null;
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PRESENCE_PS], {
      windowsHide: true,
      timeout: 15_000,
    });
    return parsePresence(stdout);
  } catch {
    return null;
  }
}

export interface AutoDeps {
  settings: () => HarvSettings;
  log: (message: string) => void;
  /** Changed: the dashboards hear it with the lights. */
  changed: () => void;
  presence?: () => Promise<Presence | null>;
  weather?: (lat: number, lon: number) => Promise<Weather>;
  now?: () => number;
}

/** What the presence signals add up to: idle time with gamepad input counted, and why the user counts as watching. */
export function present(p: Presence, gamepadAt: number | null, now: number): { idleSec: number; watching?: string } {
  const idleSec = gamepadAt === null ? p.idleSec : Math.min(p.idleSec, Math.max(0, Math.round((now - gamepadAt) / 1000)));
  const watching = p.fullScreen ? 'a full-screen app is in front' : p.display ? 'something keeps the screen on, like a video' : undefined;
  return watching ? { idleSec, watching } : { idleSec };
}

const TICK_MS = 60_000;
const WEATHER_MS = 10 * 60_000;

export class AutoLights {
  private mem: AutoMemory;
  private weather: Weather | null = null;
  private weatherFor = '';
  private idleSec: number | null = null;
  private watching: string | undefined;
  /** The gamepads' packet numbers at the last check, and when they last changed. */
  private pads: string | null = null;
  private gamepadAt: number | null = null;
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
    // The last sun times read, so a start without internet still knows when the sun sets.
    const sun = lights.log.sunTimes();
    if (sun) this.weather = sunOnly(sun, (deps.now ?? Date.now)(), 0);
  }

  /**
   * The computer is going to sleep, shutting down or logging off (the Harv app hears Windows say
   * so): a light automatic lights turned on goes off now, or it would stay on all night.
   */
  async leaving(reason: string): Promise<number> {
    let n = 0;
    for (const light of this.lights.status().lights) {
      if (!light.reachable || !light.on || light.control?.by !== 'auto') continue;
      try {
        await this.lights.set(light.id, { on: false }, 'auto', `off (${reason})`);
        this.last = { action: 'off', why: reason, at: (this.deps.now ?? Date.now)() };
        this.deps.log(`Automatic lights: ${light.name} off (${reason})`);
        n++;
      } catch (err) {
        this.deps.log(`Automatic lights: couldn’t turn ${light.name} off (${reason}): ${(err as Error).message}`);
      }
    }
    this.deps.changed();
    return n;
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
      ...(this.weather
        ? {
            ...(this.weather.radiation !== null ? { sunlight: Math.round(this.weather.radiation), weatherAt: this.weather.at } : {}),
            sunset: this.nextSunset(),
          }
        : {}),
      ...(this.idleSec !== null ? { idleSec: this.idleSec } : {}),
      ...(this.watching ? { watching: this.watching } : {}),
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
      if (!this.weather || this.weather.radiation === null || this.weatherFor !== place || now - this.weather.at > WEATHER_MS) {
        try {
          this.weather = await (this.deps.weather ?? fetchWeather)(s.autoLightsPlace.lat, s.autoLightsPlace.lon);
          this.weatherFor = place;
          this.lights.log.setSunTimes({ place, sunrise: this.weather.sunrise, sunset: this.weather.sunset });
          this.problem = undefined;
        } catch (err) {
          // No internet: the sunlight reading is good for half an hour, then the sun times carry on
          // alone (the last ones read, for this place, moved on to today).
          const sun = this.lights.log.sunTimes();
          const stale = !this.weather || this.weather.radiation === null || now - this.weather.at > 3 * WEATHER_MS;
          if (stale) {
            if (!sun || sun.place !== place) {
              this.problem = `No weather: ${(err as Error).message}`;
              return;
            }
            this.weather = sunOnly(sun, now, this.weather?.at ?? 0);
            this.weatherFor = place;
          }
          this.problem = `No weather (${(err as Error).message})${stale ? ': going by sunset and sunrise only' : ''}`;
        }
      }
      const seen = await (this.deps.presence ?? readPresence)();
      if (!seen) {
        this.idleSec = null;
        this.why = 'can’t tell whether you’re at this computer';
        return;
      }
      if (this.pads !== null && seen.pads !== this.pads) this.gamepadAt = now;
      this.pads = seen.pads;
      const here = present(seen, this.gamepadAt, now);
      this.idleSec = here.idleSec;
      this.watching = here.watching;
      const [light] = (await this.lights.refresh()).filter((l) => l.reachable);
      if (!light) {
        this.why = 'the light isn’t reachable';
        return;
      }
      const result = decide(
        {
          now,
          idleSec: this.idleSec,
          ...(this.watching ? { watching: this.watching } : {}),
          weather: this.weather!,
          light: { on: !!light.on },
          last: light.control ?? null,
          cfg: s,
        },
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
