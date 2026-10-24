import { query, type ModelInfo, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { EFFORT_LEVELS, type Catalog, type ModelOption } from '@harv/shared';
import { toCommandInfo } from './commands.ts';
import { buildOptions } from './options.ts';
import { AsyncQueue } from './queue.ts';

/** Current-generation aliases shown in the switcher, in display order. Older models stay hidden. */
const SHOWN = ['opus', 'sonnet', 'haiku', 'fable'];

export function toCatalog(plan: string | undefined, models: ModelInfo[], commands: SlashCommand[] = []): Catalog {
  const options: ModelOption[] = SHOWN.flatMap((id) => {
    const m = models.find((x) => x.value === id);
    if (!m) return [];
    return [
      {
        id,
        name: m.displayName,
        description: m.description,
        efforts: (m.supportedEffortLevels ?? []).filter((e) => EFFORT_LEVELS.includes(e)),
      },
    ];
  });
  return { plan: plan ?? null, models: options, commands: toCommandInfo(commands) };
}

/**
 * Asks Claude Code which models the logged-in plan offers, and its slash commands.
 * Starts a session without sending a prompt, so it uses no plan usage.
 */
export async function loadCatalog(): Promise<Catalog> {
  const input = new AsyncQueue<never>();
  const abort = new AbortController();
  const q = query({ prompt: input, options: { ...buildOptions('sonnet', 'low', abort), persistSession: false } });
  try {
    const [account, models, commands] = await Promise.all([q.accountInfo(), q.supportedModels(), q.supportedCommands()]);
    if (account.apiProvider && account.apiProvider !== 'firstParty') {
      throw new Error(`Claude Code is using ${account.apiProvider}, not a Claude subscription login.`);
    }
    return toCatalog(account.subscriptionType, models, commands);
  } finally {
    input.end();
    q.close();
  }
}
