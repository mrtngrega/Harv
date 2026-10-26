import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ChatServerMessage, EffortLevel, Project } from '@harv/shared';
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
  sent: { content: unknown; model: string; effort: EffortLevel; raw?: boolean }[] = [];

  constructor(
    readonly tabId: string,
    _model: string,
    _effort: EffortLevel,
    private emit: (msg: ChatServerMessage) => void,
    readonly hooks: SessionHooks,
    _store?: unknown,
    _gate?: unknown,
    _resume?: string,
    _delegate?: unknown,
    readonly mode: { project?: Project } = {},
  ) {
    FakeSession.all.set(tabId, this);
  }

  async send(content: unknown, model: string, effort: EffortLevel, raw = false) {
    this.busy = true;
    this.sent.push({ content, model, effort, raw });
  }

  context(tokens: number) {
    this.emit({ type: 'chat.context', tabId: this.tabId, tokens });
  }

  reply(text: string) {
    this.emit({ type: 'chat.assistant', tabId: this.tabId, text });
  }

  finish(ok = true) {
    this.busy = false;
    this.emit({ type: 'chat.done', tabId: this.tabId, ok, stopped: false, usage: { inputTokens: 10, outputTokens: 5, durationMs: 1 } });
  }

  async stop() {
    if (!this.busy) return;
    this.busy = false;
    this.emit({ type: 'chat.done', tabId: this.tabId, ok: false, stopped: true });
  }
  close() {}
  tasks() {
    return [];
  }
  async stopTask() {}
}

vi.mock('./session.ts', () => ({ ChatSession: FakeSession }));

const { ChatManager, ideaLine } = await import('./manager.ts');
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
    (m) => sent.push(m as ChatServerMessage),
    () => {},
  );
  const notices = (tabId: string) => sent.flatMap((m) => (m.type === 'chat.notice' && m.tabId === tabId ? [m.message] : []));
  return { chats, meter, routes, store, notices, sent };
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

describe('chat names', () => {
  it('names a chat from the classifier, until the user renames it', async () => {
    const sent: ChatServerMessage[] = [];
    const store = new ChatStore(':memory:');
    const routes = new RouteStore(':memory:');
    const gate = new SafetyGate(new ActionStore(':memory:'), { broadcast: () => {}, notice: () => {}, onChange: () => {} });
    const meter = new UsageMeter(
      { onChange: () => {}, onResume: () => {} },
      () => routes.summary(),
      async () => undefined,
    );
    let title = 'Week plan';
    const classify = vi.fn(async (..._args: unknown[]) => ({
      category: 'planning',
      difficulty: 3 as const,
      stakes: 'normal' as const,
      ambiguous: false,
      title,
    }));
    const chats = new ChatManager(
      store,
      gate,
      new Router(routes, classify),
      meter,
      (m) => sent.push(m as ChatServerMessage),
      () => {},
    );

    await chats.send('n', 'plan my week around the deadlines in notes.md', 'auto', 'medium');
    expect(store.title('n')).toBe('Week plan');
    expect(sent).toContainEqual({ type: 'chat.renamed', tabId: 'n', title: 'Week plan' });
    // The first message's own text isn't offered as a title to keep.
    expect(classify.mock.calls[0]![3]).toBeUndefined();
    FakeSession.all.get('n')!.finish();

    chats.rename('n', '  My   week ');
    expect(store.title('n')).toBe('My week');
    title = 'Something else';
    await chats.send('n', 'new question: now write a poem about tides and the moon', 'auto', 'medium');
    expect(store.title('n')).toBe('My week');
    FakeSession.all.get('n')!.finish();
  });

  it('names a new chat in manual mode with one classifier call', async () => {
    const { chats, store } = setup();
    // setup()'s classifier answers null, so the first-message title stays.
    await chats.send('m', 'hello there in manual mode', 'sonnet', 'medium');
    await settle();
    expect(store.title('m')).toBe('hello there in manual mode');
    FakeSession.all.get('m')!.finish();
  });

  it('saves a name given to a tab before its first message', () => {
    const { chats, store } = setup();
    chats.rename('blank', 'Ideas');
    expect(store.title('blank')).toBe('Ideas');
    expect(store.titleLocked('blank')).toBe(true);
  });

  it('forgets a chat without messages when its tab closes, keeps one with messages', () => {
    const { chats, store } = setup();
    chats.rename('tool', 'Terminal');
    chats.close('tool');
    expect(store.exists('tool')).toBe(false);
    store.ensureChat('talk', 'Weather');
    store.addLine('talk', { kind: 'you', text: 'rain?' });
    chats.close('talk');
    expect(store.exists('talk')).toBe(true);
  });
});

