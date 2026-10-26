import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, SHARED_SETTINGS, type HarvSettings, type StoredLine, type SyncPeer, type SyncStatus } from '@harv/shared';
import { MEMORY_DIR, toSlug } from '../agent/memory.ts';
import { loadSettings, onSettingsChange, settingsTime, updateSettings } from '../settings.ts';
import type { ChatStore } from '../store/chats.ts';
import type { RouteStore } from '../store/routes.ts';
import { loadKey, newKey, open, openBytes, saveKey, seal, sealBytes } from './crypto.ts';
import type { Chunk, SharedUi, SyncEvent } from './events.ts';
import { hashBytes, mergeLines, safeRelPath, scanFolder, type FileState } from './files.ts';
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
/** A memory name from the other device: letters, digits, spaces, dots, dashes, underscores; no path. */
const SAFE_NAME = /^\w[\w .-]{0,99}$/;
/**
 * Text files kept in step between devices, by sync name: the user's notes about Harv at the
 * repo root (each device has its own checkout). Still synced as "ideas", its name before
 * 2026-10-26 (Harv_ideas.txt), so devices on either version agree.
 */
export const SHARED_FILES: Record<string, string> = {
  ideas: fileURLToPath(new URL('../../../../harv_report.md', import.meta.url)),
};

/** Harv_ideas.txt became harv_report.md (2026-10-26, the user's wish): moved once at startup. */
export function moveOldReportFile(): void {
  const old = fileURLToPath(new URL('../../../../Harv_ideas.txt', import.meta.url));
  if (existsSync(old) && !existsSync(SHARED_FILES.ideas!)) renameSync(old, SHARED_FILES.ideas!);
}
const pad = (n: number) => String(n).padStart(12, '0');
const isDefault = (key: keyof HarvSettings, value: unknown) => JSON.stringify(DEFAULT_SETTINGS[key]) === JSON.stringify(value);

/** A folder whose files travel: attachments and Harv's own files, or the background photo. */
export interface SyncFolder {
  dir: string;
  /** Which files of it travel (a path relative to `dir`, forward slashes). */
  accept: (rel: string) => boolean;
  /** Before a file from the other device is written (the background photo replaces any other). */
  beforeWrite?: (rel: string) => void;
  /** Only the folder's own files, not its subfolders. */
  shallow?: boolean;
}

/** More of this device that syncs (docs/PLAN.md §6m "Everything Harv needs"); left out in older tests. */
export interface SyncExtras {
  /** Each registered project's Claude Code memory folder, by project name. */
  projectMemory?: () => Record<string, string>;
  folders?: Record<string, SyncFolder>;
  /** The dashboard layout's shared part, and when it last changed here. */
  ui?: () => { ui: SharedUi; at: number } | null;
}

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
  /** Projects the other device added or removed, in order (linked, cloned or unlisted here by the manager). */
  projects: { name: string; remote: string; removed: boolean }[];
  /** Anything that changes the history list. */
  history: boolean;
}

