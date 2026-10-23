import { existsSync } from 'node:fs';
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
export const FILE_WRITE_TOOLS = ['Write', 'Edit'];
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
export const HARV_TOOLS = ['mcp__harv__remember', 'mcp__harv__forget', 'mcp__harv__list_chats', 'mcp__harv__read_chat'];
export const ENABLED_TOOLS = [...READ_TOOLS, ...FILE_WRITE_TOOLS, ...SHELL_TOOLS];

const SENSITIVE_PATHS: RegExp[] = [
  /(^|[\\/])\.claude([\\/]|$)/i, // Claude Code login and settings
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.env(\.[\w.-]+)?$/i,
  /credential/i,
  /(^|[\\/])(id_rsa|id_ed25519)/i,
  /\.(pem|key|pfx|p12|kdbx)$/i,
];

const verdict = (tier: Tier, reason: string, summary: string, targets: string[] = []): Verdict => ({ tier, reason, summary, targets });

const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(p));
}

export function classify(tool: string, input: Record<string, unknown>): Verdict {
  if (HARV_TOOLS.includes(tool)) return verdict('green', "Harv's own memory and chat tools.", tool.replace('mcp__harv__', ''));

  if (READ_TOOLS.includes(tool)) {
    const paths = ['file_path', 'path', 'pattern', 'glob'].map((k) => str(input, k)).filter(Boolean);
    const secret = paths.find(isSensitivePath);
    if (secret) return verdict('blocked', `${secret} may contain credentials or secrets, which Harv never reads.`, `read ${secret}`);
    return verdict('green', 'Reading and searching is always allowed.', `${tool} ${paths[0] ?? str(input, 'query') ?? str(input, 'url')}`);
  }

  if (FILE_WRITE_TOOLS.includes(tool)) return classifyFileWrite(tool, str(input, 'file_path'));

  if (SHELL_TOOLS.includes(tool)) return classifyCommand(str(input, 'command'), str(input, 'description'));

  return verdict('blocked', `${tool} isn't one of Harv's tools.`, tool);
}

function classifyFileWrite(tool: string, rawPath: string): Verdict {
  const path = toWindowsPath(rawPath);
  const verb = tool === 'Edit' ? 'edit' : existsSync(path) ? 'overwrite' : 'create';
  const summary = `${verb} ${path}`;
  const protectedDir = loadSettings().protectedPaths.find((p) => isInside(path, p));
  if (protectedDir) return verdict('blocked', `${protectedDir} is on your read-only list.`, summary);
  if (isSensitivePath(path)) return verdict('blocked', 'That file may hold credentials or secrets.', summary);
  if (isWindowsDir(path)) return verdict('blocked', 'Harv never writes inside the Windows folder.', summary);
  if (isHarvData(path)) return verdict('blocked', "Harv's database, backups and memory are only changed by Harv itself.", summary);
  if (isInside(path, WORKSPACE)) return verdict('green', "Inside Harv's own workspace.", summary);
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
    /\bcmdkey\b|\bvaultcmd\b|get-storedcredential|\bmimikatz\b|\blsass\b|reg(\.exe)?\s+save\s+hklm\\(sam|security|system)|\.credentials\.json/i,
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

/** The parts of a command chain: `a && b; c | d` → [a, b, c, d]. Quotes aren't parsed, which only errs towards red. */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n\r]/)
    .map((s) => s.trim())
    .filter(Boolean);
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
  if (!['start', 'start-process', 'saps', 'explorer', 'explorer.exe', 'notepad', 'calc', 'code'].includes(cmd)) return false;
  if (/-verb\s+runas|-credential|-argumentlist/i.test(segment)) return false;
  const target = rest.filter((w) => !w.startsWith('-') && w !== '""')[0] ?? '';
  if (/^https?:\/\//i.test(target)) return true;
  if (EXECUTABLE.test(target)) return false;
  // A bare app name (no folder) or a document/folder path.
  return true;
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
  if (/^get-[a-z]+$/.test(first)) return !/get-(credential|storedcredential)/.test(first);
  return GREEN_COMMANDS.has(first);
}

/** Redirection into a file (`> out.txt`), ignoring harmless `2>&1` and `> $null`. */
const writesFile = (command: string) => />/.test(command.replace(/\d?>\s*(&\d|\$null|\/dev\/null|nul\b)/gi, ''));

export function classifyCommand(command: string, description = ''): Verdict {
  const summary = description || command.split(/\r?\n/)[0]!.slice(0, 120);
  for (const [re, what] of BLOCKED_COMMANDS) {
    if (re.test(command)) return verdict('blocked', `Blocked: this ${what}. Only you can unblock that, in Harv's settings.`, summary);
  }
  if (SENSITIVE_PATHS.some((re) => re.test(command.replace(/["']/g, ' ')))) {
    return verdict('blocked', 'Blocked: it touches files that may hold credentials or secrets.', summary);
  }

  const segments = splitCommand(command);
  const substitutes = /\$\(|`|\binvoke-expression\b|\biex\b|-encodedcommand|\s-enc\s/i.test(command);
  const tokens = segments.flatMap((s) => words(s).map((w) => unquote(w).toLowerCase()));
  const changing = tokens.some((t) => CHANGING_WORDS.has(t)) || CHANGING_CMDLET.test(command);

  if (!substitutes && !writesFile(command) && segments.length > 0) {
    if (segments.length === 1 && isOpenApp(segments[0]!)) return verdict('green', 'Opens an app, page or document.', summary);
    if (!changing && segments.every(isGreenSegment)) return verdict('green', 'Only reads information.', summary);
    // git's read-only subcommands are fine even though "git" is on the changing list.
    if (segments.every((s) => /^git\s/i.test(s) && isGreenSegment(s)) && !CHANGING_CMDLET.test(command)) {
      return verdict('green', 'Only reads information.', summary);
    }
  }

  const paths = pathsInCommand(command);
  const settings = loadSettings();
  const mentions = (test: (p: string) => boolean, pattern: RegExp) => paths.some(test) || pattern.test(command);
  const protectedDir = settings.protectedPaths.find((dir) => mentions((p) => isInside(p, dir), new RegExp(escapeRegExp(dir), 'i')));
  if (protectedDir) return verdict('blocked', `Blocked: it would change ${protectedDir}, which is on your read-only list.`, summary);
  if (mentions(isWindowsDir, /\b[a-z]:[\\/]windows\b|\/c\/windows\b|%windir%|%systemroot%|\$env:(windir|systemroot)/i)) {
    return verdict('blocked', 'Blocked: Harv never changes the Windows folder.', summary);
  }
  if (mentions(isHarvData, /\.harv[\\/](?!workspace)/i)) {
    return verdict('blocked', "Blocked: Harv's database, backups and memory are only changed by Harv itself.", summary);
  }

  const reason = RED_REASONS.find(([re]) => re.test(command))?.[1] ?? 'Runs a command that could change your PC.';
  return verdict(
    'red',
    reason,
    summary,
    paths.filter((p) => !isWindowsDir(p) && !isProgramDir(p)),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
