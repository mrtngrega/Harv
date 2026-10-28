import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import WebSocket from 'ws';
import { IS_WINDOWS } from '../platform.ts';

// The user's installed Chrome, run with a profile of Harv's own and driven over the
// DevTools protocol (no puppeteer: a page, its commands and its events are all Harv needs).
// The debugging port is picked by Chrome (port 0) and listens on 127.0.0.1 only.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Google Chrome (or Chromium on Linux): HARV_CHROME_PATH, the usual install folders, then PATH. */
export function findChrome(): string | null {
  const env = process.env.HARV_CHROME_PATH;
  if (env && existsSync(env)) return env;
  const fixed = IS_WINDOWS
    ? [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
      ]
    : [];
  const found = fixed.find((p) => existsSync(p));
  if (found) return found;
  if (IS_WINDOWS) return null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

/** The desktop session's variables a window needs on Linux. */
const DESKTOP_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'];

/**
 * Harv's environment, plus the desktop's display on Linux when Harv was started without one
 * (over SSH, say): taken from the user's systemd session, which KDE fills in at login.
 */
export function desktopEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (IS_WINDOWS || env.DISPLAY || env.WAYLAND_DISPLAY) return env;
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 3000 });
  return { ...env, ...sessionVars(r.stdout ?? '') };
}

/** The desktop variables in `systemctl --user show-environment` output. */
export function sessionVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && DESKTOP_VARS.includes(m[1]!)) out[m[1]!] = m[2]!.replace(/^\$?'(.*)'$/, '$1');
  }
  return out;
}

/** One page, driven over its DevTools WebSocket. */
export class CdpPage {
  private id = 0;
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.fail(new Error(msg.error.message));
        else p.ok(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
      }
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.fail(new Error('Chrome closed.'));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpPage> {
    const ws = new WebSocket(url);
    await new Promise<void>((ok, fail) => {
      ws.once('open', () => ok());
      ws.once('error', fail);
    });
    return new CdpPage(ws);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((ok, fail) => {
      const n = ++this.id;
      this.pending.set(n, { ok: ok as (v: unknown) => void, fail });
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }

  on(event: string, fn: (params: Record<string, unknown>) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }

  /** Runs an expression in the page and returns its value (promises awaited). */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /** Waits until `expression` is truthy in the page; its value, or null after `ms`. */
  async waitFor<T = unknown>(expression: string, ms: number, every = 400): Promise<T | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await this.eval<T>(expression).catch(() => null);
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  close(): void {
    this.ws.close();
  }
}

/** A Chrome Harv started, with a profile of its own. */
export class HarvChrome {
  private constructor(
    private proc: ChildProcess,
    private port: number,
    readonly headless: boolean,
  ) {}

  get running(): boolean {
    return this.proc.exitCode === null && !this.proc.killed;
  }

  /**
   * A plain Chrome window on `profile`, without the debugging port: Google refuses to sign in a
   * browser it can see is remote-controlled ("This browser or app may not be secure").
   */
  static openWindow(profile: string, url: string): ChildProcess {
    const chrome = findChrome();
    if (!chrome) throw new Error('Google Chrome isn’t installed (or set HARV_CHROME_PATH).');
    mkdirSync(profile, { recursive: true });
    return spawn(chrome, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url], {
      stdio: 'ignore',
      env: desktopEnv(),
    });
  }

  /** Starts Chrome on `profile` (headless, or a window the user sees) and waits for its debugging port. */
  static async launch(profile: string, opts: { headless: boolean; url?: string }): Promise<HarvChrome> {
    const chrome = findChrome();
    if (!chrome) throw new Error('Google Chrome isn’t installed (or set HARV_CHROME_PATH).');
    mkdirSync(profile, { recursive: true });
    const portFile = join(profile, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      ...(opts.headless ? ['--headless=new', '--window-size=1280,900'] : ['--window-size=1100,850']),
      opts.url ?? 'about:blank',
    ];
    const proc = spawn(chrome, args, { stdio: 'ignore', detached: false });
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) break;
      try {
        const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
        if (port > 0) return new HarvChrome(proc, port, opts.headless);
      } catch {
        // Not written yet.
      }
      await sleep(150);
    }
    proc.kill();
    throw new Error('Chrome didn’t start. If Harv’s Chrome window for Gemini is still open from another program, close it and try again.');
  }

  /** Opens a new tab at `url` and connects to it. */
  async open(url: string): Promise<CdpPage> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const target = (await res.json()) as { webSocketDebuggerUrl: string };
    return CdpPage.connect(target.webSocketDebuggerUrl);
  }

  /** The tabs open now (the user may have closed the window's last one). */
  async pages(): Promise<{ id: string; url: string }[]> {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${this.port}/json`)).json()) as { id: string; type: string; url: string }[];
      return list.filter((t) => t.type === 'page');
    } catch {
      return [];
    }
  }

  async closeTab(id: string): Promise<void> {
    await fetch(`http://127.0.0.1:${this.port}/json/close/${id}`).catch(() => undefined);
  }

  quit(): void {
    if (this.running) this.proc.kill();
  }

  onExit(fn: () => void): void {
    this.proc.once('exit', fn);
  }
}
