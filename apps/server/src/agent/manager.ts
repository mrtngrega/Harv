import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import {
  type Attachment,
  type Catalog,
  type ChatServerMessage,
  type EffortLevel,
  type HarvStatus,
  type ModelChoice,
  type QueuedMessage,
  type RouteDecision,
  type SlashCommandInfo,
  type StoredLine,
  AUTO_FALLBACK,
} from '@harv/shared';
import type { Router } from '../router/router.ts';
import { parseOverride } from '../router/rules.ts';
import type { SafetyGate } from '../safety/gate.ts';
import type { ChatStore } from '../store/chats.ts';
import { SHARED_FILES, type RemoteChanges } from '../sync/engine.ts';
import { cloneProject, createGitHubRepo, planLink, pullNotice, pullProject, remoteOf, sameRemote } from '../sync/projects.ts';
import type { UsageMeter } from '../usage/meter.ts';
import { buildContent, cleanAttachments, deleteAttachments } from './attachments.ts';
import { sideQuestion } from './btw.ts';
import { commandName, hiddenReason } from './commands.ts';
import { formatTranscript, type HandOff, type ProjectTools } from './chatTools.ts';
import { osPath, pathKey } from '../platform.ts';
import { loadSettings, projectsDir } from '../settings.ts';
import type { ProjectServerMessage, SharedUi } from '@harv/shared';
import { ChatSession } from './session.ts';

/** One /report note for harv_report.md: `- [25 Oct 13:05 · PC · chat name] text`, on one line. */
export function ideaLine(text: string, at: Date, device: string, chat: string): string {
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `- [${day} ${time} · ${device} · ${chat.replace(/\s+/g, ' ').trim()}] ${text.replace(/\s+/g, ' ').trim()}`;
}

/** The first CLAUDE.md of a project Harv starts; the project chat fills it in as decisions are made. */
export function starterClaudeMd(name: string, description: string): string {
  return [
    `# ${name}`,
    '',
    description.trim() || 'A new project.',
    '',
    '## Status',
    '',
    `Started ${new Date().toISOString().slice(0, 10)}. Nothing built yet.`,
    '',
    '## Stack',
    '',
    'Not decided yet.',
    '',
    '## Commands',
    '',
    'None yet.',
    '',
  ].join('\n');
}

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

/** A message typed while its chat was busy; it runs when the turn ends (like Claude Code's queue). */
/** How an attachment is named on the user's line: an upload by its name, a file or folder on the PC by its full path (the gate trusts those). */
const lineName = (f: Attachment) => f.path ?? f.name;

