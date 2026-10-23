import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn, type IPty } from '@lydell/node-pty';

/** Output kept per terminal, so a reloaded dashboard can show what was there. */
const SCROLLBACK_CHARS = 200_000;

interface Terminal {
  pty: IPty;
  buffer: string;
  exited: boolean;
}

export interface TerminalEvents {
  data: (id: string, data: string) => void;
  exit: (id: string, code: number) => void;
}

/**
 * The user's own terminal tabs: PowerShell in a real pseudo-terminal (ConPTY).
 * What the user types here is theirs, so it doesn't pass Harv's safety gate;
 * Harv itself never writes to these terminals.
 */
export class TerminalManager {
  private terms = new Map<string, Terminal>();

  constructor(
    private events: TerminalEvents,
    private shell = 'powershell.exe',
  ) {}

  open(id: string, cwd?: string, cols = 100, rows = 30): void {
    if (this.terms.has(id)) return;
    const pty = spawn(this.shell, ['-NoLogo'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd && existsSync(cwd) ? cwd : homedir(),
      // Harv's environment already has the API credentials stripped (env.ts).
      env: process.env as Record<string, string>,
    });
    const term: Terminal = { pty, buffer: '', exited: false };
    this.terms.set(id, term);
    pty.onData((data) => {
      term.buffer = (term.buffer + data).slice(-SCROLLBACK_CHARS);
      this.events.data(id, data);
    });
    pty.onExit(({ exitCode }) => {
      term.exited = true;
      this.events.exit(id, exitCode);
    });
  }

  /** Everything the terminal printed so far (the last 200k characters). */
  replay(id: string): string | undefined {
    return this.terms.get(id)?.buffer;
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
    } catch {
      // The process may be exiting.
    }
  }

  close(id: string): void {
    const term = this.terms.get(id);
    if (!term) return;
    this.terms.delete(id);
    if (!term.exited) {
      try {
        term.pty.kill();
      } catch {
        // Already gone.
      }
    }
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}
