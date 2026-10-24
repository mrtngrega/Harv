import { randomUUID } from 'node:crypto';
import {
  type Attachment,
  type Catalog,
  type ChatServerMessage,
  type EffortLevel,
  type HarvStatus,
  type ModelChoice,
  type RouteDecision,
  type StoredLine,
} from '@harv/shared';
import type { Router } from '../router/router.ts';
import { parseOverride } from '../router/rules.ts';
import type { SafetyGate } from '../safety/gate.ts';
import type { ChatStore } from '../store/chats.ts';
import type { UsageMeter } from '../usage/meter.ts';
import { buildContent, deleteAttachments } from './attachments.ts';
import type { HandOff } from './chatTools.ts';
import { ChatSession } from './session.ts';

const titleFrom = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

/** What "Try harder" asks Claude; the chat shows just "Try harder." */
const HARDER_PROMPT =
  'Try that again, harder. Look at your last answer critically, think it through more carefully and thoroughly, fix anything wrong or missing, and give your best answer.';

/** Sent when a turn cut off by a plan limit picks up again after the reset. */
const CONTINUE_PROMPT =
  'The Claude plan usage limit interrupted your last turn. It has reset now: continue where you left off and finish what the user asked.';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** How long a waiting hand-off waits for the other chat before giving up on getting the answer back. */
const HANDOFF_WAIT_MS = 15 * 60 * 1000;
/** The longest answer a hand-off brings back into the waiting chat. */
const HANDOFF_REPLY_CHARS = 12_000;

/** A message waiting for a plan limit to reset. */
type Queued =
  | { tabId: string; kind: 'send'; message: string; choice: ModelChoice; effort: EffortLevel; files: Attachment[] }
  | { tabId: string; kind: 'continue' };

/**
 * Owns one ChatSession per open tab, derives Harv's overall status, and records
 * every finished line in the history database so chats survive restarts.
 */
export class ChatManager {
  private sessions = new Map<string, ChatSession>();
  /** Tag and routing reason of the turn currently running per tab ("sonnet·medium"). */
  private tags = new Map<string, { tag: string; reason: string }>();
  /** The model·effort each tab's last turn ran at, for "Try harder". */
  private lastRun = new Map<string, { model: string; effort: EffortLevel }>();
  /** Work waiting for a plan limit to reset, sent in order when it does. */
  private queue: Queued[] = [];
  private flushing = false;
  /** Tabs whose running turn hit a plan limit; they continue after the reset. */
  private limited = new Set<string>();
  /** Resolvers waiting for a tab's turn to finish. */
  private waiters = new Map<string, (() => void)[]>();
  /** Chats waiting on a hand-off (from → to), to refuse loops. */
  private handoffs = new Map<string, string>();
  /** What a tab replies while another chat waits for it. */
  private replies = new Map<string, string[]>();
  catalog: Catalog | null = null;

  constructor(
    private store: ChatStore,
    private gate: SafetyGate,
    private router: Router,
    private meter: UsageMeter,
    private broadcast: (msg: ChatServerMessage) => void,
    private onStatus: (status: HarvStatus) => void,
  ) {}

  get status(): HarvStatus {
    const all = [...this.sessions.values()];
    if (this.gate.waiting > 0) return 'waiting';
    if (all.some((s) => s.toolRunning)) return 'working';
    if (all.some((s) => s.busy) || this.routing.size > 0) return 'thinking';
    if (this.meter.paused) return 'paused';
    return 'idle';
  }

  /** The running tool's name while Harv is working. */
  get statusDetail(): string | undefined {
    return [...this.sessions.values()].find((s) => s.toolRunning)?.toolName;
  }

  history(query = '') {
    return this.store.history(query);
  }

  openChats() {
    return this.store.openChats();
  }

  private modelName(id: string): string {
    return this.catalog?.models.find((m) => m.id === id)?.name ?? id;
  }

  private publishHistory() {
    this.broadcast({ type: 'history', items: this.store.history(), query: '' });
  }

