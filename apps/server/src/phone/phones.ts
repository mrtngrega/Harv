import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { PhoneInfo } from '@harv/shared';

// Paired phones (docs/PLAN.md §6q), in ~/.harv/phones.json. Only hashes of the phone's secrets are
// kept: the device cookie (this phone is paired), the Shortcut token (Siri and the share sheet).
// Unlock sessions (a fresh Face ID) live in memory only, so a restart asks for Face ID again.

/** A pairing code is good this long. */
export const PAIR_MS = 5 * 60_000;
/** Wrong codes before the pairing request is dropped. */
export const PAIR_TRIES = 5;
/** An unlock lasts while the phone is in use; this long idle and Face ID is asked again. */
export const UNLOCK_IDLE_MS = 30 * 60_000;
/** A WebAuthn challenge is good this long. */
const CHALLENGE_MS = 2 * 60_000;

export interface Passkey {
  /** base64url credential id. */
  id: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  transports?: string[];
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredPhone {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
  deviceHash: string;
  shortcutHash?: string;
  passkey?: Passkey;
  push?: PushSub;
}

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A phone name from the user agent or what the phone sent, kept short and plain. */
export function cleanName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/[^\p{L}\p{N} '’._-]/gu, '').trim() : '';
  return text.slice(0, 40) || 'Phone';
}

export class PhoneStore {
  private phones: StoredPhone[] = [];
  private pending: { code: string; name: string; until: number; tries: number } | null = null;
  private sessions = new Map<string, { phoneId: string; last: number }>();
  private challenges = new Map<string, { challenge: string; until: number }>();

  constructor(
    private file: string | null,
    private now: () => number = Date.now,
  ) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { phones?: StoredPhone[] };
        this.phones = (raw.phones ?? []).filter((p) => p && typeof p.id === 'string' && typeof p.deviceHash === 'string');
      } catch {
        this.phones = [];
      }
    }
  }

  private save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ phones: this.phones }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): PhoneInfo[] {
    return this.phones.map((p) => ({
      id: p.id,
      name: p.name,
      pairedAt: p.pairedAt,
      lastSeen: p.lastSeen,
      passkey: !!p.passkey,
      push: !!p.push,
      shortcut: !!p.shortcutHash,
    }));
  }

  get(id: string): StoredPhone | undefined {
    return this.phones.find((p) => p.id === id);
  }

  /** A phone asks to pair: a new 6-digit code (an older request is replaced). */
  startPairing(name: string): { code: string; until: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pending = { code, name: cleanName(name), until: this.now() + PAIR_MS, tries: 0 };
    return { code, until: this.pending.until };
  }

  get pairingName(): string | null {
    return this.pending && this.pending.until > this.now() ? this.pending.name : null;
  }

  /**
   * The code typed on the phone. Right: the phone is paired and gets its device secret (the cookie).
   * Wrong: `left` tries; at 0 (or expired) the request is gone and the phone must ask again.
   */
  finishPairing(code: string): { ok: true; secret: string; phone: StoredPhone } | { ok: false; left: number } {
    const p = this.pending;
    if (!p || p.until <= this.now()) {
      this.pending = null;
      return { ok: false, left: 0 };
    }
    if (String(code).replace(/\D/g, '') !== p.code) {
      p.tries++;
      const left = PAIR_TRIES - p.tries;
      if (left <= 0) this.pending = null;
      return { ok: false, left: Math.max(0, left) };
    }
    this.pending = null;
    const secret = newSecret();
    const phone: StoredPhone = { id: randomUUID(), name: p.name, pairedAt: this.now(), lastSeen: 0, deviceHash: hashSecret(secret) };
    this.phones.push(phone);
    this.save();
    return { ok: true, secret, phone };
  }

  /** The phone a device cookie belongs to. */
  byDevice(secret: string | undefined): StoredPhone | undefined {
    if (!secret) return undefined;
    const h = hashSecret(secret);
    return this.phones.find((p) => sameHash(p.deviceHash, h));
  }

  /** The phone a Shortcut token belongs to. */
  byShortcut(token: string | undefined): StoredPhone | undefined {
    if (!token) return undefined;
    const h = hashSecret(token);
    return this.phones.find((p) => p.shortcutHash && sameHash(p.shortcutHash, h));
  }

  /** A new Shortcut token for a phone (an older one stops working). */
  newShortcutToken(id: string): string | null {
    const phone = this.get(id);
    if (!phone) return null;
    const token = newSecret();
    phone.shortcutHash = hashSecret(token);
    this.save();
    return token;
  }

  setPasskey(id: string, passkey: Passkey) {
    const phone = this.get(id);
    if (!phone) return;
    phone.passkey = passkey;
    this.save();
  }

  setCounter(id: string, counter: number) {
    const phone = this.get(id);
    if (!phone?.passkey) return;
    phone.passkey.counter = counter;
    this.save();
  }

  setPush(id: string, push: PushSub | undefined) {
    const phone = this.get(id);
    if (!phone) return;
    phone.push = push;
    this.save();
  }

  rename(id: string, name: string) {
    const phone = this.get(id);
    if (!phone) return;
    phone.name = cleanName(name);
    this.save();
  }

  /** Forgets a phone: its cookie, passkey, token and push stop working at once. */
  revoke(id: string) {
    this.phones = this.phones.filter((p) => p.id !== id);
    for (const [key, s] of this.sessions) if (s.phoneId === id) this.sessions.delete(key);
    this.challenges.delete(id);
    this.save();
  }

  /** Marks a request from the phone (Settings shows "last seen"); saved at most once a minute. */
  seen(id: string) {
    const phone = this.get(id);
    if (!phone) return;
    const was = phone.lastSeen;
    phone.lastSeen = this.now();
    if (phone.lastSeen - was > 60_000) this.save();
  }

  /** A WebAuthn challenge for this phone (register or unlock). */
  rememberChallenge(id: string, challenge: string) {
    this.challenges.set(id, { challenge, until: this.now() + CHALLENGE_MS });
  }

  /** The challenge, used once. */
  takeChallenge(id: string): string | null {
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    return c && c.until > this.now() ? c.challenge : null;
  }

  /** Face ID done: a new unlock session (its secret goes in a cookie). */
  unlock(phoneId: string): string {
    const secret = newSecret();
    this.sessions.set(hashSecret(secret), { phoneId, last: this.now() });
    return secret;
  }

  /** The phone of a live unlock session; each use keeps it alive. */
  session(secret: string | undefined): string | null {
    if (!secret) return null;
    const key = hashSecret(secret);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (this.now() - s.last > UNLOCK_IDLE_MS || !this.get(s.phoneId)) {
      this.sessions.delete(key);
      return null;
    }
    s.last = this.now();
    return s.phoneId;
  }

  /** Like `session`, but only looks: it doesn't count as use (for a forwarded connection's periodic check). */
  peekSession(secret: string | undefined): string | null {
    if (!secret) return null;
    const s = this.sessions.get(hashSecret(secret));
    return s && this.now() - s.last <= UNLOCK_IDLE_MS && this.get(s.phoneId) ? s.phoneId : null;
  }

  /** Ends a phone's unlock sessions (the app locked itself). */
  lock(phoneId: string) {
    for (const [key, s] of this.sessions) if (s.phoneId === phoneId) this.sessions.delete(key);
  }
}
