import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HookCallbackMatcher, HookEvent, Options } from '@anthropic-ai/claude-agent-sdk';
import { HARV_VERSION, type EffortLevel } from '@harv/shared';
import { ENABLED_TOOLS } from '../safety/classify.ts';
import type { SafetyGate } from '../safety/gate.ts';
import { WORKSPACE } from '../safety/paths.ts';
import type { ChatStore } from '../store/chats.ts';
import { harvServer, recentChatsContext, type Delegate } from './chatTools.ts';
import { memoryContext } from './memory.ts';

/** Login sources that mean the user's subscription (never per-token API billing). */
export const SUBSCRIPTION_KEY_SOURCES = new Set(['none', 'oauth']);

function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: `harv/${HARV_VERSION}`,
    // Windows tasks go best through PowerShell; Bash (Git Bash) stays available too.
    CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
  };
  // `env` replaces the subprocess environment, so this guarantees no API key reaches Claude Code.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Harv's shared rulebook (repo root `harv/persona.md`); dev sessions follow the same file. */
const PERSONA_PATH = fileURLToPath(new URL('../../../../harv/persona.md', import.meta.url));

/** The chat tab a session belongs to: its tools to see the other chats, and the safety gate. */
export interface ChatContext {
  store: ChatStore;
  tabId: string;
  gate: SafetyGate;
  /** Hands a task to another chat (the hand_off tool). */
  delegate?: Delegate;
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
      '- Your tools: read and search files, search and fetch the web, create and edit files, run PowerShell and Bash commands (prefer PowerShell for Windows tasks), remember/forget for your memory, list_chats/read_chat for your other chats, and hand_off to give a task to another chat tab.',
      `- Harv's safety gate checks every action. Reading is free, and so is creating files in your workspace (${WORKSPACE}). Editing or creating the user's files is backed up first and they can Undo it. Riskier things (deleting, installing, stopping programs, scripts, the registry, system settings, sending data, git push) show the user an approval card with the exact command, and you wait for their answer. Formatting drives, touching the Windows folder, turning off antivirus or the firewall, and reading stored credentials are always blocked.`,
      "- So: pick the least risky way to do what's asked, say in a sentence what you're about to do before a risky step, and keep commands simple and readable (the user approves exactly what they see). If something is denied or blocked, don't retry it or work around it; ask what they'd like instead.",
      "- One plain command per step. Simple commands pass without bothering the user, but anything with variables, if/else, loops or several steps chained together always needs their approval. For example, check with `Test-Path '<path>'` first, then create a folder with just `New-Item -ItemType Directory -Path '<full path>'` (new folders don't need approval), and open a file with `Start-Process '<path>'`.",
      `- The user's home folder is ${homedir()} (Downloads, Documents and Desktop are usually inside it; check if a path isn't there). You can read and open files anywhere on the PC.`,
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
            "When the user asks another tab (or a new one) to do something, use hand_off with a complete request: the other chat can't see this conversation. By default you wait and get its answer; pass wait: false for long jobs the user wants running on their own. A message that starts with [Handed over from …] came from another of your chats, not straight from the user: do it like a normal request, and your reply goes back to that chat.",
            'Recent chats:',
            recentChatsContext(chat.store, chat.tabId),
          ].join('\n'),
        ]
      : []),
  ].join('\n\n');
}

/** Every tool call passes the safety gate through these hooks, even ones Claude Code would auto-approve. */
function gateHooks(chat?: ChatContext): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  if (!chat) {
    // Sessions without a chat (the model catalog) never send a prompt; refuse any tool all the same.
    return {
      PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })] }],
    };
  }
  const { gate, tabId } = chat;
  const args = (input: { tool_input: unknown }) => (input.tool_input ?? {}) as Record<string, unknown>;
  return {
    PreToolUse: [
      {
        // A red action waits for the user's answer inside this hook, so give it all the time it needs.
        timeout: 24 * 60 * 60,
        hooks: [
          async (input, _id, { signal }) =>
            input.hook_event_name === 'PreToolUse' ? gate.preToolUse(tabId, input.tool_name, args(input), input.tool_use_id, signal) : {},
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === 'PostToolUse') gate.done(input.tool_name, args(input), input.tool_use_id, input.tool_response);
            return {};
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === 'PostToolUseFailure') gate.failed(input.tool_use_id, input.error, input.is_interrupt);
            return {};
          },
        ],
      },
    ],
  };
}

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
    mcpServers: chat ? { harv: harvServer(chat.store, chat.tabId, chat.delegate) } : {},
    systemPrompt: systemPrompt(chat),
    tools: ENABLED_TOOLS,
    permissionMode: 'default',
    canUseTool: async (name, input, { toolUseID }) =>
      chat ? chat.gate.canUseTool(name, input, toolUseID) : { behavior: 'deny', message: 'No tools here.' },
    hooks: gateHooks(chat),
    includePartialMessages: true,
  };
}
