import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserInput, BrowserState } from '@harv/shared';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import { HARV_HOME } from '../paths.ts';
import { setBrowserRefs, type BrowserElement } from './browserRefs.ts';

// The browser tab: the user's installed Chrome, run headless with its own Harv
// profile, streamed into the dashboard over the DevTools protocol (screencast
// frames out, mouse and keyboard in). Harv's browser tools drive the same pages,
// so the user watches whatever Harv does.

const PROFILE_DIR = join(HARV_HOME, 'browser-profile');
const START_PAGE = 'https://www.google.com';
/** How long the "Harv is using the browser" badge stays after its last action. */
const HARV_ACTIVE_MS = 4000;

export function findChrome(): string | null {
  const candidates = [
    process.env.HARV_CHROME_PATH,
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

/** What the user typed in the address bar → a URL: a web address as is, anything else a Google search. */
export function toUrl(input: string): string {
  const text = input.trim();
  if (/^https?:\/\//i.test(text) || /^about:blank$/i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text) || /^localhost(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** Only web pages: no file:, chrome: or javascript: URLs. */
export const isWebUrl = (url: string) => /^(https?:\/\/|about:blank$)/i.test(url);

interface Tab {
  page: Page;
  cdp: CDPSession;
  watching: boolean;
  casting: boolean;
  width: number;
  height: number;
  harvUntil: number;
  state: BrowserState;
}

export interface BrowserEvents {
  frame: (id: string, data: string, width: number, height: number) => void;
  state: (id: string, state: BrowserState) => void;
  error: (id: string, message: string) => void;
}

export class BrowserManager {
  private browser: Promise<Browser> | null = null;
  private tabs = new Map<string, Tab>();
  /** Watch and size messages for tabs whose page is still being created. */
  private early = new Map<string, { watching?: boolean; width?: number; height?: number }>();
  /** The tab Harv last used, so its tools keep working in the same page. */
  harvTab: string | null = null;

  constructor(private events: BrowserEvents) {}

  private launch(): Promise<Browser> {
    this.browser ??= (async () => {
      const executablePath = findChrome();
      if (!executablePath) throw new Error('Google Chrome isn’t installed (or set HARV_CHROME_PATH).');
      mkdirSync(PROFILE_DIR, { recursive: true });
      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: PROFILE_DIR,
        defaultViewport: null,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate', '--window-size=1280,800'],
      });
      browser.on('disconnected', () => {
        this.browser = null;
        for (const id of this.tabs.keys()) this.events.error(id, 'Chrome closed. Close this tab and open a new one.');
        this.tabs.clear();
      });
      return browser;
    })();
    this.browser.catch(() => (this.browser = null));
    return this.browser;
  }

  has(id: string): boolean {
    return this.tabs.has(id);
  }

  ids(): string[] {
    return [...this.tabs.keys()];
  }

  async open(id: string, url = START_PAGE): Promise<void> {
    if (this.tabs.has(id)) return;
    const browser = await this.launch();
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Page.enable');
    // The dashboard usually says it's watching (and how big it is) before Chrome has made the page.
    const early = this.early.get(id);
    this.early.delete(id);
    const tab: Tab = {
      page,
      cdp,
      watching: early?.watching ?? false,
      casting: false,
      width: early?.width ?? 1280,
      height: early?.height ?? 800,
      harvUntil: 0,
      state: { url: '', title: '', loading: true, canGoBack: false, canGoForward: false, harvActive: false },
    };
    this.tabs.set(id, tab);
    await page.setViewport({ width: tab.width, height: tab.height });

    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      this.events.frame(id, data, metadata.deviceWidth, metadata.deviceHeight);
    });
    const update = () => void this.publish(id);
    page.on('framenavigated', (frame) => frame === page.mainFrame() && update());
    page.on('load', update);
    page.on('domcontentloaded', update);
    // Links that open a new window open in this tab instead (one page per tab keeps it simple).
    page.on('popup', (popup) => {
      if (!popup) return;
      void (async () => {
        await popup.waitForNavigation({ timeout: 5000 }).catch(() => {});
        const target = popup.url();
        await popup.close().catch(() => {});
        if (isWebUrl(target) && target !== 'about:blank') await page.goto(target).catch(() => {});
      })();
    });
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
    await this.syncCast(tab);
    await this.navigate(id, url);
  }

  close(id: string): void {
    this.early.delete(id);
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    if (this.harvTab === id) this.harvTab = null;
    void tab.page.close().catch(() => {});
    // Chrome uses a lot of memory: quit it when the last browser tab closes.
    if (this.tabs.size === 0) void this.shutdown();
  }

  async shutdown(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.tabs.clear();
    if (browser) await (await browser.catch(() => null))?.close().catch(() => {});
  }

  private async publish(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    try {
      const history = await tab.cdp.send('Page.getNavigationHistory');
      tab.state = {
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ''),
        loading: false,
        // The blank page every new tab starts on doesn't count as somewhere to go back to.
        canGoBack: history.entries.slice(0, history.currentIndex).some((e) => e.url !== 'about:blank'),
        canGoForward: history.currentIndex < history.entries.length - 1,
        harvActive: Date.now() < tab.harvUntil,
      };
      this.events.state(id, tab.state);
    } catch {
      // The page is navigating or closing.
    }
  }

  /** Frames flow while the tab is showing or Harv is working in it. */
  private async syncCast(tab: Tab) {
    const want = tab.watching || Date.now() < tab.harvUntil;
    if (want === tab.casting) return;
    tab.casting = want;
    if (want) {
      await tab.cdp
        .send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: tab.width, maxHeight: tab.height, everyNthFrame: 1 })
        .catch(() => (tab.casting = false));
    } else {
      await tab.cdp.send('Page.stopScreencast').catch(() => {});
    }
  }

  async watch(id: string, on: boolean): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) {
      this.early.set(id, { ...this.early.get(id), watching: on });
      return;
    }
    tab.watching = on;
    await this.syncCast(tab);
    if (on) void this.publish(id);
  }

  async resize(id: string, width: number, height: number): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) {
      this.early.set(id, { ...this.early.get(id), width: Math.round(width), height: Math.round(height) });
      return;
    }
    const w = Math.max(320, Math.min(2560, Math.round(width)));
    const h = Math.max(240, Math.min(1600, Math.round(height)));
    if (w === tab.width && h === tab.height) return;
    tab.width = w;
    tab.height = h;
    await tab.page.setViewport({ width: w, height: h }).catch(() => {});
    if (tab.casting) {
      // Restart the cast at the new size.
      tab.casting = false;
      await tab.cdp.send('Page.stopScreencast').catch(() => {});
      await this.syncCast(tab);
    }
  }

  async navigate(id: string, input: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const url = toUrl(input);
    if (!isWebUrl(url)) return this.events.error(id, 'Only web pages (http and https) open here.');
    tab.state = { ...tab.state, url, loading: true };
    this.events.state(id, tab.state);
    try {
      await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      this.events.error(id, `Couldn’t open ${url}: ${(err as Error).message.split('\n')[0]}`);
    }
    void this.publish(id);
  }

  async nav(id: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const opts = { waitUntil: 'domcontentloaded' as const, timeout: 15_000 };
    try {
      if (action === 'back') await tab.page.goBack(opts);
      else if (action === 'forward') await tab.page.goForward(opts);
      else if (action === 'reload') await tab.page.reload(opts);
      else await tab.cdp.send('Page.stopLoading');
    } catch {
      // Navigation timeouts are fine; the state below shows where it got to.
    }
    void this.publish(id);
  }

  /** The user's mouse and keyboard, already in page pixels. */
  async input(id: string, input: BrowserInput): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    try {
      if (input.kind === 'mouse') {
        await tab.cdp.send('Input.dispatchMouseEvent', {
          type: input.type,
          x: input.x,
          y: input.y,
          button: input.button,
          clickCount: input.clickCount,
          modifiers: input.modifiers,
        });
      } else if (input.kind === 'wheel') {
        await tab.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: input.modifiers,
        });
      } else if (input.kind === 'text') {
        await tab.cdp.send('Input.insertText', { text: String(input.text).slice(0, 20_000) });
      } else {
        // Printable keys carry text (which types it); the rest are raw key presses.
        const printable = input.type === 'keyDown' && input.text !== undefined && input.text.length === 1 && !(input.modifiers & 2);
        await tab.cdp.send('Input.dispatchKeyEvent', {
          type: input.type === 'keyUp' ? 'keyUp' : printable ? 'keyDown' : 'rawKeyDown',
          key: input.key,
          code: input.code,
          text: printable ? input.text : undefined,
          unmodifiedText: printable ? input.text : undefined,
          windowsVirtualKeyCode: input.keyCode,
          nativeVirtualKeyCode: input.keyCode,
          modifiers: input.modifiers,
        });
      }
    } catch {
      // The page may be mid-navigation.
    }
  }

  // ---- Harv's tools -------------------------------------------------------

  /** Marks Harv as using the tab: frames flow and the dashboard shows the badge. */
  private touch(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.harvTab = id;
    tab.harvUntil = Date.now() + HARV_ACTIVE_MS;
    void this.syncCast(tab);
    void this.publish(id);
    setTimeout(() => {
      void this.syncCast(tab);
      void this.publish(id);
    }, HARV_ACTIVE_MS + 100);
  }

  page(id: string): Page | undefined {
    return this.tabs.get(id)?.page;
  }

  /** Runs one of Harv's actions in a tab, with the badge on. */
  async asHarv<T>(id: string, action: (page: Page) => Promise<T>): Promise<T> {
    const page = this.page(id);
    if (!page) throw new Error('That browser tab is closed.');
    this.touch(id);
    try {
      return await action(page);
    } finally {
      this.touch(id);
    }
  }

  /** What Harv "sees": title, URL, the clickable and typeable elements (numbered), and the page's text. */
  async snapshot(id: string): Promise<string> {
    return this.asHarv(id, async (page) => {
      const result = await page.evaluate(SNAPSHOT_SCRIPT);
      const { url, title, elements, text } = result as { url: string; title: string; elements: BrowserElement[]; text: string };
      setBrowserRefs(url, elements);
      const list = elements
        .map((e) => `[${e.ref}] ${e.role || e.tag}${e.type && e.type !== e.role ? `(${e.type})` : ''} "${e.text}"`)
        .join('\n');
      return `${title}\n${url}\n\nInteractive elements (use the number as ref):\n${list || '(none visible)'}\n\nPage text:\n${text}`;
    });
  }

  async click(id: string, ref: number): Promise<string> {
    return this.asHarv(id, async (page) => {
      const el = await page.$(`[data-harv-ref="${ref}"]`);
      if (!el) return `No element [${ref}] on the page any more. Take a new snapshot.`;
      await el.scrollIntoView().catch(() => {});
      const box = await el.boundingBox();
      if (!box) return `Element [${ref}] isn't visible.`;
      // A real mouse click in the middle, so it shows in the stream like the user's own.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await settle(page);
      return `Clicked [${ref}]. Now on: ${await page.title().catch(() => '')} (${page.url()})`;
    });
  }

  async type(id: string, ref: number, text: string, submit: boolean): Promise<string> {
    return this.asHarv(id, async (page) => {
      const el = await page.$(`[data-harv-ref="${ref}"]`);
      if (!el) return `No element [${ref}] on the page any more. Take a new snapshot.`;
      await el.scrollIntoView().catch(() => {});
      await el.click({ count: 3 }).catch(() => {});
      await page.keyboard.type(text, { delay: 15 });
      if (submit) {
        await page.keyboard.press('Enter');
        await settle(page);
      }
      return `Typed into [${ref}]${submit ? ' and pressed Enter' : ''}. Now on: ${page.url()}`;
    });
  }

  async press(id: string, key: string): Promise<string> {
    return this.asHarv(id, async (page) => {
      await page.keyboard.press(key as Parameters<Page['keyboard']['press']>[0]);
      await settle(page);
      return `Pressed ${key}.`;
    });
  }

  async scroll(id: string, direction: 'up' | 'down'): Promise<string> {
    return this.asHarv(id, async (page) => {
      const tab = this.tabs.get(id)!;
      await page.mouse.move(tab.width / 2, tab.height / 2);
      await page.mouse.wheel({ deltaY: direction === 'down' ? tab.height * 0.8 : -tab.height * 0.8 });
      await new Promise((r) => setTimeout(r, 400));
      return `Scrolled ${direction}.`;
    });
  }

  async goBack(id: string): Promise<string> {
    return this.asHarv(id, async (page) => {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
      return `Back to ${page.url()}`;
    });
  }

  async goTo(id: string, url: string): Promise<string> {
    const target = toUrl(url);
    if (!isWebUrl(target)) return 'Only http and https pages can be opened.';
    return this.asHarv(id, async (page) => {
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (err) {
        return `Couldn’t open ${target}: ${(err as Error).message.split('\n')[0]}`;
      }
      return `Opened ${await page.title().catch(() => '')} (${page.url()})`;
    });
  }

  async screenshot(id: string): Promise<string> {
    return this.asHarv(id, async (page) => (await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' })) as string);
  }
}

/** Waits briefly for a click or Enter to finish navigating or re-rendering. */
async function settle(page: Page) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3000 }).catch(() => {}),
    new Promise((r) => setTimeout(r, 1200)),
  ]);
}

