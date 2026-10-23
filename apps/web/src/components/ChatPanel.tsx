import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Attachment } from '@harv/shared';
import { formatSize, uploadAttachment } from '../lib/attachments.ts';
import { chat, useChat, type Line } from '../lib/chatStore.ts';
import { useSafety } from '../lib/safetyStore.ts';
import { ActionBadge, ApprovalCard } from './ApprovalCard.tsx';

/** A file attached to the draft: uploading, ready to send, or failed. */
interface Pending {
  key: string;
  name: string;
  size: number;
  file?: Attachment;
  error?: string;
}

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

function ChatLine({ line, onHarder }: { line: Line; onHarder?: () => void }) {
  switch (line.kind) {
    case 'you':
      return (
        <div className="animate-fade-in whitespace-pre-wrap">
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
            <span className="text-ok">harv ›</span>
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
      return <div className="animate-fade-in text-muted">— {line.text}</div>;
    case 'error':
      return <div className="animate-fade-in text-warn">! {line.text}</div>;
  }
}

/** A tool call; non-green ones show their tier, status and Undo from the action log. */
function ToolLine({ line }: { line: Line }) {
  const { actions } = useSafety();
  const action = line.ref ? actions[line.ref] : undefined;
  return (
    <div className="animate-fade-in flex items-center gap-3 text-faint">
      <span className="min-w-0 truncate">&nbsp;&nbsp;▸ {line.text}</span>
      {action && action.tier !== 'green' && <ActionBadge action={action} />}
    </div>
  );
}

export function ChatPanel() {
  const { tabs, activeId } = useChat();
  const { approvals } = useSafety();
  const [draft, setDraft] = useState('');
  // Draft attachments per tab: each upload lands in that tab's folder on the server.
  const [pendingByTab, setPendingByTab] = useState<Record<string, Pending[]>>({});
  const [dragging, setDragging] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? null;
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

  const updatePending = (tabId: string, fn: (list: Pending[]) => Pending[]) =>
    setPendingByTab((all) => ({ ...all, [tabId]: fn(all[tabId] ?? []) }));

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
    if ((!text && ready.length === 0) || active?.busy || uploading) return;
    chat.send(text, ready);
    setDraft('');
    if (activeId) updatePending(activeId, () => []);
  };

  return (
    <section
      aria-label="Chat"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
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
              <button
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => chat.setActive(t.id)}
                className={`flex min-h-9 cursor-pointer items-center gap-1.5 truncate pr-1 pl-3 text-xs ${on ? 'text-ink' : 'text-muted'}`}
              >
                {t.busy && <span aria-hidden="true" className="animate-blink size-1.5 flex-none rounded-full bg-accent" />}
                <span className="truncate">{t.title}</span>
              </button>
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
        <button type="button" onClick={chat.newTab} aria-label="New chat" className="size-9 cursor-pointer text-base hover:text-accent">
          +
        </button>
      </div>

      <div ref={logRef} className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4 leading-relaxed">
        {!active || active.lines.length === 0 ? (
          <p className="m-auto text-center text-muted">{active ? 'New chat. Ask Harv anything.' : 'No chat open. Press + to start one.'}</p>
        ) : (
          active.lines.map((l) => (
            <ChatLine
              key={l.id}
              line={l}
              onHarder={!active.busy && l.id === lastReplyId ? () => chat.harder(active.id) : undefined}
            />
          ))
        )}
        {waiting.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-[rgb(10_16_24/0.7)] text-accent">
          drop files to attach
        </div>
      )}

      {pending.length > 0 && (
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
          placeholder="ask anything · read a file · search the web"
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
    </section>
  );
}
