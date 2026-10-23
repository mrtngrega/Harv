import { query, type SDKRateLimitInfo, type SDKUsageReport } from '@anthropic-ai/claude-agent-sdk';
import type { HarvUsage, PlanMeter, PlanUsage } from '@harv/shared';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES } from '../agent/options.ts';

type Limits = NonNullable<NonNullable<SDKUsageReport['rate_limits']>['limits']>;

/** How often the meter refreshes on its own, and at most after turns. */
const POLL_MS = 10 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;
/** Re-check this long after a reset time, so the server has rolled the window over. */
const RESET_SLACK_MS = 15 * 1000;
/** When a limit hits without a known reset time, look again after this long. */
const UNKNOWN_RESET_RETRY_MS = 5 * 60 * 1000;

function label(row: Limits[number]): string {
  if (row.kind === 'session') return 'Session';
  if (row.kind === 'weekly_all') return 'Weekly · all models';
  const scope = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
  if (row.group === 'weekly') return `Weekly · ${scope ?? row.kind}`;
  return scope ? `${row.group} · ${scope}` : row.kind;
}

/** The plan's meters from a `/usage` report; null when the report has none. */
export function toMeters(report: SDKUsageReport | undefined): { meters: PlanMeter[]; extraUsageOn: boolean } | null {
  const limits = report?.rate_limits?.limits;
  if (!limits) return null;
  const meters = limits.map((row) => ({
    kind: row.kind,
    label: label(row),
    percent: Math.max(0, Math.min(100, row.percent)),
    resetsAt: row.resets_at ? Date.parse(row.resets_at) : null,
    severity: row.severity,
  }));
  return { meters, extraUsageOn: report.rate_limits?.extra_usage?.is_enabled === true };
}

/** Which meter a live `rate_limit_event` is about. */
function meterFor(meters: PlanMeter[], type: SDKRateLimitInfo['rateLimitType']): PlanMeter | undefined {
  switch (type) {
    case 'five_hour':
      return meters.find((m) => m.kind === 'session');
    case 'seven_day':
      return meters.find((m) => m.kind === 'weekly_all');
    case 'seven_day_opus':
      return meters.find((m) => m.kind === 'weekly_scoped' && /opus/i.test(m.label));
    case 'seven_day_sonnet':
      return meters.find((m) => m.kind === 'weekly_scoped' && /sonnet/i.test(m.label));
    default:
      return undefined;
  }
}

/** Accepts either a 0–1 fraction or a 0–100 percentage. */
export const asPercent = (utilization: number) => (utilization <= 1 ? utilization * 100 : utilization);

/**
 * Runs `/usage` in a throwaway session. It's a local Claude Code command: no
 * model call and no tokens (checked live: cost 0, 0 tokens, ~1 s).
 */
async function fetchReport(): Promise<SDKUsageReport | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  const q = query({
    prompt: '/usage',
    options: { ...buildOptions('haiku', 'low', abort), tools: [], maxTurns: 1, persistSession: false, includePartialMessages: false },
  });
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) return undefined;
      if (msg.type === 'assistant' && msg.usage_report) return msg.usage_report;
      if (msg.type === 'result') return undefined;
    }
    return undefined;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

export interface MeterEvents {
  onChange: (usage: PlanUsage) => void;
  /** A paused limit has reset: queued work can go. */
  onResume: () => void;
}

/**
 * Claude plan usage: session and weekly meters from `/usage`, kept current by the
 * live rate-limit events, and the pause while a limit is hit.
 */
export class UsageMeter {
  private meters: PlanMeter[] = [];
  private fetchedAt: number | null = null;
  private extraUsageOn = false;
  private pausedUntil: number | null = null;
  private lastFetch = 0;
  private fetching: Promise<void> | null = null;
  private poll: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  queued = 0;

  constructor(
    private events: MeterEvents,
    private harv: () => HarvUsage,
    private fetch: () => Promise<SDKUsageReport | undefined> = fetchReport,
  ) {}

  start(): void {
    void this.refresh();
    this.poll = setInterval(() => void this.refresh(), POLL_MS);
  }

  stop(): void {
    for (const t of [this.poll, this.soon, this.resumeTimer]) if (t) clearTimeout(t);
  }

  get paused(): boolean {
    return this.pausedUntil !== null;
  }

  /** Weekly usage across all models, for the router's plan-aware trimming. */
  weeklyPercent(): number | undefined {
    return this.meters.find((m) => m.kind === 'weekly_all')?.percent;
  }

  snapshot(): PlanUsage {
    return {
      meters: this.meters,
      fetchedAt: this.fetchedAt,
      extraUsageOn: this.extraUsageOn,
      pausedUntil: this.pausedUntil,
      queued: this.queued,
      harv: this.harv(),
    };
  }

  publish(): void {
    this.events.onChange(this.snapshot());
  }

  /** After a turn: refresh soon, but not more than once a minute. */
  turnFinished(): void {
    if (this.soon) return;
    const wait = Math.max(3000, this.lastFetch + MIN_GAP_MS - Date.now());
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.refresh();
    }, wait);
    // Harv's own counts change with every turn.
    this.publish();
  }

  refresh(): Promise<void> {
    this.fetching ??= (async () => {
      this.lastFetch = Date.now();
      try {
        const parsed = toMeters(await this.fetch());
        if (parsed) {
          this.meters = parsed.meters;
          this.extraUsageOn = parsed.extraUsageOn;
          this.fetchedAt = Date.now();
          this.checkLimits();
        }
      } catch {
        // Keep the last reading; the next poll tries again.
      } finally {
        this.fetching = null;
      }
      this.publish();
    })();
    return this.fetching;
  }

  /** A live `rate_limit_event` from a chat session. */
  rateLimit(info: SDKRateLimitInfo): void {
    const meter = meterFor(this.meters, info.rateLimitType);
    if (meter) {
      if (info.utilization !== undefined) meter.percent = Math.min(100, asPercent(info.utilization));
      if (info.resetsAt) meter.resetsAt = info.resetsAt * 1000;
    }
    if (info.status === 'rejected') this.pause(info.resetsAt ? info.resetsAt * 1000 : (meter?.resetsAt ?? null));
    this.publish();
  }

  /** A limit was hit. Until `until` (epoch ms), messages queue instead of being sent. */
  pause(until: number | null): void {
    // An unknown reset, or one already past (the server hasn't rolled over yet): look again in a few minutes.
    const at = until !== null && until > Date.now() ? until : Date.now() + UNKNOWN_RESET_RETRY_MS;
    if (this.pausedUntil !== null && this.pausedUntil >= at) return;
    this.pausedUntil = at;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => void this.tryResume(), Math.max(0, at - Date.now()) + RESET_SLACK_MS);
    this.publish();
  }

  private async tryResume() {
    this.resumeTimer = null;
    this.pausedUntil = null;
    await this.refresh();
    // refresh() re-pauses if a meter is still full.
    if (!this.paused) this.events.onResume();
  }

  /** A full meter means the next send would be refused: pause until it resets. */
  private checkLimits() {
    const full = this.meters.filter((m) => m.percent >= 100);
    if (full.length === 0) return;
    const resets = full.map((m) => m.resetsAt ?? 0);
    this.pause(Math.max(...resets) || null);
  }
}
