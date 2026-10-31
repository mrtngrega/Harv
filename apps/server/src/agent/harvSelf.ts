import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARV_HOME } from '../paths.ts';

// Harv knowing itself (the user's wish, 2026-10-31: "all about him, all the logs, history and
// everything"): where its code, logs, database and settings are, and a read-only look into its
// database (the chats, every routing pick, every action it took).

/** The Harv repo on this computer (this file is apps/server/src/agent/harvSelf.ts). */
export const HARV_REPO = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');

const DB_ROWS = 200;
const DB_CHARS = 12_000;

/** The prompt section: what Harv is made of and where everything about it lives. */
export function selfContext(): string {
  return [
    '## About yourself',
    [
      `- Your code is the Harv repo at ${HARV_REPO} (docs/PLAN.md is the plan and history of every feature, CLAUDE.md the map of the code, harv/persona.md your rules). Read it to answer how you work; changing it is project work (open_project "Harv").`,
      `- Your data is in ${HARV_HOME}: harv.db (the database, read it with harv_db), logs/ (harv.log is this run's server log, harv.previous.log the run before, harv-script.log every start/stop/restart, app.log the desktop app), settings.json (Settings), ui.json (open tabs and drafts), memory/ (your memory), backups/ (one folder per backed-up action), terminals/ (saved terminal output), watchdog.json, sync/ (the sealed sync repo shared with the user's other device), workspace/ (your files).`,
      "- Read all of it freely. Changes go through your own tools and the user's Settings, never by editing those files: remember/forget for memory, Settings for settings (your safety settings are the user's alone). The keys in there (sync.key, vapid.json, phones.json, the browser profiles) are never read.",
      '- Your own Claude Code sessions are in ~/.claude/projects too (normal chats run in the workspace folder, project chats in the project folder).',
    ].join('\n'),
  ].join('\n\n');
}

/** harv_db: a read-only SQL query on harv.db, or its tables when no query is given. */
export function queryHarvDb(sql: string | undefined, file = join(HARV_HOME, 'harv.db')): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!sql?.trim()) {
      const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as {
        name: string;
      }[];
      return tables
        .map(({ name }) => {
          const cols = (db.prepare(`pragma table_info("${name}")`).all() as { name: string }[]).map((c) => c.name).join(', ');
          const { n } = db.prepare(`select count(*) n from "${name}"`).get() as { n: number };
          return `${name} (${n} rows): ${cols}`;
        })
        .join('\n');
    }
    if (!/^\s*(select|with|pragma\s+table_info)\b/i.test(sql))
      return 'Only reading queries (SELECT, WITH, PRAGMA table_info): harv_db never changes the database.';
    const rows = db.prepare(sql).all().slice(0, DB_ROWS);
    if (!rows.length) return 'No rows.';
    const out = rows.map((r) => JSON.stringify(r)).join('\n');
    return out.length > DB_CHARS ? `${out.slice(0, DB_CHARS)}\n[…cut at ${DB_CHARS} characters: narrow the query]` : out;
  } catch (err) {
    return `Query failed: ${(err as Error).message}`;
  } finally {
    db.close();
  }
}
