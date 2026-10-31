import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@harv/shared';
import { checkPhone, cookie, DEVICE_COOKIE, parseCookies, UNLOCK_COOKIE, type PhoneContext, type PhoneRequest } from './access.ts';
import { cleanName, PAIR_MS, PAIR_TRIES, PhoneStore, UNLOCK_IDLE_MS } from './phones.ts';
import { noteFor } from './push.ts';
import { parseStatus, servesDashboard } from './tailnet.ts';

const HOST = 'homepc.tail85d08b.ts.net';
const OWNER = 'mrtngrega@gmail.com';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

/** A paired phone with a passkey and a live unlock. */
function paired(store: PhoneStore) {
  const { code } = store.startPairing('iPhone');
  const done = store.finishPairing(code);
  if (!done.ok) throw new Error('pairing failed');
  store.setPasskey(done.phone.id, { id: 'cred', publicKey: 'pk', counter: 0 });
  const unlock = store.unlock(done.phone.id);
  return { id: done.phone.id, device: done.secret, unlock };
}

const ctx = (phones: PhoneStore, over: Partial<PhoneContext> = {}): PhoneContext => ({
  enabled: true,
  host: HOST,
  owner: OWNER,
  phones,
  ...over,
});

const req = (over: Partial<PhoneRequest> = {}): PhoneRequest => ({
  method: 'GET',
  path: '/api/chats',
  host: HOST,
  origin: `https://${HOST}`,
  login: OWNER,
  ...over,
});

describe('pairing', () => {
  it('pairs with the code shown on the computer and stores only a hash of the secret', () => {
    const store = new PhoneStore(null);
    const { code } = store.startPairing('Martin’s iPhone');
    expect(code).toMatch(/^\d{6}$/);
    const done = store.finishPairing(code);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.phone.deviceHash).not.toContain(done.secret);
    expect(store.byDevice(done.secret)?.id).toBe(done.phone.id);
    expect(store.byDevice('wrong')).toBeUndefined();
    expect(store.list()[0]).toMatchObject({ name: 'Martin’s iPhone', passkey: false, push: false, shortcut: false });
  });

  it(`drops the request after ${PAIR_TRIES} wrong codes`, () => {
    const store = new PhoneStore(null);
    const { code } = store.startPairing('x');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i < PAIR_TRIES; i++) expect(store.finishPairing(wrong)).toEqual({ ok: false, left: PAIR_TRIES - i });
    expect(store.finishPairing(wrong)).toEqual({ ok: false, left: 0 });
    // Even the right code is useless now: the phone must ask again.
    expect(store.finishPairing(code).ok).toBe(false);
  });

  it('lets a code run out after five minutes', () => {
    const c = clock();
    const store = new PhoneStore(null, c.now);
    const { code } = store.startPairing('x');
    c.add(PAIR_MS + 1);
    expect(store.finishPairing(code)).toEqual({ ok: false, left: 0 });
  });

  it('keeps names short and plain', () => {
    expect(cleanName('<script>iPhone</script>')).toBe('scriptiPhonescript');
    expect(cleanName('')).toBe('Phone');
    expect(cleanName('x'.repeat(80))).toHaveLength(40);
  });
});

describe('unlock sessions', () => {
  it('last while in use and end after 30 minutes idle', () => {
    const c = clock();
    const store = new PhoneStore(null, c.now);
    const p = paired(store);
    c.add(UNLOCK_IDLE_MS - 1000);
    expect(store.session(p.unlock)).toBe(p.id);
    c.add(UNLOCK_IDLE_MS - 1000);
    expect(store.session(p.unlock)).toBe(p.id);
    c.add(UNLOCK_IDLE_MS + 1);
    expect(store.session(p.unlock)).toBeNull();
  });

  it('end at once when the phone is revoked or locks itself', () => {
    const store = new PhoneStore(null);
    const p = paired(store);
    store.lock(p.id);
    expect(store.session(p.unlock)).toBeNull();
    const q = paired(store);
    store.revoke(q.id);
    expect(store.session(q.unlock)).toBeNull();
    expect(store.byDevice(q.device)).toBeUndefined();
  });

  it('uses each WebAuthn challenge once', () => {
    const store = new PhoneStore(null);
    store.rememberChallenge('a', 'c1');
    expect(store.takeChallenge('a')).toBe('c1');
    expect(store.takeChallenge('a')).toBeNull();
  });
});

