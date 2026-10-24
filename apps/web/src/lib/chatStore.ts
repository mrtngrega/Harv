import type {
  Attachment,
  ChatServerMessage,
  ClientMessage,
  ChatSnapshot,
  ChatView,
  EffortLevel,
  HistoryItem,
  LineKind,
  ModelChoice,
  ToolKind,
  UiState,
} from '@harv/shared';
import { terminalId } from '@harv/shared';
import { createStore } from './createStore.ts';
import { dropDrafts } from './drafts.ts';
import { onServerMessage, sendMessage } from './socket.ts';

export type { LineKind };

export interface Line {
  id: string;
  kind: LineKind;
  text: string;
  /** "sonnet·medium" on Harv's replies. */
  tag?: string;
  /** Why that model·effort was picked (shown on hover). */
  reason?: string;
  /** Names of files attached to the user's message. */
  files?: string[];
  /** On tool lines: the action log id. */
  ref?: string;
  /** When it was written (epoch ms). */
  at: number;
  streaming?: boolean;
}

export interface Tab {
  id: string;
  title: string;
  lines: Line[];
  busy: boolean;
  /** The Harv line deltas currently stream into. */
  currentId: string | null;
  tag?: string;
  reason?: string;
  /** Tokens the last turn sent: the conversation's context size. */
  context?: number;
  /** The server has this chat (it came from there, or a message was sent): otherwise it's a blank tab only the dashboard knows. */
  stored?: boolean;
}

/** The Settings tab's id in `activeId`; it sits in the tab bar after the chats. */
export const SETTINGS_TAB = 'settings';

export interface ChatState {
  tabs: Tab[];
  /** A chat tab's id, SETTINGS_TAB, or null when nothing is open. */
  activeId: string | null;
  /** The Settings tab is in the tab bar. */
  settingsOpen: boolean;
  /** What each chat shows: its log or one of its tools (missing = the log). */
  views: Record<string, ChatView>;
  /** Tools each chat has open, in the order they were opened. */
  tools: Record<string, ToolKind[]>;
  model: ModelChoice;
  effort: EffortLevel;
  /** What AUTO ran last, e.g. "Sonnet 5.5 · medium". */
  routed: string | null;
  routedReason?: string;
}

const newId = () => crypto.randomUUID();
/** One-message overrides at the start ("/opus /max …") don't belong in a tab title. */
const OVERRIDE_WORDS = /^(\s*\/(opus|sonnet|haiku|fable|low|med|medium|high|xhigh|max)\b)+\s*/i;
const blankTab = (): Tab => ({ id: newId(), title: 'New chat', lines: [], busy: false, currentId: null });

// The model/effort choice survives reloads (per browser; storage can be unavailable).
const SELECTION_KEY = 'harv.selection';
function loadSelection(): { model: ModelChoice; effort: EffortLevel } {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as { model: ModelChoice; effort: EffortLevel } | null;
    if (saved?.model && saved.effort) return saved;
  } catch {
    // Fall through to the defaults.
  }
  return { model: 'auto', effort: 'high' };
}
function saveSelection(model: ModelChoice, effort: EffortLevel) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ model, effort }));
  } catch {
    // Not critical.
  }
}

const first = blankTab();
const store = createStore<ChatState>({
  tabs: [first],
  activeId: first.id,
  settingsOpen: false,
  views: {},
  tools: {},
  ...loadSelection(),
  routed: null,
});

export const useChat = store.use;
export const getChatState = store.get;

export interface HistoryState {
  items: HistoryItem[];
  query: string;
}
const history = createStore<HistoryState>({ items: [], query: '' });
export const useHistory = history.use;

const fromSnapshot = (chat: ChatSnapshot): Tab => ({
  id: chat.id,
  stored: true,
  title: chat.title,
  busy: false,
  currentId: null,
  ...(chat.context ? { context: chat.context } : {}),
  lines: chat.lines.map((l) => ({
    id: newId(),
    at: l.at ?? Date.now(),
    kind: l.kind,
    text: l.text,
    ...(l.tag ? { tag: l.tag } : {}),
    ...(l.reason ? { reason: l.reason } : {}),
    ...(l.files ? { files: l.files } : {}),
    ...(l.ref ? { ref: l.ref } : {}),
  })),
});

/** Keeps only the entries of a per-chat map whose chat is still a tab. */
const onlyTabs = <T>(map: Record<string, T>, tabs: Tab[]) =>
  Object.fromEntries(Object.entries(map).filter(([id]) => tabs.some((t) => t.id === id)));

/**
 * Saved chats from the server replace ours; unsent blank tabs are kept. `ui`
 * (the saved layout) is given on the first connect only: it brings back blank
 * tabs, the tab order, which tab was showing and each chat's tools, like
 * Chrome reopening its tabs. After a reconnect the dashboard's own layout wins.
 */
