import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { HARV_VERSION, type EffortLevel } from '@harv/shared';
import { HARV_HOME } from '../paths.ts';
import { checkTool, READ_ONLY_TOOLS } from './guard.ts';
import { memoryContext, memoryServer } from './memory.ts';

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

/** Built fresh for each new session, so persona edits and new memories apply to the next chat. */
function systemPrompt(): string {
  const persona = existsSync(PERSONA_PATH) ? readFileSync(PERSONA_PATH, 'utf8').trim() : 'You are Harv, a personal assistant.';
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return [
    persona,
    '## Right now',
    [
      "- You're running inside Harv's dashboard on the user's Windows PC. Replies render as Markdown in a log-style chat, so keep formatting light.",
      "- Your tools: read and search files, search and fetch the web, and remember/forget for your memory. You can't run commands, edit files or control the PC yet; that arrives with Harv's safety gate. If asked, say so plainly and offer what you can do.",
      `- Today is ${today}.`,
    ].join('\n'),
    '## Your memory',
    memoryContext(),
  ].join('\n\n');
}

/** Every tool call passes this hook, even ones Claude Code would auto-approve. */
const guardHook: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const verdict = checkTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
  if (verdict.allow) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
};

export function buildOptions(model: string, effort: EffortLevel, abortController: AbortController, resume?: string): Options {
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
    mcpServers: { harv: memoryServer },
    systemPrompt: systemPrompt(),
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
