import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatView, ToolKind } from '@harv/shared';
import { chat, useChat } from '../../lib/chatStore.ts';

export const TOOL_ICONS: Record<ChatView | 'settings', string> = { chat: '≡', terminal: '›_', files: '▤', settings: '⚙' };

/** A non-chat tab in the chat bar (Settings). */
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

const VIEWS: { view: ChatView; label: string }[] = [
  { view: 'chat', label: 'Chat' },
  { view: 'files', label: 'File Explorer' },
  { view: 'terminal', label: 'Terminal' },
];

/**
 * The small menu at the right of the chat bar: switches the active chat between
 * its log and its tools (file explorer, terminal). Each chat has its own.
 */
export function ViewMenu({ tabId }: { tabId: string }) {
  const { views, tools } = useChat();
  const view = views[tabId] ?? 'chat';
  const open = tools[tabId] ?? [];
  const [shown, setShown] = useState(false);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = VIEWS.find((v) => v.view === view)!;

  useEffect(() => {
    if (!shown) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))) return;
      setShown(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [shown]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={shown}
        title="Switch this chat to its file explorer or terminal"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ left: Math.max(8, Math.min(r.right - 210, window.innerWidth - 218)), top: r.bottom + 4 });
          setShown((o) => !o);
        }}
        className={`mb-1.5 flex min-h-7 flex-none cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] whitespace-nowrap hover:bg-white/10 ${
          shown ? 'bg-white/10 text-ink' : 'text-muted'
        }`}
      >
        <span aria-hidden="true" className="text-accent">
          {TOOL_ICONS[view]}
        </span>
        <span>{current.label.toLowerCase()}</span>
        <span aria-hidden="true" className="text-[9px]">
          ▾
        </span>
      </button>
      {shown &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label="Show in this chat"
            className="fixed z-40 flex w-[210px] flex-col gap-0.5 rounded-xl border border-[rgb(220_232_245/0.16)] bg-[rgb(16_24_34/0.94)] p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.4)] backdrop-blur-[22px]"
            style={{ left: at.left, top: at.top }}
          >
            {VIEWS.map((item) => {
              const running = item.view !== 'chat' && open.includes(item.view);
              return (
                <div key={item.view} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={view === item.view}
                    onClick={() => {
                      setShown(false);
                      chat.setView(tabId, item.view);
                    }}
                    className={`flex min-h-8 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-white/10 focus:bg-white/10 focus:outline-none ${
                      view === item.view ? 'text-ink' : 'text-muted'
                    }`}
                  >
                    <span aria-hidden="true" className="w-5 text-center text-accent">
                      {TOOL_ICONS[item.view]}
                    </span>
                    <span className="flex-1">{item.label}</span>
                    {running && <span aria-label="open" title="Open" className="size-1.5 rounded-full bg-accent/70" />}
                  </button>
                  {running && (
                    <button
                      type="button"
                      aria-label={`Close ${item.label}`}
                      title={`Close ${item.label}`}
                      onClick={() => chat.closeTool(tabId, item.view as ToolKind)}
                      className="size-7 flex-none cursor-pointer rounded-md text-[13px] text-muted hover:bg-white/10 hover:text-ink"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
