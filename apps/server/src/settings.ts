import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCENTS, DEFAULT_SETTINGS, type HarvSettings } from '@harv/shared';
import { HARV_HOME } from './paths.ts';

const settingsPath = () => join(HARV_HOME, 'settings.json');

/** Keeps only valid values, so a hand-edited or partial file never breaks Harv. */
export function cleanSettings(raw: Partial<Record<keyof HarvSettings, unknown>>, base: HarvSettings = DEFAULT_SETTINGS): HarvSettings {
  const paths = Array.isArray(raw.protectedPaths)
    ? [...new Set(raw.protectedPaths.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()))]
    : base.protectedPaths;
  return {
    protectedPaths: paths,
    motion: typeof raw.motion === 'boolean' ? raw.motion : base.motion,
    accent: typeof raw.accent === 'string' && (ACCENTS as readonly string[]).includes(raw.accent) ? raw.accent : base.accent,
    allowFable: typeof raw.allowFable === 'boolean' ? raw.allowFable : base.allowFable,
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
export function updateSettings(patch: Partial<Record<keyof HarvSettings, unknown>>): HarvSettings {
  const next = cleanSettings(patch, loadSettings());
  writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
