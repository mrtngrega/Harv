import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ENDED_SHOWN_MS, TaskTracker } from './tasks.ts';

// The SDK's task events, with only the fields the tracker reads.
const sys = (subtype: string, rest: Record<string, unknown>) =>
  ({ type: 'system', subtype, uuid: 'u', session_id: 's', ...rest }) as unknown as SDKMessage;
const level = (...tasks: Record<string, unknown>[]) => sys('background_tasks_changed', { tasks });
const agent = { task_id: 'a1', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Find the radio API' };

describe('background task strip', () => {
  it('shows a background agent from start to its summary', () => {
    const t = new TaskTracker();
    expect(t.apply(sys('task_started', { ...agent, is_backgrounded: true }), 1000)).toBe(true);
    t.apply(sys('task_progress', { task_id: 'a1', description: 'x', usage: {}, last_tool_name: 'Grep' }), 2000);
    expect(t.list(2000)).toEqual([
      {
        id: 'a1',
        kind: 'local_agent',
        agent: 'general-purpose',
        description: 'Find the radio API',
        startedAt: 1000,
        status: 'running',
        lastTool: 'Grep',
      },
    ]);
    expect(t.running).toBe(1);
    t.apply(sys('task_notification', { task_id: 'a1', status: 'completed', summary: 'Found it in com.syu.ms', output_file: '' }), 9000);
    expect(t.list(9000)[0]).toMatchObject({ status: 'completed', summary: 'Found it in com.syu.ms', endedAt: 9000 });
    expect(t.list(9000)[0]!.lastTool).toBeUndefined();
    expect(t.running).toBe(0);
  });

  it('leaves blocking subagents to the reply until they move to the background', () => {
    const t = new TaskTracker();
    expect(t.apply(sys('task_started', { ...agent, is_backgrounded: false }))).toBe(false);
    expect(t.list()).toEqual([]);
    expect(t.apply(sys('task_updated', { task_id: 'a1', patch: { is_backgrounded: true } }))).toBe(true);
    expect(t.list()).toHaveLength(1);
  });

  it('trusts the live set: a task that left it without a notification has ended', () => {
    const t = new TaskTracker();
    t.apply(level(agent, { task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }), 1000);
    expect(t.list(1000).map((x) => x.id)).toEqual(['a1', 'b1']);
    t.apply(level({ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }), 5000);
    expect(t.list(5000).find((x) => x.id === 'a1')).toMatchObject({ status: 'completed', endedAt: 5000 });
  });

  it('maps a kill to stopped and an error to the summary', () => {
    const t = new TaskTracker();
    t.apply(level(agent));
    t.apply(sys('task_updated', { task_id: 'a1', patch: { status: 'killed', end_time: 7 } }));
    expect(t.list(8)[0]).toMatchObject({ status: 'stopped', endedAt: 7 });
    t.apply(level({ ...agent, task_id: 'a2' }));
    t.apply(sys('task_updated', { task_id: 'a2', patch: { status: 'failed', error: 'tool crashed' } }));
    expect(t.list().find((x) => x.id === 'a2')).toMatchObject({ status: 'failed', summary: 'tool crashed' });
  });

  it('hides housekeeping tasks and drops ended ones after a while', () => {
    const t = new TaskTracker();
    t.apply(level({ ...agent, task_id: 'w', ambient: true }), 0);
    expect(t.apply(sys('task_started', { ...agent, task_id: 'h', skip_transcript: true, is_backgrounded: true }), 0)).toBe(false);
    expect(t.list(0)).toEqual([]);
    t.apply(level(agent), 0);
    t.apply(sys('task_notification', { task_id: 'a1', status: 'failed', summary: '', output_file: '' }), 100);
    expect(t.list(100 + ENDED_SHOWN_MS - 1)).toHaveLength(1);
    expect(t.list(100 + ENDED_SHOWN_MS + 1)).toHaveLength(0);
  });
});
