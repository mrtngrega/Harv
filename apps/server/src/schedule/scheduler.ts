import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Schedule, ScheduledTask, ScheduleServerMessage } from '@harv/shared';
import { describeSchedule, nextRun, parseSchedule, type ScheduleInput } from './schedule.ts';

/** A run counts as late when it starts this long after it was due (Harv or the PC was off). */
const LATE_MS = 2 * 60_000;
const TICK_MS = 30_000;

type Row = {
  id: string;
  tab_id: string;
  title: string;
  prompt: string;
  schedule: string;
  next_at: number | null;
  last_at: number | null;
  created: number;
  device: string;
};

const toTask = (r: Row): ScheduledTask => ({
  id: r.id,
  tabId: r.tab_id,
  title: r.title,
  prompt: r.prompt,
  schedule: JSON.parse(r.schedule) as Schedule,
  nextAt: r.next_at,
  ...(r.last_at ? { lastAt: r.last_at } : {}),
  created: r.created,
  device: r.device,
});

export interface SchedulerHooks {
  /** Starts the task's turn in its chat (ChatManager.runScheduled). */
  run(task: ScheduledTask, late: boolean): Promise<void> | void;
  broadcast(msg: ScheduleServerMessage): void;
}

/**
 * Harv's own scheduler (docs/PLAN.md §6s C4): tasks live in harv.db on the device that made
 * them, run as a turn in their chat, and a run missed while Harv was off happens once on start.
 */
export class Scheduler {
  private db: DatabaseSync;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    path: string,
    private hooks: SchedulerHooks,
    private device: string,
    private now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
      schedule TEXT NOT NULL, next_at INTEGER, last_at INTEGER, created INTEGER NOT NULL, device TEXT NOT NULL
    )`);
  }

  list(): ScheduledTask[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY next_at IS NULL, next_at').all() as Row[]).map(toTask);
  }

  private publish() {
    this.hooks.broadcast({ type: 'schedules', tasks: this.list() });
  }

  /** The schedule_task tool: returns what to tell the model. */
  add(tabId: string, title: string, prompt: string, input: ScheduleInput): string {
    const now = this.now();
    const schedule = parseSchedule(input, now);
    if ('error' in schedule) return `Not scheduled: ${schedule.error}`;
    const id = randomUUID().slice(0, 8);
    const nextAt = nextRun(schedule, now, now);
    this.db
      .prepare('INSERT INTO schedules (id, tab_id, title, prompt, schedule, next_at, created, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, tabId, title.trim().slice(0, 60) || prompt.slice(0, 40), prompt, JSON.stringify(schedule), nextAt, now, this.device);
    this.publish();
    const next = nextAt
      ? new Date(nextAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '—';
    const clock = new Date(now).toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `Scheduled (id ${id}): ${describeSchedule(schedule)}, first run ${next} (it's ${clock} now), as a turn in this chat on this device (it runs while Harv is on; a run missed while it's off happens once when it starts). The user sees it in Settings › Scheduled tasks and can cancel it there.`;
  }

  /** The list_scheduled tool. */
  describe(): string {
    const tasks = this.list();
    if (!tasks.length) return 'No scheduled tasks.';
    return tasks
      .map((t) => {
        const next = t.nextAt
          ? new Date(t.nextAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : 'done';
        return `- ${t.id} · "${t.title}" · ${describeSchedule(t.schedule)} · next ${next} · chat ${t.tabId}\n  ${t.prompt.slice(0, 200)}`;
      })
      .join('\n');
  }

  cancel(id: string): boolean {
    const gone = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
    if (gone) this.publish();
    return gone;
  }

  /** A deleted chat takes its tasks with it. */
  dropChat(tabId: string): void {
    if (this.db.prepare('DELETE FROM schedules WHERE tab_id = ?').run(tabId).changes > 0) this.publish();
  }

  /** Runs what's due: on start that's every run missed while Harv was off, once each. */
  tick(): void {
    const now = this.now();
    const due = (this.db.prepare('SELECT * FROM schedules WHERE next_at IS NOT NULL AND next_at <= ?').all(now) as Row[]).map(toTask);
    for (const task of due) {
      const late = now - task.nextAt! > LATE_MS;
      const next = nextRun(task.schedule, now, task.created);
      if (next === null) this.db.prepare('DELETE FROM schedules WHERE id = ?').run(task.id);
      else this.db.prepare('UPDATE schedules SET next_at = ?, last_at = ? WHERE id = ?').run(next, now, task.id);
      this.hooks.broadcast({ type: 'schedule.ran', task, late });
      void Promise.resolve(this.hooks.run(task, late)).catch(() => {});
    }
    if (due.length) this.publish();
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db.close();
  }
}
