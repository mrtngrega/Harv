import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Attachment, PhoneAccess, PhoneServerMessage, PhoneState, ServerMessage } from '@harv/shared';
import { HARV_HOME } from '../paths.ts';
import { checkPhone, cookie, DEVICE_COOKIE, isPhoneHost, parseCookies, UNLOCK_COOKIE, type PhoneContext } from './access.ts';
import { PhoneStore } from './phones.ts';
import { noteFor, PhonePush, type PushNote } from './push.ts';
import { nameOf, serving, setServe, tailnetSelf, type TailnetSelf } from './tailnet.ts';

// Harv on the phone (docs/PLAN.md §6q): keeps `tailscale serve` in step with Settings › Phone,
// checks every request that comes in on the phone address, and serves pairing, Face ID, push,
// and Siri / the share sheet.

/** Siri waits this long for a reply before Harv says "on it, I'll let you know". */
const ASK_WAIT_MS = 45_000;
/** Tailscale's state is read again this often (the address or certificates may change). */
const REFRESH_MS = 5 * 60_000;
/** The device cookie lasts as long as browsers allow (400 days). */
const DEVICE_MAX_AGE_S = 400 * 24 * 3600;

export interface PhoneDeps {
  enabled: () => boolean;
  /** This computer's name for the phone's screens. */
  deviceName: () => string;
  /** The other Harv devices (live sync peers): name and tailnet address. */
  peers: () => { name: string; ip: string }[];
  broadcast: (msg: ServerMessage) => void;
  log: (msg: string) => void;
  /** The phone chat's id on this device. */
  phoneTab: () => string;
  ask: (tabId: string, text: string, files: Attachment[], waitMs: number) => Promise<{ reply: string; done: boolean }>;
  saveFile: (tabId: string, name: string, data: Buffer) => Attachment;
  /** A message in the phone chat, as if typed (the share sheet with a note). */
  send: (tabId: string, text: string, files: Attachment[]) => Promise<void>;
  title: (tabId: string) => string;
  /** Makes the phone chat (if new) and opens it as a tab. */
  openChat: (tabId: string) => void;
}

const phoneOfReq = new WeakMap<FastifyRequest, string>();

/** The paired phone a request came from (after the access check), if any. */
export const phoneOf = (req: FastifyRequest) => phoneOfReq.get(req);

export class PhoneService {
  readonly phones = new PhoneStore(join(HARV_HOME, 'phones.json'));
  readonly push: PhonePush;
  private self: TailnetSelf = { host: null, owner: null, https: false, up: false };
  private serving = false;
  private problem: string | undefined;
  private refreshing: Promise<void> | null = null;
  /** Chats whose current turn came from a phone: their end is pushed. */
  private phoneTurns = new Set<string>();
  /** Phone windows in front right now (no push while one is). */
  private visible = new Set<object>();
  private sockets = new Map<string, Set<() => void>>();

  constructor(private deps: PhoneDeps) {
    this.push = new PhonePush(this.phones, join(HARV_HOME, 'vapid.json'), deps.log);
    setInterval(() => void this.refresh(), REFRESH_MS).unref();
  }

  /** Reads Tailscale and turns `serve` on or off to match the setting. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh() {
    this.self = await tailnetSelf();
    const want = this.deps.enabled();
    const host = this.self.host;
    this.problem = undefined;
    this.serving = host ? await serving(host) : false;
    if (want) {
      if (!this.self.up || !host) this.problem = 'Tailscale isn’t running on this computer.';
      else if (!this.self.https)
        this.problem = 'HTTPS certificates are off in your tailnet: open login.tailscale.com/admin/dns and click “Enable HTTPS”.';
      else if (!this.serving) {
        this.problem = (await setServe(true)) ?? undefined;
        this.serving = !this.problem && (await serving(host));
      }
    } else if (this.serving) {
      this.problem = (await setServe(false)) ?? undefined;
      this.serving = !!this.problem;
    }
    this.publish();
  }

  access(): PhoneAccess {
    return {
      enabled: this.deps.enabled(),
      serving: this.serving,
      url: this.self.host ? `https://${this.self.host}` : null,
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  publish() {
    this.deps.broadcast({ type: 'phone.list', phones: this.phones.list(), access: this.access() } satisfies PhoneServerMessage);
  }

  private ctx(): PhoneContext {
    return { enabled: this.deps.enabled(), host: this.self.host, owner: this.self.owner, phones: this.phones };
  }

  /** For the server's request hook: is this Host the phone address? */
  isPhoneHost(host: string): boolean {
    return isPhoneHost(host, this.self);
  }

