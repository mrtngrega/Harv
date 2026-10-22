// Interim tool guard until the full safety gate (M5): Harv may only read and
// search. Anything that runs commands or changes files is denied, and so is
// reading credentials or secrets, which Harv must never touch.

/** Built-in tools available before the safety gate exists. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/** Harv's own memory tools (they can only write inside ~/.harv/memory). */
export const MEMORY_TOOLS = ['mcp__harv__remember', 'mcp__harv__forget'];

const SENSITIVE_PATHS: RegExp[] = [
  /(^|[\\/])\.claude([\\/]|$)/i, // Claude Code login and settings
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.env(\.[\w.-]+)?$/i,
  /credential/i,
  /(^|[\\/])(id_rsa|id_ed25519)/i,
  /\.(pem|key|pfx|p12|kdbx)$/i,
];

export type GuardVerdict = { allow: true } | { allow: false; reason: string };

/** Paths a tool call would touch, from the input fields built-in tools use. */
function pathsOf(input: Record<string, unknown>): string[] {
  return ['file_path', 'path', 'pattern', 'glob'].map((key) => input[key]).filter((v): v is string => typeof v === 'string');
}

export function checkTool(name: string, input: Record<string, unknown>): GuardVerdict {
  if (!READ_ONLY_TOOLS.includes(name) && !MEMORY_TOOLS.includes(name)) {
    return {
      allow: false,
      reason: `${name} isn't enabled yet. Until the safety gate is built, Harv can only read files and search; tell the user this action will be possible later.`,
    };
  }
  const sensitive = pathsOf(input).find((p) => SENSITIVE_PATHS.some((re) => re.test(p)));
  if (sensitive) {
    return { allow: false, reason: `Blocked: ${sensitive} may contain credentials or secrets, which Harv never reads.` };
  }
  return { allow: true };
}

/** One-line description of a tool call for the chat log. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (name) {
    case 'Read':
      return pick('file_path');
    case 'Glob':
    case 'Grep':
      return [pick('pattern'), pick('path')].filter(Boolean).join(' in ');
    case 'WebSearch':
      return pick('query');
    case 'WebFetch':
      return pick('url');
    case 'mcp__harv__remember':
    case 'mcp__harv__forget':
      return pick('name');
    default:
      return '';
  }
}