describe('hand-off between chats', () => {
  it('runs the task in a new tab and brings the answer back', async () => {
    const { chats, store } = setup();
    await chats.send('from', 'ask a new tab to check the weather', 'sonnet', 'medium');
    const pending = chats.delegate('from', { title: 'Weather', message: 'What is the weather in Bratislava?', wait: true });
    await settle();
    await settle();
    const target = [...FakeSession.all.values()].find((s) => s.tabId !== 'from' && String(s.sent[0]?.content).includes('Bratislava'))!;
    expect(String(target.sent[0]!.content)).toMatch(/^\[Handed over from your other chat/);
    expect(store.title(target.tabId)).toBe('Weather');
    target.reply('Sunny, 18°C.');
    target.finish();
    expect(await pending).toContain('Sunny, 18°C.');
    expect(store.snapshot(target.tabId)!.lines.map((l) => l.kind)).toEqual(['notice', 'you', 'harv']);
  });

  it('refuses to hand back to a chat that is waiting, and to a busy chat', async () => {
    const { chats, store } = setup();
    store.ensureChat('x', 'X');
    store.ensureChat('y', 'Y');
    const waiting = chats.delegate('x', { to: 'y', message: 'do a thing', wait: true });
    await settle();
    await settle();
    expect(await chats.delegate('y', { to: 'x', message: 'and back', wait: true })).toMatch(/wait on each other/);
    expect(await chats.delegate('z', { to: 'y', message: 'me too', wait: true })).toMatch(/busy/);
    FakeSession.all.get('y')!.finish();
    await waiting;
  });

  it('can start work without waiting', async () => {
    const { chats, store } = setup();
    store.ensureChat('p', 'P');
    store.ensureChat('q', 'Q');
    const result = await chats.delegate('p', { to: 'q', message: 'long job', wait: false });
    expect(result).toMatch(/Started in the "Q" tab/);
    expect(FakeSession.all.get('q')!.busy).toBe(true);
    FakeSession.all.get('q')!.finish();
  });
});

describe('chat names with a one-message override', () => {
  it('still names a new chat sent as "/haiku …" on AUTO', async () => {
    const store = new ChatStore(':memory:');
    const routes = new RouteStore(':memory:');
    const gate = new SafetyGate(new ActionStore(':memory:'), { broadcast: () => {}, notice: () => {}, onChange: () => {} });
    const meter = new UsageMeter(
      { onChange: () => {}, onResume: () => {} },
      () => routes.summary(),
      async () => undefined,
    );
    const classify = vi.fn(async (..._args: unknown[]) => ({
      category: 'chat',
      difficulty: 1 as const,
      stakes: 'normal' as const,
      ambiguous: false,
      title: 'Test file cleanup',
    }));
    const chats = new ChatManager(
      store,
      gate,
      new Router(routes, classify),
      meter,
      () => {},
      () => {},
    );
    await chats.send('o', '/haiku /low delete the test file', 'auto', 'medium');
    await vi.waitFor(() => expect(store.title('o')).toBe('Test file cleanup'));
    FakeSession.all.get('o')!.finish();
  });
});

describe('project mode', () => {
  it('moves a chat into a project: a new session in the folder, with the conversation so far', async () => {
    const { chats, store } = setup();
    await chats.send('p', 'we talked about a todo app', 'sonnet', 'medium');
    FakeSession.all.get('p')!.reply('Sounds good.');
    FakeSession.all.get('p')!.finish();
    const folder = mkdtempSync(join(tmpdir(), 'harv-proj-'));
    expect(chats.addProject(folder)).toBeUndefined();
    const project = store.projects()[0]!;
    expect(chats.setProject('p', project.id)).toBeUndefined();
    expect(store.projectOf('p')?.path).toBe(project.path);

    await chats.send('p', 'start with the data model', 'sonnet', 'medium');
    const session = FakeSession.all.get('p')!;
    expect(session.mode.project?.path).toBe(project.path);
    const first = String(session.sent[0]!.content);
    expect(first).toContain(`moved into the project "${project.name}"`);
    expect(first).toContain('we talked about a todo app');
    expect(first).toContain('start with the data model');
    session.finish();
    rmSync(folder, { recursive: true, force: true });
  });

  it('starts a new project: folder, git, CLAUDE.md, and the chat moves in', async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'harv-projects-'));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ projectsDir: projectsRoot }));
    try {
      const { chats, store } = setup();
      // Never the real gh: a test must not make GitHub repos.
      const made: [string, string, string][] = [];
      chats.createRepo = async (path, name, visibility) => {
        made.push([path, name, visibility]);
        return `https://github.com/me/${name}.git`;
      };
      type Start = (t: string, n: string, d: string, v: 'private' | 'public') => Promise<string>;
      const tools = (chats as unknown as { projectTools: { start: Start } }).projectTools;
      const reply = await tools.start('s', 'weather-app', 'A small weather dashboard.', 'private');
      const folder = join(projectsRoot, 'weather-app');
      expect(reply).toContain(folder);
      expect(reply).toContain('private GitHub repo is https://github.com/me/weather-app.git');
      expect(made).toEqual([[folder, 'weather-app', 'private']]);
      expect(readFileSync(join(folder, 'CLAUDE.md'), 'utf8')).toContain('A small weather dashboard.');
      expect(existsSync(join(folder, '.git'))).toBe(true);
      expect(store.projectOf('s')?.name).toBe('weather-app');
      expect(store.projectOf('s')?.remote).toBe('https://github.com/me/weather-app.git');
      // A second time, the folder exists: Harv has to ask.
      expect(await tools.start('t', 'weather-app', 'again', 'public')).toContain('already exists');
      // gh failing (not logged in) leaves the project on this device, and says how to fix it.
      chats.createRepo = async () => {
        throw new Error('gh: not logged in\nrun gh auth login');
      };
      const failed = await tools.start('u', 'notes', 'Notes.', 'public');
      expect(failed).toContain('Making its GitHub repo failed (gh: not logged in)');
      expect(failed).toContain('gh repo create notes --public --source . --push');
      expect(store.projectOf('u')?.remote).toBeUndefined();
      mkdirSync(join(projectsRoot, 'empty'), { recursive: true });
    } finally {
      rmSync(join(home, 'settings.json'), { force: true });
      rmSync(projectsRoot, { recursive: true, force: true });
    }
  });
});