  /** Records finished lines, then forwards every event to the dashboards. */
  private emit = (msg: ChatServerMessage) => {
    const save = (line: StoredLine) => 'tabId' in msg && this.store.addLine(msg.tabId, line);
    switch (msg.type) {
      case 'chat.started':
        this.meter.turnStarted();
        this.tags.set(msg.tabId, { tag: `${msg.model.split(' ')[0]!.toLowerCase()}·${msg.effort}`, reason: msg.reason });
        break;
      case 'chat.assistant':
        save({ kind: 'harv', text: msg.text, ...this.tags.get(msg.tabId) });
        this.replies.get(msg.tabId)?.push(msg.text);
        break;
      case 'chat.tool':
        save({ kind: 'tool', text: msg.detail ? `${msg.name} · ${msg.detail}` : msg.name, ref: msg.id });
        break;
      case 'chat.notice':
        save({ kind: 'notice', text: msg.message });
        break;
      case 'chat.error':
        save({ kind: 'error', text: msg.message });
        this.replies.get(msg.tabId)?.push(`(error: ${msg.message})`);
        break;
      case 'chat.done':
        this.router.finished(msg.tabId, msg.ok, msg.stopped, msg.usage);
        if (msg.usage?.inputTokens) this.store.setContext(msg.tabId, msg.usage.inputTokens);
        this.meter.turnFinished();
        if (msg.stopped) save({ kind: 'notice', text: 'Stopped.' });
        if (msg.error) save({ kind: 'error', text: msg.error });
        if (this.limited.delete(msg.tabId)) {
          this.enqueue({ tabId: msg.tabId, kind: 'continue' });
          this.emit({ type: 'chat.notice', tabId: msg.tabId, message: `Harv will pick this up where it left off ${this.resetText()}.` });
        }
        break;
    }
    this.broadcast(msg);
    if (msg.type === 'chat.done') {
      for (const resolve of this.waiters.get(msg.tabId) ?? []) resolve();
      this.waiters.delete(msg.tabId);
    }
  };

  private resetText(): string {
    const until = this.meter.snapshot().pausedUntil;
    return until ? `when the limit resets at ${clock(until)}` : 'when the limit resets';
  }

  private enqueue(item: Queued) {
    this.queue.push(item);
    this.meter.queued = this.queue.length;
    this.meter.publish();
  }

