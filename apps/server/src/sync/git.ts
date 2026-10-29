import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IS_WINDOWS } from '../platform.ts';

const run = promisify(execFile);

/**
 * Runs git, never waiting for a password prompt nobody sees. On Linux it gets its own process
 * group, so a timeout also ends its helpers (`git-remote-https`, `gh auth git-credential` waiting
 * on a locked keyring), which otherwise lingered for minutes after each try.
 */
async function runGit(args: string[], cwd: string, timeout: number): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (IS_WINDOWS) {
    try {
      const { stdout } = await run('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env });
      return stdout.trim();
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string };
      if (e.killed && e.signal) Object.assign(err as object, { timedOut: true });
      throw err;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(stdout.trim());
      else reject(Object.assign(new Error(`git ${args[0]} failed`), { stderr, timedOut }));
    });
  });
}

/** The branch every device pushes to. */
const BRANCH = 'main';

/**
 * The sync repo's working copy (~/.harv/sync). Each device only adds files to its own
 * folder, so a rebase onto the other device's commits never conflicts.
 */
export class SyncRepo {
  constructor(
    readonly dir: string,
    private deviceId: string,
  ) {}

  private async git(args: string[], timeout = 120_000): Promise<string> {
    try {
      return await runGit(args, this.dir, timeout);
    } catch (err) {
      const e = err as { stderr?: string; message: string; timedOut?: boolean };
      if (e.timedOut)
        throw new Error(
          IS_WINDOWS
            ? `git ${args[0]} took over ${timeout / 1000} s (no network, or GitHub didn't answer)`
            : `git ${args[0]} took over ${timeout / 1000} s: usually the keyring is locked (unlock the computer) or there's no network`,
          { cause: err },
        );
      throw new Error((e.stderr || e.message).trim().split('\n').slice(-3).join(' '), { cause: err });
    }
  }

  /** Clones the repo the first time (or again when the URL changed). True when the working copy is new. */
  async ensure(url: string): Promise<boolean> {
    if (existsSync(join(this.dir, '.git'))) {
      const current = await this.git(['remote', 'get-url', 'origin']).catch(() => '');
      if (current === url) return false;
      rmSync(this.dir, { recursive: true, force: true });
    }
    mkdirSync(this.dir, { recursive: true });
    await this.git(['init', '-b', BRANCH]);
    await this.git(['remote', 'add', 'origin', url]);
    // The chunks are binary: no line-ending changes on Windows.
    writeFileSync(join(this.dir, '.gitattributes'), '* -text\n');
    await this.git(['config', 'core.autocrlf', 'false']);
    await this.git(['config', 'user.name', 'Harv']);
    await this.git(['config', 'user.email', 'harv@localhost']);
    await this.git(['config', 'commit.gpgsign', 'false']);
    return true;
  }

  /** Brings in the other devices' commits. False when the repo is still empty. */
  async pull(): Promise<boolean> {
    await this.git(['fetch', '--quiet', 'origin']);
    const remote = await this.git(['rev-parse', '--verify', '--quiet', `origin/${BRANCH}`]).catch(() => '');
    if (!remote) return false;
    const local = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
    if (!local) await this.git(['reset', '--quiet', '--hard', `origin/${BRANCH}`]);
    else await this.git(['rebase', '--quiet', `origin/${BRANCH}`]);
    return true;
  }

  /** Commits this device's new chunk files. */
  async commit(message: string): Promise<boolean> {
    // Only this device writes in its working copy, so everything new is its own.
    await this.git(['add', '-A']);
    const staged = await this.git(['diff', '--cached', '--name-only']);
    if (!staged) return false;
    await this.git(['commit', '--quiet', '-m', message]);
    return true;
  }

  /** Pushes; if the other device pushed meanwhile, rebases onto it and tries once more. */
  async push(): Promise<void> {
    const local = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
    if (!local) return;
    try {
      await this.git(['push', '--quiet', 'origin', `HEAD:${BRANCH}`]);
    } catch {
      await this.pull();
      await this.git(['push', '--quiet', 'origin', `HEAD:${BRANCH}`]);
    }
  }

  /** Commits not on the remote yet. */
  async ahead(): Promise<number> {
    const remote = await this.git(['rev-parse', '--verify', '--quiet', `origin/${BRANCH}`]).catch(() => '');
    const local = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
    if (!local) return 0;
    if (!remote) return Number(await this.git(['rev-list', '--count', 'HEAD']));
    return Number(await this.git(['rev-list', '--count', `origin/${BRANCH}..HEAD`]));
  }
}
