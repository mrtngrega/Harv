import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AutoLightsStatus, FoundLight, LightChange, LightControlBy, LightState, LightsStatus } from '@harv/shared';
import { ControlLog } from './controlLog.ts';
import { HARV_HOME } from '../paths.ts';
import { IS_WINDOWS } from '../platform.ts';
import { fitTemp } from './colors.ts';
import type { DeviceStore } from './store.ts';

// The user's Tapo light strips (docs/PLAN.md §6z). Their firmware speaks TP-Link's new TPAP
// encryption, which python-kasa has only in an unreleased change (PR #1592), reviewed and pinned
// below; it runs in a small helper process (kasa_helper.py) in its own venv, ~/.harv/kasa.
// Only the lights the user chose are ever logged in to; one that refuses the login is never asked
// again (every failed login counts toward its lockout) until the login changes.

/** The python-kasa version reviewed on 2026-10-31 (TPAP, ZeliardM's PR #1592 at this commit). */
export const KASA_SOURCE = 'https://github.com/ZeliardM/python-kasa/archive/844ec73b08f5284626e40aa6f0f73e293502b0b3.zip';
const HELPER = fileURLToPath(new URL('./kasa_helper.py', import.meta.url));
const VENV = join(HARV_HOME, 'kasa', 'venv');
const venvPython = () => join(VENV, ...(IS_WINDOWS ? ['Scripts', 'python.exe'] : ['bin', 'python']));

const ASK_MS = 25_000;
/** How often the lights are read again while a dashboard is open. */
export const POLL_MS = 30_000;

/**
 * Broadcast addresses of the home networks: every IPv4 network this computer is on, except
 * Tailscale (100.64/10), Hamachi (25/8) and link-local ones, where no light lives (and a plain
 * 255.255.255.255 can leave through the wrong adapter on Windows).
 */
