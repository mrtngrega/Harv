import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatSize, uploadAttachment } from '../lib/attachments.ts';
import { lineTime, resetTime, tokens } from '../lib/format.ts';
import { HELP, parseCommand } from '../lib/commands.ts';
import { useUsage } from '../lib/useHarvSocket.ts';
import { chat, getChatState, SETTINGS_TAB, useChat, type Line } from '../lib/chatStore.ts';
import { useSafety } from '../lib/safetyStore.ts';
import { ActionBadge, ApprovalCard } from './ApprovalCard.tsx';
import { SettingsView } from './SettingsView.tsx';
import { Explorer } from './tools/explorer/Explorer.tsx';
import { SpecialTab, TOOL_ICONS, ViewMenu } from './tools/TabParts.tsx';
import { TerminalView } from './tools/TerminalView.tsx';
import { setDraftText, updatePending, useDrafts, useDraftTexts } from '../lib/drafts.ts';

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
  return (
    <time dateTime={new Date(at).toISOString()} className="mr-2 text-faint tabular-nums">
      {lineTime(at)}
    </time>
  );
}

function ChatLine({ line, onHarder }: { line: Line; onHarder?: () => void }) {
  switch (line.kind) {
    case 'you':
      return (
        <div className="animate-fade-in whitespace-pre-wrap">
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
            <span className="-ml-2 text-ok">harv ›</span>
            {line.tag && (
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
  const pendingByTab = useDrafts();
  const draftTexts = useDraftTexts();
  const [dragging, setDragging] = useState(false);
  /** The tab whose name is being edited (right-click or F2 on it). */
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameCancelled = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
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

  // Esc is the stop hotkey: it halts the active tab and denies its waiting approvals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !active?.busy) return;
      e.preventDefault();
      chat.stop(active.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active?.busy, active?.id]);

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

  // Keep the newest output in view while Harv streams.
  const lastText = active?.lines.at(-1)?.text;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.lines.length, lastText, activeId, waiting.length]);

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
    if ((!text && ready.length === 0) || active?.busy || uploading) return;
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
      className="glass relative flex max-h-[calc(100vh-110px)] min-w-0 flex-[999_1_520px] flex-col overflow-hidden rounded-2xl"
    >
      <div role="tablist" aria-label="Open chats" className="flex items-end gap-1 overflow-x-auto border-b border-line px-2 pt-2">
        {tabs.map((t) => {
          const on = t.id === activeId;
          return (
            <div
              key={t.id}
              className={`animate-fade-in flex max-w-[200px] items-center gap-0.5 rounded-t-[10px] border border-b-0 ${
                on ? 'border-[rgb(220_232_245/0.18)] bg-white/10' : 'border-transparent'
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
          <div className="px-2 pb-2.5 text-[11px] whitespace-nowrap text-muted" title="Tokens Harv sent with the last message in this chat">
            context · {tokens(active.context)} tokens
          </div>
        )}
        {active && <ViewMenu tabId={active.id} />}
      </div>

      {inSettings ? (
        <div className="flex flex-1 flex-col overflow-y-auto px-5 py-4">
          <SettingsView />
        </div>
      ) : active && view === 'terminal' ? (
        <TerminalView key={active.id} chatId={active.id} />
      ) : active && view === 'files' ? (
        <Explorer key={active.id} id={active.id} />
      ) : (
        <div ref={logRef} className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4 leading-relaxed">
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

      {!nonChat && (
        <form onSubmit={send} className="flex items-center gap-2.5 border-t border-line py-2.5 pr-3 pl-5">
          <label htmlFor="harv-cmd" className="font-semibold text-accent">
            harv&gt;
          </label>
          <input
            id="harv-cmd"
            type="text"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              // Pasted screenshots arrive as files.
              if (e.clipboardData.files.length === 0) return;
              e.preventDefault();
              attach(e.clipboardData.files);
            }}
            placeholder="type a command or ask anything · /model · /attach"
            className="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
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
            title="Attach files (or drop them on the chat, or paste a screenshot)"
            className="min-h-11 cursor-pointer rounded-[10px] border border-[rgb(220_232_245/0.2)] bg-white/5 px-3.5 text-xs hover:bg-white/10"
          >
            + ATTACH
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
    </section>
  );
}
