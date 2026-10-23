import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment } from '@harv/shared';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES } from '../agent/options.ts';
import type { Classification } from './table.ts';

const PROMPT = `You route messages for Harv, a personal assistant on a Windows PC, to the right Claude model. You never answer the message itself.
Reply with ONLY one JSON object, no prose:
{"category": "<one or two words: chat, question, writing, research, code, debugging, analysis, planning, pc-task, math, ...>", "difficulty": <1-5>, "stakes": "low" | "normal" | "high", "ambiguous": <true|false>, "title": "<chat title>"}
difficulty: 1 = trivial (a greeting, a fact, a one-liner), 2 = easy (a short explanation, a small edit), 3 = moderate (a normal task, some code, a few steps), 4 = hard (multi-step work, real code changes, careful reasoning), 5 = very hard (deep research, architecture, tricky debugging, long precise work).
stakes: high when a mistake would cost the user something real (their files, money, health, legal, security, sending things to other people).
title: a quick, short name (1-4 words, under 24 characters) for what this chat is working on now, in the language the user writes in, like a tab title: "Week plan", "GPU driver update", "Contract renewal". If a current title is given and still fits, repeat it exactly.`;

/** Message text passed to the classifier, trimmed to keep the call cheap. */
const MAX_CHARS = 2000;
const TIMEOUT_MS = 20_000;

/** A tidy tab title, or undefined when the model's suggestion is unusable. */
export function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const title = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”‘’`\s]+|["'“”‘’`.!?:;,\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return undefined;
  return title.length > 32 ? `${title.slice(0, 31)}…` : title;
}

/** Pulls the classification out of the model's reply; null if it isn't usable. */
export function parseClassification(reply: string): Classification | null {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const difficulty = Math.round(Number(raw.difficulty));
  if (!(difficulty >= 1 && difficulty <= 5)) return null;
  const stakes = raw.stakes === 'high' || raw.stakes === 'low' ? raw.stakes : 'normal';
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().slice(0, 30) : 'task';
  const title = cleanTitle(raw.title);
  return {
    category,
    difficulty: difficulty as Classification['difficulty'],
    stakes,
    ambiguous: raw.ambiguous === true,
    ...(title ? { title } : {}),
  };
}

/**
 * One Haiku·low turn with no tools and no saved session. It counts against the
 * plan like any call, so the router only asks when its rules can't decide.
 */
export async function classify(text: string, files: Attachment[], context?: string, title?: string): Promise<Classification | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const message = [
    title ? `Current chat title: "${title}"` : '',
    context ? `Earlier in this chat: ${context}` : '',
    files.length ? `Attached files: ${files.map((f) => `${f.name} (${Math.round(f.size / 1024)} KB)`).join(', ')}` : '',
    `Message:\n${text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const q = query({
    prompt: message,
    options: {
      ...buildOptions('haiku', 'low', abort),
      systemPrompt: PROMPT,
      tools: [],
      maxTurns: 1,
      persistSession: false,
      includePartialMessages: false,
    },
  });
  try {
    for await (const msg of q) {
      // Same hard stop as chat sessions: never run on anything but the subscription.
      if (msg.type === 'system' && msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) return null;
      if (msg.type === 'result') return msg.subtype === 'success' ? parseClassification(msg.result) : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
