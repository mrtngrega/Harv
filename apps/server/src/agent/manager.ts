import { AUTO_FALLBACK, type Catalog, type ChatServerMessage, type EffortLevel, type HarvStatus, type ModelChoice } from '@harv/shared';
import { ChatSession } from './session.ts';

/** Owns one ChatSession per open tab and derives Harv's overall status. */
export class ChatManager {
  private sessions = new Map<string, ChatSession>();
  catalog: Catalog | null = null;

  constructor(
    private broadcast: (msg: ChatServerMessage) => void,
    private onStatus: (status: HarvStatus) => void,
  ) {}

  get status(): HarvStatus {
    const all = [...this.sessions.values()];
    if (all.some((s) => s.toolRunning)) return 'working';
    if (all.some((s) => s.busy)) return 'thinking';
    return 'idle';
  }

  private modelName(id: string): string {
    return this.catalog?.models.find((m) => m.id === id)?.name ?? id;
  }

  async send(tabId: string, text: string, choice: ModelChoice, effort: EffortLevel): Promise<void> {
    // AUTO becomes the real router in M6; until then it's a sensible default for Claude Pro.
    const auto = choice === 'auto';
    const model = auto ? AUTO_FALLBACK.model : choice;
    const runEffort = auto ? AUTO_FALLBACK.effort : effort;

    let session = this.sessions.get(tabId);
    if (!session) {
      session = new ChatSession(tabId, model, runEffort, this.broadcast, () => this.onStatus(this.status));
      this.sessions.set(tabId, session);
    }
    if (session.busy) {
      this.broadcast({ type: 'chat.notice', tabId, message: 'Harv is still answering in this tab. Wait, or press Stop.' });
      return;
    }
    this.broadcast({ type: 'chat.started', tabId, model: this.modelName(model), effort: runEffort, auto });
    try {
      await session.send(text, model, runEffort);
    } catch (err) {
      this.broadcast({ type: 'chat.error', tabId, message: `Couldn’t send: ${(err as Error).message}` });
      this.broadcast({ type: 'chat.done', tabId, ok: false, stopped: false });
    }
  }

  async stop(tabId: string): Promise<void> {
    await this.sessions.get(tabId)?.stop();
  }

  close(tabId: string): void {
    this.sessions.get(tabId)?.close();
    this.sessions.delete(tabId);
    this.onStatus(this.status);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
