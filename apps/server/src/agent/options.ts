import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HookCallbackMatcher, HookEvent, Options } from '@anthropic-ai/claude-agent-sdk';
import { HARV_VERSION, type EffortLevel, type Project } from '@harv/shared';
import { ENABLED_TOOLS } from '../safety/classify.ts';
import type { SafetyGate } from '../safety/gate.ts';
import { WORKSPACE } from '../safety/paths.ts';
import { workDir } from '../settings.ts';
import type { ChatStore } from '../store/chats.ts';
import { harvServer, recentChatsContext, type Delegate, type ProjectTools } from './chatTools.ts';
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
/** How the user likes project work done (repo root `harv/dev-rules.md`), loaded in project chats. */
const DEV_RULES_PATH = fileURLToPath(new URL('../../../../harv/dev-rules.md', import.meta.url));

const readText = (path: string, fallback = '') => (existsSync(path) ? readFileSync(path, 'utf8').trim() : fallback);

/** The chat tab a session belongs to: its tools to see the other chats, and the safety gate. */
export interface ChatContext {
  store: ChatStore;
  tabId: string;
  gate: SafetyGate;
  /** Hands a task to another chat (the hand_off tool). */
  delegate?: Delegate;
  /** The project this chat works on: the session then runs as Claude Code in that folder (project mode). */
  project?: Project;
  /** Harv's start_project / open_project / list_projects tools. */
  projects?: ProjectTools;
}

/** The part about the user's other chats, shared by both kinds of chat. */
function otherChats(chat: ChatContext): string {
  return [
    '## Your other chats',
    [
      "Each chat tab is a separate conversation, but they're all you: the same rules, the same memory, one shared history. If another chat saves or forgets a memory, you'll get a note about it with the user's next message.",
      "When the user refers to another tab or something you discussed before that isn't in this conversation, use list_chats to find it and read_chat to read it. Don't read other chats unprompted; it uses the user's plan.",
      "When the user asks another tab (or a new one) to do something, use hand_off with a complete request: the other chat can't see this conversation. By default you wait and get its answer; pass wait: false for long jobs the user wants running on their own. A message that starts with [Handed over from …] came from another of your chats, not straight from the user: do it like a normal request, and your reply goes back to that chat.",
      'Recent chats:',
      recentChatsContext(chat.store, chat.tabId),
    ].join('\n'),
  ].join('\n\n');
}

/**
 * What a project chat adds on top of Claude Code's own system prompt: Harv's persona,
 * the dev rules, Harv's memory about the user and the other chats.
 */
function projectPrompt(chat: ChatContext, project: Project): string {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return [
    '# You are Harv',
    "Identity: you are Harv, the user's personal assistant, built on Claude and here working with Claude Code's tools and instructions. When asked who or what you are, you're Harv. Never call yourself Claude Code.",
    readText(PERSONA_PATH),
    '## Project mode',
    [
      `- This chat works on the project "${project.name}" in ${project.path}. You have Claude Code's full instructions and tools: follow them for all the engineering work, exactly as Claude Code would. You're still Harv (the persona above), running in Harv's dashboard on the user's Windows PC, and replies render as Markdown.`,
      "- The project's CLAUDE.md (loaded above when there is one) is the source of truth for this project. Keep it and the project's docs up to date.",
      "- Your project memory is Claude Code's auto-memory for this folder (see above). The user's Claude Code sessions on this folder share it, so keep it current: where things stand, decisions, the user's rules. What Harv knows about the user in general is below; change that with remember/forget.",
      "- Harv's safety gate checks every action. In this project folder, editing files and normal dev commands (npm, tests, builds, git add/commit, scripts in the project) run without asking; git is the undo, and deletes are backed up. It still asks the user (an approval card) for git push, throwing away uncommitted work, installing software for the whole PC, stopping programs, system or registry changes, anything outside the project folder, and commands it can't see into (variables in paths, nested shells). Blocked things stay blocked. So prefer plain, direct commands, and if something is denied, don't work around it.",
      `- The user's home folder is ${homedir()}. Today is ${today}.`,
    ].join('\n'),
    '## How the user likes project work done',
    readText(DEV_RULES_PATH),
    '## What Harv knows about the user',
    memoryContext(),
    otherChats(chat),
  ].join('\n\n');
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
      ...(workDir()
        ? [
            `- The user's default folder is ${workDir()}. When they ask you to make or change files without saying where, work there (with full paths). Your own scratch files still go in your workspace.`,
          ]
        : []),
      `- Today is ${today}.`,
    ].join('\n'),
    '## Your memory',
    memoryContext(),
    ...(chat ? [otherChats(chat)] : []),
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
  const project = chat?.project && existsSync(chat.project.path) ? chat.project : undefined;
  return {
    model,
    effort,
    abortController,
    resume,
    env: subscriptionEnv(),
    ...(project
      ? {
          // Project mode: Claude Code itself, in the project folder, with the project's CLAUDE.md and settings,
          // Claude Code's prompt (including its auto-memory) and tools, and Harv on top.
          cwd: project.path,
          settingSources: ['project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: projectPrompt(chat!, project) },
          tools: { type: 'preset', preset: 'claude_code' },
        }
      : {
          cwd: WORKSPACE,
          // Isolation: don't load the user's Claude Code settings, CLAUDE.md files or MCP servers.
          settingSources: [],
          systemPrompt: systemPrompt(chat),
          tools: ENABLED_TOOLS,
        }),
    strictMcpConfig: true,
    mcpServers: chat ? { harv: harvServer(chat.store, chat.tabId, chat.delegate, chat.projects) } : {},
    permissionMode: 'default',
    canUseTool: async (name, input, { toolUseID }) =>
      chat ? chat.gate.canUseTool(name, input, toolUseID, chat.tabId) : { behavior: 'deny', message: 'No tools here.' },
    hooks: gateHooks(chat),
    includePartialMessages: true,
  };
}
