import { useEffect, useRef, useState, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { chat, useChat, type Line } from '../lib/chatStore.ts';

function Thinking() {
  return (
    <span aria-label="Harv is thinking" className="inline-flex gap-1 text-accent">
      <span className="animate-blink">●</span>
      <span className="animate-blink [animation-delay:.2s]">●</span>
      <span className="animate-blink [animation-delay:.4s]">●</span>
    </span>
  );
}

function ChatLine({ line }: { line: Line }) {
  switch (line.kind) {
    case 'you':
      return (
        <div className="animate-fade-in whitespace-pre-wrap">
          <span className="text-accent">you ›</span> {line.text}
        </div>
      );
    case 'harv':
      return (
        <div className="animate-fade-in">
          <div className="flex items-baseline gap-2">
            <span className="text-ok">harv ›</span>
            {line.tag && <span className="text-[11px] text-faint">[{line.tag}]</span>}
            {line.streaming && line.text === '' && <Thinking />}
          </div>
          {line.text && (
            <div className="harv-md mt-1">
              <Markdown remarkPlugins={[remarkGfm]}>{line.text}</Markdown>
            </div>
          )}
        </div>
      );
    case 'tool':
      return <div className="animate-fade-in truncate text-faint">&nbsp;&nbsp;▸ {line.text}</div>;
    case 'notice':
      return <div className="animate-fade-in text-muted">— {line.text}</div>;
    case 'error':
      return <div className="animate-fade-in text-warn">! {line.text}</div>;
  }
}

export function ChatPanel() {
  const { tabs, activeId } = useChat();
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? null;

  // Keep the newest output in view while Harv streams.
  const lastText = active?.lines.at(-1)?.text;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.lines.length, lastText, activeId]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || active?.busy) return;
    chat.send(text);
    setDraft('');
  };

  return (
    <section
      aria-label="Chat"
      className="glass flex max-h-[calc(100vh-110px)] min-w-0 flex-[999_1_520px] flex-col overflow-hidden rounded-2xl"
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
          active.lines.map((l) => <ChatLine key={l.id} line={l} />)
        )}
      </div>

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
          placeholder="ask anything · read a file · search the web"
          className="min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
        <button
          type="button"
          disabled
          title="File attachments arrive in M4"
          className="min-h-11 cursor-not-allowed rounded-[10px] border border-[rgb(220_232_245/0.2)] bg-white/5 px-3.5 text-xs opacity-60"
        >
          + ATTACH
        </button>
        {active?.busy ? (
          <button
            type="button"
            onClick={() => chat.stop(active.id)}
            className="min-h-11 cursor-pointer rounded-[10px] bg-warn px-4 text-xs font-semibold text-[#0f1620]"
          >
            STOP ■
          </button>
        ) : (
          <button type="submit" className="min-h-11 cursor-pointer rounded-[10px] bg-accent px-4 text-xs font-semibold text-[#0f1620]">
            RUN ⏎
          </button>
        )}
      </form>
    </section>
  );
}