describe('the phone address check', () => {
  it('lets an unlocked, paired phone in', () => {
    const store = new PhoneStore(null);
    const p = paired(store);
    const cookies = `${DEVICE_COOKIE}=${p.device}; ${UNLOCK_COOKIE}=${p.unlock}`;
    expect(checkPhone(req({ cookie: cookies }), ctx(store))).toEqual({ ok: true, phoneId: p.id });
  });

  it('refuses everyone else', () => {
    const store = new PhoneStore(null);
    const p = paired(store);
    const cookies = `${DEVICE_COOKIE}=${p.device}; ${UNLOCK_COOKIE}=${p.unlock}`;
    const no = (r: PhoneRequest, c = ctx(store)) => checkPhone(r, c).ok;
    expect(no(req({ cookie: cookies }), ctx(store, { enabled: false }))).toBe(false);
    // Another Tailscale user (a shared device), or a request that didn't come through `serve`.
    expect(no(req({ cookie: cookies, login: 'someone@else.com' }))).toBe(false);
    expect(no(req({ cookie: cookies, login: undefined }))).toBe(false);
    expect(no(req({ cookie: cookies, origin: 'https://evil.example' }))).toBe(false);
    expect(no(req({ cookie: cookies, fetchSite: 'cross-site' }))).toBe(false);
    expect(no(req({ cookie: cookies, host: 'other.tail85d08b.ts.net' }))).toBe(false);
    // Paired but locked, or not paired.
    expect(checkPhone(req({ cookie: `${DEVICE_COOKIE}=${p.device}` }), ctx(store))).toMatchObject({ ok: false, status: 401 });
    expect(checkPhone(req({ cookie: `${UNLOCK_COOKIE}=${p.unlock}` }), ctx(store))).toMatchObject({ ok: false, status: 401 });
  });

  it('opens only pairing and the state before pairing, and Face ID with the device cookie alone', () => {
    const store = new PhoneStore(null);
    const p = paired(store);
    expect(checkPhone(req({ path: '/api/phone/state' }), ctx(store)).ok).toBe(true);
    expect(checkPhone(req({ method: 'POST', path: '/api/phone/pair/finish' }), ctx(store)).ok).toBe(true);
    expect(checkPhone(req({ method: 'POST', path: '/api/phone/unlock' }), ctx(store)).ok).toBe(false);
    expect(checkPhone(req({ method: 'POST', path: '/api/phone/unlock', cookie: `${DEVICE_COOKIE}=${p.device}` }), ctx(store))).toEqual({
      ok: true,
      phoneId: p.id,
    });
    // A phone without its passkey yet can't use the rest.
    const { code } = store.startPairing('new');
    const fresh = store.finishPairing(code);
    if (!fresh.ok) throw new Error('pairing failed');
    expect(checkPhone(req({ cookie: `${DEVICE_COOKIE}=${fresh.secret}` }), ctx(store)).ok).toBe(false);
  });

  it('takes the Shortcut token for Siri and the share sheet only', () => {
    const store = new PhoneStore(null);
    const p = paired(store);
    const token = store.newShortcutToken(p.id)!;
    const ask = req({ method: 'POST', path: '/api/phone/ask', origin: undefined, authorization: `Bearer ${token}` });
    expect(checkPhone(ask, ctx(store))).toEqual({ ok: true, phoneId: p.id });
    expect(checkPhone({ ...ask, authorization: 'Bearer nope' }, ctx(store)).ok).toBe(false);
    // The token opens nothing else.
    expect(checkPhone({ ...ask, path: '/api/chats' }, ctx(store)).ok).toBe(false);
    // A new token replaces the old one.
    store.newShortcutToken(p.id);
    expect(checkPhone(ask, ctx(store)).ok).toBe(false);
  });

  it('reads cookies and writes them HTTPS-only, out of scripts’ reach', () => {
    expect(parseCookies('a=1; b=x%20y; broken')).toEqual({ a: '1', b: 'x y' });
    expect(cookie('k', 'v', 10)).toBe('k=v; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=10');
  });
});

