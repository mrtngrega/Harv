import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RouteStore } from '../store/routes.ts';
import { cleanTitle, parseClassification } from './classifier.ts';
import { Router } from './router.ts';
import { instantRules, isFollowUp, parseOverride } from './rules.ts';
import { pickFor, stepUp, tag, type Classification } from './table.ts';

const c = (difficulty: Classification['difficulty'], extra: Partial<Classification> = {}): Classification => ({
  category: 'question',
  difficulty,
  stakes: 'normal',
  ambiguous: false,
  ...extra,
});

function newRouter(classify: (text: string, ...rest: unknown[]) => Promise<Classification | null> = vi.fn(async () => c(3))) {
  const log = new RouteStore(join(mkdtempSync(join(tmpdir(), 'harv-routes-')), 'harv.db'));
  return { router: new Router(log, classify), classify, log };
}

describe('table', () => {
  it('maps difficulty to model·effort, tuned for Pro', () => {
    expect(([1, 2, 3, 4, 5] as const).map((d) => tag(pickFor(c(d)).pick))).toEqual([
      'haiku·medium',
      'haiku·medium',
      'sonnet·medium',
      'opus·medium',
      'opus·high',
    ]);
    expect(tag(pickFor(c(3, { category: 'code' })).pick)).toBe('sonnet·high');
  });

  it('uses Fable for difficulty 5 only when allowed', () => {
    expect(tag(pickFor(c(5), undefined, true).pick)).toBe('fable·high');
    expect(tag(pickFor(c(4), undefined, true).pick)).toBe('opus·medium');
  });

  it('pushes high stakes one step up', () => {
    expect(tag(pickFor(c(2, { stakes: 'high' })).pick)).toBe('sonnet·medium');
    expect(tag(pickFor(c(4, { stakes: 'high' })).pick)).toBe('opus·high');
  });

  it('trims effort on easy work late in the week, never on hard work', () => {
    expect(tag(pickFor(c(3), 75).pick)).toBe('sonnet·low');
    expect(tag(pickFor(c(4), 95).pick)).toBe('opus·medium');
    expect(tag(pickFor(c(3), 50).pick)).toBe('sonnet·medium');
    // Never below haiku·medium (the user's floor).
    expect(tag(pickFor(c(1), 95).pick)).toBe('haiku·medium');
  });

  it('climbs the ladder from any pick, manual ones included', () => {
    expect(tag(stepUp({ model: 'sonnet', effort: 'medium' })!)).toBe('sonnet·high');
    expect(tag(stepUp({ model: 'sonnet', effort: 'low' })!)).toBe('sonnet·medium');
    expect(tag(stepUp({ model: 'haiku', effort: 'max' })!)).toBe('sonnet·medium');
    expect(tag(stepUp({ model: 'sonnet', effort: 'high' })!)).toBe('opus·medium');
    expect(tag(stepUp({ model: 'opus', effort: 'medium' })!)).toBe('opus·high');
    expect(stepUp({ model: 'fable', effort: 'high' })).toBeNull();
    expect(stepUp({ model: 'opus', effort: 'max' })).toBeNull();
    expect(tag(stepUp({ model: 'opus', effort: 'max' }, true)!)).toBe('fable·high');
    expect(tag(stepUp({ model: 'fable', effort: 'high' }, true)!)).toBe('fable·max');
  });
});

