/** When a scheduled task runs (docs/PLAN.md §6s C4). Times are the device's local time. */
export type Schedule =
  | { kind: 'once'; at: number }
  /** Every N minutes, from when it was made. */
  | { kind: 'every'; minutes: number }
  /** At HH:MM each day, or only on some weekdays (0 = Sunday … 6 = Saturday). */
  | { kind: 'daily'; time: string; days?: number[] };

/** Something Harv runs later or on a repeat, as a turn in the chat that made it. */
export interface ScheduledTask {
  id: string;
  /** The chat it runs in (reopened if it was closed). */
  tabId: string;
  title: string;
  /** What Harv is asked each time. */
  prompt: string;
  schedule: Schedule;
  /** The next run (epoch ms); null once a one-off has run. */
  nextAt: number | null;
  lastAt?: number;
  created: number;
  /** The device it runs on (it doesn't travel with sync). */
  device: string;
}

export type ScheduleClientMessage = { type: 'schedule.cancel'; id: string };

export type ScheduleServerMessage =
  /** The whole list, whenever it changes. */
  | { type: 'schedules'; tasks: ScheduledTask[] }
  /** A task just started a turn; `late`: it was due while Harv was off. */
  | { type: 'schedule.ran'; task: ScheduledTask; late: boolean };
