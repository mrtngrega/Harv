/** Tabs in the chat bar that aren't chats: a terminal, the file explorer, the browser. */
export type ToolKind = 'terminal' | 'files' | 'browser';

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

/** What the browser tab shows above the page. */
export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Harv is driving it right now (the user is watching). */
  harvActive: boolean;
}

/** Mouse and keyboard from the dashboard, in page pixels. */
export type BrowserInput =
  | {
      kind: 'mouse';
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
      x: number;
      y: number;
      button: 'left' | 'right' | 'middle' | 'none';
      clickCount: number;
      modifiers: number;
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { kind: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; text?: string; keyCode: number; modifiers: number }
  /** Pasted text, inserted as if typed. */
  | { kind: 'text'; text: string };

export type ToolClientMessage =
  /** Opens a tool tab; the dashboard picks the id. */
  | { type: 'tool.open'; id: string; kind: ToolKind }
  | { type: 'tool.close'; id: string }
  /** Asks for a terminal's output so far (after a reload). */
  | { type: 'term.attach'; id: string }
  | { type: 'term.input'; id: string; data: string }
  | { type: 'term.resize'; id: string; cols: number; rows: number }
  | { type: 'browser.navigate'; id: string; url: string }
  | { type: 'browser.nav'; id: string; action: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'browser.input'; id: string; input: BrowserInput }
  /** The tab's size in CSS pixels, so the page renders to fit. */
  | { type: 'browser.resize'; id: string; width: number; height: number }
  /** The tab is showing (frames flow) or hidden (they pause). */
  | { type: 'browser.watch'; id: string; on: boolean };

export type ToolServerMessage =
  | { type: 'tools'; tabs: ToolTab[] }
  /** Terminal output; `reset` replaces what the tab shows (the replay after attach). */
  | { type: 'term.data'; id: string; data: string; reset?: boolean }
  | { type: 'term.exit'; id: string; code: number }
  | { type: 'browser.frame'; id: string; data: string; width: number; height: number }
  | { type: 'browser.state'; id: string; state: BrowserState }
  | { type: 'browser.error'; id: string; message: string };