/** Everything one sync applied: the chat changes, and the newest layout from the other device. */
type Applied = RemoteChanges & { ui?: SharedUi };

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
  /** A sync went through: the projects can be pulled now. */
  synced?(): void;
  /** The other device's tabs and drafts are newer: show them here too (after `chats`). */
  ui?(ui: SharedUi): void;
  /** The other device showed this plan-usage warning. */
  warned?(key: string): void;
  /** A project has (or no longer has) work on the other device that isn't pushed yet. */
  projectState?(project: string, device: string, unsaved: boolean): void;
  /** A file from the other device was written (`root`, `path`): the background photo may have changed. */
  fileWritten?(root: string, path: string): void;
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
    private files: Record<string, string> = SHARED_FILES,
    private extra: SyncExtras = {},
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
    const add = (e: SyncEvent) => {
      this.db.add(e);
      if (e.t === 'delete') this.db.set(`deleted:${e.chat}`, e.at);
    };
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
      // A new working copy (first sync, or the repo's address changed) lacks chunks sealed but never pushed: seal them again.
      if (await this.repo.ensure(this.settings.load().syncRepo)) this.db.set('written', this.db.get('pushed', 0));
      await this.repo.pull();
      const key = this.key();
      if (!key) return;
      this.checkKey(key);
      // The snapshot goes first, so it doesn't send back what the other device just sent.
      if (!this.db.get('snapshot', false)) this.snapshot();
      // Local memory edits are noted before the other device's are applied, which would hide them.
      this.diffMemory();
      this.diffFiles();
      this.diffProjectMemory();
      this.diffFolders();
      this.diffUi();
      this.applyPeers(key);
      this.writeChunks(key);
      await this.repo.commit(`${this.name}: changes up to ${this.db.get('written', 0)}`);
      if ((await this.repo.ahead()) > 0) await this.repo.push();
      const written = this.db.get('written', 0);
      this.db.set('pushed', written);
      this.db.prune(written);
      this.db.set('lastSync', Date.now());
      this.lastError = undefined;
      this.hooks.synced?.();
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

  /**
   * A wrong key must never seal anything (the other device could never read it), so before
   * writing, the key has to open a chunk that's already in the repo, from any device.
   */
  private checkKey(key: Buffer) {
    for (const device of [this.id, ...this.peerIds()]) {
      const first = this.chunkFiles(device)[0];
      if (!first) continue;
      try {
        open(key, `${device}/${first.file}`, readFileSync(join(this.repo.dir, device, first.file)));
        return;
      } catch {
        throw new Error(
          'This device’s sync key doesn’t match the one the repo was made with, so nothing was sent. Copy ~/.harv/sync.key from the device that synced first.',
        );
      }
    }
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
    // Memory files go out through the next diff (nothing is marked as sent yet), and so do the others.
    this.db.set('memory', {});
    for (const project of this.db.withPrefix('pmemory:').keys()) this.db.set(`pmemory:${project}`, {});
    for (const root of Object.keys(this.extra.folders ?? {})) this.db.set(`folder:${root}`, {});
    this.db.set('uiSent', null);
    for (const name of Object.keys(this.files)) this.db.set(`file:${name}`, null);
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

  private readFile(name: string): string | null {
    const path = this.files[name]!;
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  /**
   * Shared file changes since the last sync become events. The last synced text is kept, so a
   * file that disappeared (say, git removed it from a checkout) is written back, never deleted.
   */
  private diffFiles() {
    for (const [name, path] of Object.entries(this.files)) {
      const sent = this.db.get<string | null>(`file:${name}`, null);
      const content = this.readFile(name);
      if (content === null) {
        if (sent !== null) writeFileSync(path, sent, 'utf8');
        continue;
      }
      if (content === sent) continue;
      this.db.add({ t: 'file', name, content, base: hash(sent), at: statSync(path).mtimeMs });
      this.db.set(`file:${name}`, content);
    }
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
      for (const { e } of events) if (e.t === 'blob' && e.hash) this.writeBlob(key, e.root, e.path, e.hash);
      writeFileSync(join(this.repo.dir, this.id, file), seal(key, `${this.id}/${file}`, chunk));
      written = to;
      this.db.set('written', written);
    }
  }

  /** Applies what the other devices wrote since their cursors. */
  private applyPeers(key: Buffer) {
    const changes: Applied = {
      lines: new Map(),
      forks: new Set(),
      renamed: new Map(),
      moved: new Set(),
      cleared: new Set(),
      deleted: new Set(),
      projects: [],
      history: false,
    };
    let settings: HarvSettings | undefined;
    // Shared files arrived before this version: once, read the chunks already seen again for them.
    const replay = !this.db.get('filesReplayed', false);
    for (const peer of this.peerIds()) {
      let cursor = this.db.get(`cursor:${peer}`, 0);
      for (const c of this.chunkFiles(peer)) {
        if (c.to <= cursor && !replay) continue;
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
          if (seq <= cursor) {
            if (e.t === 'file') this.applyFile(e);
            continue;
          }
          const changed = this.apply(e, chunk.device.name, changes, key, peer);
          if (changed) settings = changed;
          last = Math.max(last, e.t === 'route' ? e.row.at : e.at);
        }
        cursor = Math.max(cursor, c.to);
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
      changes.projects.length ||
      changes.history
    ) {
      this.hooks.chats(changes);
    }
    if (settings) this.hooks.settings(settings);
    if (changes.ui) this.hooks.ui?.(changes.ui);
    this.db.set('filesReplayed', true);
  }

  /** Deleted on either device: later changes to it are ignored. */
  private deleted(chat: string): boolean {
    return this.db.get<number | null>(`deleted:${chat}`, null) !== null;
  }

  /** One event from the other device. Returns the new settings when a shared setting changed. */
  private apply(e: SyncEvent, deviceName: string, changes: Applied, key: Buffer, peer: string): HarvSettings | undefined {
    switch (e.t) {
      case 'chat': {
        if (this.deleted(e.chat)) break;
        const what = this.chats.applyChat(e);
        if (what === 'renamed') changes.renamed.set(e.chat, e.title);
        if (what === 'project') changes.moved.add(e.chat);
        if (what) changes.history = true;
        break;
      }
      case 'line': {
        // Written on the other device while this one deleted the chat: deleting wins (that device deletes it too).
        if (this.deleted(e.chat)) break;
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
        this.db.set(`deleted:${e.chat}`, e.at);
        if (this.chats.applyDelete(e.chat)) {
          changes.deleted.add(e.chat);
          changes.lines.delete(e.chat);
          changes.history = true;
        }
        break;
      case 'memory':
        this.applyMemory(e, deviceName);
        break;
      case 'file':
        this.applyFile(e);
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
      case 'project':
        changes.projects.push({ name: e.name, remote: e.remote, removed: e.removed === true });
        break;
      case 'pmemory':
        this.applyProjectMemory(e);
        break;
      case 'blob':
        this.applyBlob(e, key, peer);
        break;
      case 'ui':
        // Newest wins: a layout changed here since then stays (and goes to the other device).
        if (e.at > this.db.get('uiAt', 0)) {
          this.db.set('uiAt', e.at);
          this.db.set('uiSent', hashBytes(JSON.stringify(e.ui)));
          changes.ui = e.ui;
        }
        break;
      case 'warned':
        // An old one (from an earlier 5-hour window) means nothing now.
        if (Date.now() - e.at < 5 * 60 * 60 * 1000) this.hooks.warned?.(e.key);
        break;
      case 'pstate':
        this.hooks.projectState?.(e.project, deviceName, e.unsaved);
        break;
    }
    return undefined;
  }

  /**
   * A memory file from the other device. If this device changed it too since the version the
   * other one replaced, the newer one wins and the other is kept as a conflict note Harv merges later.
   */
  private applyMemory(e: Extract<SyncEvent, { t: 'memory' }>, deviceName: string) {
    // Any plain file name, never a path: hand-made memories don't always look like Harv's own.
    const name = e.name;
    if (!SAFE_NAME.test(name) || name.includes('..') || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return;
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
          const note = `${name}-conflict-${toSlug(from) ?? 'device'}`.slice(0, 100);
          const when = new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          const text = `Another version of the memory "${name}", from ${from} (${when}), written while the devices were apart. Merge what's still true into "${name}", then forget this note.\n\n${loser}`;
          writeFileSync(join(this.memoryDir, `${note}.md`), text, 'utf8');
          // The other device writes the same note itself, so it counts as sent here (and deleting it reaches the other one).
          const sent = this.db.get<Record<string, string>>('memory', {});
          sent[note] = hash(text)!;
          this.db.set('memory', sent);
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

  /**
   * A shared file from the other device. If this device changed it too since the version the
   * other one replaced, the newer one is kept and the other's extra lines are added below it,
   * so no note is lost (both devices merge the same way, and end up with the same text).
   */
  private applyFile(e: Extract<SyncEvent, { t: 'file' }>) {
    const path = this.files[e.name];
    if (!path) return;
    const sent = this.db.get<string | null>(`file:${e.name}`, null);
    const current = this.readFile(e.name) ?? sent;
    let next = e.content;
    if (current !== null && current !== e.content && hash(current) !== e.base) {
      const localAt = existsSync(path) ? statSync(path).mtimeMs : 0;
      // A tie goes by the text, so both devices pick the same one.
      const remoteWins = e.at > localAt || (e.at === localAt && e.content > current);
      const [winner, loser] = remoteWins ? [e.content, current] : [current, e.content];
      const have = new Set(winner.split(/\r?\n/));
      const extra = loser.split(/\r?\n/).filter((l) => l.trim() && !have.has(l));
      next = extra.length ? `${winner.replace(/\s*$/, '')}\n${extra.join('\n')}\n` : winner;
    }
    if (next !== this.readFile(e.name)) writeFileSync(path, next, 'utf8');
    // What the other device has counts as sent; a merge differs from it, so the next diff sends the merge.
    this.db.set(`file:${e.name}`, e.content);
  }

  // ── Everything else Harv needs on both devices (docs/PLAN.md §6m) ──

  /** A plan-usage warning shown here: the other device needn't show it again. */
  noteWarned(key: string): void {
    if (this.enabled && this.db.get('snapshot', false)) this.db.add({ t: 'warned', key, at: Date.now() });
  }

  /** Whether each project has work here the other device can't get yet (after each pull); only changes are sent. */
  noteProjectStates(states: Record<string, boolean>): void {
    if (!this.enabled || !this.db.get('snapshot', false)) return;
    for (const [project, unsaved] of Object.entries(states)) {
      if (this.db.get(`pstate:${project}`, false) === unsaved) continue;
      this.db.set(`pstate:${project}`, unsaved);
      this.db.add({ t: 'pstate', project, unsaved, at: Date.now() });
    }
  }

  /** Project memory notes changed here since the last sync become events (per project, by name). */
  private diffProjectMemory() {
    for (const [project, dir] of Object.entries(this.extra.projectMemory?.() ?? {})) {
      this.applyPendingMemory(project);
      const sent = this.db.get<Record<string, string>>(`pmemory:${project}`, {});
      const now: Record<string, string> = {};
      if (existsSync(dir)) {
        for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
          const content = readFileSync(join(dir, f), 'utf8');
          now[f] = hash(content)!;
          if (sent[f] !== now[f]) {
            this.db.add({ t: 'pmemory', project, name: f, content, base: sent[f] ?? null, at: statSync(join(dir, f)).mtimeMs });
          }
        }
      }
      for (const f of Object.keys(sent)) {
        if (!(f in now)) this.db.add({ t: 'pmemory', project, name: f, content: null, base: sent[f]!, at: Date.now() });
      }
      this.db.set(`pmemory:${project}`, now);
    }
  }

  /** Notes for a project this device doesn't have yet wait until it does (it may still be cloning). */
  private applyPendingMemory(project: string) {
    const pending = this.db.get<Record<string, Extract<SyncEvent, { t: 'pmemory' }>>>('pmemoryPending', {});
    const mine = Object.entries(pending).filter(([, e]) => e.project === project);
    if (!mine.length) return;
    for (const [id] of mine) delete pending[id];
    this.db.set('pmemoryPending', pending);
    for (const [, e] of mine) this.applyProjectMemory(e);
  }

  /**
   * A project memory note from the other device. Edited on both sides: the newer one, plus the
   * other's lines it lacks (MEMORY.md is a list of lines, and no note gets lost).
   */
  private applyProjectMemory(e: Extract<SyncEvent, { t: 'pmemory' }>) {
    if (!SAFE_NAME.test(e.name) || !e.name.endsWith('.md') || e.name.includes('..')) return;
    const dir = this.extra.projectMemory?.()[e.project];
    if (!dir) {
      const pending = this.db.get<Record<string, typeof e>>('pmemoryPending', {});
      pending[`${e.project}/${e.name}`] = e;
      this.db.set('pmemoryPending', pending);
      return;
    }
    const path = join(dir, e.name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current !== e.content) {
      if (e.content === null) {
        // Deleted there: here too, unless it changed here since.
        if (current !== null && hash(current) === e.base) rmSync(path, { force: true });
      } else if (current === null || hash(current) === e.base) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, e.content, 'utf8');
      } else {
        const localAt = statSync(path).mtimeMs;
        // A tie goes by the text, so both devices pick the same one.
        const remoteWins = e.at > localAt || (e.at === localAt && e.content > current);
        const merged = remoteWins ? mergeLines(e.content, current) : mergeLines(current, e.content);
        if (merged !== current) writeFileSync(path, merged, 'utf8');
      }
    }
    // What the other device has counts as sent; a merge (or a kept note) differs from it, so the next diff sends it.
    const sent = this.db.get<Record<string, string>>(`pmemory:${e.project}`, {});
    if (e.content === null) delete sent[e.name];
    else sent[e.name] = hash(e.content)!;
    this.db.set(`pmemory:${e.project}`, sent);
  }

  /** Files added, changed or deleted in the synced folders become events; their bytes go out with the chunk. */
  private diffFolders() {
    for (const [root, folder] of Object.entries(this.extra.folders ?? {})) {
      const sent = this.db.get<Record<string, FileState>>(`folder:${root}`, {});
      const now = scanFolder(folder.dir, folder.accept, sent, folder.shallow);
      for (const [rel, st] of Object.entries(now)) {
        if (sent[rel]?.hash === st.hash) continue;
        this.db.add({ t: 'blob', root, path: rel, hash: st.hash, base: sent[rel]?.hash ?? null, size: st.size, at: st.mtime });
      }
      for (const [rel, st] of Object.entries(sent)) {
        // A file that grew too big to travel is still there: that isn't a delete.
        if (!(rel in now) && !existsSync(join(folder.dir, ...rel.split('/'))))
          this.db.add({ t: 'blob', root, path: rel, hash: null, base: st.hash, size: 0, at: Date.now() });
      }
      this.db.set(`folder:${root}`, now);
    }
  }

  /** The file's bytes, sealed into this device's folder of the repo (once per content). */
  private writeBlob(key: Buffer, root: string, rel: string, fileHash: string) {
    const out = join(this.repo.dir, this.id, 'blobs', `${fileHash}.hrv`);
    if (existsSync(out)) return;
    const folder = this.extra.folders?.[root];
    const src = folder && join(folder.dir, ...rel.split('/'));
    if (!src || !existsSync(src)) return;
    const data = readFileSync(src);
    // Changed again since: that version goes out with its own event.
    if (hashBytes(data) !== fileHash) return;
    mkdirSync(join(this.repo.dir, this.id, 'blobs'), { recursive: true });
    writeFileSync(out, sealBytes(key, `blobs/${fileHash}`, data));
  }

  /** A file from the other device. Changed on both sides: the newer one wins (files aren't merged). */
  private applyBlob(e: Extract<SyncEvent, { t: 'blob' }>, key: Buffer, peer: string) {
    const folder = this.extra.folders?.[e.root];
    if (!folder || !safeRelPath(e.path) || !folder.accept(e.path)) return;
    const path = join(folder.dir, ...e.path.split('/'));
    const sent = this.db.get<Record<string, FileState>>(`folder:${e.root}`, {});
    const current = existsSync(path) ? hashBytes(readFileSync(path)) : null;
    const remember = () => {
      if (existsSync(path)) {
        const st = statSync(path);
        sent[e.path] = { hash: hashBytes(readFileSync(path)), size: st.size, mtime: st.mtimeMs };
      } else delete sent[e.path];
      this.db.set(`folder:${e.root}`, sent);
    };
    if (current === e.hash) return remember();
    // Not the version the other device replaced (changed here too, or never the same): the newer one stays.
    if (current !== null && current !== e.base && statSync(path).mtimeMs > e.at) return;
    if (e.hash === null) {
      if (current !== null && current === e.base) rmSync(path, { force: true });
      return remember();
    }
    const blob = join(this.repo.dir, peer, 'blobs', `${e.hash}.hrv`);
    if (!existsSync(blob)) {
      this.hooks.log('Sync: a file from the other device came without its contents', { path: e.path });
      return;
    }
    const data = openBytes(key, `blobs/${e.hash}`, readFileSync(blob));
    folder.beforeWrite?.(e.path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, data);
    remember();
    this.hooks.fileWritten?.(e.root, e.path);
  }

  /** The dashboard layout's shared part changed here since the last sync: it goes out (newest wins on the other side). */
  private diffUi() {
    const now = this.extra.ui?.();
    if (!now) return;
    const h = hashBytes(JSON.stringify(now.ui));
    if (h === this.db.get<string | null>('uiSent', null)) return;
    const at = Math.max(now.at, this.db.get('uiAt', 0) + 1);
    this.db.set('uiSent', h);
    this.db.set('uiAt', at);
    this.db.add({ t: 'ui', ui: now.ui, at });
  }
}