  /** The access check for a request on the phone address; sends the refusal itself. */
  check(req: FastifyRequest, reply: FastifyReply): boolean {
    const h = req.headers;
    const verdict = checkPhone(
      {
        method: req.method,
        path: req.url.split('?')[0] ?? '',
        host: h.host ?? '',
        origin: h.origin,
        fetchSite: h['sec-fetch-site'] as string | undefined,
        login: h['tailscale-user-login'] as string | undefined,
        cookie: h.cookie,
        authorization: h.authorization,
      },
      this.ctx(),
    );
    if (!verdict.ok) {
      void reply.code(verdict.status).send({ error: verdict.error });
      return false;
    }
    if (verdict.phoneId) {
      phoneOfReq.set(req, verdict.phoneId);
      this.phones.seen(verdict.phoneId);
    }
    return true;
  }

  /** A phone's live dashboard connection, closed when it's revoked. */
  attachSocket(phoneId: string, close: () => void): () => void {
    const set = this.sockets.get(phoneId) ?? new Set();
    set.add(close);
    this.sockets.set(phoneId, set);
    return () => set.delete(close);
  }

  /** The connection's Face ID unlock is still alive (each message keeps it so); false = close it. */
  stillUnlocked(phoneId: string, cookieHeader: string | undefined): boolean {
    return this.phones.session(parseCookies(cookieHeader)[UNLOCK_COOKIE]) === phoneId;
  }

  /** Forgets a phone and ends its connections at once. */
  revoke(id: string) {
    this.phones.revoke(id);
    for (const close of this.sockets.get(id) ?? []) close();
    this.sockets.delete(id);
    this.publish();
  }

  /** A phone window says whether it's in front (no push while one is). */
  setVisible(socket: object, on: boolean) {
    if (on) this.visible.add(socket);
    else this.visible.delete(socket);
  }

  /** A turn sent from the phone: its end is pushed if the phone isn't looking. */
  markPhoneTurn(tabId: string) {
    this.phoneTurns.add(tabId);
  }

  /** Every dashboard event passes here: some become a push. */
  observe(msg: ServerMessage) {
    const note = noteFor(msg, (tab) => this.phoneTurns.has(tab), this.deps.title);
    if (msg.type === 'chat.done') this.phoneTurns.delete(msg.tabId);
    if (!note || this.visible.size) return;
    void this.push.send(note);
  }

  /** Harv's phone_notify tool. */
  notify(note: PushNote): Promise<number> {
    return this.push.send(note);
  }

  private state(req: FastifyRequest): PhoneState {
    const cookies = parseCookies(req.headers.cookie);
    const phone = this.phones.byDevice(cookies[DEVICE_COOKIE]);
    return {
      paired: !!phone,
      needsPasskey: !!phone && !phone.passkey,
      unlocked: !!phone?.passkey && this.phones.session(cookies[UNLOCK_COOKIE]) === phone.id,
      device: this.deps.deviceName(),
      others: [],
    };
  }

  private async others(): Promise<{ name: string; url: string }[]> {
    const out: { name: string; url: string }[] = [];
    for (const peer of this.deps.peers()) {
      const host = await nameOf(peer.ip);
      if (host) out.push({ name: peer.name, url: `https://${host}` });
    }
    return out;
  }

