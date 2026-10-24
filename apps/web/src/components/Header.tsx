import { useEffect, useState } from 'react';
import { ModelSwitcher } from './ModelSwitcher.tsx';
import { Icon } from './tools/explorer/icons.tsx';
import { chat, SETTINGS_TAB, useChat } from '../lib/chatStore.ts';

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
    <header className="glass flex flex-wrap items-center gap-4 rounded-2xl px-4 py-2.5">
      <div className="text-[15px] font-semibold tracking-wider text-accent">[HARV]</div>
      <div className="flex-1" />
      <ModelSwitcher />
      <div className="text-muted tabular-nums">{clock}</div>
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
    </header>
  );
}
