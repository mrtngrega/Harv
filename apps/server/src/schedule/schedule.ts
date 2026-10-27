import type { Schedule } from '@harv/shared';

// Scheduled tasks (docs/PLAN.md §6s C4): pure timing, tested with a fixed clock.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** The shortest repeat: anything faster would eat the plan. */
export const MIN_EVERY_MINUTES = 5;

const at = (base: Date, hh: number, mm: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);

/** When a schedule runs next, strictly after `after` (epoch ms), or null when it never does again. */
export function nextRun(schedule: Schedule, after: number, created = after): number | null {
  switch (schedule.kind) {
    case 'once':
      return schedule.at > after ? schedule.at : null;
    case 'every': {
      const step = Math.max(MIN_EVERY_MINUTES, schedule.minutes) * 60_000;
      const n = Math.floor((after - created) / step) + 1;
      return created + Math.max(1, n) * step;
    }
    case 'daily': {
      const [hh = 0, mm = 0] = schedule.time.split(':').map(Number);
      const days = schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
      const from = new Date(after);
      for (let i = 0; i < 8; i++) {
        const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
        const when = at(day, hh, mm);
        if (when.getTime() > after && days.includes(when.getDay())) return when.getTime();
      }
      return null;
    }
  }
}

/** The schedule in plain words ("every day at 08:00", "Mon, Wed at 18:30", "once, 28 Oct 09:00"). */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'once':
      return `once, ${new Date(schedule.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    case 'every':
      return schedule.minutes % 60 === 0 ? `every ${schedule.minutes / 60} h` : `every ${schedule.minutes} min`;
    case 'daily': {
      const days = schedule.days?.length && schedule.days.length < 7 ? schedule.days : null;
      const which = days ? days.map((d) => DAY_NAMES[d]![0]!.toUpperCase() + DAY_NAMES[d]!.slice(1)).join(', ') : 'every day';
      return `${which} at ${schedule.time}`;
    }
  }
}

/** What the schedule_task tool takes. Exactly one of at / in_minutes / every_minutes / daily_at. */
export interface ScheduleInput {
  at?: string;
  in_minutes?: number;
  every_minutes?: number;
  daily_at?: string;
  weekdays?: string[];
}

/** The tool's arguments as a schedule, or an error to tell the model. */
export function parseSchedule(input: ScheduleInput, now: number): Schedule | { error: string } {
  const given = [input.at, input.in_minutes, input.every_minutes, input.daily_at].filter((v) => v !== undefined && v !== '');
  if (given.length !== 1) return { error: 'Give exactly one of at, in_minutes, every_minutes or daily_at.' };
  if (input.in_minutes !== undefined) {
    if (!(input.in_minutes >= 1)) return { error: 'in_minutes must be at least 1.' };
    return { kind: 'once', at: now + Math.round(input.in_minutes * 60_000) };
  }
  if (input.at !== undefined) {
    const when = new Date(input.at).getTime();
    if (Number.isNaN(when)) return { error: `"${input.at}" isn't a date and time (use 2026-10-28T08:00, local time).` };
    if (when <= now) return { error: 'That time has passed already.' };
    return { kind: 'once', at: when };
  }
  if (input.every_minutes !== undefined) {
    if (!(input.every_minutes >= MIN_EVERY_MINUTES))
      return { error: `every_minutes must be at least ${MIN_EVERY_MINUTES} (each run uses the user's plan).` };
    return { kind: 'every', minutes: Math.round(input.every_minutes) };
  }
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(input.daily_at ?? '');
  if (!m) return { error: `daily_at must be HH:MM (24-hour), not "${input.daily_at}".` };
  const days: number[] = [];
  for (const w of input.weekdays ?? []) {
    const d = DAY_NAMES.indexOf(w.trim().slice(0, 3).toLowerCase());
    if (d === -1) return { error: `Unknown weekday "${w}" (use mon, tue, wed, thu, fri, sat, sun).` };
    if (!days.includes(d)) days.push(d);
  }
  return { kind: 'daily', time: `${m[1]!.padStart(2, '0')}:${m[2]}`, ...(days.length ? { days: days.sort() } : {}) };
}
