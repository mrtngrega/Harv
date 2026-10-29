import { useEffect, useState } from 'react';
import { ChatPanel } from '../ChatPanel.tsx';
import { HistorySidebar } from '../HistorySidebar.tsx';
import { StatsPanel } from '../StatsPanel.tsx';
import { Icon } from '../tools/explorer/icons.tsx';
import { chat, getChatState, SETTINGS_TAB, useChat } from '../../lib/chatStore.ts';
import type { PhoneState } from '@harv/shared';
import { controlDevice, onOpenRequest, phoneState, type OpenRequest } from '../../lib/phone.ts';
import { useConnection, useMetrics, useUsage } from '../../lib/useHarvSocket.ts';
import { startVoiceHere } from './VoiceBar.tsx';

// The phone's layout (docs/PLAN.md §6q): chat first and full height; history and stats slide in;
// the top bar has the narrow stats. A tapped notification opens its chat (in voice mode for "talk").

type Sheet = 'history' | 'stats' | null;

/**
 * The part of the screen iOS really shows. With the keyboard up, Safari keeps the page tall and slides
 * the view up over it; the app follows that view (its top and height) instead of fighting it: scrolling
 * the page back made it shake while typing, and a stale height left a blank strip at the bottom.
 */
function useVisibleArea(): { top: number; height: number } | null {
  const read = () => {
    const vv = window.visualViewport;
    return vv ? { top: vv.offsetTop, height: vv.height } : null;
  };
  const [area, setArea] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setArea(read()));
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('orientationchange', update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return area;
}

export function PhoneShell() {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [others, setOthers] = useState<PhoneState['others']>([]);
  const [device, setDevice] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const area = useVisibleArea();
  const [pendingOpen, setPendingOpen] = useState<OpenRequest | null>(null);
  const { activeId } = useChat();
  const { connected } = useConnection();
  const metrics = useMetrics();
  const usage = useUsage();
  const session = usage?.meters.find((m) => m.kind === 'session')?.percent;
  /** "Harv wants to talk": waits for a tap (iOS starts the mic and speech only from one). */
  const [talk, setTalk] = useState<OpenRequest | null>(null);

  /** The computer the phone controls now. */
  const controlled = (target && others.find((o) => o.id === target)?.name) || device;

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
        setTarget(s.target);
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
    // Pinned to the screen (no page to scroll or bounce), sized to what the keyboard leaves visible.
    <div
      className="fixed inset-x-0 top-0 flex flex-col gap-2 px-2 pt-[max(8px,env(safe-area-inset-top))] pb-[max(6px,env(safe-area-inset-bottom))]"
      style={area ? { top: area.top, height: area.height } : { height: '100dvh' }}
    >
      <header className="glass relative z-30 flex items-center gap-1 rounded-2xl px-1.5 py-1 select-none">
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
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={picking}
              aria-label="Which computer"
              onClick={() => setPicking((p) => !p)}
              className="min-w-0 truncate rounded-md px-1.5 py-1 text-[12px] text-ink active:bg-white/10"
            >
              {controlled} <span className="text-faint">▾</span>
            </button>
          ) : (
            <span className="truncate text-[12px] text-faint">{device}</span>
          )}
          {!connected && <span className="text-[11px] text-warn">offline</span>}
        </div>
        {picking && (
          <div
            role="menu"
            aria-label="Which computer"
            className="absolute top-full left-10 z-50 mt-1 flex min-w-48 flex-col rounded-xl border border-line bg-[rgb(16_24_34/0.97)] py-1 text-sm shadow-[0_12px_32px_rgb(0_0_0/0.5)]"
          >
            {[{ id: null, name: device, online: true }, ...others].map((d) => (
              <button
                key={d.id ?? 'here'}
                type="button"
                role="menuitemradio"
                aria-checked={target === d.id}
                disabled={!d.online && target !== d.id}
                onClick={() => {
                  setPicking(false);
                  if (target !== d.id) void controlDevice(d.id).then(() => location.reload());
                }}
                className="flex items-center gap-2.5 px-3 py-2.5 text-left disabled:opacity-45"
              >
                <span className={`size-2 rounded-full ${d.online ? 'bg-ok' : 'bg-white/25'}`} />
                <span className={`flex-1 ${target === d.id ? 'text-accent' : 'text-ink'}`}>{d.name}</span>
                {!d.online && <span className="text-[11px] text-faint">off</span>}
              </button>
            ))}
          </div>
        )}
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
