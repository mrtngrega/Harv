import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ChatView, ToolKind } from '@harv/shared';
import { chat, useChat } from '../../lib/chatStore.ts';
import { browser } from '../../lib/browser.ts';
import { inApp } from '../../lib/desktop.ts';
import { useProjects } from '../../lib/useHarvSocket.ts';
import { Icon } from './explorer/icons.tsx';

export const TOOL_ICONS: Record<ChatView | 'settings' | 'browser', ReactNode> = {
  chat: '≡',
  terminal: '›_',
  files: '▤',
  settings: <Icon name="gear" size={12} />,
  browser: '◍',
};

/** A non-chat tab in the chat bar (Settings, the Browser). */
export function SpecialTab({
  id,
  icon,
  title,
  active,
  onSelect,
  onClose,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-tab={id}
      className={`animate-fade-in flex flex-none items-center gap-0.5 rounded-t-[10px] border border-b-0 ${
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
        <span aria-hidden="true" className="flex text-accent">
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
  // One browser for every chat (docs/PLAN.md §6x), only in the app (it's the app's own web views).
  ...(inApp ? [{ view: 'browser' as const, label: 'Browser' }] : []),
];

/**
 * The small menu at the right of the chat bar: switches the active chat between
 * its log and its tools (file explorer, terminal). Each chat has its own.
 */
export function ViewMenu({ tabId }: { tabId: string }) {
  const { views, tools, tabs } = useChat();
  const { list: projects } = useProjects();
  const projectId = tabs.find((t) => t.id === tabId)?.projectId;
  const project = projects.find((p) => p.id === projectId);
  const view = views[tabId] ?? 'chat';
  const open = tools[tabId] ?? [];
  const [shown, setShown] = useState(false);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = VIEWS.find((v) => v.view === view)!;

  // The browser's pages are windows of their own: they step aside while the menu is open over them.
  useEffect(() => {
    if (!shown) return;
    browser.cover(true);
    return () => browser.cover(false);
  }, [shown]);

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
        title="Switch this chat to its file explorer, terminal or the browser"
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
        {project && <span className="max-w-28 truncate text-accent">{project.name} ·</span>}
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
            className="fixed z-40 flex max-h-[70vh] w-[230px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-[rgb(220_232_245/0.16)] bg-[rgb(16_24_34/0.94)] p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.4)] backdrop-blur-[22px]"
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
            <div className="mx-1 my-1 border-t border-line" />
            <div
              className="px-2.5 pt-0.5 pb-1 text-[11px] text-faint"
              title="In a project, Harv works like Claude Code in that folder, with its CLAUDE.md and memory"
            >
              Project
            </div>
            {[{ id: null as string | null, name: 'None (assistant)' }, ...projects].map((p) => (
              <button
                key={p.id ?? 'none'}
                type="button"
                role="menuitemradio"
                aria-checked={(projectId ?? null) === p.id}
                title={'path' in p ? String(p.path) : 'A normal Harv chat'}
                onClick={() => {
                  setShown(false);
                  chat.setProject(tabId, p.id);
                }}
                className={`flex min-h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-white/10 focus:bg-white/10 focus:outline-none ${
                  (projectId ?? null) === p.id ? 'text-ink' : 'text-muted'
                }`}
              >
                <span aria-hidden="true" className="w-5 text-center text-accent">
                  {(projectId ?? null) === p.id ? '●' : p.id ? '▣' : '○'}
                </span>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </button>
            ))}
            {projects.length === 0 && (
              <p className="m-0 px-2.5 pb-1 text-[11px] text-faint">
                Tell Harv "we're starting a new project", or add folders in Settings.
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
