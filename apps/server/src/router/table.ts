import { EFFORT_LEVELS, type EffortLevel } from '@harv/shared';

export interface Pick {
  model: string;
  effort: EffortLevel;
}

/** What the Haiku classifier reports about a message. */
export interface Classification {
  category: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  stakes: 'low' | 'normal' | 'high';
  ambiguous: boolean;
}

/**
 * Every step AUTO can take, cheapest first, tuned for Claude Pro: Haiku for trivial
 * work, Sonnet as the workhorse, Opus only near the top. "Try harder" climbs one step.
 */
export const LADDER: readonly Pick[] = [
  { model: 'haiku', effort: 'low' },
  { model: 'haiku', effort: 'medium' },
  { model: 'sonnet', effort: 'medium' },
  { model: 'sonnet', effort: 'high' },
  { model: 'opus', effort: 'high' },
  { model: 'opus', effort: 'xhigh' },
  { model: 'opus', effort: 'max' },
];

// Fable is a manual pick only, so it ranks with Opus here.
const MODEL_RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 2 };

/** Orders any model·effort, including manual picks that aren't on the ladder. */
const score = (p: Pick) => (MODEL_RANK[p.model] ?? 1) * 10 + EFFORT_LEVELS.indexOf(p.effort);

export const tag = (p: Pick) => `${p.model}·${p.effort}`;

/** The next ladder step above `p`, or null at the top. */
export function stepUp(p: Pick): Pick | null {
  return LADDER.find((step) => score(step) > score(p)) ?? null;
}

/** The higher of two picks. */
export const atLeast = (p: Pick, floor: Pick): Pick => (score(p) >= score(floor) ? p : floor);

/** Weekly plan usage (%) above which easy tasks get less effort. */
export const TRIM_FROM_PERCENT = 70;

/** The table: difficulty → model·effort. High stakes push one step up. */
export function pickFor(c: Classification, weeklyUsed?: number): { pick: Pick; why: string } {
  const code = /code|program|debug/i.test(c.category);
  let pick: Pick;
  switch (c.difficulty) {
    case 1:
      pick = LADDER[0]!;
      break;
    case 2:
      pick = LADDER[1]!;
      break;
    case 3:
      pick = code ? LADDER[3]! : LADDER[2]!;
      break;
    case 4:
      pick = LADDER[4]!;
      break;
    case 5:
      pick = LADDER[6]!;
      break;
  }
  const parts = [`${c.category}, difficulty ${c.difficulty}`];
  if (c.stakes === 'high' && c.difficulty < 5) {
    pick = stepUp(pick) ?? pick;
    parts.push('high stakes');
  }
  // Plan awareness: save usage on easy work only; never downgrade difficulty 4–5.
  if (weeklyUsed !== undefined && weeklyUsed >= TRIM_FROM_PERCENT && c.difficulty <= 3 && c.stakes !== 'high') {
    const lower = EFFORT_LEVELS[EFFORT_LEVELS.indexOf(pick.effort) - 1];
    if (lower) {
      pick = { ...pick, effort: lower };
      parts.push(`effort trimmed, ${Math.round(weeklyUsed)}% of the week used`);
    }
  }
  return { pick, why: parts.join(', ') };
}
