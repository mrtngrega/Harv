import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type HarvSettings } from '@harv/shared';
import { ChatStore } from '../store/chats.ts';
import { RouteStore } from '../store/routes.ts';
import { SyncEngine, type RemoteChanges, type SettingsPort } from './engine.ts';
import { inTailnet, LiveLink, type Tailscale } from './live.ts';
import { SyncStore } from './store.ts';

const root = mkdtempSync(join(tmpdir(), 'harv-live-'));
const open: { close(): void }[] = [];
afterAll(() => {
  for (const db of open) db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function settingsPort(initial: Partial<HarvSettings>): SettingsPort {
  const current: HarvSettings = { ...DEFAULT_SETTINGS, ...initial };
  return { load: () => current, update: () => current, time: () => 0, onChange: () => () => {} };
}

let n = 0;
let remote = '';
beforeEach(() => {
  n++;
  remote = join(root, `remote-${n}.git`).replace(/\\/g, '/');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
});

function device(name: string) {
  const home = join(root, `${name}-${n}`);
  mkdirSync(home, { recursive: true });
  const db = join(home, 'harv.db');
  const chats = new ChatStore(db);
  const routes = new RouteStore(db);
  const store = new SyncStore(db);
  open.push(chats, routes, store);
  const changes: RemoteChanges[] = [];
  const engine = new SyncEngine(
    home,
    chats,
    routes,
    store,
    { chats: (c) => changes.push(c), settings: () => {}, status: () => {}, log: () => {} },
    join(home, 'memory'),
    settingsPort({ syncEnabled: true, syncRepo: remote, deviceName: name }),
    {},
  );
  return { home, chats, engine, changes, store };
}

/** One live exchange from `a` to `b`, the way LiveLink.push runs it. */
async function exchange(a: ReturnType<typeof device>, b: ReturnType<typeof device>) {
  for (let round = 0; round < 10; round++) {
    const body = await a.engine.liveOutgoing(b.engine.id);
    if (!body) return;
    if (!a.engine.liveAcked(b.engine.id, await b.engine.receiveLive(body))) return;
  }
}

describe('live sync over Tailscale (M10c)', { timeout: 60_000 }, () => {
  it('brings a new line across in one exchange, and the git copy later changes nothing', async () => {
    const pc = device('PC');
    const nb = device('notebook');
    pc.engine.setLiveAddress('100.66.87.40', 4318);
    nb.engine.setLiveAddress('100.81.213.75', 4318);
    await pc.engine.now();
    copyFileSync(join(pc.home, 'sync.key'), join(nb.home, 'sync.key'));
    await nb.engine.now();
    await pc.engine.now();
    expect(pc.engine.livePeers()).toEqual([{ id: nb.engine.id, name: 'notebook', ip: '100.81.213.75', port: 4318 }]);

    // The first exchange only learns the notebook's cursor.
    await exchange(pc, nb);
    pc.chats.ensureChat('c1', 'Live chat');
    pc.chats.addLine('c1', { kind: 'you', text: 'hello from the PC' });
    pc.chats.addLine('c1', { kind: 'harv', text: 'hi!' });
    await exchange(pc, nb);
    expect(nb.chats.snapshot('c1')?.lines.map((l) => l.text)).toEqual(['hello from the PC', 'hi!']);
    expect(nb.engine.status().peers.find((p) => p.id === pc.engine.id)?.live).toBeGreaterThan(0);

    // Git brings the same events later: nothing is added twice.
    await pc.engine.now();
    await nb.engine.now();
    expect(nb.chats.snapshot('c1')?.lines.map((l) => l.text)).toEqual(['hello from the PC', 'hi!']);
  });

  it('refuses a batch sealed with another key, and leaves a gap to git', async () => {
    const pc = device('PC');
    const nb = device('notebook');
    await pc.engine.now();
    await nb.engine.now(); // no key: it waits for one
    copyFileSync(join(pc.home, 'sync.key'), join(nb.home, 'sync.key'));
    await nb.engine.now();
    pc.chats.ensureChat('c2', 'Gap');
    pc.chats.addLine('c2', { kind: 'you', text: 'one' });
    // Pushed through git and pruned on the PC, but the notebook hasn't pulled yet.
    await pc.engine.now();
    pc.chats.addLine('c2', { kind: 'you', text: 'two' });
    // Pretend the notebook said its cursor is 0: the PC's live batch starts after what it pruned.
    pc.store.set(`liveAck:${nb.engine.id}`, 0);
    const body = (await pc.engine.liveOutgoing(nb.engine.id))!;
    await nb.engine.receiveLive(body);
    expect(nb.chats.exists('c2')).toBe(false);

    const other = device('stranger');
    await expect(other.engine.receiveLive(body)).rejects.toThrow();
  });
});

describe('who may talk to the live port', () => {
  it('takes only tailnet addresses', () => {
    expect(inTailnet('100.81.213.75')).toBe(true);
    expect(inTailnet('::ffff:100.66.87.40')).toBe(true);
    expect(inTailnet('100.128.0.1')).toBe(false);
    expect(inTailnet('192.168.1.20')).toBe(false);
    expect(inTailnet('25.1.2.3')).toBe(false); // Hamachi
    expect(inTailnet(undefined)).toBe(false);
  });

  it("doesn't listen when Tailscale isn't up", async () => {
    const d = device('PC');
    const off: Tailscale = { ip: async () => null, owner: async () => null, self: async () => null };
    const link = new LiveLink(d.engine, () => {}, off, 0);
    expect(await link.start()).toBe(false);
    link.stop();
  });
});
