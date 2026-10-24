import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, type IPty } from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';
import { IS_WINDOWS } from '../platform.ts';

/** PowerShell on Windows; the user's own shell (bash on Fedora) elsewhere. */
const DEFAULT_SHELL = IS_WINDOWS ? 'powershell.exe' : process.env.SHELL || '/bin/bash';

// A CommonJS package: its Terminal comes off the default export.
const { Terminal: Screen } = xtermHeadless;
type Screen = InstanceType<typeof Screen>;

/** Output kept per terminal, so a reloaded dashboard can show what was there. */
const SCROLLBACK_CHARS = 200_000;
/** Lines of text saved per terminal for after a restart. */
const SAVED_LINES = 2000;
/** How often changed terminals are saved, so even a power cut loses little. */
const SAVE_EVERY_MS = 10_000;

interface Terminal {
  pty: IPty;
  /** Everything the shell printed, sent to a dashboard that attaches. */
  buffer: string;
  /** The same output rendered as a screen, for saving plain text and the folder. */
  screen: Screen;
  /** Lines restored from before a restart (with their divider), shown above the shell and kept in the next save. */
  restored: string[];
  /** When the restored lines were saved; kept if the new shell gets nothing worth saving. */
  restoredAt: number;
  exited: boolean;
  dirty: boolean;
}

/** What a dashboard shows when it attaches. */
export interface TerminalReplay {
  /** Plain lines from before a restart (ending with a divider), shown in grey above the shell. */
  restored: string[];
  /** Everything the new shell printed. */
  data: string;
}

interface Saved {
  cwd?: string;
  at: number;
}

export interface TerminalEvents {
  data: (id: string, data: string) => void;
  exit: (id: string, code: number) => void;
}

/** The folder of the last PowerShell prompt ("PS C:\Users\me> ") in some screen lines. */
export function promptFolder(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^PS ([A-Za-z]:\\[^>]*)>/.exec(lines[i]!);
    if (m) return m[1]!.trimEnd();
  }
  return undefined;
}

/** The old lines plus a divider saying when they're from: what a restored terminal shows above the new shell. */
export function restoredLines(lines: string[], at: number, shell = DEFAULT_SHELL): string[] {
  const when = new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const name = /powershell|pwsh/i.test(shell) ? 'PowerShell' : basename(shell);
  return [...lines, `── restored from ${when} · new ${name} below ──`].slice(-SAVED_LINES);
}

