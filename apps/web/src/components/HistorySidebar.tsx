import { useEffect, useRef, useState } from 'react';
import { useProjects } from '../lib/useHarvSocket.ts';
import type { HistoryItem } from '@harv/shared';
import { chat, useChat, useHistory } from '../lib/chatStore.ts';

const DAY = 86_400_000;

/** Today / Yesterday / This week / Older, by the chat's last activity. */
function groupByDay(items: HistoryItem[], now = new Date()): { label: string; items: HistoryItem[] }[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: { label: string; from: number; items: HistoryItem[] }[] = [
    { label: 'Today', from: startOfToday, items: [] },
    { label: 'Yesterday', from: startOfToday - DAY, items: [] },
    { label: 'This week', from: startOfToday - 6 * DAY, items: [] },
    { label: 'Older', from: -Infinity, items: [] },
  ];
  for (const item of items) buckets.find((b) => item.updatedAt >= b.from)!.items.push(item);
  return buckets.filter((b) => b.items.length > 0);
}

function HistoryRow({ item, active }: { item: HistoryItem; active: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const { list } = useProjects();
  const project = list.find((p) => p.id === item.projectId)?.name;

  if (confirming) {
    return (
      <div className="flex min-h-9 items-center gap-2 rounded-lg bg-black/25 px-2 text-xs">
        <span className="flex-1 truncate text-muted">Delete for good?</span>
        <button
          type="button"
          onClick={() => chat.deleteChat(item.id)}
          className="cursor-pointer rounded-md px-2 py-1 text-warn hover:bg-white/10"
        >
          yes
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="cursor-pointer rounded-md px-2 py-1 hover:bg-white/10">
          no
        </button>
      </div>
    );
  }

  return (
    <div className={`group flex items-center rounded-lg transition-colors hover:bg-white/5 ${active ? 'bg-white/10' : ''}`}>
      <button
        type="button"
        onClick={() => chat.openFromHistory(item.id)}
        title={item.title}
        className="flex min-h-9 min-w-0 flex-1 cursor-pointer flex-col justify-center px-2 py-1 text-left text-xs"
      >
        <span className="flex w-full items-center gap-1.5">
          {item.open && <span aria-label="open" className="size-1.5 flex-none rounded-full bg-accent/70" />}
          <span className="truncate">{item.title}</span>
        </span>
        {project && <span className="w-full truncate text-[11px] text-accent/80">▣ {project}</span>}
        {item.snippet && <span className="w-full truncate text-[11px] text-faint">{item.snippet}</span>}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${item.title}`}
        className="mr-1 size-7 flex-none cursor-pointer rounded-md text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-white/10"
      >
        ×
      </button>
    </div>
  );
}

export function HistorySidebar() {
  // Starts collapsed (the user's wish); the ‹ › buttons match the stats panel's.
  const [open, setOpen] = useState(false);
  const { items, query } = useHistory();
  const { activeId } = useChat();
  const [draft, setDraft] = useState(query);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    clearTimeout(timer.current);
    if (draft !== query) timer.current = setTimeout(() => chat.searchHistory(draft), 250);
    return () => clearTimeout(timer.current);
  }, [draft, query]);

  if (!open) {
    return (
      <nav
        aria-label="Chat history (collapsed)"
        className="glass flex w-full flex-none flex-row items-center gap-3 rounded-2xl px-2 py-2 lg:w-12 lg:flex-col lg:px-0"
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Expand history"
          className="size-8 cursor-pointer rounded-lg text-[15px] text-ink hover:bg-white/5"
        >
          ›
        </button>
        <span aria-hidden="true" className="text-[11px] tracking-[3px] text-muted [writing-mode:vertical-rl]">
          HISTORY
        </span>
      </nav>
    );
  }

  const groups = groupByDay(items);

  return (
    <nav
      aria-label="Chat history"
      className="glass flex max-h-64 w-full flex-col gap-2.5 rounded-2xl p-3 lg:max-h-[calc(var(--app-h)-110px)] lg:w-[230px] lg:flex-none"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] tracking-[2px] text-muted">HISTORY</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Collapse history"
          className="size-8 cursor-pointer rounded-lg text-[15px] hover:bg-white/5"
        >
          ‹
        </button>
      </div>
      <label htmlFor="history-search" className="sr-only">
        Search chats
      </label>
      <input
        id="history-search"
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="search chats…"
        className="min-h-9 rounded-[9px] border border-line bg-black/20 px-2.5 text-xs outline-none placeholder:text-faint focus:border-accent/60"
      />
      <div className="-mx-1 flex flex-col gap-2 overflow-y-auto px-1">
        {groups.length === 0 ? (
          <p className="px-2 pt-4 text-xs leading-relaxed text-faint">
            {query ? 'No chats match.' : 'No chats yet. Saved chats will show up here.'}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-0.5">
              <div className="px-2 pt-1 pb-0.5 text-[11px] text-muted">{g.label}</div>
              {g.items.map((item) => (
                <HistoryRow key={item.id} item={item} active={item.id === activeId} />
              ))}
            </div>
          ))
        )}
      </div>
    </nav>
  );
}
