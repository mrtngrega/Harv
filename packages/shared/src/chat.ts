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
  /** Claude Code's slash commands (and skills) a plain chat offers; a chat's own list replaces it once its session runs. */
  commands: SlashCommandInfo[];
}

/** A Claude Code slash command or skill, typed as `/name args` in the chat. */
export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
}

/** A message typed while Harv was still answering: it runs when the turn ends. */
export interface QueuedMessage {
  id: string;
  text: string;
  files?: string[];
}

/** A background task a chat started (a subagent, a shell or a monitor), for the strip above the prompt. */
export interface BackgroundTask {
  id: string;
  /** "local_agent", "local_bash", "monitor"… */
  kind: string;
  /** The agent type of a subagent ("general-purpose", a custom agent's name). */
  agent?: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  /** The last tool it used, while it runs. */
  lastTool?: string;
  /** Its result summary when it ended, or its one-line status while it runs. */
  summary?: string;
}

/** "auto" lets Harv pick; anything else is a model id from the catalog. */
export type ModelChoice = 'auto' | (string & {});

/** What AUTO runs when the router can't decide (e.g. the classifier failed). */
export const AUTO_FALLBACK = { model: 'sonnet', effort: 'medium' } as const satisfies { model: string; effort: EffortLevel };

/** How a turn's model·effort was chosen. */
export type RouteSource = 'manual' | 'override' | 'rule' | 'classifier' | 'followup' | 'harder' | 'fallback' | 'command';

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
  /** When the line was written (epoch ms); filled in from the database. */
  at?: number;
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
  /** Tokens the last turn sent (the conversation's context size). */
  context?: number;
  /** The project this chat works on (project mode), if any. */
  projectId?: string;
  /** Messages waiting for the current turn to end. */
  queued?: QueuedMessage[];
  /** This chat's slash commands, once its session has started (otherwise the catalog's). */
  commands?: SlashCommandInfo[];
  /** Background tasks it started that are running or ended a short while ago. */
  tasks?: BackgroundTask[];
}

export interface HistoryItem {
  id: string;
  title: string;
  updatedAt: number;
  open: boolean;
  /** Matching text when the list is a search result. */
  snippet?: string;
  projectId?: string;
}

export type ChatClientMessage =
  | { type: 'chat.send'; tabId: string; text: string; model: ModelChoice; effort: EffortLevel; attachments?: Attachment[] }
  | { type: 'chat.stop'; tabId: string }
  /** Stop one background task (a subagent or shell) without stopping the reply. */
  | { type: 'chat.stopTask'; tabId: string; taskId: string }
  /** Drop a queued message before it runs. */
  | { type: 'chat.unqueue'; tabId: string; id: string }
  /** Run a queued message now: the current reply stops and this one goes first. */
  | { type: 'chat.sendNow'; tabId: string; id: string }
  /** Run the last message again one step up the model·effort ladder. */
  | { type: 'chat.harder'; tabId: string }
  | { type: 'chat.close'; tabId: string }
  /** Reopen a chat from history as a tab. */
  | { type: 'chat.open'; tabId: string }
  | { type: 'chat.delete'; tabId: string }
  /** The user renamed a chat (right-click on its tab); auto-naming leaves it alone after that. */
  | { type: 'chat.rename'; tabId: string; title: string }
  | { type: 'history.search'; query: string };

export type ChatServerMessage =
  /** A turn began; `model`/`effort` are what actually runs (AUTO resolved). */
  | { type: 'chat.started'; tabId: string; model: string; effort: EffortLevel; auto: boolean; reason: string }
  | { type: 'chat.delta'; tabId: string; text: string }
  /** Tokens Claude has written this turn so far (estimated while a message streams, exact after it), for the status line. */
  | { type: 'chat.progress'; tabId: string; outputTokens: number }
  /** Final text of one assistant message (replaces the streamed text). */
  | { type: 'chat.assistant'; tabId: string; text: string }
  | { type: 'chat.tool'; tabId: string; id: string; name: string; detail: string }
  | { type: 'chat.done'; tabId: string; ok: boolean; stopped: boolean; error?: string; usage?: ChatUsage }
  | { type: 'chat.notice'; tabId: string; message: string }
  | { type: 'chat.error'; tabId: string; message: string }
  /** A chat to show as a tab; `focus: false` opens it without switching to it (a hand-off). */
  | { type: 'chat.opened'; chat: ChatSnapshot; focus?: boolean }
  /** A finished line added by the server (a hand-off's request), appended as is. */
  | { type: 'chat.line'; tabId: string; line: StoredLine }
  | { type: 'chat.removed'; tabId: string }
  /** /clear ran: the tab empties, like Claude Code's screen (the chat stays in history, empty). */
  | { type: 'chat.cleared'; tabId: string }
  /** A chat's title changed (named automatically, or by the user). */
  | { type: 'chat.renamed'; tabId: string; title: string }
  /** The messages waiting in a chat for its turn to end (the whole list, replacing the last one). */
  | { type: 'chat.queued'; tabId: string; items: QueuedMessage[] }
  /** A chat's slash commands changed (its session started, or found new skills). */
  | { type: 'chat.commands'; tabId: string; commands: SlashCommandInfo[] }
  /** A chat's background tasks (the whole list, replacing the last one). */
  | { type: 'chat.tasks'; tabId: string; tasks: BackgroundTask[] }
  /** The history list; `query` echoes the search it answers ("" = everything). */
  | { type: 'history'; items: HistoryItem[]; query: string };
