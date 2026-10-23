import type { Attachment, EffortLevel } from '@harv/shared';
import type { Pick } from './table.ts';

const MODEL_WORDS: Record<string, string> = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable' };
const EFFORT_WORDS: Record<string, EffortLevel> = {
  low: 'low',
  med: 'medium',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** `/opus`, `/max`, `/sonnet /high` at the start of a message. The words are removed from the text. */
export function parseOverride(text: string): { model?: string; effort?: EffortLevel; text: string } {
  let rest = text;
  let model: string | undefined;
  let effort: EffortLevel | undefined;
  for (;;) {
    const m = /^\s*\/([a-z]+)\b\s*/i.exec(rest);
    const word = m?.[1]!.toLowerCase();
    if (!m || !word) break;
    if (!model && MODEL_WORDS[word]) model = MODEL_WORDS[word];
    else if (!effort && EFFORT_WORDS[word]) effort = EFFORT_WORDS[word];
    else break;
    rest = rest.slice(m[0].length);
  }
  return { model, effort, text: model || effort ? rest : text };
}

const SMALL_TALK =
  /^(hi|hey|hello|yo|hiya|thanks|thank you|thx|ty|cheers|ok|okay|k|cool|nice|great|perfect|got it|good (morning|night|evening)|gn|bye|see you|lol|yes|no|yep|nope|sure)\b[\s!.,?:)]*$/i;

/** Asks for something on the PC that the safety gate would treat as red. */
const RISKY_VERB = /\b(delete|uninstall|install|wipe|erase|kill|terminate|regedit|registry|reformat|overwrite)\b/i;
const PC_THING =
  /\b(files?|folders?|director(y|ies)|apps?|programs?|software|process(es)?|packages?|drivers?|services?|registry|settings|startup|disk|drive|partition|downloads|desktop|documents)\b|[a-z]:\\/i;

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py|rs|go|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|sql|sh|ps1|lua|vue|svelte)$/i;
/** Attachments bigger than this in total count as "large files". */
const LARGE_FILES_BYTES = 2 * 1024 * 1024;

export type RuleResult =
  | { kind: 'decide'; pick: Pick; why: string }
  /** The classifier still decides, but never below this. */
  | { kind: 'floor'; pick: Pick; why: string }
  | null;

/** Instant rules: no model call. */
export function instantRules(text: string, files: Attachment[]): RuleResult {
  const t = text.trim();
  if (!files.length && SMALL_TALK.test(t)) return { kind: 'decide', pick: { model: 'haiku', effort: 'low' }, why: 'small talk' };
  if (RISKY_VERB.test(t) && PC_THING.test(t)) {
    return { kind: 'decide', pick: { model: 'opus', effort: 'high' }, why: 'a risky action on your PC' };
  }
  const code = /```/.test(t) || files.some((f) => CODE_FILE.test(f.name));
  const large = files.reduce((sum, f) => sum + f.size, 0) > LARGE_FILES_BYTES || t.length > 6000;
  if (code || large) {
    return { kind: 'floor', pick: { model: 'sonnet', effort: 'high' }, why: code ? 'code' : 'large input' };
  }
  return null;
}

/** Words that start a new task rather than continue the current one. */
const NEW_TASK =
  /\b(new (task|question|topic)|different (thing|question)|something else|unrelated|now (write|build|make|create|find|research|plan))\b/i;

/** How long a tab's last decision counts for follow-ups. */
export const FOLLOWUP_WINDOW_MS = 20 * 60 * 1000;

/** A short reply in an ongoing task reuses the previous decision instead of asking the classifier. */
export function isFollowUp(text: string, files: Attachment[], lastAt: number | undefined, now = Date.now()): boolean {
  if (lastAt === undefined || now - lastAt > FOLLOWUP_WINDOW_MS) return false;
  const t = text.trim();
  return !files.length && t.length > 0 && t.length <= 160 && !NEW_TASK.test(t);
}
