import type { CSSProperties } from 'react';
import { Header } from './components/Header.tsx';
import { HistorySidebar } from './components/HistorySidebar.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { StatsPanel } from './components/StatsPanel.tsx';
import { useBackground, useConnection, useSettings } from './lib/useHarvSocket.ts';

export function App() {
  const conn = useConnection();
  const { accent, motion } = useSettings();
  const { version } = useBackground();
  // Before the server says, try the photo anyway; after a removal, show the plain ground colour.
  const photo = version === null ? undefined : `url(/api/background${version ? `?v=${version}` : ''})`;

  return (
    <div className={`relative min-h-full overflow-hidden ${motion ? '' : 'still'}`} style={{ '--color-accent': accent } as CSSProperties}>
      {/* Blurred personal background from ~/.harv, falling back to the ground color. */}
      <div
        aria-hidden="true"
        className="absolute -inset-12 scale-105 bg-cover bg-center blur-[9px] saturate-[1.1]"
        style={{ backgroundImage: photo }}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-[rgb(10_16_24/0.55)]" />

      <div className="relative flex min-h-screen flex-col gap-3.5 p-4">
        <Header conn={conn} />
        <main className="flex flex-1 flex-wrap items-stretch gap-3.5">
          <HistorySidebar />
          <ChatPanel />
          <StatsPanel />
        </main>
      </div>
    </div>
  );
}
