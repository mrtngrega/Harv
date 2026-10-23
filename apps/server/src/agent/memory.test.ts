import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forget, listMemories, memoryChanges, memoryContext, memorySnapshot, remember, toSlug } from './memory.ts';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'harv-memory-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('memory', () => {
  it('slugs names safely', () => {
    expect(toSlug("User's GPU!")).toBe('users-gpu');
    expect(toSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(toSlug('!!!')).toBeNull();
  });

  it('can only write inside the memory folder', () => {
    const dir = tempDir();
    expect(remember('../escape', 'x', dir)).toBe('escape');
    expect(readdirSync(dir)).toEqual(['escape.md']);
  });

  it('saves, replaces and forgets memories', () => {
    const dir = tempDir();
    remember('coding prefs', 'Likes TypeScript.', dir);
    remember('coding-prefs', 'Likes TypeScript and short answers.', dir);
    expect(listMemories(dir)).toEqual([{ name: 'coding-prefs', content: 'Likes TypeScript and short answers.' }]);
    expect(forget('coding prefs', dir)).toBe(true);
    expect(forget('coding prefs', dir)).toBe(false);
    expect(listMemories(dir)).toEqual([]);
  });

  it('rejects oversized memories', () => {
    expect(() => remember('big', 'x'.repeat(2001), tempDir())).toThrow(/under 2000/);
  });

  it('builds the prompt block', () => {
    const dir = tempDir();
    expect(memoryContext(dir)).toBe('You have no saved memories yet.');
    remember('pc', 'Ryzen, RTX card.', dir);
    expect(memoryContext(dir)).toBe('### pc\nRyzen, RTX card.');
  });

  it('reports what other chats saved, updated or forgot', () => {
    const dir = tempDir();
    remember('pc', 'Ryzen.', dir);
    remember('old', 'Stale fact.', dir);
    const before = memorySnapshot(dir);
    expect(memoryChanges(before, memorySnapshot(dir))).toBeNull();

    remember('pc', 'Ryzen 7 5700X3D.', dir);
    remember('car', 'Golf 7.', dir);
    forget('old', dir);
    expect(memoryChanges(before, memorySnapshot(dir))).toBe('- saved "car": Golf 7.\n- updated "pc": Ryzen 7 5700X3D.\n- forgot "old"');
  });
});