  routes(app: FastifyInstance) {
    const rpID = () => this.self.host ?? '';
    const origin = () => `https://${rpID()}`;
    const phoneId = (req: FastifyRequest) => {
      const id = phoneOf(req);
      if (!id) throw Object.assign(new Error('Not a phone'), { statusCode: 403 });
      return id;
    };

    app.get('/api/phone/state', async (req) => {
      const state = this.state(req);
      if (state.unlocked) state.others = await this.others();
      return state;
    });

    app.post<{ Body: { name?: string } }>('/api/phone/pair/start', async (req) => {
      if (!this.isPhoneHost(req.headers.host ?? '')) return { ok: false };
      const { code, until } = this.phones.startPairing(req.body?.name ?? '');
      this.deps.broadcast({ type: 'phone.pairing', name: this.phones.pairingName ?? 'Phone', code, until });
      return { ok: true, until };
    });

    app.post<{ Body: { code?: string } }>('/api/phone/pair/finish', async (req, reply) => {
      if (!this.isPhoneHost(req.headers.host ?? '')) return { ok: false, left: 0 };
      const name = this.phones.pairingName ?? 'Phone';
      // Pairing again (its passkey got lost): the phone's old entry goes once the new one exists.
      const old = this.phones.byDevice(parseCookies(req.headers.cookie)[DEVICE_COOKIE]);
      const done = this.phones.finishPairing(String(req.body?.code ?? ''));
      if (done.ok && old) this.revoke(old.id);
      if (!done.ok) {
        if (done.left === 0) this.deps.broadcast({ type: 'phone.paired', name, ok: false });
        return { ok: false, left: done.left };
      }
      void reply.header('set-cookie', cookie(DEVICE_COOKIE, done.secret, DEVICE_MAX_AGE_S));
      this.deps.broadcast({ type: 'phone.paired', name, ok: true });
      this.publish();
      return { ok: true };
    });

    app.post('/api/phone/passkey/options', async (req) => {
      const phone = this.phones.get(phoneId(req))!;
      const options = await generateRegistrationOptions({
        rpName: 'Harv',
        rpID: rpID(),
        userName: `${phone.name} · ${this.deps.deviceName()}`,
        userID: new TextEncoder().encode(phone.id),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required', authenticatorAttachment: 'platform' },
      });
      this.phones.rememberChallenge(phone.id, options.challenge);
      return options;
    });

    app.post<{ Body: { response?: RegistrationResponseJSON } }>('/api/phone/passkey/register', async (req, reply) => {
      const id = phoneId(req);
      const challenge = this.phones.takeChallenge(id);
      if (!challenge || !req.body?.response) return reply.code(400).send({ error: 'Start again: the Face ID request ran out.' });
      try {
        const v = await verifyRegistrationResponse({
          response: req.body.response,
          expectedChallenge: challenge,
          expectedOrigin: origin(),
          expectedRPID: rpID(),
          requireUserVerification: true,
        });
        if (!v.verified || !v.registrationInfo) return reply.code(400).send({ error: 'Face ID didn’t confirm it.' });
        const c = v.registrationInfo.credential;
        this.phones.setPasskey(id, {
          id: c.id,
          publicKey: Buffer.from(c.publicKey).toString('base64url'),
          counter: c.counter,
          ...(c.transports ? { transports: c.transports } : {}),
        });
        void reply.header('set-cookie', cookie(UNLOCK_COOKIE, this.phones.unlock(id)));
        this.publish();
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    app.post('/api/phone/unlock/options', async (req) => {
      const phone = this.phones.get(phoneId(req))!;
      if (!phone.passkey) throw Object.assign(new Error('No passkey yet'), { statusCode: 400 });
      const options = await generateAuthenticationOptions({
        rpID: rpID(),
        userVerification: 'required',
        allowCredentials: [
          { id: phone.passkey.id, ...(phone.passkey.transports ? { transports: phone.passkey.transports as never } : {}) },
        ],
      });
      this.phones.rememberChallenge(phone.id, options.challenge);
      return options;
    });

    app.post<{ Body: { response?: AuthenticationResponseJSON } }>('/api/phone/unlock', async (req, reply) => {
      const id = phoneId(req);
      const phone = this.phones.get(id)!;
      const challenge = this.phones.takeChallenge(id);
      if (!challenge || !phone.passkey || !req.body?.response)
        return reply.code(400).send({ error: 'Try again: the Face ID request ran out.' });
      try {
        const v = await verifyAuthenticationResponse({
          response: req.body.response,
          expectedChallenge: challenge,
          expectedOrigin: origin(),
          expectedRPID: rpID(),
          requireUserVerification: true,
          credential: {
            id: phone.passkey.id,
            publicKey: new Uint8Array(Buffer.from(phone.passkey.publicKey, 'base64url')),
            counter: phone.passkey.counter,
          },
        });
        if (!v.verified) return reply.code(401).send({ error: 'Face ID didn’t confirm it.' });
        this.phones.setCounter(id, v.authenticationInfo.newCounter);
        void reply.header('set-cookie', cookie(UNLOCK_COOKIE, this.phones.unlock(id)));
        return { ok: true };
      } catch (err) {
        return reply.code(401).send({ error: (err as Error).message });
      }
    });

    app.post('/api/phone/lock', async (req, reply) => {
      this.phones.lock(phoneId(req));
      void reply.header('set-cookie', cookie(UNLOCK_COOKIE, '', 0));
      return { ok: true };
    });

    app.get('/api/phone/push/key', async (req) => {
      phoneId(req);
      return { key: this.push.publicKey };
    });

    app.post<{ Body: { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null } }>(
      '/api/phone/push',
      async (req, reply) => {
        const id = phoneId(req);
        const sub = req.body?.subscription;
        if (sub === null) this.phones.setPush(id, undefined);
        else if (sub?.endpoint?.startsWith('https://') && sub.keys?.p256dh && sub.keys.auth)
          this.phones.setPush(id, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
        else return reply.code(400).send({ error: 'Not a push subscription' });
        this.publish();
        return { ok: true };
      },
    );

    app.post('/api/phone/push/test', async (req) => {
      phoneId(req);
      return { sent: await this.push.send({ title: 'Harv', body: 'Notifications work.', tag: 'test' }) };
    });

    // The Shortcut token is made on the phone (Settings › Phone there), so it's pasted, never typed.
    app.post('/api/phone/shortcut', async (req) => {
      const token = this.phones.newShortcutToken(phoneId(req));
      this.publish();
      return { token, url: origin() };
    });

    // "Hey Siri, Harv …": the Shortcut posts what was said; Siri reads out the reply.
    app.post<{ Body: { text?: string } | string }>('/api/phone/ask', async (req, reply) => {
      phoneId(req);
      const text = (typeof req.body === 'string' ? req.body : (req.body?.text ?? '')).trim().slice(0, 4000);
      if (!text) return reply.code(400).send({ reply: 'I didn’t catch that.' });
      const tab = this.deps.phoneTab();
      this.markPhoneTurn(tab);
      const answer = await this.deps.ask(tab, text, [], ASK_WAIT_MS);
      // Answered in time: Siri already said it, no push needed.
      if (answer.done) this.phoneTurns.delete(tab);
      return { reply: answer.reply.replace(/[*_`#>]/g, '').slice(0, 2000), done: answer.done };
    });

    // The share sheet: a photo, file, link or text, with an optional note for Harv.
    void app.register(async (scope) => {
      scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 32 * 1024 * 1024 }, (_req, body, done) => done(null, body));
      scope.post<{ Querystring: { name?: string; text?: string } }>('/api/phone/share', async (req, reply) => {
        phoneId(req);
        const tab = this.deps.phoneTab();
        const note = (req.query.text ?? '').trim().slice(0, 4000);
        const type = String(req.headers['content-type'] ?? '');
        let files: Attachment[] = [];
        let text = note;
        if (/json/.test(type) || /^text\//.test(type)) {
          const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
          let shared = raw;
          try {
            const j = JSON.parse(raw) as { text?: string; url?: string };
            shared = [j.text, j.url].filter(Boolean).join('\n');
          } catch {
            /* plain text */
          }
          text = [note, shared.trim()].filter(Boolean).join('\n\n');
          if (!text) return reply.code(400).send({ error: 'Nothing to share' });
        } else {
          if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: 'No file' });
          // Shortcuts' "Name" has no extension: it comes from the type then.
          const given = (req.query.name || String(req.headers['x-file-name'] ?? '') || 'from-phone').slice(0, 120);
          const name = /\.[a-z0-9]{2,5}$/i.test(given) ? given : `${given}${extOf(type)}`;
          files = [this.deps.saveFile(tab, name, req.body)];
        }
        this.deps.openChat(tab);
        if (text) {
          this.markPhoneTurn(tab);
          void this.deps.send(tab, text, files);
        } else this.deps.broadcast({ type: 'phone.shared', tabId: tab, attachments: files });
        return { ok: true, reply: text ? 'Sent to Harv.' : 'Saved in Harv’s phone chat.' };
      });
    });
  }
}

function extOf(type: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/heic': '.heic',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'video/quicktime': '.mov',
    'video/mp4': '.mp4',
  };
  return map[type.split(';')[0]!.trim().toLowerCase()] ?? '';
}
