import { useEffect, useState, type MouseEvent } from 'react';
import { ModelSwitcher } from './ModelSwitcher.tsx';
import { Icon } from './tools/explorer/icons.tsx';
import { BROWSER_TAB, chat, SETTINGS_TAB, useChat } from '../lib/chatStore.ts';
import { desktop, inApp } from '../lib/desktop.ts';

/** In the app, empty parts of the header (and the page edge) move the window; a double click maximizes. */
export function dragWindow(e: MouseEvent) {
  if (!inApp || e.button !== 0 || (e.target as HTMLElement).closest('button, input, select, a, [role="menu"], [role="dialog"]')) return;
  desktop.window(e.detail === 2 ? 'maximize' : 'drag');
}

/** The app's window controls: thin, dim until hovered (× hides Harv to the tray). */
function WindowControls() {
  const button = 'grid size-7 cursor-pointer place-items-center rounded-md text-muted/70 hover:bg-white/5';
  return (
    <div className="-mr-1 flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => desktop.window('minimize')}
        className={`${button} hover:text-accent`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5.5h8" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Maximize"
        title="Maximize"
        onClick={() => desktop.window('maximize')}
        className={`${button} hover:text-accent`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Close to the tray"
        title="Close (Harv keeps running in the tray)"
        onClick={() => desktop.window('close')}
        className={`${button} hover:text-warn`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  );
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Harv's status lives above the command line now (StatusLine), like Claude Code's. */
export function Header() {
  const clock = useClock();
  const { activeId } = useChat();

  return (
    <header onMouseDown={dragWindow} className="glass flex flex-wrap items-center gap-4 rounded-2xl px-4 py-2.5 select-none">
      <div className="text-[15px] font-semibold tracking-wider text-accent">[HARV]</div>
      <div className="flex-1" />
      <ModelSwitcher />
      <div className="text-muted tabular-nums">{clock}</div>
      {inApp && (
        <button
          type="button"
          onClick={() => chat.openBrowser()}
          aria-label="Browser"
          aria-pressed={activeId === BROWSER_TAB}
          title="Browser (one for every chat; Harv can use it too)"
          className={`grid size-9 cursor-pointer place-items-center rounded-lg text-[17px] hover:bg-white/5 hover:text-ink ${activeId === BROWSER_TAB ? 'text-accent' : 'text-muted'}`}
        >
          ◍
        </button>
      )}
      <button
        type="button"
        onClick={chat.openSettings}
        aria-label="Settings"
        aria-pressed={activeId === SETTINGS_TAB}
        title="Settings (opens as a tab)"
        className={`grid size-9 cursor-pointer place-items-center rounded-lg hover:bg-white/5 hover:text-ink ${activeId === SETTINGS_TAB ? 'text-accent' : 'text-muted'}`}
      >
        <Icon name="gear" size={17} />
      </button>
      {inApp && <WindowControls />}
    </header>
  );
}