type FollowUp = QueuedMessage & { message: string; choice: ModelChoice; effort: EffortLevel; attachments: Attachment[] };

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
  /** Chats that just moved into or out of a project: the conversation so far, given to the new session with the next message. */
  private carry = new Map<string, string>();
  /** Chats whose project changed mid-turn: their session ends when the turn does. */
  private switchAfterTurn = new Set<string>();
  /** Old sessions about to go (their turn just ended): a message arriving first makes it happen at once, so it never lands in the old one. */
  private dropping = new Set<string>();
  /** Tag and routing reason of the turn currently running per tab ("sonnet·medium"). */
  private tags = new Map<string, { tag: string; reason: string }>();
  /** The model·effort each tab's last turn ran at, for "Try harder". */
  private lastRun = new Map<string, { model: string; effort: EffortLevel }>();
  /** Answers a /btw side question (replaced in tests). */
  ask = sideQuestion;
  /** Work waiting for a plan limit to reset, sent in order when it does. */
  private queue: Queued[] = [];
  private flushing = false;
  /** Tabs whose running turn hit a plan limit; they continue after the reset. */
  private limited = new Set<string>();
  /** Tabs running /fresh, with the summary their turn writes: when it ends, the next message starts a new session from it. */
  private freshening = new Map<string, string[]>();
  /** Tabs running /clear: when it succeeds, their log empties too. */
  private clearing = new Set<string>();
  /** Resolvers waiting for a tab's turn to finish. */
  private waiters = new Map<string, (() => void)[]>();
  /** Chats waiting on a hand-off (from → to), to refuse loops. */
  private handoffs = new Map<string, string>();
  /** What a tab replies while another chat waits for it. */
  private replies = new Map<string, string[]>();
  /** Messages typed while a tab was busy, in order. */
  private followUps = new Map<string, FollowUp[]>();
  /** Each running session's slash commands (otherwise the catalog's). */
  private commands = new Map<string, SlashCommandInfo[]>();
  catalog: Catalog | null = null;

  constructor(
    private store: ChatStore,
    private gate: SafetyGate,
    private router: Router,
    private meter: UsageMeter,
    private broadcast: (msg: ChatServerMessage | ProjectServerMessage) => void,
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
    return this.store.openChats().map((chat) => {
      const queued = this.queuedOf(chat.id);
      const commands = this.commands.get(chat.id);
      const tasks = this.sessions.get(chat.id)?.tasks() ?? [];
      return { ...chat, ...(queued.length ? { queued } : {}), ...(commands ? { commands } : {}), ...(tasks.length ? { tasks } : {}) };
    });
  }

  private queuedOf(tabId: string): QueuedMessage[] {
    return (this.followUps.get(tabId) ?? []).map(({ id, text, files, attachments }) => ({
      id,
      text,
      ...(files?.length ? { files, attachments } : {}),
    }));
  }

  private publishQueued(tabId: string) {
    this.broadcast({ type: 'chat.queued', tabId, items: this.queuedOf(tabId) });
  }

  /** Drops a message from a tab's queue before it runs. */
  unqueue(tabId: string, id: string): void {
    const list = this.followUps.get(tabId);
    if (!list?.some((f) => f.id === id)) return;
    this.followUps.set(
      tabId,
      list.filter((f) => f.id !== id),
    );
    this.publishQueued(tabId);
  }

  /** "Send now" on a queued message: it moves to the front and the current reply stops, so it runs next. */
  async sendNow(tabId: string, id: string): Promise<void> {
    const list = this.followUps.get(tabId);
    const item = list?.find((f) => f.id === id);
    if (!list || !item) return;
    this.followUps.set(tabId, [item, ...list.filter((f) => f !== item)]);
    this.publishQueued(tabId);
    if (!this.busy(tabId)) return void this.nextFollowUp(tabId);
    // Stopping ends the turn (and denies its waiting approvals); chat.done then runs the queue's first message.
    this.gate.cancel(tabId);
    await this.sessions.get(tabId)?.stop();
  }

  /** The turn ended: the next queued message runs (a plan limit sends it to the limit queue instead). */
  private async nextFollowUp(tabId: string): Promise<void> {
    if (this.busy(tabId)) return;
    const next = this.followUps.get(tabId)?.shift();
    if (!next) return;
    this.publishQueued(tabId);
    this.addLine(tabId, { kind: 'you', text: next.message, ...(next.files?.length ? { files: next.files } : {}) });
    await this.begin(tabId, next.message, next.choice, next.effort, next.attachments, false);
    // A message that ended without a turn (a refused command, a plan limit) lets the next one go too.
    if (!this.busy(tabId) && this.followUps.get(tabId)?.length) setTimeout(() => void this.nextFollowUp(tabId), 0);
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
        this.freshening.get(msg.tabId)?.push(msg.text);
        break;
      case 'chat.tool':
        save({ kind: 'tool', text: msg.detail ? `${msg.name} · ${msg.detail}` : msg.name, ref: msg.id });
        break;
      case 'chat.notice':
        save({ kind: 'notice', text: msg.message });
        break;
      case 'chat.thinking':
        save({ kind: 'thinking', text: msg.text, tag: `${msg.seconds}s` });
        break;
      case 'chat.context':
        this.store.setContext(msg.tabId, msg.tokens);
        break;
      case 'chat.error':
        save({ kind: 'error', text: msg.message });
        this.replies.get(msg.tabId)?.push(`(error: ${msg.message})`);
        break;
      case 'chat.done':
        this.gate.turnEnded(msg.tabId);
        this.router.finished(msg.tabId, msg.ok, msg.stopped, msg.usage);
        this.meter.turnFinished();
        this.turnEnded(msg.tabId);
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
      const fresh = this.freshening.get(msg.tabId);
      if (fresh) {
        this.freshening.delete(msg.tabId);
        // The summary is what the turn said last (anything before it was about saving memory).
        const summary = fresh.at(-1)?.trim();
        if (msg.ok && summary) this.startFresh(msg.tabId, summary);
        else if (!msg.stopped) this.notice(msg.tabId, 'Couldn’t write the handoff summary, so this chat keeps its session.');
      }
      if (this.clearing.delete(msg.tabId) && msg.ok) {
        this.store.clearLines(msg.tabId);
        this.router.forget(msg.tabId);
        this.broadcast({ type: 'chat.cleared', tabId: msg.tabId });
      }
      for (const resolve of this.waiters.get(msg.tabId) ?? []) resolve();
      this.waiters.delete(msg.tabId);
      // Whatever ended the turn (done, error or Stop), the next queued message runs.
      if (this.followUps.get(msg.tabId)?.length) setTimeout(() => void this.nextFollowUp(msg.tabId), 0);
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
    if (this.dropping.delete(tabId)) this.dropSession(tabId);
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
        onAutoTurn: () => {
          // Shown and logged as a turn of its own, at the model and effort the session runs.
          const last = this.lastRun.get(tabId) ?? this.lastTagged(tabId) ?? AUTO_FALLBACK;
          const decision: RouteDecision = {
            model: last.model,
            effort: last.effort,
            source: 'background',
            reason: 'Harv picked this up by itself: a background task it started has finished.',
          };
          this.router.manual(tabId, decision);
          this.emit({
            type: 'chat.started',
            tabId,
            model: this.modelName(last.model),
            effort: last.effort,
            auto: false,
            reason: decision.reason,
          });
        },
        onCommands: (commands) => {
          this.commands.set(tabId, commands);
          this.broadcast({ type: 'chat.commands', tabId, commands });
        },
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
      { project: this.store.projectOf(tabId), projects: this.projectTools },
    );
    this.sessions.set(tabId, session);
    return session;
  }

  async send(tabId: string, message: string, choice: ModelChoice, effort: EffortLevel, sent: Attachment[] = []): Promise<void> {
    // Files and folders on the PC are checked here (the dashboard only names them).
    const files = cleanAttachments(sent);
    const isNew = !this.store.exists(tabId);
    // Leave `/opus`-style override words out of the title.
    this.store.ensureChat(tabId, titleFrom(parseOverride(message).text.trim() || message || (files[0]?.name ?? 'Attachment')));
    this.store.setOpen(tabId, true);
    // /btw: a side question, answered right away even while Harv works (it never queues or interrupts).
    const btw = /^\/btw(?:\s+([\s\S]*))?$/i.exec(message.trim());
    if (btw && !files.length) {
      if (isNew) this.publishHistory();
      return this.btw(tabId, (btw[1] ?? '').trim());
    }
    // /report: a note for the user's harv_report.md, written right here (no model call, never queued).
    const report = /^\/report(?:\s+([\s\S]*))?$/i.exec(message.trim());
    if (report && !files.length) {
      if (isNew) this.publishHistory();
      return this.report(tabId, (report[1] ?? '').trim());
    }
    if (this.busy(tabId) || this.followUps.get(tabId)?.length) {
      // Like Claude Code: what's typed while Harv works waits its turn, and runs when this one ends.
      const list = this.followUps.get(tabId) ?? [];
      const names = files.map(lineName);
      list.push({
        id: randomUUID(),
        text: message,
        ...(names.length ? { files: names } : {}),
        message,
        choice,
        effort,
        attachments: files,
      });
      this.followUps.set(tabId, list);
      this.publishQueued(tabId);
      if (!this.busy(tabId)) void this.nextFollowUp(tabId);
      return;
    }
    this.store.addLine(tabId, { kind: 'you', text: message, ...(files.length ? { files: files.map(lineName) } : {}) });
    if (isNew) this.publishHistory();
    await this.begin(tabId, message, choice, effort, files, isNew);
  }

  /** Runs a message whose "you" line is already in the chat: queued for a plan limit, a slash command, or a routed turn. */
  private async begin(tabId: string, message: string, choice: ModelChoice, effort: EffortLevel, files: Attachment[], isNew: boolean) {
    // A plan limit is hit (or this tab still has queued work): wait for the reset instead of sending.
    if (this.meter.paused || this.queue.some((q) => q.tabId === tabId)) {
      this.enqueue({ tabId, kind: 'send', message, choice, effort, files });
      this.emit({ type: 'chat.notice', tabId, message: `Claude Pro limit reached, so this is queued. Harv sends it ${this.resetText()}.` });
      // Ends the thinking line the dashboard shows on send.
      this.broadcast({ type: 'chat.done', tabId, ok: true, stopped: false });
      return;
    }
    if (/^\/fresh\s*$/i.test(message.trim()) && !files.length) {
      await this.fresh(tabId);
      return;
    }
    const command = commandName(message);
    if (command && !files.length && this.isCommand(tabId, command)) {
      await this.runCommand(tabId, command, message.trim());
      return;
    }
    await this.start(tabId, message, choice, effort, files);
    // Manual mode and a one-message model override (/haiku …) skip the classifier, so a new chat gets its short name from one cheap call.
    if (isNew && (choice !== 'auto' || parseOverride(message).model)) {
      void this.router.name(parseOverride(message).text, files).then((title) => title && this.autoTitle(tabId, title));
    }
  }

  /** Where /report writes: harv_report.md, which the sync keeps in step between devices (replaced in tests). */
  ideasFile = SHARED_FILES.ideas!;

  /** /report: appends a dated note to harv_report.md, which device sync carries to the other devices. */
  private report(tabId: string, text: string) {
    this.addLine(tabId, { kind: 'you', text: text ? `/report ${text}` : '/report' });
    if (!text) return this.notice(tabId, 'Write the note after it: /report the explorer forgets my folder after a restart');
    try {
      const before = existsSync(this.ideasFile) ? readFileSync(this.ideasFile, 'utf8') : '';
      const line = ideaLine(text, new Date(), loadSettings().deviceName || hostname(), this.store.title(tabId) ?? 'chat');
      appendFileSync(this.ideasFile, `${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8');
      this.notice(tabId, 'Noted in harv_report.md.');
    } catch (err) {
      this.notice(tabId, `Couldn’t write harv_report.md: ${(err as Error).message}`);
    }
  }

  /** /btw: answered from a fork of this chat's session (see btw.ts); both lines go in the log, not in Claude's context. */
  private async btw(tabId: string, question: string) {
    this.addLine(tabId, { kind: 'you', text: question ? `/btw ${question}` : '/btw' });
    if (!question) return this.notice(tabId, 'Ask a side question after it: /btw what does that error mean?');
    if (this.meter.paused)
      return this.notice(tabId, `Claude Pro limit reached, so /btw can’t answer until ${this.resetText().replace(/^when /, '')}.`);
    const last = this.lastRun.get(tabId) ?? this.lastTagged(tabId) ?? AUTO_FALLBACK;
    const answer = await this.ask(
      question,
      last.model,
      {
        store: this.store,
        tabId,
        gate: this.gate,
        project: this.store.projectOf(tabId),
        projects: this.projectTools,
      },
      this.store.getSession(tabId) ?? undefined,
    );
    if (!this.store.exists(tabId)) return;
    if (typeof answer !== 'string' || !answer) {
      const why = typeof answer === 'string' ? 'no answer came back' : answer.error;
      return this.notice(tabId, `Couldn’t answer that side question (${why}). Try again, or ask it as a normal message.`);
    }
    this.addLine(tabId, {
      kind: 'harv',
      text: answer,
      tag: `btw·${this.modelName(last.model).split(' ')[0]!.toLowerCase()}`,
      reason: 'A side question (/btw): answered from this chat without interrupting it, and not added to it.',
    });
  }

  /** A Claude Code slash command this chat offers (or one Harv refuses), as opposed to a `/opus`-style word or a path. */
  private isCommand(tabId: string, name: string): boolean {
    if (hiddenReason(name)) return true;
    const list = this.commands.get(tabId) ?? this.catalog?.commands ?? [];
    return list.some((c) => c.name === name);
  }

  /**
   * A slash command goes to Claude Code exactly as typed, at the chat's last model·effort
   * (no router: the classifier can't judge "/compact", and skipping it saves a call).
   */
  private async runCommand(tabId: string, name: string, text: string) {
    const refused = hiddenReason(name);
    if (refused) {
      this.emit({ type: 'chat.notice', tabId, message: `Harv doesn’t run /${name}. ${refused}` });
      this.broadcast({ type: 'chat.done', tabId, ok: true, stopped: false });
      return;
    }
    if (name === 'clear') this.clearing.add(tabId);
    const last = this.lastRun.get(tabId) ?? this.lastTagged(tabId) ?? AUTO_FALLBACK;
    const decision: RouteDecision = { model: last.model, effort: last.effort, source: 'command', reason: `Claude Code command /${name}` };
    this.router.manual(tabId, decision);
    await this.run(tabId, decision, false, text, true);
  }

  /**
   * /fresh (the user's wish 2026-10-25; /clear stays): one turn at the chat's model saves
   * what's worth keeping and writes a handoff summary; when it ends, the next message
   * starts a new Claude session with that summary instead of the whole conversation.
   */
  private async fresh(tabId: string) {
    if (!this.store.getSession(tabId)) {
      this.emit({ type: 'chat.notice', tabId, message: 'This chat has no session yet, so it’s already fresh.' });
      this.broadcast({ type: 'chat.done', tabId, ok: true, stopped: false });
      return;
    }
    this.freshening.set(tabId, []);
    const last = this.lastRun.get(tabId) ?? this.lastTagged(tabId) ?? AUTO_FALLBACK;
    const decision: RouteDecision = {
      model: last.model,
      effort: last.effort,
      source: 'command',
      reason: '/fresh: saving memory and a handoff summary',
    };
    this.router.manual(tabId, decision);
    const project = this.store.projectOf(tabId);
    await this.run(
      tabId,
      decision,
      false,
      [
        '[/fresh: the user is moving this chat to a fresh session to keep it small. The next session sees only what you write now, not this conversation.]',
        `1. Save anything worth keeping that isn't saved yet: facts about the user with remember${project ? ", and the project's state in its memory and CLAUDE.md, as you normally would" : ''}. Skip this if nothing is new.`,
        '2. Then end with ONE message that is only the handoff summary for your next session, no preamble: what we are working on, decisions made, where things stand (files, commands, results), open questions, and the exact next step. Keep names, paths and numbers exact. At most about 400 words.',
      ].join('\n'),
      true,
    );
  }

  /** The /fresh turn ended with its summary: the old session goes, and the next message starts from the summary. */
  private startFresh(tabId: string, summary: string) {
    this.carry.set(
      tabId,
      `[This chat moved to a fresh session (/fresh) to keep it small. Your handoff summary from the previous session:]\n${summary}\n[End of the summary. Earlier lines are still in the chat's history (read_chat) if you need them.]\n\n`,
    );
    this.store.setSession(tabId, null);
    setTimeout(() => this.dropSession(tabId), 0);
    this.router.forget(tabId);
    this.store.setContext(tabId, 0);
    this.broadcast({ type: 'chat.context', tabId, tokens: 0 });
    this.addLine(tabId, { kind: 'notice', text: '— fresh session — (the next message starts a new session from the summary above)' });
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
    // A chat that just changed project starts a new session: it gets the conversation so far as context.
    const carried = this.carry.get(tabId);
    const stale = this.store.takeStale(tabId);
    if (carried) {
      this.carry.delete(tabId);
      note = carried + note;
    } else if (stale) {
      // The chat went on on the user's other device, which this device's Claude session never saw.
      const lines = this.store.snapshot(tabId)?.lines ?? [];
      if (lines.at(-1)?.kind === 'you') lines.pop();
      if (lines.length) {
        note = `[This chat continued on the user's other device, so this is a new session here. The conversation so far, for context:]\n${formatTranscript(lines.slice(-30)).slice(-8000)}\n[End of the earlier conversation.]\n\n${note}`;
      }
    }
    let decision: RouteDecision;
    let text: string;
    // "thinking" from routing until the session has the message, so the status pill doesn't blink idle in between.
    this.setRouting(tabId, true);
    try {
      if (choice === 'auto') {
        // A new chat's title is just its first message, not a name worth keeping.
        const current = this.store.title(tabId);
        const named = current && current !== titleFrom(parseOverride(message).text.trim() || message) ? current : undefined;
        const routed = await this.router.route(tabId, message, files, named, {
          project: !!this.store.projectOf(tabId),
          recent: this.recentForRouter(tabId),
        });
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

  /**
   * The last few lines before the message being routed (it's already the chat's last line),
   * cut short, so the classifier sees what a "now do that" refers to without costing much.
   */
  private recentForRouter(tabId: string): string | undefined {
    const lines = (this.store.snapshot(tabId)?.lines ?? []).filter((l) => l.kind === 'you' || l.kind === 'harv');
    if (lines.at(-1)?.kind === 'you') lines.pop();
    const recent = lines.slice(-4).map((l) => {
      const text = l.text.replace(/\s+/g, ' ').trim();
      return `${l.kind === 'you' ? 'User' : 'Harv'}: ${text.length > 220 ? `${text.slice(0, 219)}…` : text}`;
    });
    return recent.length ? recent.join('\n') : undefined;
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

  private async run(tabId: string, decision: RouteDecision, auto: boolean, content: Parameters<ChatSession['send']>[0], raw = false) {
    const { model, effort } = decision;
    const session = this.session(tabId, model, effort);
    this.lastRun.set(tabId, { model, effort });
    this.emit({ type: 'chat.started', tabId, model: this.modelName(model), effort, auto, reason: decision.reason });
    try {
      await session.send(content, model, effort, raw);
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

  /** Stops one background task of a chat (the strip's ■), leaving the reply running. */
  async stopTask(tabId: string, taskId: string): Promise<void> {
    await this.sessions.get(tabId)?.stopTask(taskId);
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
    this.followUps.delete(tabId);
    this.commands.delete(tabId);
    this.gate.cancel(tabId);
    this.sessions.get(tabId)?.close();
    this.sessions.delete(tabId);
    if (this.store.exists(tabId)) {
      // A chat without messages (a renamed tool tab, an untouched project chat) isn't worth keeping.
      if (this.store.snapshot(tabId)?.lines.length) this.store.setOpen(tabId, false);
      else this.store.delete(tabId);
      this.publishHistory();
    }
    // Every window drops the tab, not only the one that closed it (the app and a browser tab side by side).
    this.broadcast({ type: 'chat.removed', tabId });
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
    this.followUps.delete(tabId);
    this.commands.delete(tabId);
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

  /**
   * Changes from the user's other device (sync, docs/PLAN.md §6m): the dashboards catch up, and
   * a Claude session that missed lines ends, so the next message starts one with the chat so far.
   */
  remote(changes: RemoteChanges): void {
    const restart = (id: string) => {
      if (this.busy(id)) this.switchAfterTurn.add(id);
      else this.dropSession(id);
    };
    for (const id of changes.deleted) {
      this.dequeueTab(id);
      this.followUps.delete(id);
      this.commands.delete(id);
      this.gate.cancel(id);
      this.dropSession(id);
      this.router.forget(id);
      this.lastRun.delete(id);
      deleteAttachments(id);
      this.broadcast({ type: 'chat.removed', tabId: id });
    }
    for (const id of changes.cleared) {
      this.router.forget(id);
      restart(id);
      this.broadcast({ type: 'chat.cleared', tabId: id });
    }
    for (const id of changes.moved) {
      restart(id);
      this.broadcast({ type: 'chat.project', tabId: id, projectId: this.store.projectOf(id)?.id ?? null });
    }
    for (const [id, title] of changes.renamed) this.broadcast({ type: 'chat.renamed', tabId: id, title });
    for (const [id, lines] of changes.lines) {
      restart(id);
      for (const line of lines) this.broadcast({ type: 'chat.line', tabId: id, line });
    }
    if (changes.history) this.publishHistory();
    if (changes.projects.length) void this.applyRemoteProjects(changes.projects);
    this.onStatus(this.status);
  }

  // ── Project mode (docs/PLAN.md §6f) ──

  private publishProjects() {
    this.broadcast({ type: 'projects', projects: this.store.projects() });
  }

  private dropSession(tabId: string) {
    this.sessions.get(tabId)?.close();
    this.sessions.delete(tabId);
  }

  /** The turn that changed a chat's project has ended: its old session goes. */
  turnEnded(tabId: string): void {
    if (!this.switchAfterTurn.delete(tabId)) return;
    this.dropping.add(tabId);
    setTimeout(() => {
      if (this.dropping.delete(tabId)) this.dropSession(tabId);
    }, 0);
  }

  /**
   * Binds a chat to a project (or back to a plain assistant chat with null). A Claude
   * session can't move folders, so the next message starts a new one, with the
   * conversation so far as context. Returns an error message, if any.
   */
  setProject(tabId: string, projectId: string | null): string | undefined {
    const project = this.store.project(projectId);
    if (projectId && !project) return 'There is no such project.';
    this.store.ensureChat(tabId, 'New chat');
    this.store.setOpen(tabId, true);
    if ((this.store.projectOf(tabId)?.id ?? null) === (project?.id ?? null)) return undefined;
    this.store.setProject(tabId, project?.id ?? null);
    const lines = this.store.snapshot(tabId)?.lines ?? [];
    if (lines.length) {
      const what = project ? `moved into the project "${project.name}" (${project.path})` : 'left project mode';
      const earlier = formatTranscript(lines.slice(-30)).slice(-8000);
      this.carry.set(
        tabId,
        `[This chat just ${what}. The conversation so far, for context:]\n${earlier}\n[End of the earlier conversation.]\n\n`,
      );
    }
    this.store.setSession(tabId, null);
    if (this.busy(tabId)) this.switchAfterTurn.add(tabId);
    else this.dropSession(tabId);
    if (project) void this.pullOnOpen(project.id);
    this.broadcast({ type: 'chat.project', tabId, projectId: project?.id ?? null });
    this.publishHistory();
    return undefined;
  }

  /** Adds an existing folder as a project. */
  addProject(path: string, name?: string): string | undefined {
    const folder = osPath.normalize(path.trim());
    if (!osPath.isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) return `No folder at ${path}.`;
    const project = this.store.addProject(name?.trim() || osPath.basename(folder), folder);
    this.publishProjects();
    void this.noteRemote(project.id, folder);
    return undefined;
  }

  removeProject(id: string, fromSync = false): void {
    for (const chat of this.store.openChats()) if (chat.projectId === id) this.setProject(chat.id, null);
    this.store.removeProject(id, fromSync);
    this.publishProjects();
    this.publishHistory();
  }

  // ── Project sync (docs/PLAN.md §6n, item 5): projects follow the user to their other devices ──

  /** Makes a new project's GitHub repo and returns its remote; replaced in tests. */
  createRepo = createGitHubRepo;
  private pulling = false;
  /** After each pull: which projects have work here the other device can't get yet (sync tells it). */
  onProjectStates?: (states: Record<string, boolean>) => void;
  /** Projects with unpushed work on the other device, already told ("name@device"). */
  private peerUnsaved = new Set<string>();

  /**
   * The other device has work in a project that isn't pushed yet (uncommitted, or committed
   * but not pushed), so this device's copy is behind without knowing it. Said once per change.
   */
  peerProjectState(project: string, device: string, unsaved: boolean): void {
    const key = `${project}@${device}`;
    if (!unsaved) return void this.peerUnsaved.delete(key);
    if (this.peerUnsaved.has(key)) return;
    this.peerUnsaved.add(key);
    this.projectNotice(
      `"${project}" has work on ${device} that isn't pushed yet, so it's missing here. Commit and push it there (or ask Harv there) before working on it here.`,
    );
  }

  /**
   * The other device's tabs and drafts (sync): chats it has open open here too, and ones it
   * closed close (not while they're working). The dashboards then take the order and drafts.
   */
  applyRemoteUi(ui: SharedUi): void {
    const wanted = new Set(ui.order.filter((id) => !ui.blanks.includes(id)));
    for (const id of wanted) {
      if (this.store.exists(id) && !this.store.openChats().some((c) => c.id === id)) {
        this.store.setOpen(id, true);
        const chat = this.store.snapshot(id);
        if (chat) this.broadcast({ type: 'chat.opened', chat, focus: false });
      }
    }
    for (const c of this.store.openChats()) {
      if (wanted.has(c.id) || this.busy(c.id)) continue;
      this.close(c.id);
    }
    this.publishHistory();
  }

  private projectNotice(message: string) {
    this.broadcast({ type: 'project.notice', message });
  }

  /** A project's folder has a GitHub repo: remember it, and the other devices hear about it. */
  private async noteRemote(id: string, path: string) {
    const remote = await remoteOf(path);
    if (remote) this.store.setProjectRemote(id, remote);
    this.publishProjects();
  }

  /** On start: projects added before project sync, or whose repo was made by hand, get their remotes noted. */
  async noteRemotes(): Promise<void> {
    for (const p of this.store.projects()) if (!p.remote) await this.noteRemote(p.id, p.path);
  }

  /** Projects the other device added or removed: link, clone or unlist them here, one at a time. */
  private async applyRemoteProjects(list: RemoteChanges['projects']) {
    for (const p of list) {
      try {
        if (p.removed) {
          const local = this.store.projects().find((x) => x.remote && sameRemote(x.remote, p.remote));
          if (!local) continue;
          this.removeProject(local.id, true);
          this.projectNotice(
            `"${local.name}" was removed on the other device, so it's off the list here too (its folder ${local.path} stays).`,
          );
          continue;
        }
        const plan = await planLink(p.name, p.remote, this.store.projects(), projectsDir());
        if (plan.do === 'nothing') continue;
        if (plan.do === 'conflict') {
          this.projectNotice(plan.notice);
          continue;
        }
        if (plan.do === 'link') {
          this.store.setProjectRemote(plan.project.id, p.remote, true);
          continue;
        }
        if (plan.do === 'clone') await cloneProject(p.remote, plan.path);
        const project = this.store.addProject(p.name, plan.path);
        this.store.setProjectRemote(project.id, p.remote, true);
        this.projectNotice(
          plan.do === 'clone'
            ? `New project from the other device: "${p.name}", cloned into ${plan.path}.`
            : `New project from the other device: "${p.name}" (it was already in ${plan.path}).`,
        );
      } catch (err) {
        this.projectNotice(`Couldn't bring the project "${p.name}" over from the other device: ${(err as Error).message}`);
      } finally {
        this.publishProjects();
        this.publishHistory();
      }
    }
  }

  /**
   * After each sync: pulls the other device's pushes into every project with a repo, only
   * when nothing here could be lost (pullProject checks) and none of its chats is working.
   */
  async pullProjects(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    try {
      const states: Record<string, boolean> = {};
      for (const p of this.store.projects()) {
        if (!p.remote || !existsSync(p.path)) continue;
        if (this.store.openChats().some((c) => c.projectId === p.id && this.busy(c.id))) continue;
        const result = await pullProject(p.path);
        if (result === 'pulled') this.projectNotice(`Pulled the other device's new work into "${p.name}".`);
        if (result !== 'failed' && result !== 'no-remote')
          states[p.name] = result === 'dirty' || result === 'unpushed' || result === 'diverged';
      }
      this.onProjectStates?.(states);
    } finally {
      this.pulling = false;
    }
  }

  /** Opening a project: bring it up to date first, or say why not. */
  private async pullOnOpen(projectId: string) {
    const p = this.store.project(projectId);
    if (!p?.remote || !existsSync(p.path)) return;
    const result = await pullProject(p.path);
    const notice = result === 'pulled' ? `Pulled the other device's new work into "${p.name}".` : pullNotice(p.name, result);
    if (notice) this.projectNotice(notice);
  }

  /** Harv's start_project / open_project / list_projects tools. */
  private projectTools: ProjectTools = {
    list: () => this.store.projects(),
    start: async (tabId, rawName, description, visibility) => {
      // Characters Windows doesn't allow in folder names (and control characters) go.
      const name = [...rawName.trim()]
        .filter((c) => c.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(c))
        .join('')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/, '');
      if (!name) return 'That name has no usable characters for a folder; pick another.';
      const path = osPath.join(projectsDir(), name);
      if (existsSync(path)) {
        return `${path} already exists. Ask the user whether to use it (open_project with that path) or pick another name.`;
      }
      mkdirSync(path, { recursive: true });
      writeFileSync(osPath.join(path, 'CLAUDE.md'), starterClaudeMd(name, description));
      let git = 'a git repository';
      try {
        await promisify(execFile)('git', ['init', '-b', 'main'], { cwd: path, windowsHide: true });
      } catch {
        git = 'no git repository (git init failed; try it in the project chat)';
      }
      const project = this.store.addProject(name, path);
      let repo = '';
      if (git === 'a git repository') {
        try {
          const remote = await this.createRepo(path, name, visibility);
          this.store.setProjectRemote(project.id, remote);
          repo = ` Its ${visibility} GitHub repo is ${remote}, with the first commit pushed, so the user's other devices get the project too.`;
        } catch (err) {
          const why = (err as Error).message.split('\n')[0];
          repo = ` Making its GitHub repo failed (${why}), so it stays on this device for now: tell the user, and once that's fixed (e.g. \`gh auth login\`), run \`gh repo create ${name} --${visibility} --source . --push\` in the project.`;
        }
      }
      this.publishProjects();
      this.setProject(tabId, project.id);
      return `Created ${path} with ${git} and a starter CLAUDE.md, and this is now a project chat for "${name}".${repo} From the user's next message you work in that folder as Claude Code. Tell the user the folder you made and suggest the first step (the stack and a short plan).`;
    },
    open: async (tabId, nameOrPath) => {
      const wanted = nameOrPath.trim();
      let project = this.store.projects().find((p) => p.name.toLowerCase() === wanted.toLowerCase());
      if (!project && osPath.isAbsolute(wanted)) {
        const error = this.addProject(wanted);
        if (error) return error;
        project = this.store.projects().find((p) => pathKey(p.path) === pathKey(osPath.normalize(wanted)));
      }
      if (!project) {
        const known =
          this.store
            .projects()
            .map((p) => p.name)
            .join(', ') || 'none yet';
        return `No project called "${wanted}" (known: ${known}). Ask the user for the folder path to add it.`;
      }
      this.setProject(tabId, project.id);
      return `This is now a project chat for "${project.name}" (${project.path}). From the user's next message you work there as Claude Code, with its CLAUDE.md and memory.`;
    },
  };

  /** Shuts down the live Claude sessions; chats stay saved and open for next time. */
  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
