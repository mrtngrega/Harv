import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Harv's own folder: workspace, backups, database and settings live here, outside the repo. */
export const HARV_HOME = process.env.HARV_HOME ?? join(homedir(), '.harv');

export function ensureHarvHome(): void {
  mkdirSync(HARV_HOME, { recursive: true });
}
