import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARV_HOME } from '../paths.ts';

// The user's smart-home devices (docs/PLAN.md §6z): their Tapo lights. The Tapo account login lives
// in ~/.harv/devices.json, typed into Settings › Devices; it's read only by this server (the gate
// blocks the file for every chat tool, like other secrets) and never sent to a dashboard.

export interface TapoLogin {
  email: string;
  password: string;
}

export interface DevicesFile {
  tapo?: TapoLogin;
}

export class DeviceStore {
  constructor(private file = join(HARV_HOME, 'devices.json')) {}

  /** Read fresh each time and cleaned, so a hand edit can't break Harv. */
  read(): DevicesFile {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { tapo?: Partial<TapoLogin> };
      const t = raw.tapo;
      return typeof t?.email === 'string' && typeof t.password === 'string' && t.email && t.password
        ? { tapo: { email: t.email.trim(), password: t.password } }
        : {};
    } catch {
      return {};
    }
  }

  /** The login, or null to forget it. */
  setTapo(login: TapoLogin | null): void {
    const next: DevicesFile = { ...this.read() };
    if (login) next.tapo = { email: login.email.trim(), password: login.password };
    else delete next.tapo;
    writeFileSync(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
  }

  /** What a dashboard may see: whether there's a login, and its email. Never the password. */
  summary(): { tapoEmail: string | null } {
    return { tapoEmail: this.read().tapo?.email ?? null };
  }
}
