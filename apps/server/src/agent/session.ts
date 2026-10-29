import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatServerMessage, EffortLevel, Project, SlashCommandInfo } from '@harv/shared';
import type { SafetyGate } from '../safety/gate.ts';
import type { ChatStore } from '../store/chats.ts';
import type { ContentBlockParam } from './attachments.ts';
import type { BrowserTools, Delegate, ImageTools, ProjectTools, ScheduleTools, TerminalTools } from './chatTools.ts';
import { toCommandInfo } from './commands.ts';
import { describeTool, MEMORY_TOOLS } from './guard.ts';
import { memoryChanges, memorySnapshot } from './memory.ts';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES } from './options.ts';
import { AsyncQueue } from './queue.ts';
import { killShellTree } from './killTree.ts';
import { TaskTracker } from './tasks.ts';

type Emit = (msg: ChatServerMessage) => void;

export interface SessionHooks {
  onStateChange: () => void;
  /** Claude Code's session id, stored so the chat can be resumed after a restart. */
  onSessionId: (sessionId: string) => void;
  /** Resuming an old session failed before it started (e.g. its transcript is gone). */
  onResumeFailed: () => void;
  /** Live plan usage from Claude; `rejected` means a limit is hit. */
  onRateLimit: (info: SDKRateLimitInfo) => void;
  /** The session's slash commands (on start, and when it finds new skills). */
  onCommands?: (commands: SlashCommandInfo[]) => void;
  /** Claude started a turn by itself (a background task it started finished): no message from the user began it. */
  onAutoTurn?: () => void;
  /** A turn ended: the last entry of the conversation so far, where a later rewind can resume. */
  onChainEnd?: (uuid: string) => void;
  /** The Claude process is gone (it crashed, quit, or was refused): this session takes no more messages. */
  onEnded?: () => void;
}

/** Where one of the user's messages sits in the Claude conversation, for rewinding to before it. */
export interface TurnMark {
  /** The message's own uuid (file checkpoints are taken there). */
  uuid: string;
  /** The conversation's last entry before it (none: it was the session's first message). */
  forkAt?: string;
}

/** How a session starts: resumed, cut back to a point (a rewind), in plan mode. */
export interface SessionStart {
  resume?: string;
  resumeAt?: string;
  /** The last entry of the conversation so far (stored), so the next message knows where it starts. */
  chainEnd?: string;
  planning?: boolean;
}

