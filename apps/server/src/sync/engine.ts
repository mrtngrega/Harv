import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, SHARED_SETTINGS, type HarvSettings, type StoredLine, type SyncPeer, type SyncStatus } from '@harv/shared';
import { MEMORY_DIR, toSlug } from '../agent/memory.ts';
import { loadSettings, onSettingsChange, settingsTime, updateSettings } from '../settings.ts';
import type { ChatStore } from '../store/chats.ts';
import type { RouteStore } from '../store/routes.ts';
import { loadKey, newKey, open, saveKey, seal } from './crypto.ts';
import type { Chunk, SyncEvent } from './events.ts';
import { SyncRepo } from './git.ts';
import type { SyncStore } from './store.ts';

/** How often Harv pulls and pushes (docs/PLAN.md §6m: a minute or two of latency). */
const INTERVAL_MS = 2 * 60 * 1000;
/** After a finished reply: push soon, but let a burst of lines settle first. */
const SOON_MS = 10 * 1000;
/** Events per chunk file. */
const CHUNK_EVENTS = 2000;
const CHUNK = /^(\d{12})-(\d{12})\.hrv$/;

const hash = (s: string | null) => (s === null ? null : createHash('sha256').update(s).digest('hex').slice(0, 16));
const pad = (n: number) => String(n).padStart(12, '0');
const isDefault = (key: keyof HarvSettings, value: unknown) => JSON.stringify(DEFAULT_SETTINGS[key]) === JSON.stringify(value);

/** What changed in the chats after applying the other device's events, for the dashboards. */
export interface RemoteChanges {
  lines: Map<string, StoredLine[]>;
  /** Chats made here because both devices wrote in the same chat while apart. */
  forks: Set<string>;
  renamed: Map<string, string>;
  /** Chats whose project changed (their Claude session must start again). */
  moved: Set<string>;
  cleared: Set<string>;
  deleted: Set<string>;
  /** Anything that changes the history list. */
  history: boolean;
}

/** How the engine reads and changes settings (replaced in tests, where two devices share one process). */
export interface SettingsPort {
  load(): HarvSettings;
  update(patch: Partial<HarvSettings>, quiet: boolean): HarvSettings;
  /** When settings.json last changed. */
  time(): number;
  onChange(listener: (before: HarvSettings, after: HarvSettings) => void): () => void;
}

const realSettings: SettingsPort = {
  load: loadSettings,
  update: updateSettings,
  time: settingsTime,
  onChange: onSettingsChange,
};

export interface SyncHooks {
  chats(changes: RemoteChanges): void;
  settings(settings: HarvSettings): void;
  status(status: SyncStatus): void;
  log(message: string, data?: Record<string, unknown>): void;
}

/** This device's id, made once (~/.harv/device.json). */
export function deviceId(home: string): string {
  const path = join(home, 'device.json');
  try {
    const id = (JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown }).id;
    if (typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) return id;
  } catch {
    // made below
  }
  const id = randomBytes(8).toString('hex');
  writeFileSync(path, `${JSON.stringify({ id }, null, 2)}\n`);
  return id;
}

/**
 * Git sync between the user's devices (M10b). Every local change becomes an event in the
 * outbox; a tick pulls the repo, applies what the other device wrote since its cursor, seals
 * this device's new events into a chunk file in its own folder, and pushes.
 */
export class SyncEngine {
  readonly id: string;
  private repo: SyncRepo;
  private keyPath: string;
  private timer?: NodeJS.Timeout;
  private soonTimer?: NodeJS.Timeout;
  private busy = false;
  private running: Promise<void> | null = null;
  private again = false;
  private lastError?: string;
  private needsKey = false;
  private unsubscribe?: () => void;

  constructor(
    home: string,
    private chats: ChatStore,
    private routes: RouteStore,
    private db: SyncStore,
    private hooks: SyncHooks,
    private memoryDir = MEMORY_DIR,
    private settings: SettingsPort = realSettings,
  ) {
    this.id = deviceId(home);
    this.repo = new SyncRepo(join(home, 'sync'), this.id);
    this.keyPath = join(home, 'sync.key');
    this.unsubscribe = this.settings.onChange((before, after) => this.settingsChanged(before, after));
    if (this.enabled && this.db.get('snapshot', false)) this.record(true);
  }

