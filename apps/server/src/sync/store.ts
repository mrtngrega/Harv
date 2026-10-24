import { DatabaseSync } from 'node:sqlite';
import type { SyncEvent } from './events.ts';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sync_out (
    seq   INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/**
 * This device's side of sync in harv.db: the outbox of changes not pushed yet (numbered by
 * `seq`, which keeps counting up forever), and small state like each peer's cursor.
 */
export class SyncStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  add(e: SyncEvent): void {
    this.db.prepare('INSERT INTO sync_out (event) VALUES (?)').run(JSON.stringify(e));
  }

  /** Events after `seq`, oldest first. */
  after(seq: number, limit = 1_000_000): { seq: number; e: SyncEvent }[] {
    return (
      this.db.prepare('SELECT seq, event FROM sync_out WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as {
        seq: number;
        event: string;
      }[]
    ).map((r) => ({ seq: r.seq, e: JSON.parse(r.event) as SyncEvent }));
  }

  count(after: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sync_out WHERE seq > ?').get(after) as { n: number }).n;
  }

  /** Drops events that are safely pushed. */
  prune(upTo: number): void {
    this.db.prepare('DELETE FROM sync_out WHERE seq <= ?').run(upTo);
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  /** Every state key with a prefix ("cursor:" → each peer's cursor). */
  withPrefix<T>(prefix: string): Map<string, T> {
    const rows = this.db
      .prepare("SELECT key, value FROM sync_state WHERE key LIKE ? ESCAPE '\\'")
      .all(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as { key: string; value: string }[];
    return new Map(rows.map((r) => [r.key.slice(prefix.length), JSON.parse(r.value) as T]));
  }

  close(): void {
    this.db.close();
  }
}
