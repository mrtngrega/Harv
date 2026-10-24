import type { SDKUsageReport } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asPercent, DEFAULT_WARN, newWarning, toMeters, UsageMeter } from './meter.ts';

const HARV = { turnsToday: 0, inputTokensToday: 0, outputTokensToday: 0, split: [] };

function report(session: number, weekly: number, extra = false): SDKUsageReport {
  const row = (kind: string, group: string, percent: number, resets: string) => ({
    kind,
    group,
    percent,
    resets_at: resets,
    scope: null,
    severity: 'normal',
    is_active: kind === 'session',
  });
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    rate_limits: {
      limits: [
        row('session', 'session', session, '2026-10-23T21:40:00+00:00'),
        row('weekly_all', 'weekly', weekly, '2026-10-27T07:00:00+00:00'),
        { ...row('weekly_scoped', 'weekly', 5, '2026-10-27T07:00:00+00:00'), scope: { model: { display_name: 'Opus 5.5' } } },
      ],
      extra_usage: { is_enabled: extra, monthly_limit: null, used_credits: null, utilization: null },
    },
  };
}

function newMeter(fetch: () => Promise<SDKUsageReport | undefined>) {
  const events = { onChange: vi.fn(), onResume: vi.fn(), onWarning: vi.fn() };
  return { meter: new UsageMeter(events, () => HARV, fetch), events };
}

afterEach(() => vi.useRealTimers());

describe('usage report', () => {
  it('turns /usage rows into labelled meters', () => {
    const parsed = toMeters(report(34, 14, true))!;
    expect(parsed.extraUsageOn).toBe(true);
    expect(parsed.meters.map((m) => [m.label, m.percent])).toEqual([
      ['Session', 34],
      ['Weekly · all models', 14],
      ['Weekly · Opus 5.5', 5],
    ]);
    expect(parsed.meters[0]!.resetsAt).toBe(Date.parse('2026-10-23T21:40:00Z'));
    expect(toMeters(undefined)).toBeNull();
  });

  it('reads utilization as a fraction or a percentage', () => {
    expect(asPercent(0.42)).toBeCloseTo(42);
    expect(asPercent(42)).toBe(42);
  });
});

describe('UsageMeter', () => {
  it('reports weekly % for the router and updates from live events', async () => {
    const { meter } = newMeter(async () => report(34, 14));
    await meter.refresh();
    expect(meter.weeklyPercent()).toBe(14);
    meter.rateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 });
    expect(meter.weeklyPercent()).toBeCloseTo(80);
    expect(meter.paused).toBe(false);
  });

  it('keeps the last reading when /usage fails', async () => {
    let fail = false;
    const { meter } = newMeter(async () => {
      if (fail) throw new Error('offline');
      return report(34, 14);
    });
    await meter.refresh();
    fail = true;
    await meter.refresh();
    expect(meter.snapshot().meters).toHaveLength(3);
  });

  it('pauses on a rejected event and resumes after the reset once /usage agrees', async () => {
    vi.useFakeTimers();
    let session = 100;
    const { meter, events } = newMeter(async () => report(session, 50));
    const resetsAt = Math.floor(Date.now() / 1000) + 60;
    meter.rateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt });
    expect(meter.paused).toBe(true);
    expect(meter.snapshot().pausedUntil).toBe(resetsAt * 1000);

    session = 0;
    await vi.advanceTimersByTimeAsync(80_000);
    expect(meter.paused).toBe(false);
    expect(events.onResume).toHaveBeenCalledOnce();
  });

  it('pauses when /usage shows a full meter, and stays paused while it is still full', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-23T21:00:00Z') });
    let session = 100;
    const { meter, events } = newMeter(async () => report(session, 50));
    await meter.refresh();
    expect(meter.snapshot().pausedUntil).toBe(Date.parse('2026-10-23T21:40:00Z'));

    // At the reset time the server still says 100%: keep waiting (it retries in a few minutes).
    await vi.advanceTimersByTimeAsync(41 * 60_000);
    expect(meter.paused).toBe(true);
    expect(events.onResume).not.toHaveBeenCalled();

    session = 3;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(meter.paused).toBe(false);
    expect(events.onResume).toHaveBeenCalledOnce();
  });
});

describe('usage warnings and refresh pace', () => {
  const session = (percent: number, resetsAt = 1000) => ({ kind: 'session', label: 'Session', percent, resetsAt, severity: 'normal' });

  it('warns once per threshold per window, only the highest one crossed', () => {
    const warned = new Set<string>();
    expect(newWarning(session(60), DEFAULT_WARN, warned)).toBeNull();
    expect(newWarning(session(76), DEFAULT_WARN, warned)).toMatchObject({ kind: 'session', threshold: 75, percent: 76 });
    expect(newWarning(session(80), DEFAULT_WARN, warned)).toBeNull();
    // A jump past two thresholds gives one warning.
    expect(newWarning(session(96), DEFAULT_WARN, warned)?.threshold).toBe(95);
    expect(newWarning(session(97), DEFAULT_WARN, warned)).toBeNull();
    // A new window (new reset time) starts over.
    expect(newWarning(session(78, 2000), DEFAULT_WARN, warned)?.threshold).toBe(75);
    // At 100% the pause banner says it instead.
    expect(newWarning(session(100, 3000), DEFAULT_WARN, warned)).toBeNull();
    // Scoped weekly meters and switched-off warnings stay quiet.
    expect(newWarning({ ...session(99), kind: 'weekly_scoped' }, DEFAULT_WARN, warned)).toBeNull();
    expect(newWarning(session(99, 4000), { session: [], weekly: [] }, warned)).toBeNull();
  });

  it('sends warnings from /usage and from live rate-limit events', async () => {
    let percent = 50;
    const { meter, events } = newMeter(async () => report(percent, 10));
    await meter.refresh();
    expect(events.onWarning).not.toHaveBeenCalled();
    percent = 91;
    await meter.refresh();
    expect(events.onWarning).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session', threshold: 90 }));
    meter.rateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 });
    expect(events.onWarning).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'weekly', threshold: 75 }));
  });

  it('checks every 2 minutes while chatting and every 10 when idle', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-24T12:00:00Z') });
    const fetch = vi.fn(async () => report(10, 10));
    const { meter } = newMeter(fetch);
    meter.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    meter.turnStarted();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    meter.stop();
  });
});
