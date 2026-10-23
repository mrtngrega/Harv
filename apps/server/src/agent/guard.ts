// Tool lists and chat-log descriptions. The safety checks themselves live in
// ../safety (classify.ts sorts every call, gate.ts enforces it).

/** Harv's memory tools (they can only write inside ~/.harv/memory). */
export const MEMORY_TOOLS = ['mcp__harv__remember', 'mcp__harv__forget'];

/** One-line description of a tool call for the chat log; `chatTitle` names chats read with read_chat. */
export function describeTool(name: string, input: Record<string, unknown>, chatTitle?: (id: string) => string | undefined): string {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return pick('file_path');
    case 'Glob':
    case 'Grep':
      return [pick('pattern'), pick('path')].filter(Boolean).join(' in ');
    case 'WebSearch':
      return pick('query');
    case 'WebFetch':
      return pick('url');
    case 'Bash':
    case 'PowerShell':
      return pick('command').split(/\r?\n/)[0]!.slice(0, 160);
    case 'mcp__harv__remember':
    case 'mcp__harv__forget':
      return pick('name');
    case 'mcp__harv__list_chats':
      return pick('query') || (input.open_only ? 'open tabs' : 'recent');
    case 'mcp__harv__read_chat': {
      const title = chatTitle?.(pick('id'));
      return title ? `"${title}"` : pick('id').slice(0, 8);
    }
    case 'mcp__harv__hand_off': {
      const to = pick('to');
      const target = to
        ? chatTitle?.(to)
          ? `"${chatTitle(to)}"`
          : to.slice(0, 8)
        : `new tab${pick('title') ? ` "${pick('title')}"` : ''}`;
      return `→ ${target}${input.wait === false ? ' (not waiting)' : ''}`;
    }
    default:
      return '';
  }
}
