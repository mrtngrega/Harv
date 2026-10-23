import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ChatServerMessage, EffortLevel } from '@harv/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SessionHooks } from './session.ts';

const home = mkdtempSync(join(tmpdir(), 'harv-manager-'));
vi.stubEnv('HARV_HOME', home);
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Stands in for a Claude Code session: records what it was sent, finishes turns on demand. */
class FakeSession {
  static all = new Map<string, FakeSession>();
  busy = false;
  toolRunning = false;
  sent: { content: unknown; model: string; effort: EffortLevel }[] = [];

  constructor(
    readonly tabId: string,
    _model: string,
    _effort: EffortLevel,
    private emit: (msg: ChatServerMessage) => void,
    readonly hooks: SessionHooks,
  ) {
    FakeSession.all.set(tabId, this);
  }

  async send(content: unknown, model: string, effort: EffortLevel) {
    this.busy = true;
    this.sent.push({ content, model, effort });
  }

  finish(ok = true) {
    this.busy = false;
    this.emit({ type: 'chat.done', tabId: this.tabId, ok, stopped: false, usage: { inputTokens: 10, outputTokens: 5, durationMs: 1 } });
  }

  async stop() {}
  close() {}
}

vi.mock('./session.ts', () => ({ ChatSession: FakeSession }));

const { ChatManager } = await import('./manager.ts');
const { SafetyGate } = await import('../safety/gate.ts');
const { ActionStore } = await import('../store/actions.ts');
const { ChatStore } = await import('../store/chats.ts');
const { RouteStore } = await import('../store/routes.ts');
const { Router } = await import('../router/router.ts');
const { UsageMeter } = await import('../usage/meter.ts');

function setup() {
  const sent: ChatServerMessage[] = [];
  const store = new ChatStore(':memory:');
  const routes = new RouteStore(':memory:');
  const gate = new SafetyGate(new ActionStore(':memory:'), { broadcast: () => {}, notice: () => {}, onChange: () => {} });
  const meter = new UsageMeter(
    { onChange: () => {}, onResume: () => void chats.flushQueue() },
    () => routes.summary(),
    async () => undefined,
  );
  const chats = new ChatManager(
    store,
    gate,
    new Router(routes, async () => null),
    meter,
    (m) => sent.push(m),
    () => {},
  );
  const notices = (tabId: string) => sent.flatMap((m) => (m.type === 'chat.notice' && m.tabId === tabId ? [m.message] : []));
  return { chats, meter, routes, store, notices };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('limit handling', () => {
  it('queues messages while paused and sends them in order after the reset', async () => {
    const { chats, meter, notices } = setup();
    await chats.send('a', 'hello there', 'sonnet', 'medium');
    FakeSession.all.get('a')!.finish();

    meter.pause(Date.now() + 60_000);
    await chats.send('a', 'first queued', 'sonnet', 'medium');
    await chats.send('b', 'second queued', 'haiku', 'low');
    expect(chats.status).toBe('paused');
    expect(meter.snapshot().queued).toBe(2);
    expect(notices('a').at(-1)).toMatch(/queued/);
    expect(FakeSession.all.get('a')!.sent).toHaveLength(1);

    // Pretend the reset happened.
    (meter as unknown as { pausedUntil: number | null }).pausedUntil = null;
    const flushing = chats.flushQueue();
    await settle();
    expect(FakeSession.all.get('a')!.sent.at(-1)!.content).toBe('first queued');
    expect(FakeSession.all.has('b')).toBe(false);
    FakeSession.all.get('a')!.finish();
    await settle();
    expect(FakeSession.all.get('b')!.sent.at(-1)).toMatchObject({ content: 'second queued', model: 'haiku', effort: 'low' });
    FakeSession.all.get('b')!.finish();
    await flushing;
    expect(meter.snapshot().queued).toBe(0);
  });

  it('continues a turn the limit cut off, at the same model·effort', async () => {
    const { chats, meter, notices } = setup();
    await chats.send('c', 'write the report', 'opus', 'high');
    const session = FakeSession.all.get('c')!;
    const rejected: SDKRateLimitInfo = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 600 };
    session.hooks.onRateLimit(rejected);
    session.finish(false);
    expect(meter.paused).toBe(true);
    expect(notices('c').at(-1)).toMatch(/pick this up where it left off/);

    (meter as unknown as { pausedUntil: number | null }).pausedUntil = null;
    const flushing = chats.flushQueue();
    await settle();
    expect(session.sent.at(-1)).toMatchObject({ model: 'opus', effort: 'high' });
    expect(String(session.sent.at(-1)!.content)).toMatch(/continue where you left off/);
    session.finish();
    await flushing;
  });

  it('Stop cancels a tab’s queued messages', async () => {
    const { chats, meter, notices } = setup();
    meter.pause(Date.now() + 60_000);
    await chats.send('d', 'one', 'sonnet', 'medium');
    await chats.send('d', 'two', 'sonnet', 'medium');
    await chats.stop('d');
    expect(meter.snapshot().queued).toBe(0);
    expect(notices('d').at(-1)).toBe('Removed 2 queued messages.');
  });

  it('logs every turn with its tokens for Harv’s own stats', async () => {
    const { chats, routes } = setup();
    await chats.send('e', 'hello there', 'sonnet', 'medium');
    FakeSession.all.get('e')!.finish();
    expect(routes.summary()).toMatchObject({ turnsToday: 1, inputTokensToday: 10, outputTokensToday: 5 });
    expect(routes.summary().split).toEqual([{ model: 'sonnet', effort: 'medium', turns: 1, harder: 0 }]);
  });
});
