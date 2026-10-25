import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundTask } from '@harv/shared';

/** How long an ended task stays in the strip. */
export const ENDED_SHOWN_MS = 10 * 60 * 1000;

interface Tracked extends BackgroundTask {
  /** Running in the background (the strip shows only these; a blocking one is the reply's own tool line). */
  background: boolean;
}

const ENDED: Record<string, BackgroundTask['status']> = { completed: 'completed', failed: 'failed', killed: 'stopped', stopped: 'stopped' };

/**
 * A chat's background tasks, from the SDK's task events. `background_tasks_changed` is
 * the level signal (the full live set) and wins; the task_* edges add the details:
 * start, the last tool, the end and its summary.
 */
export class TaskTracker {
  private tasks = new Map<string, Tracked>();

  /** Takes one SDK message; true when the list changed. */
  apply(msg: SDKMessage, now = Date.now()): boolean {
    if (msg.type !== 'system') return false;
    switch (msg.subtype) {
      case 'background_tasks_changed': {
        const live = new Set<string>();
        for (const t of msg.tasks) {
          if (t.ambient) continue;
          live.add(t.task_id);
          const known = this.tasks.get(t.task_id);
          this.tasks.set(t.task_id, {
            id: t.task_id,
            kind: t.task_type,
            agent: t.subagent_type ?? known?.agent,
            description: t.description,
            startedAt: known?.startedAt ?? now,
            lastTool: known?.lastTool,
            summary: known?.summary,
            status: 'running',
            background: true,
          });
        }
        // Gone from the live set without a word about how it ended: it's over all the same.
        for (const t of this.tasks.values()) {
          if (t.status === 'running' && t.background && !live.has(t.id)) this.end(t, 'completed', now);
        }
        return true;
      }
      case 'task_started': {
        if (msg.ambient || msg.skip_transcript) return false;
        this.tasks.set(msg.task_id, {
          id: msg.task_id,
          kind: msg.task_type ?? 'task',
          agent: msg.subagent_type,
          description: msg.description,
          startedAt: now,
          status: 'running',
          background: msg.is_backgrounded === true || this.tasks.get(msg.task_id)?.background === true,
        });
        return this.tasks.get(msg.task_id)!.background;
      }
      case 'task_progress': {
        const t = this.tasks.get(msg.task_id);
        if (!t || t.status !== 'running') return false;
        t.lastTool = msg.last_tool_name ?? t.lastTool;
        if (msg.summary) t.summary = msg.summary;
        return t.background;
      }
      case 'task_updated': {
        const t = this.tasks.get(msg.task_id);
        if (!t) return false;
        if (msg.patch.is_backgrounded) t.background = true;
        if (msg.patch.description) t.description = msg.patch.description;
        const status = msg.patch.status && ENDED[msg.patch.status];
        if (status && t.status === 'running') this.end(t, status, msg.patch.end_time ?? now);
        if (msg.patch.error) t.summary = msg.patch.error;
        return t.background;
      }
      case 'task_notification': {
        const t = this.tasks.get(msg.task_id);
        if (!t || msg.ambient || msg.skip_transcript) return false;
        t.status = msg.status;
        t.endedAt = t.endedAt ?? now;
        if (msg.summary) t.summary = msg.summary;
        t.lastTool = undefined;
        return t.background;
      }
      default:
        return false;
    }
  }

  private end(t: Tracked, status: BackgroundTask['status'], at: number) {
    t.status = status;
    t.endedAt = at;
    t.lastTool = undefined;
  }

  /** What the strip shows: running background tasks, and ones that ended in the last few minutes. */
  list(now = Date.now()): BackgroundTask[] {
    for (const [id, t] of this.tasks) {
      if (t.endedAt !== undefined && now - t.endedAt > ENDED_SHOWN_MS) this.tasks.delete(id);
    }
    return [...this.tasks.values()]
      .filter((t) => t.background)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ background: _background, ...task }) => task);
  }

  get running(): number {
    return [...this.tasks.values()].filter((t) => t.background && t.status === 'running').length;
  }
}
