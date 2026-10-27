import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HookCallbackMatcher, HookEvent, Options } from '@anthropic-ai/claude-agent-sdk';
import { HARV_VERSION, type EffortLevel, type Project } from '@harv/shared';
import { IS_WINDOWS, OS_NAME } from '../platform.ts';
import type { SafetyGate } from '../safety/gate.ts';
import { PLANS_DIR, WORKSPACE } from '../safety/paths.ts';
import { loadSettings, workDir } from '../settings.ts';
import type { ChatStore } from '../store/chats.ts';
import { harvServer, recentChatsContext, type Delegate, type ProjectTools, type ScheduleTools } from './chatTools.ts';
import { memoryContext } from './memory.ts';

/** Login sources that mean the user's subscription (never per-token API billing). */
export const SUBSCRIPTION_KEY_SOURCES = new Set(['none', 'oauth']);

function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: `harv/${HARV_VERSION}`,
  };
  // Windows tasks go best through PowerShell; Bash (Git Bash) stays available too. Linux has Bash only.
  if (IS_WINDOWS) env.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1';
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
  /** Harv's schedule_task / list_scheduled / cancel_scheduled tools. */
  schedules?: ScheduleTools;
}

/** The part about the user's other chats, shared by both kinds of chat. */
function otherChats(chat: ChatContext): string {
  return [
    '## Your other chats',
    [
      "Each chat tab is a separate conversation, but they're all you: the same rules, the same memory, one shared history. If another chat saves or forgets a memory, you'll get a note about it with the user's next message.",
      "When the user refers to another tab or something you discussed before that isn't in this conversation, use list_chats to find it and read_chat to read it. Don't read other chats unprompted; it uses the user's plan.",
      'Earlier Claude Code sessions (project chats, and the user\'s own Claude Code sessions in a terminal) are saved as ~/.claude/projects/<folder>/<session>.jsonl, one JSON line per message, with <folder> the working folder with every non-letter or digit turned into "-". When the user asks about an earlier session you can\'t find with read_chat, grep those files first (they get big), then read the parts you need. They are read-only.',
      "When the user asks another tab (or a new one) to do something, use hand_off with a complete request: the other chat can't see this conversation. By default you wait and get its answer; pass wait: false for long jobs the user wants running on their own. A message that starts with [Handed over from …] came from another of your chats, not straight from the user: do it like a normal request, and your reply goes back to that chat.",
      'Recent chats:',
      recentChatsContext(chat.store, chat.tabId),
    ].join('\n'),
  ].join('\n\n');
}

/**
 * The skills a normal chat lists (docs/PLAN.md §6u): documents, research and the like. Claude Code's
 * own dev skills (config, keybindings, code review, init…) and ones that can't work in Harv (the
 * browsers, computer use, /loop, /schedule) only cost context there; project chats keep them all.
 * Each name twice: as Claude Code lists it and as the claude.ai plugin names it.
 */
export const CHAT_SKILLS = [
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'deep-research',
  'docs',
  'google-workspace',
  'dataviz',
  'skill-creator',
  'morning',
  'import-memory',
].flatMap((s) => [s, `anthropic-skills:${s}`]);
/** Tools no chat uses: Claude Code's schedulers (Harv has its own), and in normal chats the coding-only ones. */
const NEVER_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'];
const CODING_TOOLS = ['EnterWorktree', 'ExitWorktree', 'NotebookEdit', 'LSP', 'Workflow'];

