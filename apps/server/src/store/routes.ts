import { DatabaseSync } from 'node:sqlite';
import type { EffortLevel, RouteSource } from '@harv/shared';

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
    feedback   TEXT
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

/** The router's log: every decision, and whether the user asked to try harder. Used to tune the table. */
export class RouteStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
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

  /** How many turns ran on each model·effort (the routing split). */
  split(sinceMs = 0): { model: string; effort: EffortLevel; turns: number; harder: number }[] {
    return this.db
      .prepare(
        `SELECT model, effort, COUNT(*) AS turns, SUM(feedback = 'harder') AS harder
         FROM routes WHERE at >= ? GROUP BY model, effort ORDER BY turns DESC`,
      )
      .all(sinceMs) as { model: string; effort: EffortLevel; turns: number; harder: number }[];
  }
}