describe('messages typed while Harv works', () => {
  it('queues them and runs them in order when the turn ends', async () => {
    const { chats, sent } = setup();
    await chats.send('q', 'first', 'sonnet', 'medium');
    const session = FakeSession.all.get('q')!;
    await chats.send('q', 'second', 'sonnet', 'medium');
    await chats.send('q', 'third', 'haiku', 'low');
    expect(session.sent.map((s) => s.content)).toEqual(['first']);
    const queued = sent.filter((m) => m.type === 'chat.queued');
    expect(queued.at(-1)).toMatchObject({ items: [{ text: 'second' }, { text: 'third' }] });
    expect(
      chats
        .openChats()
        .find((c) => c.id === 'q')
        ?.queued?.map((q) => q.text),
    ).toEqual(['second', 'third']);

    session.finish();
    await settle();
    expect(session.sent.map((s) => s.content)).toEqual(['first', 'second']);
    expect(sent.some((m) => m.type === 'chat.line' && m.tabId === 'q' && m.line.kind === 'you' && m.line.text === 'second')).toBe(true);
    session.finish();
    await settle();
    expect(session.sent.at(-1)).toMatchObject({ content: 'third', model: 'haiku', effort: 'low' });
    expect(sent.filter((m) => m.type === 'chat.queued').at(-1)).toMatchObject({ items: [] });
  });

  it('can drop a queued message before it runs', async () => {
    const { chats } = setup();
    await chats.send('u', 'first', 'sonnet', 'medium');
    await chats.send('u', 'oops', 'sonnet', 'medium');
    const [item] = chats.openChats().find((c) => c.id === 'u')!.queued!;
    chats.unqueue('u', item!.id);
    FakeSession.all.get('u')!.finish();
    await settle();
    expect(FakeSession.all.get('u')!.sent.map((s) => s.content)).toEqual(['first']);
  });

  it('"send now" stops the reply and runs that message first', async () => {
    const { chats } = setup();
    await chats.send('n', 'first', 'sonnet', 'medium');
    await chats.send('n', 'later', 'sonnet', 'medium');
    await chats.send('n', 'urgent', 'sonnet', 'medium');
    const urgent = chats
      .openChats()
      .find((c) => c.id === 'n')!
      .queued!.find((q) => q.text === 'urgent')!;
    await chats.sendNow('n', urgent.id);
    await settle();
    const session = FakeSession.all.get('n')!;
    expect(session.sent.map((s) => s.content)).toEqual(['first', 'urgent']);
    expect(
      chats
        .openChats()
        .find((c) => c.id === 'n')!
        .queued!.map((q) => q.text),
    ).toEqual(['later']);
  });
});

