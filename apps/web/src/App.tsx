import { useEffect, useState, type CSSProperties } from 'react';
import { dragWindow, Header } from './components/Header.tsx';
import { HistorySidebar } from './components/HistorySidebar.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { StatsPanel } from './components/StatsPanel.tsx';
import { Toasts } from './components/Toasts.tsx';
import { revealWhenReady } from './lib/boot.ts';
import { getChatState, subscribeChat } from './lib/chatStore.ts';
import { desktop, inApp } from './lib/desktop.ts';
import { useBackground, useConnection, useSettings } from './lib/useHarvSocket.ts';

export function App() {
  const { accent, motion, backgroundBlur, scrim, glass, glassBlur, uiScale, density, backdrop, frost } = useSettings();
  // See-through (the app only; a browser shows the photo): the window shows the desktop behind it, the darkness layer tints it.
  const clear = inApp && backdrop === 'seeThrough';
  const { battery } = useConnection();
  const plain = backdrop === 'plain';
  useEffect(() => {
    if (!inApp) return;
    document.documentElement.classList.toggle('see-through', clear);
    desktop.seeThrough(clear, frost);
  }, [clear, frost]);
  const { version } = useBackground();
  // Before the server says, try the photo anyway; after a removal, show the plain ground colour.
  const photo = version === null ? undefined : `url(/api/background${version ? `?v=${version}` : ''})`;
  const zoom = uiScale / 100;
  // The starting cover goes once the hello (settings, photo version) and the layout are in.
  const [hydrated, setHydrated] = useState(() => getChatState().hydrated);
  useEffect(() => {
    if (hydrated) return;
    const check = () => getChatState().hydrated && setHydrated(true);
    // The layout may have come in between the first render and this effect: check now too, or that change is missed
    // (the notebook did, every start, and the cover waited for its 8 s fallback).
    check();
    return subscribeChat(check);
  }, [hydrated]);
  const known = version !== undefined;
  useEffect(() => {
    if (!hydrated || !known) return;
    const shown = !clear && !plain && version !== null;
    revealWhenReady(shown ? `/api/background${version ? `?v=${version}` : ''}` : null, motion);
  }, [hydrated, known, version, clear, plain, motion]);

  return (
    <div
      className={`relative min-h-full overflow-clip ${motion ? '' : 'still'} ${density === 'compact' ? 'compact' : ''} ${battery ? 'battery' : ''}`}
      style={
        {
          '--color-accent': accent,
          '--glass-alpha': glass / 100,
          '--glass-blur': `${glassBlur}px`,
          // The page's height in zoomed pixels (Chrome scales 100vh by the zoom too).
          '--app-h': `calc(100vh / ${zoom})`,
          zoom,
        } as CSSProperties
      }
    >
      {/* Blurred personal background from ~/.harv, falling back to the ground color. */}
      {!clear && !plain && (
        <div
          aria-hidden="true"
          className="absolute -inset-12 scale-105 bg-cover bg-center saturate-[1.1]"
          style={{ backgroundImage: photo, filter: backgroundBlur ? `blur(${backgroundBlur}px)` : undefined }}
        />
      )}
      {!plain && <div aria-hidden="true" className="absolute inset-0" style={{ background: `rgb(10 16 24 / ${scrim / 100})` }} />}

      <div
        className="relative flex min-h-[var(--app-h)] flex-col gap-3.5 p-4"
        onMouseDown={(e) => e.target === e.currentTarget && dragWindow(e)}
      >
        <Header />
        {/* Three columns that shrink from 1024px up; stacked below that. */}
        <main className="flex flex-1 flex-col items-stretch gap-3.5 lg:min-h-0 lg:flex-row">
          <HistorySidebar />
          <ChatPanel />
          <StatsPanel />
        </main>
      </div>
      <Toasts />
    </div>
  );
}
