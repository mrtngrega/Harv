import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BACKDROPS, COMPACT_ROWS, DEFAULT_SETTINGS, type Backdrop, type HarvSettings } from '@harv/shared';
import { HARV_HOME } from './paths.ts';
import { osPath } from './platform.ts';

const settingsPath = () => join(HARV_HOME, 'settings.json');

/** An HTTPS or SSH Git URL (never a local path or an option like `--upload-pack`). */
const SYNC_REPO = /^(https:\/\/[\w.-]+(:\d+)?\/[\w./-]+|git@[\w.-]+:[\w./-]+)$/;

// eslint-disable-next-line no-control-regex -- control characters don't belong in a device name
const CONTROL = /[\u0000-\u001f]/g;

/** A settings file as read: anything may be wrong or missing (seeThrough: the old name of backdrop's see-through, one day old). */
type Raw = Partial<Record<keyof HarvSettings | 'seeThrough', unknown>>;

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback;
const oneOf = <T>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
/** A place with real coordinates, or null to clear it. */
const place = (v: unknown, fallback: HarvSettings['autoLightsPlace']): HarvSettings['autoLightsPlace'] => {
  if (v === null) return null;
  const p = v as { name?: unknown; lat?: unknown; lon?: unknown } | undefined;
  return typeof p?.name === 'string' &&
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
    ? { name: p.name.trim().slice(0, 80), lat: p.lat, lon: p.lon }
    : fallback;
};
const percents = (v: unknown, fallback: number[]) =>
  Array.isArray(v)
    ? [...new Set(v.filter((n): n is number => typeof n === 'number' && n > 0 && n < 100).map(Math.round))].sort((a, b) => a - b)
    : fallback;

/** Keeps only valid values, so a hand-edited or partial file never breaks Harv. */
export function cleanSettings(raw: Raw, base: HarvSettings = DEFAULT_SETTINGS): HarvSettings {
  const paths = Array.isArray(raw.protectedPaths)
    ? [...new Set(raw.protectedPaths.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()))]
    : base.protectedPaths;
  const rows = Array.isArray(raw.compactRows) ? COMPACT_ROWS.filter((r) => (raw.compactRows as unknown[]).includes(r)) : base.compactRows;
  const folder = (v: unknown, fallback: string) => {
    if (typeof v !== 'string') return fallback;
    const path = v.trim();
    // Only a full path (or nothing).
    return path === '' ? '' : osPath.isAbsolute(path) ? osPath.normalize(path) : fallback;
  };
  return {
    protectedPaths: paths,
    askRisky: bool(raw.askRisky, base.askRisky),
    confirmYellow: bool(raw.confirmYellow, base.confirmYellow),
    allowRules: Array.isArray(raw.allowRules)
      ? [...new Set(raw.allowRules.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim().toLowerCase()))]
      : base.allowRules,
    backupDays: num(raw.backupDays, 1, 365, base.backupDays),
    backupMaxGb: num(raw.backupMaxGb, 1, 100, base.backupMaxGb),
    motion: bool(raw.motion, base.motion),
    accent: typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent) ? raw.accent.toUpperCase() : base.accent,
    backgroundBlur: num(raw.backgroundBlur, 0, 30, base.backgroundBlur),
    scrim: num(raw.scrim, 0, 90, base.scrim),
    glass: num(raw.glass, 20, 95, base.glass),
    glassBlur: num(raw.glassBlur, 0, 40, base.glassBlur),
    // seeThrough (a switch for one day, 2026-10-27) became backdrop.
    backdrop: (BACKDROPS as readonly unknown[]).includes(raw.backdrop)
      ? (raw.backdrop as Backdrop)
      : raw.seeThrough === true
        ? 'seeThrough'
        : base.backdrop,
    frost: bool(raw.frost, base.frost),
    uiScale: num(raw.uiScale, 80, 130, base.uiScale),
    density: oneOf(raw.density, ['comfy', 'compact'] as const, base.density),
    showTimes: bool(raw.showTimes, base.showTimes),
    showTags: bool(raw.showTags, base.showTags),
    sendKey: oneOf(raw.sendKey, ['enter', 'ctrlEnter'] as const, base.sendKey),
    startModel: oneOf(raw.startModel, ['auto', 'last'] as const, base.startModel),
    allowFable: bool(raw.allowFable, base.allowFable),
    statsExpanded: bool(raw.statsExpanded, base.statsExpanded),
    compactRows: rows,
    tempUnit: oneOf(raw.tempUnit, ['C', 'F'] as const, base.tempUnit),
    metricsMs: oneOf(raw.metricsMs, [1000, 2000, 3000, 5000] as const, base.metricsMs),
    warnSession: percents(raw.warnSession, base.warnSession),
    warnWeekly: percents(raw.warnWeekly, base.warnWeekly),
    workDir: folder(raw.workDir, base.workDir),
    projectsDir: folder(raw.projectsDir, base.projectsDir),
    startSensors: bool(raw.startSensors, base.startSensors),
    restoreTabs: bool(raw.restoreTabs, base.restoreTabs),
    watchdog: bool(raw.watchdog, base.watchdog),
    watchdogIgnored: Array.isArray(raw.watchdogIgnored)
      ? [
          ...new Set(
            raw.watchdogIgnored.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim().toLowerCase()),
          ),
        ]
      : base.watchdogIgnored,
    syncEnabled: bool(raw.syncEnabled, base.syncEnabled),
    phoneAccess: bool(raw.phoneAccess, base.phoneAccess),
    autoLights: bool(raw.autoLights, base.autoLights),
    autoLightsPlace: place(raw.autoLightsPlace, base.autoLightsPlace),
    autoLightsDark: num(raw.autoLightsDark, 5, 500, base.autoLightsDark),
    autoLightsSunset: num(raw.autoLightsSunset, 0, 180, base.autoLightsSunset),
    autoLightsAway: num(raw.autoLightsAway, 1, 120, base.autoLightsAway),
    syncRepo:
      typeof raw.syncRepo === 'string' && (raw.syncRepo.trim() === '' || SYNC_REPO.test(raw.syncRepo.trim()))
        ? raw.syncRepo.trim()
        : base.syncRepo,
    deviceName:
      typeof raw.deviceName === 'string' ? raw.deviceName.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, 40) : base.deviceName,
  };
}

/** Read on every check, so edits to ~/.harv/settings.json apply at once. */
export function loadSettings(): HarvSettings {
  try {
    if (!existsSync(settingsPath())) return DEFAULT_SETTINGS;
    return cleanSettings(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const listeners = new Set<(before: HarvSettings, after: HarvSettings) => void>();

/** Called after every change made on this device (sync sends the shared ones to the other device). */
export function onSettingsChange(listener: (before: HarvSettings, after: HarvSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Applies a change from the dashboard and saves it. `quiet` (a change from the other device) tells no listener. */
export function updateSettings(patch: Raw, quiet = false): HarvSettings {
  const before = loadSettings();
  const next = cleanSettings(patch, before);
  writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
  if (!quiet) for (const listener of listeners) listener(before, next);
  return next;
}

/** When settings.json last changed (0 = never saved). */
export function settingsTime(): number {
  try {
    return statSync(settingsPath()).mtimeMs;
  } catch {
    return 0;
  }
}

/** Where new projects get their folder. */
export function projectsDir(settings = loadSettings()): string {
  return settings.projectsDir || join(homedir(), 'Projects');
}

/** The user's default folder, if it's set and still there. */
export function workDir(settings = loadSettings()): string | undefined {
  return settings.workDir && existsSync(settings.workDir) ? settings.workDir : undefined;
}
