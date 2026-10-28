import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryItem, Project, StoredLine } from '@harv/shared';
import { z } from 'zod';
import type { ChatStore } from '../store/chats.ts';
import type { ScheduleInput } from '../schedule/schedule.ts';
import { memoryTools, text } from './memory.ts';

// Every chat tab is its own Claude session, but they share one history. These
// tools let Harv look through its other chats (open tabs and past ones) when the
// user refers to them. They only read the database, so they cost no plan usage
// beyond the text they bring into the conversation.

/** Keeps a read chat from flooding the context (it counts against plan usage). */
const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_LINE_CHARS = 2_000;

const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** One line per chat: id, title, last activity and whether it's an open tab. */
export function chatList(items: HistoryItem[], currentId: string): string {
  return items
    .map((c) => {
      const flags = [day(c.updatedAt), c.open ? 'open tab' : 'closed', c.id === currentId ? 'this chat' : ''].filter(Boolean);
      return `- ${c.id} · "${c.title}" · ${flags.join(' · ')}${c.snippet ? `\n  match: ${c.snippet}` : ''}`;
    })
    .join('\n');
}

const SPEAKER: Record<StoredLine['kind'], string> = {
  you: 'user',
  harv: 'harv',
  tool: '  tool',
  notice: '  note',
  error: '  error',
  thinking: '  thought',
};

/** A chat as plain text, newest lines kept when it's too long. */
export function formatTranscript(lines: StoredLine[]): string {
  const out: string[] = [];
  let total = 0;
  // Thinking summaries are Harv's scratch work, not part of the conversation.
  for (const line of [...lines].reverse().filter((l) => l.kind !== 'thinking')) {
    const body = line.text.length > MAX_LINE_CHARS ? `${line.text.slice(0, MAX_LINE_CHARS)}…` : line.text;
    const files = line.files?.length ? ` [attached: ${line.files.join(', ')}]` : '';
    const entry = `${SPEAKER[line.kind]}: ${body}${files}`;
    if (total + entry.length > MAX_TRANSCRIPT_CHARS) {
      out.push('(…earlier lines left out)');
      break;
    }
    out.push(entry);
    total += entry.length;
  }
  return out.reverse().join('\n');
}

/** The list of recent chats that goes into every new session's system prompt (no model call needed). */
export function recentChatsContext(store: ChatStore, currentId: string, limit = 10): string {
  const others = store
    .history()
    .filter((c) => c.id !== currentId)
    .slice(0, limit);
  return others.length ? chatList(others, currentId) : 'No other chats yet.';
}

/** A task one chat hands to another (the `hand_off` tool). */
export interface HandOff {
  /** The chat to give it to; a new tab when left out. */
  to?: string;
  title?: string;
  message: string;
  /** Wait for the other chat's answer (default true). */
  wait: boolean;
}

/** Runs a hand-off from this chat and returns what to tell the model. */
export type Delegate = (req: HandOff, signal?: AbortSignal) => Promise<string>;

/** Project mode: what Harv's project tools do (ChatManager implements them). */
export interface ProjectTools {
  list(): Project[];
  /** Creates the folder in the user's projects folder, git init, a starter CLAUDE.md, its GitHub repo, and moves this chat into it. */
  start(tabId: string, name: string, description: string, visibility: 'private' | 'public'): Promise<string>;
  /** Moves this chat into a known project (by name) or a folder (by path). */
  open(tabId: string, nameOrPath: string): Promise<string>;
}

/** Harv's scheduler, as the chat tools see it (schedule/scheduler.ts). */
export interface ScheduleTools {
  add(tabId: string, title: string, prompt: string, input: ScheduleInput): string;
  describe(): string;
  cancel(id: string): boolean;
}

/**
 * The chat's visible terminal, as Harv's terminal tools see it (the server's TerminalManager).
 * `chat` names another chat whose terminal to use (the user's wish: a terminal tab every chat can work in).
 */
