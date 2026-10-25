import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ChatSnapshot, HistoryItem, LineKind, Project, StoredLine } from '@harv/shared';
import type { SyncEvent } from '../sync/events.ts';

type LineEvent = Extract<SyncEvent, { t: 'line' }>;
type LineRow = {
  kind: LineKind;
  text: string;
  tag: string | null;
  reason: string | null;
  files: string | null;
  ref: string | null;
  created_at: number;
};

const fromRow = (r: LineRow): StoredLine => ({
  kind: r.kind,
  text: r.text,
  ...(r.tag ? { tag: r.tag } : {}),
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.files ? { files: JSON.parse(r.files) as string[] } : {}),
  ...(r.ref ? { ref: r.ref } : {}),
  at: r.created_at,
});

const lineEvent = (chat: string, uid: string, prev: string | null, line: StoredLine, at: number): LineEvent => ({
  t: 'line',
  chat,
  uid,
  prev,
  kind: line.kind,
  text: line.text,
  ...(line.tag ? { tag: line.tag } : {}),
  ...(line.reason ? { reason: line.reason } : {}),
  ...(line.files?.length ? { files: line.files } : {}),
  ...(line.ref ? { ref: line.ref } : {}),
  at,
});

/** What a line event says, as a line. */
const toLine = (e: LineEvent): StoredLine => ({
  kind: e.kind,
  text: e.text,
  ...(e.tag ? { tag: e.tag } : {}),
  ...(e.reason ? { reason: e.reason } : {}),
  ...(e.files?.length ? { files: e.files } : {}),
  ...(e.ref ? { ref: e.ref } : {}),
});

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS chats (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    session_id TEXT,
    open       INTEGER NOT NULL DEFAULT 1,
    context    INTEGER,
    title_locked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    text       TEXT NOT NULL,
    tag        TEXT,
    reason     TEXT,
    files      TEXT,
    ref        TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lines_by_chat ON lines(chat_id, id);
  CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  );
`;

/** Lines kept per chat when restoring a tab (older ones stay in the database). */
const RESTORE_LINES = 500;

const likePattern = (query: string) => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** ~80 characters of `text` around the first match of `query`. */
export function snippetAround(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 80);
  const start = Math.max(0, at - 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 80).replace(/\s+/g, ' ')}${start + 80 < text.length ? '…' : ''}`;
}

/** Chat history in SQLite (Node's built-in driver): one row per chat, one per finished line. */
type ProjectRow = { id: string; name: string; path: string; remote: string | null };
const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, path: r.path, ...(r.remote ? { remote: r.remote } : {}) });