export function broadcastTargets(ifaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const [a, b] = i.address.split('.').map(Number) as [number, number];
      if (a === 25 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)) continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      out.add(ip.map((n, k) => (n | (~mask[k]! & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

interface HelperAnswer {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  auth?: boolean;
}

export interface LightsDeps {
  broadcast: (status: LightsStatus) => void;
  log: (message: string) => void;
  /** Dashboards connected right now (the lights are polled only while one is). */
  watchers: () => number;
}

export class LightsService {
  private helper: ChildProcessWithoutNullStreams | null = null;
  private loginKey = '';
  private nextId = 1;
  private pending = new Map<number, (a: HelperAnswer) => void>();
  private states = new Map<string, LightState>();
  private ips = new Map<string, string>();
  /** Lights read since Harv started (a change seen on the first read happened while it was off). */
  private watched = new Set<string>();
  private found: { id: string; ip: string; model: string }[] = [];
  private problem: string | undefined;
  private installing = false;
  private timer: NodeJS.Timeout | null = null;
  /** Automatic lights' state, shown with the lights (set by the server). */
  autoStatus: (() => AutoLightsStatus) | null = null;

  constructor(
    private store: DeviceStore,
    private deps: LightsDeps,
    /** Who took control of each light last. */
    readonly log: ControlLog = new ControlLog(),
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.deps.watchers() > 0 && this.ready() && this.chosen().length) void this.refresh();
    }, POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.helper?.kill();
    this.helper = null;
  }

  private ready = () => existsSync(venvPython());
  private chosen = () => this.store.read().lights ?? [];

  status(): LightsStatus {
    const file = this.store.read();
    const setup: LightsStatus['setup'] = !this.ready() ? 'missing' : !file.tapo ? 'nologin' : 'ready';
    const refused = new Set(file.refused ?? []);
    const lights = (file.lights ?? []).map(
      (id) =>
        this.states.get(id) ?? { id, name: id, reachable: false, ...(refused.has(id) ? { error: 'It refused your Tapo login.' } : {}) },
    );
    const found: FoundLight[] = this.found.map((f) => ({ ...f, chosen: (file.lights ?? []).includes(f.id), refused: refused.has(f.id) }));
    return {
      setup,
      ...(setup === 'missing' ? { setupCommand: this.installing ? 'installing' : 'install' } : {}),
      lights,
      found,
      ...(this.problem ? { problem: this.problem } : {}),
      ...(this.autoStatus ? { auto: this.autoStatus() } : {}),
      log: this.log.recent(8),
    };
  }

  publish(): void {
    this.deps.broadcast(this.status());
  }

  /** Settings › Devices › Install: the helper's venv with the reviewed python-kasa, once per computer. */
  async install(): Promise<void> {
    if (this.installing || this.ready()) return;
    this.installing = true;
    this.problem = 'Installing the light helper (a minute or two)…';
    this.publish();
    try {
      mkdirSync(join(HARV_HOME, 'kasa'), { recursive: true });
      await run(IS_WINDOWS ? 'python' : 'python3', ['-m', 'venv', VENV]);
      await run(venvPython(), ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', KASA_SOURCE]);
      this.problem = undefined;
    } catch (err) {
      this.problem = `Installing the light helper failed: ${(err as Error).message}`;
    } finally {
      this.installing = false;
      this.publish();
    }
  }

  private ensureHelper(): ChildProcessWithoutNullStreams {
    if (this.helper) return this.helper;
    const child = spawn(venvPython(), ['-I', HELPER], { windowsHide: true });
    this.helper = child;
    this.loginKey = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const answer = JSON.parse(line) as HelperAnswer;
        this.pending.get(answer.id)?.(answer);
        this.pending.delete(answer.id);
      } catch {
        /* not an answer */
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', () => {
      if (this.helper === child) this.helper = null;
      for (const done of this.pending.values()) done({ id: 0, ok: false, error: 'The light helper stopped.' });
      this.pending.clear();
    });
    return child;
  }

  private ask(msg: Record<string, unknown>): Promise<HelperAnswer> {
    const child = this.ensureHelper();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: 'The light didn’t answer in time.' });
      }, ASK_MS);
      this.pending.set(id, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
      child.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
    });
  }

  /** The helper logs in with the current login (again when it changed, e.g. synced from the other device). */
  private async login(): Promise<boolean> {
    const tapo = this.store.read().tapo;
    if (!tapo) return false;
    const key = `${tapo.email}\n${tapo.password}`;
    if (key === this.loginKey && this.helper) return true;
    const a = await this.ask({ op: 'login', email: tapo.email, password: tapo.password });
    if (a.ok) this.loginKey = key;
    return a.ok;
  }

  /** Every Tapo light on the home network, found without logging in to any. */
  async scan(): Promise<FoundLight[]> {
    if (!this.ready()) return [];
    const a = await this.ask({ op: 'scan', targets: broadcastTargets() });
    if (a.ok) {
      this.found = a.result as typeof this.found;
      for (const f of this.found) this.ips.set(f.id, f.ip);
    } else this.problem = a.error;
    this.publish();
    return this.status().found;
  }

  /** A light Harv may talk to: chosen by the user and not one that refused the login. */
  private allowed(id: string): string | null {
    const file = this.store.read();
    if (!file.tapo) return 'Save your Tapo login in Settings › Devices first.';
    if (!(file.lights ?? []).includes(id)) return 'Harv doesn’t control that light (Settings › Devices).';
    if ((file.refused ?? []).includes(id))
      return 'That light refused your Tapo login, so Harv leaves it alone (change the login in Settings › Devices to try again).';
    return null;
  }

  private remember(id: string, a: HelperAnswer): LightState {
    if (a.ok) {
      const s = a.result as LightState & { ip?: string };
      if (s.ip) this.ips.set(id, s.ip);
      const { ip: _ip, ...state } = s;
      const control = this.log.last(id);
      const next: LightState = { ...state, id, reachable: true, at: Date.now(), ...(control ? { control } : {}) };
      this.states.set(id, next);
      return next;
    }
    if (a.auth) this.store.refuse(id);
    const before = this.states.get(id);
    const next: LightState = {
      ...(before ?? { id, name: id }),
      id,
      reachable: false,
      error: a.auth ? 'It refused your Tapo login.' : (a.error ?? 'No answer.'),
      at: Date.now(),
    };
    this.states.set(id, next);
    return next;
  }

  /** Switched on or off by something outside Harv since the last change Harv knows of (the Tapo app, its button, the other computer). */
  private noticeOutside(state: LightState, firstLook: boolean): LightState {
    const last = state.control;
    if (!state.reachable || !last || last.on === !!state.on) return state;
    // Seen on the first read since Harv started: it happened some time while Harv wasn't running, so it
    // can't count as "since it got dark" tonight (switched off last night, the PC on again after dark).
    const control = firstLook
      ? this.log.record(state.id, 'outside', !!state.on, `${state.on ? 'on' : 'off'} (while Harv wasn’t running)`, last.at + 1, Date.now())
      : this.log.record(state.id, 'outside', !!state.on, state.on ? 'on' : 'off');
    const next = { ...state, control };
    this.states.set(state.id, next);
    return next;
  }

  /** Reads every chosen light again. */
  async refresh(): Promise<LightState[]> {
    if (!this.ready() || !(await this.login())) {
      this.publish();
      return [];
    }
    const out: LightState[] = [];
    for (const id of this.chosen()) {
      if (this.allowed(id)) continue;
      const state = this.remember(id, await this.ask({ op: 'state', mac: id, ip: this.ips.get(id), targets: broadcastTargets() }));
      out.push(this.noticeOutside(state, !this.watched.has(id)));
      if (state.reachable) this.watched.add(id);
    }
    this.publish();
    return out;
  }

  /**
   * Changes one light; anything not in `change` stays. `by` is written to the log of who took
   * control (automatic lights follow it). Throws with a plain reason when it can't.
   */
  async set(id: string, change: LightChange, by: LightControlBy = 'you', what?: string): Promise<LightState> {
    const why = this.allowed(id) ?? (this.ready() ? null : 'The light helper isn’t installed yet (Settings › Devices › Install).');
    if (why) throw new Error(why);
    if (!(await this.login())) throw new Error('Save your Tapo login in Settings › Devices first.');
    const clean: LightChange = {};
    if (typeof change.on === 'boolean') clean.on = change.on;
    if (typeof change.brightness === 'number') clean.brightness = Math.min(100, Math.max(1, Math.round(change.brightness)));
    if (typeof change.hue === 'number') {
      clean.hue = ((Math.round(change.hue) % 360) + 360) % 360;
      clean.saturation = Math.min(100, Math.max(0, Math.round(change.saturation ?? 100)));
    } else if (typeof change.temp === 'number') clean.temp = fitTemp(change.temp, this.states.get(id)?.tempRange);
    if (typeof change.effect === 'string') {
      const effects = this.states.get(id)?.effects;
      const match = change.effect.toLowerCase() === 'off' ? 'Off' : effects?.find((e) => e.toLowerCase() === change.effect!.toLowerCase());
      if (!match) throw new Error(`No effect called "${change.effect}". It has: ${(effects ?? []).join(', ') || 'none known yet'}.`);
      clean.effect = match;
    }
    const state = this.remember(
      id,
      await this.ask({ op: 'set', mac: id, ip: this.ips.get(id), targets: broadcastTargets(), change: clean }),
    );
    if (!state.reachable) {
      this.publish();
      throw new Error(state.error ?? 'The light didn’t answer.');
    }
    const control = this.log.record(id, by, !!state.on, what ?? describeChange(clean, !!state.on));
    const next = { ...state, control };
    this.states.set(id, next);
    this.publish();
    return next;
  }

  async choose(id: string, chosen: boolean): Promise<void> {
    this.store.setChosen(id, chosen);
    if (!chosen) this.states.delete(id);
    if (chosen) await this.refresh();
    else this.publish();
  }

  /** The lights a chat may name: "all", or a name like the Tapo app's ("L.E.D", "led", "desk"). */
  match(name: string | undefined): LightState[] {
    const lights = this.status().lights;
    if (!name || /^(all|every|both)\b/i.test(name.trim())) return lights;
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const k = key(name);
    return lights.filter((l) => key(l.name) === k || key(l.id) === k || (k.length > 1 && key(l.name).includes(k)));
  }
}

/** A change in a few words for the log ("on, 30%, hue 175"). */
export function describeChange(c: LightChange, on: boolean): string {
  if (c.on === false) return 'off';
  const parts = [c.on === true || on ? 'on' : 'off'];
  if (c.brightness !== undefined) parts.push(`${c.brightness}%`);
  if (c.hue !== undefined) parts.push(`hue ${c.hue}`);
  if (c.temp !== undefined) parts.push(`${c.temp}K`);
  if (c.effect) parts.push(c.effect === 'Off' ? 'no effect' : c.effect);
  return parts.join(', ');
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-600)));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').at(-1) || `${cmd} exited with ${code}`))));
  });
}
