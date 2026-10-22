import { useState, type FormEvent } from 'react';

interface Tab {
  id: number;
  title: string;
}

interface Line {
  id: number;
  who: 'you' | 'harv';
  text: string;
}

export function ChatPanel() {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, title: 'New chat' }]);
  const [active, setActive] = useState(1);
  const [nextId, setNextId] = useState(2);
  const [lines, setLines] = useState<Record<number, Line[]>>({});
  const [draft, setDraft] = useState('');

  const newTab = () => {
    setTabs((t) => [...t, { id: nextId, title: 'New chat' }]);
    setActive(nextId);
    setNextId((n) => n + 1);
  };

  const closeTab = (id: number) => {
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (id === active) setActive(rest.at(-1)?.id ?? 0);
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !active) return;
    // Chat with Claude arrives in M2; until then Harv answers with a placeholder.
    setLines((all) => ({
      ...all,
      [active]: [
        ...(all[active] ?? []),
        { id: Date.now(), who: 'you', text },
        { id: Date.now() + 1, who: 'harv', text: 'Chat comes online in M2. The dashboard shell works.' },
      ],
    }));
    setDraft('');
  };

  const current = lines[active] ?? [];

  return (
    <section aria-label="Chat" className="glass flex min-w-0 flex-[999_1_520px] flex-col overflow-hidden rounded-2xl">
      <div role="tablist" aria-label="Open chats" className="flex items-end gap-1 overflow-x-auto border-b border-line px-2 pt-2">
        {tabs.map((t) => {
          const on = t.id === active;
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
                onClick={() => setActive(t.id)}
                className={`min-h-9 cursor-pointer truncate pr-1 pl-3 text-xs ${on ? 'text-ink' : 'text-muted'}`}
              >
                {t.title}
              </button>
              <button
                type="button"
                onClick={() => closeTab(t.id)}
                aria-label={`Close ${t.title}`}
                className="mr-1 size-7 cursor-pointer rounded-md text-[13px] text-muted hover:bg-white/10"
              >
                ×
              </button>
            </div>
          );
        })}
        <button type="button" onClick={newTab} aria-label="New chat" className="size-9 cursor-pointer text-base hover:text-accent">
          +
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4 leading-relaxed">
        {current.length === 0 ? (
          <p className="m-auto text-center text-muted">
            {active ? 'New chat. Ask Harv anything, or type /model, /attach.' : 'No chat open. Press + to start one.'}
          </p>
        ) : (
          current.map((l) => (
            <div key={l.id} className="animate-fade-in">
              <span className={l.who === 'you' ? 'text-accent' : 'text-ok'}>{l.who} ›</span> {l.text}
            </div>
          ))
        )}
      </div>

      <form onSubmit={send} className="flex items-center gap-2.5 border-t border-line py-2.5 pr-3 pl-5">
        <label htmlFor="harv-cmd" className="font-semibold text-accent">
          harv&gt;
        </label>
        <input
          id="harv-cmd"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="type a command or ask anything · /model · /attach"
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
        <button type="submit" className="min-h-11 cursor-pointer rounded-[10px] bg-accent px-4 text-xs font-semibold text-[#0f1620]">
          RUN ⏎
        </button>
      </form>
    </section>
  );
}
