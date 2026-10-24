import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES, type ChatContext } from './options.ts';

const TIMEOUT_MS = 120_000;

/**
 * /btw, like Claude Code's: a quick side question about the chat, answered without
 * interrupting it. It runs as a fork of the chat's Claude session (so it knows the
 * conversation, and the prompt cache is shared), takes one turn, can't use tools, and
 * isn't saved, so the chat itself never sees it. Null when it couldn't answer.
 */
export async function sideQuestion(question: string, model: string, chat: ChatContext, resume?: string): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const q = query({
    prompt: `[A quick side question from the user ("/btw"). Answer it briefly from what this conversation already knows, without using any tools. Your answer won't become part of the conversation.]\n\n${question}`,
    options: {
      // The chat's own options (same prompt and tools, so the cached context is reused)…
      ...buildOptions(model, 'low', abort, { resume, chat }),
      // …but forked, one turn, nothing saved, and no tool may run.
      forkSession: true,
      persistSession: false,
      maxTurns: 1,
      includePartialMessages: false,
      hooks: {},
      canUseTool: async () => ({ behavior: 'deny', message: 'A /btw answer uses no tools.' }),
    },
  });
  try {
    for await (const msg of q) {
      // Same hard stop as chat sessions: never run on anything but the subscription.
      if (msg.type === 'system' && msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) return null;
      if (msg.type === 'result') return msg.subtype === 'success' && msg.result.trim() ? msg.result.trim() : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
