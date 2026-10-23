/** Tabs in the chat bar that aren't chats: a terminal and the file explorer. (A browser tab existed in a3d96e0; removed for now.) */
export type ToolKind = 'terminal' | 'files';

export interface ToolTab {
  id: string;
  kind: ToolKind;
  title: string;
}

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

/** Shortcuts on the explorer's left: home folders and drives. */
export interface FilePlaces {
  places: { name: string; path: string }[];
  drives: string[];
}

export type ToolClientMessage =
  /** Opens a tool tab; the dashboard picks the id. */
  | { type: 'tool.open'; id: string; kind: ToolKind }
  | { type: 'tool.close'; id: string }
  /** Asks for a terminal's output so far (after a reload). */
  | { type: 'term.attach'; id: string }
  | { type: 'term.input'; id: string; data: string }
  | { type: 'term.resize'; id: string; cols: number; rows: number };


export type ToolServerMessage =
  | { type: 'tools'; tabs: ToolTab[] }
  /** Terminal output; `reset` replaces what the tab shows (the replay after attach). */
  | { type: 'term.data'; id: string; data: string; reset?: boolean }
  | { type: 'term.exit'; id: string; code: number };

