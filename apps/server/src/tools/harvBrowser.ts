import { homedir } from 'node:os';
import { toBrowserUrl } from '@harv/shared';
import type { BrowserHost } from './browserHost.ts';
import { setBrowserRefs, type BrowserElement } from './browserRefs.ts';

// What Harv does in the shared browser (its browser_* tools): small scripts run in the page by
// the app (synchronous: the engines don't wait for promises), plus open/back through the app.
// Waiting for a page happens here, by asking again.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Keeps what goes back to the model small: it counts against the user's plan. */
const MAX_TEXT = 6000;

/**
 * Numbers what can be clicked or typed into (data-harv-ref) and returns them with the page's
 * text. A function body: the app wraps it and returns its value.
 */
export const SNAPSHOT_SCRIPT = `
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
  const text = (main ? main.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_TEXT});
  return { url: location.href, title: document.title, elements: out, text };
`;

interface Snapshot {
  url: string;
  title: string;
  elements: BrowserElement[];
  text: string;
}

const elementLine = (e: BrowserElement) =>
  `[${e.ref}] ${e.role || e.tag}${e.type ? `(${e.type})` : ''} ${e.text ? `"${e.text}"` : ''}${e.name ? ` · ${e.name}` : ''}`.trim();

/** A snapshot as text for the model: where, what can be used (by ref), and what the page says. */
export function formatSnapshot(s: Snapshot): string {
  return [
    `${s.title || '(no title)'} · ${s.url}`,
    '',
    s.elements.length ? `Elements (use their numbers):\n${s.elements.map(elementLine).join('\n')}` : 'No clickable elements found.',
    '',
    `Page text:\n${s.text || '(none)'}`,
  ].join('\n');
}

/** A page script that finds element `ref` from the last snapshot (or says it's gone). */
const byRef = (ref: number) =>
  `const el = document.querySelector('[data-harv-ref="${ref}"]'); if (!el) return { gone: true }; el.scrollIntoView({ block: 'center' });`;

const GONE = (ref: number) => `No element [${ref}] on the page any more (it changed). Take a new browser_snapshot.`;

/** Keys a page script can press on the focused element. */
const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
};

export class HarvBrowser {
  constructor(
    private host: BrowserHost,
    /** Tells the dashboards Harv is using the browser (the tab shows it). */
    private busy: () => void,
  ) {}

  private eval<T>(script: string): Promise<T> {
    return this.host.call('eval', { script }) as Promise<T>;
  }

  /** Waits until the page has loaded (or a while has passed), then a moment for scripts to draw it. */
  private async settle(ms = 15_000): Promise<void> {
    await sleep(400);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const state = await this.eval<string>('return document.readyState').catch(() => 'loading');
      if (state === 'complete') break;
      await sleep(400);
    }
    await sleep(600);
  }

  async snapshot(): Promise<string> {
    this.busy();
    const s = await this.eval<Snapshot | null>(SNAPSHOT_SCRIPT);
    if (!s) return 'The page gave no answer (still loading?). Try again.';
    setBrowserRefs(s.url, s.elements);
    return formatSnapshot(s);
  }

  /** Opens `target` (an address, a file path or words to search) in a new page tab, and reads it. */
  async open(target: string, sameTab = false): Promise<string> {
    this.busy();
    const url = toBrowserUrl(target, homedir());
    await this.host.call(sameTab ? 'navigate' : 'open', { url });
    await this.settle();
    return this.snapshot();
  }

  async click(ref: number): Promise<string> {
    this.busy();
    const r = await this.eval<{ gone?: boolean } | null>(`${byRef(ref)} el.click(); return { clicked: true };`);
    if (!r || r.gone) return GONE(ref);
    await this.settle(8000);
    const where = await this.eval<{ title: string; url: string }>('return { title: document.title, url: location.href }');
    return `Clicked [${ref}]. Now on: ${where.title || '(no title)'} · ${where.url}. Take a browser_snapshot to see the page.`;
  }

  /** Types into a field (replacing what's there), like the user would; submit sends Enter / the form. */
  async type(ref: number, value: string, submit: boolean): Promise<string> {
    this.busy();
    const r = await this.eval<{ gone?: boolean } | null>(`${byRef(ref)}
      el.focus();
      const text = ${JSON.stringify(value)};
      if (el.isContentEditable) {
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, text);
      } else {
        // The native setter, so pages built with React and the like see the change.
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (${submit}) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const go = el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        const form = el.form || el.closest('form');
        if (go && form) form.requestSubmit ? form.requestSubmit() : form.submit();
      }
      return { typed: true };`);
    if (!r || r.gone) return GONE(ref);
    if (submit) await this.settle(8000);
    return submit ? `Typed into [${ref}] and submitted. Take a browser_snapshot to see the result.` : `Typed into [${ref}].`;
  }

  async press(key: string): Promise<string> {
    this.busy();
    const k = KEYS[key.toLowerCase().replace(/\s+/g, '')];
    if (!k)
      return `Unknown key "${key}". Known: ${Object.values(KEYS)
        .map((x) => x.code)
        .join(', ')}.`;
    await this.eval(`
      const el = document.activeElement || document.body;
      const opts = { key: ${JSON.stringify(k.key)}, code: ${JSON.stringify(k.code)}, keyCode: ${k.keyCode}, which: ${k.keyCode}, bubbles: true, cancelable: true };
      const go = el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (go && opts.key === 'Enter') { const form = el.form || el.closest && el.closest('form'); if (form) form.requestSubmit ? form.requestSubmit() : form.submit(); else if (el.click && el !== document.body) el.click(); }
      if (go && opts.key === 'PageDown') scrollBy(0, innerHeight * 0.85);
      if (go && opts.key === 'PageUp') scrollBy(0, -innerHeight * 0.85);
      return true;`);
    if (k.key === 'Enter') await this.settle(8000);
    return `Pressed ${k.key}.`;
  }

  async scroll(direction: 'up' | 'down'): Promise<string> {
    this.busy();
    const at = await this.eval<{ y: number; max: number }>(
      `scrollBy(0, ${direction === 'down' ? '' : '-'}innerHeight * 0.85); return { y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) };`,
    );
    return `Scrolled ${direction} (${at.y} of ${at.max} px). Take a browser_snapshot to read what's shown.`;
  }

  async back(): Promise<string> {
    this.busy();
    await this.host.call('back');
    await this.settle(8000);
    return this.snapshot();
  }
}
