import { AUTO_FALLBACK, type Attachment, type ChatUsage, type RouteDecision, type RouteSource } from '@harv/shared';
import type { RouteStore } from '../store/routes.ts';
import { classify as haikuClassify } from './classifier.ts';
import { asksForWork, instantRules, isFollowUp, parseOverride } from './rules.ts';
import { atLeast, pickFor, stepUp, struggleStep, tag, type Classification, type Pick } from './table.ts';

type Classify = (text: string, files: Attachment[], context?: string, title?: string) => Promise<Classification | null>;

interface TabState {
  /** The decision for the task in progress (small talk doesn't replace it). */
  task?: { pick: Pick; why: string; at: number; c?: Classification };
  /** The last turn ended in an error, so the next follow-up steps up. */
  failed?: boolean;
}

/** What the router knows about the chat a message is in. */
export interface RouteContext {
  /** A project chat: real dev work, so at least PROJECT_FLOOR. */
  project?: boolean;
  /** The last few lines of the chat, so the classifier judges a follow-up in context. */
  recent?: string;
}

/** The least a project chat's work runs at (small talk excepted): the user wants the best result first. */
export const PROJECT_FLOOR: Pick = { model: 'sonnet', effort: 'high' };
/** Below this, a short "now do X" in an ongoing chat is classified again instead of reusing the pick. */
const WORK_FLOOR: Pick = { model: 'sonnet', effort: 'high' };
/** "Try harder" on at least this many similar tasks, and this share of them, starts that kind one step higher. */
const LEARN_MIN_HARDER = 2;
const LEARN_SHARE = 0.25;
const LEARN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * AUTO: picks model·effort for each message. Instant rules first, then a cheap
 * Haiku classifier, then the table; "Try harder" and failures climb the ladder.
 * Every decision is logged for tuning.
 */
export class Router {
  private tabs = new Map<string, TabState>();

  constructor(
    private log: RouteStore,
    private classify: Classify = haikuClassify,
    /** Weekly plan usage in %, once M7 can read it. */
    private weeklyUsed: () => number | undefined = () => undefined,
    /** The "allow Fable in AUTO" setting. */
    private allowFable: () => boolean = () => false,
  ) {}

  private state(tabId: string): TabState {
    let s = this.tabs.get(tabId);
    if (!s) this.tabs.set(tabId, (s = {}));
    return s;
  }

  /**
   * Decides a message's model·effort. `text` comes back without any `/opus`-style override words.
   * When the classifier ran, `title` is its short name for the chat (given the current `title`).
   */
  async route(
    tabId: string,
    message: string,
    files: Attachment[] = [],
    title?: string,
    ctx: RouteContext = {},
  ): Promise<{ decision: RouteDecision; text: string; title?: string }> {
    const s = this.state(tabId);
    const override = parseOverride(message);
    const text = override.text;

    if (override.model) {
      const pick: Pick = { model: override.model, effort: override.effort ?? 'high' };
      return { decision: this.record(tabId, pick, 'override', 'you asked for it'), text };
    }

    const auto = await this.auto(s, text, files, title, ctx);
    let { pick, source, why } = auto;
    if (ctx.project && why !== 'small talk' && atLeast(pick, PROJECT_FLOOR) !== pick) {
      pick = PROJECT_FLOOR;
      why = `${why}; project work runs at least ${tag(PROJECT_FLOOR)}`;
    }
    if (override.effort) {
      pick = { ...pick, effort: override.effort };
      source = 'override';
      why = `effort you asked for; ${why}`;
    }
    if (why !== 'small talk') s.task = { pick, why, at: Date.now(), ...(auto.c ? { c: auto.c } : {}) };
    // A follow-up reuses the task's classification for the log, but only a fresh one names the chat.
    const named = auto.source === 'followup' ? undefined : auto.c?.title;
    return { decision: this.record(tabId, pick, source, why, auto.c), text, ...(named ? { title: named } : {}) };
  }