function hydrate(chats: ChatSnapshot[], ui?: UiState) {
  store.set((s) => {
    const saved = chats.map(fromSnapshot);
    // The untouched starter tab gives way to saved chats; blank tabs the user opened stay.
    const blanks = s.tabs.filter((t) => !t.stored && t.id !== first.id && !saved.some((c) => c.id === t.id));
    for (const id of ui?.blanks ?? []) {
      if (!saved.some((c) => c.id === id) && !blanks.some((t) => t.id === id)) blanks.push({ ...blankTab(), id });
    }
    let tabs = [...saved, ...blanks];
    if (ui?.order.length) {
      const rank = (id: string) => {
        const i = ui.order.indexOf(id);
        return i === -1 ? Infinity : i;
      };
      tabs = tabs
        .map((t, i) => ({ t, i }))
        .sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i)
        .map(({ t }) => t);
    }
    if (tabs.length === 0) tabs.push(s.tabs.find((t) => t.id === first.id) ?? blankTab());

    const settingsOpen = s.settingsOpen || !!ui?.settingsOpen;
    const wanted = ui ? ui.activeId : s.activeId;
    const valid = (id: string | null) => (id === SETTINGS_TAB && settingsOpen) || tabs.some((t) => t.id === id);
    const activeId = valid(wanted) ? wanted : valid(s.activeId) ? s.activeId : tabs.at(-1)!.id;
    const views = onlyTabs(ui ? { ...ui.views, ...s.views } : s.views, tabs);
    const tools = onlyTabs(ui ? { ...ui.tools, ...s.tools } : s.tools, tabs);
    return { ...s, tabs, activeId, settingsOpen, views, tools };
  });
}

function updateTab(id: string, fn: (tab: Tab) => Tab) {
  store.set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) }));
}

const line = (kind: LineKind, text: string, extra: Partial<Line> = {}): Line => ({ id: newId(), kind, text, at: Date.now(), ...extra });

/** Marks the streaming line finished, dropping it if nothing arrived. */
function finishCurrent(tab: Tab): Tab {
  if (!tab.currentId) return tab;
  const lines = tab.lines
    .filter((l) => !(l.id === tab.currentId && l.text === ''))
    .map((l) => (l.id === tab.currentId ? { ...l, streaming: false } : l));
  return { ...tab, lines, currentId: null };
}

/** Adds text to the streaming line, creating one after a tool call. */
function withCurrent(tab: Tab, update: (text: string) => string): Tab {
  if (tab.currentId) {
    return { ...tab, lines: tab.lines.map((l) => (l.id === tab.currentId ? { ...l, text: update(l.text) } : l)) };
  }
  const fresh = line('harv', update(''), { tag: tab.tag, reason: tab.reason, streaming: true });
  return { ...tab, lines: [...tab.lines, fresh], currentId: fresh.id };
}

export function applyChatEvent(msg: ChatServerMessage): void {
  switch (msg.type) {
    case 'chat.started': {
      const tag = `${msg.model.split(' ')[0]!.toLowerCase()}·${msg.effort}`;
      const { reason } = msg;
      updateTab(msg.tabId, (t) => {
        // The thinking line added on send gets its tag now that the router has decided.
        const waiting = t.lines.find((l) => l.id === t.currentId && l.text === '');
        if (waiting) {
          const lines = t.lines.map((l) => (l === waiting ? { ...l, tag, reason } : l));
          return { ...t, busy: true, tag, reason, lines };
        }
        const pending = line('harv', '', { tag, reason, streaming: true });
        return { ...t, busy: true, tag, reason, lines: [...t.lines, pending], currentId: pending.id };
      });
      if (msg.auto) store.set((s) => ({ ...s, routed: `${msg.model} · ${msg.effort}`, routedReason: msg.reason }));
      break;
    }
    case 'chat.delta':
      updateTab(msg.tabId, (t) => withCurrent(t, (text) => text + msg.text));
      break;
    case 'chat.assistant':
      updateTab(msg.tabId, (t) => withCurrent(t, () => msg.text));
      break;
    case 'chat.tool':
      updateTab(msg.tabId, (t) => {
        const done = finishCurrent(t);
        return { ...done, lines: [...done.lines, line('tool', msg.detail ? `${msg.name} · ${msg.detail}` : msg.name, { ref: msg.id })] };
      });
      break;
    case 'chat.done':
      updateTab(msg.tabId, (t) => {
        const done = finishCurrent(t);
        const extra: Line[] = [];
        if (msg.stopped) extra.push(line('notice', 'Stopped.'));
        if (msg.error) extra.push(line('error', msg.error));
        const context = msg.usage?.inputTokens || done.context;
        return { ...done, busy: false, ...(context ? { context } : {}), lines: [...done.lines, ...extra] };
      });
      break;
    case 'chat.notice':
      updateTab(msg.tabId, (t) => ({ ...t, lines: [...t.lines, line('notice', msg.message)] }));
      break;
    case 'chat.line': {
      const { kind, text, ...rest } = msg.line;
      updateTab(msg.tabId, (t) => ({ ...t, lines: [...t.lines, line(kind, text, rest)] }));
      break;
    }
    case 'chat.error':
      updateTab(msg.tabId, (t) => ({ ...t, lines: [...t.lines, line('error', msg.message)] }));
      break;
    case 'chat.opened':
      store.set((s) => ({
        ...s,
        tabs: s.tabs.some((t) => t.id === msg.chat.id) ? s.tabs : [...s.tabs, fromSnapshot(msg.chat)],
        activeId: msg.focus === false && s.activeId ? s.activeId : msg.chat.id,
      }));
      break;
    case 'chat.renamed':
      updateTab(msg.tabId, (t) => ({ ...t, title: msg.title }));
      break;
    case 'chat.removed':
      store.set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== msg.tabId);
        return { ...withoutChat(s, msg.tabId), tabs, activeId: s.activeId === msg.tabId ? (tabs.at(-1)?.id ?? null) : s.activeId };
      });
      break;
    case 'history':
      // Ignore answers to a search the user has since changed.
      if (msg.query === history.get().query) history.set({ items: msg.items, query: msg.query });
      break;
  }
}

