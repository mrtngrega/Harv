import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type HarvSettings } from '@harv/shared';
import { ChatStore } from '../store/chats.ts';
import { RouteStore } from '../store/routes.ts';
import { SyncEngine, type RemoteChanges, type SettingsPort } from './engine.ts';
import { SyncStore } from './store.ts';

const root = mkdtempSync(join(tmpdir(), 'harv-sync-'));
const open: { close(): void }[] = [];
afterAll(() => {
  for (const db of open) db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function settingsPort(initial: Partial<HarvSettings>): SettingsPort {
  let current: HarvSettings = { ...DEFAULT_SETTINGS, ...initial };
  let time = 0;
  const listeners = new Set<(before: HarvSettings, after: HarvSettings) => void>();
  return {
    load: () => current,
    update: (patch, quiet) => {
      const before = current;
      current = { ...current, ...patch };
      time = Date.now();
      if (!quiet) for (const l of listeners) l(before, current);
      return current;
    },
    time: () => time,
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

type Device = {
  home: string;
  chats: ChatStore;
  routes: RouteStore;
  memory: string;
  settings: SettingsPort;
  engine: SyncEngine;
  changes: RemoteChanges[];
  sync: () => Promise<void>;
};

let n = 0;
let remote = '';

function device(name: string): Device {
  const home = join(root, `${name}-${n}`);
  mkdirSync(home, { recursive: true });
  const db = join(home, 'harv.db');
  const chats = new ChatStore(db);
  const routes = new RouteStore(db);
  const memory = join(home, 'memory');
  const settings = settingsPort({ syncEnabled: true, syncRepo: remote, deviceName: name });
  const changes: RemoteChanges[] = [];
  const syncStore = new SyncStore(db);
  open.push(chats, routes, syncStore);
  const engine = new SyncEngine(
    home,
    chats,
    routes,
    syncStore,
    { chats: (c) => changes.push(c), settings: () => {}, status: () => {}, log: () => {} },
    memory,
    settings,
  );
  const sync = async () => {
    await engine.now();
    const error = engine.status().error;
    if (error) throw new Error(error);
  };
  return { home, chats, routes, memory, settings, engine, changes, sync };
}

/** Two devices on one fresh repo; the notebook already has the PC's key. */
async function pair(): Promise<[Device, Device]> {
  const pc = device('PC');
  const nb = device('notebook');
  await pc.sync();
  copyFileSync(join(pc.home, 'sync.key'), join(nb.home, 'sync.key'));
  await nb.sync();
  return [pc, nb];
}

const texts = (d: Device, id: string) => d.chats.snapshot(id)?.lines.map((l) => l.text);

beforeEach(() => {
  n++;
  remote = join(root, `remote-${n}.git`).replace(/\\/g, '/');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
});

// Real git against a bare repo on disk: a few seconds per test on Windows.
describe('Git sync between two devices', { timeout: 60_000 }, () => {
  it('brings a chat to the other device, which needs the key first', async () => {
    const pc = device('PC');
    pc.engine.start();
    pc.chats.ensureChat('c1', 'GPU question');
    pc.chats.addLine('c1', { kind: 'you', text: 'How hot is my GPU?' });
    pc.chats.addLine('c1', { kind: 'harv', text: '54 °C.', tag: 'haiku·low' });
    await pc.sync();

    const nb = device('notebook');
    await nb.engine.now();
    expect(nb.engine.status().needsKey).toBe(true);
    expect(nb.chats.exists('c1')).toBe(false);

    copyFileSync(join(pc.home, 'sync.key'), join(nb.home, 'sync.key'));
    await nb.sync();
    expect(nb.chats.title('c1')).toBe('GPU question');
    expect(texts(nb, 'c1')).toEqual(['How hot is my GPU?', '54 °C.']);
    expect(nb.chats.snapshot('c1')!.lines[1]!.tag).toBe('haiku·low');
    // In history, not opened as a tab.
    expect(nb.chats.history().map((h) => [h.id, h.open])).toEqual([['c1', false]]);
    expect(nb.engine.status().peers).toEqual([expect.objectContaining({ name: 'PC' })]);
    pc.engine.stop();
  });

  it('keeps everything in the repo encrypted', async () => {
    const [pc] = await pair();
    pc.chats.ensureChat('c1', 'Secret plans');
    pc.chats.addLine('c1', { kind: 'you', text: 'my bank is ExampleBank' });
    await pc.sync();
    const dir = join(pc.home, 'sync', pc.engine.id);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = readFileSync(join(dir, f));
      expect(raw.includes('ExampleBank')).toBe(false);
      expect(raw.includes('Secret')).toBe(false);
    }
  });

  it('continues a chat on the other device and back, without duplicates', async () => {
    const [pc, nb] = await pair();
    pc.chats.ensureChat('c1', 'Plan');
    pc.chats.addLine('c1', { kind: 'you', text: 'one' });
    await pc.sync();
    await nb.sync();
    nb.chats.addLine('c1', { kind: 'you', text: 'two' });
    await nb.sync();
    await pc.sync();
    expect(texts(pc, 'c1')).toEqual(['one', 'two']);
    // The PC's Claude session missed "two": the next message there starts fresh with the chat so far.
    expect(pc.chats.takeStale('c1')).toBe(true);
    expect(pc.chats.takeStale('c1')).toBe(false);
    expect(
      pc.changes
        .at(-1)!
        .lines.get('c1')!
        .map((l) => l.text),
    ).toEqual(['two']);

    pc.chats.addLine('c1', { kind: 'harv', text: 'three' });
    await pc.sync();
    await nb.sync();
    await nb.sync();
    await pc.sync();
    expect(texts(nb, 'c1')).toEqual(['one', 'two', 'three']);
    expect(texts(pc, 'c1')).toEqual(['one', 'two', 'three']);
  });

  it('forks a chat both devices wrote in while apart, losing nothing', async () => {
    const [pc, nb] = await pair();
    pc.chats.ensureChat('c1', 'Trip');
    pc.chats.addLine('c1', { kind: 'you', text: 'start' });
    await pc.sync();
    await nb.sync();
    pc.chats.addLine('c1', { kind: 'you', text: 'pc side' });
    nb.chats.addLine('c1', { kind: 'you', text: 'notebook side' });
    await pc.sync();
    await nb.sync();
    await pc.sync();

    expect(texts(pc, 'c1')).toEqual(['start', 'pc side']);
    const pcFork = pc.chats.history().find((h) => h.title === 'Trip (notebook)')!;
    expect(texts(pc, pcFork.id)!.slice(1)).toEqual(['notebook side']);
    expect(texts(nb, 'c1')).toEqual(['start', 'notebook side']);
    const nbFork = nb.chats.history().find((h) => h.title === 'Trip (PC)')!;
    expect(texts(nb, nbFork.id)!.slice(1)).toEqual(['pc side']);

    // Going on in the fork reaches the other device's original chat.
    nb.chats.addLine(nbFork.id, { kind: 'you', text: 'more on the pc side' });
    await nb.sync();
    await pc.sync();
    expect(texts(pc, 'c1')).toEqual(['start', 'pc side', 'more on the pc side']);
  });

  it('syncs renames (newest wins), /clear and delete', async () => {
    const [pc, nb] = await pair();
    pc.chats.ensureChat('c1', 'Old name');
    pc.chats.addLine('c1', { kind: 'you', text: 'hi' });
    pc.chats.ensureChat('c2', 'To delete');
    pc.chats.addLine('c2', { kind: 'you', text: 'bye' });
    await pc.sync();
    await nb.sync();

    nb.chats.setTitle('c1', 'New name', true);
    nb.chats.clearLines('c1');
    nb.chats.addLine('c1', { kind: 'you', text: 'fresh start' });
    nb.chats.delete('c2');
    await nb.sync();
    await pc.sync();
    expect(pc.chats.title('c1')).toBe('New name');
    expect(pc.chats.titleLocked('c1')).toBe(true);
    expect(texts(pc, 'c1')).toEqual(['fresh start']);
    expect(pc.chats.exists('c2')).toBe(false);
    const last = pc.changes.at(-1)!;
    expect([...last.deleted]).toEqual(['c2']);
    expect([...last.cleared]).toEqual(['c1']);
    expect(last.renamed.get('c1')).toBe('New name');
  });

  it('binds project chats by project name, each device with its own folder', async () => {
    const [pc, nb] = await pair();
    const pcProject = pc.chats.addProject('Harv', 'C:\\Code\\Harv');
    pc.chats.ensureChat('c1', 'Sync work');
    pc.chats.setProject('c1', pcProject.id);
    pc.chats.addLine('c1', { kind: 'you', text: 'build it' });
    await pc.sync();
    await nb.sync();
    // No such project on the notebook yet: a plain chat that remembers the name…
    expect(nb.chats.projectOf('c1')).toBeUndefined();
    // …and joins it when the project is added there.
    const nbProject = nb.chats.addProject('Harv', '/home/me/Code/Harv');
    expect(nb.chats.projectOf('c1')?.id).toBe(nbProject.id);
  });

  it('syncs memory, keeping both versions when both devices changed one', async () => {
    const [pc, nb] = await pair();
    mkdirSync(pc.memory, { recursive: true });
    writeFileSync(join(pc.memory, 'user-profile.md'), 'Likes short answers.\n');
    await pc.sync();
    await nb.sync();
    expect(readFileSync(join(nb.memory, 'user-profile.md'), 'utf8')).toBe('Likes short answers.\n');

    // Changed on one side only: just taken over.
    writeFileSync(join(nb.memory, 'user-profile.md'), 'Likes short answers. Uses Fedora.\n');
    await nb.sync();
    await pc.sync();
    expect(readFileSync(join(pc.memory, 'user-profile.md'), 'utf8')).toBe('Likes short answers. Uses Fedora.\n');
    expect(readdirSync(pc.memory)).toEqual(['user-profile.md']);

    // Changed on both while apart: the newer wins, the other is a note on both devices.
    writeFileSync(join(pc.memory, 'user-profile.md'), 'PC version\n');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(nb.memory, 'user-profile.md'), 'Notebook version\n');
    await pc.sync();
    await nb.sync();
    await pc.sync();
    await nb.sync();
    for (const d of [pc, nb]) {
      expect(readFileSync(join(d.memory, 'user-profile.md'), 'utf8')).toBe('Notebook version\n');
      const notes = readdirSync(d.memory).filter((f) => f.includes('conflict'));
      expect(notes).toEqual(['user-profile-conflict-pc.md']);
      expect(readFileSync(join(d.memory, notes[0]!), 'utf8')).toContain('PC version');
    }

    // Forgetting goes over too.
    rmSync(join(nb.memory, 'user-profile-conflict-pc.md'));
    await nb.sync();
    await pc.sync();
    expect(existsSync(join(pc.memory, 'user-profile-conflict-pc.md'))).toBe(false);
  });

  it('syncs shared settings but keeps device-only ones', async () => {
    const [pc, nb] = await pair();
    pc.settings.update({ accent: '#9FE0C4', projectsDir: 'C:\\Projects', uiScale: 110 }, false);
    await pc.sync();
    await nb.sync();
    const s = nb.settings.load();
    expect(s.accent).toBe('#9FE0C4');
    expect(s.projectsDir).toBe('');
    expect(s.uiScale).toBe(100);
    expect(s.deviceName).toBe('notebook');
  });

  it('counts the other device’s turns in Harv’s own usage', async () => {
    const [pc, nb] = await pair();
    pc.routes.add({ chatId: 'c1', model: 'haiku', effort: 'low', source: 'rule', reason: 'small talk' });
    pc.routes.finishLast('c1', { inputTokens: 1000, outputTokens: 50, durationMs: 900 });
    await pc.sync();
    await nb.sync();
    const usage = nb.routes.summary();
    expect(usage.turnsToday).toBe(1);
    expect(usage.inputTokensToday).toBe(1000);
    // The notebook's own "latest turn" in that chat isn't the PC's row.
    nb.routes.markLast('c1', 'harder');
    expect(nb.routes.split()[0]!.harder).toBe(0);
  });

  it('sends a snapshot of what was there before sync was turned on', async () => {
    const pc = device('PC');
    pc.settings.update({ syncEnabled: false }, true);
    pc.chats.ensureChat('old', 'From before');
    pc.chats.addLine('old', { kind: 'you', text: 'ancient history' });
    pc.settings.update({ syncEnabled: true }, false);
    await pc.sync();
    const nb = device('notebook');
    copyFileSync(join(pc.home, 'sync.key'), join(nb.home, 'sync.key'));
    await nb.sync();
    expect(texts(nb, 'old')).toEqual(['ancient history']);
    // A second snapshot (sync off and on again) adds nothing twice.
    pc.settings.update({ syncEnabled: false }, false);
    pc.settings.update({ syncEnabled: true }, false);
    await pc.sync();
    await nb.sync();
    expect(texts(nb, 'old')).toEqual(['ancient history']);
    expect(nb.chats.history()).toHaveLength(1);
  });
});
