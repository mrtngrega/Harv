/** What the PC watchdog noticed. */
export type WatchdogKind = 'heat' | 'cpu-hog' | 'gpu-hog' | 'threat' | 'protection-off' | 'suspicious';

/** One watchdog warning, shown as a toast and kept in Settings › Watchdog. */
export interface WatchdogAlert {
  id: string;
  kind: WatchdogKind;
  /** `critical` stays on screen until dismissed. */
  severity: 'warn' | 'critical';
  title: string;
  detail: string;
  /** The program it's about (e.g. "xmrig.exe"), so the user can ignore it. */
  app?: string;
  at: number;
}

export type WatchdogServerMessage = { type: 'watchdog.alert'; alert: WatchdogAlert };
