/** The accent colours the mockup offers; the first is the default ice blue. */
export const ACCENTS = ['#A8C8E8', '#9FE0C4', '#F2B880', '#C9B8F0'] as const;

/** ~/.harv/settings.json: shared by every dashboard window and the safety gate. */
export interface HarvSettings {
  /** Folders Harv may read but never change (the user's read-only list). */
  protectedPaths: string[];
  /** Subtle animations on (off = everything still). */
  motion: boolean;
  /** One of ACCENTS. */
  accent: string;
  /** Let AUTO use Fable 5.1 for the hardest tasks (it's always a manual pick). */
  allowFable: boolean;
}

export const DEFAULT_SETTINGS: HarvSettings = { protectedPaths: [], motion: true, accent: ACCENTS[0], allowFable: false };

export type SettingsClientMessage = { type: 'settings.update'; patch: Partial<HarvSettings> };

export type SettingsServerMessage =
  | { type: 'settings'; settings: HarvSettings }
  /** The background photo changed; `version` busts the image cache (null = none set). */
  | { type: 'background'; version: number | null };
