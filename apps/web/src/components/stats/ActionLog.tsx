import { recentActions, useSafety } from '../../lib/safetyStore.ts';
import { ActionBadge } from '../ApprovalCard.tsx';
import { Card } from './parts.tsx';

const time = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** The latest yellow, red and blocked actions with their outcome and Undo. Reads aren't listed. */
export function ActionLog() {
  const actions = recentActions(useSafety());

  return (
    <Card title="Actions" sub="changes Harv made · newest first">
      {actions.length === 0 ? (
        <p className="m-0 text-xs text-muted">Nothing yet. Edits, commands and anything blocked show up here.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-xs">
          {actions.map((a) => (
            <li key={a.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                <span className="flex-none text-[11px] text-faint tabular-nums">{time(a.at)}</span>
                <span className="min-w-0 flex-1 truncate" title={a.summary}>
                  {a.summary}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-[46px]">
                <ActionBadge action={a} />
                {a.result && (
                  <span className="min-w-0 truncate text-[11px] text-faint" title={a.result}>
                    {a.result}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
