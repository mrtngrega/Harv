import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightControl, LightControlBy } from '@harv/shared';
import { HARV_HOME } from '../paths.ts';

// Who took control of each light last (the user's idea, 2026-10-31): every change Harv makes is
// written down with who asked for it, and a change Harv didn't make (the Tapo app, the strip's
// button, the other computer) is noticed on the next read. Automatic lights follow it: a light is
// Harv's to turn off only while automatic lights were the last to touch it. Kept in
// ~/.harv/lights-log.json (this computer's own; the other computer's changes show up here as
// "outside"), with automatic lights' own state, so all of it survives a restart.

const KEEP = 60;

interface LogFile {
  entries: LightControl[];
  /** Automatic lights: it counted as dark, and since when (ms). */
  auto?: { dark: boolean; darkSince: number };
}

export class ControlLog {
  constructor(private file = join(HARV_HOME, 'lights-log.json')) {}

  private read(): LogFile {
    if (!existsSync(this.file)) return { entries: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LogFile>;
      const entries = Array.isArray(raw.entries)
        ? raw.entries.filter(
            (e): e is LightControl => !!e && typeof e.id === 'string' && typeof e.at === 'number' && typeof e.on === 'boolean',
          )
        : [];
      return {
        entries,
        ...(raw.auto && typeof raw.auto.darkSince === 'number' ? { auto: { dark: !!raw.auto.dark, darkSince: raw.auto.darkSince } } : {}),
      };
    } catch {
      return { entries: [] };
    }
  }

  private write(next: LogFile) {
    writeFileSync(this.file, JSON.stringify({ ...next, entries: next.entries.slice(-KEEP) }, null, 1));
  }

  record(id: string, by: LightControlBy, on: boolean, what: string, at = Date.now()): LightControl {
    const entry: LightControl = { id, at, by, on, what };
    const now = this.read();
    this.write({ ...now, entries: [...now.entries, entry] });
    return entry;
  }

  last(id: string): LightControl | null {
    return this.read().entries.findLast((e) => e.id === id) ?? null;
  }

  recent(n = 10): LightControl[] {
    return this.read().entries.slice(-n).reverse();
  }

  autoState(): { dark: boolean; darkSince: number } | null {
    return this.read().auto ?? null;
  }

  setAutoState(auto: { dark: boolean; darkSince: number }): void {
    const now = this.read();
    if (now.auto?.dark === auto.dark && now.auto.darkSince === auto.darkSince) return;
    this.write({ ...now, auto });
  }
}
