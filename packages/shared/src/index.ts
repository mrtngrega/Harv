/** Port the Harv server listens on (localhost only). */
export const SERVER_PORT = 4317;

export const HARV_VERSION = '0.0.1';

export type HarvStatus = 'idle' | 'thinking' | 'working';

/** Result of POST /api/sensors/start (starting LibreHardwareMonitor). */
export type LhmLaunchResult = 'already-running' | 'started' | 'declined' | 'not-installed' | 'failed';

export type * from './metrics.ts';
import type { MetricsSnapshot } from './metrics.ts';

/** Messages the server pushes to the dashboard over /ws. */
export type ServerMessage =
  | { type: 'hello'; version: string; status: HarvStatus; metrics: MetricsSnapshot | null }
  | { type: 'harv.status'; status: HarvStatus }
  | { type: 'metrics.tick'; metrics: MetricsSnapshot };

/** Messages the dashboard sends to the server over /ws. */
export type ClientMessage = { type: 'ping' };