/** A chat's views and tools, forgotten when it closes. */
function withoutChat(s: ChatState, id: string): ChatState {
  const { [id]: _view, ...views } = s.views;
  const { [id]: _tools, ...tools } = s.tools;
  return { ...s, views, tools };
}

let restored = false;
/** Listeners for the saved layout on the first connect (drafts, explorer folders). */
const restoreListeners = new Set<(ui: UiState) => void>();
export const onLayoutRestore = (fn: (ui: UiState) => void) => void restoreListeners.add(fn);
/** True once the first hello brought the saved layout back; saving before that would wipe it. */
export const layoutRestored = () => restored;
export const subscribeChat = store.subscribe;

onServerMessage((msg) => {
  if (msg.type === 'hello') {
    hydrate(msg.chats, restored ? undefined : msg.ui);
    if (!restored) {
      restored = true;
      // Settings › AUTO: start on AUTO instead of the last model picked.
      if (msg.settings.startModel === 'auto') store.set((s) => ({ ...s, model: 'auto' }));
      restoreListeners.forEach((fn) => fn(msg.ui));
    }
    history.set({ items: msg.history, query: '' });
    if (history.get().query) sendMessage({ type: 'history.search', query: history.get().query });
  } else if (msg.type.startsWith('chat.') || msg.type === 'history') {
    applyChatEvent(msg as ChatServerMessage);
  }
});

/** Folders a chat's terminal should start in (from the explorer's "Open in Terminal"). */
export const terminalStart = new Map<string, string>();

