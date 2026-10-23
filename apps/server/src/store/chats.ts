import { DatabaseSync } from 'node:sqlite';
import type { ChatSnapshot, HistoryItem, LineKind, StoredLine } from '@harv/shared';

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS chats (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    session_id TEXT,
    open       INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    text       TEXT NOT NULL,
    tag        TEXT,
    files      TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lines_by_chat ON lines(chat_id, id);
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
export class ChatStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Databases from before M4 lack the attachments column.
    const columns = this.db.prepare('PRAGMA table_info(lines)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'files')) this.db.exec('ALTER TABLE lines ADD COLUMN files TEXT');
  }

  close(): void {
    this.db.close();
  }

  ensureChat(id: string, title: string): void {
    const now = Date.now();
    this.db.prepare('INSERT OR IGNORE INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now);
  }

  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, id);
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

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(id) !== undefined;
  }

  addLine(chatId: string, line: StoredLine): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO lines (chat_id, kind, text, tag, files, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(chatId, line.kind, line.text, line.tag ?? null, line.files?.length ? JSON.stringify(line.files) : null, now);
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chatId);
  }

  snapshot(id: string): ChatSnapshot | null {
    const chat = this.db.prepare('SELECT id, title FROM chats WHERE id = ?').get(id) as { id: string; title: string } | undefined;
    if (!chat) return null;
    const rows = this.db
      .prepare('SELECT kind, text, tag, files FROM (SELECT * FROM lines WHERE chat_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(id, RESTORE_LINES) as { kind: LineKind; text: string; tag: string | null; files: string | null }[];
    return {
      ...chat,
      lines: rows.map((r) => ({
        kind: r.kind,
        text: r.text,
        ...(r.tag ? { tag: r.tag } : {}),
        ...(r.files ? { files: JSON.parse(r.files) as string[] } : {}),
      })),
    };
  }

  openChats(): ChatSnapshot[] {
    const ids = this.db.prepare('SELECT id FROM chats WHERE open = 1 ORDER BY created_at').all() as { id: string }[];
    return ids.map((r) => this.snapshot(r.id)!).filter(Boolean);
  }

  history(query = ''): HistoryItem[] {
    const q = query.trim();
    type Row = { id: string; title: string; updated_at: number; open: number; match: string | null };
    const rows = q
      ? (this.db
          .prepare(
            `SELECT c.id, c.title, c.updated_at, c.open,
                    (SELECT l.text FROM lines l WHERE l.chat_id = c.id AND l.text LIKE ? ESCAPE '\\' LIMIT 1) AS match
             FROM chats c
             WHERE c.title LIKE ? ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM lines l WHERE l.chat_id = c.id AND l.text LIKE ? ESCAPE '\\')
             ORDER BY c.updated_at DESC LIMIT 100`,
          )
          .all(likePattern(q), likePattern(q), likePattern(q)) as Row[])
      : (this.db.prepare('SELECT id, title, updated_at, open, NULL AS match FROM chats ORDER BY updated_at DESC LIMIT 200').all() as Row[]);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      open: r.open === 1,
      ...(r.match ? { snippet: snippetAround(r.match, q) } : {}),
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

  delete(id: string): void {
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  }
}
