import type { EffortLevel } from './chat.ts';

/** One of the plan's meters, as `/usage` reports it. */
export interface PlanMeter {
  /** The server's kind: 'session', 'weekly_all', 'weekly_scoped', ... */
  kind: string;
  /** "Session", "Weekly · all models", "Weekly · Opus 5.5". */
  label: string;
  /** 0–100. */
  percent: number;
  /** Epoch ms; null when unknown. */
  resetsAt: number | null;
  /** The server's reading: 'normal', 'warning', 'critical'. */
  severity: string;
}

/** Harv's own tracking: the turns it ran (from the router's log). */
export interface HarvUsage {
  /** Since local midnight. */
  turnsToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
  /** The routing split over the last 7 days, busiest first. */
  split: { model: string; effort: EffortLevel; turns: number; harder: number }[];
}

export interface PlanUsage {
  meters: PlanMeter[];
  /** When `/usage` last answered (epoch ms); null before the first answer. */
  fetchedAt: number | null;
  /** Extra usage (overage) is switched on in claude.ai. Harv never uses it, but it's worth turning off. */
  extraUsageOn: boolean;
  /** Epoch ms when Harv can send again while a limit is hit; null when not paused. */
  pausedUntil: number | null;
  /** Messages waiting for the reset. */
  queued: number;
  harv: HarvUsage;
}

export type UsageServerMessage = { type: 'usage.update'; usage: PlanUsage };
