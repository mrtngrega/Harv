import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tier } from '@harv/shared';
import { isHarvData, isInside, isProgramDir, isWindowsDir, loadSettings, toWindowsPath, WORKSPACE } from './paths.ts';

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

/** Built-in tools Harv may use; anything else is refused. */
export const SHELL_TOOLS = ['Bash', 'PowerShell'];
export const FILE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch'];
/**
 * Claude Code's own bookkeeping tools in project chats: task lists, subagents (whose
 * tool calls pass the gate themselves), plan mode, watching or stopping a shell Harv
 * started in the background.
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
  // Skills and slash commands only load instructions; what they then do is checked tool by tool.
  'Skill',
  'SlashCommand',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];
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
  sensitive(String.raw`\.(pem|key|pfx|p12|kdbx|ppk|ovpn|jks|keystore)END`),
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
];

const verdict = (tier: Tier, reason: string, summary: string, targets: string[] = []): Verdict => ({ tier, reason, summary, targets });

const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(p)) && !isClaudeMemory(p) && !isClaudeToolResult(p);
}

/**
 * Claude Code's project memory notes (~/.claude/projects/<folder>/memory/*.md). Project
 * chats share them with Claude Code, so they're allowed although they're under .claude.
 */
export function isClaudeMemory(p: string): boolean {
  const path = toWindowsPath(p);
  return isInside(path, join(homedir(), '.claude', 'projects')) && /[\\/]memory[\\/][^\\/]+\.md$|[\\/]memory[\\/]?$/i.test(path);
}

/**
 * Where the SDK saves a tool's output that was too big for the chat
 * (~/.claude/projects/<folder>/<session>/tool-results/…). Harv is told to read it there,
 * so blocking it left Harv stuck.
 */
export function isClaudeToolResult(p: string): boolean {
  const path = toWindowsPath(p);
  return isInside(path, join(homedir(), '.claude', 'projects')) && /[\\/][0-9a-f-]{36}[\\/]tool-results([\\/][^\\/]+)?[\\/]?$/i.test(path);
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
}

