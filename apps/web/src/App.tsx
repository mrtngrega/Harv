import type { CSSProperties } from 'react';
import { Header } from './components/Header.tsx';
import { HistorySidebar } from './components/HistorySidebar.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { StatsPanel } from './components/StatsPanel.tsx';
import { Toasts } from './components/Toasts.tsx';
import { useBackground, useSettings } from './lib/useHarvSocket.ts';

export function App() {
  const { accent, motion, backgroundBlur, scrim, glass, uiScale, density } = useSettings();
  const { version } = useBackground();
  // Before the server says, try the photo anyway; after a removal, show the plain ground colour.
  const photo = version === null ? undefined : `url(/api/background${version ? `?v=${version}` : ''})`;
  const zoom = uiScale / 100;

  return (
    <div
      className={`relative min-h-full overflow-clip ${motion ? '' : 'still'} ${density === 'compact' ? 'compact' : ''}`}
      style={
        {
          '--color-accent': accent,
          '--glass-alpha': glass / 100,
          // The page's height in zoomed pixels (Chrome scales 100vh by the zoom too).
          '--app-h': `calc(100vh / ${zoom})`,
          zoom,
        } as CSSProperties
      }
    >
      {/* Blurred personal background from ~/.harv, falling back to the ground color. */}
      <div
        aria-hidden="true"
        className="absolute -inset-12 scale-105 bg-cover bg-center saturate-[1.1]"
        style={{ backgroundImage: photo, filter: backgroundBlur ? `blur(${backgroundBlur}px)` : undefined }}
      />
      <div aria-hidden="true" className="absolute inset-0" style={{ background: `rgb(10 16 24 / ${scrim / 100})` }} />

      <div className="relative flex min-h-[var(--app-h)] flex-col gap-3.5 p-4">
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
