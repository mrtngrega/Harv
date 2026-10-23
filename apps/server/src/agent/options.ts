import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { HARV_VERSION, type EffortLevel } from '@harv/shared';
import { HARV_HOME } from '../paths.ts';
import type { ChatStore } from '../store/chats.ts';
import { harvServer, recentChatsContext } from './chatTools.ts';
import { checkTool, READ_ONLY_TOOLS } from './guard.ts';
import { memoryContext } from './memory.ts';

/** Harv's own working folder; Claude starts here rather than in any project. */
export const WORKSPACE = join(HARV_HOME, 'workspace');

/** Login sources that mean the user's subscription (never per-token API billing). */
export const SUBSCRIPTION_KEY_SOURCES = new Set(['none', 'oauth']);

function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `harv/${HARV_VERSION}` };
  // `env` replaces the subprocess environment, so this guarantees no API key reaches Claude Code.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Harv's shared rulebook (repo root `harv/persona.md`); dev sessions follow the same file. */
const PERSONA_PATH = fileURLToPath(new URL('../../../../harv/persona.md', import.meta.url));

/** The chat tab a session belongs to; gives it the tools to see the other chats. */
export interface ChatContext {
  store: ChatStore;
  tabId: string;
}

/** Built fresh for each new session, so persona edits and new memories apply to the next chat. */
function systemPrompt(chat?: ChatContext): string {
  const persona = existsSync(PERSONA_PATH) ? readFileSync(PERSONA_PATH, 'utf8').trim() : 'You are Harv, a personal assistant.';
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return [
    persona,
    '## Right now',
    [
      "- You're running inside Harv's dashboard on the user's Windows PC. Replies render as Markdown in a log-style chat, so keep formatting light.",
      "- Your tools: read and search files, search and fetch the web, remember/forget for your memory, and list_chats/read_chat for your other chats. You can't run commands, edit files or control the PC yet; that arrives with Harv's safety gate. If asked, say so plainly and offer what you can do.",
      `- Today is ${today}.`,
    ].join('\n'),
    '## Your memory',
    memoryContext(),
    ...(chat
      ? [
          '## Your other chats',
          [
            "Each chat tab is a separate conversation, but they're all you: the same rules, the same memory, one shared history. If another chat saves or forgets a memory, you'll get a note about it with the user's next message.",
            "When the user refers to another tab or something you discussed before that isn't in this conversation, use list_chats to find it and read_chat to read it. Don't read other chats unprompted; it uses the user's plan.",
            'Recent chats:',
            recentChatsContext(chat.store, chat.tabId),
          ].join('\n'),
        ]
      : []),
  ].join('\n\n');
}

/** Every tool call passes this hook, even ones Claude Code would auto-approve. */
const guardHook: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const verdict = checkTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
  if (verdict.allow) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
};

export function buildOptions(
  model: string,
  effort: EffortLevel,
  abortController: AbortController,
  { resume, chat }: { resume?: string; chat?: ChatContext } = {},
): Options {
  mkdirSync(WORKSPACE, { recursive: true });
  return {
    model,
    effort,
    abortController,
    resume,
    env: subscriptionEnv(),
    cwd: WORKSPACE,
    // Isolation: don't load the user's Claude Code settings, CLAUDE.md files or MCP servers.
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: chat ? { harv: harvServer(chat.store, chat.tabId) } : {},
    systemPrompt: systemPrompt(chat),
    tools: READ_ONLY_TOOLS,
    permissionMode: 'default',
    canUseTool: async (name, input) => {
      const verdict = checkTool(name, input);
      return verdict.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict.reason };
    },
    hooks: { PreToolUse: [{ hooks: [guardHook] }] },
    includePartialMessages: true,
  };
}
