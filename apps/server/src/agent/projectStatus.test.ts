import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Project } from '@harv/shared';
import { claudeMemoryDir } from '../sync/files.ts';
import { findProject, projectStatus } from './projectStatus.ts';

const root = mkdtempSync(join(tmpdir(), 'harv-status-'));
const home = join(root, 'home');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const project = (name: string, path: string) => ({ id: name, name, path }) as Project;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, windowsHide: true });

describe('project_status', () => {
  it('finds a project by a loose name', () => {
    const list = [project('car_radio', '/a'), project('Harv', '/b')];
    expect(findProject(list, 'car radio')?.name).toBe('car_radio');
    expect(findProject(list, 'harv')?.name).toBe('Harv');
    expect(findProject(list, 'radio')?.name).toBe('car_radio');
    expect(findProject(list, 'weather')).toBeUndefined();
    expect(findProject(list, '!!')).toBeUndefined();
  });

  it('reads the memory, CLAUDE.md, the plan and git without switching', async () => {
    const path = join(root, 'car_radio');
    mkdirSync(join(path, 'docs'), { recursive: true });
    writeFileSync(join(path, 'CLAUDE.md'), '# car_radio\nA custom UI for the head unit.');
    writeFileSync(join(path, 'docs', 'PLAN.md'), 'Status: settings screen next.');
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'Home icon fixed');
    writeFileSync(join(path, 'new.txt'), 'x');
    const memory = claudeMemoryDir(path, home);
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'MEMORY.md'), '- [Session end](session-end.md)');
    writeFileSync(join(memory, 'session-end.md'), 'Stopped at: map the steering wheel buttons.');

    const out = await projectStatus(project('car_radio', path), home);
    expect(out).toContain('map the steering wheel buttons');
    expect(out.indexOf('MEMORY.md')).toBeLessThan(out.indexOf('session-end.md'));
    expect(out).toContain('A custom UI for the head unit');
    expect(out).toContain('Status: settings screen next.');
    expect(out).toMatch(/[0-9a-f]{7} \d{4}-\d\d-\d\d \d\d:\d\d Home icon fixed/);
    expect(out).toContain('Uncommitted: 1 file(s)');
    expect(out).toContain('No upstream branch.');
  });

  it('says plainly what is missing', async () => {
    const path = join(root, 'empty');
    mkdirSync(path);
    const out = await projectStatus(project('empty', path), home);
    expect(out).toContain('No Claude Code memory for this project yet.');
    expect(out).toContain('Not a git repository');
    expect(await projectStatus(project('gone', join(root, 'nope')), home)).toContain("isn't on this computer");
  });
});
