import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { HARV_VERSION, type EffortLevel } from '@harv/shared';
import { HARV_HOME } from '../paths.ts';
import { checkTool, READ_ONLY_TOOLS } from './guard.ts';

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

function systemPrompt(): string {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return [
    'You are Harv, a personal assistant living in a dashboard on the user’s Windows 11 PC (Ryzen 7 5700X3D, RTX 3060 Ti, 32 GB RAM).',
    'Be direct and concise. Use light Markdown only when it helps (short lists, code blocks).',
    `You can currently read files, search files, and search or fetch the web. You cannot run commands, edit files or control the PC yet; those arrive with Harv’s safety gate. If asked, say so plainly.`,
    'Never read or reveal credentials, tokens, keys or password files.',
    `Today is ${today}.`,
  ].join('\n');
}

/** Every tool call passes this hook, even ones Claude Code would auto-approve. */
const guardHook: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const verdict = checkTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
  if (verdict.allow) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
};

export function buildOptions(model: string, effort: EffortLevel, abortController: AbortController): Options {
  mkdirSync(WORKSPACE, { recursive: true });
  return {
    model,
    effort,
    abortController,
    env: subscriptionEnv(),
    cwd: WORKSPACE,
    // Isolation: don't load the user's Claude Code settings, CLAUDE.md files or MCP servers.
    settingSources: [],
    strictMcpConfig: true,
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