export interface TerminalTools {
  /** Shows the terminal in the dashboard, types the command and returns what it printed. */
  run(tabId: string, command: string, opts: { cwd?: string; interrupt?: boolean; waitMs?: number; chat?: string }): Promise<string>;
  read(tabId: string, lines: number, chat?: string): string;
}

/** An open chat tab, for finding another chat's terminal. */
export interface OpenTab {
  id: string;
  title: string;
  /** It shows its terminal right now. */
  terminal: boolean;
}

/**
 * The open chat the user means by `ref`: its id, its title (exact, else the only one containing
 * it), or, for "terminal", the only other chat showing its terminal. An error naming the open
 * chats when it's not clear.
 */
export function findTab(ref: string, tabs: OpenTab[], self: string): OpenTab | string {
  const want = ref.trim().toLowerCase();
  const others = tabs.filter((t) => t.id !== self);
  const byId = tabs.find((t) => t.id === ref.trim()) ?? (want.length >= 6 ? tabs.filter((t) => t.id.startsWith(want)) : []).at(0);
  if (byId) return byId;
  const exact = tabs.filter((t) => t.title.toLowerCase() === want);
  if (exact.length === 1) return exact[0]!;
  const partial = tabs.filter((t) => t.title.toLowerCase().includes(want));
  if (partial.length === 1) return partial[0]!;
  const showing = others.filter((t) => t.terminal);
  if (/terminal|shell|konzol|termin[aá]l/.test(want) && showing.length === 1) return showing[0]!;
  const list = tabs
    .map((t) => `- "${t.title}" (${t.id})${t.terminal ? ' · terminal open' : ''}${t.id === self ? ' · this chat' : ''}`)
    .join('\n');
  return `No single open chat matches "${ref}". Open chats:\n${list}\nAsk the user which one (a chat used only for its terminal can be renamed by double-clicking its tab).`;
}

/** Pictures made by Gemini (tools/gemini.ts): returns what to tell the model (saved paths, or what the user must do). */
export interface ImageTools {
  generate(prompt: string, images: string[]): Promise<string>;
}

