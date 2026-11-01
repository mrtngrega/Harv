import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { installOwnSkills, OWN_SKILLS_SRC } from './ownSkills.ts';

describe("Harv's own skills", () => {
  const dir = mkdtempSync(join(tmpdir(), 'harv-skills-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src');
  const dest = join(dir, 'dest');
  const put = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };

  it('copies skill folders with their references, then only what changed', () => {
    put(join(src, 'diagnose', 'SKILL.md'), 'v1');
    put(join(src, 'diagnose', 'references', 'gotchas.md'), 'traps');
    put(join(src, 'notes', 'README.md'), 'not a skill');
    put(join(src, 'CREDITS.md'), 'not a folder');
    expect(installOwnSkills(src, dest).sort()).toEqual([join('diagnose', 'SKILL.md'), join('diagnose', 'references', 'gotchas.md')]);
    expect(readFileSync(join(dest, 'diagnose', 'references', 'gotchas.md'), 'utf8')).toBe('traps');
    expect(existsSync(join(dest, 'notes'))).toBe(false);
    expect(installOwnSkills(src, dest)).toEqual([]);
    put(join(src, 'diagnose', 'SKILL.md'), 'v2');
    expect(installOwnSkills(src, dest)).toEqual([join('diagnose', 'SKILL.md')]);
  });

  it('a hand edit of the installed copy is replaced by the repo version', () => {
    put(join(dest, 'diagnose', 'SKILL.md'), 'edited by hand');
    expect(installOwnSkills(src, dest)).toEqual([join('diagnose', 'SKILL.md')]);
    expect(readFileSync(join(dest, 'diagnose', 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('the repo’s skills each have a name matching their folder and a "Use …" description', () => {
    const names = readdirSync(OWN_SKILLS_SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['diagnose', 'deslop', 'ui-check', 'learn-from-session', 'image-prompt', 'video']));
    for (const name of names) {
      const text = readFileSync(join(OWN_SKILLS_SRC, name, 'SKILL.md'), 'utf8');
      expect(text).toMatch(new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .*\\bUse `, 'm'));
    }
  });
});
