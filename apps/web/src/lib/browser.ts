import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { BrowserPage, BrowserServerMessage } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onServerMessage, sendMessage } from './socket.ts';
import { subscribeConnection, getConnection } from './useHarvSocket.ts';

/**
 * Harv's browser (docs/PLAN.md §6x): one per computer, real web views the app places over the
 * Browser tab (apps/desktop/src-tauri/src/browser.rs). This module drives them for the tab and,
 * in the app, for Harv's browser tools (the server's browser.do, answered with browser.result).
 */

export interface BrowserView {
  pages: BrowserPage[];
  active: number | null;
  /** Harv used it moments ago, until this time: the tab says so. */
  busyUntil: number;
}

/** In the app (asked here, not from desktop.ts: that would import the chat store back, a cycle). */
const inApp = isTauri();
/** The page a new browser starts on. */
export const BROWSER_START = 'https://www.google.com';

const store = createStore<BrowserView>({ pages: [], active: null, busyUntil: 0 });
export const useBrowser = store.use;
export const getBrowser = store.get;
export const subscribeBrowser = store.subscribe;
/** Listeners for "show the Browser tab" (chatStore opens it; this module can't import it: a cycle). */
const showListeners = new Set<(activate: boolean) => void>();
export const onShowBrowser = (fn: (activate: boolean) => void) => void showListeners.add(fn);

type Args = { id?: number; url?: string; script?: string; x?: number; y?: number; w?: number; h?: number; visible?: boolean };
const call = <T = unknown>(action: string, args: Args = {}) => invoke<T>('browser', { action, ...args });

export const browser = {
  open: (url: string) => call<{ id: number }>('open', { url }),
  navigate: (url: string, id?: number) => call('navigate', { url, ...(id ? { id } : {}) }),
  back: () => call('back'),
  forward: () => call('forward'),
  reload: () => call('reload'),
  close: (id: number) => call('close', { id }),
  select: (id: number) => call('select', { id }),
  /** Puts the browser over the tab's page area (logical px of the window), or hides it. */
  place(rect: DOMRect | null, visible: boolean) {
    const at = rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : {};
    void call('place', { ...at, visible }).catch(() => {});
  },
};

if (inApp) {
  void listen<{ pages: BrowserPage[]; active: number | null }>('browser-state', (e) => {
    store.set((s) => ({ ...s, pages: e.payload.pages, active: e.payload.active }));
  });
  // Pages the app still holds after the dashboard reloaded.
  void invoke('browser_state').catch(() => {});

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
    // Harv opening a page puts the Browser tab in the tab bar (without switching to it).
    if (msg.action === 'open') showListeners.forEach((fn) => fn(false));
    const { reqId, action, ...args } = msg;
    delete (args as { type?: string }).type;
    call(action, args as Args).then(
      (value) => sendMessage({ type: 'browser.result', reqId, ok: true, value }),
      (err: unknown) => sendMessage({ type: 'browser.result', reqId, ok: false, error: String(err) }),
    );
  });
}