/** What a local command like /context or /usage printed (it comes back as a user message). */
const LOCAL_OUTPUT = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/g;
// eslint-disable-next-line no-control-regex -- terminal colour codes start with ESC
const ANSI = /\x1b\[[0-9;]*m/g;

const ERROR_TEXT: Record<string, string> = {
  rate_limit: 'Claude Pro usage limit reached. Harv will be able to continue after the limit resets.',
  authentication_failed: 'Claude Code isn’t logged in. Run `claude` in a terminal and log in with your subscription.',
  billing_error: 'Claude reported a billing problem with the subscription.',
  overloaded: 'Claude is overloaded right now. Try again in a moment.',
  model_not_found: 'That model isn’t available on your plan.',
};

const clock = (epochSec: number) => new Date(epochSec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * One chat tab = one long-lived Claude Code session in streaming input mode,
 * so model and effort can change between messages without losing context.
 */
export class ChatSession {
  private input = new AsyncQueue<SDKUserMessage>();
  private abort = new AbortController();
  private q: Query;
  private stopping = false;
  private closed = false;
  /** The Claude process is gone; nothing more can be sent. */
  private ended = false;
  private started = false;
  /** The memories this session knows about (its system prompt, plus notes since). */
  private memory = memorySnapshot();
  private usedMemoryTool = false;
  /** Whether this turn showed any text (a slash command's only output may be its result). */
  private said = false;
  busy = false;
  toolRunning = false;
  /** The tool running now, for the status pill ("working · Read"). */
  toolName: string | undefined;
  /** This turn's output tokens: finished messages (exact) plus the streaming one (characters / 4). */
  private turnTokens = 0;
  private streamChars = 0;
  /**
   * Thinking tokens of the message streaming now, from the SDK's estimate. Thinking arrives
   * hidden (empty deltas), so without it the count stood still for minutes while Opus thought
   * and Harv looked stuck (the user's report, 2026-10-25). The exact count replaces it at the end.
   */
  private thinkingTokens = 0;
  /** The thinking block streaming now: its index in the message, when it started, its summary so far. */
  private thought: { index: number; at: number; text: string } | null = null;
  private progressAt = 0;
  /** What the latest API call sent: the context it had (the turn's summed usage counts the context once per call). */
  private contextIn = 0;
  /** Subagents and shells this chat runs in the background, for the strip above the prompt. */
  private taskTracker = new TaskTracker();
  /** Background Bash commands by tool call (subagents' too), so stopping one can end what it started. */
  private shellCommands = new Map<string, string>();
  /** The conversation's latest entry (an assistant message or a tool result), for rewind marks. */
  private chainEnd: string | undefined;
  private resume?: string;

  constructor(
    readonly tabId: string,
    private model: string,
    private effort: EffortLevel,
    private emit: Emit,
    private hooks: SessionHooks,
    private store: ChatStore,
    gate: SafetyGate,
    start: SessionStart = {},
    delegate?: Delegate,
    mode: {
      project?: Project;
      projects?: ProjectTools;
      schedules?: ScheduleTools;
      terminal?: TerminalTools;
      images?: ImageTools;
      browser?: BrowserTools;
    } = {},
  ) {
    this.resume = start.resume;
    this.chainEnd = start.resumeAt ?? start.chainEnd;
    this.q = query({
      prompt: this.input,
      options: buildOptions(model, effort, this.abort, {
        resume: start.resume,
        resumeAt: start.resumeAt,
        planning: start.planning,
        chat: { store, tabId, gate, delegate, ...mode },
      }),
    });
    void this.consume();
  }

  /** Plan mode on or off: Claude Code's own plan mode, so Claude gets its planning instructions. */
  async setPlanning(on: boolean): Promise<void> {
    await this.q.setPermissionMode(on ? 'plan' : 'default');
  }

  /** Puts the files Claude changed back as they were before this message (file checkpoints). */
  async rewindFiles(uuid: string) {
    // A real rewind doesn't say which files it changed; a dry run first does.
    const preview = await this.q.rewindFiles(uuid, { dryRun: true });
    if (!preview.canRewind) return preview;
    const result = await this.q.rewindFiles(uuid);
    return { ...result, filesChanged: result.filesChanged?.length ? result.filesChanged : preview.filesChanged };
  }

  /**
   * `raw`: a slash command, sent exactly as typed (a memory note in front would stop Claude Code seeing the command).
   * Returns where the message sits in the conversation, for a later rewind.
   */
  async send(content: string | ContentBlockParam[], model: string, effort: EffortLevel, raw = false): Promise<TurnMark> {
    if (this.closed || this.ended) throw new Error('this Claude session has ended');
    if (model !== this.model) {
      await this.q.setModel(model);
      this.model = model;
    }
    if (effort !== this.effort) {
      await this.q.applyFlagSettings({ effortLevel: effort });
      this.effort = effort;
    }
    this.stopping = false;
    this.said = false;
    this.turnTokens = 0;
    this.streamChars = 0;
    this.thinkingTokens = 0;
    this.setBusy(true);
    const message = raw ? content : this.withMemoryNote(content);
    const uuid = randomUUID();
    const mark: TurnMark = { uuid, ...(this.chainEnd ? { forkAt: this.chainEnd } : {}) };
    this.chainEnd = uuid;
    this.input.push({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, uuid });
    return mark;
  }

  /** Tells Claude about memories other chats saved or forgot since this one last knew. */
  private withMemoryNote(content: string | ContentBlockParam[]): string | ContentBlockParam[] {
    const now = memorySnapshot();
    const changes = memoryChanges(this.memory, now);
    this.memory = now;
    if (!changes) return content;
    const note = `[Your memory changed since this chat last saw it (another chat, or the user, edited it):\n${changes}]`;
    return typeof content === 'string' ? `${note}\n\n${content}` : [{ type: 'text', text: note }, ...content];
  }

  async stop(): Promise<void> {
    if (!this.busy) return;
    this.stopping = true;
    await this.q.interrupt();
  }

  /** Stops one background task, with everything it started; the SDK reports its end as a task_notification. */
  async stopTask(taskId: string): Promise<void> {
    const toolUse = this.taskTracker.toolUseOf(taskId);
    const command = toolUse && this.shellCommands.get(toolUse);
    if (command) await killShellTree(command);
    await this.q.stopTask(taskId);
  }

  tasks() {
    return this.taskTracker.list();
  }

  /**
   * Ends the session. Background shells and agents it started are stopped first: closing
   * Claude Code alone left them running (on Windows its child processes outlive it).
   */
  close(): void {
    this.closed = true;
    const running = this.taskTracker.list().filter((t) => t.status === 'running');
    const end = () => {
      this.input.end();
      this.q.close();
    };
    if (!running.length) return end();
    const stops = Promise.allSettled(running.map((t) => this.stopTask(t.id)));
    void Promise.race([stops, new Promise((r) => setTimeout(r, 5000))]).finally(end);
  }

  private say(text: string) {
    this.said = true;
    this.emit({ type: 'chat.assistant', tabId: this.tabId, text });
  }

  /** Live token count for the status line, like Claude Code's "↓ 1.2k tokens" (at most twice a second). */
  private countTokens(ev: { type: string; delta?: unknown; usage?: unknown }) {
    if (ev.type === 'content_block_delta') {
      const d = ev.delta as { text?: string; thinking?: string; partial_json?: string };
      this.streamChars += (d.text ?? d.thinking ?? d.partial_json ?? '').length;
    } else if (ev.type === 'message_delta') {
      this.turnTokens +=
        (ev.usage as { output_tokens?: number } | undefined)?.output_tokens ?? Math.ceil(this.streamChars / 4) + this.thinkingTokens;
      this.streamChars = 0;
      this.thinkingTokens = 0;
    } else {
      return;
    }
    this.progress(ev.type === 'message_delta');
  }

  /** Sends the turn's output tokens so far to the status line (at most twice a second unless `now`). */
  private progress(now = false) {
    const at = Date.now();
    if (!now && at - this.progressAt < 500) return;
    this.progressAt = at;
    this.emit({
      type: 'chat.progress',
      tabId: this.tabId,
      outputTokens: this.turnTokens + this.thinkingTokens + Math.ceil(this.streamChars / 4),
    });
  }

  /** The context meter, live: each main-thread message's own input (cached parts included), then plus its output. */
  private trackContext(ev: { type: string; message?: unknown; usage?: unknown }) {
    type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    if (ev.type === 'message_start') {
      const u = ((ev.message as { usage?: Usage } | undefined)?.usage ?? {}) as Usage;
      this.contextIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (this.contextIn > 0) this.emit({ type: 'chat.context', tabId: this.tabId, tokens: this.contextIn });
    } else if (ev.type === 'message_delta' && this.contextIn > 0) {
      const out = (ev.usage as Usage | undefined)?.output_tokens ?? 0;
      this.emit({ type: 'chat.context', tabId: this.tabId, tokens: this.contextIn + out });
    }
  }

  private setBusy(busy: boolean, toolRunning = false) {
    this.busy = busy;
    this.toolRunning = toolRunning;
    if (!toolRunning) this.toolName = undefined;
    this.hooks.onStateChange();
  }

  private async consume() {
    let resumeFailed = false;
    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (err) {
      if (this.resume && !this.started) {
        resumeFailed = true;
        this.hooks.onResumeFailed();
      } else if (!this.closed) {
        this.emit({ type: 'chat.error', tabId: this.tabId, message: `Claude session ended: ${(err as Error).message}` });
      }
    } finally {
      this.ended = true;
      if (this.busy) this.emit({ type: 'chat.done', tabId: this.tabId, ok: false, stopped: this.stopping });
      this.setBusy(false);
      // A dead session left in place swallowed every later message (the tab stayed "thinking").
      if (!resumeFailed) this.hooks.onEnded?.();
    }
  }

  private handle(msg: SDKMessage) {
    const tabId = this.tabId;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'thinking_tokens') {
          this.thinkingTokens += Math.max(0, msg.estimated_tokens_delta);
          this.progress();
          return;
        }
        if (this.taskTracker.apply(msg)) {
          this.emit({ type: 'chat.tasks', tabId, tasks: this.taskTracker.list() });
          return;
        }
        if (msg.subtype === 'commands_changed') {
          this.hooks.onCommands?.(toCommandInfo(msg.commands));
          return;
        }
        if (msg.subtype === 'compact_boundary') {
          this.emit({ type: 'chat.notice', tabId, message: 'Conversation compacted: the older part is summarized now.' });
          return;
        }
        if (msg.subtype !== 'init') return;
        this.started = true;
        void this.q
          .supportedCommands()
          .then((commands) => this.hooks.onCommands?.(toCommandInfo(commands, msg.terminal_slash_commands ?? [])))
          .catch(() => {});
        this.hooks.onSessionId(msg.session_id);
        if (!SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) {
          // Hard stop: this would bill per token instead of using the subscription.
          this.emit({
            type: 'chat.error',
            tabId,
            message: `Refused: Claude Code is authenticating with "${msg.apiKeySource}" instead of your subscription.`,
          });
          this.close();
        }
        return;

      case 'user': {
        if (msg.parent_tool_use_id) return;
        if (msg.uuid) this.chainEnd = msg.uuid;
        const content = msg.message.content;
        const text = typeof content === 'string' ? content : '';
        const output = [...text.matchAll(LOCAL_OUTPUT)].map((m) => m[1]!.replace(ANSI, '').trim()).filter(Boolean);
        if (output.length) this.say(output.join('\n\n'));
        return;
      }

      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.emit({ type: 'chat.delta', tabId, text: ev.delta.text });
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') {
          this.thought = { index: ev.index, at: Date.now(), text: '' };
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta' && this.thought?.index === ev.index) {
          this.thought.text += ev.delta.thinking;
        } else if (ev.type === 'content_block_stop' && this.thought?.index === ev.index) {
          const { at, text } = this.thought;
          this.thought = null;
          if (text.trim())
            this.emit({ type: 'chat.thinking', tabId, text: text.trim(), seconds: Math.max(1, Math.round((Date.now() - at) / 1000)) });
        } else if (ev.type === 'message_start' && this.toolRunning) {
          this.setBusy(true, false);
        } else if (ev.type === 'message_start' && !this.busy && !this.closed) {
          // A turn nobody sent: Claude picked something up by itself (a background task finished).
          this.said = false;
          this.turnTokens = 0;
          this.streamChars = 0;
          this.thinkingTokens = 0;
          this.hooks.onAutoTurn?.();
          this.setBusy(true);
        }
        this.countTokens(ev);
        this.trackContext(ev);
        return;
      }

      case 'assistant': {
        for (const block of msg.message.content) {
          const input = (block.type === 'tool_use' ? block.input : undefined) as
            { command?: unknown; run_in_background?: unknown } | undefined;
          if (block.type === 'tool_use' && block.name === 'Bash' && input?.run_in_background && typeof input.command === 'string') {
            this.shellCommands.set(block.id, input.command);
          }
        }
        if (msg.parent_tool_use_id) return;
        if (msg.uuid) this.chainEnd = msg.uuid;
        if (msg.error === 'rate_limit') this.hooks.onRateLimit({ status: 'rejected' });
        if (msg.error && msg.error !== 'max_output_tokens') {
          this.emit({ type: 'chat.error', tabId, message: ERROR_TEXT[msg.error] ?? `Claude error: ${msg.error}` });
        }
        let text = '';
        let usedTool = false;
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text;
          if (block.type === 'tool_use') {
            usedTool = true;
            if (MEMORY_TOOLS.includes(block.name)) this.usedMemoryTool = true;
            this.toolName = block.name.replace(/^mcp__harv__/, '');
            if (text) {
              this.say(text);
              text = '';
            }
            const input = (block.input ?? {}) as Record<string, unknown>;
            this.emit({
              type: 'chat.tool',
              tabId,
              id: block.id,
              name: block.name.replace(/^mcp__harv__/, ''),
              detail: describeTool(block.name, input, (id) => this.store.title(id)),
            });
          }
        }
        if (text) this.say(text);
        if (usedTool) this.setBusy(true, true);
        return;
      }

      case 'result': {
        // This chat's own memory edits are already in its context; don't report them back to it.
        if (this.usedMemoryTool) this.memory = memorySnapshot();
        this.usedMemoryTool = false;
        const ok = msg.subtype === 'success' && !msg.is_error;
        // A command that answered without a message (e.g. /clear) still shows what it said.
        if (ok && !this.said && msg.result.trim()) this.say(msg.result.trim());
        let error: string | undefined;
        if (!ok && !this.stopping) error = msg.subtype === 'success' ? msg.result : msg.errors.join('; ') || msg.subtype;
        this.emit({
          type: 'chat.done',
          tabId,
          ok,
          stopped: this.stopping,
          error,
          usage: {
            // Cached context counts too: it's most of what a long chat sends.
            inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
            outputTokens: msg.usage.output_tokens,
            durationMs: msg.duration_ms,
          },
        });
        this.stopping = false;
        if (this.chainEnd) this.hooks.onChainEnd?.(this.chainEnd);
        this.setBusy(false);
        return;
      }

      case 'rate_limit_event': {
        const info = msg.rate_limit_info;
        const resets = info.resetsAt ? ` It resets at ${clock(info.resetsAt)}.` : '';
        if (info.isUsingOverage || info.overageInUse) {
          // Extra usage is billed. Harv is subscription-only, so stop right here and wait for the reset.
          this.hooks.onRateLimit({ ...info, status: 'rejected' });
          this.emit({
            type: 'chat.error',
            tabId,
            message: `Stopped: Claude was about to use paid extra usage, which Harv never does. Turn extra usage off at claude.ai › Settings › Usage.${resets}`,
          });
          void this.stop();
          return;
        }
        this.hooks.onRateLimit(info);
        if (info.status === 'rejected') {
          // Never offer to buy credits or use overage: Harv is subscription-only.
          this.emit({ type: 'chat.error', tabId, message: `Claude Pro usage limit reached.${resets}` });
        }
        // `allowed_warning` comes with every API call above Claude's own mark, so it says nothing
        // here: the usage meter warns once per threshold (Settings › Usage warnings).
        return;
      }

      default:
        return;
    }
  }
}
