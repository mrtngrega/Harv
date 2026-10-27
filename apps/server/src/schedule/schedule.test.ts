import { describe, expect, it } from 'vitest';
import type { ScheduledTask, ScheduleServerMessage } from '@harv/shared';
import { describeSchedule, nextRun, parseSchedule } from './schedule.ts';
import { Scheduler } from './scheduler.ts';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('when a scheduled task runs next', () => {
  it('runs a one-off once', () => {
    const at = local(2026, 10, 28, 9);
    expect(nextRun({ kind: 'once', at }, local(2026, 10, 27, 20))).toBe(at);
    expect(nextRun({ kind: 'once', at }, at)).toBeNull();
  });

  it('repeats every N minutes from when it was made, never faster than 5', () => {
    const made = local(2026, 10, 27, 10);
    expect(nextRun({ kind: 'every', minutes: 60 }, made, made)).toBe(local(2026, 10, 27, 11));
    // Missed a few while off: the next one on the grid, not a burst.
    expect(nextRun({ kind: 'every', minutes: 60 }, local(2026, 10, 27, 13, 30), made)).toBe(local(2026, 10, 27, 14));
    expect(nextRun({ kind: 'every', minutes: 1 }, made, made)).toBe(made + 5 * 60_000);
  });

  it('runs daily at a time, or only on some weekdays', () => {
    // 27 Oct 2026 is a Tuesday.
    expect(nextRun({ kind: 'daily', time: '08:00' }, local(2026, 10, 27, 7))).toBe(local(2026, 10, 27, 8));
    expect(nextRun({ kind: 'daily', time: '08:00' }, local(2026, 10, 27, 8))).toBe(local(2026, 10, 28, 8));
    expect(nextRun({ kind: 'daily', time: '18:30', days: [1, 5] }, local(2026, 10, 27, 12))).toBe(local(2026, 10, 30, 18, 30));
    expect(describeSchedule({ kind: 'daily', time: '18:30', days: [1, 5] })).toBe('Mon, Fri at 18:30');
    expect(describeSchedule({ kind: 'every', minutes: 120 })).toBe('every 2 h');
  });

  it("reads the tool's arguments and says what's wrong", () => {
    const now = local(2026, 10, 27, 12);
    expect(parseSchedule({ in_minutes: 60 }, now)).toEqual({ kind: 'once', at: now + 3_600_000 });
    expect(parseSchedule({ at: '2026-10-28T08:00' }, now)).toEqual({ kind: 'once', at: local(2026, 10, 28, 8) });
    expect(parseSchedule({ daily_at: '8:05', weekdays: ['Monday', 'fri', 'mon'] }, now)).toEqual({
      kind: 'daily',
      time: '08:05',
      days: [1, 5],
    });
    expect(parseSchedule({ every_minutes: 2 }, now)).toMatchObject({ error: expect.stringContaining('at least 5') });
    expect(parseSchedule({ at: '2026-10-01T08:00' }, now)).toMatchObject({ error: expect.stringContaining('passed') });
    expect(parseSchedule({ daily_at: '25:00' }, now)).toMatchObject({ error: expect.any(String) });
    expect(parseSchedule({ in_minutes: 5, daily_at: '08:00' }, now)).toMatchObject({ error: expect.stringContaining('exactly one') });
    // From the real clock: today, tomorrow when it has passed, or N days on.
    expect(parseSchedule({ time: '18:30' }, now)).toEqual({ kind: 'once', at: local(2026, 10, 27, 18, 30) });
    expect(parseSchedule({ time: '08:00' }, now)).toEqual({ kind: 'once', at: local(2026, 10, 28, 8) });
    expect(parseSchedule({ time: '08:00', days_from_today: 3 }, now)).toEqual({ kind: 'once', at: local(2026, 10, 30, 8) });
    expect(parseSchedule({ time: '08:00', days_from_today: 0 }, now)).toMatchObject({ error: expect.stringContaining('passed') });
  });
});

describe('the scheduler', () => {
  function setup(start: number) {
    let now = start;
    const runs: { task: ScheduledTask; late: boolean }[] = [];
    const sent: ScheduleServerMessage[] = [];
    const s = new Scheduler(
      ':memory:',
      { run: (task, late) => void runs.push({ task, late }), broadcast: (m) => sent.push(m) },
      'PC',
      () => now,
    );
    return { s, runs, sent, set: (t: number) => (now = t) };
  }

  it('runs due tasks as turns, keeps repeating ones and drops one-offs after their run', () => {
    const { s, runs, set } = setup(local(2026, 10, 27, 7, 59));
    expect(s.add('chat-1', 'Morning news', 'Tell me the news', { daily_at: '08:00' })).toMatch(/^Scheduled/);
    s.add('chat-1', 'Check build', 'Is the build green?', { in_minutes: 30 });
    set(local(2026, 10, 27, 8, 0));
    s.tick();
    expect(runs.map((r) => [r.task.title, r.late])).toEqual([['Morning news', false]]);
    set(local(2026, 10, 27, 8, 30));
    s.tick();
    expect(runs.map((r) => r.task.title)).toEqual(['Morning news', 'Check build']);
    expect(s.list().map((t) => t.title)).toEqual(['Morning news']);
    expect(s.list()[0]!.nextAt).toBe(local(2026, 10, 28, 8));
  });

  it('runs a task missed while Harv was off once, marked late', () => {
    const { s, runs, set } = setup(local(2026, 10, 27, 7));
    s.add('chat-1', 'Morning news', 'Tell me the news', { daily_at: '08:00' });
    // Off from 7:00 until two days later at 12:00: one late run, then tomorrow at 8.
    set(local(2026, 10, 29, 12));
    s.start();
    s.stop();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.late).toBe(true);
  });

  it('cancels, and a deleted chat takes its tasks', () => {
    const { s } = setup(local(2026, 10, 27, 7));
    s.add('a', 'x', 'x', { every_minutes: 30 });
    s.add('b', 'y', 'y', { every_minutes: 30 });
    expect(s.cancel(s.list()[0]!.id)).toBe(true);
    s.dropChat('b');
    expect(s.list()).toEqual([]);
  });
});
