import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PhoneState } from '@harv/shared';

// The dashboard opened on the phone through `tailscale serve` (docs/PLAN.md §6q). Everything here
// talks to /api/phone/*; the cookies it gets are HttpOnly, so this code never sees a secret.

/** This window is the phone's (the tailnet address), not the computer's own dashboard. */
export const isPhone = typeof location !== 'undefined' && location.hostname.endsWith('.ts.net');

/** Opened from the home screen (iOS keeps a separate cookie jar for it, so pairing must happen there). */
export const standalone =
  typeof window !== 'undefined' &&
  ((navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches);

export const isIos = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Harv answered ${res.status}`);
  return data;
}

export const phoneState = () => call<PhoneState>('/api/phone/state');

/** A name for the computer's pairing toast. */
function phoneName(): string {
  if (/iPhone/.test(navigator.userAgent)) return 'iPhone';
  if (/iPad/.test(navigator.userAgent)) return 'iPad';
  if (/Android/.test(navigator.userAgent)) return 'Android phone';
  return 'Phone';
}

export const askPairing = () => call<{ ok: boolean; until: number }>('/api/phone/pair/start', { name: phoneName() });
export const sendCode = (code: string) => call<{ ok: boolean; left?: number }>('/api/phone/pair/finish', { code });

/** Makes this phone's Face ID passkey (and unlocks it). */
export async function makePasskey(): Promise<void> {
  const optionsJSON = await call<Parameters<typeof startRegistration>[0]['optionsJSON']>('/api/phone/passkey/options', {});
  const response = await startRegistration({ optionsJSON });
  await call('/api/phone/passkey/register', { response });
}

/** Face ID: unlocks Harv on this phone. */
export async function unlock(): Promise<void> {
  const optionsJSON = await call<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/api/phone/unlock/options', {});
  const response = await startAuthentication({ optionsJSON });
  await call('/api/phone/unlock', { response });
}

export const lockPhone = () => call('/api/phone/lock', {});

/** Control another of the user's computers (this Harv forwards to it), or this one again with null. */
/** A new Shortcut token (Siri, the share sheet); the old one stops working. */
export const newShortcutToken = () => call<{ token: string; url: string }>('/api/phone/shortcut', {});

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

/** Asks for notifications (must run from a tap) and gives the subscription to Harv. */
export async function enablePush(): Promise<string | null> {
  if (!pushSupported()) return isIos && !standalone ? 'Open Harv from your Home Screen first.' : 'This browser has no notifications.';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'Notifications are off for Harv: Settings › Notifications › Harv on the phone.';
  const reg = await registerWorker();
  if (!reg) return 'The notification helper didn’t start.';
  const { key } = await call<{ key: string }>('/api/phone/push/key');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await call('/api/phone/push', { subscription: sub.toJSON() });
  return null;
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
  await call('/api/phone/push', { subscription: null });
}

export const testPush = () => call<{ sent: number }>('/api/phone/push/test', {});

/** What a tapped notification asked for: open this chat, maybe in voice mode, saying `say`. */
export interface OpenRequest {
  tabId?: string;
  talk: boolean;
  say?: string;
}

/** From the page address (the app was closed) or the service worker (it was open). */
export function onOpenRequest(listener: (req: OpenRequest) => void): void {
  const q = new URLSearchParams(location.search);
  if (q.has('tab') || q.has('talk')) {
    listener({ tabId: q.get('tab') ?? undefined, talk: q.get('talk') === '1', say: q.get('say') ?? undefined });
    history.replaceState(null, '', '/');
  }
  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent<{ type?: string } & OpenRequest>) => {
    if (event.data?.type === 'harv.open') listener(event.data);
  });
}
