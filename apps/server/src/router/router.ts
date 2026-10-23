import { AUTO_FALLBACK, type Attachment, type ChatUsage, type RouteDecision, type RouteSource } from '@harv/shared';
import type { RouteStore } from '../store/routes.ts';
import { classify as haikuClassify } from './classifier.ts';
import { instantRules, isFollowUp, parseOverride } from './rules.ts';
import { atLeast, pickFor, stepUp, tag, type Classification, type Pick } from './table.ts';

type Classify = (text: string, files: Attachment[], context?: string, title?: string) => Promise<Classification | null>;

interface TabState {
  /** The decision for the task in progress (small talk doesn't replace it). */
  task?: { pick: Pick; why: string; at: number };
  /** The last turn ended in an error, so the next follow-up steps up. */
  failed?: boolean;
}

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
  ): Promise<{ decision: RouteDecision; text: string; title?: string }> {
    const s = this.state(tabId);
    const override = parseOverride(message);
    const text = override.text;

    if (override.model) {
      const pick: Pick = { model: override.model, effort: override.effort ?? 'high' };
      return { decision: this.record(tabId, pick, 'override', 'you asked for it'), text };
    }

    const auto = await this.auto(s, text, files, title);
    let { pick, source, why } = auto;
    if (override.effort) {
      pick = { ...pick, effort: override.effort };
      source = 'override';
      why = `effort you asked for; ${why}`;
    }
    if (why !== 'small talk') s.task = { pick, why, at: Date.now() };
    return { decision: this.record(tabId, pick, source, why, auto.c), text, ...(auto.c?.title ? { title: auto.c.title } : {}) };
  }

  private async auto(
    s: TabState,
    text: string,
    files: Attachment[],
    title?: string,
  ): Promise<{ pick: Pick; source: RouteSource; why: string; c?: Classification }> {
    const rule = instantRules(text, files);
    if (rule?.kind === 'decide') return { pick: rule.pick, source: 'rule', why: rule.why };

    if (!rule && s.task && isFollowUp(text, files, s.task.at)) {
      const up = s.failed ? stepUp(s.task.pick, this.allowFable()) : null;
      if (up) return { pick: up, source: 'followup', why: `stepped up after the last turn failed (${s.task.why})` };
      return { pick: s.task.pick, source: 'followup', why: `same task (${s.task.why})` };
    }

    const c = await this.classify(text, files, s.task?.why, title);
    if (!c) {
      const pick = rule ? atLeast(AUTO_FALLBACK, rule.pick) : AUTO_FALLBACK;
      return { pick, source: 'fallback', why: 'the classifier didn’t answer, so the default' };
    }
    const table = pickFor(c, this.weeklyUsed(), this.allowFable());
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
