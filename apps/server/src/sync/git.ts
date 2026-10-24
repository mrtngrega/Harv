import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

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
      const { stdout } = await run('git', args, {
        cwd: this.dir,
        timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        // Never wait for a password prompt nobody sees.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
      return stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error((e.stderr || e.message).trim().split('\n').slice(-3).join(' '), { cause: err });
    }
  }

  /** Clones the repo the first time (or again when the URL changed). */
  async ensure(url: string): Promise<void> {
    if (existsSync(join(this.dir, '.git'))) {
      const current = await this.git(['remote', 'get-url', 'origin']).catch(() => '');
      if (current === url) return;
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
