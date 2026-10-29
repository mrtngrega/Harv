import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tier } from '@harv/shared';
import { IS_WINDOWS } from '../platform.ts';
import { fullPath, isHarvData, isInside, isProgramDir, isSystemDir, isTempDir, loadSettings, WORKSPACE } from './paths.ts';
import { BROWSER_TOOLS, browserSends, classifyBrowser } from './browser.ts';
import { reachesSecret } from './secrets.ts';

/** How the OS folders are named in reasons. */
const SYSTEM_FOLDER = IS_WINDOWS ? 'the Windows folder' : "the system's own folders";

// Sorts every tool call into green / yellow / red / blocked (CLAUDE.md "Harv's
// safety model"). It is deliberately conservative: a shell command is green only
// when every part of it is clearly read-only, and anything unclear is red, so the
// user gets asked rather than surprised.

export interface Verdict {
  tier: Tier;
  /** Why it got this tier, in plain words. */
  reason: string;
  /** What the call does, in plain words. */
  summary: string;
  /** Paths to back up before it runs (yellow and red). */
  targets: string[];
}

/** Harv's own tool that types a command into the chat's visible terminal (PowerShell on Windows, the user's shell elsewhere). */
export const TERMINAL_RUN = 'mcp__harv__terminal_run';
/** Built-in tools Harv may use; anything else is refused. Every tool that runs a shell command is checked as one. */
export const SHELL_TOOLS = ['Bash', 'PowerShell', TERMINAL_RUN];
export const FILE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch'];
/**
 * Claude Code's own bookkeeping tools (every chat has Claude Code's toolset since 2026-10-27):
 * task lists, subagents (whose tool calls pass the gate themselves), plan mode, watching or
 * stopping a shell Harv started in the background.
 */
export const AGENT_TOOLS = [
  'TodoWrite',
  'Task',
  'Agent',
  'ExitPlanMode',
  'EnterPlanMode',
  'BashOutput',
  'KillShell',
  'KillBash',
  // Background agents: listing them, messaging them, reading or stopping their output (the user's wish 2026-10-25).
  'ListAgents',
  'SendMessage',
  'TaskOutput',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  // Skills and slash commands only load instructions; what they then do is checked tool by tool.
  'Skill',
  'SlashCommand',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  // Asking the user a question shows a question card (gate.ts); nothing runs.
  'AskUserQuestion',
];
/**
 * Claude Code's own schedulers live only as long as the session (or run in the cloud, billed
 * per run on some plans): Harv schedules with its own tools instead, run by Harv's server.
 */
const SCHEDULER_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'];
// hand_off only starts a turn in another chat; everything that chat does passes the gate itself.
export const HARV_TOOLS = [
  'mcp__harv__remember',
  'mcp__harv__forget',
  'mcp__harv__list_chats',
  'mcp__harv__read_chat',
  'mcp__harv__hand_off',
  'mcp__harv__list_projects',
  'mcp__harv__start_project',
  'mcp__harv__open_project',
  'mcp__harv__schedule_task',
  'mcp__harv__list_scheduled',
  'mcp__harv__cancel_scheduled',
  'mcp__harv__terminal_read',
  // Sends the prompt (and pictures the user gave for it) to Gemini, like a web search.
  'mcp__harv__generate_image',
  // A notification on the user's own phone: it's the user, so the sending check doesn't ask (docs/PLAN.md §6q).
  'mcp__harv__phone_notify',
];
export const ENABLED_TOOLS = [...READ_TOOLS, ...FILE_WRITE_TOOLS, ...SHELL_TOOLS];

/** Where a file name ends inside a command line too (a quote, a space, a separator), not only at the end. */
const END = String.raw`(?=$|[\s"'\\/;|),])`;
const START = String.raw`(^|[\\/\s"'])`;
const sensitive = (body: string) => new RegExp(body.replace(/\^START/g, START).replace(/END$/, END), 'i');

/** Files and folders that hold passwords, keys, tokens or login sessions: never read or changed. */
const SENSITIVE_PATHS: RegExp[] = [
  /(^|[\\/])\.claude([\\/]|$)/i, // Claude Code login and settings
  /credential/i, // Windows Credentials, .git-credentials, …credentials.json
  sensitive(String.raw`^START\.(ssh|aws|azure|kube|gnupg|gcloud)([\\/]|END)`),
  sensitive(String.raw`^START\.env(?!\.(example|sample|template)\b)(\.[\w.-]+)?END`),
  sensitive(String.raw`^START(id_rsa|id_ed25519|id_ecdsa|id_dsa)`),
  sensitive(String.raw`^START(\.npmrc|\.netrc|_netrc|\.pypirc)END`),
  sensitive(String.raw`[\\/]\.docker[\\/]config\.json`),
  sensitive(String.raw`[\\/]gh[\\/]hosts\.yml`),
  // Browsers (Chrome, Edge, Brave, Opera…): saved passwords, cookies, autofill, and the key that decrypts them.
  sensitive(String.raw`[\\/](login data|cookies|web data|local state)(-journal)?END`),
  // Firefox
  sensitive(String.raw`[\\/](logins\.json|key[34]\.db|cookies\.sqlite|signons\.sqlite)END`),
  // Windows: saved credentials, the vault, DPAPI master keys, the password hives, Wi-Fi keys.
  sensitive(String.raw`[\\/]microsoft[\\/](credentials|vault|protect)([\\/]|END)`),
  sensitive(String.raw`[\\/]system32[\\/]config[\\/](regback[\\/])?(sam|security|system)END`),
  /[\\/]wlansvc[\\/]profiles/i,
  // App logins: Discord / Telegram sessions, Steam, password managers, VPN state, Harv's own browser.
  /[\\/]discord\w*[\\/]local storage/i,
  /[\\/]telegram desktop[\\/]tdata/i,
  /[\\/]steam[\\/](ssfn|config[\\/](loginusers|config)\.vdf)/i,
  sensitive(String.raw`[\\/](bitwarden|1password|keepassxc|logmein hamachi)([\\/]|END)`),
  /[\\/]tailscale[\\/][^\\/]*state/i,
  /[\\/]\.harv[\\/]browser-profile/i,
  // Linux: the password hashes, sudo rules, the desktop keyrings (GNOME Keyring, KDE Wallet), pass.
  sensitive(String.raw`[\\/]etc[\\/](g?shadow-?|sudoers(\.d)?)END`),
  /[\\/]keyrings([\\/]|$)/i,
  /[\\/]kwalletd?([\\/]|$)/i,
  /[\\/]\.password-store([\\/]|$)/i,
];

/**
 * Key and certificate files, by extension. Only tested on whole file names: in code
 * (`e.key`, `cert.pem` in a sentence) the same letters are no file at all.
 */
const KEY_FILE = /\.(pem|key|pfx|p12|kdbx|ppk|ovpn|jks|keystore)$/i;
const hasKeyFile = (p: string) => p.split(/[\\/]/).some((part) => KEY_FILE.test(part));

const verdict = (tier: Tier, reason: string, summary: string, targets: string[] = []): Verdict => ({ tier, reason, summary, targets });

const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');

export function isSensitivePath(p: string): boolean {
  return (SENSITIVE_PATHS.some((re) => re.test(p)) || hasKeyFile(p)) && !isClaudeHistory(p);
}

