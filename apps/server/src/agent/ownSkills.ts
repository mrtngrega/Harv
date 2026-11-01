import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARV_REPO } from './harvSelf.ts';

// Harv's own skills (docs/PLAN.md §6ab "The skills plan"): their source is harv/skills/<name>/ in
// this repo, so a git pull updates both computers; Claude Code reads skills from ~/.claude/skills,
// so Harv copies them there when it starts, only the files that changed. A skill or file removed
// from the repo stays installed until removed by hand (Harv never deletes in ~/.claude by itself).

export const OWN_SKILLS_SRC = join(HARV_REPO, 'harv', 'skills');
export const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills');

function files(dir: string, base = ''): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir, join(base, e.name)) : e.isFile() ? [join(base, e.name)] : [],
  );
}

/** Copies every skill folder (one with a SKILL.md) from `src` to `dest`; returns the files written. */
export function installOwnSkills(src = OWN_SKILLS_SRC, dest = USER_SKILLS_DIR): string[] {
  if (!existsSync(src)) return [];
  const written: string[] = [];
  for (const skill of readdirSync(src, { withFileTypes: true })) {
    if (!skill.isDirectory() || !existsSync(join(src, skill.name, 'SKILL.md'))) continue;
    for (const rel of files(join(src, skill.name))) {
      const from = join(src, skill.name, rel);
      const to = join(dest, skill.name, rel);
      const bytes = readFileSync(from);
      if (existsSync(to) && statSync(to).size === bytes.length && readFileSync(to).equals(bytes)) continue;
      mkdirSync(join(to, '..'), { recursive: true });
      writeFileSync(to, bytes);
      written.push(join(skill.name, rel));
    }
  }
  return written;
}