/** Claude Code's project memory folders and saved tool outputs named in a command (allowed, although they're under .claude). */
const CLAUDE_ALLOWED_IN_COMMAND = /\S*\.claude[\\/]projects[\\/][^\s"'\\/]+[\\/](memory\b|[0-9a-f-]{36}[\\/]tool-results\b)[^\s"']*/gi;
/** The command with those allowed .claude paths taken out (unless they climb out with `..`). */
const withoutAllowedClaude = (command: string) => command.replace(CLAUDE_ALLOWED_IN_COMMAND, (m) => (m.includes('..') ? m : ' '));

/** The registered project a command works in: it starts with `cd`/`Set-Location`/`pushd` (or `git -C`) into one. */
export function projectOfCommand(command: string, projects: string[]): string | undefined {
  const [first = ''] = splitCommand(command);
  const ws = words(first).map(unquote);
  const cmd = (ws[0] ?? '').toLowerCase();
  let target: string | undefined;
  if (['cd', 'chdir', 'set-location', 'sl', 'pushd'].includes(cmd)) target = ws.slice(1).find((w) => !w.startsWith('-'));
  else if (cmd === 'git' && ws[1] === '-C') target = ws[2];
  if (!target || /[$`%*?]/.test(target)) return undefined;
  const path = toWindowsPath(target);
  return projects.find((p) => isInside(path, p));
}

export function classify(tool: string, input: Record<string, unknown>, ctx: ClassifyContext = {}): Verdict {
  if (HARV_TOOLS.includes(tool)) return verdict('green', "Harv's own memory and chat tools.", tool.replace('mcp__harv__', ''));
  // Only project chats get Claude Code's agent tools; assistant chats never have them.
  if (AGENT_TOOLS.includes(tool) && ctx.project)
    return verdict('green', 'Planning and bookkeeping; anything it runs is checked on its own.', tool);

  if (READ_TOOLS.includes(tool)) {
    const paths = ['file_path', 'path', 'pattern', 'glob'].map((k) => str(input, k)).filter(Boolean);
    const secret = paths.find(isSensitivePath);
    if (secret) return verdict('blocked', `${secret} may contain credentials or secrets, which Harv never reads.`, `read ${secret}`);
    return verdict('green', 'Reading and searching is always allowed.', `${tool} ${paths[0] ?? str(input, 'query') ?? str(input, 'url')}`);
  }

  if (FILE_WRITE_TOOLS.includes(tool)) {
    const file = str(input, 'file_path') || str(input, 'notebook_path');
    const inProject = ctx.project ?? (file ? ctx.projects?.find((p) => isInside(toWindowsPath(file), p)) : undefined);
    return classifyFileWrite(tool, file, { ...ctx, project: inProject });
  }

  if (SHELL_TOOLS.includes(tool)) {
    const command = str(input, 'command');
    const inProject = ctx.project ?? projectOfCommand(command, ctx.projects ?? []);
    return classifyCommand(command, str(input, 'description'), {
      ...ctx,
      project: inProject,
      shell: tool === 'PowerShell' ? 'powershell' : 'bash',
    });
  }

  if (tool.startsWith('mcp__') && ctx.project) return classifyMcp(tool);

  return verdict('blocked', `${tool} isn't one of Harv's tools.`, tool);
}

/** Connector tools that only look things up. */
const MCP_READ = /^(get|list|read|search|query|fetch|find|guide|describe|view|lookup|export|status)([_-]|$)/i;
/** The user's own private Claude Docs on claude.ai: writing there touches nothing outside their account. */
const PRIVATE_MCP = /^claude_ai_Claude_Docs$/i;

/**
 * A tool from an MCP server a project chat loads (the user's claude.ai connectors, a project's
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
  const path = toWindowsPath(rawPath, ctx.project);
  const verb = tool === 'Write' ? (existsSync(path) ? 'overwrite' : 'create') : 'edit';
  const summary = `${verb} ${path}`;
  const protectedDir = loadSettings().protectedPaths.find((p) => isInside(path, p));
  if (protectedDir) return verdict('blocked', `${protectedDir} is on your read-only list.`, summary);
  if (isSensitivePath(path)) return verdict('blocked', 'That file may hold credentials or secrets.', summary);
  if (isWindowsDir(path)) return verdict('blocked', 'Harv never writes inside the Windows folder.', summary);
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
    /\bformat(\.com)?\s+[a-z]:|\b(format-volume|clear-disk|initialize-disk|remove-partition)\b|\bdiskpart\b|\bmkfs\b/i,
    'formats or wipes a drive',
  ],
  [
    /set-mppreference\b.*-disable|add-mppreference\b.*exclusion|\b(sc(\.exe)?|stop-service|set-service)\b.*\b(windefend|mpssvc|wscsvc|sense)\b/i,
    'turns off antivirus protection',
  ],
  [
    /set-netfirewallprofile\b.*-enabled\s+\$?(false|0)|netsh\s+(advfirewall\s+set\b.*\bstate\s+off|firewall\s+set\s+opmode\s+disable)|\b(remove|disable)-netfirewallrule\b|netsh\s+advfirewall\s+firewall\s+delete/i,
    'turns off or removes firewall protection',
  ],
  [
    /\bcmdkey\b|\bvaultcmd\b|get-storedcredential|\bmimikatz\b|\blsass\b|reg(\.exe)?\s+save\s+hklm\\(sam|security|system)|\.credentials\.json|\bwlan\s+show\s+prof\w*\b.*\bkey\s*=\s*clear|protecteddata|\bunprotect\(|hklm[\\:]+(sam|security)\b/i,
    'reads stored credentials',
  ],
];

/** Commands that only read or show information. */
const GREEN_COMMANDS = new Set(
  (
    'ls dir pwd cd echo cat type head tail wc grep rg findstr which where where.exe whoami hostname date uname df du file stat tree sort uniq cut ' +
    'tasklist systeminfo ipconfig ping nslookup tracert netstat nvidia-smi ver get-date ' +
    'select-object select where-object ? sort-object format-table ft format-list fl measure-object measure select-string sls test-path resolve-path ' +
    'split-path join-path out-string out-host write-output write-host convertto-json convertfrom-json compare-object group-object gci gc gps gsv gl gi'
  ).split(' '),
);
const GREEN_GIT = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'blame', 'remote', 'branch', 'tag', 'describe']);

/** Words that change something, wherever they appear in a command. */
const CHANGING_WORDS = new Set(
  (
    'rm rmdir rd del erase mv move cp copy xcopy robocopy ren rename mkdir md touch chmod chown ln kill taskkill pkill shutdown reg regedit sc net netsh ' +
    'schtasks wmic msiexec winget choco scoop npm npx pnpm yarn pip pip3 curl wget powershell pwsh cmd bash sh python python3 py node deno bun start ' +
    'sudo runas iex icacls takeown attrib cipher bcdedit powercfg setx tee dd sed awk perl ruby git -exec -delete -ok'
  ).split(' '),
);
const CHANGING_CMDLET =
  /\b(remove|set|new|add|clear|stop|start|restart|install|uninstall|move|rename|copy|invoke|enable|disable|register|unregister|update|export|import|reset|suspend|resume|mount|dismount|initialize|expand|compress|send|publish|grant|revoke|block|unblock|lock|unlock|protect|unprotect|restore|backup|save|submit|edit|merge|push|pop|out-file)-[a-z]+\b|\b(write|format)-(?!output\b|host\b|table\b|list\b|wide\b|custom\b)[a-z]+\b/i;

/** Red-action categories, for a clear reason on the approval card. */
const RED_REASONS: [RegExp, string][] = [
  [/\b(rm|rmdir|rd|del|erase|remove-item|ri)\b/i, 'Deletes files or folders.'],
  [
    /\b(winget|choco|scoop|msiexec)\b|\b(npm|pnpm|yarn|pip3?)\s+(i|install|add|uninstall|remove)\b|\b(install|uninstall)-\w+/i,
    'Installs or uninstalls software.',
  ],
  [/\b(taskkill|kill|pkill|stop-process|spps)\b/i, 'Stops running programs.'],
  [/\b(reg|regedit)\b|-itemproperty\b|\bhk(lm|cu|cr|u|cc):?\\/i, 'Changes the Windows registry.'],
  [/\b(netsh|sc|bcdedit|powercfg|schtasks|setx|set-service|set-netadapter|set-executionpolicy)\b/i, 'Changes system settings.'],
  [/\bgit\s+push\b/i, 'Pushes to a git remote.'],
  [
    /send-mailmessage|\bcurl\b.*\s-(d|f|x\s*post|-data)|invoke-(webrequest|restmethod)\b.*-method\s+(post|put|delete)/i,
    'Sends data over the network.',
  ],
  [/\b(mv|move|ren|rename|move-item|rename-item|cp|copy|xcopy|robocopy|copy-item)\b/i, 'Moves, renames or copies files.'],
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
      if (!/[\\/.]/.test(word) && !existsSync(toWindowsPath(word, cwd))) continue;
      const path = toWindowsPath(word, cwd);
      if (existsSync(path)) out.add(path);
    }
  }
  return [...out];
}

/** `start notepad`, `Start-Process https://…`, `explorer C:\…`: opening an app, page or document. */
function isOpenApp(segment: string): boolean {
  const [first = '', ...rest] = words(segment).map(unquote);
  const cmd = first.toLowerCase();
  if (!['start', 'start-process', 'saps', 'invoke-item', 'ii', 'explorer', 'explorer.exe', 'notepad', 'calc', 'code'].includes(cmd))
    return false;
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
      const path = toWindowsPath(target, cwd);
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
  if (folders.some(isWindowsDir)) return verdict('blocked', 'Blocked: Harv never changes the Windows folder.', summary);
  if (folders.some(isHarvData))
    return verdict('blocked', "Blocked: Harv's database, backups and memory are only changed by Harv itself.", summary);
  if (folders.every((f) => isInside(f, WORKSPACE))) return verdict('green', "Inside Harv's own workspace.", summary);
  if (project && folders.every((f) => isInside(f, project))) return verdict('green', 'Inside the project folder.', summary);
  if (folders.some(isProgramDir)) return verdict('red', 'It changes an installed program’s folder.', summary, folders);
  return verdict('yellow', 'Creates new folders.', summary, folders);
}

function isGreenSegment(segment: string): boolean {
  const ws = words(segment).map(unquote);
  const first = (ws[0] ?? '').toLowerCase();
  if (first === 'git')
    return GREEN_GIT.has((ws[1] ?? '').toLowerCase()) && !/\s-(d|D|m|M)\b|--delete|set-url|\badd\b|\bremove\b/.test(segment);
  if (first === 'nvidia-smi')
    return !/\s-(pl|r|ac|lgc|pm|rac)\b|--(power-limit|gpu-reset|applications-clocks|lock-gpu-clocks)/i.test(segment);
  if (first === 'ipconfig') return !/\/(release|renew)/i.test(segment);
  if (first === 'find') return !/-(delete|exec|execdir|ok|fprint)/.test(segment);
  // Printing lines (`sed -n '5,20p' file`); anything else sed can do may write.
  if (first === 'sed') return /^sed\s+-n\s+(["']?)[\d,$;p]+\1(\s|$)/.test(segment) && !/\s(-i|--in-place)/.test(segment);
  if (/^get-[a-z]+$/.test(first)) return !/get-(credential|storedcredential)/.test(first);
  return GREEN_COMMANDS.has(first);
}

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
  if (SENSITIVE_PATHS.some((re) => re.test(withoutAllowedClaude(command).replace(/["']/g, ' ')))) {
    return verdict('blocked', 'Blocked: it touches files that may hold credentials or secrets.', summary);
  }

  const segments = splitCommand(command);
  const substitutes = /\$\(|`|\binvoke-expression\b|\biex\b|-encodedcommand|\s-enc\s/i.test(command);
  const tokens = segments.flatMap((s) => words(s).map((w) => unquote(w).toLowerCase()));
  const changing = tokens.some((t) => CHANGING_WORDS.has(t)) || CHANGING_CMDLET.test(command);

  // git's read-only subcommands and `sed -n` are fine although "git" and "sed" are on the changing list.
  const readOnly = (segment: string) => {
    const ws = words(segment).map((w) => unquote(w).toLowerCase());
    if (isReadOnlyProgram(ws[0] ?? '', ws.slice(1))) return true;
    if (!isGreenSegment(segment)) return false;
    return ['git', 'sed'].includes(ws[0] ?? '') || !ws.some((t) => CHANGING_WORDS.has(t));
  };

  if (!substitutes && !writesFile(command) && segments.length > 0) {
    if (segments.length === 1 && isOpenApp(segments[0]!)) return verdict('green', 'Opens an app, page or document.', summary);
    if (segments.every(readOnly) && !CHANGING_CMDLET.test(command)) return verdict('green', 'Only reads information.', summary);
  }
  if (ctx.shell === 'powershell' && !writesFile(command) && isReadOnlyPowerShell(command)) {
    return verdict('green', 'Only reads information.', summary);
  }

  const folders = newFolders(command, cwd);
  if (folders) return classifyNewFolders(folders, summary, ctx.project);

  const paths = pathsInCommand(command, cwd);
  const settings = loadSettings();
  const mentions = (test: (p: string) => boolean, pattern: RegExp) => paths.some(test) || pattern.test(command);
  const protectedDir = settings.protectedPaths.find((dir) => mentions((p) => isInside(p, dir), new RegExp(escapeRegExp(dir), 'i')));
  if (protectedDir) return verdict('blocked', `Blocked: it would change ${protectedDir}, which is on your read-only list.`, summary);
  if (mentions(isWindowsDir, /\b[a-z]:[\\/]windows\b|\/c\/windows\b|%windir%|%systemroot%|\$env:(windir|systemroot)/i)) {
    return verdict('blocked', 'Blocked: Harv never changes the Windows folder.', summary);
  }
  // Reading Harv's logs or settings is fine; anything that could change them is blocked.
  if ((changing || writesFile(command)) && mentions(isHarvData, /\.harv[\\/](?!workspace)/i)) {
    return verdict('blocked', "Blocked: Harv's database, backups and memory are only changed by Harv itself.", summary);
  }
  if (ctx.project) {
    const trusted = classifyInProject(command, summary, ctx.project, paths);
    if (trusted) return trusted;
  }

  const reason = RED_REASONS.find(([re]) => re.test(command))?.[1] ?? 'Runs a command that could change your PC.';
  return verdict(
    'red',
    reason,
    summary,
    paths.filter((p) => !isWindowsDir(p) && !isProgramDir(p)),
  );
}

// ── Project chats: the project folder is trusted (the user's choice, docs/PLAN.md §6f) ──

/** Still asked first inside a project. */
const PROJECT_RED: [RegExp, string][] = [
  // A normal push runs (the user wants work pushed without asking); rewriting or deleting remote history asks.
  [/\bgit\s+push\b[^|;&\n]*(\s(-f|-d)\b|--force|--delete|--mirror|\s\+\S|\s:\S)/i, 'Rewrites or deletes history on the git remote.'],
  [/\bgit\s+(reset\s+--hard|clean\b|checkout\s+(--\s|\.(\s|$))|restore\s+(?!--staged))/i, 'Throws away uncommitted work.'],
  [
    /\b(npm|pnpm|yarn|bun)\s+(i|install|add|uninstall|remove|rm)\b[^|;&\n]*(\s-g\b|--global\b)/i,
    'Installs or removes software for the whole PC.',
  ],
  [
    /\b(winget|choco|scoop|msiexec)\b|\bpip3?\s+(install|uninstall)\b|\b(install|uninstall)-(module|package|script)\b/i,
    'Installs or removes software for the whole PC.',
  ],
  [/\b(taskkill|kill|pkill|stop-process|spps)\b/i, 'Stops running programs.'],
  [/\b(reg|regedit)\b|-itemproperty\b|\bhk(lm|cu|cr|u|cc):?\\/i, 'Changes the Windows registry.'],
  [/\b(netsh|sc|bcdedit|powercfg|schtasks|setx|set-service|set-executionpolicy|shutdown)\b/i, 'Changes system settings.'],
  [/\b(runas|sudo)\b|-verb\s+runas/i, 'Runs as administrator.'],
  [
    /send-mailmessage|\bcurl\b.*\s-(d|f|x\s*post|-data)|invoke-(webrequest|restmethod)\b.*-method\s+(post|put|delete)/i,
    'Sends data over the network.',
  ],
];

/** Things whose effect Harv can't see from the command line: substitutions, variables in paths, nested shells. */
const OPAQUE =
  /\$\(|`|\binvoke-expression\b|\biex\b|-encodedcommand|\s-enc\s|\$env:|%\w+%|(^|[\s"'=])~[\\/]|\b(powershell|pwsh)(\.exe)?\s|\bcmd(\.exe)?\s+\/[ck]\b|\b(bash|sh)\s+-c\b|\|\s*(sh|bash|powershell|pwsh)\b/i;

/** Every word of a command that looks like a path, resolved against the project folder (existing or not). */
function pathLikeWords(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const segment of splitCommand(command)) {
    for (const raw of words(segment).slice(1)) {
      const word = unquote(raw).replace(/^-{1,2}[\w-]+[=:]/, '');
      if (!word || /:\/\//.test(word) || /\s/.test(word) || word.startsWith('-')) continue;
      if (!/[\\/]/.test(word) && !word.startsWith('..') && !/^[a-z]:/i.test(word)) continue;
      out.push(toWindowsPath(word.replace(/^>+/, ''), cwd));
    }
  }
  return out;
}

/**
 * A command in a project chat: normal dev work inside the folder runs (deletes are
 * backed up first); the risky kinds still ask. Null means "not clearly inside the
 * project", and the normal rules decide (usually red).
 */
export function classifyInProject(command: string, summary: string, project: string, existing: string[] = []): Verdict | null {
  const risky = PROJECT_RED.find(([re]) => re.test(command));
  if (risky)
    return verdict(
      'red',
      risky[1],
      summary,
      existing.filter((p) => isInside(p, project)),
    );
  if (OPAQUE.test(command)) return null;
  const targets = [...pathLikeWords(command, project), ...existing];
  if (targets.some((p) => !isInside(p, project))) return null;
  if (/\b(rm|rmdir|rd|del|erase|remove-item|ri)\b/i.test(command)) {
    return verdict('yellow', 'Deletes files inside the project (backed up first, Undo brings them back).', summary, existing);
  }
  return verdict('green', 'A normal command inside the project folder.', summary);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