  get name(): string {
    return this.settings.load().deviceName || hostname();
  }

  private get enabled(): boolean {
    const s = this.settings.load();
    return s.syncEnabled && !!s.syncRepo;
  }

  status(): SyncStatus {
    const pushed = this.db.get('pushed', 0);
    const peers = [...this.db.withPrefix<Omit<SyncPeer, 'id'>>('peer:')].map(([id, p]) => ({ id, ...p }));
    const lastSync = this.db.get<number | null>('lastSync', null);
    return {
      enabled: this.enabled,
      device: { id: this.id, name: this.name },
      busy: this.busy,
      ...(lastSync ? { lastSync } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      pending: this.enabled ? this.db.count(pushed) : 0,
      peers,
      ...(this.needsKey ? { needsKey: true } : {}),
    };
  }

  private publish() {
    this.hooks.status(this.status());
  }

  /** Syncs now and every 2 minutes. */
  start(): void {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.soonTimer);
    this.unsubscribe?.();
    this.record(false);
  }

  /** A reply finished: push it in a few seconds. */
  soon(): void {
    if (!this.enabled) return;
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => void this.tick(), SOON_MS);
    this.soonTimer.unref();
  }

  /** Settings › Sync › Sync now. */
  now(): Promise<void> {
    return this.tick();
  }

  /** Starts or stops writing local changes to the outbox. */
  private record(on: boolean) {
    const add = (e: SyncEvent) => this.db.add(e);
    this.chats.onEvent = on ? add : undefined;
    this.routes.onEvent = on ? add : undefined;
  }

  private settingsChanged(before: HarvSettings, after: HarvSettings) {
    const was = before.syncEnabled && !!before.syncRepo;
    const is = after.syncEnabled && !!after.syncRepo;
    if (was && !is) {
      // Off: stop recording. Turning it on again sends a fresh snapshot (applying one twice changes nothing).
      this.record(false);
      this.db.set('snapshot', false);
      this.lastError = undefined;
    }
    if (is && (!was || before.syncRepo !== after.syncRepo)) void this.tick();
    if (is && this.db.get('snapshot', false)) {
      const now = Date.now();
      for (const key of SHARED_SETTINGS) {
        if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
        this.db.set(`setAt:${key}`, now);
        this.db.add({ t: 'setting', key, value: after[key], at: now });
      }
    }
    if (before.deviceName !== after.deviceName || was !== is) this.publish();
  }

  /** When a shared setting last changed here (one never changed through Harv counts from settings.json, if not the default). */
  private settingAt(key: (typeof SHARED_SETTINGS)[number], settings: HarvSettings): number {
    return this.db.get<number | null>(`setAt:${key}`, null) ?? (isDefault(key, settings[key]) ? 0 : this.settings.time());
  }

  /** One sync at a time: asked during one, another runs right after it (and the caller waits for that one). */
  private tick(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running.then(() => this.running ?? undefined);
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.tick();
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    this.busy = true;
    this.publish();
    try {
      await this.repo.ensure(this.settings.load().syncRepo);
      await this.repo.pull();
      const key = this.key();
      if (!key) return;
      // The snapshot goes first, so it doesn't send back what the other device just sent.
      if (!this.db.get('snapshot', false)) this.snapshot();
      // Local memory edits are noted before the other device's are applied, which would hide them.
      this.diffMemory();
      this.applyPeers(key);
      this.writeChunks(key);
      await this.repo.commit(`${this.name}: changes up to ${this.db.get('written', 0)}`);
      if ((await this.repo.ahead()) > 0) await this.repo.push();
      const written = this.db.get('written', 0);
      this.db.set('pushed', written);
      this.db.prune(written);
      this.db.set('lastSync', Date.now());
      this.lastError = undefined;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.hooks.log('Sync failed', { error: this.lastError });
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  /** The key, made on the first device. Another device has to get a copy of it (it never goes through the repo). */
  private key(): Buffer | null {
    const key = loadKey(this.keyPath);
    this.needsKey = false;
    if (key) return key;
    if (this.peerIds().some((peer) => this.chunkFiles(peer).length > 0)) {
      this.needsKey = true;
      this.lastError = 'This device has no sync key yet. Copy ~/.harv/sync.key from your other device, then press Sync now.';
      return null;
    }
    const made = newKey();
    saveKey(this.keyPath, made);
    return made;
  }

  private peerIds(): string[] {
    if (!existsSync(this.repo.dir)) return [];
    return readdirSync(this.repo.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[a-f0-9]{16}$/.test(d.name) && d.name !== this.id)
      .map((d) => d.name);
  }

  private chunkFiles(device: string): { file: string; from: number; to: number }[] {
    const dir = join(this.repo.dir, device);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((file) => {
        const m = CHUNK.exec(file);
        return m ? { file, from: Number(m[1]), to: Number(m[2]) } : null;
      })
      .filter((c): c is { file: string; from: number; to: number } => c !== null)
      .sort((a, b) => a.from - b.from);
  }

  /** The opening snapshot: everything this device has so far, then live recording from here on. */
  private snapshot() {
    for (const e of this.chats.exportEvents()) this.db.add(e);
    for (const e of this.routes.exportEvents()) this.db.add(e);
    const settings = this.settings.load();
    for (const key of SHARED_SETTINGS) {
      const at = this.settingAt(key, settings);
      if (at) this.db.add({ t: 'setting', key, value: settings[key], at });
    }
    // Memory files go out through the next diff (nothing is marked as sent yet).
    this.db.set('memory', {});
    this.db.set('snapshot', true);
    this.record(true);
  }

  private readMemory(name: string): string | null {
    const path = join(this.memoryDir, `${name}.md`);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  /** Memory changes since the last sync (by Harv's tools or by hand) become events. */
  private diffMemory() {
    const sent = this.db.get<Record<string, string>>('memory', {});
    const now: Record<string, string> = {};
    if (existsSync(this.memoryDir)) {
      for (const f of readdirSync(this.memoryDir).filter((f) => f.endsWith('.md'))) {
        const name = f.slice(0, -3);
        const content = readFileSync(join(this.memoryDir, f), 'utf8');
        now[name] = hash(content)!;
        if (sent[name] !== now[name]) {
          const at = statSync(join(this.memoryDir, f)).mtimeMs;
          this.db.add({ t: 'memory', name, content, base: sent[name] ?? null, at });
        }
      }
    }
    for (const name of Object.keys(sent)) {
      if (!(name in now)) this.db.add({ t: 'memory', name, content: null, base: sent[name]!, at: Date.now() });
    }
    this.db.set('memory', now);
  }

  private writeChunks(key: Buffer) {
    let written = this.db.get('written', 0);
    for (;;) {
      const events = this.db.after(written, CHUNK_EVENTS);
      if (!events.length) break;
      const from = events[0]!.seq;
      const to = events.at(-1)!.seq;
      const file = `${pad(from)}-${pad(to)}.hrv`;
      const chunk: Chunk = { v: 1, device: { id: this.id, name: this.name }, events };
      mkdirSync(join(this.repo.dir, this.id), { recursive: true });
      writeFileSync(join(this.repo.dir, this.id, file), seal(key, `${this.id}/${file}`, chunk));
      written = to;
      this.db.set('written', written);
    }
  }

  /** Applies what the other devices wrote since their cursors. */
  private applyPeers(key: Buffer) {
    const changes: RemoteChanges = {
      lines: new Map(),
      forks: new Set(),
      renamed: new Map(),
      moved: new Set(),
      cleared: new Set(),
      deleted: new Set(),
      history: false,
    };
    let settings: HarvSettings | undefined;
    for (const peer of this.peerIds()) {
      let cursor = this.db.get(`cursor:${peer}`, 0);
      for (const c of this.chunkFiles(peer)) {
        if (c.to <= cursor) continue;
        let chunk: Chunk;
        try {
          chunk = open<Chunk>(key, `${peer}/${c.file}`, readFileSync(join(this.repo.dir, peer, c.file)));
        } catch {
          throw new Error(
            'Couldn’t read the other device’s changes: the sync keys don’t match. Copy ~/.harv/sync.key from the first device.',
          );
        }
        let last = this.db.get<Omit<SyncPeer, 'id'> | null>(`peer:${peer}`, null)?.lastChange ?? 0;
        for (const { seq, e } of chunk.events) {
          if (seq <= cursor) continue;
          const changed = this.apply(e, chunk.device.name, changes);
          if (changed) settings = changed;
          last = Math.max(last, e.t === 'route' ? e.row.at : e.at);
        }
        cursor = c.to;
        this.db.set(`cursor:${peer}`, cursor);
        this.db.set(`peer:${peer}`, { name: chunk.device.name, lastChange: last || undefined });
      }
    }
    if (
      changes.lines.size ||
      changes.renamed.size ||
      changes.moved.size ||
      changes.cleared.size ||
      changes.deleted.size ||
      changes.history
    ) {
      this.hooks.chats(changes);
    }
    if (settings) this.hooks.settings(settings);
  }

  /** One event from the other device. Returns the new settings when a shared setting changed. */
  private apply(e: SyncEvent, deviceName: string, changes: RemoteChanges): HarvSettings | undefined {
    switch (e.t) {
      case 'chat': {
        const what = this.chats.applyChat(e);
        if (what === 'renamed') changes.renamed.set(e.chat, e.title);
        if (what === 'project') changes.moved.add(e.chat);
        if (what) changes.history = true;
        break;
      }
      case 'line': {
        const done = this.chats.applyLine(e, deviceName);
        if (!done) break;
        changes.lines.set(done.chat, [...(changes.lines.get(done.chat) ?? []), done.line]);
        if (done.forked) changes.forks.add(done.forked);
        changes.history = true;
        break;
      }
      case 'clear':
        if (this.chats.applyClear(e.chat)) {
          changes.cleared.add(e.chat);
          changes.lines.delete(e.chat);
        }
        break;
      case 'delete':
        if (this.chats.applyDelete(e.chat)) {
          changes.deleted.add(e.chat);
          changes.lines.delete(e.chat);
          changes.history = true;
        }
        break;
      case 'memory':
        this.applyMemory(e, deviceName);
        break;
      case 'setting': {
        const key = e.key as (typeof SHARED_SETTINGS)[number];
        if (!SHARED_SETTINGS.includes(key)) break;
        const current = this.settings.load();
        if (e.at <= this.settingAt(key, current)) break;
        this.db.set(`setAt:${key}`, e.at);
        if (JSON.stringify(current[key]) === JSON.stringify(e.value)) break;
        return this.settings.update({ [key]: e.value }, true);
      }
      case 'route':
        this.routes.applyRoute(e.row);
        break;
    }
    return undefined;
  }

  /**
   * A memory file from the other device. If this device changed it too since the version the
   * other one replaced, the newer one wins and the other is kept as a conflict note Harv merges later.
   */
  private applyMemory(e: Extract<SyncEvent, { t: 'memory' }>, deviceName: string) {
    const name = toSlug(e.name);
    if (!name || name !== e.name) return;
    const path = join(this.memoryDir, `${name}.md`);
    const current = this.readMemory(name);
    const write = (content: string | null) => {
      if (content === null) rmSync(path, { force: true });
      else {
        mkdirSync(this.memoryDir, { recursive: true });
        writeFileSync(path, content, 'utf8');
      }
    };
    if (current !== e.content) {
      if (hash(current) === e.base || current === null) write(e.content);
      else {
        const localAt = statSync(path).mtimeMs;
        const remoteWins = e.at >= localAt;
        const [loser, from, at] = remoteWins ? [current, this.name, localAt] : [e.content, deviceName, e.at];
        if (remoteWins) write(e.content);
        if (loser !== null) {
          const note = `${name}-conflict-${toSlug(from) ?? 'device'}`.slice(0, 60);
          writeFileSync(
            join(this.memoryDir, `${note}.md`),
            `Another version of the memory "${name}", from ${from} (${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}), written while the devices were apart. Merge what's still true into "${name}", then forget this note.\n\n${loser}`,
            'utf8',
          );
        }
      }
    }
    // Whatever is there now counts as sent, so the next diff doesn't send it back.
    const sent = this.db.get<Record<string, string>>('memory', {});
    const after = this.readMemory(name);
    if (after === null) delete sent[name];
    else sent[name] = hash(after)!;
    this.db.set('memory', sent);
  }
}