  private async auto(
    s: TabState,
    text: string,
    files: Attachment[],
    title?: string,
    ctx: RouteContext = {},
  ): Promise<{ pick: Pick; source: RouteSource; why: string; c?: Classification }> {
    const rule = instantRules(text, files);
    if (rule?.kind === 'decide') return { pick: rule.pick, source: 'rule', why: rule.why };

    // A follow-up keeps the task's pick, unless it asks for new work and that pick is a cheap one (from a light start).
    const cheap = s.task && atLeast(s.task.pick, WORK_FLOOR) !== s.task.pick;
    if (!rule && s.task && isFollowUp(text, files, s.task.at) && !(cheap && asksForWork(text))) {
      const why = s.task.why.replace(/^same task \((.*)\)$/, '$1');
      const up = s.failed ? stepUp(s.task.pick, this.allowFable()) : null;
      if (up) return { pick: up, source: 'followup', why: `stepped up after the last turn failed (${why})`, c: s.task.c };
      return { pick: s.task.pick, source: 'followup', why: `same task (${why})`, c: s.task.c };
    }

    const c = await this.classify(text, files, ctx.recent ?? s.task?.why, title);
    if (!c) {
      const pick = rule ? atLeast(AUTO_FALLBACK, rule.pick) : AUTO_FALLBACK;
      return { pick, source: 'fallback', why: 'the classifier didn’t answer, so the default' };
    }
    const table = pickFor(c, this.weeklyUsed(), this.allowFable());
    // Learned from "Try harder": this kind of task keeps needing more, so start it a step higher.
    const seen = this.log.harderStats(c.category, c.difficulty, Date.now() - LEARN_WINDOW_MS);
    if (seen.harder >= LEARN_MIN_HARDER && seen.harder / seen.turns >= LEARN_SHARE) {
      const up = stepUp(table.pick, this.allowFable());
      if (up) {
        table.pick = up;
        table.why += `, a step up (you asked to try harder on ${seen.harder} similar tasks)`;
      }
    }
    if (rule && atLeast(table.pick, rule.pick) !== table.pick) {
      return { pick: rule.pick, source: 'rule', why: `${table.why}; at least ${tag(rule.pick)} for ${rule.why}`, c };
    }
    return { pick: table.pick, source: 'classifier', why: table.why + (c.ambiguous ? ', ambiguous' : ''), c };
  }

  /** A short title for a chat's first message when no AUTO routing names it (manual mode): one cheap classifier call. */
  async name(text: string, files: Attachment[] = []): Promise<string | undefined> {
    return (await this.classify(text, files))?.title;
  }

  /** "Try harder": one step up from what the last turn ran at. Null when that was already the top. */
  harder(tabId: string, from: Pick): RouteDecision | null {
    const up = stepUp(from, this.allowFable());
    if (!up) return null;
    this.log.markLast(tabId, 'harder');
    const s = this.state(tabId);
    const why = `you asked to try harder (was ${tag(from)})`;
    s.task = { pick: up, why, at: Date.now() };
    return this.record(tabId, up, 'harder', why);
  }

  /**
   * A reply is struggling (tests failing, tool calls failing in a row): one step up mid-reply, at most
   * up to STRUGGLE_CEILING. The task keeps the new pick, so its follow-ups don't drop back down.
   */
  struggling(tabId: string, from: Pick, why: string): RouteDecision | null {
    const up = struggleStep(from);
    if (!up) return null;
    const reason = `↑ stepped up from ${tag(from)}: ${why}`;
    this.state(tabId).task = { pick: up, why: reason, at: Date.now() };
    return this.record(tabId, up, 'stepup', reason);
  }

  /** Logs a turn the user picked the model for (manual mode), so Harv's stats count every turn. */
  manual(tabId: string, decision: RouteDecision): void {
    this.record(tabId, decision, decision.source, decision.reason);
  }

  /** A turn ended; failures make the next follow-up step up. */
  finished(tabId: string, ok: boolean, stopped: boolean, usage?: ChatUsage): void {
    this.state(tabId).failed = !ok && !stopped;
    if (usage) this.log.finishLast(tabId, usage);
  }

  forget(tabId: string): void {
    this.tabs.delete(tabId);
  }

  private record(chatId: string, pick: Pick, source: RouteSource, reason: string, c?: Classification): RouteDecision {
    this.log.add({ chatId, ...pick, source, reason, category: c?.category, difficulty: c?.difficulty, stakes: c?.stakes });
    return { ...pick, source, reason };
  }
}