describe('/btw side questions', () => {
  it('answers right away, even mid-reply, without queueing or touching the chat', async () => {
    const { chats, sent } = setup();
    const asked: { question: string; resume?: string }[] = [];
    chats.ask = async (question, _model, _chat, resume) => {
      asked.push({ question, resume });
      return 'It means the file is locked.';
    };
    await chats.send('b', 'first', 'sonnet', 'medium');
    const session = FakeSession.all.get('b')!;
    session.hooks.onSessionId('sess-1');
    await chats.send('b', '/btw what does EBUSY mean?', 'sonnet', 'medium');
    expect(asked).toEqual([{ question: 'what does EBUSY mean?', resume: 'sess-1' }]);
    expect(session.sent.map((s) => s.content)).toEqual(['first']);
    expect(chats.openChats().find((c) => c.id === 'b')?.queued).toBeUndefined();
    const lines = sent.flatMap((m) => (m.type === 'chat.line' && m.tabId === 'b' ? [m.line] : []));
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['you', '/btw what does EBUSY mean?'],
      ['harv', 'It means the file is locked.'],
    ]);
    expect(lines[1]!.tag).toMatch(/^btw·/);
  });

  it('says how to use it when the question is missing', async () => {
    const { chats, notices } = setup();
    chats.ask = async () => 'never';
    await chats.send('e', '/btw', 'sonnet', 'medium');
    expect(notices('e').at(-1)).toMatch(/side question/);
  });

  it('says why when it could not answer (it used to say only "Couldn’t answer")', async () => {
    const { chats, notices } = setup();
    chats.ask = async () => ({ error: 'error_max_turns' });
    await chats.send('x', '/btw what is this?', 'sonnet', 'medium');
    expect(notices('x').at(-1)).toBe('Couldn’t answer that side question (error_max_turns). Try again, or ask it as a normal message.');
  });
});

