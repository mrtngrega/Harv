import { createHmac, timingSafeEqual } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { SERVER_PORT } from '@harv/shared';

// One phone app for both computers (docs/PLAN.md §6q): the phone talks to the Harv it was installed
// from (pairing, Face ID), and when it picks the other device, this Harv forwards the dashboard's
// requests and its WebSocket to that device's live-sync port (Tailscale only, same account). Each
// forwarded request carries a short-lived proof made with the sync key, which only the user's own
// Harvs have; the other device then treats it as its own dashboard.

/** A proof is good this long (clocks of the two devices may differ a little). */
const PROOF_MS = 2 * 60_000;
export const RELAY_HEADER = 'x-harv-relay';
export const RELAY_PREFIX = '/relay';

export function relayProof(key: Buffer, now = Date.now()): string {
  const at = String(now);
  return `${at}.${createHmac('sha256', key).update(`harv-relay:${at}`).digest('base64url')}`;
}

export function relayOk(key: Buffer | null, proof: string | undefined, now = Date.now()): boolean {
  if (!key || !proof) return false;
  const [at = '', mac = ''] = proof.split('.');
  const t = Number(at);
  if (!Number.isFinite(t) || Math.abs(now - t) > PROOF_MS) return false;
  const want = Buffer.from(createHmac('sha256', key).update(`harv-relay:${at}`).digest('base64url'));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** What the phone sent, minus what belongs to this Harv only (its cookies, Tailscale's and the browser's site headers). */
export function forwardHeaders(headers: IncomingHttpHeaders, proof: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (/^(host|cookie|origin|referer|x-forwarded-.*|tailscale-.*|sec-fetch-.*|x-harv-relay)$/i.test(name)) continue;
    out[name] = value;
  }
  out[RELAY_HEADER] = proof;
  return out;
}

/** On the other device: the request as its own dashboard would make it. */
export function localHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || /^(host|origin|x-harv-relay|x-forwarded-.*|tailscale-.*)$/i.test(name)) continue;
    out[name] = value;
  }
  out.host = `127.0.0.1:${SERVER_PORT}`;
  out.origin = 'http://127.0.0.1:5173';
  out['sec-fetch-site'] = 'same-origin';
  return out;
}

function rawUpgrade(path: string, headers: Record<string, string | string[]>): string {
  const lines = [`GET ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Joins two sockets; ending either ends both. */
function pipeBoth(a: Socket, b: Socket) {
  a.pipe(b);
  b.pipe(a);
  const end = () => (a.destroy(), b.destroy());
  a.on('error', end).on('close', end);
  b.on('error', end).on('close', end);
}

export interface Peer {
  ip: string;
  port: number;
}

// ---- This Harv (the phone's): sends the phone's requests on ----

export function forwardHttp(req: IncomingMessage, res: ServerResponse, peer: Peer, proof: string) {
  const out = request(
    {
      host: peer.ip,
      port: peer.port,
      method: req.method,
      path: `${RELAY_PREFIX}${req.url}`,
      headers: forwardHeaders(req.headers, proof),
      timeout: 60_000,
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  out.on('timeout', () => out.destroy(new Error('timeout')));
  out.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'The other computer’s Harv didn’t answer. Is it on and awake?' }));
  });
  req.pipe(out);
}

/** The phone's WebSocket, on to the other device. Returns the joined socket (closed when the phone's unlock ends). */
export function forwardWs(req: IncomingMessage, socket: Socket, head: Buffer, peer: Peer, proof: string): Socket {
  const up = connect(peer.port, peer.ip, () => {
    up.write(rawUpgrade(`${RELAY_PREFIX}${req.url}`, forwardHeaders(req.headers, proof)));
    if (head.length) up.write(head);
    pipeBoth(socket, up);
  });
  up.on('error', () => socket.destroy());
  return up;
}

// ---- The other device: takes a proven request and hands it to its own server ----

export function serveRelayHttp(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? '/').slice(RELAY_PREFIX.length) || '/';
  const out = request(
    { host: '127.0.0.1', port: SERVER_PORT, method: req.method, path, headers: localHeaders(req.headers), timeout: 60_000 },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  out.on('error', () => res.writeHead(502).end());
  req.pipe(out);
}

export function serveRelayWs(req: IncomingMessage, socket: Socket, head: Buffer) {
  const path = (req.url ?? '/').slice(RELAY_PREFIX.length) || '/';
  const local = connect(SERVER_PORT, '127.0.0.1', () => {
    local.write(rawUpgrade(path, localHeaders(req.headers)));
    if (head.length) local.write(head);
    pipeBoth(socket, local);
  });
  local.on('error', () => socket.destroy());
}
