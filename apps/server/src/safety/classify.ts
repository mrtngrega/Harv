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
export const AGENT_TOOLS = ['TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode', 'BashOutput', 'KillShell', 'KillBash'];
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
  return SENSITIVE_PATHS.some((re) => re.test(p)) && !isClaudeMemory(p);
}

/**
 * Claude Code's project memory notes (~/.claude/projects/<folder>/memory/*.md). Project
 * chats share them with Claude Code, so they're allowed although they're under .claude.
 */
export function isClaudeMemory(p: string): boolean {
  const path = toWindowsPath(p);
  return isInside(path, join(homedir(), '.claude', 'projects')) && /[\\/]memory[\\/][^\\/]+\.md$|[\\/]memory[\\/]?$/i.test(path);
}

/** Where a call runs: in a project chat, the project folder (trusted, and the base for relative paths). */
export interface ClassifyContext {
  project?: string;
  /**
   * Every registered project folder. Any chat working inside one gets the project's
   * trust (a command that starts with `cd <project>`, or a file in it).
   */
  projects?: string[];
}

/** Claude Code's project memory folders named in a command (allowed, although they're under .claude). */
const CLAUDE_MEMORY_IN_COMMAND = /\S*\.claude[\\/]projects[\\/][^\s"'\\/]+[\\/]memory\b[^\s"']*/gi;

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
    return classifyCommand(command, str(input, 'description'), { ...ctx, project: inProject });
  }

  return verdict('blocked', `${tool} isn't one of Harv's tools.`, tool);
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
  const cwd = ctx.project ?? WORKSPACE;
  const summary = description || command.split(/\r?\n/)[0]!.slice(0, 120);
  for (const [re, what] of BLOCKED_COMMANDS) {
    if (re.test(command)) return verdict('blocked', `Blocked: this ${what}. Only you can unblock that, in Harv's settings.`, summary);
  }
  if (SENSITIVE_PATHS.some((re) => re.test(command.replace(CLAUDE_MEMORY_IN_COMMAND, ' ').replace(/["']/g, ' ')))) {
    return verdict('blocked', 'Blocked: it touches files that may hold credentials or secrets.', summary);
  }

  const segments = splitCommand(command);
  const substitutes = /\$\(|`|\binvoke-expression\b|\biex\b|-encodedcommand|\s-enc\s/i.test(command);
  const tokens = segments.flatMap((s) => words(s).map((w) => unquote(w).toLowerCase()));
  const changing = tokens.some((t) => CHANGING_WORDS.has(t)) || CHANGING_CMDLET.test(command);

  // git's read-only subcommands and `sed -n` are fine although "git" and "sed" are on the changing list.
  const readOnly = (segment: string) => {
    if (!isGreenSegment(segment)) return false;
    const ws = words(segment).map((w) => unquote(w).toLowerCase());
    return ['git', 'sed'].includes(ws[0] ?? '') || !ws.some((t) => CHANGING_WORDS.has(t));
  };

  if (!substitutes && !writesFile(command) && segments.length > 0) {
    if (segments.length === 1 && isOpenApp(segments[0]!)) return verdict('green', 'Opens an app, page or document.', summary);
    if (segments.every(readOnly) && !CHANGING_CMDLET.test(command)) return verdict('green', 'Only reads information.', summary);
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
  [/\bgit\s+push\b/i, 'Pushes to a git remote.'],
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
