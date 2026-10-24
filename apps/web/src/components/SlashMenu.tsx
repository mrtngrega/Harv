import { useEffect, useRef } from 'react';
import type { SlashCommandInfo } from '@harv/shared';

/** The dashboard's own commands (lib/commands.ts), listed with Claude Code's. */
export const DASHBOARD_COMMANDS: SlashCommandInfo[] = [
  { name: 'model', argumentHint: 'auto|opus|sonnet|haiku|fable [effort]', description: 'Switch the model and effort (Harv)' },
  { name: 'attach', argumentHint: '', description: 'Add files to the message (Harv)' },
  { name: 'new', argumentHint: '', description: 'Open a new chat tab (Harv)' },
  { name: 'help', argumentHint: '', description: 'Show Harv’s commands (Harv)' },
];

/** The commands matching what's typed after "/": names that start with it first, then names that contain it. */
export function matchCommands(draft: string, commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const typed = /^\/([\w:.-]*)$/.exec(draft)?.[1]?.toLowerCase();
  if (typed === undefined) return [];
  const seen = new Set<string>();
  const all = [...DASHBOARD_COMMANDS, ...commands].filter((c) => !seen.has(c.name) && seen.add(c.name));
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(typed));
  const contains = all.filter((c) => !c.name.toLowerCase().startsWith(typed) && c.name.toLowerCase().includes(typed));
  return [...starts, ...contains];
}

/** The list that opens above the command line while a "/command" is being typed, like Claude Code's. */
export function SlashMenu({ items, index, onPick }: { items: SlashCommandInfo[]; index: number; onPick: (c: SlashCommandInfo) => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  // Keep the highlighted row in view (by hand: scrollIntoView could scroll the page).
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[index] as HTMLElement | undefined;
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [index]);

  // A solid panel, not glass: a backdrop blur inside the glass chat panel shows nothing behind it.
  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Commands"
      className="absolute right-3 bottom-full left-3 z-30 mb-1 max-h-64 overflow-y-auto rounded-xl border border-[rgb(220_232_245/0.18)] bg-[rgb(16_24_34/0.96)] py-1 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)]"
    >
      {items.map((c, i) => (
        <li
          key={c.name}
          role="option"
          aria-selected={i === index}
          // mousedown, so the textarea keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          className={`flex min-w-0 cursor-pointer items-baseline gap-3 px-3 py-1.5 ${i === index ? 'bg-white/10' : 'hover:bg-white/5'}`}
        >
          <span className="flex-none text-accent">/{c.name}</span>
          {c.argumentHint && c.argumentHint.length <= 32 && <span className="hidden flex-none text-faint sm:inline">{c.argumentHint}</span>}
          <span className="min-w-0 truncate text-muted">{c.description}</span>
        </li>
      ))}
    </ul>
  );
}
