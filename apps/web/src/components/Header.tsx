import { useEffect, useState } from 'react';
import type { HarvConnection } from '../lib/useHarvSocket.ts';
import { ModelSwitcher } from './ModelSwitcher.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { StatusPill } from './StatusPill.tsx';

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function Header({ conn }: { conn: HarvConnection }) {
  const clock = useClock();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="glass flex flex-wrap items-center gap-4 rounded-2xl px-4 py-2.5">
      <div className="text-[15px] font-semibold tracking-wider text-accent">[HARV]</div>
      <StatusPill conn={conn} />
      <div className="flex-1" />
      <ModelSwitcher />
      <div className="text-muted tabular-nums">{clock}</div>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label="Settings"
        aria-expanded={settingsOpen}
        title="Settings"
        className="size-9 cursor-pointer rounded-lg text-[15px] text-muted hover:bg-white/5 hover:text-ink"
      >
        ⚙
      </button>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}
