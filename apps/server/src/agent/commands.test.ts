import { describe, expect, it } from 'vitest';
import { asksForSkill, toCommandInfo } from './commands.ts';

describe('toCommandInfo', () => {
  it('leaves out commands Claude Code lists as removed', () => {
    const names = toCommandInfo([
      { name: 'agents', description: '(removed) Ask Claude to create/manage subagents', argumentHint: '' },
      { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '' },
    ]).map((c) => c.name);
    expect(names).toContain('compact');
    expect(names).toContain('btw');
    expect(names).not.toContain('agents');
  });
});

describe('asksForSkill', () => {
  const known = (n: string) => ['compact', 'docx'].includes(n);
  const override = (w: string) => ['opus', 'haiku', 'high'].includes(w);
  it('spots a skill the chat does not list, asked for by name', () => {
    expect(asksForSkill('/simplify the last change', known, override)).toBe(true);
    expect(asksForSkill('/frontend-design make a landing page', known, override)).toBe(true);
    expect(asksForSkill('use the code-review skill on this', known, override)).toBe(true);
    expect(asksForSkill('what plugins do I have?', known, override)).toBe(true);
  });
  it('leaves known commands, Harv’s own words, model overrides and plain messages alone', () => {
    expect(asksForSkill('/docx a letter', known, override)).toBe(false);
    expect(asksForSkill('/compact', known, override)).toBe(false);
    expect(asksForSkill('/btw what time is it', known, override)).toBe(false);
    expect(asksForSkill('/opus explain this', known, override)).toBe(false);
    expect(asksForSkill('/c/Users/me/file.txt', known, override)).toBe(false);
    expect(asksForSkill('how good is my GPU?', known, override)).toBe(false);
  });
});
