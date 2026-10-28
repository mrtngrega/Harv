import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fileOfUrl, toBrowserUrl } from '@harv/shared';
import { browser, BROWSER_START, useBrowser } from '../../lib/browser.ts';
import { inApp } from '../../lib/desktop.ts';
import { fileProps } from '../../lib/preview.ts';

/**
 * The Browser tab (docs/PLAN.md §6x): page tabs, back / forward / reload, an address bar, and the
 * area the app's real web view sits over. One browser for every chat: Harv's browser tools use
 * the same pages, and the tab says when Harv is at it. In a plain browser there's no browser.
 */
export function BrowserView() {
  const { pages, active, busyUntil } = useBrowser();
  const page = pages.find((p) => p.id === active) ?? null;
  const area = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = busyUntil > now;

  // The app's web view goes exactly over the page area, and away when this tab isn't showing.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || !inApp) return;
    const put = () => browser.place(el.getBoundingClientRect(), true);
    put();
    const watch = new ResizeObserver(put);
    watch.observe(el);
    window.addEventListener('resize', put);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', put);
      browser.place(null, false);
    };
  }, []);

  // "Harv is using the browser" stays a few seconds after its last action.
  useEffect(() => {
    if (busyUntil <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), busyUntil - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [busyUntil]);

  // A file of the user's (a mockup) reloads when it changes, like the preview pane.
  const file = page ? fileOfUrl(page.url) : null;
  useEffect(() => {
    if (!file) return;
    let last = 0;
    let live = true;
    const check = () =>
      void fileProps(file, true).then((p) => {
        if (!live || !p) return;
        if (last && p.modified !== last) void browser.reload();
        last = p.modified;
      });
    check();
    const timer = window.setInterval(check, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [file]);

  if (!inApp) {
    return (
      <p className="m-auto max-w-sm p-6 text-center text-muted">
        The browser works in the Harv app (it uses real web views the app places here).
      </p>
    );
  }

  const go = (text: string) => {
    if (!text.trim()) return;
    const url = toBrowserUrl(text);
    void (page ? browser.navigate(url, page.id) : browser.open(url)).catch(() => {});
    setDraft(null);
  };
  const tool = 'flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg text-sm hover:bg-white/10 disabled:opacity-30';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Page tabs */}
      <div className="flex min-w-0 items-center gap-1 border-b border-line px-2 pt-1.5">
        {pages.map((p) => (
          <div
            key={p.id}
            className={`flex max-w-[200px] min-w-[80px] flex-[0_1_200px] items-center rounded-t-lg border border-b-0 ${
              p.id === active ? 'border-[rgb(220_232_245/0.18)] bg-white/10' : 'border-transparent'
            }`}
          >
            <button
              type="button"
              onClick={() => void browser.select(p.id)}
              title={p.url}
              className={`min-w-0 flex-1 cursor-pointer truncate py-1.5 pl-2.5 text-left text-[11px] ${p.id === active ? 'text-ink' : 'text-muted'}`}
            >
              {p.loading ? '◌ ' : ''}
              {p.title || p.url || 'New page'}
            </button>
            <button
              type="button"
              onClick={() => void browser.close(p.id)}
              aria-label={`Close ${p.title || 'page'}`}
              className="size-6 flex-none cursor-pointer rounded text-[12px] text-muted hover:bg-white/10"
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" onClick={() => void browser.open(BROWSER_START)} aria-label="New page" title="New page" className={tool}>
          +
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button type="button" className={tool} disabled={!page} onClick={() => void browser.back()} aria-label="Back">
          ←
        </button>
        <button type="button" className={tool} disabled={!page} onClick={() => void browser.forward()} aria-label="Forward">
          →
        </button>
        <button type="button" className={tool} disabled={!page} onClick={() => void browser.reload()} aria-label="Reload">
          ⟳
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(draft ?? '');
          }}
        >
          <label htmlFor="browser-address" className="sr-only">
            Address
          </label>
          <input
            id="browser-address"
            value={draft ?? page?.url ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => e.key === 'Escape' && (setDraft(null), e.currentTarget.blur())}
            placeholder="Search Google, or type an address or a file path"
            className="min-h-8 w-full rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
          />
        </form>
        {busy && (
          <span
            className="animate-fade-in flex-none rounded-full border border-accent/50 px-2.5 py-1 text-[11px] text-accent"
            role="status"
          >
            Harv is using the browser
          </span>
        )}
      </div>

      {/* The app's web view sits exactly here. */}
      <div ref={area} className="relative min-h-0 flex-1 bg-black/20">
        {!pages.length && <p className="m-auto p-6 text-center text-muted">No page open. Press + or type an address.</p>}
      </div>
    </div>
  );
}
