import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatSize, uploadAttachment } from '../lib/attachments.ts';
import { lineTime, resetTime, tokens } from '../lib/format.ts';
import { HELP, parseCommand } from '../lib/commands.ts';
import { useCatalog, useSettings, useUsage } from '../lib/useHarvSocket.ts';
import { chat, getChatState, SETTINGS_TAB, startQuestions, useChat, type Line } from '../lib/chatStore.ts';
import { useSafety } from '../lib/safetyStore.ts';
import { ActionBadge, ApprovalCard } from './ApprovalCard.tsx';
import { SettingsView } from './SettingsView.tsx';
import { StartChoice } from './StartChoice.tsx';
import { StatusLine } from './StatusLine.tsx';
import { matchCommands, SlashMenu } from './SlashMenu.tsx';
import { SpecialTab, TOOL_ICONS, ViewMenu } from './tools/TabParts.tsx';
import { setDraftText, updatePending, useDrafts, useDraftTexts } from '../lib/drafts.ts';

// The terminal (xterm) and the explorer load when first opened, keeping the dashboard's first load small.
const TerminalView = lazy(() => import('./tools/TerminalView.tsx').then((m) => ({ default: m.TerminalView })));
const Explorer = lazy(() => import('./tools/explorer/Explorer.tsx').then((m) => ({ default: m.Explorer })));

function FileChip({ name, detail, onRemove }: { name: string; detail?: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-[rgb(220_232_245/0.2)] bg-white/5 py-0.5 pr-1 pl-2 text-[11px]">
      <span aria-hidden="true" className="text-accent">
        ▤
      </span>
      <span className="truncate text-ink">{name}</span>
      {detail && <span className="flex-none text-faint">{detail}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="size-6 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
        >
          ×
        </button>
      )}
    </span>
  );
}

function Thinking() {
  return (
    <span aria-label="Harv is thinking" className="inline-flex gap-1 text-accent">
      <span className="animate-blink">●</span>
      <span className="animate-blink [animation-delay:.2s]">●</span>
      <span className="animate-blink [animation-delay:.4s]">●</span>
    </span>
  );
}

function Time({ at }: { at: number }) {
  if (!useSettings().showTimes) return null;
  return (
    <time dateTime={new Date(at).toISOString()} className="mr-2 text-faint tabular-nums">
      {lineTime(at)}
    </time>
  );
}

function ChatLine({ line, onHarder }: { line: Line; onHarder?: () => void }) {
  const { showTimes, showTags } = useSettings();
  switch (line.kind) {
    case 'you':
      return (
        <div className="animate-fade-in rounded-md border-l-2 border-accent bg-accent/10 px-2.5 py-1.5 whitespace-pre-wrap text-white">
          <Time at={line.at} />
          <span className="text-accent">you ›</span> {line.text}
          {line.files && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {line.files.map((name, i) => (
                <FileChip key={i} name={name} />
              ))}
            </div>
          )}
        </div>
      );
    case 'harv':
      return (
        <div className="animate-fade-in">
          <div className="flex items-baseline gap-2">
            <Time at={line.at} />
            <span className={`text-ok ${showTimes ? '-ml-2' : ''}`}>harv ›</span>
            {line.tag && showTags && (
              <span title={line.reason} className="cursor-help text-[11px] text-faint">
                [{line.tag}]
              </span>
            )}
            {line.streaming && line.text === '' && <Thinking />}
            {onHarder && (
              <button
                type="button"
                onClick={onHarder}
                title="Run that again one step up (a stronger model or more effort)"
                className="cursor-pointer rounded px-1.5 text-[11px] text-muted hover:bg-white/10 hover:text-accent"
              >
                ↑ try harder
              </button>
            )}
          </div>
          {line.text && (
            <div className="harv-md mt-1">
              <Markdown remarkPlugins={[remarkGfm]}>{line.text}</Markdown>
            </div>
          )}
        </div>
      );
    case 'tool':
      return <ToolLine line={line} />;
    case 'notice':
      return (
        <div className="animate-fade-in text-muted">
          <Time at={line.at} />— {line.text}
        </div>
      );
    case 'error':
      return (
        <div className="animate-fade-in text-warn">
          <Time at={line.at} />! {line.text}
        </div>
      );
  }
}

