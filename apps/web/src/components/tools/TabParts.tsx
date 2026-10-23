import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ToolKind } from '@harv/shared';
import { chat } from '../../lib/chatStore.ts';

export const TOOL_ICONS: Record<ToolKind | 'settings', string> = { terminal: '›_', files: '▤', settings: '⚙' };

/** A non-chat tab in the chat bar (terminal, files, settings). */
export function SpecialTab({
  icon,
  title,
  active,
  onSelect,
  onClose,
}: {
  icon: string;
  title: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={`animate-fade-in flex max-w-[200px] items-center gap-0.5 rounded-t-[10px] border border-b-0 ${
        active ? 'border-[rgb(220_232_245/0.18)] bg-white/10' : 'border-transparent'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        className={`flex min-h-9 cursor-pointer items-center gap-1.5 truncate pr-1 pl-3 text-xs whitespace-nowrap ${active ? 'text-ink' : 'text-muted'}`}
      >
        <span aria-hidden="true" className="text-accent">
          {icon}
        </span>
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title}`}
        className="mr-1 size-7 flex-none cursor-pointer rounded-md text-[13px] text-muted hover:bg-white/10"
      >
        ×
      </button>
    </div>
  );
}

const ITEMS: { label: string; icon: string; hint: string; run: () => void }[] = [
  { label: 'New chat', icon: '+', hint: 'Ctrl+click + for this directly', run: () => chat.newTab() },
  { label: 'Terminal', icon: TOOL_ICONS.terminal, hint: 'PowerShell', run: () => chat.openTool('terminal') },
  { label: 'File Explorer', icon: TOOL_ICONS.files, hint: 'File Explorer', run: () => chat.openTool('files') },
];

/** The + at the end of the chat bar: a new chat, a terminal or the file explorer. */
export function NewTabMenu() {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={open}
        title="New chat, terminal or file explorer"
        onClick={(e) => {
          if (e.ctrlKey) return chat.newTab();
          const r = e.currentTarget.getBoundingClientRect();
          // The tab bar scrolls sideways, so the menu is placed on the page, not inside it.
          setAt({ left: Math.min(r.left, window.innerWidth - 230), top: r.bottom + 4 });
          setOpen((o) => !o);
        }}
        className="size-9 flex-none cursor-pointer text-base hover:text-accent"
      >
        +
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label="New tab"
            className="fixed z-40 flex w-[220px] flex-col gap-0.5 rounded-xl border border-[rgb(220_232_245/0.16)] bg-[rgb(16_24_34/0.94)] p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.4)] backdrop-blur-[22px]"
            style={{ left: at.left, top: at.top }}
          >
            {ITEMS.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-white/10 focus:bg-white/10 focus:outline-none"
              >
                <span aria-hidden="true" className="w-5 text-center text-accent">
                  {item.icon}
                </span>
                <span className="flex flex-col">
                  <span className="text-ink">{item.label}</span>
                  <span className="text-[11px] text-faint">{item.hint}</span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
