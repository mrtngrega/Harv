import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { IS_WINDOWS } from '../platform.ts';
import { RELAY_HEADER, RELAY_PREFIX, relayOk, serveRelayHttp, serveRelayWs } from '../phone/relay.ts';
import type { SyncEngine } from './engine.ts';

// Live sync over Tailscale (M10c, docs/PLAN.md §6m): when both devices are on, each change goes
// straight to the other Harv within seconds; git stays the mailbox for when one is off. Harv
// listens on its tailnet address only (never 0.0.0.0, never Funnel), takes requests only from
// tailnet addresses that Tailscale says belong to the same account, and every batch is sealed
// with the sync key, so only the user's own Harvs can read or send one.

export const LIVE_PORT = 4318;
/** Tailscale's address range (CGNAT, 100.64.0.0/10). */
const TAILNET = /^(?:::ffff:)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const MAX_BODY = 64 * 1024 * 1024;
/** Local changes are sent after this pause (a reply's lines come in a burst). */
const SOON_MS = 1200;
/** Checks in with the peer this often anyway (it may have come online). */
const PROBE_MS = 30_000;
/** After a failed exchange, the peer is left alone this long. */
const BACKOFF_MS = 60_000;

export const inTailnet = (ip: string | undefined) => !!ip && TAILNET.test(ip);

/** The tailscale CLI, where it is on this OS. */
function cli(): string {
  const win = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  return IS_WINDOWS && existsSync(win) ? win : 'tailscale';
}

/** Runs the tailscale CLI (also used by phone access, docs/PLAN.md §6q). */
export function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cli(), args, { timeout: 8000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out)))),
  );
}

/** What Harv asks Tailscale (replaced in tests). */
export interface Tailscale {
  /** This device's tailnet IPv4, or null when Tailscale isn't up. */
  ip(): Promise<string | null>;
  /** The account that owns the device at this tailnet address. */
  owner(ip: string): Promise<string | null>;
  /** This device's own account. */
  self(): Promise<string | null>;
}

