import type { Attachment } from './chat.ts';

/** Tools a chat can switch to from its view menu. (A browser existed in a3d96e0; removed for now.) */
export type ToolKind = 'terminal' | 'files';

/** What a chat shows: its conversation or one of its tools. */
export type ChatView = 'chat' | ToolKind;

/** A chat's terminal id on the server. */
export const terminalId = (chatId: string) => `terminal-${chatId}`;

/**
 * The dashboard's layout, saved in ~/.harv/ui.json so it comes back after a
 * restart like Chrome's tabs: which tab was showing, the order, each chat's
 * tools and view, unsent drafts.
 */
export interface UiState {
  /** A chat's id, "settings", or null. */
  activeId: string | null;
  settingsOpen: boolean;
  /** Tab order (chat ids). */
  order: string[];
  /** Chats opened with + that have no messages yet (the server doesn't know them otherwise). */
  blanks: string[];
  /** Tools each chat has open. */
  tools: Record<string, ToolKind[]>;
  views: Record<string, ChatView>;
  /** Where each chat's file explorer is. */
  explorer: Record<string, string>;
  /** Unsent message text per chat. */
  drafts: Record<string, string>;
  /** Files attached to a draft (already uploaded) per chat. */
  attachments: Record<string, Attachment[]>;
}

/** The part of the layout every device shows the same (synced, docs/PLAN.md §6m): tabs, their order, drafts. */
export type SharedUi = Pick<UiState, 'order' | 'blanks' | 'drafts' | 'attachments'>;

export const EMPTY_UI: UiState = {
  activeId: null,
  settingsOpen: false,
  order: [],
  blanks: [],
  tools: {},
  views: {},
  explorer: {},
  drafts: {},
  attachments: {},
};

/** One entry in a folder listing. */
export interface FileEntry {
  name: string;
  /** Full Windows path. */
  path: string;
  dir: boolean;
  /** Bytes; undefined for folders or when it couldn't be read. */
  size?: number;
  /** Epoch ms. */
  mtime?: number;
  hidden: boolean;
}

export interface FolderListing {
  path: string;
  /** The folder above, or null at a drive root. */
  parent: string | null;
  entries: FileEntry[];
}

/** A drive on This PC. */
export interface DriveInfo {
  path: string;
  label: string;
  /** Bytes; 0 when unknown. */
  total: number;
  free: number;
}

/** The explorer's Properties dialog. */
export interface FileProps {
  path: string;
  name: string;
  dir: boolean;
  /** Bytes (for folders: everything inside). */
  size: number;
  created: number;
  modified: number;
  accessed: number;
  readOnly: boolean;
  files?: number;
  folders?: number;
  /** The folder was too big to count completely. */
  partial?: boolean;
}

/** A change the file explorer asks for (POST /api/files/op). */
export type FileOp =
  | { op: 'newFolder'; dir: string }
  | { op: 'newFile'; dir: string }
  | { op: 'rename'; path: string; name: string }
  | { op: 'copy'; paths: string[]; dest: string }
  | { op: 'move'; paths: string[]; dest: string }
  | { op: 'recycle'; paths: string[] }
  | { op: 'deleteForever'; paths: string[] };

/** Shortcuts on the explorer's left: home folders and drives. */
export interface FilePlaces {
  places: { name: string; path: string }[];
  drives: string[];
  /** Linux: the Trash's files folder, when the user's file manager shows a Trash place. */
  trash?: string;
}

export type ToolClientMessage =
  /** Saves the dashboard's layout (debounced on the dashboard's side). */
  | { type: 'ui.save'; state: UiState }
  /** Shows a terminal, starting it (in `cwd`, or where it was before a restart) if it isn't running. */
  | { type: 'term.attach'; id: string; cwd?: string }
  /** Ends a terminal (its chat closed the tool). */
  | { type: 'term.close'; id: string }
  | { type: 'term.input'; id: string; data: string }
  | { type: 'term.resize'; id: string; cols: number; rows: number };

export type ToolServerMessage =
  /**
   * Terminal output; `reset` replaces what the view shows (the replay after attach).
   * `restored`: plain lines from before a restart, shown in grey above the new shell.
   */
  | { type: 'term.data'; id: string; data: string; reset?: boolean; restored?: string[] }
  | { type: 'term.exit'; id: string; code: number }
  /** Harv runs something in a chat's terminal (terminal_run): the dashboard shows that terminal. */
  | { type: 'term.show'; tabId: string }
  /** The other device's tabs and drafts are newer: the dashboard shows them (its own tab and tools stay). */
  | { type: 'ui.synced'; ui: SharedUi };
