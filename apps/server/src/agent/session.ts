import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatServerMessage, EffortLevel } from '@harv/shared';
import { describeTool } from './guard.ts';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES } from './options.ts';
import { AsyncQueue } from './queue.ts';

type Emit = (msg: ChatServerMessage) => void;

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
  busy = false;
  toolRunning = false;

  constructor(
    readonly tabId: string,
    private model: string,
    private effort: EffortLevel,
    private emit: Emit,
    private onStateChange: () => void,
  ) {
    this.q = query({ prompt: this.input, options: buildOptions(model, effort, this.abort) });
    void this.consume();
  }

  async send(text: string, model: string, effort: EffortLevel): Promise<void> {
    if (model !== this.model) {
      await this.q.setModel(model);
      this.model = model;
    }
    if (effort !== this.effort) {
      await this.q.applyFlagSettings({ effortLevel: effort });
      this.effort = effort;
    }
    this.stopping = false;
    this.setBusy(true);
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  async stop(): Promise<void> {
    if (!this.busy) return;
    this.stopping = true;
    await this.q.interrupt();
  }

  close(): void {
    this.closed = true;
    this.input.end();
    this.q.close();
  }

  private setBusy(busy: boolean, toolRunning = false) {
    this.busy = busy;
    this.toolRunning = toolRunning;
    this.onStateChange();
  }

  private async consume() {
    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (err) {
      if (!this.closed) this.emit({ type: 'chat.error', tabId: this.tabId, message: `Claude session ended: ${(err as Error).message}` });
    } finally {
      if (this.busy) this.emit({ type: 'chat.done', tabId: this.tabId, ok: false, stopped: this.stopping });
      this.setBusy(false);
    }
  }

  private handle(msg: SDKMessage) {
    const tabId = this.tabId;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) {
          // Hard stop: this would bill per token instead of using the subscription.
          this.emit({
            type: 'chat.error',
            tabId,
            message: `Refused: Claude Code is authenticating with "${msg.apiKeySource}" instead of your subscription.`,
          });
          this.close();
        }
        return;

      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.emit({ type: 'chat.delta', tabId, text: ev.delta.text });
        } else if (ev.type === 'message_start' && this.toolRunning) {
          this.setBusy(true, false);
        }
        return;
      }

      case 'assistant': {
        if (msg.parent_tool_use_id) return;
        if (msg.error && msg.error !== 'max_output_tokens') {
          this.emit({ type: 'chat.error', tabId, message: ERROR_TEXT[msg.error] ?? `Claude error: ${msg.error}` });
        }
        let text = '';
        let usedTool = false;
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text;
          if (block.type === 'tool_use') {
            usedTool = true;
            if (text) {
              this.emit({ type: 'chat.assistant', tabId, text });
              text = '';
            }
            const input = (block.input ?? {}) as Record<string, unknown>;
            this.emit({ type: 'chat.tool', tabId, name: block.name, detail: describeTool(block.name, input) });
          }
        }
        if (text) this.emit({ type: 'chat.assistant', tabId, text });
        if (usedTool) this.setBusy(true, true);
        return;
      }

      case 'result': {
        const ok = msg.subtype === 'success' && !msg.is_error;
        let error: string | undefined;
        if (!ok && !this.stopping) error = msg.subtype === 'success' ? msg.result : msg.errors.join('; ') || msg.subtype;
        this.emit({
          type: 'chat.done',
          tabId,
          ok,
          stopped: this.stopping,
          error,
          usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, durationMs: msg.duration_ms },
        });
        this.stopping = false;
        this.setBusy(false);
        return;
      }

      case 'rate_limit_event': {
        const info = msg.rate_limit_info;
        const resets = info.resetsAt ? ` It resets at ${clock(info.resetsAt)}.` : '';
        if (info.status === 'rejected') {
          // Never offer to buy credits or use overage: Harv is subscription-only.
          this.emit({ type: 'chat.error', tabId, message: `Claude Pro usage limit reached.${resets}` });
        } else if (info.status === 'allowed_warning' && info.utilization !== undefined) {
          // Accept either a 0–1 fraction or a 0–100 percentage.
          const used = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
          this.emit({ type: 'chat.notice', tabId, message: `Heads up: ${Math.round(used)}% of your Claude Pro limit used.${resets}` });
        }
        return;
      }

      default:
        return;
    }
  }
}
