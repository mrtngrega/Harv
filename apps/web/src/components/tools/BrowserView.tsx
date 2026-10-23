import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { BrowserInput, BrowserState } from '@harv/shared';
import { onServerMessage, sendMessage } from '../../lib/socket.ts';
import { selectAll } from './FilesView.tsx';

/** Last known page per tab, so switching back shows it at once. */
const lastState = new Map<string, BrowserState>();
const lastFrame = new Map<string, string>();

const BUTTONS = ['left', 'middle', 'right'] as const;
/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

/**
 * The browser tab: a live picture of the real Chrome page on the server, with the
 * user's mouse and keyboard passed through. Harv's browser tools drive the same page.
 */
export function BrowserView({ id }: { id: string }) {
  const [state, setState] = useState<BrowserState | null>(() => lastState.get(id) ?? null);
  const [address, setAddress] = useState(() => lastState.get(id)?.url ?? '');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(() => lastFrame.has(id));
  const screen = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const frameSize = useRef({ width: 1280, height: 800 });
  const lastMove = useRef(0);

  const send = (input: BrowserInput) => sendMessage({ type: 'browser.input', id, input });

  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    let timer = 0;
    const resize = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width > 50 && r.height > 50) sendMessage({ type: 'browser.resize', id, width: r.width, height: r.height });
      }, 150);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    const off = onServerMessage((msg) => {
      if (msg.type === 'browser.frame' && msg.id === id) {
        frameSize.current = { width: msg.width, height: msg.height };
        const src = `data:image/jpeg;base64,${msg.data}`;
        lastFrame.set(id, src);
        // Straight to the <img>, not through React state: frames arrive many times a second.
        if (img.current) img.current.src = src;
        setHasFrame(true);
      } else if (msg.type === 'browser.state' && msg.id === id) {
        lastState.set(id, msg.state);
        setState(msg.state);
        setError(null);
      } else if (msg.type === 'browser.error' && msg.id === id) {
        setError(msg.message);
      } else if (msg.type === 'hello') {
        sendMessage({ type: 'browser.watch', id, on: true });
        resize();
      }
    });
    sendMessage({ type: 'browser.watch', id, on: true });
    resize();
    if (img.current && lastFrame.has(id)) img.current.src = lastFrame.get(id)!;

    // The wheel has to be a non-passive listener to stop the dashboard from scrolling instead.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = point(e.clientX, e.clientY);
      send({ kind: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: mods(e) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      off();
      observer.disconnect();
      clearTimeout(timer);
      el.removeEventListener('wheel', onWheel);
      sendMessage({ type: 'browser.watch', id, on: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** Dashboard pixels → page pixels. */
  function point(clientX: number, clientY: number) {
    const r = img.current?.getBoundingClientRect() ?? screen.current!.getBoundingClientRect();
    const { width, height } = frameSize.current;
    return {
      x: Math.round(((clientX - r.left) / Math.max(1, r.width)) * width),
      y: Math.round(((clientY - r.top) / Math.max(1, r.height)) * height),
    };
  }

  const mouse = (e: ReactMouseEvent, type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => {
    if (type === 'mouseMoved') {
      // About 30 moves a second is plenty for hovers and drags.
      const now = performance.now();
      if (now - lastMove.current < 33) return;
      lastMove.current = now;
    }
    if (type === 'mousePressed') screen.current?.focus();
    const button = type === 'mouseMoved' ? (e.buttons & 1 ? 'left' : 'none') : (BUTTONS[e.button] ?? 'left');
    send({
      kind: 'mouse',
      type,
      ...point(e.clientX, e.clientY),
      button,
      clickCount: type === 'mouseMoved' ? 0 : Math.max(1, e.detail),
      modifiers: mods(e),
    });
  };

  const key = (e: KeyboardEvent, type: 'keyDown' | 'keyUp') => {
    // Ctrl+V pastes the dashboard's clipboard through the paste event below.
    if (e.ctrlKey && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    send({
      kind: 'key',
      type,
      key: e.key,
      code: e.code,
      text: e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : undefined,
      keyCode: e.keyCode,
      modifiers: mods(e),
    });
  };

  const navButton = 'size-8 flex-none cursor-pointer rounded-lg text-sm hover:bg-white/10 disabled:cursor-default disabled:opacity-30';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <button
          type="button"
          className={navButton}
          disabled={!state?.canGoBack}
          onClick={() => sendMessage({ type: 'browser.nav', id, action: 'back' })}
          aria-label="Back"
        >
          ←
        </button>
        <button
          type="button"
          className={navButton}
          disabled={!state?.canGoForward}
          onClick={() => sendMessage({ type: 'browser.nav', id, action: 'forward' })}
          aria-label="Forward"
        >
          →
        </button>
        <button
          type="button"
          className={navButton}
          onClick={() => sendMessage({ type: 'browser.nav', id, action: state?.loading ? 'stop' : 'reload' })}
          aria-label={state?.loading ? 'Stop loading' : 'Reload'}
        >
          {state?.loading ? '×' : '⟳'}
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!address.trim()) return;
            sendMessage({ type: 'browser.navigate', id, url: address });
            setEditing(false);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <label htmlFor={`addr-${id}`} className="sr-only">
            Address
          </label>
          <input
            id={`addr-${id}`}
            value={editing ? address : (state?.url ?? address)}
            placeholder="search or type a web address"
            onFocus={(e) => {
              setAddress(state?.url ?? address);
              setEditing(true);
              selectAll(e.target);
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            className="min-h-8 w-full rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
          />
        </form>
        {state?.harvActive && (
          <span className="animate-fade-in flex flex-none items-center gap-1.5 rounded-full border border-accent/40 px-2 py-1 text-[11px] text-accent">
            <span className="animate-blink size-1.5 rounded-full bg-accent" /> Harv is browsing
          </span>
        )}
        <button
          type="button"
          className="min-h-8 flex-none cursor-pointer rounded-lg px-2 text-[11px] text-muted hover:bg-white/10 hover:text-ink"
          title="Open this page in your own Chrome window (your normal profile)"
          onClick={() =>
            state?.url &&
            void fetch('/api/browser/external', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: state.url }),
            })
          }
        >
          open in Chrome ↗
        </button>
      </div>
      {error && <p className="m-0 border-b border-line px-3 py-1.5 text-xs text-warn">! {error}</p>}

      <div
        ref={screen}
        tabIndex={0}
        role="application"
        aria-label={`Web page: ${state?.title ?? 'loading'}`}
        className="relative min-h-0 flex-1 cursor-default overflow-hidden bg-white/5 outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        onMouseDown={(e) => mouse(e, 'mousePressed')}
        onMouseUp={(e) => mouse(e, 'mouseReleased')}
        onMouseMove={(e) => mouse(e, 'mouseMoved')}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => key(e, 'keyDown')}
        onKeyUp={(e) => key(e, 'keyUp')}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (text) send({ kind: 'text', text });
        }}
      >
        <img ref={img} alt="" draggable={false} className={`block h-full w-full object-fill select-none ${hasFrame ? '' : 'hidden'}`} />
        {!hasFrame && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
            {error ? 'The browser couldn’t start.' : 'Starting Chrome…'}
          </div>
        )}
      </div>
    </div>
  );
}
