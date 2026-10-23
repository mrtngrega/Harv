import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryItem, StoredLine } from '@harv/shared';
import { z } from 'zod';
import type { ChatStore } from '../store/chats.ts';
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

const SPEAKER: Record<StoredLine['kind'], string> = { you: 'user', harv: 'harv', tool: '  tool', notice: '  note', error: '  error' };

/** A chat as plain text, newest lines kept when it's too long. */
export function formatTranscript(lines: StoredLine[]): string {
  const out: string[] = [];
  let total = 0;
  for (const line of [...lines].reverse()) {
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

/** Harv's own MCP server for one chat tab: memory tools, tools to look at the other chats, and handing work to them. */
export function harvServer(store: ChatStore, tabId: string, delegate?: Delegate) {
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
    ],
  });
}