export const chat = {
  setModel(model: ModelChoice) {
    store.set((s) => ({ ...s, model }));
    saveSelection(model, store.get().effort);
  },
  setEffort(effort: EffortLevel) {
    store.set((s) => ({ ...s, effort }));
    saveSelection(store.get().model, effort);
  },
  setActive: (activeId: string) => store.set((s) => ({ ...s, activeId })),

  /** Opens a new chat (optionally straight into one of its tools) and returns its id. */
  newTab(view: ChatView = 'chat'): string {
    const tab = blankTab();
    store.set((s) => ({
      ...s,
      tabs: [...s.tabs, tab],
      activeId: tab.id,
      ...(view !== 'chat' ? { views: { ...s.views, [tab.id]: view }, tools: { ...s.tools, [tab.id]: [view] } } : {}),
    }));
    return tab.id;
  },

  closeTab(id: string) {
    // The server ends the chat's terminal too.
    sendMessage({ type: 'chat.close', tabId: id });
    dropDrafts(id);
    store.set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId = s.activeId === id ? (tabs.at(-1)?.id ?? (s.settingsOpen ? SETTINGS_TAB : null)) : s.activeId;
      return { ...withoutChat(s, id), tabs, activeId };
    });
  },

  /** Shows a chat's log or one of its tools, opening the tool if it isn't yet. */
  setView(tabId: string, view: ChatView) {
    store.set((s) => {
      const open = s.tools[tabId] ?? [];
      const tools = view === 'chat' || open.includes(view) ? s.tools : { ...s.tools, [tabId]: [...open, view] };
      return { ...s, tools, views: { ...s.views, [tabId]: view } };
    });
  },

  /** Closes one of a chat's tools; the chat goes back to its log. */
  closeTool(tabId: string, kind: ToolKind) {
    if (kind === 'terminal') sendMessage({ type: 'term.close', id: terminalId(tabId) });
    store.set((s) => ({
      ...s,
      tools: { ...s.tools, [tabId]: (s.tools[tabId] ?? []).filter((k) => k !== kind) },
      views: s.views[tabId] === kind ? { ...s.views, [tabId]: 'chat' } : s.views,
    }));
  },

  /** The chat's terminal in `dir`: a new one starts there, a running one changes folder. */
  terminalAt(tabId: string, dir: string) {
    if (getChatState().tools[tabId]?.includes('terminal')) {
      sendMessage({ type: 'term.input', id: terminalId(tabId), data: `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'\r` });
    } else {
      terminalStart.set(tabId, dir);
    }
    chat.setView(tabId, 'terminal');
  },

  /** Opens Settings as a tab in the chat bar (or switches to it). */
  openSettings: () => store.set((s) => ({ ...s, settingsOpen: true, activeId: SETTINGS_TAB })),

  closeSettings() {
    store.set((s) => ({
      ...s,
      settingsOpen: false,
      activeId: s.activeId === SETTINGS_TAB ? (s.tabs.at(-1)?.id ?? null) : s.activeId,
    }));
  },

  /** The active chat's id. From Settings (or nothing) it switches to the last chat, or opens a new one. */
  ensureTab(): string {
    const s = store.get();
    if (s.tabs.some((t) => t.id === s.activeId)) return s.activeId!;
    const last = s.tabs.at(-1);
    if (last) chat.setActive(last.id);
    else chat.newTab();
    return store.get().activeId!;
  },

  send(text: string, attachments: Attachment[] = []) {
    const tabId = chat.ensureTab();
    const { model, effort } = store.get();
    const files = attachments.map((a) => a.name);
    updateTab(tabId, (t) => ({
      ...t,
      title: t.title === 'New chat' ? (text.replace(OVERRIDE_WORDS, '') || text || files[0] || 'Attachment').slice(0, 24) : t.title,
      stored: true,
      lines: [...t.lines, line('you', text, files.length ? { files } : {})],
    }));
    chat.dispatch(tabId, { type: 'chat.send', tabId, text, model, effort, ...(attachments.length ? { attachments } : {}) });
  },

  /** Runs the tab's last message again one step up the model·effort ladder. */
  harder(tabId: string) {
    updateTab(tabId, (t) => ({ ...t, lines: [...t.lines, line('you', 'Try harder.')] }));
    chat.dispatch(tabId, { type: 'chat.harder', tabId });
  },

  /** Sends a turn, showing Harv thinking right away (AUTO may take a moment to pick a model). */
  dispatch(tabId: string, msg: ClientMessage) {
    if (!sendMessage(msg)) {
      updateTab(tabId, (t) => ({ ...t, lines: [...t.lines, line('error', 'Not connected to the Harv server.')] }));
      return;
    }
    const pending = line('harv', '', { streaming: true });
    updateTab(tabId, (t) => ({ ...t, busy: true, lines: [...t.lines, pending], currentId: pending.id }));
  },

  /** A line from the dashboard itself (command help, errors); not saved. */
  localNotice(text: string, kind: 'notice' | 'error' = 'notice') {
    const tabId = chat.ensureTab();
    updateTab(tabId, (t) => ({ ...t, lines: [...t.lines, line(kind, text)] }));
  },

  /** A note in the chat that's showing, if one is (not saved; Settings stays put). */
  noticeInActive(text: string) {
    const { activeId, tabs } = store.get();
    if (activeId && tabs.some((t) => t.id === activeId)) updateTab(activeId, (t) => ({ ...t, lines: [...t.lines, line('notice', text)] }));
  },

  stop(tabId: string) {
    sendMessage({ type: 'chat.stop', tabId });
  },

  /** Activates the chat if it's already a tab, otherwise asks the server to reopen it. */
  openFromHistory(id: string) {
    if (store.get().tabs.some((t) => t.id === id)) chat.setActive(id);
    else sendMessage({ type: 'chat.open', tabId: id });
  },

  /** Renames a chat; Harv stops naming it automatically. */
  rename(tabId: string, raw: string) {
    const title = raw.replace(/\s+/g, ' ').trim();
    if (!title) return;
    updateTab(tabId, (t) => ({ ...t, title }));
    sendMessage({ type: 'chat.rename', tabId, title });
  },

  deleteChat(id: string) {
    sendMessage({ type: 'chat.delete', tabId: id });
  },

  searchHistory(query: string) {
    history.set((h) => ({ ...h, query }));
    sendMessage({ type: 'history.search', query });
  },
};
