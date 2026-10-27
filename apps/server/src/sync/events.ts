import type { LineKind, SharedUi } from '@harv/shared';

export type { SharedUi };

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
  /** A rewind: the line with this uid and everything after it went. */
  | { t: 'rewind'; chat: string; uid: string; at: number }
  | { t: 'delete'; chat: string; at: number }
  /** A memory file written (or deleted, with null). `base` is the hash of the version it replaced, to spot edits on both sides. */
  | { t: 'memory'; name: string; content: string | null; base: string | null; at: number }
  /** A shared text file (the user's ideas list), never deleted. `base` is the hash of the version it replaced. */
  | { t: 'file'; name: string; content: string; base: string | null; at: number }
  /** A project with a GitHub repo, by name (each device keeps it in its own folder); `removed` unlists it there. */
  | { t: 'project'; name: string; remote: string; removed?: boolean; at: number }
  /** One shared setting (newest wins per key). */
  | { t: 'setting'; key: string; value: unknown; at: number }
  /** A row of the router's log, for Harv's own usage stats (sent again when its tokens or feedback arrive). */
  | { t: 'route'; row: RouteRow }
  /** A note in a project's Claude Code memory (null: deleted), by project name. `base` as for memory. */
  | { t: 'pmemory'; project: string; name: string; content: string | null; base: string | null; at: number }
  /**
   * A file in a synced folder (`root`: "workspace" for attachments and Harv's files, "home" for
   * the background photo) by its path there. Its bytes are a sealed blob in the device's folder
   * of the repo (`blobs/<hash>.hrv`); null hash: deleted.
   */
  | { t: 'blob'; root: string; path: string; hash: string | null; base: string | null; size: number; at: number }
  /** The shared part of the dashboard's layout: open tabs, their order, unsent drafts (newest wins). */
  | { t: 'ui'; ui: SharedUi; at: number }
  /** A plan-usage warning was shown ("session:90"), so the other device doesn't show it again. */
  | { t: 'warned'; key: string; at: number }
  /** A project's work on this device that the other one can't have yet: uncommitted or unpushed changes. */
  | { t: 'pstate'; project: string; unsaved: boolean; at: number };

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
