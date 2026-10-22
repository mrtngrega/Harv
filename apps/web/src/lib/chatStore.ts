import type { ChatServerMessage, EffortLevel, ModelChoice } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onServerMessage, sendMessage } from './socket.ts';

export type LineKind = 'you' | 'harv' | 'tool' | 'notice' | 'error';

export interface Line {
  id: string;
  kind: LineKind;
  text: string;
  /** "sonnet·medium" on Harv's replies. */
  tag?: string;
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

const first = blankTab();
const store = createStore<ChatState>({ tabs: [first], activeId: first.id, model: 'auto', effort: 'high', routed: null });

export const useChat = store.use;
export const getChatState = store.get;

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
  }
}

onServerMessage((msg) => {
  if (msg.type.startsWith('chat.')) applyChatEvent(msg as ChatServerMessage);
});

export const chat = {
  setModel: (model: ModelChoice) => store.set((s) => ({ ...s, model })),
  setEffort: (effort: EffortLevel) => store.set((s) => ({ ...s, effort })),
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

  send(text: string) {
    let { activeId } = store.get();
    if (!activeId) {
      chat.newTab();
      activeId = store.get().activeId!;
    }
    const { model, effort } = store.get();
    const tabId = activeId;
    updateTab(tabId, (t) => ({
      ...t,
      title: t.title === 'New chat' ? text.slice(0, 24) : t.title,
      lines: [...t.lines, line('you', text)],
    }));
    if (!sendMessage({ type: 'chat.send', tabId, text, model, effort })) {
      updateTab(tabId, (t) => ({ ...t, lines: [...t.lines, line('error', 'Not connected to the Harv server.')] }));
    }
  },

  stop(tabId: string) {
    sendMessage({ type: 'chat.stop', tabId });
  },
};