/** The safety note while "Ask before risky actions" is off (the user's choice, 2026-10-27). */
const NO_CARDS =
  "- Harv's safety gate checks every action, but it doesn't ask the user first: everything runs right away (the user's choice, Settings › Safety › Ask before risky actions). Files a command names are backed up before they change or go, and every action is logged with Undo. Formatting drives, " +
  (IS_WINDOWS ? 'the Windows folder' : "the system's own folders (/usr, /etc…)") +
  ", turning off antivirus or the firewall, and reading stored credentials stay blocked. So you're trusted: before something hard to undo (deleting the user's files, installing or uninstalling, stopping programs, system or registry changes, sending messages or data, force pushes), say in a sentence what you're about to do, and pick the least risky way to do it. If something is blocked, don't retry it or work around it; tell the user." +
  (IS_WINDOWS ? '' : " sudo can't type a password here, so leave anything that needs it to the user.");

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
      `- This chat works on the project "${project.name}" in ${project.path}. You have Claude Code's full instructions and tools: follow them for all the engineering work, exactly as Claude Code would. The user's own Claude Code setup is loaded too: their skills (docx, pdf, pptx, xlsx, deep-research, skill-creator and the rest; use them for documents and research) and their claude.ai connectors (Claude Docs for docs they asked for). You're still Harv (the persona above), running in Harv's dashboard on the user's ${OS_NAME}, and replies render as Markdown.`,
      "- The project's CLAUDE.md (loaded above when there is one) is the source of truth for this project. Keep it and the project's docs up to date.",
      "- Your project memory is Claude Code's auto-memory for this folder (see above). The user's Claude Code sessions on this folder share it, so keep it current: where things stand, decisions, the user's rules. What Harv knows about the user in general is below; change that with remember/forget.",
      loadSettings().askRisky
        ? "- Harv's safety gate checks every action, and in a project chat it asks only for the risky kinds. Editing files and dev commands (npm, tests, builds, scripts, heredoc scripts like `python3 - <<'EOF'`, git add/commit and a normal git push) run without asking, in the project folder and in the temp folder (your scratch space); git is the undo, and deletes are backed up. Work that touches files elsewhere also runs, logged, with the small files it names backed up first; downloads without uploading run too. It asks the user (an approval card) for deleting outside the project or with targets it can't see (variables, substitutions), force-pushing or deleting remote branches, throwing away uncommitted work, installing software for the whole PC, sudo, stopping programs, system or registry changes, sending data (uploads, POST requests), piping a download into a shell, and changing a connected Android device. Blocked things stay blocked. If something is denied, don't work around it."
        : NO_CARDS,
      '- Background agents you start show in a strip above the prompt, where the user can stop each one; use ListAgents to check on them, and SendMessage to talk to one.',
      "- Harv's own tools: schedule_task / list_scheduled / cancel_scheduled for anything to run later or on a repeat (Claude Code's Cron and ScheduleWakeup tools don't work here). Files you make show as cards, pictures by full path show in the chat, and HTML, SVG and Mermaid open in a live preview pane.",
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
  const asks = loadSettings().askRisky;
  const persona = existsSync(PERSONA_PATH) ? readFileSync(PERSONA_PATH, 'utf8').trim() : 'You are Harv, a personal assistant.';
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return [
    persona,
    '## Right now',
    [
      `- You're running inside Harv's dashboard on the user's ${OS_NAME}. Replies render as Markdown in a log-style chat, so keep formatting light.`,
      `- Your tools are Claude Code's full toolset: read and search files, search and fetch the web, create and edit files, ${IS_WINDOWS ? 'run PowerShell and Bash commands (prefer PowerShell for Windows tasks)' : 'run Bash commands'}, background shells and subagents (Agent; they show in a strip above the prompt where the user can stop each one), a task list (TodoWrite) for longer jobs, AskUserQuestion to give the user choices (it shows as a card), plan mode, and the user's own Claude Code setup: their skills (docx, xlsx, pptx, pdf, deep-research, skill-creator and the rest; use them for documents and research), plugins and claude.ai connectors (Claude Docs for docs they asked for). Plus Harv's own: remember/forget for your memory, list_chats/read_chat for your other chats, hand_off to give a task to another chat tab, and schedule_task / list_scheduled / cancel_scheduled for anything to run later or on a repeat ("every morning at 8…", "check X in an hour"; Claude Code's own Cron and ScheduleWakeup tools don't work here).`,
      '- Files you make show as cards with Open and Show in folder; pictures (png, jpg, svg, gif, webp) you make or mention by full path show right in the chat, and HTML pages, SVG and Mermaid open in a live preview pane. So when the user wants a drawing, a diagram, a chart or a small page, make it as a file (SVG, HTML with inline JS/CSS, a Mermaid ```mermaid block, or a picture from Python) and say its full path. Math in replies renders with $…$ and $$…$$.',
      ...(asks
        ? [
            `- Harv's safety gate checks every action. Reading is free, and so is creating files in your workspace (${WORKSPACE}). Editing or creating the user's files is backed up first and they can Undo it. Riskier things (deleting, installing, stopping programs, scripts, ${IS_WINDOWS ? 'the registry, ' : 'sudo, '}system settings, sending data, git push) show the user an approval card with the exact command, and you wait for their answer. Formatting drives, touching ${IS_WINDOWS ? 'the Windows folder' : "the system's own folders (/usr, /etc…)"}, turning off antivirus or the firewall, and reading stored credentials are always blocked.${IS_WINDOWS ? '' : " sudo can't type a password here, so leave anything that needs it to the user."}`,
          ]
        : [NO_CARDS]),
      "- When the user starts a new project, use start_project (never make the folder yourself): ask first whether its GitHub repo should be private or public, and wait for the answer. It makes the folder, git, a starter CLAUDE.md and the repo, so the user's other devices get the project too.",
      '- The user\'s projects (list_projects) are trusted: commands that start with `cd` into a project folder, and edits to its files, run without asking, git push included (except force pushes, installs for the whole PC and the like). When the user wants to work on one of them ("let\'s continue on Harv", "work on X"), call open_project first, before anything else, so the chat becomes a project chat with Claude Code\'s full tools and the project\'s rules.',
      ...(asks
        ? [
            "- So: pick the least risky way to do what's asked, say in a sentence what you're about to do before a risky step, and keep commands simple and readable (the user approves exactly what they see). If something is denied or blocked, don't retry it or work around it; ask what they'd like instead.",
            '- One plain command per step. Simple commands pass without bothering the user, but anything with variables, if/else, loops or several steps chained together always needs their approval. ' +
              (IS_WINDOWS
                ? "For example, check with `Test-Path '<path>'` first, then create a folder with just `New-Item -ItemType Directory -Path '<full path>'` (new folders don't need approval), and open a file with `Start-Process '<path>'`."
                : "For example, check with `ls '<path>'` first, then create a folder with just `mkdir '<full path>'` (new folders don't need approval), and open a file with `xdg-open '<path>'`."),
          ]
        : []),
      `- The user's home folder is ${homedir()} (Downloads, Documents and Desktop are usually inside it; check if a path isn't there). You can read and open files anywhere on the ${IS_WINDOWS ? 'PC' : 'computer'}.`,
      ...(workDir()
        ? [
            `- The user's default folder is ${workDir()}. When they ask you to make or change files without saying where, work there (with full paths). Your own scratch files still go in your workspace.`,
          ]
        : []),
      `- Your own working files (scripts, builds, drafts, downloads) go in your workspace, ${WORKSPACE}, or the temp folder; never anywhere else under ~/.harv, which holds Harv's database, backups and memory.`,
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
  { resume, resumeAt, planning, chat }: { resume?: string; resumeAt?: string; planning?: boolean; chat?: ChatContext } = {},
): Options {
  mkdirSync(WORKSPACE, { recursive: true });
  // Plans go in the workspace, where plan mode may write (the gate allows only that folder then).
  const planSettings = { plansDirectory: PLANS_DIR };
  const project = chat?.project && existsSync(chat.project.path) ? chat.project : undefined;
  return {
    model,
    effort,
    abortController,
    resume,
    // A rewind resumes the conversation cut back to the entry before the message it went back to.
    ...(resume && resumeAt ? { resumeSessionAt: resumeAt } : {}),
    env: subscriptionEnv(),
    ...(project
      ? {
          // Project mode: Claude Code itself, in the project folder, with the project's CLAUDE.md and settings,
          // Claude Code's prompt (including its auto-memory) and tools, and Harv on top. The user's own
          // Claude Code setup too: their skills (synced from claude.ai: docx, pdf, xlsx…), plugins and
          // claude.ai connectors, which run on the subscription. A billing setting there can't slip
          // through: a session that doesn't log in with the subscription refuses to run (session.ts).
          cwd: project.path,
          settingSources: ['user', 'project', 'local'],
          strictMcpConfig: false,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: projectPrompt(chat!, project) },
          tools: { type: 'preset', preset: 'claude_code' },
          disallowedTools: NEVER_TOOLS,
          settings: planSettings,
        }
      : chat
        ? {
            // Every chat has Claude Code's full toolset and the user's own Claude Code setup (skills,
            // plugins, claude.ai connectors; since 2026-10-27, the user's wish) with Harv's own prompt.
            // Claude Code's auto-memory stays off: Harv's memory is ~/.harv/memory.
            cwd: WORKSPACE,
            settingSources: ['user'],
            strictMcpConfig: false,
            settings: { ...planSettings, autoMemoryEnabled: false },
            systemPrompt: systemPrompt(chat),
            tools: { type: 'preset', preset: 'claude_code' },
            disallowedTools: [...NEVER_TOOLS, ...CODING_TOOLS],
            skills: CHAT_SKILLS,
          }
        : {
            // The model catalog: nothing loaded, no tools.
            cwd: WORKSPACE,
            settingSources: [],
            systemPrompt: systemPrompt(),
            tools: [],
            strictMcpConfig: true,
          }),
    mcpServers: chat ? { harv: harvServer(chat.store, chat.tabId, chat.delegate, chat.projects, chat.schedules) } : {},
    permissionMode: planning ? 'plan' : 'default',
    // Checkpoints of the files Claude edits, so a rewind can put them back.
    ...(chat ? { enableFileCheckpointing: true } : {}),
    canUseTool: async (name, input, { toolUseID }) =>
      chat ? chat.gate.canUseTool(name, input, toolUseID, chat.tabId) : { behavior: 'deny', message: 'No tools here.' },
    hooks: gateHooks(chat),
    includePartialMessages: true,
    // Claude's thinking comes as a short summary (not hidden), shown folded above the reply like
    // Claude Code's. It only changes what's shown: how much Claude thinks stays the same.
    ...(chat ? { extraArgs: { 'thinking-display': 'summarized' } } : {}),
    // The dashboard can stop each background agent on its own (the strip above harv>),
    // so Stop on a reply ends only the reply, not the agents it started.
    perTaskStopAffordance: true,
  };
}
