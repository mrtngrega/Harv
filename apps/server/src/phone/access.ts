import type { PhoneStore } from './phones.ts';

// Who may use Harv through its phone address (docs/PLAN.md §6q). Requests for the dashboard's own
// localhost names never come here. Everything else must name this device's tailnet address, come
// through `tailscale serve` from the user's own account, and then belong to a paired phone that did
// Face ID recently (or, for Siri and the share sheet, carry that phone's Shortcut token).

export const DEVICE_COOKIE = 'harv_phone';
export const UNLOCK_COOKIE = 'harv_unlock';

/** Open before pairing: the page asks where it stands, asks for a code and sends it. */
const OPEN = new Set(['GET /api/phone/state', 'POST /api/phone/pair/start', 'POST /api/phone/pair/finish']);
/** Need the device cookie only: making the passkey, Face ID. */
const DEVICE = new Set([
  'POST /api/phone/passkey/options',
  'POST /api/phone/passkey/register',
  'POST /api/phone/unlock/options',
  'POST /api/phone/unlock',
]);
/** Siri and the share sheet (Shortcuts): the phone's Shortcut token instead of cookies. */
const TOKEN = new Set(['POST /api/phone/ask', 'POST /api/phone/share']);

export interface PhoneRequest {
  method: string;
  /** The path without the query. */
  path: string;
  host: string;
  origin?: string;
  fetchSite?: string;
  /** `Tailscale-User-Login`, which `serve` sets for the person whose device made the request. */
  login?: string;
  cookie?: string;
  authorization?: string;
}

export interface PhoneContext {
  enabled: boolean;
  /** This device's MagicDNS name. */
  host: string | null;
  /** This device's Tailscale account. */
  owner: string | null;
  phones: PhoneStore;
}

export type PhoneVerdict = { ok: true; phoneId?: string } | { ok: false; status: 401 | 403; error: string };

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const key = part.slice(0, at).trim();
    try {
      out[key] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      /* a broken cookie is no cookie */
    }
  }
  return out;
}

/** True when this Host is the phone address (the caller then must use `checkPhone`). */
export function isPhoneHost(host: string, ctx: Pick<PhoneContext, 'host'>): boolean {
  return !!ctx.host && host.toLowerCase() === ctx.host;
}

export function checkPhone(req: PhoneRequest, ctx: PhoneContext): PhoneVerdict {
  const deny = (error: string): PhoneVerdict => ({ ok: false, status: 403, error });
  if (!ctx.enabled || !ctx.host || req.host.toLowerCase() !== ctx.host) return deny('Phone access is off');
  // Only the person who owns this computer's Tailscale (not a shared device, not another user).
  if (!ctx.owner || !req.login || req.login.toLowerCase() !== ctx.owner.toLowerCase()) return deny('Not your Tailscale account');
  if (req.origin && req.origin !== `https://${ctx.host}`) return deny('Forbidden origin');
  if (req.fetchSite && req.fetchSite !== 'same-origin' && req.fetchSite !== 'none') return deny('Forbidden');

  const route = `${req.method.toUpperCase()} ${req.path}`;
  if (OPEN.has(route)) return { ok: true };
  if (TOKEN.has(route)) {
    const token = /^Bearer\s+(\S+)$/i.exec(req.authorization ?? '')?.[1];
    const phone = ctx.phones.byShortcut(token);
    return phone ? { ok: true, phoneId: phone.id } : { ok: false, status: 401, error: 'Wrong or old Shortcut token' };
  }
  const cookies = parseCookies(req.cookie);
  const phone = ctx.phones.byDevice(cookies[DEVICE_COOKIE]);
  if (!phone) return { ok: false, status: 401, error: 'This phone isn’t paired' };
  if (DEVICE.has(route)) return { ok: true, phoneId: phone.id };
  if (!phone.passkey) return { ok: false, status: 401, error: 'Finish pairing: make the Face ID passkey' };
  if (ctx.phones.session(cookies[UNLOCK_COOKIE]) !== phone.id) return { ok: false, status: 401, error: 'Locked: unlock with Face ID' };
  return { ok: true, phoneId: phone.id };
}

/** Set-Cookie for the phone: never readable by scripts, never sent cross-site, HTTPS only. */
export function cookie(name: string, value: string, maxAgeS?: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=Strict${maxAgeS !== undefined ? `; Max-Age=${maxAgeS}` : ''}`;
}