describe('tailscale', () => {
  it('reads this device, its owner and whether HTTPS certificates are on', () => {
    const raw = JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'HomePC.tail85d08b.ts.net.', UserID: 7 },
      User: { '7': { LoginName: OWNER } },
      CertDomains: ['homepc.tail85d08b.ts.net'],
    });
    expect(parseStatus(raw)).toEqual({ host: HOST, owner: OWNER, https: true, up: true });
    expect(parseStatus(JSON.stringify({ Self: { DNSName: `${HOST}.` }, CertDomains: null })).https).toBe(false);
  });

  it('knows when serve already points at the dashboard', () => {
    const cfg = { TCP: { '443': { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:5173' } } } } };
    expect(servesDashboard(JSON.stringify(cfg), HOST)).toBe(true);
    expect(servesDashboard('{}', HOST)).toBe(false);
    expect(servesDashboard('not json', HOST)).toBe(false);
  });
});

describe('push notes', () => {
  const title = () => 'Build fix';
  it('tells the phone when a turn it started is done, never what was said', () => {
    const done = { type: 'chat.done', tabId: 't', ok: true, stopped: false } as ServerMessage;
    expect(noteFor(done, () => true, title)).toMatchObject({ title: 'Harv is done', body: 'Build fix', tabId: 't' });
    expect(noteFor(done, () => false, title)).toBeNull();
    expect(noteFor({ ...done, stopped: true } as ServerMessage, () => true, title)).toBeNull();
  });

  it('reads out a Siri answer that came after Siri stopped waiting', () => {
    const done = { type: 'chat.done', tabId: 't', ok: true, stopped: false } as ServerMessage;
    expect(
      noteFor(
        done,
        () => true,
        title,
        () => true,
      ),
    ).toMatchObject({ title: 'Harv has your answer', tabId: 't', talk: true, last: true });
    expect(
      noteFor(
        done,
        () => true,
        title,
        () => false,
      )?.talk,
    ).toBeUndefined();
    // A failed turn says so instead of reading out an error.
    expect(
      noteFor(
        { ...done, ok: false } as ServerMessage,
        () => true,
        title,
        () => true,
      )?.title,
    ).toBe('Harv ran into a problem');
  });

  it('tells the phone when Harv waits for an OK, an answer or a plan', () => {
    const ask = (kind?: 'action' | 'question' | 'plan') =>
      noteFor(
        { type: 'approval.request', approval: { kind, id: 'a1', tabId: 't', summary: 'Delete old logs' } } as ServerMessage,
        () => false,
        title,
      );
    expect(ask()).toMatchObject({ title: 'Harv needs your OK', body: 'Delete old logs', tabId: 't' });
    expect(ask('question')?.title).toBe('Harv has a question');
    expect(ask('plan')?.title).toBe('Harv’s plan is ready');
  });

  it('passes on usage and watchdog warnings and scheduled runs', () => {
    const warn = {
      type: 'usage.warning',
      warning: { kind: 'session', label: 'session', percent: 91, threshold: 90, resetsAt: null },
    } as ServerMessage;
    expect(noteFor(warn, () => false, title)?.title).toBe('Claude session at 91%');
    expect(noteFor({ type: 'metrics.tick' } as unknown as ServerMessage, () => true, title)).toBeNull();
  });
});
