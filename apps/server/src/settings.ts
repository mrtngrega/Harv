import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { COMPACT_ROWS, DEFAULT_SETTINGS, type HarvSettings } from '@harv/shared';
import { HARV_HOME } from './paths.ts';

const settingsPath = () => join(HARV_HOME, 'settings.json');

type Raw = Partial<Record<keyof HarvSettings, unknown>>;

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback;
const oneOf = <T>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
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
  const workDir = typeof raw.workDir === 'string' ? raw.workDir.trim() : base.workDir;
  return {
    protectedPaths: paths,
    confirmYellow: bool(raw.confirmYellow, base.confirmYellow),
    motion: bool(raw.motion, base.motion),
    accent: typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent) ? raw.accent.toUpperCase() : base.accent,
    backgroundBlur: num(raw.backgroundBlur, 0, 30, base.backgroundBlur),
    scrim: num(raw.scrim, 0, 90, base.scrim),
    glass: num(raw.glass, 20, 95, base.glass),
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
    metricsMs: oneOf(raw.metricsMs, [1000, 2000, 5000] as const, base.metricsMs),
    warnSession: percents(raw.warnSession, base.warnSession),
    warnWeekly: percents(raw.warnWeekly, base.warnWeekly),
    // Only a full Windows path (or nothing).
    workDir: workDir === '' || win32.isAbsolute(workDir) ? win32.normalize(workDir || '.').replace(/^\.$/, '') : base.workDir,
    startSensors: bool(raw.startSensors, base.startSensors),
    restoreTabs: bool(raw.restoreTabs, base.restoreTabs),
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

/** Applies a change from the dashboard and saves it. */
export function updateSettings(patch: Raw): HarvSettings {
  const next = cleanSettings(patch, loadSettings());
  writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** The user's default folder, if it's set and still there. */
export function workDir(settings = loadSettings()): string | undefined {
  return settings.workDir && existsSync(settings.workDir) ? settings.workDir : undefined;
}
