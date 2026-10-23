import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARV_HOME } from './paths.ts';

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Largest photo the background picker accepts. */
export const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024;

/**
 * The dashboard background is a personal photo, so it lives in ~/.harv
 * (never in the public repo). Returns the first `background.<ext>` found.
 */
export function findBackground(): { path: string; contentType: string } | null {
  for (const [ext, contentType] of Object.entries(TYPES)) {
    const path = join(HARV_HOME, `background.${ext}`);
    if (existsSync(path)) return { path, contentType };
  }
  return null;
}

/** Changes whenever the photo does, so the dashboard can bust its cache. */
export function backgroundVersion(): number | null {
  const bg = findBackground();
  return bg ? Math.round(statSync(bg.path).mtimeMs) : null;
}

/** The image type from the file's first bytes (the name or header isn't trusted). */
export function imageType(data: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function removeBackground(): void {
  for (const ext of Object.keys(TYPES)) rmSync(join(HARV_HOME, `background.${ext}`), { force: true });
}

/** Replaces the background photo. Returns false if the data isn't a JPEG, PNG or WebP. */
export function saveBackground(data: Buffer): boolean {
  const ext = imageType(data);
  if (!ext) return false;
  removeBackground();
  writeFileSync(join(HARV_HOME, `background.${ext}`), data);
  return true;
}
