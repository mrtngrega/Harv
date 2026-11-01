import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { queryHarvDb, recentWork, selfContext } from './harvSelf.ts';

const dir = mkdtempSync(join(tmpdir(), 'harv-self-'));
const file = join(dir, 'harv.db');
const db = new DatabaseSync(file);
db.exec("create table chats (id text, title text); insert into chats values ('a', 'Car radio'), ('b', 'Phone');");
db.close();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('harv_db', () => {
  it('lists the tables without a query', () => {
    expect(queryHarvDb(undefined, file)).toBe('chats (2 rows): id, title');
  });

  it('answers reading queries', () => {
    expect(queryHarvDb("select title from chats where id = 'a'", file)).toBe('{"title":"Car radio"}');
    expect(queryHarvDb('with t as (select * from chats) select count(*) n from t', file)).toBe('{"n":2}');
    expect(queryHarvDb('select * from chats where 0', file)).toBe('No rows.');
    expect(queryHarvDb('select * from nope', file)).toMatch(/^Query failed/);
  });

  it('never changes the database', () => {
    expect(queryHarvDb('delete from chats', file)).toMatch(/^Only reading queries/);
    expect(queryHarvDb("update chats set title = 'x'", file)).toMatch(/^Only reading queries/);
    // A write hidden behind a reading start fails on the read-only connection.
    expect(queryHarvDb('with x as (select 1) delete from chats', file)).toMatch(/^Query failed/);
    expect(queryHarvDb('select count(*) n from chats', file)).toBe('{"n":2}');
  });

  it('tells Harv where everything about it lives, keys excepted', () => {
    const text = selfContext();
    expect(text).toContain('harv.db');
    expect(text).toContain('harv-script.log');
    expect(text).toContain('docs/PLAN.md');
    expect(text).toMatch(/sync\.key.*never read/);
  });

  it('knows the newest work from the plan’s status lines, kept short (what the dev sessions built)', () => {
    const plan = join(dir, 'PLAN.md');
    const long = 'x'.repeat(2000);
    writeFileSync(
      plan,
      `# Plan\n\nStatus (today): automatic lights built.\n\nStatus (yesterday): ${long}\n\nStatus (older): a\n\nStatus (oldest): b\n`,
    );
    const text = recentWork(plan);
    expect(text).toContain('## Recent work on you');
    expect(text).toContain('- Status (today): automatic lights built.');
    expect(text).toContain(`- Status (yesterday): ${'x'.repeat(1480)}…\n`);
    expect(text).not.toContain('oldest');
    expect(recentWork(join(dir, 'missing.md'))).toBe('');
    expect(selfContext()).toContain('## Recent work on you');
  });
});
