import {
  AUTO_FALLBACK,
  type Attachment,
  type Catalog,
  type ChatServerMessage,
  type EffortLevel,
  type HarvStatus,
  type ModelChoice,
  type StoredLine,
} from '@harv/shared';
import type { SafetyGate } from '../safety/gate.ts';
import type { ChatStore } from '../store/chats.ts';
import { buildContent, deleteAttachments } from './attachments.ts';
import { ChatSession } from './session.ts';

const titleFrom = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

/**
 * Owns one ChatSession per open tab, derives Harv's overall status, and records
 * every finished line in the history database so chats survive restarts.
 */
export class ChatManager {
  private sessions = new Map<string, ChatSession>();
  /** Tag of the turn currently running per tab ("sonnet·medium"). */
  private tags = new Map<string, string>();
  catalog: Catalog | null = null;

  constructor(
    private store: ChatStore,
    private gate: SafetyGate,
    private broadcast: (msg: ChatServerMessage) => void,
    private onStatus: (status: HarvStatus) => void,
  ) {}

  get status(): HarvStatus {
    const all = [...this.sessions.values()];
    if (this.gate.waiting > 0) return 'waiting';
    if (all.some((s) => s.toolRunning)) return 'working';
    if (all.some((s) => s.busy)) return 'thinking';
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
        this.tags.set(msg.tabId, `${msg.model.split(' ')[0]!.toLowerCase()}·${msg.effort}`);
        break;
      case 'chat.assistant':
        save({ kind: 'harv', text: msg.text, tag: this.tags.get(msg.tabId) });
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

  async send(tabId: string, text: string, choice: ModelChoice, effort: EffortLevel, files: Attachment[] = []): Promise<void> {
    // AUTO becomes the real router in M6; until then it's a sensible default for Claude Pro.
    const auto = choice === 'auto';
    const model = auto ? AUTO_FALLBACK.model : choice;
    const runEffort = auto ? AUTO_FALLBACK.effort : effort;

    const isNew = !this.store.exists(tabId);
    this.store.ensureChat(tabId, titleFrom(text || (files[0]?.name ?? 'Attachment')));
    this.store.setOpen(tabId, true);
    const session = this.session(tabId, model, runEffort);
    if (session.busy) {
      this.broadcast({ type: 'chat.notice', tabId, message: 'Harv is still answering in this tab. Wait, or press Stop.' });
      return;
    }
    this.store.addLine(tabId, { kind: 'you', text, ...(files.length ? { files: files.map((f) => f.name) } : {}) });
    if (isNew) this.publishHistory();

    this.emit({ type: 'chat.started', tabId, model: this.modelName(model), effort: runEffort, auto });
    try {
      await session.send(files.length ? buildContent(tabId, text, files) : text, model, runEffort);
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
