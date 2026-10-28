// Harv's browser (docs/PLAN.md §6x): one per computer, real web views in the app, shared by
// every chat. The app's dashboard drives it; Harv's browser tools reach it through the server.

/** A page tab in the browser. */
export interface BrowserPage {
  id: number;
  url: string;
  title: string;
  loading: boolean;
}

/** What the browser does for the server (Harv's tools), carried out by the app's dashboard. */
export type BrowserAction = 'open' | 'navigate' | 'back' | 'forward' | 'reload' | 'close' | 'select' | 'eval';

export type BrowserClientMessage =
  /** The app's dashboard is here and can drive the browser. */
  | { type: 'browser.hello' }
  /** The answer to a browser.do. */
  | { type: 'browser.result'; reqId: string; ok: boolean; value?: unknown; error?: string };

export type BrowserServerMessage =
  /** Do this in the browser and answer with browser.result (sent to the app's dashboard only). */
  | { type: 'browser.do'; reqId: string; action: BrowserAction; id?: number; url?: string; script?: string }
  /** Harv is using the browser: the tab says so until `until` (ms since 1970). */
  | { type: 'browser.busy'; until: number };

/** What the user typed in the address bar (or Harv asked to open), as an address the browser takes. */
export function toBrowserUrl(input: string, home = ''): string {
  const text = input.trim();
  if (/^(https?|file):\/\//i.test(text) || text === 'about:blank') return text;
  // A file or folder on this computer: C:\…, /home/…, ~/…
  const local = /^~(?=$|[\\/])/.test(text) && home ? home + text.slice(1) : text;
  if (/^[a-z]:[\\/]/i.test(local)) return `file:///${local.replace(/\\/g, '/').split('/').map(encodePart).join('/')}`;
  if (local.startsWith('/')) return `file://${local.split('/').map(encodePart).join('/')}`;
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(text) || /^127\.0\.0\.1(:\d+)?(\/\S*)?$/.test(text)) return `http://${text}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** One part of a file path in a URL: spaces and the like escaped, the drive's colon kept. */
const encodePart = (part: string) => (/^[a-z]:$/i.test(part) ? part : encodeURIComponent(part));

/** A file:// address as the path it points at (for watching it), or null for a web page. */
export function fileOfUrl(url: string): string | null {
  if (!/^file:\/\//i.test(url)) return null;
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    return /^\/[a-z]:\//i.test(path) ? path.slice(1).replace(/\//g, '\\') : path;
  } catch {
    return null;
  }
}
