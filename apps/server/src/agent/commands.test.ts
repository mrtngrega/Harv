import { describe, expect, it } from 'vitest';
import { toCommandInfo } from './commands.ts';

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
