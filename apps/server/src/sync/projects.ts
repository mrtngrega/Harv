import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '@harv/shared';
import { IS_WINDOWS } from '../platform.ts';

// Projects follow the user between devices (docs/PLAN.md §6n, item 5): every project
// Harv starts gets a GitHub repo, the sync log carries its name and remote, and the
// other device links or clones it and keeps it pulled, never touching work in progress.

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run('git', args, { cwd, windowsHide: true, timeout: 120_000 });

/** "github.com/owner/repo", however the remote is written (https, ssh, with or without .git). */
export function remoteKey(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export const sameRemote = (a: string, b: string) => remoteKey(a) === remoteKey(b);

/** The folder's `origin`, or null when it has none (or isn't a git repo). */
export async function remoteOf(path: string): Promise<string | null> {
  if (!existsSync(join(path, '.git'))) return null;
  try {
    const { stdout } = await git(path, 'remote', 'get-url', 'origin');
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A GitHub repo name from a project name: letters, digits, dots, dashes and underscores. */
export function repoName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

/** `gh`, also where its installer puts it when the server's PATH doesn't have it. */
async function gh(cwd: string, args: string[]) {
  try {
    return await run('gh', args, { cwd, windowsHide: true, timeout: 120_000 });
  } catch (err) {
    const fallback = 'C:\\Program Files\\GitHub CLI\\gh.exe';
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && IS_WINDOWS && existsSync(fallback)) {
      return run(fallback, args, { cwd, windowsHide: true, timeout: 120_000 });
    }
    throw err;
  }
}

/**
 * Makes the GitHub repo for a new project (private or public: the user's answer, always
 * asked) and pushes its first commit. Returns the remote.
 */
export async function createGitHubRepo(path: string, name: string, visibility: 'private' | 'public'): Promise<string> {
  await git(path, 'add', '-A');
  await git(path, 'commit', '-q', '-m', 'Start the project');
  await gh(path, ['repo', 'create', repoName(name), `--${visibility}`, '--source', '.', '--remote', 'origin', '--push']);
  const remote = await remoteOf(path);
  if (!remote) throw new Error('gh made the repo but the folder has no origin remote');
  return remote;
}

export type PullResult = 'pulled' | 'up-to-date' | 'dirty' | 'unpushed' | 'diverged' | 'no-remote' | 'failed';

/**
 * Brings the project up to date with its remote, only when nothing here could be lost: a
 * clean tree, nothing unpushed, and a fast-forward. Anything else is left for the user.
 */
export async function pullProject(path: string): Promise<PullResult> {
  try {
    if (!(await remoteOf(path))) return 'no-remote';
    const { stdout: status } = await git(path, 'status', '--porcelain');
    if (status.trim()) return 'dirty';
    await git(path, 'fetch', '-q', 'origin');
    let ahead = 0;
    let behind = 0;
    try {
      const { stdout } = await git(path, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}');
      [ahead, behind] = stdout.trim().split(/\s+/).map(Number) as [number, number];
    } catch {
      return 'no-remote'; // no upstream branch yet
    }
    if (ahead > 0 && behind > 0) return 'diverged';
    if (ahead > 0) return 'unpushed';
    if (behind === 0) return 'up-to-date';
    await git(path, 'merge', '--ff-only', '-q', '@{upstream}');
    return 'pulled';
  } catch {
    return 'failed';
  }
}

/** What a pull that didn't happen means, for a notice. */
export function pullNotice(name: string, result: PullResult): string | undefined {
  switch (result) {
    case 'dirty':
      return `"${name}" has uncommitted changes here, so Harv didn't pull the other device's work into it.`;
    case 'unpushed':
      return `"${name}" has commits here that aren't pushed yet, so Harv didn't pull the other device's work into it.`;
    case 'diverged':
      return `"${name}" has new commits both here and on the other device; Harv left it for you to merge.`;
    case 'failed':
      return `Harv couldn't pull "${name}" (git failed; check the network or the repo).`;
    default:
      return undefined;
  }
}

/** What to do with a project the other device announced. */
export type LinkPlan =
  | { do: 'nothing' }
  /** A project of that name here already works on the same repo: remember the remote. */
  | { do: 'link'; project: Project }
  /** Not here yet, and its folder is free: clone it there. */
  | { do: 'clone'; path: string }
  /** A folder of that name exists with that repo in it: add it as a project. */
  | { do: 'add'; path: string }
  /** Something else has that name: leave it alone, and say so. */
  | { do: 'conflict'; notice: string };

export async function planLink(
  name: string,
  remote: string,
  projects: (Project & { remote?: string })[],
  projectsDir: string,
): Promise<LinkPlan> {
  const same = projects.find((p) => p.remote && sameRemote(p.remote, remote));
  if (same) return { do: 'nothing' };
  const named = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (named) {
    const there = await remoteOf(named.path);
    if (there && sameRemote(there, remote)) return { do: 'link', project: named };
    return {
      do: 'conflict',
      notice: `The other device has a project "${name}" (${remote}), but "${name}" here is ${there ? `a different repo (${there})` : 'not linked to it'}. Harv left yours alone.`,
    };
  }
  const path = join(projectsDir, name);
  if (!existsSync(path)) return { do: 'clone', path };
  const there = await remoteOf(path);
  if (there && sameRemote(there, remote)) return { do: 'add', path };
  return {
    do: 'conflict',
    notice: `The other device has a project "${name}", but ${path} already holds something else here, so Harv didn't touch it. Clone ${remote} somewhere else and add it as a project if you want it here.`,
  };
}

export async function cloneProject(remote: string, path: string): Promise<void> {
  await run('git', ['clone', '-q', remote, path], { windowsHide: true, timeout: 600_000 });
}
