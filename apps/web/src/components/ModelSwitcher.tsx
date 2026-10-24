import { EFFORT_LEVELS, type EffortLevel } from '@harv/shared';
import { chat, useChat } from '../lib/chatStore.ts';
import { useCatalog } from '../lib/useHarvSocket.ts';

const EFFORT_LABEL: Record<EffortLevel, string> = { low: 'LOW', medium: 'MED', high: 'HIGH', xhigh: 'XHI', max: 'MAX' };

function Segment({ on, label, title, onClick }: { on: boolean; label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`min-h-[34px] cursor-pointer rounded-[9px] px-3 text-xs font-semibold whitespace-nowrap transition-colors ${
        on ? 'bg-accent text-[#0f1620]' : 'text-[#d5dee7] hover:bg-white/5'
      }`}
    >
      {label}
    </button>
  );
}

export function ModelSwitcher() {
  const catalog = useCatalog();
  const { model, effort, routed, routedReason } = useChat();
  const current = catalog?.models.find((m) => m.id === model);
  const efforts = current?.efforts.length ? current.efforts : EFFORT_LEVELS;

  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
      {/* Scrolls sideways instead of spilling out of the header on a narrow window. */}
      <div role="group" aria-label="Model" className="flex max-w-full flex-wrap gap-1 rounded-xl bg-black/20 p-[3px]">
        <Segment on={model === 'auto'} label="AUTO" title="Harv picks the model and effort" onClick={() => chat.setModel('auto')} />
        {catalog ? (
          catalog.models.map((m) => (
            <Segment key={m.id} on={model === m.id} label={m.name} title={m.description} onClick={() => chat.setModel(m.id)} />
          ))
        ) : (
          <span className="flex items-center px-3 text-xs text-faint">loading models…</span>
        )}
      </div>

      {model === 'auto' ? (
        routed && (
          <span title={routedReason} className="animate-fade-in cursor-help text-xs text-muted">
            auto → {routed}
          </span>
        )
      ) : (
        <div role="group" aria-label="Effort" className="flex gap-1 rounded-xl bg-black/20 p-[3px]">
          {efforts.map((e) => (
            <Segment key={e} on={effort === e} label={EFFORT_LABEL[e]} title={`${e} effort`} onClick={() => chat.setEffort(e)} />
          ))}
        </div>
      )}
    </div>
  );
}
