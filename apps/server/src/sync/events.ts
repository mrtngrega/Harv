import type { LineKind } from '@harv/shared';

/**
 * One change, as a device writes it to its own log (docs/PLAN.md §6m). The other device
 * replays the ones it hasn't seen into its own database; applying one never logs a new one.
 */
export type SyncEvent =
  /** A chat's name or project changed (or it's new). `project` is the project's name: each device maps its own folder. */
  | { t: 'chat'; chat: string; title: string; locked: boolean; project: string | null; created: number; at: number }
  /** A finished line. `prev` is the uid of the chat's line before it (null for the first), to notice both devices writing while apart. */
  | {
      t: 'line';
      chat: string;
      uid: string;
      prev: string | null;
      kind: LineKind;
      text: string;
      tag?: string;
      reason?: string;
      files?: string[];
      ref?: string;
      at: number;
    }
  | { t: 'clear'; chat: string; at: number }
  | { t: 'delete'; chat: string; at: number }
  /** A memory file written (or deleted, with null). `base` is the hash of the version it replaced, to spot edits on both sides. */
  | { t: 'memory'; name: string; content: string | null; base: string | null; at: number }
  /** A shared text file (the user's ideas list), never deleted. `base` is the hash of the version it replaced. */
  | { t: 'file'; name: string; content: string; base: string | null; at: number }
  /** One shared setting (newest wins per key). */
  | { t: 'setting'; key: string; value: unknown; at: number }
  /** A row of the router's log, for Harv's own usage stats (sent again when its tokens or feedback arrive). */
  | { t: 'route'; row: RouteRow };

export interface RouteRow {
  uid: string;
  chatId: string;
  at: number;
  model: string;
  effort: string;
  source: string;
  reason: string;
  category: string | null;
  difficulty: number | null;
  stakes: string | null;
  feedback: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** What a chunk file holds once decrypted. */
export interface Chunk {
  v: 1;
  device: { id: string; name: string };
  events: { seq: number; e: SyncEvent }[];
}
