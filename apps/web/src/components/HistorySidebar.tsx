import { useState } from 'react';

export function HistorySidebar() {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <nav aria-label="Chat history (collapsed)" className="glass flex w-12 flex-none flex-col items-center gap-3 rounded-2xl py-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Expand history"
          className="size-9 cursor-pointer rounded-lg text-sm hover:bg-white/5"
        >
          »
        </button>
        <span aria-hidden="true" className="text-[11px] tracking-[3px] text-muted [writing-mode:vertical-rl]">
          HISTORY
        </span>
      </nav>
    );
  }

  return (
    <nav aria-label="Chat history" className="glass flex w-full flex-col gap-2.5 rounded-2xl p-3 sm:w-[230px] sm:flex-none">
      <div className="flex items-center justify-between">
        <span className="text-[11px] tracking-[2px] text-muted">HISTORY</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Collapse history"
          className="size-8 cursor-pointer rounded-lg text-sm hover:bg-white/5"
        >
          «
        </button>
      </div>
      <label htmlFor="history-search" className="sr-only">
        Search chats
      </label>
      <input
        id="history-search"
        type="text"
        placeholder="search chats…"
        className="min-h-9 rounded-[9px] border border-line bg-black/20 px-2.5 text-xs outline-none placeholder:text-faint focus:border-accent/60"
      />
      <p className="px-2 pt-4 text-xs leading-relaxed text-faint">No chats yet. Saved chats will show up here.</p>
    </nav>
  );
}
