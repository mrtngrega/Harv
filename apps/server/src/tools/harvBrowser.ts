import { randomUUID } from 'node:crypto';
import type { BrowserManager } from './browser.ts';
import type { ToolRegistry } from './registry.ts';

/** Set once at startup (index.ts); Harv's browser tools use it. */
let wired: { browser: BrowserManager; tools: ToolRegistry } | null = null;

export function wireHarvBrowser(browser: BrowserManager, tools: ToolRegistry): void {
  wired = { browser, tools };
}

export function harvBrowser(): BrowserManager {
  if (!wired) throw new Error('The browser isn’t available.');
  return wired.browser;
}

/**
 * The browser tab Harv works in: the one it used last, else the newest open
 * browser tab, else a new one (it appears in the chat bar so the user can watch).
 */
export async function harvBrowserTab(): Promise<string> {
  if (!wired) throw new Error('The browser isn’t available.');
  const { browser, tools } = wired;
  if (browser.harvTab && browser.has(browser.harvTab)) return browser.harvTab;
  const open = tools.list().filter((t) => t.kind === 'browser' && browser.has(t.id));
  if (open.length) return open.at(-1)!.id;
  const id = randomUUID();
  await tools.open(id, 'browser');
  browser.harvTab = id;
  return id;
}