/** True when the shell printed nothing but prompts (nothing was typed), so there's nothing new to keep. */
export function onlyPrompts(lines: string[]): boolean {
  // PowerShell's "PS C:\…> ", or a bash/zsh prompt ending in $, # or % ("[me@host ~]$ ").
  return lines.every((l) => !l.trim() || /^PS [A-Za-z]:\\[^>]*>\s*$/.test(l) || (!IS_WINDOWS && /^\S.*[$#%]\s*$/.test(l)));
}

/** A shell command that moves to `folder`, in the shell's own syntax. */
export function cdCommand(shell: string, folder: string): string {
  if (/powershell|pwsh/i.test(shell)) return `Set-Location -LiteralPath '${folder.replace(/'/g, "''")}'`;
  return `cd -- '${folder.replace(/'/g, `'\\''`)}'`;
}

/**
 * The user's own terminals, one per chat that opens one: PowerShell in a real
 * pseudo-terminal (ConPTY). What the user types here is theirs, so it doesn't
 * pass Harv's safety gate; Harv itself never writes to these terminals.
 * Each one's text and folder are saved to ~/.harv/terminals, so after a
 * restart it comes back as a fresh PowerShell in the same folder with the old
 * output above it.
 */
export class TerminalManager {
  private terms = new Map<string, Terminal>();
  private timer: NodeJS.Timeout;

  constructor(
    private events: TerminalEvents,
    private dir: string,
    /** Where a new terminal opens when nothing else says (its chat's project, or the user's default folder). */
    private defaultCwd: (id: string) => string | undefined = () => undefined,
    private shell = DEFAULT_SHELL,
  ) {
    mkdirSync(dir, { recursive: true });
    this.timer = setInterval(() => this.saveAll(), SAVE_EVERY_MS);
    this.timer.unref();
  }

  static validId(id: string): boolean {
    return /^terminal-[\w-]{1,64}$/.test(id);
  }

  private files(id: string) {
    return { log: join(this.dir, `${id}.log`), meta: join(this.dir, `${id}.json`) };
  }

  /** Starts the terminal if it isn't running (in `cwd`, else where it was last time) and returns everything to show. */
  attach(id: string, cwd?: string, cols = 100, rows = 30): TerminalReplay | undefined {
    if (!TerminalManager.validId(id)) return undefined;
    const running = this.terms.get(id);
    if (running && running.exited && cwd) {
      // "Open in Terminal" on a shell that has exited: start a fresh one there.
      this.terms.delete(id);
      this.kill(running);
    } else if (running) {
      // "Open in Terminal" on a running shell: move it to that folder.
      if (cwd && existsSync(cwd)) running.pty.write(`${cdCommand(this.shell, cwd)}\r`);
      return { restored: running.restored, data: running.buffer };
    }

    const { log, meta } = this.files(id);
    let restored: string[] = [];
    let restoredAt = Date.now();
    let start = cwd && existsSync(cwd) ? cwd : undefined;
    try {
      if (existsSync(meta) && existsSync(log)) {
        const saved = JSON.parse(readFileSync(meta, 'utf8')) as Saved;
        const lines = readFileSync(log, 'utf8').split('\n');
        if (lines.some((l) => l.trim())) {
          restored = restoredLines(lines, saved.at, this.shell);
          restoredAt = saved.at;
        }
        if (!start && saved.cwd && existsSync(saved.cwd)) start = saved.cwd;
      }
    } catch {
      // A damaged save just means a fresh terminal.
    }

    const pty = spawn(this.shell, /powershell|pwsh/i.test(this.shell) ? ['-NoLogo'] : [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: start ?? this.defaultCwd(id) ?? homedir(),
      // Harv's environment already has the API credentials stripped (env.ts).
      env: process.env as Record<string, string>,
    });
    const screen = new Screen({ cols, rows, scrollback: SAVED_LINES, allowProposedApi: true });
    const term: Terminal = { pty, buffer: '', screen, restored, restoredAt, exited: false, dirty: false };
    this.terms.set(id, term);
    pty.onData((data) => {
      term.buffer = (term.buffer + data).slice(-SCROLLBACK_CHARS);
      term.screen.write(data);
      term.dirty = true;
      this.events.data(id, data);
    });
    pty.onExit(({ exitCode }) => {
      term.exited = true;
      this.events.exit(id, exitCode);
    });
    return { restored, data: term.buffer };
  }

  input(id: string, data: string): void {
    const term = this.terms.get(id);
    if (term && !term.exited) term.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.terms.get(id);
    if (!term || term.exited || cols < 2 || rows < 2) return;
    try {
      term.pty.resize(Math.floor(cols), Math.floor(rows));
      term.screen.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // The process may be exiting.
    }
  }

  /** The terminal's screen and scrollback as plain lines, without the blank ones at the end. */
  private lines(term: Terminal): string[] {
    const buf = term.screen.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines;
  }

  private save(id: string, term: Terminal): void {
    if (!term.dirty) return;
    term.dirty = false;
    const lines = this.lines(term);
    // A restored shell nobody typed in keeps the old save as it was (no extra divider each restart).
    const unused = term.restored.length > 0 && onlyPrompts(lines);
    const text = unused ? term.restored.slice(0, -1) : [...term.restored, ...lines].slice(-SAVED_LINES);
    const { log, meta } = this.files(id);
    try {
      writeFileSync(log, text.join('\n'));
      writeFileSync(meta, JSON.stringify({ cwd: this.folder(term, lines), at: unused ? term.restoredAt : Date.now() } satisfies Saved));
    } catch {
      // Try again next round.
    }
  }

  /** The shell's folder: from its last prompt on Windows, from /proc on Linux (exact, whatever the prompt looks like). */
  private folder(term: Terminal, lines: string[]): string | undefined {
    if (IS_WINDOWS) return promptFolder(lines);
    if (term.exited) return undefined;
    try {
      return readlinkSync(`/proc/${term.pty.pid}/cwd`);
    } catch {
      return undefined;
    }
  }

  saveAll(): void {
    for (const [id, term] of this.terms) this.save(id, term);
  }

  /** The user closed the terminal (or its chat): end it and forget its saved text. */
  close(id: string): void {
    if (!TerminalManager.validId(id)) return;
    const term = this.terms.get(id);
    this.terms.delete(id);
    if (term) this.kill(term);
    const { log, meta } = this.files(id);
    rmSync(log, { force: true });
    rmSync(meta, { force: true });
  }

  /** Forgets every saved terminal `keep` says no to (chats closed while Harv was off). */
  prune(keep: (id: string) => boolean): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const ids = new Set(names.map((f) => f.replace(/\.(log|json)$/, '')).filter(TerminalManager.validId));
    for (const id of ids) if (!keep(id)) this.close(id);
  }

  private kill(term: Terminal): void {
    term.screen.dispose();
    if (term.exited) return;
    try {
      term.pty.kill();
    } catch {
      // Already gone.
    }
  }

  /** Server shutdown: save everything (so it comes back), then end the shells. */
  closeAll(): void {
    clearInterval(this.timer);
    this.saveAll();
    for (const term of this.terms.values()) this.kill(term);
    this.terms.clear();
  }
}