/** Runs in the page: numbers the visible interactive elements and collects the readable text. */
const SNAPSHOT_SCRIPT = `(() => {
  document.querySelectorAll('[data-harv-ref]').forEach((el) => el.removeAttribute('data-harv-ref'));
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=searchbox], [role=textbox], [contenteditable=true], summary';
  const out = [];
  const seen = new Set();
  let ref = 1;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
    if (r.bottom < -200 || r.top > innerHeight * 3) continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const key = el.tagName + label + Math.round(r.top) + Math.round(r.left);
    if (seen.has(key)) continue;
    seen.add(key);
    const form = el.form || el.closest('form');
    const submit = form ? form.querySelector('button[type=submit], input[type=submit], button:not([type])') : null;
    el.setAttribute('data-harv-ref', String(ref));
    out.push({
      ref: ref++,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: label,
      type: (el.getAttribute('type') || '').toLowerCase(),
      name: [el.getAttribute('name'), el.id, el.getAttribute('autocomplete')].filter(Boolean).join(' ').slice(0, 80),
      formSubmit: submit ? (submit.innerText || submit.value || '').trim().slice(0, 60) : '',
    });
    if (out.length >= 150) break;
  }
  const main = document.querySelector('main, [role=main], article') || document.body;
  const text = (main ? main.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000);
  return { url: location.href, title: document.title, elements: out, text };
})()`;
