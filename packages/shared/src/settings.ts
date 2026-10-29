/** The accent colours the mockup offers; the first is the default ice blue. Any other #rrggbb works too. */
export const ACCENTS = ['#A8C8E8', '#9FE0C4', '#F2B880', '#C9B8F0'] as const;

/** Rows the collapsed stats panel can show, in order. */
export const COMPACT_ROWS = ['cpu', 'gpu', 'ram', 'disk', 'net', 'session', 'weekly'] as const;
export type CompactRow = (typeof COMPACT_ROWS)[number];

/** Warning thresholds the Settings tab offers. */
export const WARN_CHOICES = { session: [50, 75, 90, 95], weekly: [50, 75, 90] } as const;

export const BACKDROPS = ['photo', 'seeThrough', 'plain'] as const;
export type Backdrop = (typeof BACKDROPS)[number];

/** ~/.harv/settings.json: shared by every dashboard window, the server and the safety gate. */
export interface HarvSettings {
  /** Folders Harv may read but never change (the user's read-only list). */
  protectedPaths: string[];
  /**
   * Ask before risky (red) actions: deleting, installing, stopping programs, system changes,
   * sending data. Off (the user's choice, 2026-10-27): they run without a card, still backed up
   * and logged with Undo; blocked things stay blocked.
   */
  askRisky: boolean;
  /** Ask before yellow actions too (editing, moving or creating the user's files), not only red ones. */
  confirmYellow: boolean;
  /** "Don't ask again" rules from approval cards: commands like "npm install" or "remove-item" that run without a card (backed up, with Undo). */
  allowRules: string[];
  /** Backups (for Undo) older than this many days are deleted (the user's wish, 2026-10-29). */
  backupDays: number;
  /** All backups together stay under this many GB: the oldest go first. */
  backupMaxGb: number;

  // Look
  /** Subtle animations on (off = everything still). */
  motion: boolean;
  /** #rrggbb. */
  accent: string;
  /** Background photo blur in px (0–30). */
  backgroundBlur: number;
  /** How dark the layer over the photo is, in % (0–90). */
  scrim: number;
  /** How solid the glass panels are, in % (20–95). */
  glass: number;
  /** How much the glass panels blur what's behind them, in px (0–40). */
  glassBlur: number;
  /**
   * What's behind the panels: the photo, the desktop (the app's see-through window; a browser
   * shows the photo instead), or the plain ground colour. Per device.
   */
  backdrop: Backdrop;
  /** See-through on Windows: frost what's behind the window (Acrylic; Windows has one strength). Per device. */
  frost: boolean;
  /** Size of everything, in % (80–130). */
  uiScale: number;
  /** Space between chat lines. */
  density: 'comfy' | 'compact';

  // Chat
  showTimes: boolean;
  /** The [model·effort] tag on Harv's replies. */
  showTags: boolean;
  /** Enter sends (Shift+Enter = new line), or Ctrl+Enter sends (Enter = new line). */
  sendKey: 'enter' | 'ctrlEnter';
  /** What the model switcher starts on when the dashboard opens. */
  startModel: 'auto' | 'last';
  /** Let AUTO use Fable 5.1 for the hardest tasks (it's always a manual pick). */
  allowFable: boolean;

  // Stats panel
  statsExpanded: boolean;
  compactRows: CompactRow[];
  tempUnit: 'C' | 'F';
  /** How often the hardware stats update, in ms. */
  metricsMs: 1000 | 2000 | 3000 | 5000;

  // Usage
  /** Warn at these % of the session (5-hour) limit; empty = off. */
  warnSession: number[];
  /** Warn at these % of the weekly limit; empty = off. */
  warnWeekly: number[];

  // Workspace
  /** The user's default folder: where terminals and the explorer open, and where Harv works on files unless told otherwise. '' = none. */
  workDir: string;
  /** Where new projects get their folder ('' = a Projects folder in the user's home). */
  projectsDir: string;

  // Startup
  /** Start LibreHardwareMonitor (UAC prompt) when Harv starts. */
  startSensors: boolean;
  /** Bring back the tabs, tools and drafts after a restart, like Chrome. */
  restoreTabs: boolean;

  // Watchdog
  /** Warn about overheating, background apps hogging the CPU/GPU, and dangerous software. */
  watchdog: boolean;
  /** Programs the watchdog never warns about (lowercase exe names, e.g. "blender.exe"). */
  watchdogIgnored: string[];

  // Sync (docs/PLAN.md §6m)
  /** Sync chats, memory and shared settings with the user's other devices. */
  syncEnabled: boolean;
  /** The private Git repo the devices sync through (HTTPS clone URL). */
  syncRepo: string;
  /** This device's name, shown on the other one ('' = the computer's name). */
  deviceName: string;

  // Phone (docs/PLAN.md §6q)
  /** Paired phones may open this device's Harv over Tailscale (`tailscale serve`). Per device, off by default. */
  phoneAccess: boolean;
}

export const DEFAULT_SETTINGS: HarvSettings = {
  protectedPaths: [],
  askRisky: false,
  confirmYellow: false,
  allowRules: [],
  backupDays: 30,
  backupMaxGb: 5,
  motion: true,
  accent: ACCENTS[0],
  backgroundBlur: 9,
  scrim: 55,
  glass: 50,
  glassBlur: 22,
  backdrop: 'photo',
  frost: true,
  uiScale: 100,
  density: 'comfy',
  showTimes: true,
  showTags: true,
  sendKey: 'enter',
  startModel: 'last',
  allowFable: false,
  statsExpanded: false,
  compactRows: [...COMPACT_ROWS],
  tempUnit: 'C',
  metricsMs: 1000,
  warnSession: [75, 90, 95],
  warnWeekly: [75, 90],
  workDir: '',
  projectsDir: '',
  startSensors: true,
  restoreTabs: true,
  watchdog: true,
  watchdogIgnored: [],
  syncEnabled: false,
  syncRepo: '',
  deviceName: '',
  phoneAccess: false,
};

/**
 * Settings that follow the user to their other devices (newest wins per key). The rest
 * stay per device: folders and read-only paths (they differ per OS), size, startup, sensors, watchdog, sync.
 */
export const SHARED_SETTINGS = [
  'askRisky',
  'confirmYellow',
  'allowRules',
  'motion',
  'accent',
  'backgroundBlur',
  'scrim',
  'glass',
  'glassBlur',
  'density',
  'showTimes',
  'showTags',
  'sendKey',
  'startModel',
  'allowFable',
  'compactRows',
  'tempUnit',
  'warnSession',
  'warnWeekly',
  'watchdogIgnored',
] as const satisfies readonly (keyof HarvSettings)[];

export type SettingsClientMessage = { type: 'settings.update'; patch: Partial<HarvSettings> };

export type SettingsServerMessage =
  | { type: 'settings'; settings: HarvSettings }
  /** The background photo changed; `version` busts the image cache (null = none set). */
  | { type: 'background'; version: number | null };
