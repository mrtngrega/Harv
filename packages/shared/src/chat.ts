export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A model the user's plan offers, as reported by Claude Code. */
export interface ModelOption {
  /** Alias passed to the SDK ("opus", "sonnet", ...). */
  id: string;
  name: string;
  description: string;
  efforts: EffortLevel[];
}

export interface Catalog {
  /** e.g. "Claude Pro". */
  plan: string | null;
  models: ModelOption[];
}

/** "auto" lets Harv pick; anything else is a model id from the catalog. */
export type ModelChoice = 'auto' | (string & {});

/** What AUTO runs when the router can't decide (e.g. the classifier failed). */
export const AUTO_FALLBACK = { model: 'sonnet', effort: 'medium' } as const satisfies { model: string; effort: EffortLevel };

/** How a turn's model·effort was chosen. */
export type RouteSource = 'manual' | 'override' | 'rule' | 'classifier' | 'followup' | 'harder' | 'fallback';

/** The model·effort a turn runs at, and why. */
export interface RouteDecision {
  model: string;
  effort: EffortLevel;
  source: RouteSource;
  /** Shown when hovering the reply's tag. */
  reason: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export type LineKind = 'you' | 'harv' | 'tool' | 'notice' | 'error';

/** A finished chat line as stored in the history database. */
export interface StoredLine {
  kind: LineKind;
  text: string;
  /** "sonnet·medium" on Harv's replies. */
  tag?: string;
  /** Why that model·effort was picked. */
  reason?: string;
  /** Names of the files attached to the user's message. */
  files?: string[];
  /** On tool lines: the tool_use id, which is also the action log id. */
  ref?: string;
}

/** A file uploaded with POST /api/attachments, waiting to be sent with a message. */
export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
}

/** Largest file the dashboard accepts. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** An open chat tab with its saved lines (sent on connect and when reopening from history). */
export interface ChatSnapshot {
  id: string;
  title: string;
  lines: StoredLine[];
}

export interface HistoryItem {
  id: string;
  title: string;
  updatedAt: number;
  open: boolean;
  /** Matching text when the list is a search result. */
  snippet?: string;
}

export type ChatClientMessage =
  | { type: 'chat.send'; tabId: string; text: string; model: ModelChoice; effort: EffortLevel; attachments?: Attachment[] }
  | { type: 'chat.stop'; tabId: string }
  /** Run the last message again one step up the model·effort ladder. */
  | { type: 'chat.harder'; tabId: string }
  | { type: 'chat.close'; tabId: string }
  /** Reopen a chat from history as a tab. */
  | { type: 'chat.open'; tabId: string }
  | { type: 'chat.delete'; tabId: string }
  | { type: 'history.search'; query: string };

export type ChatServerMessage =
  /** A turn began; `model`/`effort` are what actually runs (AUTO resolved). */
  | { type: 'chat.started'; tabId: string; model: string; effort: EffortLevel; auto: boolean; reason: string }
  | { type: 'chat.delta'; tabId: string; text: string }
  /** Final text of one assistant message (replaces the streamed text). */
  | { type: 'chat.assistant'; tabId: string; text: string }
  | { type: 'chat.tool'; tabId: string; id: string; name: string; detail: string }
  | { type: 'chat.done'; tabId: string; ok: boolean; stopped: boolean; error?: string; usage?: ChatUsage }
  | { type: 'chat.notice'; tabId: string; message: string }
  | { type: 'chat.error'; tabId: string; message: string }
  | { type: 'chat.opened'; chat: ChatSnapshot }
  | { type: 'chat.removed'; tabId: string }
  /** The history list; `query` echoes the search it answers ("" = everything). */
  | { type: 'history'; items: HistoryItem[]; query: string };
