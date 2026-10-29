import { useEffect, useRef, useState } from 'react';
import { useProjects } from '../lib/useHarvSocket.ts';
import { HISTORY_QUERY_MAX, type HistoryItem, type Project } from '@harv/shared';
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

/**
 * One row per project (the user's wish): its chats stay out of the dated history.
 * Clicking it goes to the project's open tab, else its latest chat, else a new chat in it.
 */
function ProjectRow({ project, latest, active }: { project: Project; latest?: HistoryItem; active: boolean }) {
  const { tabs } = useChat();
  const open = () => {
    const tab = tabs.find((t) => t.projectId === project.id);
    if (tab) chat.setActive(tab.id);
    else if (latest) chat.openFromHistory(latest.id);
    else chat.setProject(chat.newTab(), project.id);
  };
  return (
    <button
      type="button"
      onClick={open}
      title={project.path}
      className={`flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs transition-colors hover:bg-white/5 ${active ? 'bg-white/10' : ''}`}
    >
      <span aria-hidden="true" className="flex-none text-accent/80">
        ▣
      </span>
      <span className="truncate">{project.name}</span>
    </button>
  );
}

/** `sheet`: the phone's slide-in (docs/PLAN.md §6q), always open, closed with `onClose`. */
export function HistorySidebar({ sheet = false, onClose }: { sheet?: boolean; onClose?: () => void } = {}) {
  // Starts collapsed (the user's wish); the ‹ › buttons match the stats panel's.
  const [opened, setOpened] = useState(false);
  const open = sheet || opened;
  const setOpen = (on: boolean) => (sheet ? !on && onClose?.() : setOpened(on));
  const { items, query } = useHistory();
  const { activeId, tabs } = useChat();
  const { list: projects } = useProjects();
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
      <nav aria-label="Chat history (collapsed)" className="glass flex w-full flex-none rounded-2xl px-2 py-2.5 lg:w-12 lg:px-1.5">
        {/* One button with the word in it, like the stats panel's LIVE button (the user's wish). */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Expand history"
          className="flex min-h-8 w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2 text-[11px] tracking-[2px] text-muted hover:bg-white/5 lg:flex-col lg:justify-start lg:px-0 lg:py-2"
        >
          <span className="lg:order-2 lg:[writing-mode:vertical-rl]">HISTORY</span>
          <span className="text-[15px] tracking-normal text-ink lg:order-1">›</span>
        </button>
      </nav>
    );
  }

  // Project chats live under their project's row, not in the dated list.
  const groups = groupByDay(items.filter((i) => !i.projectId));
  const latest = new Map<string, HistoryItem>();
  for (const item of items) if (item.projectId && !latest.has(item.projectId)) latest.set(item.projectId, item);
  const q = query.trim().toLowerCase();
  const shownProjects = projects
    .filter((p) => !q || latest.has(p.id) || p.name.toLowerCase().includes(q))
    .sort((a, b) => (latest.get(b.id)?.updatedAt ?? 0) - (latest.get(a.id)?.updatedAt ?? 0) || a.name.localeCompare(b.name));
  const activeProject = tabs.find((t) => t.id === activeId)?.projectId;

  return (
    <nav
      aria-label="Chat history"
      className={`glass flex w-full flex-col gap-2.5 rounded-2xl p-3 ${
        sheet ? 'h-full' : 'max-h-64 lg:max-h-[calc(var(--app-h)-110px)] lg:w-[230px] lg:flex-none'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Collapse history"
        className="flex min-h-8 w-full cursor-pointer items-center justify-between rounded-lg px-2 text-[11px] tracking-[2px] text-muted hover:bg-white/5"
      >
        <span>HISTORY</span>
        <span className="text-[15px] tracking-normal text-ink">‹</span>
      </button>
      <label htmlFor="history-search" className="sr-only">
        Search chats
      </label>
      <input
        id="history-search"
        type="search"
        maxLength={HISTORY_QUERY_MAX}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="search chats…"
        className="min-h-9 rounded-[9px] border border-line bg-black/20 px-2.5 text-xs outline-none placeholder:text-faint focus:border-accent/60"
      />
      <div className="-mx-1 flex flex-col gap-2 overflow-y-auto px-1">
        {shownProjects.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="px-2 pt-1 pb-0.5 text-[11px] text-muted">Projects</div>
            {shownProjects.map((p) => (
              <ProjectRow key={p.id} project={p} latest={latest.get(p.id)} active={p.id === activeProject} />
            ))}
          </div>
        )}
        {groups.length === 0
          ? !shownProjects.length && (
              <p className="px-2 pt-4 text-xs leading-relaxed text-faint">
                {query ? 'No chats match.' : 'No chats yet. Saved chats will show up here.'}
              </p>
            )
          : groups.map((g) => (
              <div key={g.label} className="flex flex-col gap-0.5">
                <div className="px-2 pt-1 pb-0.5 text-[11px] text-muted">{g.label}</div>
                {g.items.map((item) => (
                  <HistoryRow key={item.id} item={item} active={item.id === activeId} />
                ))}
              </div>
            ))}
      </div>
    </nav>
  );
}
