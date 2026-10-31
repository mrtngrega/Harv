// What a dashboard message must look like before `handle()` sees it. The dashboard never sends a
// malformed one, but a message missing its tab or with text: null reached the chat code and ended
// as an unhandled rejection (the test pass, 2026-10-31). Shapes only: each handler still decides
// what the values mean.

/** Fields that are always strings wherever a message has them. */
const STRINGS = ['tabId', 'id', 'text', 'title', 'taskId', 'reqId', 'path', 'name', 'query', 'cwd', 'data', 'projectId'] as const;
/** Fields that are always finite numbers. */
const NUMBERS = ['fromEnd', 'cols', 'rows'] as const;
/** Chat messages that don't name a tab. */
const NO_TAB = new Set(['history.search']);

/** Why a message is refused, or null when it may go on. */
export function malformed(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'not an object';
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== 'string' || !m.type) return 'no type';
  for (const key of STRINGS) if (key in m && m[key] !== undefined && typeof m[key] !== 'string') return `${key} isn't text`;
  for (const key of NUMBERS) if (key in m && m[key] !== undefined && !Number.isFinite(m[key])) return `${key} isn't a number`;
  if (m.type.startsWith('chat.') && !NO_TAB.has(m.type) && (typeof m.tabId !== 'string' || !m.tabId)) return 'no tab';
  if (m.type === 'chat.send' && typeof m.text !== 'string') return 'no text';
  return null;
}
