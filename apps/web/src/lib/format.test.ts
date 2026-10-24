import { describe, expect, it } from 'vitest';
import { countDuplicates, dateGroup, duration, lineTime, pace, rate, resetTime, sizePair, tokens, until } from './format.ts';

describe('format', () => {
  it('formats throughput', () => {
    expect(rate(205)).toBe('205 B/s');
    expect(rate(17.7 * 1024)).toBe('18 KB/s');
    expect(rate(1.6 * 1024 ** 2)).toBe('1.6 MB/s');
    expect(rate(undefined)).toBe('—');
  });

  it('puts both sides of a size pair in the total unit', () => {
    expect(sizePair(752 * 1024 ** 3, 931 * 1024 ** 3)).toBe('752 / 931 GB');
    expect(sizePair(1.2 * 1024 ** 4, 1.8 * 1024 ** 4)).toBe('1.2 / 1.8 TB');
  });

  it('collapses duplicates', () => {
    expect(countDuplicates(['Kingston 16 GB', 'Kingston 16 GB', 'Other'])).toEqual(['2× Kingston 16 GB', 'Other']);
  });

  it('formats uptime', () => {
    expect(duration(3 * 86400 + 4 * 3600 + 12 * 60)).toBe('3d 4h 12m');
    expect(duration(2 * 3600 + 5 * 60)).toBe('2h 5m');
  });
});

describe('plan usage format', () => {
  it('shows a reset as a time today, or a weekday later', () => {
    const now = new Date(2026, 9, 23, 20, 0).getTime();
    expect(resetTime(new Date(2026, 9, 23, 23, 40).getTime(), now)).toBe('23:40');
    expect(resetTime(new Date(2026, 9, 27, 8, 0).getTime(), now)).toBe('Tue 08:00');
    expect(resetTime(null, now)).toBe('—');
  });

  it('shortens token counts', () => {
    expect([tokens(820), tokens(12_400), tokens(1_300_000), tokens(4200)]).toEqual(['820', '12k', '1.3M', '4.2k']);
  });
});

describe('plan meter details', () => {
  const now = new Date(2026, 9, 23, 20, 0).getTime();
  it('counts down to a reset', () => {
    expect(until(now + (2 * 60 + 14) * 60_000, now)).toBe('2h 14m');
    expect(until(now + 36 * 60_000, now)).toBe('36m');
  });

  it('compares usage with time gone in the window', () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    // Halfway through the week.
    expect(pace({ kind: 'weekly_all', percent: 40, resetsAt: now + week / 2 }, now)).toBe('on track');
    expect(pace({ kind: 'weekly_all', percent: 80, resetsAt: now + week / 2 }, now)).toBe('running hot');
    expect(pace({ kind: 'session', percent: 100, resetsAt: now + 60_000 }, now)).toBe('limit reached');
  });

  it('shows line times relative to today', () => {
    expect(lineTime(new Date(2026, 9, 23, 9, 5).getTime(), now)).toBe('09:05');
    expect(lineTime(new Date(2026, 9, 20, 9, 5).getTime(), now)).toBe('Tue');
    expect(lineTime(new Date(2026, 8, 1, 9, 5).getTime(), now)).toBe('1 Sept');
  });

  it('groups dates like Windows Explorer', () => {
    // Friday 24 Oct 2026, 15:00 local time.
    const now = new Date(2026, 9, 24, 15).getTime();
    const at = (m: number, d: number, h = 12) => new Date(2026, m, d, h).getTime();
    expect(dateGroup(at(9, 24, 1), now)).toBe('Today');
    expect(dateGroup(at(9, 23), now)).toBe('Yesterday');
    expect(dateGroup(at(9, 20), now)).toBe('Earlier this week');
    expect(dateGroup(at(9, 19, 0), now)).toBe('Earlier this week');
    expect(dateGroup(at(9, 18), now)).toBe('Last week');
    expect(dateGroup(at(9, 12), now)).toBe('Last week');
    expect(dateGroup(at(9, 3), now)).toBe('Earlier this month');
    expect(dateGroup(at(8, 2), now)).toBe('Last month');
    expect(dateGroup(at(1, 2), now)).toBe('Earlier this year');
    expect(dateGroup(new Date(2025, 11, 31).getTime(), now)).toBe('A long time ago');
    expect(dateGroup(undefined, now)).toBe('A long time ago');
  });
});
