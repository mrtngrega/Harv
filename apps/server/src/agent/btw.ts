import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES, type ChatContext } from './options.ts';

const TIMEOUT_MS = 120_000;

/** A /btw answer, or why there is none (shown in the chat, so a failure can be traced). */
export type SideAnswer = string | { error: string };

/**
 * /btw, like Claude Code's: a quick side question about the chat, answered without
 * interrupting it. It runs as a fork of the chat's Claude session (so it knows the
 * conversation, and the prompt cache is shared) and isn't saved, so the chat itself
 * never sees it. Tools are refused; a model that reaches for one anyway gets a second
 * turn to answer without it (with one turn, the refusal used it up and /btw said only
 * "Couldn't answer", the user's report of 2026-10-25).
 */
export async function sideQuestion(question: string, model: string, chat: ChatContext, resume?: string): Promise<SideAnswer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const q = query({
    prompt: `[A quick side question from the user ("/btw"). Answer it briefly from what this conversation already knows, without using any tools. Your answer won't become part of the conversation.]\n\n${question}`,
    options: {
      // The chat's own options (same prompt and tools, so the cached context is reused)…
      ...buildOptions(model, 'low', abort, { resume, chat }),
      // …but forked, nothing saved, and no tool may run.
      forkSession: true,
      persistSession: false,
      maxTurns: 2,
      includePartialMessages: false,
      hooks: {},
      canUseTool: async () => ({
        behavior: 'deny',
        message: 'No tools for a /btw side question: answer now, briefly, from what you already know (say so if you would need to look).',
      }),
    },
  });
  // What it wrote, in case the run ends without a clean result.
  let said = '';
  try {
    for await (const msg of q) {
      // Same hard stop as chat sessions: never run on anything but the subscription.
      if (msg.type === 'system' && msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) {
        return { error: `Claude Code isn't using your subscription (${msg.apiKeySource})` };
      }
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        const text = msg.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        if (text.trim()) said = text.trim();
      }
      if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error && msg.result.trim()) return msg.result.trim();
        if (said) return said;
        const why = msg.subtype === 'success' ? msg.result : [msg.subtype, ...msg.errors].join(': ');
        return { error: why.trim() || msg.subtype };
      }
    }
    return said || { error: 'the side session ended without an answer' };
  } catch (err) {
    if (said) return said;
    return { error: abort.signal.aborted ? 'it took longer than 2 minutes' : (err as Error).message.split('\n')[0]! };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
