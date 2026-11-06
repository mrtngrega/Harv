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
