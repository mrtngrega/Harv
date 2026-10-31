import type { LightChange } from '@harv/shared';

// What a chat (or Siri) says about a light's colour, turned into what the strip takes: a colour as
// hue/saturation, or a white as kelvin. Pure and tested; the strips themselves are in lights.ts.

/** Colours by name (hue 0–360, saturation 0–100). */
const NAMED: Record<string, [number, number]> = {
  red: [0, 100],
  orange: [30, 100],
  amber: [38, 100],
  gold: [45, 100],
  yellow: [55, 100],
  lime: [90, 100],
  green: [120, 100],
  mint: [150, 50],
  teal: [175, 100],
  cyan: [185, 100],
  turquoise: [175, 75],
  'sky blue': [200, 60],
  blue: [235, 100],
  indigo: [260, 100],
  violet: [275, 80],
  purple: [280, 100],
  magenta: [300, 100],
  pink: [330, 60],
  'hot pink': [330, 100],
  rose: [345, 70],
};

/** Whites by name (kelvin). */
const WHITES: Record<string, number> = {
  candle: 2500,
  'warm white': 2700,
  warm: 2700,
  'soft white': 3000,
  white: 4000,
  neutral: 4000,
  'neutral white': 4000,
  'cool white': 5000,
  cool: 5500,
  daylight: 6500,
  cold: 6500,
  'cold white': 6500,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** #rgb / #rrggbb → hue, saturation (the strip's brightness stays its own). */
function fromHex(hex: string): [number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (max === 0) return [0, 0];
  let hue = 0;
  if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [clamp((hue * 60 + 360) % 360, 0, 359), clamp((d / max) * 100, 0, 100)];
}

/**
 * A colour as said: a name ("teal", "warm white"), a hex code, or kelvin ("2700K", "3000").
 * Null when it isn't one.
 */
export function parseColor(said: string): Pick<LightChange, 'hue' | 'saturation' | 'temp'> | null {
  const text = said.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text in WHITES) return { temp: WHITES[text] };
  if (text in NAMED) {
    const [hue, saturation] = NAMED[text]!;
    return { hue, saturation };
  }
  const k = /^(\d{4})\s*k?$/.exec(text);
  if (k) return { temp: Number(k[1]) };
  const hex = fromHex(text);
  if (hex) return { hue: hex[0], saturation: hex[1] };
  return null;
}

export const COLOR_NAMES = [...Object.keys(NAMED), ...Object.keys(WHITES)];

/** A white temperature within what the light can do. */
export const fitTemp = (k: number, range: [number, number] = [2500, 9000]) => clamp(k, range[0], range[1]);
