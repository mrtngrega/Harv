import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { BrowserPage, BrowserServerMessage } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onServerMessage, sendMessage } from './socket.ts';
import { subscribeConnection, getConnection } from './useHarvSocket.ts';

/**
 * Harv's browser (docs/PLAN.md §6x): one per computer, real web views the app places over a
 * chat's Browser view (its ≡ menu; apps/desktop/src-tauri/src/browser.rs). This module drives them
 * for that view and, in the app, for Harv's browser tools (the server's browser.do, answered
 * with browser.result).
 */

export interface BrowserState {
  pages: BrowserPage[];
  active: number | null;
  /** Harv used it moments ago, until this time: the view says so. */
  busyUntil: number;
  /** The app has said what it holds (until then, no pages doesn't mean none). */
  known: boolean;
}

/** In the app (asked here, not from desktop.ts: that would import the chat store back, a cycle). */
const inApp = isTauri();
/** The page a new browser starts on. */
export const BROWSER_START = 'https://www.google.com';

const store = createStore<BrowserState>({ pages: [], active: null, busyUntil: 0, known: false });
export const useBrowser = store.use;

type Args = { id?: number; url?: string; script?: string; x?: number; y?: number; w?: number; h?: number; visible?: boolean };
const call = <T = unknown>(action: string, args: Args = {}) => invoke<T>('browser', { action, ...args });

/**
 * Where the Browser view wants the pages (null: not showing), and how many menus are open over
 * it: the pages are real windows of their own, so nothing of the dashboard can show on top of
 * them, and they step aside while a menu is open.
 */
let wanted: DOMRect | null = null;
let covers = 0;
const apply = () => {
  const show = !!wanted && covers === 0;
  const at = wanted ? { x: wanted.left, y: wanted.top, w: wanted.width, h: wanted.height } : {};
  void call('place', { ...at, visible: show }).catch(() => {});
};

export const browser = {
  open: (url: string) => call<{ id: number }>('open', { url }),
  navigate: (url: string, id?: number) => call('navigate', { url, ...(id ? { id } : {}) }),
  back: () => call('back'),
  forward: () => call('forward'),
  reload: () => call('reload'),
  close: (id: number) => call('close', { id }),
  select: (id: number) => call('select', { id }),
  /** Puts the browser over the view's page area (logical px of the window), or away (null). */
  place(rect: DOMRect | null) {
    wanted = rect;
    apply();
  },
  /** A menu opens (true) or closes (false) where the browser may be. */
  cover(on: boolean) {
    covers = Math.max(0, covers + (on ? 1 : -1));
    apply();
  },
};

if (inApp) {
  // A dashboard that (re)loads shows no browser until a Browser view asks: after a restart the
  // pages stayed over the chat (the user's report, 2026-10-28).
  apply();
  void listen<{ pages: BrowserPage[]; active: number | null }>('browser-state', (e) => {
    store.set((s) => ({ ...s, pages: e.payload.pages, active: e.payload.active, known: true }));
  })
    // Then the pages the app still holds (after a reload): asked once listening, or the answer is lost.
    .then(() => invoke('browser_state'))
    .catch(() => {});

  // This dashboard drives the browser for Harv: say so on every (re)connection.
  let connected = false;
  const hello = () => {
    const now = getConnection().connected;
    if (now && !connected) sendMessage({ type: 'browser.hello' });
    connected = now;
  };
  subscribeConnection(hello);
  hello();

  onServerMessage((raw) => {
    const msg = raw as BrowserServerMessage;
    if (msg.type === 'browser.busy') {
      store.set((s) => ({ ...s, busyUntil: msg.until }));
      return;
    }
    if (msg.type !== 'browser.do') return;
    const { reqId, action, ...args } = msg;
    delete (args as { type?: string }).type;
    call(action, args as Args).then(
      (value) => sendMessage({ type: 'browser.result', reqId, ok: true, value }),
      (err: unknown) => sendMessage({ type: 'browser.result', reqId, ok: false, error: String(err) }),
    );
  });
}
