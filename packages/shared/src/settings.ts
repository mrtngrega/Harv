/** The accent colours the mockup offers; the first is the default ice blue. Any other #rrggbb works too. */
export const ACCENTS = ['#A8C8E8', '#9FE0C4', '#F2B880', '#C9B8F0'] as const;

/** Rows the collapsed stats panel can show, in order. */
export const COMPACT_ROWS = ['cpu', 'gpu', 'ram', 'disk', 'net', 'session', 'weekly'] as const;
export type CompactRow = (typeof COMPACT_ROWS)[number];

/** Warning thresholds the Settings tab offers. */
export const WARN_CHOICES = { session: [50, 75, 90, 95], weekly: [50, 75, 90] } as const;

/** ~/.harv/settings.json: shared by every dashboard window, the server and the safety gate. */
export interface HarvSettings {
  /** Folders Harv may read but never change (the user's read-only list). */
  protectedPaths: string[];
  /** Ask before yellow actions too (editing, moving or creating the user's files), not only red ones. */
  confirmYellow: boolean;

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
  metricsMs: 1000 | 2000 | 5000;

  // Usage
  /** Warn at these % of the session (5-hour) limit; empty = off. */
  warnSession: number[];
  /** Warn at these % of the weekly limit; empty = off. */
  warnWeekly: number[];

  // Workspace
  /** The user's default folder: where terminals and the explorer open, and where Harv works on files unless told otherwise. '' = none. */
  workDir: string;

  // Startup
  /** Start LibreHardwareMonitor (UAC prompt) when Harv starts. */
  startSensors: boolean;
  /** Bring back the tabs, tools and drafts after a restart, like Chrome. */
  restoreTabs: boolean;
}

export const DEFAULT_SETTINGS: HarvSettings = {
  protectedPaths: [],
  confirmYellow: false,
  motion: true,
  accent: ACCENTS[0],
  backgroundBlur: 9,
  scrim: 55,
  glass: 50,
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
  startSensors: true,
  restoreTabs: true,
};

export type SettingsClientMessage = { type: 'settings.update'; patch: Partial<HarvSettings> };

export type SettingsServerMessage =
  | { type: 'settings'; settings: HarvSettings }
  /** The background photo changed; `version` busts the image cache (null = none set). */
  | { type: 'background'; version: number | null };
