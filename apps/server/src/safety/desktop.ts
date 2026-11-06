import type { Tier } from '@harv/shared';

// Desktop control (docs/PLAN.md §6t item 1): Windows-MCP's tools, judged by the gate. Looking at
// the screen is green. Anything that moves the mouse, types or switches windows is red, and the
// gate asks once per reply before the first of them, even with "Ask before risky actions" off
// (the agreed rule, 2026-11-06): a click on a coordinate can do anything, and a misread message
// must never drive the user's desktop unasked. Nobody to ask (a scheduled or background turn):
// refused. Windows-MCP's own shell, file, registry, process and web tools are never started
// (WINDOWS_MCP_TOOLS); if one shows up anyway it's blocked, as is App's launch_executable.

/** The name chats see the server under: its tools are mcp__desktop__<Tool>. */
export const DESKTOP_SERVER = 'desktop';
const PREFIX = `mcp__${DESKTOP_SERVER}__`;

/** Tools that only look (Notification shows a Windows toast; it changes nothing). */
const LOOKS = ['Snapshot', 'Screenshot', 'DisplayInventory', 'Wait', 'WaitFor', 'ControlStatus', 'Notification'];
/** Tools that act on the desktop. */
const ACTS = ['Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'MultiSelect', 'MultiEdit', 'App', 'Clipboard'];
/** The tools Windows-MCP is started with (an allow-list: tools a later version adds never appear by themselves). */
export const DESKTOP_TOOLS = [...LOOKS, ...ACTS];

export interface DesktopVerdict {
  tier: Tier;
  reason: string;
  summary: string;
}

export const isDesktopTool = (tool: string) => tool.startsWith(PREFIX);

const text = (v: unknown, max = 60) => {
  const s = typeof v === 'string' ? v : '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const truthy = (v: unknown) => v === true || v === 'true';

/** Where a click or a scroll lands: an element from the last Snapshot, or a point on the screen. */
function target(input: Record<string, unknown>): string {
  if (typeof input.label === 'number') return `element #${input.label} from the last snapshot`;
  if (Array.isArray(input.loc)) return `(${input.loc.join(', ')})`;
  if (typeof input.loc === 'string' && input.loc) return input.loc;
  return 'where the mouse is';
}

export function classifyDesktop(tool: string, input: Record<string, unknown>): DesktopVerdict {
  const name = tool.slice(PREFIX.length);
  const acts = (summary: string): DesktopVerdict => ({
    tier: 'red',
    reason: 'Uses your mouse or keyboard: Harv asks once per reply before it takes over.',
    summary,
  });
  if (LOOKS.includes(name)) return { tier: 'green', reason: 'Only reads the screen.', summary: `desktop: ${name}` };
  switch (name) {
    case 'Click': {
      const button = input.button && input.button !== 'left' ? `${String(input.button)}-` : '';
      const times = typeof input.clicks === 'number' && input.clicks > 1 ? ` ×${input.clicks}` : '';
      return acts(`${button}click ${target(input)}${times}`);
    }
    case 'Type':
      return acts(
        `type “${text(input.text)}”${input.loc !== undefined || input.label !== undefined ? ` into ${target(input)}` : ''}${truthy(input.press_enter) ? ' and press Enter' : ''}`,
      );
    case 'Scroll':
      return acts(`scroll ${typeof input.direction === 'string' ? input.direction : 'down'} at ${target(input)}`);
    case 'Move':
      return acts(truthy(input.drag) ? `drag to ${target(input)}` : `move the mouse to ${target(input)}`);
    case 'Shortcut':
      return acts(`press ${text(input.shortcut, 40)}`);
    case 'MultiSelect':
      return acts('select several items');
    case 'MultiEdit':
      return acts('fill in several fields');
    case 'Clipboard':
      if (input.mode === 'get') return { tier: 'green', reason: 'Only reads the clipboard.', summary: 'desktop: read the clipboard' };
      return acts(`copy “${text(input.text)}” to the clipboard`);
    case 'App': {
      const mode = typeof input.mode === 'string' ? input.mode : 'launch';
      const app = text(input.name, 40) || 'an app';
      if (mode === 'launch_executable')
        return {
          tier: 'blocked',
          reason: 'Running a program by its path goes through Harv’s own shell tools, where it is checked like any command.',
          summary: `run ${text(input.executable, 80)}`,
        };
      if (mode === 'switch') return acts(`switch to ${app}`);
      if (mode === 'resize') return acts(`move or resize ${app}`);
      return acts(`open ${app}`);
    }
  }
  return {
    tier: 'blocked',
    reason: `${name} isn’t enabled in Harv’s desktop control; use Harv’s own tools for that (they’re checked and backed up).`,
    summary: `desktop: ${name}`,
  };
}

/** A desktop call that takes over the mouse or keyboard (the once-per-reply card). */
export const actsOnDesktop = (tool: string, input: Record<string, unknown>) =>
  isDesktopTool(tool) && classifyDesktop(tool, input).tier === 'red';

// ── Monitors (the user's wish, 2026-11-06: Harv works on one monitor, the smaller one unless they
// pick another in Settings, and on the others only when they say so) ─────────────────────────────

/** A monitor in Windows-MCP's coordinates: one virtual desktop across all monitors, physical pixels. */
export interface Monitor {
  device: string;
  primary: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The monitor Harv works on, with a name the user would use ("right", "left · main"). */
export interface WorkArea extends Monitor {
  label: string;
  /** Snapshot/Screenshot's `region` for it: [left, top, right, bottom]. */
  region: [number, number, number, number];
  /** How many monitors there are (with one, nothing is limited). */
  count: number;
}

const area = (m: Monitor) => (m.right - m.left) * (m.bottom - m.top);

/** "left", "right" or "middle" by position, "· main" for the primary one ("your monitor" when there's one). */
export function monitorLabel(m: Monitor, all: Monitor[]): string {
  if (all.length < 2) return 'your monitor';
  const xs = all.map((x) => x.left);
  const where = m.left === Math.min(...xs) ? 'left' : m.left === Math.max(...xs) ? 'right' : 'middle';
  return m.primary ? `${where} · main` : where;
}

/** The monitor the user picked (Settings › Desktop control), else the smallest one. */
export function workArea(all: Monitor[], chosen = ''): WorkArea | null {
  if (!all.length) return null;
  const pick =
    all.find((m) => m.device === chosen) ?? [...all].sort((a, b) => area(a) - area(b) || Number(a.primary) - Number(b.primary))[0]!;
  return { ...pick, label: monitorLabel(pick, all), region: [pick.left, pick.top, pick.right, pick.bottom], count: all.length };
}

export const contains = (m: Monitor, [x, y]: [number, number]) => x >= m.left && x < m.right && y >= m.top && y < m.bottom;

/** A point from a tool's input: [x, y] or "x,y" / "[x, y]". */
function point(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')) return [v[0] as number, v[1] as number];
  if (typeof v === 'string') {
    const m = /^\s*\[?\s*(-?\d+)\s*,\s*(-?\d+)\s*\]?\s*$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return null;
}

/** Every screen point a desktop action lands on or moves a window to (labels from a Snapshot have none). */
export function pointsOf(input: Record<string, unknown>): [number, number][] {
  const out: [number, number][] = [];
  for (const key of ['loc', 'from_loc', 'window_loc']) {
    const p = point(input[key]);
    if (p) out.push(p);
  }
  let locs = input.locs;
  if (typeof locs === 'string') {
    try {
      locs = JSON.parse(locs);
    } catch {
      locs = undefined;
    }
  }
  if (Array.isArray(locs))
    for (const l of locs) {
      const p = point(l);
      if (p) out.push(p);
    }
  return out;
}

/**
 * The user's message names a monitor ("on the left monitor", "the main screen", "both displays",
 * "na ľavom monitore"): then Harv may work on any of them in this reply.
 */
const NAMES_A_MONITOR = [
  /(?<![\p{L}])(left|right|middle|main|primary|other|second|first|big(ger)?|large(r)?|small(er)?|both|all|each)\s+(monitor|screen|display)s?(?![\p{L}])/iu,
  /(?<![\p{L}])(monitor|screen|display)\s*(#?\d)(?![\p{L}\d])/iu,
  /(?<![\p{L}])(ľav|lav|prav|hlavn|druh|prv|veľk|velk|men[sš]|ob[ae]|obidv|v[sš]etk)\p{L}*\s+(monitor|obrazovk|displej)\p{L}*/iu,
];
export const namesAMonitor = (message: string) => NAMES_A_MONITOR.some((re) => re.test(message));