describe('rules', () => {
  it('parses /model and /effort overrides at the start', () => {
    expect(parseOverride('/opus /max fix it')).toEqual({ model: 'opus', effort: 'max', text: 'fix it' });
    expect(parseOverride('/high explain')).toEqual({ model: undefined, effort: 'high', text: 'explain' });
    expect(parseOverride('see /opus later')).toEqual({ model: undefined, effort: undefined, text: 'see /opus later' });
    expect(parseOverride('/usage')).toEqual({ model: undefined, effort: undefined, text: '/usage' });
  });

  it('sends small talk to Haiku and risky PC actions to Opus', () => {
    expect(instantRules('thanks!', [])).toMatchObject({ kind: 'decide', pick: { model: 'haiku', effort: 'medium' } });
    expect(instantRules('uninstall the old Java packages', [])).toMatchObject({
      kind: 'decide',
      pick: { model: 'opus', effort: 'medium' },
    });
    expect(instantRules('remove the comma from this sentence', [])).toBeNull();
  });

  it('puts a floor under code and large files', () => {
    const file = { id: 'f', name: 'main.py', size: 100, mime: 'text/x-python' };
    expect(instantRules('what does this do?', [file])).toMatchObject({ kind: 'floor', pick: { model: 'sonnet', effort: 'high' } });
  });

  it('treats short replies soon after as follow-ups', () => {
    const now = Date.now();
    expect(isFollowUp('and the other one?', [], now - 60_000, now)).toBe(true);
    expect(isFollowUp('and the other one?', [], now - 60 * 60_000, now)).toBe(false);
    expect(isFollowUp('new question: how do tides work', [], now - 60_000, now)).toBe(false);
    expect(isFollowUp('x'.repeat(400), [], now - 60_000, now)).toBe(false);
  });
});

describe('classifier reply', () => {
  it('reads the JSON, even wrapped in prose', () => {
    expect(parseClassification('Sure: {"category":"code","difficulty":4,"stakes":"high","ambiguous":false}')).toEqual({
      category: 'code',
      difficulty: 4,
      stakes: 'high',
      ambiguous: false,
    });
    expect(parseClassification('{"difficulty": 9}')).toBeNull();
    expect(parseClassification('no idea')).toBeNull();
  });

  it('keeps a tidy short title', () => {
    expect(parseClassification('{"category":"planning","difficulty":3,"stakes":"normal","title":"\\"Week plan.\\""}')?.title).toBe(
      'Week plan',
    );
    expect(cleanTitle('  GPU   driver\nupdate ')).toBe('GPU driver update');
    expect(cleanTitle('A very long title that goes on and on forever')).toHaveLength(32);
    expect(cleanTitle('')).toBeUndefined();
    expect(cleanTitle(42)).toBeUndefined();
  });
});

