import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { HARV_HOME } from '../paths.ts';

// Harv's private memory: one Markdown file per memory in ~/.harv/memory. It's
// read into the system prompt at session start and changed only through the
// scoped remember/forget tools below, which can't write anywhere else.

export const MEMORY_DIR = process.env.HARV_MEMORY_DIR ?? join(HARV_HOME, 'memory');
const MAX_CHARS = 2000;
/** Keeps the memory block in every prompt small (it counts against plan usage). */
const MAX_TOTAL_CHARS = 12_000;

/** "User's GPU!" → "users-gpu"; null if nothing usable is left. */
export function toSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || null;
}

export function listMemories(dir = MEMORY_DIR): { name: string; content: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: f.slice(0, -3), content: readFileSync(join(dir, f), 'utf8').trim() }));
}

/** The memory block for the system prompt, trimmed to a fixed budget. */
export function memoryContext(dir = MEMORY_DIR): string {
  const memories = listMemories(dir);
  if (memories.length === 0) return 'You have no saved memories yet.';
  let out = '';
  for (const m of memories) {
    const entry = `### ${m.name}\n${m.content}\n\n`;
    if (out.length + entry.length > MAX_TOTAL_CHARS) {
      out += `(…${memories.length} memories in total; some were left out to save space.)\n`;
      break;
    }
    out += entry;
  }
  return out.trim();
}

export function remember(name: string, content: string, dir = MEMORY_DIR): string {
  const slug = toSlug(name);
  if (!slug) throw new Error('The memory needs a name with letters or digits.');
  if (content.length > MAX_CHARS) throw new Error(`Keep a memory under ${MAX_CHARS} characters.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), content.trim() + '\n', 'utf8');
  return slug;
}

export function forget(name: string, dir = MEMORY_DIR): boolean {
  const slug = toSlug(name);
  const path = slug ? join(dir, `${slug}.md`) : null;
  if (!path || !existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Every memory's content by name, to notice changes made by other chats (or by hand). */
export function memorySnapshot(dir = MEMORY_DIR): Map<string, string> {
  return new Map(listMemories(dir).map((m) => [m.name, m.content]));
}

/** What changed between two snapshots, as a note for Claude; null when nothing did. */
export function memoryChanges(before: Map<string, string>, after: Map<string, string>): string | null {
  const lines: string[] = [];
  for (const [name, content] of after) {
    if (before.get(name) !== content) lines.push(`- ${before.has(name) ? 'updated' : 'saved'} "${name}": ${content}`);
  }
  for (const name of before.keys()) if (!after.has(name)) lines.push(`- forgot "${name}"`);
  return lines.length ? lines.join('\n') : null;
}

export const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export const memoryTools = [
  tool(
    'remember',
    'Save or update one of your long-term memories about the user (preferences, decisions, facts about their setup, rules they taught you). Use a short kebab-case name; saving an existing name replaces it. Never store secrets.',
    { name: z.string().describe('Short name, e.g. "coding-preferences"'), content: z.string().describe('The memory, short and factual') },
    async ({ name, content }) => {
      try {
        return text(`Saved memory "${remember(name, content)}".`);
      } catch (err) {
        return { ...text((err as Error).message), isError: true };
      }
    },
  ),
  tool('forget', 'Delete one of your memories that is wrong or no longer true.', { name: z.string() }, async ({ name }) =>
    forget(name) ? text(`Forgot "${toSlug(name)}".`) : { ...text(`No memory named "${name}".`), isError: true },
  ),
];
