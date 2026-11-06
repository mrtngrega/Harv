import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { HARV_HOME } from '../paths.ts';
import { IS_WINDOWS } from '../platform.ts';
import { DESKTOP_TOOLS } from '../safety/desktop.ts';
import { loadSettings } from '../settings.ts';

// Desktop control (docs/PLAN.md §6t item 1): Windows-MCP (CursorTouch, MIT) gives chats the screen
// as text (Windows' accessibility tree: buttons, fields, labels), screenshots, the mouse and the
// keyboard. Reviewed on 2026-11-06 at 0.8.8, the version pinned here; it lives in its own venv in
// ~/.harv/windows-mcp, installed from Settings › This computer › Desktop control. What a chat may do
// with it is safety/desktop.ts. Windows only.

/** The version reviewed. A newer one gets a new review before this changes. */
export const WINDOWS_MCP_VERSION = '0.8.8';
const HOME = join(HARV_HOME, 'windows-mcp');
const VENV = join(HOME, 'venv');
const EXE = join(VENV, 'Scripts', 'windows-mcp.exe');
const PYTHON = join(VENV, 'Scripts', 'python.exe');
/** Starts it without its own glow and notice pill: Harv's pill is the indicator (windows_mcp_quiet.py). */
const QUIET = fileURLToPath(new URL('./windows_mcp_quiet.py', import.meta.url));

/**
 * How the server is started. Its telemetry (PostHog, on unless told otherwise; it sends every
 * tool's result) is always off, and only the allowed tools exist: its shell, file, registry,
 * process and web tools never start, so nothing gets around the gate and Harv's backups.
 */
export const WINDOWS_MCP_ENV: Record<string, string> = {
  ANONYMIZED_TELEMETRY: 'false',
  WINDOWS_MCP_TOOLS: DESKTOP_TOOLS.join(','),
  // No white flash over the screen at every screenshot.
  WINDOWS_MCP_DISABLE_FLASH: '1',
};

/** A local server on stdin/stdout (no port, nothing on the network), through Harv's quiet launcher. */
export const WINDOWS_MCP_ARGS = ['-I', QUIET, 'serve', '--transport', 'stdio'];

export interface DesktopStatus {
  /** This OS can have it at all. */
  available: boolean;
  installed: boolean;
  installing: boolean;
  /** Why the last install failed. */
  error?: string;
}

export class WindowsMcp {
  private installing = false;
  private error: string | undefined;

  constructor(private onChange: (status: DesktopStatus) => void = () => {}) {}

  installed(): boolean {
    return IS_WINDOWS && existsSync(EXE);
  }

  status(): DesktopStatus {
    return {
      available: IS_WINDOWS,
      installed: this.installed(),
      installing: this.installing,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** What chats load, when the user turned it on and it's installed (else nothing). */
  server(): McpStdioServerConfig | undefined {
    if (!loadSettings().desktopControl || !this.installed()) return undefined;
    return { type: 'stdio', command: PYTHON, args: WINDOWS_MCP_ARGS, env: WINDOWS_MCP_ENV };
  }

  /** Settings › Install: the venv with the reviewed version, once per computer (needs Python 3.14, the `py` launcher). */
  async install(): Promise<void> {
    if (!IS_WINDOWS || this.installing || this.installed()) return;
    this.installing = true;
    this.error = undefined;
    this.onChange(this.status());
    try {
      rmSync(VENV, { recursive: true, force: true });
      await run('py', ['-3.14', '-m', 'venv', VENV]);
      await run(join(VENV, 'Scripts', 'python.exe'), [
        '-m',
        'pip',
        'install',
        '-q',
        '--disable-pip-version-check',
        `windows-mcp==${WINDOWS_MCP_VERSION}`,
      ]);
      if (!existsSync(EXE)) throw new Error('windows-mcp.exe is missing after the install.');
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.installing = false;
      this.onChange(this.status());
    }
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-600)));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').at(-1) || `${cmd} exited with ${code}`))));
  });
}