export class ChatStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Databases from before M4 lack the attachments column.
    const columns = this.db.prepare('PRAGMA table_info(lines)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'files')) this.db.exec('ALTER TABLE lines ADD COLUMN files TEXT');
    if (!columns.some((c) => c.name === 'ref')) this.db.exec('ALTER TABLE lines ADD COLUMN ref TEXT');
    if (!columns.some((c) => c.name === 'reason')) this.db.exec('ALTER TABLE lines ADD COLUMN reason TEXT');
    const chatColumns = this.db.prepare('PRAGMA table_info(chats)').all() as { name: string }[];
    if (!chatColumns.some((c) => c.name === 'context')) this.db.exec('ALTER TABLE chats ADD COLUMN context INTEGER');
    if (!chatColumns.some((c) => c.name === 'title_locked')) {
      this.db.exec('ALTER TABLE chats ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0');
    }
    if (!chatColumns.some((c) => c.name === 'project_id')) this.db.exec('ALTER TABLE chats ADD COLUMN project_id TEXT');
    // Sync (M10b): a line id both devices share, when a chat's name or project last changed, whether its
    // Claude session missed lines from the other device, and a project known there only by name.
    if (!columns.some((c) => c.name === 'uid')) this.db.exec('ALTER TABLE lines ADD COLUMN uid TEXT');
    if (!chatColumns.some((c) => c.name === 'meta_at')) this.db.exec('ALTER TABLE chats ADD COLUMN meta_at INTEGER NOT NULL DEFAULT 0');
    if (!chatColumns.some((c) => c.name === 'stale')) this.db.exec('ALTER TABLE chats ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
    if (!chatColumns.some((c) => c.name === 'project_name')) this.db.exec('ALTER TABLE chats ADD COLUMN project_name TEXT');
    // Project sync (docs/PLAN.md §6n): a project's GitHub repo.
    const projectColumns = this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    if (!projectColumns.some((c) => c.name === 'remote')) this.db.exec('ALTER TABLE projects ADD COLUMN remote TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS lines_by_uid ON lines(uid)');
    const missing = this.db.prepare('SELECT id FROM lines WHERE uid IS NULL').all() as { id: number }[];
    if (missing.length) {
      const set = this.db.prepare('UPDATE lines SET uid = ? WHERE id = ?');
      this.db.exec('BEGIN');
      for (const { id } of missing) set.run(randomUUID(), id);
      this.db.exec('COMMIT');
    }
  }

  /** Every local change, for sync (set while sync is on). Changes applied from the other device don't call it. */
  onEvent?: (e: SyncEvent) => void;

  private chatEvent(id: string): Extract<SyncEvent, { t: 'chat' }> | undefined {
    const row = this.db
      .prepare(
        `SELECT c.title, c.title_locked, c.created_at, c.meta_at, COALESCE(p.name, c.project_name) AS project
         FROM chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
      )
      .get(id) as { title: string; title_locked: number; created_at: number; meta_at: number; project: string | null } | undefined;
    if (!row) return undefined;
    return {
      t: 'chat',
      chat: id,
      title: row.title,
      locked: row.title_locked === 1,
      project: row.project,
      created: row.created_at,
      at: row.meta_at || row.created_at,
    };
  }

  /** The chat's name or project changed here. */
  private touchMeta(id: string) {
    this.db.prepare('UPDATE chats SET meta_at = ? WHERE id = ?').run(Date.now(), id);
    const e = this.onEvent && this.chatEvent(id);
    if (e) this.onEvent!(e);
  }

  /** The uid of a chat's newest shared line (notes that stay on this device have none). */
  private lastUid(chatId: string): string | null {
    const row = this.db.prepare('SELECT uid FROM lines WHERE chat_id = ? AND uid IS NOT NULL ORDER BY id DESC LIMIT 1').get(chatId) as
      { uid: string } | undefined;
    return row?.uid ?? null;
  }

  // ── Projects (project mode) ──

  projects(): Project[] {
    const rows = this.db
      .prepare('SELECT id, name, path, remote FROM projects ORDER BY name COLLATE NOCASE')
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  project(id: string | null | undefined): Project | undefined {
    if (!id) return undefined;
    const row = this.db.prepare('SELECT id, name, path, remote FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row && toProject(row);
  }

  /** A project's GitHub repo; telling the other devices about it (unless it came from them). */
  setProjectRemote(id: string, remote: string, fromSync = false): void {
    const project = this.project(id);
    if (!project || project.remote === remote) return;
    this.db.prepare('UPDATE projects SET remote = ? WHERE id = ?').run(remote, id);
    if (!fromSync) this.onEvent?.({ t: 'project', name: project.name, remote, at: Date.now() });
  }

  /** The project for a folder, adding it if it's new. */
  addProject(name: string, path: string): Project {
    const existing = this.db.prepare('SELECT id, name, path, remote FROM projects WHERE path = ?').get(path) as ProjectRow | undefined;
    if (existing) return toProject(existing);
    const project = { id: randomUUID(), name, path };
    this.db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(project.id, name, path, Date.now());
    // Chats from the other device that work on a project of this name join it.
    this.db
      .prepare('UPDATE chats SET project_id = ?, project_name = NULL WHERE project_id IS NULL AND lower(project_name) = lower(?)')
      .run(project.id, name);
    return project;
  }

  /** Forgets a project; its chats go back to plain assistant chats (the folder isn't touched). The other devices unlist it too. */
  removeProject(id: string, fromSync = false): void {
    const project = this.project(id);
    if (project?.remote && !fromSync)
      this.onEvent?.({ t: 'project', name: project.name, remote: project.remote, removed: true, at: Date.now() });
    // They remember the name, so adding the project again brings them back.
    this.db
      .prepare('UPDATE chats SET project_id = NULL, project_name = (SELECT name FROM projects WHERE id = ?) WHERE project_id = ?')
      .run(id, id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  setProject(chatId: string, projectId: string | null): void {
    this.db.prepare('UPDATE chats SET project_id = ?, project_name = NULL WHERE id = ?').run(projectId, chatId);
    this.touchMeta(chatId);
  }

  /** The project a chat works on, if any. */
  projectOf(chatId: string): Project | undefined {
    const row = this.db.prepare('SELECT project_id FROM chats WHERE id = ?').get(chatId) as { project_id: string | null } | undefined;
    return this.project(row?.project_id);
  }

  close(): void {
    this.db.close();
  }

  ensureChat(id: string, title: string): void {
    const now = Date.now();
    const added = this.db
      .prepare('INSERT OR IGNORE INTO chats (id, title, created_at, updated_at, meta_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, now, now, now);
    if (added.changes && this.onEvent) this.onEvent(this.chatEvent(id)!);
  }

  title(id: string): string | undefined {
    return (this.db.prepare('SELECT title FROM chats WHERE id = ?').get(id) as { title: string } | undefined)?.title;
  }

  /** `byUser` locks the title: automatic naming never changes it after that. */
  setTitle(id: string, title: string, byUser = false): void {
    this.db.prepare('UPDATE chats SET title = ?, title_locked = MAX(title_locked, ?) WHERE id = ?').run(title, byUser ? 1 : 0, id);
    this.touchMeta(id);
  }

  /** The user named this chat themselves. */
  titleLocked(id: string): boolean {
    return (
      (this.db.prepare('SELECT title_locked FROM chats WHERE id = ?').get(id) as { title_locked: number } | undefined)?.title_locked === 1
    );
  }

  setOpen(id: string, open: boolean): void {
    this.db.prepare('UPDATE chats SET open = ? WHERE id = ?').run(open ? 1 : 0, id);
  }

  setSession(id: string, sessionId: string | null): void {
    this.db.prepare('UPDATE chats SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  getSession(id: string): string | null {
    const row = this.db.prepare('SELECT session_id FROM chats WHERE id = ?').get(id) as { session_id: string | null } | undefined;
    return row?.session_id ?? null;
  }

  /** The tokens a chat's last turn sent, shown as its context size. */
  setContext(id: string, tokens: number): void {
    this.db.prepare('UPDATE chats SET context = ? WHERE id = ?').run(tokens, id);
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(id) !== undefined;
  }

  addLine(chatId: string, line: StoredLine): void {
    const now = Date.now();
    const uid = randomUUID();
    const prev = this.onEvent ? this.lastUid(chatId) : null;
    this.insertLine(chatId, uid, line, now);
    this.onEvent?.(lineEvent(chatId, uid, prev, line, now));
  }

  private insertLine(chatId: string, uid: string | null, line: StoredLine, at: number) {
    this.db
      .prepare('INSERT INTO lines (chat_id, kind, text, tag, reason, files, ref, created_at, uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        chatId,
        line.kind,
        line.text,
        line.tag ?? null,
        line.reason ?? null,
        line.files?.length ? JSON.stringify(line.files) : null,
        line.ref ?? null,
        at,
        uid,
      );
    this.db.prepare('UPDATE chats SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(at, chatId);
  }

  snapshot(id: string): ChatSnapshot | null {
    const row = this.db.prepare('SELECT id, title, context, project_id FROM chats WHERE id = ?').get(id) as
      { id: string; title: string; context: number | null; project_id: string | null } | undefined;
    if (!row) return null;
    const chat = {
      id: row.id,
      title: row.title,
      ...(row.context ? { context: row.context } : {}),
      ...(row.project_id ? { projectId: row.project_id } : {}),
    };
    const rows = this.db
      .prepare(
        'SELECT kind, text, tag, reason, files, ref, created_at FROM (SELECT * FROM lines WHERE chat_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id',
      )
      .all(id, RESTORE_LINES) as LineRow[];
    return { ...chat, lines: rows.map(fromRow) };
  }

  openChats(): ChatSnapshot[] {
    const ids = this.db.prepare('SELECT id FROM chats WHERE open = 1 ORDER BY created_at').all() as { id: string }[];
    return ids.map((r) => this.snapshot(r.id)!).filter(Boolean);
  }

  /**
   * The history sidebar's list: only chats with messages, so a tab used just for its
   * terminal or file explorer (saved when renamed or put in a project) stays out.
   */
  history(query = ''): HistoryItem[] {
    const q = query.trim();
    type Row = { id: string; title: string; updated_at: number; open: number; match: string | null; project_id: string | null };
    const rows = q
      ? (this.db
          .prepare(
            `SELECT c.id, c.title, c.updated_at, c.open, c.project_id,
                    (SELECT l.text FROM lines l WHERE l.chat_id = c.id AND l.text LIKE ? ESCAPE '\\' LIMIT 1) AS match
             FROM chats c
             WHERE EXISTS (SELECT 1 FROM lines l WHERE l.chat_id = c.id)
               AND (c.title LIKE ? ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM lines l WHERE l.chat_id = c.id AND l.text LIKE ? ESCAPE '\\'))
             ORDER BY c.updated_at DESC LIMIT 100`,
          )
          .all(likePattern(q), likePattern(q), likePattern(q)) as Row[])
      : (this.db
          .prepare(
            `SELECT c.id, c.title, c.updated_at, c.open, c.project_id, NULL AS match
             FROM chats c
             WHERE EXISTS (SELECT 1 FROM lines l WHERE l.chat_id = c.id)
             ORDER BY c.updated_at DESC LIMIT 200`,
          )
          .all() as Row[]);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      open: r.open === 1,
      ...(r.match ? { snippet: snippetAround(r.match, q) } : {}),
      ...(r.project_id ? { projectId: r.project_id } : {}),
    }));
  }

  /** Title, open state and the last `limit` lines of a chat, for Harv's own chat tools. */
  transcript(id: string, limit = 60): { title: string; open: boolean; updatedAt: number; lines: StoredLine[] } | null {
    const chat = this.db.prepare('SELECT title, open, updated_at FROM chats WHERE id = ?').get(id) as
      { title: string; open: number; updated_at: number } | undefined;
    if (!chat) return null;
    const lines = this.snapshot(id)!.lines.slice(-limit);
    return { title: chat.title, open: chat.open === 1, updatedAt: chat.updated_at, lines };
  }

  /** /clear: the chat's lines go (it keeps its name and place in history); the next message starts fresh. */
  clearLines(id: string): void {
    this.db.prepare('DELETE FROM lines WHERE chat_id = ?').run(id);
    this.db.prepare('UPDATE chats SET context = NULL WHERE id = ?').run(id);
    this.onEvent?.({ t: 'clear', chat: id, at: Date.now() });
  }

  delete(id: string): void {
    const existed = this.db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0;
    if (existed) this.onEvent?.({ t: 'delete', chat: id, at: Date.now() });
  }

  // ── Sync: changes from the user's other device (docs/PLAN.md §6m). None of these call onEvent. ──

  /** Every chat with messages as events: the opening snapshot a device sends when sync starts. */
  exportEvents(): SyncEvent[] {
    const out: SyncEvent[] = [];
    for (const p of this.projects()) if (p.remote) out.push({ t: 'project', name: p.name, remote: p.remote, at: Date.now() });
    const ids = this.db
      .prepare('SELECT id FROM chats c WHERE EXISTS (SELECT 1 FROM lines l WHERE l.chat_id = c.id) ORDER BY created_at')
      .all() as { id: string }[];
    for (const { id } of ids) {
      out.push(this.chatEvent(id)!);
      const rows = this.db
        .prepare('SELECT uid, kind, text, tag, reason, files, ref, created_at FROM lines WHERE chat_id = ? AND uid IS NOT NULL ORDER BY id')
        .all(id) as (LineRow & { uid: string })[];
      let prev: string | null = null;
      for (const r of rows) {
        out.push(lineEvent(id, r.uid, prev, fromRow(r), r.created_at));
        prev = r.uid;
      }
    }
    return out;
  }

  /** A chat's name or project from the other device; the newer change wins. Says what changed here. */
  applyChat(e: Extract<SyncEvent, { t: 'chat' }>): 'new' | 'renamed' | 'project' | null {
    const row = this.db.prepare('SELECT title, meta_at, project_id, project_name FROM chats WHERE id = ?').get(e.chat) as
      { title: string; meta_at: number; project_id: string | null; project_name: string | null } | undefined;
    const local = e.project
      ? (this.db.prepare('SELECT id FROM projects WHERE lower(name) = lower(?)').get(e.project) as { id: string } | undefined)
      : undefined;
    const projectId = local?.id ?? null;
    const projectName = e.project && !local ? e.project : null;
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO chats (id, title, open, title_locked, created_at, updated_at, meta_at, project_id, project_name)
           VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(e.chat, e.title, e.locked ? 1 : 0, e.created, e.created, e.at, projectId, projectName);
      return 'new';
    }
    if (e.at < row.meta_at) return null;
    this.db
      .prepare('UPDATE chats SET title = ?, title_locked = ?, meta_at = ?, project_id = ?, project_name = ? WHERE id = ?')
      .run(e.title, e.locked ? 1 : 0, e.at, projectId, projectName, e.chat);
    if (row.project_id !== projectId || row.project_name !== projectName) {
      // A Claude session can't move folders: the next message here starts a new one.
      this.db.prepare('UPDATE chats SET session_id = NULL, stale = 1 WHERE id = ?').run(e.chat);
      return 'project';
    }
    return row.title !== e.title ? 'renamed' : null;
  }

  /**
   * A line from the other device. It goes after its `prev` line, wherever that is (a fork
   * too). If this device wrote something after `prev` meanwhile, both sides wrote while
   * apart: the other device's side continues in a fork ("Title (notebook)"), so nothing is lost.
   * Returns where it went, or null when it was already here.
   */
  applyLine(e: LineEvent, deviceName: string): { chat: string; line: StoredLine; forked?: string } | null {
    if (this.db.prepare('SELECT 1 FROM lines WHERE uid = ?').get(e.uid)) return null;
    let chat = e.chat;
    let known = e.prev === null;
    if (e.prev) {
      const at = this.db.prepare('SELECT chat_id FROM lines WHERE uid = ?').get(e.prev) as { chat_id: string } | undefined;
      if (at) {
        chat = at.chat_id;
        known = true;
      }
    }
    if (!this.exists(chat)) {
      this.db
        .prepare('INSERT INTO chats (id, title, open, created_at, updated_at, meta_at) VALUES (?, ?, 0, ?, ?, 0)')
        .run(chat, 'Synced chat', e.at, e.at);
    }
    let forked: string | undefined;
    // An unknown `prev` (a line this device never got) can't show a conflict: the line just goes at the end.
    if (known && this.lastUid(chat) !== e.prev) {
      const from = this.db.prepare('SELECT title, project_id, project_name FROM chats WHERE id = ?').get(chat) as {
        title: string;
        project_id: string | null;
        project_name: string | null;
      };
      forked = randomUUID();
      this.db
        .prepare(
          `INSERT INTO chats (id, title, open, title_locked, created_at, updated_at, meta_at, project_id, project_name)
           VALUES (?, ?, 0, 1, ?, ?, 0, ?, ?)`,
        )
        .run(forked, `${from.title} (${deviceName})`.slice(0, 60), e.at, e.at, from.project_id, from.project_name);
      // A note without a uid: it stays on this device.
      const text = `Both devices wrote in “${from.title}” while they were apart, so ${deviceName}’s side continues here.`;
      this.insertLine(forked, null, { kind: 'notice', text }, e.at);
      chat = forked;
    }
    const line = toLine(e);
    this.insertLine(chat, e.uid, line, e.at);
    // This device's Claude session didn't see that line: the next message here starts fresh with the chat so far.
    this.db.prepare('UPDATE chats SET session_id = NULL, stale = 1 WHERE id = ?').run(chat);
    return { chat, line: { ...line, at: e.at }, ...(forked ? { forked } : {}) };
  }

  /** /clear on the other device. */
  applyClear(id: string): boolean {
    if (!this.exists(id)) return false;
    this.db.prepare('DELETE FROM lines WHERE chat_id = ?').run(id);
    this.db.prepare('UPDATE chats SET context = NULL, session_id = NULL, stale = 0 WHERE id = ?').run(id);
    return true;
  }

  applyDelete(id: string): boolean {
    return this.db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0;
  }

  /** Whether the chat got lines from the other device since its Claude session last ran here (and clears the mark). */
  takeStale(id: string): boolean {
    return this.db.prepare('UPDATE chats SET stale = 0 WHERE id = ? AND stale = 1').run(id).changes > 0;
  }
}