  /** Drops a tab's queued work; returns how many items were removed. */
  private dequeueTab(tabId: string): number {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.tabId !== tabId);
    this.limited.delete(tabId);
    if (this.queue.length !== before) {
      this.meter.queued = this.queue.length;
      this.meter.publish();
    }
    return before - this.queue.length;
  }

  private turnDone(tabId: string): Promise<void> {
    if (!this.busy(tabId)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.set(tabId, [...(this.waiters.get(tabId) ?? []), resolve]));
  }

  /** The limit reset: send the queued work in order, one turn at a time. */
  async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.meter.paused) {
        const item = this.queue.shift()!;
        this.meter.queued = this.queue.length;
        this.meter.publish();
        if (!this.store.exists(item.tabId)) continue;
        await this.turnDone(item.tabId);
        if (item.kind === 'send') {
          this.emit({ type: 'chat.notice', tabId: item.tabId, message: 'The limit reset, so Harv is sending your queued message.' });
          await this.start(item.tabId, item.message, item.choice, item.effort, item.files);
        } else {
          const last = this.lastRun.get(item.tabId) ?? this.lastTagged(item.tabId) ?? { model: 'sonnet', effort: 'medium' as const };
          const decision: RouteDecision = { ...last, source: 'followup', reason: 'continuing after the limit reset' };
          this.router.manual(item.tabId, decision);
          await this.run(item.tabId, decision, true, CONTINUE_PROMPT);
        }
        await this.turnDone(item.tabId);
      }
    } finally {
      this.flushing = false;
    }
  }

  private session(tabId: string, model: string, effort: EffortLevel): ChatSession {
    let session = this.sessions.get(tabId);
    if (session) return session;
    session = new ChatSession(
      tabId,
      model,
      effort,
      this.emit,
      {
        onStateChange: () => this.onStatus(this.status),
        onSessionId: (id) => this.store.setSession(tabId, id),
        onRateLimit: (info) => {
          this.meter.rateLimit(info);
          if (info.status === 'rejected') this.limited.add(tabId);
        },
        onResumeFailed: () => {
          // The old Claude transcript is gone; the next message starts a fresh session.
          this.sessions.delete(tabId);
          this.store.setSession(tabId, null);
          this.emit({
            type: 'chat.notice',
            tabId,
            message: 'Couldn’t resume the earlier conversation with Claude, so a fresh one starts. Please send that again.',
          });
        },
      },
      this.store,
      this.gate,
      this.store.getSession(tabId) ?? undefined,
      (req, signal) => this.delegate(tabId, req, signal),
    );
    this.sessions.set(tabId, session);
    return session;
  }

  async send(tabId: string, message: string, choice: ModelChoice, effort: EffortLevel, files: Attachment[] = []): Promise<void> {
    const isNew = !this.store.exists(tabId);
    // Leave `/opus`-style override words out of the title.
    this.store.ensureChat(tabId, titleFrom(parseOverride(message).text.trim() || message || (files[0]?.name ?? 'Attachment')));
    this.store.setOpen(tabId, true);
    if (this.busy(tabId)) {
      this.broadcast({ type: 'chat.notice', tabId, message: 'Harv is still answering in this tab. Wait, or press Stop.' });
      return;
    }
    this.store.addLine(tabId, { kind: 'you', text: message, ...(files.length ? { files: files.map((f) => f.name) } : {}) });
    if (isNew) this.publishHistory();

    // A plan limit is hit (or this tab still has queued work): wait for the reset instead of sending.
    if (this.meter.paused || this.queue.some((q) => q.tabId === tabId)) {
      this.enqueue({ tabId, kind: 'send', message, choice, effort, files });
      this.emit({ type: 'chat.notice', tabId, message: `Claude Pro limit reached, so this is queued. Harv sends it ${this.resetText()}.` });
      // Ends the thinking line the dashboard shows on send.
      this.broadcast({ type: 'chat.done', tabId, ok: true, stopped: false });
      return;
    }
    await this.start(tabId, message, choice, effort, files);
    // Manual mode never asks the classifier, so a new chat gets its short name from one cheap call.
    if (isNew && choice !== 'auto') {
      void this.router.name(parseOverride(message).text, files).then((title) => title && this.autoTitle(tabId, title));
    }
  }

  /** Harv's short name for what a chat is about; skipped once the user has named it. */
  private autoTitle(tabId: string, title: string) {
    if (!this.store.exists(tabId) || this.store.titleLocked(tabId) || this.store.title(tabId) === title) return;
    this.store.setTitle(tabId, title);
    this.broadcast({ type: 'chat.renamed', tabId, title });
    this.publishHistory();
  }

  /** The user renamed a chat (right-click on its tab). */
  rename(tabId: string, raw: string): void {
    const title = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!title) return;
    // A tab that hasn't sent anything yet is saved now, so its name sticks.
    this.store.ensureChat(tabId, title);
    this.store.setTitle(tabId, title, true);
    this.broadcast({ type: 'chat.renamed', tabId, title });
    this.publishHistory();
  }

  /** Adds a line the dashboard didn't write itself (it only shows the user's own messages as they're sent). */
  private addLine(tabId: string, line: StoredLine) {
    this.store.addLine(tabId, line);
    this.broadcast({ type: 'chat.line', tabId, line: { ...line, at: Date.now() } });
  }

  /**
   * The hand_off tool: `fromTab` gives a task to another chat (or a new tab). It runs
   * there as a normal AUTO turn, through that chat's own safety gate. With `wait`, the
   * answer comes back as the tool's result.
   */
  async delegate(fromTab: string, req: HandOff, signal?: AbortSignal): Promise<string> {
    const fromTitle = this.store.title(fromTab) ?? 'another chat';
    let to = req.to?.trim() || undefined;
    if (to === fromTab) return 'That is this chat. Hand off to a different chat, or leave `to` out to open a new tab.';
    if (to && !this.store.exists(to)) return `No chat with id ${to}. Use list_chats to find it, or leave \`to\` out to open a new tab.`;
    for (let at = to; at; at = this.handoffs.get(at)) {
      if (at === fromTab)
        return 'That chat is waiting for this one, so handing work back would make them wait on each other. Answer here instead.';
    }
    if (to && this.busy(to)) return `"${this.store.title(to)}" is busy right now. Try again when it's done, or hand off to a new tab.`;
    if (this.meter.paused) return `The Claude Pro limit is reached, so nothing can run until it resets (${this.resetText()}).`;

    const isNew = !to;
    to ??= randomUUID();
    if (isNew) this.store.ensureChat(to, titleFrom(req.title?.trim() || req.message));
    const wasOpen = !isNew && this.store.transcript(to, 1)?.open;
    this.store.setOpen(to, true);
    // Show the chat as a tab without pulling the user away from the one they're in.
    if (!wasOpen) this.broadcast({ type: 'chat.opened', chat: this.store.snapshot(to)!, focus: false });
    this.publishHistory();
    const title = this.store.title(to)!;

    this.addLine(to, { kind: 'notice', text: `Handed over from “${fromTitle}”${req.wait ? ', which is waiting for the answer' : ''}.` });
    this.addLine(to, { kind: 'you', text: req.message });
    const note = `[Handed over from your other chat "${fromTitle}" (id ${fromTab}). Do it as if the user asked. ${
      req.wait ? 'Your reply goes back to that chat, so make it a complete answer.' : 'The user reads your reply here.'
    }]\n\n`;

    if (req.wait) {
      this.handoffs.set(fromTab, to);
      this.replies.set(to, []);
    }
    try {
      await this.start(to, req.message, 'auto', 'medium', [], note);
      if (!req.wait) return `Started in the "${title}" tab (id ${to}). Its answer will appear there; read_chat can fetch it later.`;

      const outcome = await new Promise<'done' | 'timeout' | 'stopped'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), HANDOFF_WAIT_MS);
        signal?.addEventListener('abort', () => resolve('stopped'), { once: true });
        void this.turnDone(to).then(() => {
          clearTimeout(timer);
          resolve('done');
        });
      });
      const reply = (this.replies.get(to) ?? []).join('\n\n').trim();
      const capped = reply.length > HANDOFF_REPLY_CHARS ? `${reply.slice(0, HANDOFF_REPLY_CHARS)}…` : reply;
      if (outcome === 'stopped') return `Stopped waiting. "${title}" may still be working; its answer will appear in that tab.`;
      if (outcome === 'timeout')
        return `"${title}" is still working after 15 minutes. Its answer will appear in that tab; read_chat can fetch it later.`;
      return capped ? `Answer from "${title}" (id ${to}):\n\n${capped}` : `"${title}" finished without a written answer.`;
    } finally {
      if (req.wait) {
        this.handoffs.delete(fromTab);
        this.replies.delete(to);
      }
    }
  }

  /** Routes a message and runs it. `note` goes in front of what Claude sees (not the chat log or the router). */
  private async start(tabId: string, message: string, choice: ModelChoice, effort: EffortLevel, files: Attachment[], note = '') {
    let decision: RouteDecision;
    let text: string;
    // "thinking" from routing until the session has the message, so the status pill doesn't blink idle in between.
    this.setRouting(tabId, true);
    try {
      if (choice === 'auto') {
        // A new chat's title is just its first message, not a name worth keeping.
        const current = this.store.title(tabId);
        const named = current && current !== titleFrom(parseOverride(message).text.trim() || message) ? current : undefined;
        const routed = await this.router.route(tabId, message, files, named);
        ({ decision, text } = routed);
        if (routed.title) this.autoTitle(tabId, routed.title);
      } else {
        // `/opus`-style words work in manual mode too, for one message.
        const override = parseOverride(message);
        text = override.text;
        decision =
          override.model || override.effort
            ? { model: override.model ?? choice, effort: override.effort ?? effort, source: 'override', reason: 'you asked for it' }
            : { model: choice, effort, source: 'manual', reason: 'your pick' };
        this.router.manual(tabId, decision);
      }
      await this.run(tabId, decision, choice === 'auto', files.length ? buildContent(tabId, note + text, files) : note + text);
    } finally {
      this.setRouting(tabId, false);
    }
  }

  /** "Try harder": the last message again, one step up the ladder. */
  async harder(tabId: string): Promise<void> {
    if (!this.store.exists(tabId)) return;
    if (this.busy(tabId)) {
      this.broadcast({ type: 'chat.notice', tabId, message: 'Harv is still answering in this tab. Wait, or press Stop.' });
      return;
    }
    const from = this.lastRun.get(tabId) ?? this.lastTagged(tabId);
    if (!from || this.meter.paused) {
      if (this.meter.paused) this.emit({ type: 'chat.notice', tabId, message: `Claude Pro limit reached. Try again ${this.resetText()}.` });
      this.broadcast({ type: 'chat.done', tabId, ok: true, stopped: false });
      return;
    }
    const decision = this.router.harder(tabId, from);
    if (!decision) {
      this.emit({ type: 'chat.notice', tabId, message: 'Already at the top of the ladder, so there’s no harder to try.' });
      this.broadcast({ type: 'chat.done', tabId, ok: true, stopped: false });
      return;
    }
    this.store.addLine(tabId, { kind: 'you', text: 'Try harder.' });
    await this.run(tabId, decision, true, HARDER_PROMPT);
  }

  /** The model·effort of a chat's last reply, from its saved tag (after a restart). */
  private lastTagged(tabId: string): { model: string; effort: EffortLevel } | undefined {
    const last = this.store.snapshot(tabId)?.lines.findLast((l) => l.kind === 'harv' && l.tag);
    const [model, effort] = last?.tag?.split('·') ?? [];
    return model && effort ? { model, effort: effort as EffortLevel } : undefined;
  }

  private busy(tabId: string): boolean {
    return this.routing.has(tabId) || !!this.sessions.get(tabId)?.busy;
  }

  /** Shows "thinking" while the router's classifier runs. */
  private routing = new Set<string>();
  private setRouting(tabId: string, on: boolean) {
    if (on) this.routing.add(tabId);
    else this.routing.delete(tabId);
    this.onStatus(this.status);
  }

  private async run(tabId: string, decision: RouteDecision, auto: boolean, content: Parameters<ChatSession['send']>[0]) {
    const { model, effort } = decision;
    const session = this.session(tabId, model, effort);
    this.lastRun.set(tabId, { model, effort });
    this.emit({ type: 'chat.started', tabId, model: this.modelName(model), effort, auto, reason: decision.reason });
    try {
      await session.send(content, model, effort);
    } catch (err) {
      this.emit({ type: 'chat.error', tabId, message: `Couldn’t send: ${(err as Error).message}` });
      this.emit({ type: 'chat.done', tabId, ok: false, stopped: false });
    }
  }

  async stop(tabId: string): Promise<void> {
    const dropped = this.dequeueTab(tabId);
    if (dropped)
      this.emit({ type: 'chat.notice', tabId, message: `Removed ${dropped === 1 ? 'the queued message' : `${dropped} queued messages`}.` });
    this.gate.cancel(tabId);
    await this.sessions.get(tabId)?.stop();
  }

  /** A line from Harv itself (e.g. an Undo result) in a chat's log. */
  notice(tabId: string, message: string): void {
    if (this.store.exists(tabId)) this.emit({ type: 'chat.notice', tabId, message });
  }

  /** Harv's overall status changed outside a session (an approval arrived or was answered). */
  refreshStatus(): void {
    this.onStatus(this.status);
  }

  /** Closing a tab keeps the chat in history; its Claude session can be resumed later. */
  close(tabId: string): void {
    this.dequeueTab(tabId);
    this.gate.cancel(tabId);
    this.sessions.get(tabId)?.close();
    this.sessions.delete(tabId);
    if (this.store.exists(tabId)) {
      this.store.setOpen(tabId, false);
      this.publishHistory();
    }
    this.onStatus(this.status);
  }

  open(tabId: string): void {
    const chat = this.store.snapshot(tabId);
    if (!chat) return;
    this.store.setOpen(tabId, true);
    this.broadcast({ type: 'chat.opened', chat });
    this.publishHistory();
  }

  delete(tabId: string): void {
    this.dequeueTab(tabId);
    this.gate.cancel(tabId);
    this.sessions.get(tabId)?.close();
    this.sessions.delete(tabId);
    this.store.delete(tabId);
    this.router.forget(tabId);
    this.lastRun.delete(tabId);
    deleteAttachments(tabId);
    this.broadcast({ type: 'chat.removed', tabId });
    this.publishHistory();
    this.onStatus(this.status);
  }

  /** Shuts down the live Claude sessions; chats stay saved and open for next time. */
  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
