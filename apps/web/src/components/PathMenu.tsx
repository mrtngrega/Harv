import { useEffect, useRef, useState } from 'react';
import type { PathSuggestion } from '@harv/shared';
import { formatSize } from '../lib/attachments.ts';

/**
 * The `@path` being typed at the end of the command line (like Claude Code's): what follows the
 * last `@` that starts a word, up to the end. Spaces are allowed (`@C:\My files\Co`), new lines
 * aren't. Null when there's none.
 */
export function atToken(draft: string): { start: number; query: string } | null {
  const m = /(^|\s)@([^\n@]*)$/.exec(draft);
  if (!m || m[2]!.length > 260) return null;
  return { start: m.index + m[1]!.length, query: m[2]! };
}

/** A folder's path ready to type inside it (`C:\Users\me` → `C:\Users\me\`, `/home/me` → `/home/me/`). */
export function insideFolder(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  return path.endsWith(sep) ? path : path + sep;
}

/** The draft with the `@path` taken out (it becomes a chip instead). */
export const withoutToken = (draft: string, start: number) => draft.slice(0, start).replace(/[ \t]+$/, start > 0 ? ' ' : '');

/** Suggestions for what's typed after `@`, from the server's disk (GET /api/paths), a moment after typing stops. */
export function usePathSuggestions(query: string | null): PathSuggestion[] {
  // Each answer is kept with the query it answers, so an older one never shows for newer typing.
  const [answer, setAnswer] = useState<{ query: string; items: PathSuggestion[] }>({ query: '', items: [] });
  useEffect(() => {
    if (query === null) return;
    let live = true;
    const timer = setTimeout(() => {
      fetch(`/api/paths?q=${encodeURIComponent(query)}`)
        .then((r) => (r.ok ? (r.json() as Promise<PathSuggestion[]>) : []))
        .then((items) => live && setAnswer({ query, items }))
        .catch(() => live && setAnswer({ query, items: [] }));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  return query !== null && answer.query === query ? answer.items : [];
}

/** The list above the command line while an `@path` is typed: Enter attaches, Tab walks into a folder. */
export function PathMenu({ items, index, onPick }: { items: PathSuggestion[]; index: number; onPick: (s: PathSuggestion) => void }) {
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
      aria-label="Files and folders"
      className="absolute right-3 bottom-full left-3 z-30 mb-1 max-h-64 overflow-y-auto rounded-xl border border-[rgb(220_232_245/0.18)] bg-[rgb(16_24_34/0.96)] py-1 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)]"
    >
      {items.map((s, i) => (
        <li
          key={s.path}
          role="option"
          aria-selected={i === index}
          title={s.path}
          // mousedown, so the textarea keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s);
          }}
          className={`flex min-w-0 cursor-pointer items-baseline gap-3 px-3 py-1.5 ${i === index ? 'bg-white/10' : 'hover:bg-white/5'}`}
        >
          <span aria-hidden="true" className="w-3 flex-none text-accent">
            {s.folder ? '▸' : '·'}
          </span>
          <span className="min-w-0 truncate text-ink">
            {s.name}
            {s.folder && s.name !== s.path ? '/' : ''}
          </span>
          <span className="ml-auto flex-none text-faint">{s.folder ? 'folder' : formatSize(s.size)}</span>
        </li>
      ))}
      <li aria-hidden="true" className="px-3 pt-1 text-[11px] text-faint">
        Enter attaches it by path (nothing is copied) · Tab opens a folder · Esc closes
      </li>
    </ul>
  );
}
