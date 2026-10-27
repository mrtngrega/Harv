/** Port the Harv server listens on (localhost only). */
export const SERVER_PORT = 4317;

export const HARV_VERSION = '0.0.1';

/** `waiting` = a red action needs the user's approval; `paused` = a plan limit is hit, messages queue until it resets. */
export type HarvStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'paused';

/** Result of POST /api/sensors/start (starting LibreHardwareMonitor). */
export type LhmLaunchResult = 'already-running' | 'started' | 'declined' | 'not-installed' | 'failed';

/** The OS the server runs on: paths, the file explorer's wording and the sensors depend on it. */
export type HarvPlatform = 'windows' | 'linux' | 'mac';

export type * from './metrics.ts';
export * from './chat.ts';
export type * from './safety.ts';
export type * from './usage.ts';
export * from './settings.ts';
export * from './tools.ts';
export type * from './projects.ts';
export type * from './watchdog.ts';
export type * from './sync.ts';
import type { MetricsSnapshot } from './metrics.ts';
import type { ActionEntry, ApprovalRequest, SafetyClientMessage, SafetyServerMessage } from './safety.ts';
import type { PlanUsage, UsageServerMessage } from './usage.ts';
import type { HarvSettings, SettingsClientMessage, SettingsServerMessage } from './settings.ts';
import type { ToolClientMessage, ToolServerMessage, UiState } from './tools.ts';
import type { Project, ProjectClientMessage, ProjectServerMessage } from './projects.ts';
import type { Catalog, ChatClientMessage, ChatServerMessage, ChatSnapshot, HistoryItem } from './chat.ts';
import type { WatchdogServerMessage } from './watchdog.ts';
import type { SyncClientMessage, SyncServerMessage, SyncStatus } from './sync.ts';

/** Messages the server pushes to the dashboard over /ws. */
export type ServerMessage =
  | {
      type: 'hello';
      version: string;
      status: HarvStatus;
      metrics: MetricsSnapshot | null;
      catalog: Catalog | null;
      /** Open chat tabs restored from the database. */
      chats: ChatSnapshot[];
      history: HistoryItem[];
      /** Red actions waiting for the user. */
      approvals: ApprovalRequest[];
      /** The latest entries of the action log. */
      actions: ActionEntry[];
      usage: PlanUsage;
      settings: HarvSettings;
      /** Background photo version (null = none set). */
      background: number | null;
      /** The dashboard's saved layout (~/.harv/ui.json). */
      ui: UiState;
      /** Folders Harv works on as projects. */
      projects: Project[];
      /** The OS the server runs on. */
      platform: HarvPlatform;
      /** The computer runs on a battery: the dashboard keeps still what would keep the GPU busy. */
      battery?: boolean;
      /** When this server started (ms): a new value tells the dashboard Harv was restarted. */
      startedAt: number;
      /** Sync with the user's other devices. */
      sync: SyncStatus;
    }
  /** `detail` names the running tool while working. */
  | { type: 'harv.status'; status: HarvStatus; detail?: string }
  | { type: 'metrics.tick'; metrics: MetricsSnapshot }
  | { type: 'catalog'; catalog: Catalog }
  | ChatServerMessage
  | SafetyServerMessage
  | UsageServerMessage
  | SettingsServerMessage
  | ToolServerMessage
  | ProjectServerMessage
  | WatchdogServerMessage
  | SyncServerMessage;

/** Messages the dashboard sends to the server over /ws. */
export type ClientMessage =
  | { type: 'ping' }
  | ChatClientMessage
  | SafetyClientMessage
  | SettingsClientMessage
  | ToolClientMessage
  | ProjectClientMessage
  | SyncClientMessage;