describe('router', () => {
  it('asks the classifier once, then reuses the decision for follow-ups', async () => {
    const { router, classify } = newRouter(vi.fn(async () => c(4)));
    const first = await router.route('t', 'Plan the migration of my photo library to the NAS with dedup');
    expect(first.decision).toMatchObject({ model: 'opus', effort: 'medium', source: 'classifier' });
    const next = await router.route('t', 'ok and what about raw files?');
    expect(next.decision).toMatchObject({ model: 'opus', effort: 'medium', source: 'followup' });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('passes the classifier’s title on, and the current title to the classifier', async () => {
    const classify = vi.fn(async () => ({ ...c(3), title: 'Week plan' }));
    const { router } = newRouter(classify);
    const r = await router.route('t', 'Plan my week around the deadlines in notes.md', [], 'Old name');
    expect(r.title).toBe('Week plan');
    expect(classify).toHaveBeenCalledWith('Plan my week around the deadlines in notes.md', [], undefined, 'Old name');
    // Follow-ups skip the classifier, so they don't rename.
    expect((await router.route('t', 'and Friday?')).title).toBeUndefined();
  });

  it('doesn’t let small talk replace the task decision', async () => {
    const { router } = newRouter(vi.fn(async () => c(4)));
    await router.route('t', 'Write a careful plan for my thesis chapters');
    expect((await router.route('t', 'thanks')).decision.model).toBe('haiku');
    expect((await router.route('t', 'and chapter 3?')).decision).toMatchObject({ model: 'opus', source: 'followup' });
  });

  it('skips the classifier for overrides and strips them', async () => {
    const { router, classify } = newRouter();
    const r = await router.route('t', '/sonnet /low hello there friend');
    expect(r).toMatchObject({ decision: { model: 'sonnet', effort: 'low', source: 'override' }, text: 'hello there friend' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('falls back to the default when the classifier fails, respecting floors', async () => {
    const { router } = newRouter(vi.fn(async () => null));
    expect((await router.route('t', 'explain black holes')).decision).toMatchObject({
      model: 'sonnet',
      effort: 'medium',
      source: 'fallback',
    });
    const code = await router.route('u', '```js\nconsole.log(1)\n```');
    expect(code.decision).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('steps up after a failed turn, and on Try harder', async () => {
    const { router, log } = newRouter(vi.fn(async () => c(3)));
    await router.route('t', 'Summarise the attached report for me');
    router.finished('t', false, false);
    expect((await router.route('t', 'try again')).decision).toMatchObject({ model: 'sonnet', effort: 'high', source: 'followup' });
    router.finished('t', true, false);
    expect(router.harder('t', { model: 'sonnet', effort: 'high' })).toMatchObject({ model: 'opus', effort: 'medium', source: 'harder' });
    expect(router.harder('t', { model: 'opus', effort: 'max' })).toBeNull();
    expect(log.split().find((r) => r.model === 'sonnet' && r.effort === 'high')).toMatchObject({ harder: 1 });
  });
});

describe('router fixes (2026-10-24)', () => {
  it('classifies a short "now do X" again when the chat started light', async () => {
    const classify = vi.fn(async (text: string) =>
      text.startsWith('we continue') ? c(2, { category: 'chat' }) : c(4, { category: 'code' }),
    );
    const { router } = newRouter(classify);
    expect(tag((await router.route('w', 'we continue on harv project, where did we end')).decision)).toBe('haiku·medium');
    const r = await router.route('w', 'do the startup prompt then gimme your ideas');
    expect(classify).toHaveBeenCalledTimes(2);
    expect(r.decision).toMatchObject({ model: 'opus', source: 'classifier' });
    // Reactions to the answer still reuse the pick.
    expect((await router.route('w', 'and the other tab too?')).decision.source).toBe('followup');
  });

  it('keeps reusing a strong pick for follow-up work, saving the classifier call', async () => {
    const classify = vi.fn(async () => c(3, { category: 'code' }));
    const { router } = newRouter(classify);
    await router.route('k', 'Refactor the settings loader to validate every field');
    expect((await router.route('k', 'now add tests for the new validation too')).decision).toMatchObject({ source: 'followup' });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('gives project work at least sonnet·high, but not small talk', async () => {
    const { router } = newRouter(vi.fn(async () => c(1)));
    expect(tag((await router.route('p', 'what does this function return', [], undefined, { project: true })).decision)).toBe('sonnet·high');
    expect(tag((await router.route('p2', 'thanks', [], undefined, { project: true })).decision)).toBe('haiku·medium');
    expect(tag((await router.route('p3', 'what does this function return')).decision)).toBe('haiku·medium');
  });

  it('passes the last lines of the chat to the classifier', async () => {
    const classify = vi.fn(async () => c(2));
    const { router } = newRouter(classify);
    await router.route('r', 'Plan the release notes for version two', [], undefined, { recent: 'User: hi\nHarv: hello' });
    expect(classify).toHaveBeenCalledWith('Plan the release notes for version two', [], 'User: hi\nHarv: hello', undefined);
  });

  it('learns from "Try harder": a kind of task that keeps needing more starts a step up', async () => {
    const { router } = newRouter(vi.fn(async () => c(2, { category: 'writing' })));
    for (const tab of ['a', 'b']) {
      const first = await router.route(tab, 'Write a short note to my landlord about the heating');
      router.harder(tab, first.decision);
    }
    const next = await router.route('c', 'Write a short note to my neighbour about the party');
    expect(tag(next.decision)).toBe('sonnet·medium');
    expect(next.decision.reason).toMatch(/try harder on 2 similar tasks/);
  });
});