/** A tool call; non-green ones show their tier, status and Undo from the action log. */
function ToolLine({ line }: { line: Line }) {
  const { actions } = useSafety();
  const action = line.ref ? actions[line.ref] : undefined;
  return (
    <div className="animate-fade-in flex items-center gap-3 text-faint">
      <span className="min-w-0 truncate">
        <Time at={line.at} />
        &nbsp;&nbsp;▸ {line.text}
      </span>
      {action && action.tier !== 'green' && <ActionBadge action={action} />}
    </div>
  );
}

export function ChatPanel() {
  const { tabs, activeId, settingsOpen, views } = useChat();
  const inSettings = activeId === SETTINGS_TAB;
  const { approvals } = useSafety();
  const usage = useUsage();
  const { density, sendKey } = useSettings();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingByTab = useDrafts();
  const draftTexts = useDraftTexts();
  const [dragging, setDragging] = useState(false);
  /** The tab whose name is being edited (right-click or F2 on it). */
  const [renaming, setRenaming] = useState<string | null>(null);
  // Tab being dragged, and where it would land (before or after `id`).
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const renameCancelled = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  /** The active chat's log, or one of its tools (the view menu). */
  const view = active ? (views[active.id] ?? 'chat') : 'chat';
  /** Settings or a tool is showing: no chat input or attachments. */
  const nonChat = inSettings || view !== 'chat';
  // Each chat keeps its own unsent text.
  const draft = (active && draftTexts[active.id]) || '';
  const setDraft = (text: string) => setDraftText(active?.id ?? chat.ensureTab(), text);
  const pending = (activeId && pendingByTab[activeId]) || [];
  const uploading = pending.some((p) => !p.file && !p.error);
  const waiting = approvals.filter((a) => a.tabId === activeId);
  // "Try harder" sits on the newest reply, once the tab is idle.
  const lastReplyId = active?.lines.findLast((l) => l.kind === 'harv' && l.tag)?.id;
  // Chats from before Harv started ask "continue or new session?" in their own tab (not while a turn runs in them).
  const asking = startQuestions.use();
  const askHere = !inSettings && view === 'chat' && active && !active.busy && asking.includes(active.id);
  // Typing "/" opens the command list (the dashboard's and Claude Code's); Esc closes it until the text changes.
  const catalog = useCatalog();
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosedAt, setMenuClosedAt] = useState<string | null>(null);
  const menuItems = nonChat || menuClosedAt === draft ? [] : matchCommands(draft, active?.commands ?? catalog?.commands ?? []);
  const menuAt = Math.min(menuIndex, Math.max(menuItems.length - 1, 0));
  const pickCommand = (name: string) => {
    setDraft(`/${name} `);
    setMenuIndex(0);
    inputRef.current?.focus();
  };

  // Esc is the stop hotkey: it halts the active tab and denies its waiting approvals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !active?.busy || view !== 'chat') return;
      // Esc that closes a menu, a dialog or a rename belongs to them.
      if (document.querySelector('[role="menu"], [role="dialog"]') || (e.target as HTMLElement).closest?.('[role="tablist"] input')) return;
      e.preventDefault();
      chat.stop(active.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active?.busy, active?.id, view]);

  const attach = (files: Iterable<File>) => {
    const tabId = chat.ensureTab();
    for (const file of files) {
      const key = crypto.randomUUID();
      updatePending(tabId, (list) => [...list, { key, name: file.name || 'pasted-image.png', size: file.size }]);
      uploadAttachment(tabId, file).then(
        (uploaded) => updatePending(tabId, (list) => list.map((p) => (p.key === key ? { ...p, file: uploaded } : p))),
        (err: Error) => updatePending(tabId, (list) => list.map((p) => (p.key === key ? { ...p, error: err.message } : p))),
      );
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) attach(e.dataTransfer.files);
  };

  // The active tab scrolls into view in the tab bar (by hand: scrollIntoView would also scroll the page).
  useEffect(() => {
    const bar = tabsRef.current;
    const tab = bar?.querySelector<HTMLElement>(`[data-tab="${activeId}"]`);
    if (!bar || !tab) return;
    const left = tab.offsetLeft - bar.offsetLeft;
    if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
    else if (left + tab.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left + tab.offsetWidth - bar.clientWidth + 8;
  }, [activeId, tabs.length]);

  // Keep the newest output in view while Harv streams.
  const lastText = active?.lines.at(-1)?.text;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.lines.length, lastText, activeId, waiting.length]);

  // The message box grows with what's typed (up to its max height).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
  }, [draft, nonChat]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    const ready = pending.flatMap((p) => (p.file ? [p.file] : []));
    const command = ready.length === 0 ? parseCommand(text) : null;
    if (command) {
      setDraft('');
      if (command.kind === 'attach') fileInputRef.current?.click();
      else if (command.kind === 'new') chat.newTab();
      else if (command.kind === 'help') chat.localNotice(HELP);
      else if (command.kind === 'error') chat.localNotice(command.message, 'error');
      else {
        if (command.model) chat.setModel(command.model);
        if (command.effort) chat.setEffort(command.effort);
        const { model, effort } = getChatState();
        chat.localNotice(model === 'auto' ? 'Model: AUTO (Harv picks model and effort).' : `Model: ${model} · ${effort}.`);
      }
      return;
    }
    // While Harv answers, a message waits its turn (queued on the server, shown above the input).
    if ((!text && ready.length === 0) || uploading) return;
    chat.send(text, ready);
    setDraft('');
    if (activeId) updatePending(activeId, () => []);
  };

  return (
    <section
      aria-label="Chat"
      onDragOver={(e) => {
        // The explorer takes its own drops (copying files into the folder).
        if (nonChat || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => !nonChat && onDrop(e)}
      className="glass relative flex h-[calc(var(--app-h)-140px)] min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl lg:h-auto lg:max-h-[calc(var(--app-h)-110px)] lg:min-h-0"
    >
      <div className="flex items-end gap-1 border-b border-line px-2 pt-2">
        {/* Tabs shrink like Chrome's, then scroll sideways (mouse wheel too); + and the view menu stay put. */}
        <div
          ref={tabsRef}
          role="tablist"
          aria-label="Open chats"
          onWheel={(e) => {
            if (e.deltaY && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) e.currentTarget.scrollLeft += e.deltaY;
          }}
          className="no-scrollbar flex min-w-0 flex-[0_1_auto] items-end gap-1 overflow-x-auto"
        >
          {tabs.map((t) => {
            const on = t.id === activeId;
            return (
              <div
                key={t.id}
                data-tab={t.id}
                draggable={renaming !== t.id}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-harv-tab', t.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDragTab(t.id);
                }}
                onDragEnd={() => {
                  setDragTab(null);
                  setDropAt(null);
                }}
                onDragOver={(e) => {
                  if (!dragTab || !e.dataTransfer.types.includes('application/x-harv-tab')) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  const after = e.clientX > r.left + r.width / 2;
                  if (dropAt?.id !== t.id || dropAt.after !== after) setDropAt({ id: t.id, after });
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('application/x-harv-tab');
                  if (!id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (dropAt) chat.moveTab(id, dropAt.id, dropAt.after);
                  setDragTab(null);
                  setDropAt(null);
                }}
                className={`animate-fade-in flex min-w-[84px] flex-[0_1_200px] items-center gap-0.5 rounded-t-[10px] border border-b-0 ${
                  on ? 'border-[rgb(220_232_245/0.18)] bg-white/10' : 'border-transparent'
                } ${dragTab === t.id ? 'opacity-40' : ''} ${
                  dragTab && dragTab !== t.id && dropAt?.id === t.id
                    ? dropAt.after
                      ? 'shadow-[2px_0_0_0_var(--color-accent)]'
                      : 'shadow-[-2px_0_0_0_var(--color-accent)]'
                    : ''
                }`}
              >
                {renaming === t.id ? (
                  <input
                    aria-label="Chat name"
                    autoFocus
                    defaultValue={t.title}
                    maxLength={60}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        renameCancelled.current = true;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      // Enter and clicking away save; Escape doesn't.
                      const name = e.target.value.trim();
                      if (!renameCancelled.current && name && name !== t.title) chat.rename(t.id, name);
                      renameCancelled.current = false;
                      setRenaming(null);
                    }}
                    className="my-1 ml-1.5 min-h-7 w-[150px] rounded-md border border-accent/60 bg-black/30 px-1.5 text-xs text-ink outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    title={`${t.title} · right-click to rename`}
                    onClick={() => chat.setActive(t.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setRenaming(t.id);
                    }}
                    onKeyDown={(e) => {
                      // F2 renames too, for the keyboard.
                      if (e.key === 'F2') setRenaming(t.id);
                    }}
                    className={`flex min-h-9 cursor-pointer items-center gap-1.5 truncate pr-1 pl-3 text-xs ${on ? 'text-ink' : 'text-muted'}`}
                  >
                    {t.busy && <span aria-hidden="true" className="animate-blink size-1.5 flex-none rounded-full bg-accent" />}
                    {!t.busy && asking.includes(t.id) && (
                      <span aria-hidden="true" title="Asks: continue or new session" className="flex-none text-accent">
                        ?
                      </span>
                    )}
                    {t.projectId && (
                      <span aria-hidden="true" title="Project chat" className="flex-none text-accent">
                        ▣
                      </span>
                    )}
                    {views[t.id] && views[t.id] !== 'chat' && (
                      <span aria-hidden="true" className="flex-none text-accent">
                        {TOOL_ICONS[views[t.id]!]}
                      </span>
                    )}
                    <span className="truncate">{t.title}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => chat.closeTab(t.id)}
                  aria-label={`Close ${t.title}`}
                  className="mr-1 size-7 cursor-pointer rounded-md text-[13px] text-muted hover:bg-white/10"
                >
                  ×
                </button>
              </div>
            );
          })}
          {settingsOpen && (
            <SpecialTab
              icon={TOOL_ICONS.settings}
              title="Settings"
              active={inSettings}
              onSelect={chat.openSettings}
              onClose={chat.closeSettings}
            />
          )}
        </div>
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={() => chat.newTab()}
          className="size-9 flex-none cursor-pointer text-base hover:text-accent"
        >
          +
        </button>
        <div className="flex-1" />
        {view === 'chat' && active?.context && (
          <div
            className="hidden px-2 pb-2.5 text-[11px] whitespace-nowrap text-muted xl:block"
            title="Tokens Harv sent with the last message in this chat"
          >
            context · {tokens(active.context)} tokens
          </div>
        )}
        {active && <ViewMenu tabId={active.id} />}
      </div>

      {/* Everything under the tab bar, so a chat's start question covers only this part. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {inSettings ? (
          <div className="flex flex-1 flex-col overflow-y-auto px-5 py-4">
            <SettingsView />
          </div>
        ) : active && view === 'terminal' ? (
          <Suspense fallback={<p className="m-auto text-muted">Starting the terminal…</p>}>
            <TerminalView key={active.id} chatId={active.id} />
          </Suspense>
        ) : active && view === 'files' ? (
          <Suspense fallback={<p className="m-auto text-muted">Opening the explorer…</p>}>
            <Explorer key={active.id} id={active.id} />
          </Suspense>
        ) : (
          <div
            ref={logRef}
            className={`flex flex-1 flex-col overflow-y-auto px-5 ${density === 'compact' ? 'gap-1.5 py-3 leading-normal' : 'gap-3.5 py-4 leading-relaxed'}`}
          >
            {!active || active.lines.length === 0 ? (
              <p className="m-auto text-center text-muted">
                {active ? 'New chat. Ask Harv anything.' : 'No chat open. Press + to start one.'}
              </p>
            ) : (
              active.lines.map((l) => (
                <ChatLine key={l.id} line={l} onHarder={!active.busy && l.id === lastReplyId ? () => chat.harder(active.id) : undefined} />
              ))
            )}
            {waiting.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-[rgb(10_16_24/0.7)] text-accent">
            drop files to attach
          </div>
        )}

        {!nonChat && active?.queued && active.queued.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-line px-5 pt-2 text-xs">
            {active.queued.map((q) => (
              <div key={q.id} className="flex min-w-0 items-center gap-2">
                <span className="flex-none text-faint">queued ›</span>
                <span className="min-w-0 flex-1 truncate text-muted">{q.text || q.files?.join(', ')}</span>
                <button
                  type="button"
                  onClick={() => chat.sendNow(active.id, q.id)}
                  title="Stop the current reply and send this now"
                  className="flex-none cursor-pointer rounded border border-accent/50 px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/15"
                >
                  send now
                </button>
                <button
                  type="button"
                  onClick={() => chat.unqueue(active.id, q.id)}
                  aria-label="Remove queued message"
                  title="Remove"
                  className="size-6 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
                >
                  ×
                </button>
              </div>
            ))}
            <p className="text-[11px] text-faint">Runs when Harv finishes · “send now” stops this reply and sends it right away</p>
          </div>
        )}

        {!nonChat && pending.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-line px-5 pt-2.5">
            {pending.map((p) => (
              <FileChip
                key={p.key}
                name={p.name}
                detail={p.error ? `! ${p.error}` : p.file ? formatSize(p.size) : 'uploading…'}
                onRemove={() => activeId && updatePending(activeId, (list) => list.filter((x) => x.key !== p.key))}
              />
            ))}
          </div>
        )}

        {!nonChat && usage?.pausedUntil && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 pt-2 text-xs text-warn">
            <span>
              Claude Pro limit reached: messages queue until {resetTime(usage.pausedUntil)}
              {usage.queued > 0 && ` (${usage.queued} waiting)`}.
            </span>
            {active && usage.queued > 0 && (
              <button
                type="button"
                onClick={() => chat.stop(active.id)}
                className="cursor-pointer rounded px-1.5 text-muted hover:bg-white/10 hover:text-ink"
              >
                cancel this tab’s queue
              </button>
            )}
          </div>
        )}

        {!nonChat && <StatusLine tab={active ?? undefined} />}

        {!nonChat && (
          <form onSubmit={send} className="relative flex items-end gap-2.5 pt-1 pr-3 pb-2.5 pl-5">
            {menuItems.length > 0 && <SlashMenu items={menuItems} index={menuAt} onPick={(c) => pickCommand(c.name)} />}
            <label htmlFor="harv-cmd" className="pb-3 leading-5 font-semibold text-accent">
              harv&gt;
            </label>
            <textarea
              ref={inputRef}
              id="harv-cmd"
              rows={1}
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (menuItems.length > 0 && !e.nativeEvent.isComposing) {
                  const typed = draft.slice(1).toLowerCase();
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMenuIndex((menuAt + (e.key === 'ArrowDown' ? 1 : menuItems.length - 1)) % menuItems.length);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuClosedAt(draft);
                    return;
                  }
                  // Tab, or Enter on a name not fully typed yet, completes it; Enter on a full name sends it.
                  if (e.key === 'Tab' || (e.key === 'Enter' && menuItems[menuAt]!.name.toLowerCase() !== typed)) {
                    e.preventDefault();
                    pickCommand(menuItems[menuAt]!.name);
                    return;
                  }
                }
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                // Settings › Chat: Enter sends (Shift+Enter = new line), or Ctrl+Enter sends (Enter = new line).
                const sends = sendKey === 'enter' ? !e.shiftKey : e.ctrlKey;
                if (!sends) return;
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }}
              onPaste={(e) => {
                // Pasted screenshots arrive as files.
                if (e.clipboardData.files.length === 0) return;
                e.preventDefault();
                attach(e.clipboardData.files);
              }}
              placeholder={active?.busy ? 'queue a message · it runs when Harv finishes' : 'ask anything · / for commands'}
              title={`${sendKey === 'enter' ? 'Enter sends, Shift+Enter' : 'Ctrl+Enter sends, Enter'} makes a new line. /help lists the commands.`}
              className="max-h-40 min-h-11 min-w-0 flex-1 resize-none overflow-y-hidden bg-transparent py-3 text-sm leading-5 outline-none placeholder:text-faint"
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) attach(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              title="Attach files (or drop them on the chat, or paste a screenshot)"
              className="min-h-11 cursor-pointer rounded-[10px] border border-[rgb(220_232_245/0.2)] bg-white/5 px-3.5 text-xs hover:bg-white/10"
            >
              +<span className="hidden sm:inline"> ATTACH</span>
            </button>
            {active?.busy ? (
              <button
                type="button"
                onClick={() => chat.stop(active.id)}
                title="Stop (Esc)"
                className="min-h-11 cursor-pointer rounded-[10px] bg-warn px-4 text-xs font-semibold text-[#0f1620]"
              >
                STOP ■
              </button>
            ) : (
              <button
                type="submit"
                disabled={uploading}
                className="min-h-11 cursor-pointer rounded-[10px] bg-accent px-4 text-xs font-semibold text-[#0f1620] disabled:cursor-wait disabled:opacity-60"
              >
                RUN ⏎
              </button>
            )}
          </form>
        )}
        {askHere && <StartChoice key={active.id} tabId={active.id} title={active.title} />}
      </div>
    </section>
  );
}
