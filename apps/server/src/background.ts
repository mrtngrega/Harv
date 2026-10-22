import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HARV_HOME } from './paths.ts';

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

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