/** Harv's own MCP server for one chat tab: memory tools, the other chats, handing work to them, projects, scheduled tasks, the terminal and pictures. */
export function harvServer(
  store: ChatStore,
  tabId: string,
  delegate?: Delegate,
  projects?: ProjectTools,
  schedules?: ScheduleTools,
  terminal?: TerminalTools,
  images?: ImageTools,
) {
  return createSdkMcpServer({
    name: 'harv',
    version: '1.0.0',
    tools: [
      ...memoryTools,
      tool(
        'list_chats',
        "List your chats with the user (open tabs and past ones), newest first. Pass a query to search titles and messages. Use it when the user refers to another chat or something you talked about before that isn't in this conversation.",
        {
          query: z.string().optional().describe('Words to search for; leave out to list recent chats'),
          open_only: z.boolean().optional().describe('Only chats open as tabs right now'),
        },
        async ({ query, open_only }) => {
          const items = store.history(query ?? '').filter((c) => !open_only || c.open);
          if (items.length === 0) return text(query ? `No chats match "${query}".` : 'No chats found.');
          return text(chatList(items.slice(0, 30), tabId));
        },
      ),
      tool(
        'read_chat',
        'Read another chat by its id (from list_chats or the list in your instructions): its title and its latest messages. A chat open in another tab may still be in progress; only finished messages are shown.',
        {
          id: z.string().describe('The chat id'),
          last: z.number().int().min(1).max(200).optional().describe('How many of the latest lines to read (default 40)'),
        },
        async ({ id, last }) => {
          if (id === tabId) return text('That is this chat; its messages are already in your context.');
          const chat = store.transcript(id, last ?? 40);
          if (!chat) return { ...text(`No chat with id ${id}.`), isError: true };
          const header = `"${chat.title}" · ${chat.open ? 'open tab' : 'closed'} · last active ${day(chat.updatedAt)}`;
          return text(`${header}\n\n${formatTranscript(chat.lines) || '(no messages yet)'}`);
        },
      ),
      ...(delegate
        ? [
            tool(
              'hand_off',
              "Give a task to another chat tab: an existing chat (by id) or a new tab. That chat works on it as its own conversation, with the same rules and safety checks, and by default you get its answer back here. It runs a second session, so it uses about as much of the user's plan again: only hand off when the user asks you to involve another tab or chat, or to run something separately.",
              {
                to: z
                  .string()
                  .optional()
                  .describe('Id of the chat to give it to (from list_chats or your instructions); leave out to open a new tab'),
                title: z.string().optional().describe('Short title for a new tab'),
                message: z
                  .string()
                  .min(1)
                  .describe('The full request for the other chat, with everything it needs (it can’t see this conversation)'),
                wait: z.boolean().optional().describe('Wait for its answer and get it back here (default true)'),
              },
              async ({ to, title, message, wait }, extra) => {
                const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
                return text(await delegate({ to, title, message, wait: wait ?? true }, signal));
              },
            ),
          ]
        : []),
      ...(projects
        ? [
            tool('list_projects', 'List the projects Harv knows (name and folder).', {}, async () => {
              const list = projects.list();
              return text(list.length ? list.map((p) => `- ${p.name}: ${p.path}`).join('\n') : 'No projects yet.');
            }),
            tool(
              'start_project',
              "Start a new project when the user says so (\"we're starting a new project…\"): makes its folder in the user's projects folder, runs git init, writes a starter CLAUDE.md, creates its GitHub repo (so the user's other devices get it too) and turns this chat into a project chat there (from the next message you work as Claude Code in that folder). Before calling it, ALWAYS ask the user whether the GitHub repo should be private or public, and wait for the answer: never guess or pick a default. Fails if the folder exists: then ask the user, or use open_project.",
              {
                name: z.string().min(1).describe('Folder name: what the user called it, or a short lowercase-hyphen name like weather-app'),
                description: z.string().describe('What the project is, in a sentence or two (goes into CLAUDE.md)'),
                visibility: z
                  .enum(['private', 'public'])
                  .describe("The GitHub repo's visibility, exactly as the user answered when you asked (never assumed)"),
              },
              async ({ name, description, visibility }) => text(await projects.start(tabId, name, description, visibility)),
            ),
            tool(
              'open_project',
              `Turn this chat into a project chat for an existing project, ONLY when the user explicitly asks to work on it or switch to it ("let's work on X", "switch to X"): give the project's name (see list_projects) or a folder path (it gets added). From the next message you work as Claude Code in that folder. Never call it just to look at something from a project (a mockup, a file, a picture): read or open that file directly from this chat instead, since project folders are readable from any chat.`,
              { project: z.string().min(1).describe('Project name or full folder path') },
              async ({ project }) => text(await projects.open(tabId, project)),
            ),
          ]
        : []),
      ...(schedules
        ? [
            tool(
              'schedule_task',
              `Schedule something to run later or on a repeat, when the user asks ("every morning at 8 tell me…", "check X in an hour", "remind me on Friday…"): each run is a new turn in THIS chat, with the prompt as the request, run by Harv's server on this device while Harv is on (a run missed while it's off happens once when it starts). Each run uses the user's plan, so never repeat faster than the user needs. Give exactly one of in_minutes, time (+ days_from_today), at, every_minutes, daily_at. Don't work out dates or clock times yourself (your sense of "now" can be hours old): "in an hour" is in_minutes 60, "tomorrow at 8" is time "08:00" with days_from_today 1, "at 18:30" is time "18:30"; use at only for a date the user gave. The result says the real time.`,
              {
                title: z.string().describe('A short name for the list, like "Morning news"'),
                prompt: z
                  .string()
                  .min(1)
                  .describe(
                    "The full request for each run, written as the user's ask (the run doesn't see this conversation's later turns)",
                  ),
                at: z.string().optional().describe('One run at this local date and time, like 2026-10-28T08:00'),
                in_minutes: z.number().optional().describe('One run this many minutes from now'),
                time: z.string().optional().describe('One run at HH:MM (24-hour, local): today, or tomorrow if that has passed'),
                days_from_today: z.number().int().optional().describe('With time: that many days from today (1 = tomorrow)'),
                every_minutes: z.number().optional().describe('Repeat every N minutes (at least 5)'),
                daily_at: z.string().optional().describe('Repeat every day at HH:MM (24-hour, local)'),
                weekdays: z.array(z.string()).optional().describe('With daily_at: only on these days (mon, tue, wed, thu, fri, sat, sun)'),
              },
              async ({ title, prompt, ...when }) => text(schedules.add(tabId, title, prompt, when)),
            ),
            tool('list_scheduled', "List Harv's scheduled tasks on this device (id, name, when, next run, chat).", {}, async () =>
              text(schedules.describe()),
            ),
            tool(
              'cancel_scheduled',
              'Cancel a scheduled task by its id (from list_scheduled), when the user asks to stop it.',
              { id: z.string().min(1) },
              async ({ id }) => text(schedules.cancel(id) ? `Cancelled ${id}.` : `No scheduled task with id ${id}.`),
            ),
          ]
        : []),
      ...(terminal
        ? [
            tool(
              'terminal_run',
              "Run a command in this chat's Terminal, the one the user sees (its view menu ≡ → Terminal): it opens in the dashboard, the command is typed there as if by the user, and you get back what it printed. Use it when the user asks to open the terminal, to run something in it, or to watch a program run (e.g. `java Main`, a dev server, an interactive program); use Bash for your own quiet work. The shell is PowerShell on Windows and the user's shell (bash) on Linux, and it keeps its folder and state between calls. It returns after the output has been quiet for a moment (or wait_seconds): a program that's still running keeps running; read it later with terminal_read, or answer its prompts with another terminal_run (command = the text to type).",
              {
                command: z.string().describe('The command line, or text to type into a running program; empty just reads'),
                cwd: z.string().optional().describe('Folder to cd into first'),
                interrupt: z.boolean().optional().describe('Press Ctrl+C first, to stop what is running'),
                wait_seconds: z.number().min(1).max(120).optional().describe('Longest to wait for output (default 15)'),
                chat: z
                  .string()
                  .optional()
                  .describe(
                    'Another open chat whose terminal to use instead of this one\'s, when the user says so ("in the Terminal tab", "in the Server chat\'s terminal"): its title or id. The user watches it in that tab.',
                  ),
              },
              async ({ command, cwd, interrupt, wait_seconds, chat }) =>
                text(await terminal.run(tabId, command, { cwd, interrupt, waitMs: (wait_seconds ?? 15) * 1000, chat })),
            ),
            tool(
              'terminal_read',
              "Read the latest lines on this chat's Terminal (what the user sees there), or another open chat's (chat), e.g. a program started with terminal_run that's still running, or something the user ran.",
              {
                lines: z.number().int().min(1).max(500).optional().describe('How many of the last lines (default 60)'),
                chat: z.string().optional().describe("Another open chat's title or id, to read its terminal"),
              },
              async ({ lines, chat }) => text(terminal.read(tabId, lines ?? 60, chat)),
            ),
          ]
        : []),
      ...(images
        ? [
            tool(
              'generate_image',
              "Make a picture with Google's Gemini when the user asks for one (a photo, illustration, logo, icon, wallpaper…), or change one of their pictures. Write a full, specific prompt in English (subject, style, composition, colours, mood, aspect ratio), not just the user's words. It takes up to a few minutes; the result is saved in your workspace's images folder: name the full path in your reply so the picture shows in the chat. Pass images only when the user gave you pictures for this (they go to Google). If it says the user must sign in, tell them exactly that.",
              {
                prompt: z.string().min(1).describe('The full prompt for Gemini'),
                images: z
                  .array(z.string())
                  .max(4)
                  .optional()
                  .describe('Full paths of the user’s pictures to edit or use (PNG, JPG, WebP, up to 10 MB each)'),
              },
              async ({ prompt, images: inputs }) => text(await images.generate(prompt, inputs ?? [])),
            ),
          ]
        : []),
    ],
  });
}
