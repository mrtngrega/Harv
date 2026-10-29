import { IS_WINDOWS } from '../platform.ts';
import { run } from '../sync/live.ts';

// Phone access over Tailscale (docs/PLAN.md §6q): `tailscale serve` gives the dashboard an HTTPS
// address inside the user's tailnet only. Harv itself stays on localhost; never Funnel.

/** The Vite dashboard `serve` points at (it proxies /api and /ws to the server). */
export const DASHBOARD_TARGET = 'http://127.0.0.1:5173';

export interface TailnetSelf {
  /** This device's MagicDNS name without the trailing dot, e.g. homepc.tail85d08b.ts.net. */
  host: string | null;
  /** The account that owns this device. */
  owner: string | null;
  /** The tailnet hands out HTTPS certificates (needed for passkeys, push and the home-screen app). */
  https: boolean;
  /** Tailscale answers at all. */
  up: boolean;
}

interface Status {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number };
  User?: Record<string, { LoginName?: string }>;
  CertDomains?: string[] | null;
}

/** Reads `tailscale status --json` into what phone access needs. */
export function parseStatus(raw: string): TailnetSelf {
  const s = JSON.parse(raw) as Status;
  const host = s.Self?.DNSName?.replace(/\.$/, '').toLowerCase() || null;
  return {
    host,
    owner: s.User?.[String(s.Self?.UserID)]?.LoginName ?? null,
    https: !!host && !!s.CertDomains?.some((d) => d.toLowerCase() === host),
    up: s.BackendState === 'Running',
  };
}

export async function tailnetSelf(): Promise<TailnetSelf> {
  try {
    return parseStatus(await run(['status', '--json']));
  } catch {
    return { host: null, owner: null, https: false, up: false };
  }
}

/** True when `serve` already sends this device's HTTPS 443 to the dashboard. */
export function servesDashboard(raw: string, host: string): boolean {
  try {
    const cfg = JSON.parse(raw) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    const proxy = cfg.Web?.[`${host}:443`]?.Handlers?.['/']?.Proxy ?? '';
    return proxy.replace(/\/$/, '') === DASHBOARD_TARGET;
  } catch {
    return false;
  }
}

export async function serving(host: string): Promise<boolean> {
  try {
    return servesDashboard(await run(['serve', 'status', '--json']), host);
  } catch {
    return false;
  }
}

/** Turns `serve` on or off. Returns a problem in the user's words, or null. */
export async function setServe(on: boolean): Promise<string | null> {
  try {
    if (on) await run(['serve', '--bg', '--https=443', DASHBOARD_TARGET]);
    else await run(['serve', '--https=443', 'off']);
    return null;
  } catch (err) {
    const text = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message}`;
    if (/access denied|operator|permission/i.test(text))
      return IS_WINDOWS
        ? 'Tailscale refused: Harv needs to run as the Windows user who is signed in to Tailscale.'
        : 'Tailscale needs your OK once: run `sudo tailscale set --operator=$USER` in a terminal, then turn Phone access on again.';
    if (/https|cert/i.test(text))
      return 'HTTPS certificates are off in your tailnet: open login.tailscale.com/admin/dns and click "Enable HTTPS".';
    if (/not in tailnet|NoState|stopped|not running|logged out/i.test(text)) return 'Tailscale isn’t running on this computer.';
    return `Tailscale serve failed: ${text.trim().slice(0, 200)}`;
  }
}

/** The MagicDNS name of a tailnet address (a peer's phone address), or null. */
export async function nameOf(ip: string): Promise<string | null> {
  try {
    const w = JSON.parse(await run(['whois', '--json', ip])) as { Node?: { Name?: string } };
    return w.Node?.Name?.replace(/\.$/, '').toLowerCase() || null;
  } catch {
    return null;
  }
}
