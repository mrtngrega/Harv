import { EFFORT_LEVELS, type EffortLevel } from '@harv/shared';

/** Commands the dashboard handles itself; they never reach Claude, so they cost nothing. */
export type Command = { kind: 'model'; model?: string; effort?: EffortLevel } | { kind: 'attach' } | { kind: 'new' } | { kind: 'help' };

export const HELP =
  'Commands: /model auto|opus|sonnet|haiku|fable [low|medium|high|xhigh|max] switches the model, /attach adds files, /new opens a tab. ' +
  'Start a message with /opus, /sonnet, /max… to run just that message at that model or effort. ' +
  'Claude Code’s commands and skills (/compact, /context, /init, /code-review…) go straight to Claude: type / to see them all. ' +
  'While Harv answers, what you send waits its turn; STOP ends the reply and runs it now.';

const MODELS = ['auto', 'opus', 'sonnet', 'haiku', 'fable'];
const EFFORT_ALIASES: Record<string, EffortLevel> = { med: 'medium' };

/** A dashboard command, or null for a normal message (including one-message overrides like "/opus fix it"). */
export function parseCommand(text: string): Command | { kind: 'error'; message: string } | null {
  const [head, ...args] = text.trim().split(/\s+/);
  switch (head?.toLowerCase()) {
    case '/attach':
      return args.length ? null : { kind: 'attach' };
    case '/new':
      return args.length ? null : { kind: 'new' };
    case '/help':
    case '/?':
      return { kind: 'help' };
    case '/model': {
      if (args.length === 0) return { kind: 'help' };
      let model: string | undefined;
      let effort: EffortLevel | undefined;
      for (const raw of args) {
        const a = raw.toLowerCase();
        const e = EFFORT_ALIASES[a] ?? a;
        if (!model && MODELS.includes(a)) model = a;
        else if (!effort && (EFFORT_LEVELS as string[]).includes(e)) effort = e as EffortLevel;
        else return { kind: 'error', message: `Unknown model or effort “${raw}”. ${HELP}` };
      }
      return { kind: 'model', model, effort };
    }
    default:
      return null;
  }
}
