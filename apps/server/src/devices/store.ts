import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARV_HOME } from '../paths.ts';

// The user's smart-home devices (docs/PLAN.md §6z): their Tapo lights. The Tapo account login lives
// in ~/.harv/devices.json, typed into Settings › Devices; it's read only by this server (the gate
// blocks the file for every chat tool, like other secrets) and never sent to a dashboard. Sync
// carries the file to the user's other device, sealed with the sync key.

export interface TapoLogin {
  email: string;
  password: string;
}

export interface DevicesFile {
  tapo?: TapoLogin;
  /** The lights Harv controls, by MAC (the user picks them; the others are left alone). */
  lights?: string[];
  /** Lights that refused this login: never asked again until the login changes (each try counts toward a lockout). */
  refused?: string[];
}

const macs = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((m): m is string => typeof m === 'string' && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(m)))] : [];

export class DeviceStore {
  constructor(private file = join(HARV_HOME, 'devices.json')) {}

  /** Read fresh each time and cleaned, so a hand edit (or a synced copy) can't break Harv. */
  read(): DevicesFile {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { tapo?: Partial<TapoLogin>; lights?: unknown; refused?: unknown };
      const t = raw.tapo;
      const out: DevicesFile = { lights: macs(raw.lights), refused: macs(raw.refused) };
      if (typeof t?.email === 'string' && typeof t.password === 'string' && t.email && t.password) {
        out.tapo = { email: t.email.trim(), password: t.password };
      }
      return out;
    } catch {
      return {};
    }
  }

  private write(next: DevicesFile) {
    writeFileSync(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
  }

  /** The login, or null to forget it. A new login may work where the old one was refused. */
  setTapo(login: TapoLogin | null): void {
    const { tapo: _old, ...rest } = this.read();
    this.write({ ...rest, refused: [], ...(login ? { tapo: { email: login.email.trim(), password: login.password } } : {}) });
  }

  setChosen(id: string, chosen: boolean): void {
    const now = this.read();
    const lights = (now.lights ?? []).filter((m) => m !== id);
    this.write({ ...now, lights: chosen ? [...lights, id] : lights });
  }

  refuse(id: string): void {
    const now = this.read();
    if (!now.refused?.includes(id)) this.write({ ...now, refused: [...(now.refused ?? []), id] });
  }

  /** What a dashboard may see: whether there's a login, and its email. Never the password. */
  summary(): { tapoEmail: string | null } {
    return { tapoEmail: this.read().tapo?.email ?? null };
  }
}