/** A command's shell lines mention a credential file (key files only as whole command words, like `cat server.key`). */
function mentionsSecret(shell: string): boolean {
  const text = withoutAllowedClaude(shell);
  if (SENSITIVE_PATHS.some((re) => re.test(text.replace(/["']/g, ' ')))) return true;
  return words(text).some((w) => {
    const file = unquote(w).split('=').at(-1)!;
    return !/[\s(){}<>,;]/.test(file) && hasKeyFile(file);
  });
}

/** Quoted strings in a script: where the paths and shell commands of Python or JavaScript code are. */
const quotedStrings = (text: string) => [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2] ?? '');
/** Words and strings of a script that look like paths (a folder, `~`, a dot file, a file name). */
const looksLikePath = (s: string) =>
  // A name is needed: a lone "/" or the "/255" of a division isn't a path.
  /[a-z]/i.test(s) && !/\s{2}|[\n<>|]/.test(s) && (/[\\/]/.test(s) || /^[~.]/.test(s) || /^[\w.-]+\.\w+$/.test(s));
const scriptPaths = (text: string) =>
  [...quotedStrings(text), ...text.split(/[\s"'`(),;=]+/).filter((w) => /[\\/]/.test(w))].filter(looksLikePath);

/**
 * Claude Code's history (~/.claude/projects/<folder>/): earlier sessions' transcripts
 * (`<session>.jsonl`, the user's wish 2026-10-25), tool outputs too big for the chat
 * (Harv is told to read them there) and the project memory notes. Readable although
 * it's under .claude; the login and settings next to it stay blocked.
 */
export function isClaudeHistory(p: string): boolean {
  return isInside(fullPath(p), join(homedir(), '.claude', 'projects'));
}

/**
 * Claude Code's project memory notes (~/.claude/projects/<folder>/memory/*.md). Project
 * chats share them with Claude Code, so they may write them too.
 */
export function isClaudeMemory(p: string): boolean {
  const path = fullPath(p);
  return isClaudeHistory(path) && /[\\/]memory[\\/][^\\/]+\.md$|[\\/]memory[\\/]?$/i.test(path);
}

/** Where a call runs: in a project chat, the project folder (trusted, and the base for relative paths). */
export interface ClassifyContext {
  project?: string;
  /**
   * Every registered project folder. Any chat working inside one gets the project's
   * trust (a command that starts with `cd <project>`, or a file in it).
   */
  projects?: string[];
  /** Which shell runs a command: PowerShell commands get the read-only analysis below. */
  shell?: 'powershell' | 'bash';
  /** Files and folders on the PC the user attached to this chat (the user gave them, so they're trusted). */
  attached?: string[];
  /** The attached file or folder a command works in (set by `classify`). */
  attachedRoot?: string;
}

/** Claude Code's history named in a command (allowed, although it's under .claude; see isClaudeHistory). */
const CLAUDE_ALLOWED_IN_COMMAND = /\S*\.claude[\\/]projects(?=$|[\\/\s"'])[^\s"']*/gi;
/** The command with those allowed .claude paths taken out (unless they climb out with `..`). */
const withoutAllowedClaude = (command: string) => command.replace(CLAUDE_ALLOWED_IN_COMMAND, (m) => (m.includes('..') ? m : ' '));

/**
 * The attached file or folder a command works in: it `cd`s into one, or names a path inside
 * one (the most specific attachment wins). Other paths it names are judged as usual below.
 */
export function attachedOfCommand(command: string, attached: string[]): string | undefined {
  if (attached.length === 0) return undefined;
  const viaCd = projectOfCommand(command, attached);
  if (viaCd) return viaCd;
  const named = pathLikeWords(splitHeredocs(command).shell, WORKSPACE);
  return [...attached].sort((a, b) => b.length - a.length).find((root) => named.some((p) => isInside(p, root)));
}

/** The registered project a command works in: it starts with `cd`/`Set-Location`/`pushd` (or `git -C`) into one. */
export function projectOfCommand(command: string, projects: string[]): string | undefined {
  const [first = ''] = splitCommand(command);
  const ws = words(first).map(unquote);
  const cmd = (ws[0] ?? '').toLowerCase();
  let target: string | undefined;
  if (['cd', 'chdir', 'set-location', 'sl', 'pushd'].includes(cmd)) target = ws.slice(1).find((w) => !w.startsWith('-'));
  else if (cmd === 'git' && ws[1] === '-C') target = ws[2];
  if (!target || /[$`%*?]/.test(target)) return undefined;
  const path = fullPath(target);
  return projects.find((p) => isInside(path, p));
}

export function classify(tool: string, input: Record<string, unknown>, ctx: ClassifyContext = {}): Verdict {
  if (HARV_TOOLS.includes(tool)) return verdict('green', "Harv's own memory and chat tools.", tool.replace('mcp__harv__', ''));
  if (AGENT_TOOLS.includes(tool)) return verdict('green', 'Planning and bookkeeping; anything it runs is checked on its own.', tool);

  if (READ_TOOLS.includes(tool)) {
    const paths = ['file_path', 'path', 'pattern', 'glob'].map((k) => str(input, k)).filter(Boolean);
    const secret = paths.find(isSensitivePath);
    if (secret) return verdict('blocked', `${secret} may contain credentials or secrets, which Harv never reads.`, `read ${secret}`);
    return verdict('green', 'Reading and searching is always allowed.', `${tool} ${paths[0] ?? str(input, 'query') ?? str(input, 'url')}`);
  }

  if (FILE_WRITE_TOOLS.includes(tool)) {
    const file = str(input, 'file_path') || str(input, 'notebook_path');
    const inProject = ctx.project ?? (file ? ctx.projects?.find((p) => isInside(fullPath(file), p)) : undefined);
    return classifyFileWrite(tool, file, { ...ctx, project: inProject });
  }

  if (SHELL_TOOLS.includes(tool)) {
    const command = str(input, 'command');
    const inProject = ctx.project ?? projectOfCommand(command, ctx.projects ?? []);
    return classifyCommand(command, str(input, 'description'), {
      ...ctx,
      project: inProject,
      attachedRoot: inProject ? undefined : attachedOfCommand(command, ctx.attached ?? []),
      shell: tool === 'PowerShell' || (tool === TERMINAL_RUN && IS_WINDOWS) ? 'powershell' : 'bash',
    });
  }

  // Monitor watches a shell command's output lines (or a WebSocket): the command is checked like any other.
  if (tool === 'Monitor') {
    const command = str(input, 'command');
    if (!command) return verdict('green', 'Watches a WebSocket for events.', `monitor ${str(input, 'description')}`);
    return classifyCommand(command, str(input, 'description'), { ...ctx, shell: 'bash' });
  }

  if (BROWSER_TOOLS.includes(tool)) {
    const v = classifyBrowser(tool, input);
    return verdict(v.tier, v.reason, v.summary);
  }

  if (tool.startsWith('mcp__')) return classifyMcp(tool);

  if (SCHEDULER_TOOLS.includes(tool))
    return verdict('blocked', "Claude Code's scheduler only lives as long as this session. Use Harv's schedule_task tool instead.", tool);

  return verdict('blocked', `${tool} isn't one of Harv's tools.`, tool);
}

/** Connector tools that only look things up. */
const MCP_READ = /^(get|list|read|search|query|fetch|find|guide|describe|view|lookup|export|status)([_-]|$)/i;
/** The user's own private Claude Docs on claude.ai: writing there touches nothing outside their account. */
const PRIVATE_MCP = /^claude_ai_Claude_Docs$/i;

/** Words in a connector tool's name that mean it sends something to someone. */
const MCP_SENDS = /(^|[_-])(send|post|reply|forward|share|invite|publish|comment|message|mail|email|tweet|dm|notify)/i;
/** A whole word or phrase, letters of any language (JS's \b only knows ASCII, so "napíš" would never end). */
const phrase = (body: string) => new RegExp(`(?<![\\p{L}\\d])(?:${body})(?![\\p{L}\\d])`, 'iu');

/**
 * What in the user's message asks Harv to send (English and Slovak), as real phrases: "text file",
 * "Postgres", "shared folder" or "napíš mi funkciu" (write me a function) aren't asking (docs/PLAN.md §6u).
 */
const ASKS_TO_SEND = [
  phrase('send|sends|sending|sent|resend'),
  phrase('e-?mail(s|ed|ing)?'),
  phrase('mail\\s+(it|this|that|them|him|her|me|us|to)'),
  phrase('text\\s+(him|her|them|me|us|my|mom|dad|back)'),
  phrase('(post|posted|posting)\\s+(it|this|that|them|on|to|in)'),
  phrase('(reply|replies|replied|respond|answer)\\s+(to|him|her|them)'),
  phrase('forward(s|ed|ing)?'),
  phrase('share(d)?\\s+((it|this|that|them)\\s+)?(with|to|on)'),
  phrase('message\\s+(him|her|them|me|us)|dm|tweet|invite|publish'),
  // "upload … to <somewhere>", but not to a folder on this PC ("to my workspace").
  phrase(
    'upload(ed|ing)?\\s+.{0,40}?(?<![\\p{L}])to\\s+(?!((my|the|your)\\s+)?(workspace|folder|desktop|downloads|documents)(?![\\p{L}]))(?!(my|the|your)\\s+(workspace|folder|desktop|downloads|documents)(?![\\p{L}]))[\\p{L}\\d]+',
  ),
  // Slovak: pošli / pošlite / pošleš / poslať, odošli, odpíš / odpovedz, prepošli, zdieľaj s, zverejni.
  phrase('po[sš]l(i|ite|e[sš]|eme|ete)|posla[tť]|odo[sš]li(te)?|odosla[tť]|odp[ií][sš](te)?|odpovedz(te)?|prepo[sš]li(te)?|zverejni(te)?'),
  phrase('zdie[lľ]aj(te)?\\s+(to\\s+)?(s|so|na)'),
  // "napíš" only with someone to write to or a message word ("napíš mu", "napíš Jankovi", "napíš mail").
  /(?<![\p{L}\d])nap[ií][sš](te)?\s+(mu|jej|im|n[aá]m|mail|e-?mail|spr[aá]vu|sms|odpove[dď]|\p{Lu}\p{Ll}+(ovi|e|i))(?![\p{L}\d])/u,
];

/** Fields a connector's send tool names its recipients in. */
const RECIPIENT_KEYS =
  /^(to|cc|bcc|recipients?|emails?|address(es)?|users?|user_?ids?|usernames?|channels?|channel_?ids?|chats?|chat_?ids?|conversations?|threads?|phone|numbers?|invitees?|attendees?|people)$/i;

function recipientsOf(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim())
      out.push(
        ...v
          .split(/[,;]/)
          .map((x) => x.trim())
          .filter(Boolean),
      );
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) if (typeof x === 'string') add(x);
  };
  for (const [k, v] of Object.entries(input)) if (RECIPIENT_KEYS.test(k)) add(v);
  return out;
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\d._%+-]+/gu) ?? [];

/**
 * The user's message names this recipient: an address or its name part, a name (Slovak endings
 * allowed: "Peter" in "Petrovi"), or, for an id nobody types ("C04ABC123"), the service ("on Slack").
 */
function mentions(message: string, recipient: string, service: string): boolean {
  const said = message.toLowerCase();
  const r = recipient.toLowerCase().replace(/^[@#]/, '');
  if (said.includes(r)) return true;
  const local = r.includes('@') ? r.split('@')[0]! : r;
  const parts = local.split(/[\s._-]+/).filter((p) => p.length >= 3 && /\p{L}/u.test(p));
  const heard = wordsOf(message);
  if (parts.some((p) => heard.some((w) => w.startsWith(p.slice(0, Math.max(3, p.length - 2)))))) return true;
  const idLike = /\d/.test(r) && !/\s/.test(r) && !r.includes('@');
  return idLike && service.length >= 3 && said.includes(service.toLowerCase());
}

/**
 * A call that sends something to someone (mail, messages, posts, invites, shares, uploads, GitHub posts,
 * copies to another machine, scripts that post or mail). The user's rule (persona rule 12): Harv asks
 * first only when they didn't ask for it.
 */
export function isSending(tool: string, input: Record<string, unknown>): boolean {
  if (BROWSER_TOOLS.includes(tool)) return browserSends(tool, input);
  if (tool.startsWith('mcp__') && !SHELL_TOOLS.includes(tool)) {
    const [, server = '', ...rest] = tool.split('__');
    return !PRIVATE_MCP.test(server) && server !== 'harv' && MCP_SENDS.test(rest.join('__'));
  }
  if (!SHELL_TOOLS.includes(tool)) return false;
  const command = str(input, 'command');
  return sendsData(command) || scriptSends(command);
}

/** The user's message for this turn asked to send something (a free check of its words, no model call). */
export function asksToSend(message: string): boolean {
  return ASKS_TO_SEND.some((re) => re.test(message));
}

/**
 * The user asked for this send: their message asks to send, and a connector send's recipients are
 * ones it names. Sending to someone else in the same reply still gets a card.
 */
export function askedToSend(tool: string, input: Record<string, unknown>, message: string): boolean {
  if (!asksToSend(message)) return false;
  if (!tool.startsWith('mcp__') || SHELL_TOOLS.includes(tool)) return true;
  const service = (tool.split('__')[1] ?? '').replace(/^claude_ai_/, '').replace(/_/g, ' ');
  return recipientsOf(input).every((r) => mentions(message, r, service));
}

/**
 * A tool from an MCP server a chat loads (the user's claude.ai connectors, a project's
 * .mcp.json). Reading is free; changing things elsewhere asks first, except the user's private docs.
 */
function classifyMcp(tool: string): Verdict {
  const [, server = '', ...rest] = tool.split('__');
  const name = rest.join('__');
  const summary = `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${name}`;
  if (MCP_READ.test(name)) return verdict('green', 'Only reads through a connected service.', summary);
  if (PRIVATE_MCP.test(server) && !/delete|remove/i.test(name)) {
    return verdict('green', 'Changes a private doc in your own claude.ai account.', summary);
  }
  return verdict('red', `Changes something through an outside service (${server.replace(/^claude_ai_/, '')}).`, summary);
}

function classifyFileWrite(tool: string, rawPath: string, ctx: ClassifyContext = {}): Verdict {
  const path = fullPath(rawPath, ctx.project);
  const verb = tool === 'Write' ? (existsSync(path) ? 'overwrite' : 'create') : 'edit';
  const summary = `${verb} ${path}`;
  const protectedDir = loadSettings().protectedPaths.find((p) => isInside(path, p));
  if (protectedDir) return verdict('blocked', `${protectedDir} is on your read-only list.`, summary);
  if (isClaudeHistory(path) && !isClaudeMemory(path))
    return verdict('blocked', "Claude Code's session history is only read, never changed.", summary);
  if (isSensitivePath(path)) return verdict('blocked', 'That file may hold credentials or secrets.', summary);
  if (isSystemDir(path)) return verdict('blocked', `Harv never writes inside ${SYSTEM_FOLDER}.`, summary);
  if (isHarvData(path)) return verdict('blocked', "Harv's database, backups and memory are only changed by Harv itself.", summary);
  if (isInside(path, WORKSPACE)) return verdict('green', "Inside Harv's own workspace.", summary);
  if (isClaudeMemory(path)) return verdict('green', 'Harv’s notes about the project (shared with Claude Code).', summary);
  if (ctx.project && isInside(path, ctx.project)) return verdict('green', 'Inside the project folder (git can undo it).', summary);
  if (isProgramDir(path)) return verdict('red', 'It changes an installed program’s files.', summary, [path]);
  return verdict('yellow', verb === 'create' ? 'Creates a new file outside the workspace.' : 'Changes one of your files.', summary, [path]);
}

// ── Shell commands ──────────────────────────────────────────────────────────

/** Never allowed, whatever the user approves (only the user can lift these, in settings). */
const BLOCKED_COMMANDS: [RegExp, string][] = [
  [
    /\bformat(\.com)?\s+[a-z]:|\b(format-volume|clear-disk|initialize-disk|remove-partition)\b|\bdiskpart\b|\bmkfs\b|\b(wipefs|sfdisk|sgdisk|gdisk|parted|blkdiscard)\b|\bfdisk\s+(?!-l\b)|\bdd\b[^|;&\n]*\bof=\/dev\//i,
    'formats or wipes a drive',
  ],
  [/\brm\s+(-\S+\s+)*(\/|\/\*|--no-preserve-root)(\s|$)/, 'deletes the whole system'],
  [
    /set-mppreference\b.*-disable|add-mppreference\b.*exclusion|\b(sc(\.exe)?|stop-service|set-service)\b.*\b(windefend|mpssvc|wscsvc|sense)\b|\bsetenforce\s+(0|permissive)\b/i,
    'turns off antivirus protection',
  ],
  [
    /set-netfirewallprofile\b.*-enabled\s+\$?(false|0)|netsh\s+(advfirewall\s+set\b.*\bstate\s+off|firewall\s+set\s+opmode\s+disable)|\b(remove|disable)-netfirewallrule\b|netsh\s+advfirewall\s+firewall\s+delete|\bsystemctl\s+(stop|disable|mask|kill)\b.*\b(firewalld|ufw|nftables|iptables)\b|\bufw\s+disable\b|\bip6?tables\s+(-F|--flush)\b|\bnft\s+flush\s+ruleset\b/i,
    'turns off or removes firewall protection',
  ],
  [
    /\bcmdkey\b|\bvaultcmd\b|get-storedcredential|\bmimikatz\b|\blsass\b|reg(\.exe)?\s+save\s+hklm\\(sam|security|system)|\.credentials\.json|\bwlan\s+show\s+prof\w*\b.*\bkey\s*=\s*clear|protecteddata|\bunprotect\(|hklm[\\:]+(sam|security)\b|\bsecret-tool\s+lookup\b|\bkwallet-query\b/i,
    'reads stored credentials',
  ],
];

/** Commands that only read or show information. */
const GREEN_COMMANDS = new Set(
  (
    'ls dir pwd cd echo cat type head tail wc grep rg findstr which where where.exe whoami hostname date uname df du file stat tree sort uniq cut ' +
    'tasklist systeminfo ipconfig ping nslookup tracert netstat nvidia-smi ver get-date ' +
    'select-object select where-object ? sort-object format-table ft format-list fl measure-object measure select-string sls test-path resolve-path ' +
    'split-path join-path out-string out-host write-output write-host convertto-json convertfrom-json compare-object group-object gci gc gps gsv gl gi ' +
    'free uptime ps lsblk lscpu lspci lsusb sensors id ss nproc realpath basename dirname lsof ' +
    'fc-list nl md5sum sha1sum sha256sum sha512sum cksum column tr rev jq printf test [ true false identify'
  ).split(' '),
);
const GREEN_GIT = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'blame', 'remote', 'branch', 'tag', 'describe']);

/** Words that change something, wherever they appear in a command. */
const CHANGING_WORDS = new Set(
  (
    'rm rmdir rd del erase mv move cp copy xcopy robocopy ren rename mkdir md touch chmod chown ln kill taskkill pkill shutdown reg regedit sc net netsh ' +
    'schtasks wmic msiexec winget choco scoop npm npx pnpm yarn pip pip3 curl wget powershell pwsh cmd bash sh python python3 py node deno bun start ' +
    'sudo runas iex icacls takeown attrib cipher bcdedit powercfg setx tee dd sed awk perl ruby git -exec -delete -ok ' +
    'dnf yum rpm apt apt-get snap flatpak systemctl pkexec crontab mount umount useradd userdel usermod passwd shred truncate killall'
  ).split(' '),
);
const CHANGING_CMDLET =
  /\b(remove|set|new|add|clear|stop|start|restart|install|uninstall|move|rename|copy|invoke|enable|disable|register|unregister|update|export|import|reset|suspend|resume|mount|dismount|initialize|expand|compress|send|publish|grant|revoke|block|unblock|lock|unlock|protect|unprotect|restore|backup|save|submit|edit|merge|push|pop|out-file)-[a-z]+\b|\b(write|format)-(?!output\b|host\b|table\b|list\b|wide\b|custom\b)[a-z]+\b/i;

/** Linux package managers installing, removing or upgrading software. */
const LINUX_INSTALL =
  /\b(dnf|yum|apt|apt-get|snap|flatpak)\s+(\S+\s+)*?(install|remove|erase|uninstall|reinstall|upgrade|autoremove)\b|\brpm\s+-[a-z]*[iue]/i;
/** Linux system changes: services, scheduled jobs, mounts, users, kernel and network settings. */
const LINUX_SYSTEM =
  /\b(systemctl\s+(?!(status|list-\S+|is-\S+|show|cat)\b)\S+|crontab|mount|umount|useradd|userdel|usermod|passwd|hostnamectl\s+set-\S+|timedatectl\s+set-\S+|nmcli\s+(con|connection|dev|device|radio|networking)\s+(?!(show|status)\b)\S+|sysctl\s+-w|grubby|modprobe|rmmod)\b/i;

/**
 * Other ways to send (docs/PLAN.md §6u): GitHub CLI commands that post for others to see, and copies
 * to another machine (scp/rsync to host:path, sftp, ftp).
 */
function sendsElsewhere(command: string): boolean {
  return splitCommand(command).some((segment) => {
    if (/(?<![\w.-])gh\s+(issue|pr)\s+(create|comment|review|edit|close|reopen|merge)\b/i.test(segment)) return true;
    if (/(?<![\w.-])gh\s+(release\s+(create|upload|edit)|gist\s+(create|edit))\b/i.test(segment)) return true;
    if (
      /(?<![\w.-])gh\s+api\b/i.test(segment) &&
      /\s(-X|--method)\s*(post|put|patch|delete)\b|\s(-f|-F|--field|--raw-field|--input)\b/i.test(segment)
    )
      return true;
    if (/(?<![\w.-])(sftp|ftp|lftp)(\.exe)?\s/i.test(segment)) return true;
    if (!/(?<![\w.-])(scp|rsync|pscp)(\.exe)?\s/i.test(segment)) return false;
    // A remote target is host:path (a drive letter like C:\ isn't a host).
    return words(segment)
      .slice(1)
      .some((w) => /^[^\s:\\/]{2,}:/.test(unquote(w)) && !/^[a-z]:[\\/]/i.test(unquote(w)));
  });
}

/** Code in a command (heredocs, `python -c`, `node -e`) that posts or mails: requests.post, smtplib, fetch with POST… */
export function scriptSends(command: string): boolean {
  return /\b(requests|httpx|session|client)\.(post|put|patch)\s*\(|\bsmtplib\b|\burlopen\s*\([^)]*data\s*=|\baxios\.(post|put|patch)\b|\bfetch\s*\([^)]*method\s*:\s*['"](post|put|patch)['"]|\bnodemailer\b|\bwebhook(s)?\.(send|execute)\b|\bdiscord(_webhook)?\b[^\n]*\.(send|post)\s*\(/i.test(
    command,
  );
}

/**
 * Sending data out: curl/wget uploads and POST-like requests, PowerShell web requests
 * with a changing method, mail. curl's flags are case-sensitive (`-f` only fails
 * quietly, `-F` posts a form), so they're read word by word.
 */
export function sendsData(command: string): boolean {
  if (sendsElsewhere(command)) return true;
  if (/send-mailmessage/i.test(command)) return true;
  // PowerShell's web cmdlets (and their aliases: PowerShell 5.1's curl and wget are Invoke-WebRequest).
  // Parameters may be shortened (`-Met Post`) or joined with a colon (`-Method:Post`); a body is data sent.
  if (
    /\b(invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget)\b/i.test(command) &&
    /\s-met\w*(\s+|:)['"]?(post|put|patch|delete)\b|\s-(bo|bod|body|inf\w*|form)\b|\s-in(?=\s)/i.test(command)
  )
    return true;
  // .NET uploads (WebClient, HttpClient), BITS uploads, raw sockets, and input fed to a remote shell.
  if (/\.upload(string|file|data|values)(taskasync|async)?\s*\(|\.(post|put|patch|send)async\s*\(|-transfertype\s+upload/i.test(command))
    return true;
  if (/(^|[\s;|&(])(nc|ncat|netcat|socat)(\.exe)?\s/i.test(command)) return true;
  if (/\|\s*ssh\b/i.test(command) || splitCommand(command).some((s) => /^ssh\b/i.test(s) && /\s<\s*\S/.test(s))) return true;
  return splitCommand(command).some((segment) => {
    const ws = words(segment).map(unquote);
    const at = ws.findIndex((w) => /(^|[^\w-])(curl|wget)(\.exe)?$/i.test(w));
    if (at === -1) return false;
    const args = ws.slice(at + 1);
    if (/wget(\.exe)?$/i.test(ws[at]!)) return args.some((a) => /^--(post-data|post-file|method|body-data|body-file)\b/.test(a));
    return args.some(
      (a, j) =>
        (/^-[a-zA-Z]*[dFTK]/.test(a) && !a.startsWith('--')) ||
        /^--(data|form|upload-file|json|config)\b/.test(a) ||
        /^-X(post|put|patch|delete)$/i.test(a) ||
        ((a === '-X' || a === '--request') && /^(post|put|patch|delete)$/i.test(args[j + 1] ?? '')),
    );
  });
}

/**
 * Where a plain curl/wget download saves to, as written (`.` for a file named by the
 * server in the current folder; none when it prints to the screen), or null when it isn't one.
 */
export function downloadTargets(segment: string): string[] | null {
  const ws = words(segment).map(unquote);
  const program = (ws[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  if ((program !== 'curl' && program !== 'wget') || sendsData(segment) || /[$`]/.test(segment)) return null;
  const out: string[] = [];
  let intoCwd = program === 'wget';
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i]!;
    if (program === 'curl') {
      if (w === '--output' || w === '--output-dir') out.push(ws[++i] ?? '');
      else if (/^--(output|output-dir)=/.test(w)) out.push(w.slice(w.indexOf('=') + 1));
      else if (w === '--remote-name' || w === '--remote-name-all') intoCwd = true;
      else if (/^-[a-zA-Z]+$/.test(w)) {
        if (w.includes('O')) intoCwd = true;
        if (w.endsWith('o')) out.push(ws[++i] ?? '');
      } else if (/^-o./.test(w)) out.push(w.slice(2));
    } else if (w === '-O' || w === '-P' || w === '-o' || w === '-a') {
      out.push(ws[++i] ?? '');
      if (w === '-O') intoCwd = false;
    } else if (/^--(output-document|directory-prefix|output-file|append-output)=/.test(w)) {
      out.push(w.slice(w.indexOf('=') + 1));
    }
  }
  if (intoCwd) out.push('.');
  return out.filter((t) => t !== '-' && t !== '/dev/null');
}

/** A pattern, or a check that needs more than one (like reading curl's flags). */
type Rule = RegExp | ((command: string) => boolean);
const matches = (rule: Rule, text: string) => (typeof rule === 'function' ? rule(text) : rule.test(text));

/** Red-action categories, for a clear reason on the approval card. */
const RED_REASONS: [Rule, string][] = [
  // (?<![\w.-]): a word, not a flag or part of a name (`java -cp`, `docker run --rm`).
  [/(?<![\w.-])(rm|rmdir|rd|del|erase|remove-item|ri)\b/i, 'Deletes files or folders.'],
  [
    /\b(winget|choco|scoop|msiexec)\b|\b(npm|pnpm|yarn|pip3?)\s+(i|install|add|uninstall|remove)\b|\b(install|uninstall)-\w+/i,
    'Installs or uninstalls software.',
  ],
  [LINUX_INSTALL, 'Installs or uninstalls software.'],
  [/(?<![\w.-])(taskkill|kill|pkill|killall|stop-process|spps)\b/i, 'Stops running programs.'],
  [/(?<![\w.-])reg\b(?!\s+(query|export)\b)|\bregedit\b|-itemproperty\b|\bhk(lm|cu|cr|u|cc):?\\/i, 'Changes the Windows registry.'],
  [/\b(netsh|sc|bcdedit|powercfg|schtasks|setx|set-service|set-netadapter|set-executionpolicy)\b/i, 'Changes system settings.'],
  [LINUX_SYSTEM, 'Changes system settings.'],
  [/\b(sudo|pkexec)\b/i, 'Runs as administrator.'],
  [/\bgit\s+push\b/i, 'Pushes to a git remote.'],
  [sendsData, 'Sends data over the network.'],
  [scriptSends, 'Sends data over the network (from a script).'],
  [/(?<![\w.-])(mv|move|ren|rename|move-item|rename-item|cp|copy|xcopy|robocopy|copy-item)\b/i, 'Moves, renames or copies files.'],
  [/\.(ps1|bat|cmd|vbs|js|py|sh)\b|\b(python3?|py|node|powershell|pwsh|cmd|bash)\b/i, 'Runs a script or another shell.'],
  [/\b(set-content|add-content|out-file|new-item|tee)\b|>/i, 'Writes files.'],
];

const EXECUTABLE = /\.(exe|bat|cmd|ps1|vbs|js|jse|wsf|msi|scr|com|lnk|reg|py|sh)$/i;

/** The parts of a command chain: `a && b; c | d` → [a, b, c, d]. Separators inside quotes (`-match 'a|b'`) don't split. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (/[;|\n\r]/.test(ch) || (ch === '&' && command[i + 1] === '&')) {
      if (command[i + 1] === ch) i++;
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface Heredoc {
  /** The command that reads it (`python3`, `cat`): code for an interpreter, data for cat/tee. */
  runner: string;
  text: string;
}

/**
 * A bash command's heredocs (`python3 - <<'EOF' … EOF`) taken apart from its shell lines.
 * The body is a script or data, not commands for the shell, so reading its words as
 * commands made every script red. Found the way bash does: only outside quotes.
 */
export function splitHeredocs(command: string): { shell: string; bodies: Heredoc[] } {
  let shell = '';
  const bodies: Heredoc[] = [];
  const pending: { tag: string; dash: boolean; runner: string }[] = [];
  let quote = '';
  let lineStart = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') {
        shell += ch + (command[++i] ?? '');
        continue;
      }
      if (ch === quote) quote = '';
      shell += ch;
      continue;
    }
    if (ch === '\\') {
      shell += ch + (command[++i] ?? '');
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      shell += ch;
      continue;
    }
    const op = ch === '<' && command[i - 1] !== '<' ? /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w-]*)\2/.exec(command.slice(i)) : null;
    if (op) {
      const [whole, dash, , tag] = op;
      const before = splitCommand(shell.slice(lineStart)).at(-1) ?? '';
      pending.push({ tag: tag!, dash: dash === '-', runner: (words(before)[0] ?? '').toLowerCase() });
      shell += ' ';
      i += whole.length - 1;
      continue;
    }
    if (ch === '\n' && pending.length > 0) {
      shell += '\n';
      let pos = i + 1;
      for (const { tag, dash, runner } of pending.splice(0)) {
        const body: string[] = [];
        while (pos <= command.length) {
          const end = command.indexOf('\n', pos);
          const line = command.slice(pos, end === -1 ? command.length : end).replace(/\r$/, '');
          pos = end === -1 ? command.length + 1 : end + 1;
          if ((dash ? line.replace(/^\t+/, '') : line) === tag) break;
          body.push(line);
        }
        bodies.push({ runner, text: body.join('\n') });
      }
      i = pos - 1; // the loop's i++ lands on the line after the last terminator
      lineStart = shell.length;
      continue;
    }
    if (ch === '\n') lineStart = shell.length + 1;
    shell += ch;
  }
  return { shell, bodies };
}

/** Commands whose heredoc is data they print or save, not code they run. */
const DATA_RUNNERS = new Set(['cat', 'tee']);
const SHELL_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Code that starts other programs (or edits the registry): only then can its strings be shell commands. */
const PROCESS_API =
  /\b(subprocess|os\.(system|popen|exec\w*|spawn\w*)|popen|child_process|start-process|invoke-expression|iex|winreg)\b|\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(|shell\s*=\s*True/i;
/**
 * Code of a heredoc as text the shell rules can look at: all of a shell script, the strings
 * of other code that starts programs. A script that doesn't (Python editing a file, with
 * `sc` or `rm` somewhere in its strings) can't run anything.
 */
const codeOf = (bodies: Heredoc[]) =>
  bodies
    .filter((b) => !DATA_RUNNERS.has(b.runner))
    .map((b) => (SHELL_RUNNERS.has(b.runner) ? b.text : PROCESS_API.test(b.text) ? quotedStrings(b.text).join(' ') : ''))
    .join('\n');
/** Deleting from inside a script (Python, Node, PowerShell). */
const DELETE_API =
  /\b(os\.(remove|unlink|rmdir|removedirs)|shutil\.rmtree|rmtree|unlinkSync|rmSync|rmdirSync|fs\.(rm|unlink|rmdir)|remove-item)\b|\.unlink\(/i;

// ── Read-only programs and PowerShell pipelines ────────────────────────────

/** Programs that only show information when their first argument is one of these. */
const READ_ONLY_PROGRAMS: Record<string, RegExp> = {
  ollama: /^(list|ls|ps|show|--version|-v)$/i,
  winget: /^(list|search|show|--version|-v)$/i,
  npm: /^(ls|list|ll|view|info|outdated|root|prefix|--version|-v)$/i,
  pnpm: /^(ls|list|outdated|--version|-v)$/i,
  yarn: /^(list|info|--version|-v)$/i,
  pip: /^(list|show|freeze|--version|-V)$/,
  pip3: /^(list|show|freeze|--version|-V)$/,
  node: /^(--version|-v)$/i,
  python: /^(--version|-V)$/,
  python3: /^(--version|-V)$/,
  py: /^(--version|-V|--list|-0)$/,
  dotnet: /^(--version|--info|--list-sdks|--list-runtimes)$/i,
  docker: /^(ps|images|version|info)$/i,
  wsl: /^(-l|--list|--status|--version)$/i,
  choco: /^(list|search|info|--version)$/i,
  scoop: /^(list|search|info|status)$/i,
  code: /^(--version|--list-extensions)$/i,
  tailscale: /^(status|ip|version)$/i,
  java: /^(-version|--version)$/,
  javac: /^(-version|--version)$/,
  adb: /^(devices|version|get-state|get-serialno)$/,
  magick: /^(identify|-version|--version)$/,
  dnf: /^(list|info|search|repolist|repoquery|history|check-update|--version)$/i,
  rpm: /^(-q[a-z]*|--query|--version)$/,
  flatpak: /^(list|info|search|remotes|history|--version)$/i,
  systemctl: /^(status|list-units|list-unit-files|list-timers|is-active|is-enabled|is-failed|show|cat|--failed|--version)$/i,
  hostnamectl: /^status$/i,
  timedatectl: /^status$/i,
  powercfg: /^[/-](l|list|q|query|a|availablesleepstates|getactivescheme|requests)$/i,
};

/** `ollama list`, `npm --version`: a program from the list above, asked only to show something. */
export function isReadOnlyProgram(name: string, args: string[]): boolean {
  const program = name.toLowerCase().replace(/\.exe$/, '');
  const first = args.find((a) => a.length > 0);
  return Object.hasOwn(READ_ONLY_PROGRAMS, program) && first !== undefined && READ_ONLY_PROGRAMS[program]!.test(first);
}

const PS_KEYWORDS = new Set(
  'if else elseif foreach for while do until switch return break continue try catch finally in default begin process end'.split(' '),
);
/** PowerShell commands that only read: Get-*, Test-*, filters, formatting. */
const PS_READ_CMDLET =
  /^(get|test|resolve|measure|select|sort|group|where|foreach|compare|convertto|convertfrom|split|join)-[a-z]+$|^(format-(table|list|wide|custom|hex)|out-(string|null|host|default)|write-(output|host)|start-sleep)$/;
const PS_READ_ALIASES = new Set('% ? foreach where sort select measure group gp gpv gm gcm gal'.split(' '));
/** .NET methods that only compute or read; any other method call (`.Delete()`, `.Kill()`, `::Start(`) isn't read-only. */
const SAFE_METHODS = new Set(
  (
    'tostring substring trim trimend trimstart tolower toupper tolowerinvariant toupperinvariant replace split join contains startswith endswith ' +
    'indexof lastindexof padleft padright insert normalize equals compareto gettype gethashcode format concat isnullorempty isnullorwhitespace ' +
    'round floor ceiling truncate max min abs pow sqrt log log10 sign parse tryparse toint32 toint64 todouble todecimal toboolean tochararray ' +
    'tobase64string frombase64string adddays addhours addminutes addseconds addmilliseconds addmonths addyears subtract toshortdatestring ' +
    'tolongdatestring toshorttimestring touniversaltime tolocaltime fromfiletime now today match matches ismatch escape unescape toarray ' +
    'getfolderpath getenvironmentvariable getenvironmentvariables getlogicaldrives getfilename getextension getdirectoryname ' +
    'getfilenamewithoutextension combine getfullpath getpathroot gettemppath exists getfiles getdirectories getfilesystementries ' +
    'enumeratefiles enumeratedirectories getlastwritetime getcreationtime getattributes readalltext readalllines getvalue getvaluenames ' +
    'getsubkeynames getbytes getstring openread add'
  ).split(' '),
);

/**
 * A PowerShell command that only reads, however it's put together: pipelines, script blocks
 * (`ForEach-Object { … }`, `@{n=…;e={…}}`), variables, `[math]::Round(…)`. Every command
 * that runs, wherever it sits, must be a read-only one, and every .NET call a harmless one.
 */
export function isReadOnlyPowerShell(command: string): boolean {
  // Here-strings are hard to read safely.
  if (/@["']/.test(command)) return false;
  // Strings are data, but "…$(…)…" runs code inside a string.
  let code = command.replace(/'[^']*'/g, "''");
  if (/"[^"]*\$\(/.test(code)) return false;
  code = code.replace(/"[^"]*"/g, '""');
  // An unclosed quote, a backtick (escapes, line continuations) or a comment.
  if (/['"`#]/.test(code.replace(/''|""/g, ''))) return false;

  for (const m of code.matchAll(/(?:\.|::)\s*([A-Za-z_]\w*)\s*\(/g)) {
    if (!SAFE_METHODS.has(m[1]!.toLowerCase())) return false;
  }
  // A method named by a string or a variable: `$x.'Delete'()`, `$x.$name()`.
  if (/(\.|::)\s*(''|""|\$\w*)\s*\(/.test(code)) return false;

  const tokens = code.match(/\$\(|@\(|@\{|&&|\|\||\[[^\]]*\]|[|;{}()=,\n\r]|[^\s|;{}()=,]+/g) ?? [];
  // What each open bracket is: a hashtable (keys come before `=`), or a block/pipeline.
  const stack: ('hash' | 'block')[] = [];
  let expectCommand = true;
  let hashKey = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const lower = t.toLowerCase();
    if (t === '@{') {
      stack.push('hash');
      hashKey = true;
      expectCommand = false;
      continue;
    }
    if (t === '{' || t === '(' || t === '$(' || t === '@(') {
      stack.push('block');
      expectCommand = true;
      continue;
    }
    if (t === '}' || t === ')') {
      stack.pop();
      expectCommand = false;
      continue;
    }
    const inHash = stack.at(-1) === 'hash';
    if (t === ';' || t === '\n' || t === '\r') {
      if (inHash) hashKey = true;
      else expectCommand = true;
      continue;
    }
    if (t === '|' || t === '&&' || t === '||' || t === '=' || t === ',') {
      // `a = b` and `x, (Get-Date)`: what follows may be a command.
      if (inHash && t === '=') hashKey = false;
      expectCommand = t !== ',';
      continue;
    }
    if (inHash && hashKey) continue; // a hashtable key
    if (!expectCommand) continue; // an argument or operator
    expectCommand = false;
    // Values, not commands: variables, types/casts, numbers, strings, operators like -not.
    if (/^[$[\d'"@!-]/.test(t)) {
      // `[math]::Round(...)` and `$x.Method()` were checked above; `$x = ...` continues as an assignment.
      continue;
    }
    if (t === '&' || t === '.' || t.startsWith('.') || /[\\/]/.test(t)) return false; // call operator, dot-sourcing, a script by path
    const next = (tokens[i + 1] ?? '').toLowerCase();
    if (lower === 'foreach-object' || lower === '%' || (lower === 'foreach' && next !== '(')) {
      // `% Delete` calls a method on every item; only a script block is read here.
      if (next !== '{' && next !== '-process') return false;
      continue;
    }
    if (PS_KEYWORDS.has(lower)) {
      expectCommand = lower !== 'in';
      continue;
    }
    if (PS_READ_CMDLET.test(lower) && !/^get-(credential|storedcredential)$/.test(lower)) continue;
    if (PS_READ_ALIASES.has(lower) || (GREEN_COMMANDS.has(lower) && !CHANGING_WORDS.has(lower))) continue;
    // An outside program: read-only only when it's asked to show something.
    const args: string[] = [];
    for (let j = i + 1; j < tokens.length && !/^([|;})\n\r]|&&|\|\|)$/.test(tokens[j]!); j++) args.push(unquote(tokens[j]!));
    if (isReadOnlyProgram(lower, args)) continue;
    return false;
  }
  return true;
}

const words = (segment: string) => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
const unquote = (w: string) => w.replace(/^["']|["']$/g, '');

/** Literal paths a command mentions that exist on disk (what a backup should cover). */
export function pathsInCommand(command: string, cwd = WORKSPACE): string[] {
  const out = new Set<string>();
  for (const segment of splitCommand(command)) {
    for (const word of words(segment).slice(1).map(unquote)) {
      if (!word || word.startsWith('-') || /^\/[a-z?]$/i.test(word) || /[*?$`]/.test(word) || /^https?:/i.test(word)) continue;
      if (!/[\\/.]/.test(word) && !existsSync(fullPath(word, cwd))) continue;
      const path = fullPath(word, cwd);
      if (existsSync(path)) out.add(path);
    }
  }
  return [...out];
}

/** Programs that can change a whole folder at once: delete, move or rename it, mirror into it, reset it. */
const FOLDER_CHANGERS =
  /^(rm|rmdir|rd|del|erase|remove-item|ri|mv|move|move-item|mi|ren|rename|rename-item|rni|robocopy|xcopy|rsync|shred|git)$/i;

/**
 * What a backup really needs of an action's targets. Folders in the temp folder are scratch. A folder is copied
 * whole only when a shell command can change it as a whole (`rm -r x`, `mv x y`, `robocopy … x /mir`,
 * `git clean` in it): looking into one, or making something inside it, copied all of it before (the
 * whole Projects folder for a "check the repo", a 142 MB Temp folder for a listing). What a command
 * creates there is still noted (a path that doesn't exist yet), so Undo removes it.
 */
export function backupTargets(targets: string[], command?: string, cwd = WORKSPACE): string[] {
  const segments = command ? splitCommand(command).map((s) => words(s).map(unquote)) : [];
  return targets.filter((target) => {
    if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) return true;
    // A folder in the temp folder is scratch (a file there may still be worth an Undo).
    if (isTempDir(target)) return false;
    if (command === undefined) return true;
    const full = fullPath(target, cwd).toLowerCase();
    return segments.some(
      (ws) =>
        FOLDER_CHANGERS.test((ws[0] ?? '').replace(/\.exe$/i, '')) &&
        (ws[0]!.toLowerCase() !== 'git' || /^(clean|reset|checkout|restore|stash|rm|mv)$/i.test(ws[1] ?? '')) &&
        ws.slice(1).some((w) => !w.startsWith('-') && fullPath(w, cwd).toLowerCase() === full),
    );
  });
}

/** `start notepad`, `Start-Process https://…`, `explorer C:\…`: opening an app, page or document. */
function isOpenApp(segment: string): boolean {
  const [first = '', ...rest] = words(segment).map(unquote);
  const cmd = first.toLowerCase();
  const windows = ['start', 'start-process', 'saps', 'invoke-item', 'ii', 'explorer', 'explorer.exe', 'notepad', 'calc', 'code'];
  if (![...windows, 'xdg-open', 'kde-open', 'kde-open5', 'dolphin', 'kate'].includes(cmd)) return false;
  if (/-verb\s+runas|-credential|-argumentlist/i.test(segment)) return false;
  const target = rest.filter((w) => !w.startsWith('-') && w !== '""')[0] ?? '';
  if (/^https?:\/\//i.test(target)) return true;
  if (EXECUTABLE.test(target)) return false;
  // A bare app name (no folder) or a document/folder path.
  return true;
}

/**
 * The new folders a command creates (`mkdir x`, `md x`, `New-Item -ItemType Directory -Path x [-Name y]`),
 * or null when it does anything else or a folder already exists.
 */
export function newFolders(command: string, cwd = WORKSPACE): string[] | null {
  const segments = splitCommand(command);
  if (segments.length === 0 || /\$\(|`|>/.test(command)) return null;
  const out: string[] = [];
  for (const segment of segments) {
    const ws = words(segment).map(unquote);
    const cmd = (ws[0] ?? '').toLowerCase();
    let targets: string[];
    if (cmd === 'mkdir' || cmd === 'md') {
      targets = ws.slice(1).filter((w) => !w.startsWith('-'));
    } else if (cmd === 'new-item' || cmd === 'ni') {
      const opts: Record<string, string> = {};
      const positional: string[] = [];
      for (let i = 1; i < ws.length; i++) {
        const w = ws[i]!;
        if (!w.startsWith('-')) positional.push(w);
        else if (w.toLowerCase() !== '-force') opts[w.slice(1).toLowerCase()] = ws[++i] ?? '';
      }
      if (!/^(directory|dir|container)$/i.test(opts.itemtype ?? opts.type ?? '')) return null;
      const base = opts.path ?? opts.literalpath ?? positional[0];
      if (!base && !opts.name) return null;
      targets = [opts.name ? join(base ?? '.', opts.name) : base!];
    } else {
      return null;
    }
    if (targets.length === 0) return null;
    for (const target of targets) {
      const path = fullPath(target, cwd);
      if (/[*?$]/.test(target) || existsSync(path)) return null;
      out.push(path);
    }
  }
  return out;
}

/** Making new folders can't destroy anything, so it's yellow (logged, Undo removes them) unless it's somewhere off-limits. */
function classifyNewFolders(folders: string[], summary: string, project?: string): Verdict {
  const protectedDir = loadSettings().protectedPaths.find((dir) => folders.some((f) => isInside(f, dir)));
  if (protectedDir) return verdict('blocked', `Blocked: ${protectedDir} is on your read-only list.`, summary);
  if (folders.some(isSystemDir)) return verdict('blocked', `Blocked: Harv never changes ${SYSTEM_FOLDER}.`, summary);
  if (folders.some(isHarvData))
    return verdict('blocked', "Blocked: Harv's database, backups and memory are only changed by Harv itself.", summary);
  if (folders.every((f) => isInside(f, WORKSPACE))) return verdict('green', "Inside Harv's own workspace.", summary);
  if (project && folders.every((f) => isInside(f, project))) return verdict('green', 'Inside the project folder.', summary);
  if (folders.some(isProgramDir)) return verdict('red', 'It changes an installed program’s folder.', summary, folders);
  return verdict('yellow', 'Creates new folders.', summary, folders);
}

/**
 * sed that only prints: no in-place edit (`-i`), no script file, and no command that
 * writes or runs something (`w`, `W`, `r`, `R`, `e`, or the `w`/`e` flags of `s`).
 */
export function isPrintOnlySed(args: string[]): boolean {
  const scripts: string[] = [];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (/^--expression=/.test(a)) scripts.push(a.slice(13));
    else if (/^-[a-zA-Z]*[if]|^--(in-place|file)/.test(a)) return false;
    else if (/^-/.test(a)) continue;
    else if (scripts.length === 0 && !positional) {
      scripts.push(a);
      positional = true;
    }
  }
  if (scripts.length === 0) return false;
  return scripts.every((script) => {
    let flagsOk = true;
    const rest = script
      // s/a/b/flags and y/abc/xyz/ (any delimiter): keep only the flags.
      .replace(/([sy])([^\w\s\\])((?:\\.|(?!\2).)*)\2((?:\\.|(?!\2).)*)\2([a-zA-Z0-9]*)/g, (_m, _c, _d, _a, _b, flags: string) => {
        if (/[we]/.test(flags)) flagsOk = false;
        return ';';
      })
      // /regex/ addresses
      .replace(/\/(?:\\.|[^/])*\//g, '');
    return flagsOk && /^[\s\d,$;!{}pdnqgPDNhHxG=~+-]*$/.test(rest);
  });
}

/** gh commands that only look: listing and viewing, auth status, GET-only `gh api`. */
function isReadOnlyGh(args: string[]): boolean {
  const [group = '', action = ''] = args;
  if (group === '--version' || (group === 'auth' && action === 'status')) return true;
  if (group === 'search') return true;
  if (group === 'api') return !args.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
  return /^(repo|pr|issue|release|run|workflow|gist|label|cache|ruleset)$/.test(group) && /^(list|view|status|diff|checks)$/.test(action);
}

function isGreenSegment(segment: string): boolean {
  const ws = words(segment).map(unquote);
  const first = (ws[0] ?? '').toLowerCase();
  if (first === 'git') {
    const sub = (ws[1] ?? '').toLowerCase();
    if (!GREEN_GIT.has(sub) || /\s-(d|D|m|M)\b|--delete|set-url|\b(add|remove|rename|prune|set-head|set-branches|update)\b/.test(segment))
      return false;
    // `git diff --output=f` writes a file.
    if (/\s--output\b/.test(segment)) return false;
    // `git branch x` / `git tag x` make one: only listing is reading.
    if (sub === 'branch' || sub === 'tag')
      return (
        ws.slice(2).every((w) => w.startsWith('-')) &&
        !(sub === 'branch' ? /\s-(c|C|f|u)\b/ : /\s-(a|s|u|f|e)\b/).test(segment) &&
        !/--(copy|force|annotate|sign|edit|set-upstream\S*|unset-upstream)/.test(segment)
      );
    return true;
  }
  // Read-only programs with options that write a file or run another program.
  if (first === 'sort') return !/\s(-o\S*|--output\S*)/.test(segment);
  if (first === 'uniq') return ws.slice(1).filter((w) => !w.startsWith('-')).length <= 1;
  if (first === 'rg') return !/\s--pre(-glob)?\b/.test(segment);
  if (first === 'tree') return !/\s-o\b/.test(segment);
  if (first === 'ss') return !/\s(-K|--kill)\b/.test(segment);
  if (first === 'hostname') return ws.slice(1).every((w) => w.startsWith('-') && !/^(-F|--file)$/.test(w));
  if (first === 'nvidia-smi')
    return !/\s-(pl|r|ac|lgc|pm|rac)\b|--(power-limit|gpu-reset|applications-clocks|lock-gpu-clocks)/i.test(segment);
  if (first === 'ipconfig') return !/\/(release|renew)/i.test(segment);
  if (first === 'find') return !/-(delete|exec|execdir|ok|fprint|fls)/.test(segment);
  // Logs: reading only (`--vacuum-*`, `--rotate`, `--flush` delete or move them).
  if (first === 'journalctl') return !/--(vacuum|rotate|flush|relinquish|sync|setup-keys|update-catalog)/.test(segment);
  // `ip addr`, `ip route`: showing only, never `add`/`del`/`set`/`flush`.
  if (first === 'ip')
    return (
      /^(-\S+\s+)*(a|addr|address|r|route|l|link|n|neigh)\b/.test(ws.slice(1).join(' ')) &&
      !/\b(add|del|delete|set|flush|change|replace|append)\b/.test(segment)
    );
  // Printing lines (`sed -n '5,20p' file`, `sed 's/a/b/g' file`), never editing in place or writing files.
  if (first === 'sed') return isPrintOnlySed(ws.slice(1));
  // awk programs that only print: no shell calls, pipes, redirections or program files.
  if (first === 'awk' || first === 'gawk')
    return !/\s(-i|--inplace|-f|--file)\b|\bsystem\s*\(|getline|[|>]/.test(
      ` ${ws
        .slice(1)
        .filter((w) => !/^-F/.test(w))
        .join(' ')}`,
    );
  if (first === 'date') return !/\s(-s|--set)\b/.test(segment);
  if (first === 'gh') return isReadOnlyGh(ws.slice(1));
  if (/^get-[a-z]+$/.test(first)) return !/get-(credential|storedcredential)/.test(first);
  return GREEN_COMMANDS.has(first);
}

/** A system folder named in a Linux command (/etc, /usr…). */
const LINUX_SYSTEM_PATH = /(^|[\s"'=>])\/(boot|usr|etc|bin|sbin|lib|lib64|proc|sys|dev|root)(\/|\s|$)/;

/** Redirection into a file (`> out.txt`), ignoring harmless `2>&1` and `> $null`. */
const writesFile = (command: string) => />/.test(command.replace(/\d?>\s*(&\d|\$null|\/dev\/null|nul\b)/gi, ''));

export function classifyCommand(command: string, description = '', ctx: ClassifyContext = {}): Verdict {
  const v = classifyCommandAsIs(command, description, ctx);
  if (v.tier !== 'red') return v;
  const rules = loadSettings().allowRules;
  if (rules.length === 0) return v;
  const needed = rulesFor(command, ctx);
  if (!needed || needed.length === 0 || !needed.every((r) => rules.includes(r))) return v;
  return { ...v, tier: 'yellow', reason: `You said not to ask again for ${needed.map((r) => `"${r}"`).join(' and ')}.` };
}

// ── "Don't ask again" rules (Settings › Safety; the user's wish 2026-10-24) ──

/** Commands no rule may cover: they run other code, so "this kind of command" means nothing. */
const NO_RULE = new Set(
  (
    'powershell pwsh cmd bash sh node python python3 py deno bun iex invoke-expression invoke-command start start-process saps & . ' +
    'foreach-object % foreach where-object ? sudo runas wsl npx call'
  ).split(' '),
);

/**
 * The rule a single command would be covered by: the program plus its subcommand
 * (`npm install`, `git push`, `reg export`), or the PowerShell cmdlet (`remove-item`).
 * Null when it's not a plain command (script blocks, substitutions, redirection).
 */
export function ruleOf(segment: string): string | null {
  if (/[{}()`<>]/.test(segment) || /\$\(|\biex\b/i.test(segment)) return null;
  const ws = words(segment).map(unquote);
  const program = (ws[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  if (!/^[a-z][\w.-]*$/.test(program) || NO_RULE.has(program) || EXECUTABLE.test(program)) return null;
  const sub = ws[1] ?? '';
  // The destructive kinds of git get their own rule, so allowing `git push` doesn't allow a force push.
  if (program === 'git' && sub === 'push' && /\s(-f|-d|--force\S*|--delete|--mirror)\b|\s\+\S|\s:\S/.test(segment))
    return 'git push --force';
  if (program === 'git' && sub === 'reset' && /\s--hard\b/.test(segment)) return 'git reset --hard';
  // Cmdlets (Verb-Noun) have no subcommands; for programs the second word is one when it's a plain word.
  if (!program.includes('-') && /^[a-z][a-z-]*$/i.test(sub)) return `${program} ${sub.toLowerCase()}`;
  return program;
}

/**
 * The rules a command needs to run without asking: one per part that isn't read-only.
 * Null when some part can't be covered by a rule (it always asks).
 */
export function rulesFor(command: string, ctx: ClassifyContext = {}): string[] | null {
  const needed = new Set<string>();
  for (const segment of splitCommand(command)) {
    if (classifyCommandAsIs(segment, '', ctx).tier === 'green') continue;
    const rule = ruleOf(segment);
    if (!rule) return null;
    needed.add(rule);
  }
  return [...needed];
}

function classifyCommandAsIs(command: string, description: string, ctx: ClassifyContext): Verdict {
  const cwd = ctx.project ?? WORKSPACE;
  const summary = description || command.split(/\r?\n/)[0]!.slice(0, 120);
  for (const [re, what] of BLOCKED_COMMANDS) {
    if (re.test(command)) return verdict('blocked', `Blocked: this ${what}. Only you can unblock that, in Harv's settings.`, summary);
  }
  // Heredoc bodies are scripts or data: the shell rules below read only the shell lines around them.
  const { shell, bodies } = ctx.shell === 'powershell' ? { shell: command, bodies: [] } : splitHeredocs(command);
  const parts = splitCommand(shell).map((segment) => words(segment).map(unquote));
  if (mentionsSecret(shell) || reachesSecret(parts, cwd) || bodies.some((b) => scriptPaths(b.text).some(isSensitivePath))) {
    return verdict('blocked', 'Blocked: it touches files that may hold credentials or secrets.', summary);
  }

  const segments = splitCommand(shell);
  const substitutes = /\$\(|`|\binvoke-expression\b|\biex\b|-encodedcommand|\s-enc\s/i.test(shell);
  const tokens = segments.flatMap((s) => words(s).map((w) => unquote(w).toLowerCase()));
  const changing = tokens.some((t) => CHANGING_WORDS.has(t)) || CHANGING_CMDLET.test(shell);

  // git's read-only subcommands, print-only sed and awk are fine although they're on the changing list.
  const readOnly = (segment: string) => {
    const ws = words(segment).map((w) => unquote(w).toLowerCase());
    if (isReadOnlyProgram(ws[0] ?? '', ws.slice(1))) return true;
    if (!isGreenSegment(segment)) return false;
    return ['git', 'sed', 'awk', 'gawk', 'journalctl', 'ip'].includes(ws[0] ?? '') || !ws.some((t) => CHANGING_WORDS.has(t));
  };
  // A plain download into the workspace, the temp folder or the project. After a `cd`, a file named by the server could land anywhere.
  const changesDir = segments.some((s) => /^(cd|chdir|set-location|sl|pushd)$/i.test(words(s)[0] ?? ''));
  const download = (segment: string) => {
    const targets = downloadTargets(segment);
    if (!targets || (changesDir && targets.some((t) => !/^([a-z]:)?[\\/]|^~[\\/]/i.test(t)))) return false;
    return targets
      .map((t) => fullPath(t, cwd))
      .every((t) => isInside(t, WORKSPACE) || isTempDir(t) || (ctx.project !== undefined && isInside(t, ctx.project)));
  };

  if (!substitutes && !writesFile(shell) && segments.length > 0 && bodies.length === 0) {
    if (segments.length === 1 && isOpenApp(segments[0]!)) return verdict('green', 'Opens an app, page or document.', summary);
    if (segments.every(readOnly) && !CHANGING_CMDLET.test(shell)) return verdict('green', 'Only reads information.', summary);
    if (segments.every((s) => readOnly(s) || download(s)) && !CHANGING_CMDLET.test(shell)) {
      return verdict('green', 'Only reads, or downloads into the workspace, the temp folder or the project.', summary);
    }
  }
  if (ctx.shell === 'powershell' && !writesFile(command) && isReadOnlyPowerShell(command)) {
    return verdict('green', 'Only reads information.', summary);
  }

  const folders = bodies.length === 0 ? newFolders(shell, cwd) : null;
  if (folders) return classifyNewFolders(folders, summary, ctx.project);

  const paths = pathsInCommand(shell, cwd);
  const settings = loadSettings();
  const mentions = (test: (p: string) => boolean, pattern: RegExp) => paths.some(test) || pattern.test(command);
  const protectedDir = settings.protectedPaths.find((dir) => mentions((p) => isInside(p, dir), new RegExp(escapeRegExp(dir), 'i')));
  if (protectedDir) return verdict('blocked', `Blocked: it would change ${protectedDir}, which is on your read-only list.`, summary);
  if (IS_WINDOWS && mentions(isSystemDir, /\b[a-z]:[\\/]windows\b|\/c\/windows\b|%windir%|%systemroot%|\$env:(windir|systemroot)/i)) {
    return verdict('blocked', 'Blocked: Harv never changes the Windows folder.', summary);
  }
  // Linux guards its own folders (they belong to root), so only sudo could change them.
  const changesAsRoot = tokens.some((t) => CHANGING_WORDS.has(t) && t !== 'sudo' && t !== 'pkexec') || writesFile(shell);
  if (!IS_WINDOWS && /\b(sudo|pkexec)\b/.test(command) && changesAsRoot && mentions(isSystemDir, LINUX_SYSTEM_PATH)) {
    return verdict('blocked', `Blocked: Harv never changes ${SYSTEM_FOLDER}.`, summary);
  }
  // Reading Harv's logs or settings is fine; anything that could change them is blocked.
  // Separators can come doubled: code writes Windows paths with escaped backslashes ("C:\\Users\\…\\.harv\\workspace").
  if ((changing || writesFile(shell) || bodies.length > 0) && mentions(isHarvData, /\.harv[\\/]+(?![\\/])(?!workspace([\\/"'\s]|$))/i)) {
    return verdict('blocked', "Blocked: Harv's database, backups and memory are only changed by Harv itself.", summary);
  }
  if (ctx.project) {
    const trusted = classifyInProject(command, summary, ctx.project, paths);
    if (trusted) return trusted;
  }
  if (ctx.attachedRoot) {
    const given = classifyInAttached(command, summary, ctx.attachedRoot, paths);
    if (given) return given;
  }

  const reason = RED_REASONS.find(([rule]) => matches(rule, shell))?.[1] ?? 'Runs a command that could change your PC.';
  return verdict(
    'red',
    reason,
    summary,
    paths.filter((p) => !isSystemDir(p) && !isProgramDir(p)),
  );
}

// ── Project chats: the project folder is trusted (the user's choice, docs/PLAN.md §6f) ──

/**
 * `pip install` for the whole PC: a bare `pip` / `python -m pip`, or one in a system folder.
 * A venv's own pip (`.venv/bin/pip`, `/tmp/carvenv/bin/python -m pip`) only fills that venv.
 */
export function installsPythonPackages(text: string): boolean {
  return splitCommand(text).some((segment) => {
    const ws = words(segment).map(unquote);
    const at = ws.findIndex((w) => !/^\w+=/.test(w) && !/^(sudo|env|time|nice)$/i.test(w));
    const program = ws[at] ?? '';
    const name = program
      .split(/[\\/]/)
      .at(-1)!
      .toLowerCase()
      .replace(/\.exe$/, '');
    const args = ws.slice(at + 1);
    const pipArgs = /^pip3?(\.\d+)?$/.test(name)
      ? args
      : /^(python3?(\.\d+)?|py)$/.test(name) && args[0] === '-m' && /^pip3?$/.test(args[1] ?? '')
        ? args.slice(2)
        : null;
    if (!pipArgs?.some((a) => /^(install|uninstall)$/i.test(a))) return false;
    if (/^sudo$/i.test(ws[0] ?? '') || !/[\\/]/.test(program)) return true;
    const where = fullPath(program);
    return isSystemDir(where) || isProgramDir(where);
  });
}

/** Still asked first inside a project. */
const PROJECT_RED: [Rule, string][] = [
  // A normal push runs (the user wants work pushed without asking); rewriting or deleting remote history asks.
  [/\bgit\s+push\b[^|;&\n]*(\s(-f|-d)\b|--force|--delete|--mirror|\s\+\S|\s:\S)/i, 'Rewrites or deletes history on the git remote.'],
  [/\bgit\s+(reset\s+--hard|clean\b|checkout\s+(--\s|\.(\s|$))|restore\s+(?!--staged))/i, 'Throws away uncommitted work.'],
  [
    /\b(npm|pnpm|yarn|bun)\s+(i|install|add|uninstall|remove|rm)\b[^|;&\n]*(\s-g\b|--global\b)/i,
    'Installs or removes software for the whole PC.',
  ],
  [/\b(winget|choco|scoop|msiexec)\b|\b(install|uninstall)-(module|package|script)\b/i, 'Installs or removes software for the whole PC.'],
  [installsPythonPackages, 'Installs or removes Python packages for the whole PC.'],
  [LINUX_INSTALL, 'Installs or removes software for the whole PC.'],
  [/(?<![\w.-])(taskkill|kill|pkill|killall|stop-process|spps)\b/i, 'Stops running programs.'],
  [/(?<![\w.-])reg\b(?!\s+(query|export)\b)|\bregedit\b|-itemproperty\b|\bhk(lm|cu|cr|u|cc):?\\/i, 'Changes the Windows registry.'],
  [/\b(netsh|sc|bcdedit|powercfg|schtasks|setx|set-service|set-executionpolicy|shutdown|reboot|poweroff)\b/i, 'Changes system settings.'],
  [LINUX_SYSTEM, 'Changes system settings.'],
  [/\b(runas|sudo|pkexec)\b|-verb\s+runas/i, 'Runs as administrator.'],
  [sendsData, 'Sends data over the network.'],
  [scriptSends, 'Sends data over the network (from a script).'],
  // `curl … | sh` runs whatever the server sends; `curl … | python3 -c '…'` only parses it with code from the command.
  [
    /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sudo\s+)?((sh|bash|zsh|iex|invoke-expression|pwsh|powershell)\b(?!\s+-c\b)|(python3?|node|ruby|perl)(\s+-)?\s*($|[|;&\n]))/i,
    'Runs a script straight from the internet.',
  ],
  [
    /\badb\b[^|;&\n]*\s(install|uninstall|push|reboot|root|remount|disable-verity|sideload|shell\s+(rm|pm\s+(uninstall|clear|disable\S*|install)|settings\s+put|setprop|reboot|am\s+force-stop|wipe|svc))\b/i,
    'Changes the connected Android device.',
  ],
];

/** Things whose effect Harv can't see from the command line: substitutions, variables in paths, nested shells. (`~/` is fine: `fullPath` resolves it.) */
const OPAQUE =
  /\$\(|`|\binvoke-expression\b|\biex\b|-encodedcommand|\s-enc\s|\$env:|%\w+%|\b(powershell|pwsh)(\.exe)?\s|\bcmd(\.exe)?\s+\/[ck]\b|\b(bash|sh)\s+-c\b|\|\s*(sh|bash|powershell|pwsh)\b/i;

/**
 * Every word of a command that looks like a path, resolved where it runs (existing or
 * not): a `cd` moves the base for what follows and counts as a place the command works in.
 */
function pathLikeWords(command: string, cwd: string): string[] {
  const out: string[] = [];
  let base = cwd;
  for (const segment of splitCommand(command)) {
    const ws = words(segment).map(unquote);
    if (/^(cd|chdir|set-location|sl|pushd)$/i.test(ws[0] ?? '')) {
      const target = ws.slice(1).find((w) => !w.startsWith('-'));
      if (target && target !== '-') {
        base = fullPath(target, base);
        out.push(base);
      }
      continue;
    }
    for (const raw of ws.slice(1)) {
      const word = raw.replace(/^-{1,2}[\w-]+[=:]/, '').replace(/^\d?>+&?/, '');
      if (!word || /:\/\//.test(word) || /\s/.test(word) || word.startsWith('-') || /^(\/dev\/null|\$null|nul)$/i.test(word)) continue;
      if (!/[\\/]/.test(word) && !word.startsWith('..') && !/^[a-z]:/i.test(word) && word !== '~') continue;
      out.push(fullPath(word, base));
    }
  }
  return out;
}

const DELETES = /\b(rm|rmdir|rd|del|erase|remove-item|ri|unlink|shred)\b|\s-delete\b/i;
/** Backed up before a project command that works outside the folder: small files only (a big folder named as a source isn't worth copying). */
const MAX_PROJECT_BACKUP = 10 * 1024 * 1024;
const smallFile = (p: string) => {
  const st = statSync(p, { throwIfNoEntry: false });
  return st?.isFile() === true && st.size <= MAX_PROJECT_BACKUP;
};

/**
 * A command in a project chat. Only the risky kinds ask (the user's choice, 2026-10-25):
 * dev work runs, inside the folder or outside it (outside, it's logged and the small
 * files it names are backed up first); deletes inside the project are backed up. Null
 * means it deletes outside the project or somewhere Harv can't tell, and the normal rules
 * decide (red). The temp folder is scratch space.
 */
export function classifyInProject(command: string, summary: string, project: string, existing: string[] = []): Verdict | null {
  const { shell, bodies } = splitHeredocs(command);
  const code = bodies.filter((b) => !DATA_RUNNERS.has(b.runner));
  const scriptText = codeOf(bodies);
  const risky = PROJECT_RED.find(([rule]) => matches(rule, shell) || (scriptText !== '' && matches(rule, scriptText)));
  if (risky)
    return verdict(
      'red',
      risky[1],
      summary,
      existing.filter((p) => isInside(p, project)),
    );
  const free = (p: string) => isInside(p, project) || isTempDir(p) || isInside(p, WORKSPACE) || isClaudeMemory(p);
  const scriptTargets = code.flatMap((b) =>
    SHELL_RUNNERS.has(b.runner) ? pathLikeWords(b.text, project) : scriptPaths(b.text).map((p) => fullPath(p, project)),
  );
  const targets = [...pathLikeWords(shell, project), ...scriptTargets, ...existing];
  const outside = targets.filter((p) => !free(p));
  const opaque = OPAQUE.test(shell);

  const deletes = DELETES.test(shell) || code.some((b) => DELETE_API.test(b.text) || (SHELL_RUNNERS.has(b.runner) && DELETES.test(b.text)));
  if (deletes) {
    // What a variable or a substitution deletes can't be checked, so it asks.
    // Only the deleting part counts: `for f in a b; do sed … $f.json` next to a `git rm` is fine.
    const deleting = splitCommand(shell).filter((segment) => DELETES.test(segment));
    if (outside.length > 0 || opaque || deleting.some((segment) => /\$(?!null\b)\{?\w/i.test(segment))) return null;
    return verdict(
      'yellow',
      'Deletes files in the project or the temp folder (backed up first, Undo brings them back).',
      summary,
      existing,
    );
  }
  // Installed programs' folders ask as before.
  if (outside.some(isProgramDir)) return null;
  if (outside.length === 0 && !opaque) return verdict('green', 'A normal command inside the project folder.', summary);
  const backups = [...new Set(outside)].filter((p) => !isSystemDir(p) && smallFile(p)).slice(0, 20);
  return verdict(
    'yellow',
    'Project work that also touches files outside the folder (logged; small files it names are backed up).',
    summary,
    backups,
  );
}

/**
 * A command working in a file or folder the user attached to the chat: trusted like a project
 * folder (the user's wish, 2026-10-26: "I give it to him willingly"), except there's no git to
 * undo with, so what runs there is yellow (logged, the files it names backed up first, Undo)
 * instead of green. The risky kinds still ask; deleting outside it is judged as usual (null).
 */
export function classifyInAttached(command: string, summary: string, root: string, existing: string[] = []): Verdict | null {
  const v = classifyInProject(command, summary, root, existing);
  if (!v || v.tier === 'red') return v;
  const inside = existing.filter((p) => isInside(p, root) && smallFile(p)).slice(0, 20);
  if (v.tier === 'green')
    return verdict('yellow', 'Works in what you attached (logged; the files it names are backed up).', summary, inside);
  if (DELETES.test(command))
    return verdict('yellow', 'Deletes inside what you attached (backed up first, Undo brings it back).', summary, v.targets);
  return verdict(
    'yellow',
    'Works in what you attached and touches files outside it (logged; small files it names are backed up).',
    summary,
    v.targets,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