describe('slash commands', () => {
  it('sends a Claude Code command as typed, without the router, at the last model', async () => {
    const { chats } = setup();
    chats.catalog = { plan: 'Claude Pro', models: [], commands: [{ name: 'compact', description: '', argumentHint: '' }] };
    await chats.send('s', 'hello', 'haiku', 'low');
    const session = FakeSession.all.get('s')!;
    session.finish();
    await chats.send('s', '/compact keep the plan', 'auto', 'medium');
    expect(session.sent.at(-1)).toEqual({ content: '/compact keep the plan', model: 'haiku', effort: 'low', raw: true });
  });

  it('/clear empties the tab and its saved lines once it worked (the user’s wish)', async () => {
    const { chats, sent } = setup();
    chats.catalog = { plan: 'Claude Pro', models: [], commands: [{ name: 'clear', description: '', argumentHint: '' }] };
    await chats.send('c', 'hello', 'haiku', 'low');
    const session = FakeSession.all.get('c')!;
    session.reply('Hi!');
    session.finish();
    await chats.send('c', '/clear', 'auto', 'medium');
    expect(sent.some((m) => m.type === 'chat.cleared')).toBe(false);
    session.finish();
    expect(sent.filter((m) => m.type === 'chat.cleared')).toEqual([{ type: 'chat.cleared', tabId: 'c' }]);
    expect(chats.openChats().find((c) => c.id === 'c')?.lines).toEqual([]);
    // Other commands leave the log alone.
    chats.catalog.commands.push({ name: 'compact', description: '', argumentHint: '' });
    await chats.send('c', 'again', 'haiku', 'low');
    session.finish();
    await chats.send('c', '/compact', 'auto', 'medium');
    session.finish();
    expect(chats.openChats().find((c) => c.id === 'c')?.lines.length).toBeGreaterThan(0);
  });

  it('refuses commands that could bill or only work in a terminal, and leaves other slashes alone', async () => {
    const { chats, notices } = setup();
    chats.catalog = { plan: 'Claude Pro', models: [], commands: [] };
    await chats.send('r', '/ultrareview', 'sonnet', 'medium');
    expect(notices('r').at(-1)).toMatch(/doesn’t run \/ultrareview.*subscription/);
    expect(FakeSession.all.get('r')).toBeUndefined();
    await chats.send('r2', '/c/Users/me/notes.txt what is in it', 'sonnet', 'medium');
    expect(FakeSession.all.get('r2')!.sent[0]!.raw).toBe(false);
  });
});

describe('context meter', () => {
  it("keeps each message's own context, not the turn's sum over every API call", async () => {
    const { chats, store, sent } = setup();
    await chats.send('ctx', 'look around the repo', 'sonnet', 'medium');
    const session = FakeSession.all.get('ctx')!;
    session.context(31_000);
    session.context(42_500);
    session.finish(); // its usage sums all calls of the turn
    expect(store.snapshot('ctx')!.context).toBe(42_500);
    expect(sent.filter((m) => m.type === 'chat.context').map((m) => (m as { tokens: number }).tokens)).toEqual([31_000, 42_500]);
  });
});

