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
import { buildContent, deleteAttachments } from './attachments.ts';
import { ChatSession } from './session.ts';

const titleFrom = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

/** What "Try harder" asks Claude; the chat shows just "Try harder." */
const HARDER_PROMPT =
  'Try that again, harder. Look at your last answer critically, think it through more carefully and thoroughly, fix anything wrong or missing, and give your best answer.';

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
  catalog: Catalog | null = null;

  constructor(
    private store: ChatStore,
    private gate: SafetyGate,
    private router: Router,
    private broadcast: (msg: ChatServerMessage) => void,
    private onStatus: (status: HarvStatus) => void,
  ) {}

  get status(): HarvStatus {
    const all = [...this.sessions.values()];
    if (this.gate.waiting > 0) return 'waiting';
    if (all.some((s) => s.toolRunning)) return 'working';
    if (all.some((s) => s.busy) || this.routing.size > 0) return 'thinking';
    return 'idle';
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
        this.tags.set(msg.tabId, { tag: `${msg.model.split(' ')[0]!.toLowerCase()}·${msg.effort}`, reason: msg.reason });
        break;
      case 'chat.assistant':
        save({ kind: 'harv', text: msg.text, ...this.tags.get(msg.tabId) });
        break;
      case 'chat.tool':
        save({ kind: 'tool', text: msg.detail ? `${msg.name} · ${msg.detail}` : msg.name, ref: msg.id });
        break;
      case 'chat.notice':
        save({ kind: 'notice', text: msg.message });
        break;
      case 'chat.error':
        save({ kind: 'error', text: msg.message });
        break;
      case 'chat.done':
        this.router.finished(msg.tabId, msg.ok, msg.stopped);
        if (msg.stopped) save({ kind: 'notice', text: 'Stopped.' });
        if (msg.error) save({ kind: 'error', text: msg.error });
        break;
    }
    this.broadcast(msg);
  };

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
    );
    this.sessions.set(tabId, session);
    return session;
  }

  async send(tabId: string, message: string, choice: ModelChoice, effort: EffortLevel, files: Attachment[] = []): Promise<void> {
    const isNew = !this.store.exists(tabId);
    this.store.ensureChat(tabId, titleFrom(message || (files[0]?.name ?? 'Attachment')));
    this.store.setOpen(tabId, true);
    if (this.busy(tabId)) {
      this.broadcast({ type: 'chat.notice', tabId, message: 'Harv is still answering in this tab. Wait, or press Stop.' });
      return;
    }
    this.store.addLine(tabId, { kind: 'you', text: message, ...(files.length ? { files: files.map((f) => f.name) } : {}) });
    if (isNew) this.publishHistory();

    let decision: RouteDecision;
    let text: string;
    if (choice === 'auto') {
      this.setRouting(tabId, true);
      try {
        ({ decision, text } = await this.router.route(tabId, message, files));
      } finally {
        this.setRouting(tabId, false);
      }
    } else {
      // `/opus`-style words work in manual mode too, for one message.
      const override = parseOverride(message);
      text = override.text;
      decision = override.model || override.effort
        ? { model: override.model ?? choice, effort: override.effort ?? effort, source: 'override', reason: 'you asked for it' }
        : { model: choice, effort, source: 'manual', reason: 'your pick' };
    }
    await this.run(tabId, decision, choice === 'auto', files.length ? buildContent(tabId, text, files) : text);
  }

  /** "Try harder": the last message again, one step up the ladder. */
  async harder(tabId: string): Promise<void> {
    if (!this.store.exists(tabId)) return;
    if (this.busy(tabId)) {
      this.broadcast({ type: 'chat.notice', tabId, message: 'Harv is still answering in this tab. Wait, or press Stop.' });
      return;
    }
    const from = this.lastRun.get(tabId) ?? this.lastTagged(tabId);
    if (!from) return;
    const decision = this.router.harder(tabId, from);
    if (!decision) {
      this.emit({ type: 'chat.notice', tabId, message: 'Already at the top (opus·max), so there’s no harder to try.' });
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
