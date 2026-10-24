import { DatabaseSync } from 'node:sqlite';
import type { ChatUsage, EffortLevel, HarvUsage, RouteSource } from '@harv/shared';

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
  }

  add(e: RouteEntry): void {
    this.db
      .prepare(
        'INSERT INTO routes (chat_id, at, model, effort, source, reason, category, difficulty, stakes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(e.chatId, Date.now(), e.model, e.effort, e.source, e.reason, e.category ?? null, e.difficulty ?? null, e.stakes ?? null);
  }

  /** Feedback on a chat's latest decision ("harder" = the user asked for more). */
  markLast(chatId: string, feedback: string): void {
    this.db.prepare('UPDATE routes SET feedback = ? WHERE id = (SELECT MAX(id) FROM routes WHERE chat_id = ?)').run(feedback, chatId);
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
    this.db
      .prepare('UPDATE routes SET input_tokens = ?, output_tokens = ? WHERE id = (SELECT MAX(id) FROM routes WHERE chat_id = ?)')
      .run(usage.inputTokens, usage.outputTokens, chatId);
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