describe("the other device's projects", { timeout: 60_000 }, () => {
  it('clones a new one into the projects folder, and unlists it when it goes there', async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'harv-projects-'));
    const bare = join(projectsRoot, 'github', 'car_radio.git');
    mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ projectsDir: projectsRoot }));
    try {
      const { chats, store, sent } = setup();
      const none = {
        lines: new Map(),
        forks: new Set<string>(),
        renamed: new Map(),
        moved: new Set<string>(),
        cleared: new Set<string>(),
        deleted: new Set<string>(),
        history: false,
      };
      chats.remote({ ...none, projects: [{ name: 'car_radio', remote: bare, removed: false }] });
      await vi.waitFor(() => expect(store.projects().map((p) => p.name)).toEqual(['car_radio']), { timeout: 30_000 });
      const project = store.projects()[0]!;
      expect(project.path).toBe(join(projectsRoot, 'car_radio'));
      expect(project.remote).toBe(bare);
      expect(existsSync(join(project.path, '.git'))).toBe(true);
      const notices = () =>
        (sent as { type: string; message?: string }[]).flatMap((m) => (m.type === 'project.notice' ? [m.message!] : []));
      expect(notices().at(-1)).toContain('cloned into');

      chats.remote({ ...none, projects: [{ name: 'car_radio', remote: bare, removed: true }] });
      await vi.waitFor(() => expect(store.projects()).toEqual([]));
      expect(existsSync(project.path)).toBe(true);
      expect(notices().at(-1)).toContain('its folder');
    } finally {
      rmSync(join(home, 'settings.json'), { force: true });
      rmSync(projectsRoot, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe('/report', () => {
  it('writes a dated one-line note to the ideas file, without a model call, even mid-reply', async () => {
    const { chats, store, sent } = setup();
    const ideas = join(home, 'ideas.txt');
    writeFileSync(ideas, '- an older note');
    chats.ideasFile = ideas;
    await chats.send('r', 'look at the stats panel', 'sonnet', 'medium');
    store.setTitle('r', 'Stats', true);
    await chats.send('r', '/report the GPU fan\n reads 0 rpm', 'sonnet', 'medium');
    const text = readFileSync(ideas, 'utf8').split('\n');
    expect(text[0]).toBe('- an older note');
    expect(text[1]).toMatch(/^- \[\d{1,2} \w{3} \d{2}:\d{2} · .+ · Stats\] the GPU fan reads 0 rpm$/);
    expect(text[2]).toBe('');
    expect(FakeSession.all.get('r')!.sent).toHaveLength(1);
    expect(sent.some((m) => m.type === 'chat.notice' && m.tabId === 'r' && m.message === 'Noted in the ideas file.')).toBe(true);
    expect(chats.openChats().find((c) => c.id === 'r')?.queued).toBeUndefined();
    FakeSession.all.get('r')!.finish();
  });

  it('formats the note like the plan says', () => {
    expect(ideaLine(' explorer   forgets\nthe folder ', new Date(2026, 9, 25, 13, 5), 'PC', 'Files  chat')).toBe(
      '- [25 Oct 13:05 · PC · Files chat] explorer forgets the folder',
    );
  });
});

describe('/fresh', () => {
  it('saves and summarizes in one turn, then the next message starts a new session from the summary', async () => {
    const { chats, store, sent } = setup();
    await chats.send('f', 'plan the radio app', 'sonnet', 'high');
    const old = FakeSession.all.get('f')!;
    old.hooks.onSessionId('session-1');
    old.reply('Here is a plan.');
    old.finish();

    await chats.send('f', '/fresh', 'sonnet', 'medium');
    expect(String(old.sent.at(-1)!.content)).toContain('[/fresh');
    expect(old.sent.at(-1)).toMatchObject({ model: 'sonnet', effort: 'high' });
    old.reply('Saved the stack choice to memory.');
    old.reply('We are building a radio app. Next: the data model.');
    old.finish();
    await settle();
    expect(store.getSession('f')).toBeNull();
    expect(store.snapshot('f')!.lines.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('— fresh session —') });
    expect(sent.filter((m) => m.type === 'chat.context').at(-1)).toMatchObject({ tokens: 0 });

    await chats.send('f', 'go on', 'sonnet', 'medium');
    const next = FakeSession.all.get('f')!;
    expect(next).not.toBe(old);
    const first = String(next.sent[0]!.content);
    expect(first).toContain('handoff summary from the previous session');
    expect(first).toContain('We are building a radio app. Next: the data model.');
    expect(first).not.toContain('Saved the stack choice');
    expect(first.endsWith('go on')).toBe(true);
    next.finish();
  });

  it('says a chat without a session is already fresh', async () => {
    const { chats, notices } = setup();
    await chats.send('g', '/fresh', 'sonnet', 'medium');
    expect(notices('g').at(-1)).toMatch(/already fresh/);
    expect(FakeSession.all.has('g')).toBe(false);
  });
});

describe('found in the test pass (2026-10-25)', () => {
  it('shows a turn Claude starts by itself as a turn, logged on its own (F1)', async () => {
    const { chats, routes, sent } = setup();
    await chats.send('auto', 'start the build in the background', 'sonnet', 'medium');
    const session = FakeSession.all.get('auto')!;
    session.finish();
    const before = routes.summary();
    // A background task finished: Claude Code starts a turn with no message from the user.
    session.hooks.onAutoTurn!();
    const started = sent.filter((m) => m.type === 'chat.started' && m.tabId === 'auto').at(-1);
    expect(started).toMatchObject({ model: 'sonnet', effort: 'medium', reason: expect.stringContaining('background task') });
    session.finish();
    // Its own row: the first turn's tokens stay, this one's are added (they used to overwrite them).
    const after = routes.summary();
    expect(after.turnsToday).toBe(before.turnsToday + 1);
    expect(after.inputTokensToday).toBe(before.inputTokensToday + 10);
  });

  it('sends a message that arrives right after a project switch to the new session, not the old one (F4)', async () => {
    const { chats, store } = setup();
    await chats.send('sw', 'we talked about a radio app', 'sonnet', 'medium');
    const old = FakeSession.all.get('sw')!;
    const folder = mkdtempSync(join(tmpdir(), 'harv-proj-'));
    expect(chats.addProject(folder)).toBeUndefined();
    // Mid-turn, the chat moves into the project (Harv's open_project); its session goes when the turn ends.
    chats.setProject('sw', store.projects().find((p) => p.path === folder)!.id);
    old.finish();
    // The answer comes in before the old session's drop got its turn.
    await chats.send('sw', 'private', 'sonnet', 'medium');
    const now = FakeSession.all.get('sw')!;
    expect(now).not.toBe(old);
    expect(String(now.sent[0]!.content)).toContain('private');
    expect(old.sent).toHaveLength(1);
    now.finish();
    rmSync(folder, { recursive: true, force: true });
  });
});

describe('sync of tabs and project work (docs/PLAN.md §6m)', () => {
  it("opens the other device's tabs here and closes the ones it closed, but not busy ones", async () => {
    const { chats, store, sent } = setup();
    for (const id of ['keep', 'gone', 'busy']) {
      store.ensureChat(id, id);
      store.addLine(id, { kind: 'you', text: 'hi' });
    }
    store.ensureChat('closed', 'closed');
    store.addLine('closed', { kind: 'you', text: 'hi' });
    store.setOpen('closed', false);
    await chats.send('busy', 'working on it', 'sonnet', 'medium');
    chats.applyRemoteUi({ order: ['keep', 'closed', 'blank1'], blanks: ['blank1'], drafts: {}, attachments: {} });
    const open = store.openChats().map((c) => c.id);
    expect(open).toEqual(expect.arrayContaining(['keep', 'closed', 'busy']));
    expect(open).not.toContain('gone');
    expect(sent.some((m) => m.type === 'chat.opened' && m.chat.id === 'closed' && m.focus === false)).toBe(true);
    expect(sent.some((m) => m.type === 'chat.removed' && m.tabId === 'gone')).toBe(true);
    FakeSession.all.get('busy')!.finish();
  });

  it('says once that a project has unpushed work on the other device', () => {
    const { chats, sent } = setup();
    const said = () => sent.filter((m) => (m as { type: string }).type === 'project.notice').length;
    chats.peerProjectState('car_radio', 'notebook', true);
    chats.peerProjectState('car_radio', 'notebook', true);
    expect(said()).toBe(1);
    chats.peerProjectState('car_radio', 'notebook', false);
    chats.peerProjectState('car_radio', 'notebook', true);
    expect(said()).toBe(2);
  });
});
