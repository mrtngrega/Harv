import { useState } from 'react';

// Placeholder list until M2, when Harv asks Claude Code which models the plan actually offers.
const MODELS = ['AUTO', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'] as const;
type Model = (typeof MODELS)[number];

export function ModelSwitcher() {
  const [model, setModel] = useState<Model>('AUTO');

  return (
    <div role="group" aria-label="Model" className="flex gap-1 rounded-xl bg-black/20 p-[3px]">
      {MODELS.map((m) => {
        const on = m === model;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            onClick={() => setModel(m)}
            className={`min-h-[34px] cursor-pointer rounded-[9px] px-3 text-xs font-semibold transition-colors ${
              on ? 'bg-accent text-[#0f1620]' : 'text-[#d5dee7] hover:bg-white/5'
            }`}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}
