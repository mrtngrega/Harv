import { Header } from './components/Header.tsx';
import { HistorySidebar } from './components/HistorySidebar.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { StatsPanel } from './components/StatsPanel.tsx';
import { useHarvSocket } from './lib/useHarvSocket.ts';

export function App() {
  const conn = useHarvSocket();

  return (
    <div className="relative min-h-full overflow-hidden">
      {/* Blurred personal background from ~/.harv, falling back to the ground color. */}
      <div
        aria-hidden="true"
        className="absolute -inset-12 scale-105 bg-cover bg-center blur-[18px] saturate-[1.1]"
        style={{ backgroundImage: 'url(/api/background)' }}
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