export const tailscaleCli: Tailscale = {
  async ip() {
    try {
      const ip = (await run(['ip', '-4'])).trim().split(/\s+/)[0] ?? '';
      return inTailnet(ip) ? ip : null;
    } catch {
      return null;
    }
  },
  async owner(ip) {
    try {
      return (
        (JSON.parse(await run(['whois', '--json', ip.replace(/^::ffff:/, '')])) as { UserProfile?: { LoginName?: string } }).UserProfile
          ?.LoginName ?? null
      );
    } catch {
      return null;
    }
  },
  async self() {
    try {
      const s = JSON.parse(await run(['status', '--json'])) as {
        Self?: { UserID?: number };
        User?: Record<string, { LoginName?: string }>;
      };
      return s.User?.[String(s.Self?.UserID)]?.LoginName ?? null;
    } catch {
      return null;
    }
  },
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Too big'));
      } else parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function post(ip: string, port: number, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: ip,
        port,
        path: '/live',
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
        timeout: 20_000,
      },
      (res) => {
        void readBody(res).then((data) => (res.statusCode === 200 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}`))), reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export class LiveLink {
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private probe: NodeJS.Timeout | null = null;
  private pushing = false;
  private again = false;
  private quietUntil = new Map<string, number>();
  private trusted = new Map<string, { ok: boolean; until: number }>();
  private account: string | null = null;
  /** The last exchange with each peer, for the heartbeat. */
  private beats = new Map<string, number>();

  constructor(
    private engine: SyncEngine,
    private log: (message: string, data?: Record<string, unknown>) => void,
    private tailscale: Tailscale = tailscaleCli,
    private port = LIVE_PORT,
  ) {}

  /** Listens on this device's tailnet address, if Tailscale is up. */
  async start(): Promise<boolean> {
    const ip = await this.tailscale.ip();
    this.account = await this.tailscale.self();
    if (!ip || !this.account) {
      this.log('Live sync: Tailscale is not running here, so changes go through git only');
      return false;
    }
    this.server = createServer((req, res) => void this.handle(req, res));
    // The phone's dashboard connection, forwarded by the other Harv.
    this.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!req.url?.startsWith(`${RELAY_PREFIX}/`)) return void socket.destroy();
      void this.relayAllowed(req).then((ok) => (ok ? serveRelayWs(req, socket, head) : socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, ip, () => resolve());
    }).catch((err: Error) => {
      this.log('Live sync: could not listen', { error: err.message });
      this.server = null;
    });
    if (!this.server) return false;
    this.engine.setLiveAddress(ip, this.port);
    this.engine.onLocalChange = () => this.soon();
    this.probe = setInterval(() => this.soon(0), PROBE_MS);
    this.probe.unref();
    this.soon(0);
    return true;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.probe) clearInterval(this.probe);
    this.engine.onLocalChange = undefined;
    this.server?.close();
    this.server = null;
  }

  /** The same account as this device, says Tailscale (asked once per address every 10 minutes). */
  private async isMine(ip: string): Promise<boolean> {
    const known = this.trusted.get(ip);
    if (known && known.until > Date.now()) return known.ok;
    const ok = !!this.account && (await this.tailscale.owner(ip)) === this.account;
    this.trusted.set(ip, { ok, until: Date.now() + 10 * 60_000 });
    return ok;
  }

  /** A phone's request, forwarded by the user's other Harv (docs/PLAN.md §6q): same account and the sync key's proof. */
  private async relayAllowed(req: IncomingMessage): Promise<boolean> {
    const ip = req.socket.remoteAddress;
    return inTailnet(ip) && (await this.isMine(ip!)) && relayOk(this.engine.syncKey(), req.headers[RELAY_HEADER] as string | undefined);
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const ip = req.socket.remoteAddress;
    if (req.url?.startsWith(`${RELAY_PREFIX}/`)) {
      if (!(await this.relayAllowed(req))) return void res.writeHead(403).end();
      return serveRelayHttp(req, res);
    }
    if (req.method !== 'POST' || req.url !== '/live') return void res.writeHead(404).end();
    if (!inTailnet(ip) || !(await this.isMine(ip!))) return void res.writeHead(403).end();
    try {
      const answer = await this.engine.receiveLive(await readBody(req));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(answer);
      // It's on: whatever waits for it goes now.
      this.soon(0);
    } catch (err) {
      this.log('Live sync: refused a batch', { error: (err as Error).message });
      res.writeHead(400).end();
    }
  }

  /** Sends local changes in a moment (several changes in a row go together). */
  soon(ms = SOON_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push(), ms);
    this.timer.unref();
  }

  /** One exchange round with every peer that has a live address and isn't resting after a failure. */
  async push(): Promise<void> {
    if (this.pushing) {
      this.again = true;
      return;
    }
    this.pushing = true;
    try {
      for (const peer of this.engine.livePeers()) {
        if ((this.quietUntil.get(peer.id) ?? 0) > Date.now() || !inTailnet(peer.ip)) continue;
        try {
          for (let round = 0; round < 50; round++) {
            const beat = round === 0 && Date.now() - (this.beats.get(peer.id) ?? 0) > PROBE_MS - 5000;
            const body = await this.engine.liveOutgoing(peer.id, beat);
            if (!body) break;
            const more = this.engine.liveAcked(peer.id, await post(peer.ip, peer.port, body));
            this.beats.set(peer.id, Date.now());
            if (!more) break;
          }
        } catch {
          // Off, asleep or not on the tailnet right now: git carries the changes, live tries again later.
          this.engine.liveLost(peer.id);
          this.quietUntil.set(peer.id, Date.now() + BACKOFF_MS);
        }
      }
    } finally {
      this.pushing = false;
      if (this.again) {
        this.again = false;
        this.soon(0);
      }
    }
  }
}
