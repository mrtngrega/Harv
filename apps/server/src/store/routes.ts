import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ChatUsage, EffortLevel, HarvUsage, RouteSource } from '@harv/shared';
import type { RouteRow, SyncEvent } from '../sync/events.ts';

const ROW = `SELECT uid, chat_id AS chatId, at, model, effort, source, reason, category, difficulty, stakes, feedback,
                    input_tokens AS inputTokens, output_tokens AS outputTokens FROM routes`;

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS routes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL,
    at         INTEGER NOT NULL,
    model      TEXT NOT NULL,
    effort     TEXT NOT NULL,
    source     TEXT NOT NULL,
    reason     TEXT NOT NULL,
    category   TEXT,
    difficulty INTEGER,
    stakes     TEXT,
    feedback   TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS routes_by_chat ON routes(chat_id, id);
`;

export interface RouteEntry {
  chatId: string;
  model: string;
  effort: EffortLevel;
  source: RouteSource;
  reason: string;
  category?: string;
  difficulty?: number;
  stakes?: string;
}

/**
 * The router's log: every turn's model·effort and why, whether the user asked to
 * try harder, and the tokens it used. Tunes the table and feeds Harv's own usage stats.
 */
export class RouteStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // The first M6 databases lack the token columns.
    const columns = this.db.prepare('PRAGMA table_info(routes)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'input_tokens')) {
      this.db.exec('ALTER TABLE routes ADD COLUMN input_tokens INTEGER; ALTER TABLE routes ADD COLUMN output_tokens INTEGER;');
    }
    // Sync (M10b): rows both devices share, and which came from the other one (its turns count in Harv's stats here too).
    if (!columns.some((c) => c.name === 'uid')) {
      this.db.exec('ALTER TABLE routes ADD COLUMN uid TEXT; ALTER TABLE routes ADD COLUMN remote INTEGER NOT NULL DEFAULT 0;');
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS routes_by_uid ON routes(uid)');
    const missing = this.db.prepare('SELECT id FROM routes WHERE uid IS NULL').all() as { id: number }[];
    if (missing.length) {
      const set = this.db.prepare('UPDATE routes SET uid = ? WHERE id = ?');
      this.db.exec('BEGIN');
      for (const { id } of missing) set.run(randomUUID(), id);
      this.db.exec('COMMIT');
    }
  }

  close(): void {
    this.db.close();
  }

  /** Every local change, for sync (set while sync is on). */
  onEvent?: (e: SyncEvent) => void;

  /** This device's latest row for a chat (the other device's turns in the same chat don't count). */
  private lastId(chatId: string): number | undefined {
    return (
      (
        this.db.prepare('SELECT MAX(id) AS id FROM routes WHERE chat_id = ? AND remote = 0').get(chatId) as
          { id: number | null } | undefined
      )?.id ?? undefined
    );
  }

  private changed(id: number | undefined) {
    if (!this.onEvent || id === undefined) return;
    const row = this.db.prepare(`${ROW} WHERE id = ?`).get(id) as RouteRow | undefined;
    if (row) this.onEvent({ t: 'route', row });
  }

  add(e: RouteEntry): void {
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO routes (chat_id, at, model, effort, source, reason, category, difficulty, stakes, uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        e.chatId,
        Date.now(),
        e.model,
        e.effort,
        e.source,
        e.reason,
        e.category ?? null,
        e.difficulty ?? null,
        e.stakes ?? null,
        randomUUID(),
      );
    this.changed(Number(lastInsertRowid));
  }

  /** Feedback on a chat's latest decision ("harder" = the user asked for more). */
  markLast(chatId: string, feedback: string): void {
    const id = this.lastId(chatId);
    this.db.prepare('UPDATE routes SET feedback = ? WHERE id = ?').run(feedback, id ?? null);
    this.changed(id);
  }

  /** Every row as events: the opening snapshot. */
  exportEvents(): SyncEvent[] {
    return (this.db.prepare(`${ROW} WHERE remote = 0 ORDER BY id`).all() as unknown as RouteRow[]).map((row) => ({ t: 'route', row }));
  }

  /** A row from the other device (new, or with its tokens or feedback filled in). */
  applyRoute(r: RouteRow): void {
    this.db
      .prepare(
        `INSERT INTO routes (uid, chat_id, at, model, effort, source, reason, category, difficulty, stakes, feedback, input_tokens, output_tokens, remote)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(uid) DO UPDATE SET feedback = excluded.feedback, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens`,
      )
      .run(
        r.uid,
        r.chatId,
        r.at,
        r.model,
        r.effort,
        r.source,
        r.reason,
        r.category,
        r.difficulty,
        r.stakes,
        r.feedback,
        r.inputTokens,
        r.outputTokens,
      );
  }

  /** How often the user asked to try harder on this kind of task (same category and difficulty) since `sinceMs`. */
  harderStats(category: string, difficulty: number, sinceMs: number): { turns: number; harder: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS turns, SUM(feedback = 'harder') AS harder FROM routes
         WHERE lower(category) = lower(?) AND difficulty = ? AND at >= ? AND source IN ('classifier', 'followup', 'rule')`,
      )
      .get(category, difficulty, sinceMs) as { turns: number; harder: number | null };
    return { turns: row.turns, harder: row.harder ?? 0 };
  }

  /** The tokens a chat's latest turn used. */
  finishLast(chatId: string, usage: ChatUsage): void {
    const id = this.lastId(chatId);
    this.db
      .prepare('UPDATE routes SET input_tokens = ?, output_tokens = ? WHERE id = ?')
      .run(usage.inputTokens, usage.outputTokens, id ?? null);
    this.changed(id);
  }

  /** Harv's own usage: today's turns and tokens, and the last week's routing split. */
  summary(now = new Date()): HarvUsage {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const today = this.db
      .prepare('SELECT COUNT(*) AS turns, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM routes WHERE at >= ?')
      .get(midnight) as { turns: number; input: number | null; output: number | null };
    return {
      turnsToday: today.turns,
      inputTokensToday: today.input ?? 0,
      outputTokensToday: today.output ?? 0,
      split: this.split(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    };
  }

  /** How many turns ran on each model·effort (the routing split). */
  split(sinceMs = 0): { model: string; effort: EffortLevel; turns: number; harder: number }[] {
    return (
      this.db
        .prepare(
          `SELECT model, effort, COUNT(*) AS turns, SUM(feedback = 'harder') AS harder
         FROM routes WHERE at >= ? GROUP BY model, effort ORDER BY turns DESC`,
        )
        .all(sinceMs) as { model: string; effort: EffortLevel; turns: number; harder: number | null }[]
    ).map((r) => ({ ...r, harder: r.harder ?? 0 }));
  }
}
