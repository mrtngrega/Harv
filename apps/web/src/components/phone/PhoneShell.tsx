import { useEffect, useState } from 'react';
import { ChatPanel } from '../ChatPanel.tsx';
import { HistorySidebar } from '../HistorySidebar.tsx';
import { StatsPanel } from '../StatsPanel.tsx';
import { Icon } from '../tools/explorer/icons.tsx';
import { chat, getChatState, SETTINGS_TAB, useChat } from '../../lib/chatStore.ts';
import { onOpenRequest, phoneState, type OpenRequest } from '../../lib/phone.ts';
import { useConnection, useMetrics, useUsage } from '../../lib/useHarvSocket.ts';
import { startVoiceHere } from './VoiceBar.tsx';

// The phone's layout (docs/PLAN.md §6q): chat first and full height; history and stats slide in;
// the top bar has the narrow stats. A tapped notification opens its chat (in voice mode for "talk").

type Sheet = 'history' | 'stats' | null;

export function PhoneShell() {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [others, setOthers] = useState<{ name: string; url: string }[]>([]);
  const [device, setDevice] = useState('');
  const [pendingOpen, setPendingOpen] = useState<OpenRequest | null>(null);
  const { activeId } = useChat();
  const { connected } = useConnection();
  const metrics = useMetrics();
  const usage = useUsage();
  const session = usage?.meters.find((m) => m.kind === 'session')?.percent;
  /** "Harv wants to talk": waits for a tap (iOS starts the mic and speech only from one). */
  const [talk, setTalk] = useState<OpenRequest | null>(null);

  // Picking a chat in the history sheet closes it.
  const [seenActive, setSeenActive] = useState(activeId);
  if (activeId !== seenActive) {
    setSeenActive(activeId);
    if (sheet === 'history') setSheet(null);
  }

  useEffect(() => {
    void phoneState().then(
      (s) => {
        setOthers(s.others);
        setDevice(s.device);
      },
      () => {},
    );
    onOpenRequest((req) => {
      setPendingOpen(req);
      if (req.talk) setTalk(req);
    });
  }, []);

  // Open the chat a notification named, once the chats are in.
  const hydrated = useChat().hydrated;
  useEffect(() => {
    const tabId = pendingOpen?.tabId;
    if (!tabId || !hydrated) return;
    if (getChatState().tabs.some((t) => t.id === tabId)) chat.setActive(tabId);
    else chat.openFromHistory(tabId);
  }, [pendingOpen, hydrated]);

  return (
    <div className="relative flex h-[100dvh] flex-col gap-2 px-2 pt-[max(8px,env(safe-area-inset-top))] pb-[max(6px,env(safe-area-inset-bottom))]">
      <header className="glass flex items-center gap-1 rounded-2xl px-1.5 py-1 select-none">
        <button
          type="button"
          onClick={() => setSheet('history')}
          aria-label="Chat history"
          className="grid size-10 place-items-center rounded-lg text-muted active:bg-white/10"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 5h12M3 9h12M3 13h12" />
          </svg>
        </button>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-[14px] font-semibold tracking-wider text-accent">HARV</span>
          {others.length > 0 ? (
            <select
              aria-label="Which computer"
              value=""
              onChange={(e) => e.target.value && location.assign(e.target.value)}
              className="min-w-0 truncate bg-transparent text-[11px] text-faint outline-none"
            >
              <option value="">{device}</option>
              {others.map((o) => (
                <option key={o.url} value={o.url}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate text-[11px] text-faint">{device}</span>
          )}
          {!connected && <span className="text-[11px] text-warn">offline</span>}
        </div>
        <button
          type="button"
          onClick={() => setSheet('stats')}
          aria-label="System and plan"
          className="flex items-center gap-2 rounded-lg px-2 py-2 text-[11px] text-muted tabular-nums active:bg-white/10"
        >
          {metrics && <span>CPU {Math.round(metrics.cpu.load)}%</span>}
          {session !== undefined && <span className={session >= 85 ? 'text-warn' : ''}>S {Math.round(session)}%</span>}
        </button>
        <button
          type="button"
          onClick={chat.openSettings}
          aria-label="Settings"
          className={`grid size-10 place-items-center rounded-lg active:bg-white/10 ${activeId === SETTINGS_TAB ? 'text-accent' : 'text-muted'}`}
        >
          <Icon name="gear" size={17} />
        </button>
      </header>

      {talk && (
        <button
          type="button"
          onClick={() => {
            startVoiceHere(talk.say);
            setTalk(null);
          }}
          className="glass rounded-2xl px-4 py-3 text-left text-sm text-ink"
        >
          🎙 Harv wants to talk. <span className="text-accent">Tap to answer.</span>
        </button>
      )}

      <main className="flex min-h-0 flex-1 flex-col">
        <ChatPanel />
      </main>

      {sheet && (
        <div className="fixed inset-0 z-40 flex" role="dialog" aria-label={sheet === 'history' ? 'Chat history' : 'System and plan'}>
          <button type="button" aria-label="Close" onClick={() => setSheet(null)} className="absolute inset-0 bg-black/60" />
          <div
            className={`animate-fade-in relative flex h-full w-[86%] max-w-[380px] flex-col pt-[max(8px,env(safe-area-inset-top))] pb-[max(8px,env(safe-area-inset-bottom))] ${
              sheet === 'history' ? 'mr-auto pl-2' : 'ml-auto pr-2'
            }`}
          >
            {/* A solid ground under the glass: the chat behind mustn't show through a sheet. */}
            <div className="flex min-h-0 flex-1 flex-col rounded-2xl bg-[rgb(12_18_26/0.94)]">
              {sheet === 'history' ? (
                <HistorySidebar sheet onClose={() => setSheet(null)} />
              ) : (
                <StatsPanel sheet onClose={() => setSheet(null)} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
