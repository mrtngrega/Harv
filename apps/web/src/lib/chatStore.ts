import type { Attachment, ChatServerMessage, ChatSnapshot, EffortLevel, HistoryItem, LineKind, ModelChoice } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onServerMessage, sendMessage } from './socket.ts';

export type { LineKind };

export interface Line {
  id: string;
  kind: LineKind;
  text: string;
  /** "sonnet·medium" on Harv's replies. */
  tag?: string;
  /** Names of files attached to the user's message. */
  files?: string[];
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
}

export interface ChatState {
  tabs: Tab[];
  activeId: string | null;
  model: ModelChoice;
  effort: EffortLevel;
  /** What AUTO ran last, e.g. "Sonnet 5.5 · medium". */
  routed: string | null;
}

const newId = () => crypto.randomUUID();
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
const store = createStore<ChatState>({ tabs: [first], activeId: first.id, ...loadSelection(), routed: null });

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
  title: chat.title,
  busy: false,
  currentId: null,
  lines: chat.lines.map((l) => ({
    id: newId(),
    kind: l.kind,
    text: l.text,
    ...(l.tag ? { tag: l.tag } : {}),
    ...(l.files ? { files: l.files } : {}),
  })),
});

/** Saved chats from the server replace ours; unsent blank tabs are kept. */
function hydrate(chats: ChatSnapshot[]) {
  store.set((s) => {
    const saved = chats.map(fromSnapshot);
    // The untouched starter tab gives way to saved chats; blank tabs the user opened stay.
    const blanks = s.tabs.filter((t) => t.lines.length === 0 && t.id !== first.id && !saved.some((c) => c.id === t.id));
    const tabs = [...saved, ...blanks];
    if (tabs.length === 0) tabs.push(s.tabs.find((t) => t.id === first.id) ?? blankTab());
    const activeId = tabs.some((t) => t.id === s.activeId) ? s.activeId : tabs.at(-1)!.id;
    return { ...s, tabs, activeId };
  });
}

function updateTab(id: string, fn: (tab: Tab) => Tab) {
  store.set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) }));
}

const line = (kind: LineKind, text: string, extra: Partial<Line> = {}): Line => ({ id: newId(), kind, text, ...extra });

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
  const fresh = line('harv', update(''), { tag: tab.tag, streaming: true });
  return { ...tab, lines: [...tab.lines, fresh], currentId: fresh.id };
}

export function applyChatEvent(msg: ChatServerMessage): void {
  switch (msg.type) {
    case 'chat.started': {
      const tag = `${msg.model.split(' ')[0]!.toLowerCase()}·${msg.effort}`;
      const pending = line('harv', '', { tag, streaming: true });
      updateTab(msg.tabId, (t) => ({ ...t, busy: true, tag, lines: [...t.lines, pending], currentId: pending.id }));
      if (msg.auto) store.set((s) => ({ ...s, routed: `${msg.model} · ${msg.effort}` }));
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
        return { ...done, lines: [...done.lines, line('tool', msg.detail ? `${msg.name} · ${msg.detail}` : msg.name)] };
      });
      break;
    case 'chat.done':
      updateTab(msg.tabId, (t) => {
        const done = finishCurrent(t);
        const extra: Line[] = [];
        if (msg.stopped) extra.push(line('notice', 'Stopped.'));
        if (msg.error) extra.push(line('error', msg.error));
        return { ...done, busy: false, lines: [...done.lines, ...extra] };
      });
      break;
    case 'chat.notice':
      updateTab(msg.tabId, (t) => ({ ...t, lines: [...t.lines, line('notice', msg.message)] }));
      break;
    case 'chat.error':
      updateTab(msg.tabId, (t) => ({ ...t, lines: [...t.lines, line('error', msg.message)] }));
      break;
    case 'chat.opened':
      store.set((s) => ({
        ...s,
        tabs: s.tabs.some((t) => t.id === msg.chat.id) ? s.tabs : [...s.tabs, fromSnapshot(msg.chat)],
        activeId: msg.chat.id,
      }));
      break;
    case 'chat.removed':
      store.set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== msg.tabId);
        return { ...s, tabs, activeId: s.activeId === msg.tabId ? (tabs.at(-1)?.id ?? null) : s.activeId };
      });
      break;
    case 'history':
      // Ignore answers to a search the user has since changed.
      if (msg.query === history.get().query) history.set({ items: msg.items, query: msg.query });
      break;
  }
}

onServerMessage((msg) => {
  if (msg.type === 'hello') {
    hydrate(msg.chats);
    history.set({ items: msg.history, query: '' });
    if (history.get().query) sendMessage({ type: 'history.search', query: history.get().query });
  } else if (msg.type.startsWith('chat.') || msg.type === 'history') {
    applyChatEvent(msg as ChatServerMessage);
  }
});

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

  newTab() {
    const tab = blankTab();
    store.set((s) => ({ ...s, tabs: [...s.tabs, tab], activeId: tab.id }));
  },

  closeTab(id: string) {
    sendMessage({ type: 'chat.close', tabId: id });
    store.set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId = s.activeId === id ? (tabs.at(-1)?.id ?? null) : s.activeId;
      return { ...s, tabs, activeId };
    });
  },

  /** The active tab's id, opening a new tab when none is open. */
  ensureTab(): string {
    if (!store.get().activeId) chat.newTab();
    return store.get().activeId!;
  },

  send(text: string, attachments: Attachment[] = []) {
    const tabId = chat.ensureTab();
    const { model, effort } = store.get();
    const files = attachments.map((a) => a.name);
    updateTab(tabId, (t) => ({
      ...t,
      title: t.title === 'New chat' ? (text || files[0] || 'Attachment').slice(0, 24) : t.title,
      lines: [...t.lines, line('you', text, files.length ? { files } : {})],
    }));
    if (!sendMessage({ type: 'chat.send', tabId, text, model, effort, ...(attachments.length ? { attachments } : {}) })) {
      updateTab(tabId, (t) => ({ ...t, lines: [...t.lines, line('error', 'Not connected to the Harv server.')] }));
    }
  },

  stop(tabId: string) {
    sendMessage({ type: 'chat.stop', tabId });
  },

  /** Activates the chat if it's already a tab, otherwise asks the server to reopen it. */
  openFromHistory(id: string) {
    if (store.get().tabs.some((t) => t.id === id)) chat.setActive(id);
    else sendMessage({ type: 'chat.open', tabId: id });
  },

  deleteChat(id: string) {
    sendMessage({ type: 'chat.delete', tabId: id });
  },

  searchHistory(query: string) {
    history.set((h) => ({ ...h, query }));
    sendMessage({ type: 'history.search', query });
  },
};
