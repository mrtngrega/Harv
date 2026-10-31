/** The user's Tapo light strips (docs/PLAN.md §6z), controlled on the home Wi-Fi. */

/** One light Harv controls: its state as last read, or why it couldn't be read. */
export interface LightState {
  /** The light's hardware address (MAC, "EC:75:0C:EA:F1:9F"): it stays when the router hands out a new IP. */
  id: string;
  /** The name it has in the Tapo app. */
  name: string;
  model?: string;
  /** Answered the last time it was asked. */
  reachable: boolean;
  on?: boolean;
  /** 1–100. */
  brightness?: number;
  /** Colour (0–360, 0–100), when it shows one. */
  hue?: number;
  saturation?: number;
  /** White temperature in kelvin, when it shows white (2500 warm … 9000 cold). */
  temp?: number;
  tempRange?: [number, number];
  /** A built-in effect that's running ("Aurora"), or null. */
  effect?: string | null;
  effects?: string[];
  error?: string;
  /** When it was last read (ms). */
  at?: number;
}

/** A light found on the network (before the user picks which ones Harv controls). */
export interface FoundLight {
  id: string;
  ip: string;
  model: string;
  /** Harv controls it. */
  chosen: boolean;
  /** It refused the user's Tapo login: never tried again until the login changes (each try counts toward its lockout). */
  refused: boolean;
}

export interface LightsStatus {
  /** `missing`: the light helper isn't installed on this computer yet (`setupCommand` does it once). */
  setup: 'ready' | 'missing' | 'nologin';
  setupCommand?: string;
  lights: LightState[];
  /** The last scan's lights (Settings › Devices). */
  found: FoundLight[];
  problem?: string;
  /** Automatic lights on this computer (docs/PLAN.md §6z). */
  auto?: AutoLightsStatus;
}

/** What automatic lights see and did, for Settings › Devices. */
export interface AutoLightsStatus {
  enabled: boolean;
  /** It needs to know the user is at the computer: Windows only for now. */
  supported: boolean;
  /** Sunlight on the ground now (W/m²), and when the weather was read. */
  sunlight?: number;
  weatherAt?: number;
  /** Today's (or tomorrow's) sunset, epoch ms. */
  sunset?: number;
  /** Seconds since the last mouse or keyboard input. */
  idleSec?: number;
  dark: boolean;
  /** Why it does what it does right now ("dark, but you're away"). */
  why: string;
  last?: { action: 'on' | 'off'; why: string; at: number };
  problem?: string;
}

/** What to change on a light; anything left out stays. A colour, a white or an effect also turns it on. */
export interface LightChange {
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
  temp?: number;
  /** An effect's name, or "Off" to stop it. */
  effect?: string;
}

export type LightsClientMessage =
  | { type: 'lights.get' }
  | { type: 'lights.set'; id: string; change: LightChange }
  | { type: 'lights.scan' }
  /** Harv controls this light (true) or leaves it alone (false). */
  | { type: 'lights.choose'; id: string; chosen: boolean };

export type LightsServerMessage = { type: 'lights'; status: LightsStatus };

/** A light's colour as #rrggbb for the dashboard's swatch (white: a warm-to-cold tint). */
export function swatch(light: { hue?: number; saturation?: number; temp?: number; brightness?: number }): string {
  if (light.temp) {
    // 2500 K amber-ish … 9000 K bluish white.
    const t = Math.min(1, Math.max(0, (light.temp - 2500) / 6500));
    const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
    return `#${[mix(255, 210), mix(190, 225), mix(130, 255)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  const h = (light.hue ?? 0) / 60;
  const s = (light.saturation ?? 0) / 100;
  const c = s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = 1 - c;
  return `#${[r, g, b]
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
