import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type HarvSettings, type SharedUi } from '@harv/shared';
import { ChatStore } from '../store/chats.ts';
import { RouteStore } from '../store/routes.ts';
import { SyncEngine, type SettingsPort } from './engine.ts';
import { claudeMemoryDir, mergeLines, safeRelPath } from './files.ts';
import { SyncStore } from './store.ts';

// Everything else Harv needs on both devices (docs/PLAN.md §6m): project memory, files,
// the background photo, tabs and drafts, usage warnings, unpushed project work.

const root = mkdtempSync(join(tmpdir(), 'harv-sync-extras-'));
const open: { close(): void }[] = [];
afterAll(() => {
  for (const db of open) db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function settingsPort(initial: Partial<HarvSettings>): SettingsPort {
  let current: HarvSettings = { ...DEFAULT_SETTINGS, ...initial };
  return {
    load: () => current,
    update: (patch) => (current = { ...current, ...patch }),
    time: () => 0,
    onChange: () => () => {},
  };
}

let n = 0;
let remote = '';

function device(name: string, projects: string[] = ['car_radio']) {
  const home = join(root, `${name}-${n}`);
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const db = join(home, 'harv.db');
  const chats = new ChatStore(db);
  const routes = new RouteStore(db);
  const syncStore = new SyncStore(db);
  open.push(chats, routes, syncStore);
  const projectDirs = new Map(projects.map((p) => [p, join(home, 'claude', p, 'memory')]));
  const got = { ui: [] as SharedUi[], warned: [] as string[], states: [] as string[], written: [] as string[] };
  let ui: { ui: SharedUi; at: number } | null = null;
  const engine = new SyncEngine(
    home,
    chats,
    routes,
    syncStore,
    {
      chats: () => {},
      settings: () => {},
      status: () => {},
      log: () => {},
      ui: (u) => got.ui.push(u),
      warned: (k) => got.warned.push(k),
      projectState: (p, d, unsaved) => got.states.push(`${p}@${d}:${unsaved}`),
      fileWritten: (r, p) => got.written.push(`${r}/${p}`),
    },
    join(home, 'memory'),
    settingsPort({ syncEnabled: true, syncRepo: remote, deviceName: name }),
    {},
    {
      projectMemory: () => Object.fromEntries(projectDirs),
      folders: {
        workspace: { dir: workspace, accept: () => true },
        home: {
          dir: home,
          // As in index.ts: the photo, and the Tapo login (docs/PLAN.md §6z), which mustn't replace the photo.
          accept: (rel) => /^background\.(jpg|png)$/.test(rel) || rel === 'devices.json',
          beforeWrite: (rel) =>
            /^background\./.test(rel) && ['jpg', 'png'].forEach((e) => rmSync(join(home, `background.${e}`), { force: true })),
          secret: (rel) => rel === 'devices.json',
          shallow: true,
        },
      },
      ui: () => ui,
    },
  );
  const sync = async () => {
    await engine.now();
    const error = engine.status().error;
    if (error) throw new Error(error);
  };
  return {
    home,
    workspace,
    projectDirs,
    engine,
    got,
    sync,
    setUi: (u: SharedUi, at = Date.now()) => (ui = { ui: u, at }),
  };
}

async function pair() {
  const pc = device('PC');
  const nb = device('notebook');
  await pc.sync();
  copyFileSync(join(pc.home, 'sync.key'), join(nb.home, 'sync.key'));
  await nb.sync();
  return [pc, nb] as const;
}

const write = (path: string, content: string | Buffer, at?: number) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  if (at) utimesSync(path, at / 1000, at / 1000);
};

beforeEach(() => {
  n++;
  remote = join(root, `remote-${n}.git`).replace(/\\/g, '/');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
});

describe('helpers', () => {
  it('names the Claude Code memory folder like Claude Code does', () => {
    expect(claudeMemoryDir('C:\\My files\\Code\\Harv', '/h')).toBe(join('/h', '.claude', 'projects', 'C--My-files-Code-Harv', 'memory'));
    expect(claudeMemoryDir('/home/me/Code/car_radio', '/h')).toBe(join('/h', '.claude', 'projects', '-home-me-Code-car-radio', 'memory'));
  });

  it('takes only plain relative paths from the other device', () => {
    expect(safeRelPath('attachments/c1/a1/photo.png')).toBe(true);
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', 'con.txt', ''])
      expect(safeRelPath(bad), bad).toBe(false);
  });

  it('merges lines without losing any', () => {
    expect(mergeLines('- a\n- b\n', '- a\n- c\n')).toBe('- a\n- b\n- c\n');
  });
});

describe('sync of everything else', { timeout: 60_000 }, () => {
  it("brings a project's Claude Code memory over by project name, both ways, merging MEMORY.md", async () => {
    const [pc, nb] = await pair();
    const pcDir = pc.projectDirs.get('car_radio')!;
    const nbDir = nb.projectDirs.get('car_radio')!;
    write(join(pcDir, 'MEMORY.md'), '- [Plan](plan.md) — the plan\n', Date.now() - 60_000);
    write(join(pcDir, 'plan.md'), 'photo of the Golf');
    await pc.sync();
    await nb.sync();
    expect(readFileSync(join(nbDir, 'plan.md'), 'utf8')).toBe('photo of the Golf');

    // Both add a line to the index while apart: the newer wins, the other's line is kept.
    write(join(pcDir, 'MEMORY.md'), '- [Plan](plan.md) — the plan\n- [PC note](pc.md) — pc\n', Date.now() - 30_000);
    write(join(nbDir, 'MEMORY.md'), '- [Plan](plan.md) — the plan\n- [Laptop note](nb.md) — nb\n', Date.now());
    await pc.sync();
    await nb.sync();
    await pc.sync();
    const merged = '- [Plan](plan.md) — the plan\n- [Laptop note](nb.md) — nb\n- [PC note](pc.md) — pc\n';
    expect(readFileSync(join(nbDir, 'MEMORY.md'), 'utf8')).toBe(merged);
    expect(readFileSync(join(pcDir, 'MEMORY.md'), 'utf8')).toBe(merged);

    // Deleted on one, deleted on the other.
    rmSync(join(nbDir, 'plan.md'));
    await nb.sync();
    await pc.sync();
    expect(existsSync(join(pcDir, 'plan.md'))).toBe(false);
  });

  it("keeps notes for a project this device doesn't have yet until it does", async () => {
    const pc = device('PC', ['car_radio', 'weather']);
    const nb = device('notebook', ['car_radio']);
    await pc.sync();
    copyFileSync(join(pc.home, 'sync.key'), join(nb.home, 'sync.key'));
    write(join(pc.projectDirs.get('weather')!, 'MEMORY.md'), '- weather notes\n');
    await pc.sync();
    await nb.sync();
    // The project arrives (cloned) later.
    nb.projectDirs.set('weather', join(nb.home, 'claude', 'weather', 'memory'));
    await nb.sync();
    expect(readFileSync(join(nb.projectDirs.get('weather')!, 'MEMORY.md'), 'utf8')).toBe('- weather notes\n');
  });

  it('brings attachments and workspace files over, sealed in the repo, and deletes them there too', async () => {
    const [pc, nb] = await pair();
    const photo = Buffer.from('\x89PNG fake image bytes of the Golf');
    write(join(nb.workspace, 'attachments', 'c1', 'a1', 'golf.png'), photo);
    write(join(nb.workspace, 'notes', 'list.txt'), 'shopping list');
    // Rebuilt folders and big files stay home.
    write(join(nb.workspace, 'node_modules', 'x', 'index.js'), 'x');
    write(join(nb.workspace, 'big.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await nb.sync();
    await pc.sync();
    expect(readFileSync(join(pc.workspace, 'attachments', 'c1', 'a1', 'golf.png'))).toEqual(photo);
    expect(readFileSync(join(pc.workspace, 'notes', 'list.txt'), 'utf8')).toBe('shopping list');
    expect(existsSync(join(pc.workspace, 'node_modules'))).toBe(false);
    expect(existsSync(join(pc.workspace, 'big.bin'))).toBe(false);

    // GitHub only sees noise.
    const blobs = join(nb.home, 'sync', nb.engine.id, 'blobs');
    for (const f of readdirSync(blobs)) expect(readFileSync(join(blobs, f)).includes('shopping list')).toBe(false);

    // Nothing comes back the other way (what arrived counts as sent).
    await pc.sync();
    expect(pc.engine.status().pending).toBe(0);

    rmSync(join(nb.workspace, 'attachments', 'c1'), { recursive: true });
    await nb.sync();
    await pc.sync();
    expect(existsSync(join(pc.workspace, 'attachments', 'c1', 'a1', 'golf.png'))).toBe(false);
    expect(existsSync(join(pc.workspace, 'notes', 'list.txt'))).toBe(true);
  });

  it('keeps a file changed on both sides as the newer one', async () => {
    const [pc, nb] = await pair();
    write(join(pc.workspace, 'todo.txt'), 'v1');
    await pc.sync();
    await nb.sync();
    write(join(pc.workspace, 'todo.txt'), 'pc version', Date.now() - 60_000);
    write(join(nb.workspace, 'todo.txt'), 'notebook version', Date.now());
    await pc.sync();
    await nb.sync();
    await pc.sync();
    expect(readFileSync(join(nb.workspace, 'todo.txt'), 'utf8')).toBe('notebook version');
    expect(readFileSync(join(pc.workspace, 'todo.txt'), 'utf8')).toBe('notebook version');
  });

  it('brings the background photo over, replacing the other one', async () => {
    const [pc, nb] = await pair();
    write(join(nb.home, 'background.jpg'), 'old photo');
    write(join(pc.home, 'background.png'), 'forest photo');
    // Only the photo travels from ~/.harv, nothing else there.
    write(join(pc.home, 'settings.json'), '{}');
    await pc.sync();
    await nb.sync();
    expect(readFileSync(join(nb.home, 'background.png'), 'utf8')).toBe('forest photo');
    expect(nb.got.written).toContain('home/background.png');
    expect(existsSync(join(nb.home, 'settings.json'))).toBe(false);
  });

  it('brings the Tapo login over owner-only, and leaves the photo alone (docs/PLAN.md §6z)', async () => {
    const [pc, nb] = await pair();
    write(join(pc.home, 'background.png'), 'forest photo');
    await pc.sync();
    await nb.sync();
    write(join(pc.home, 'devices.json'), '{"tapo":{"email":"me@example.com","password":"pw"},"lights":["EC:75:0C:EA:F1:9F"]}');
    await pc.sync();
    await nb.sync();
    expect(JSON.parse(readFileSync(join(nb.home, 'devices.json'), 'utf8')).lights).toEqual(['EC:75:0C:EA:F1:9F']);
    expect(readFileSync(join(nb.home, 'background.png'), 'utf8')).toBe('forest photo');
    if (process.platform !== 'win32') expect(statSync(join(nb.home, 'devices.json')).mode & 0o777).toBe(0o600);
    // Only sealed in the shared repo: the password isn't readable there.
    // git grep exits 1 when nothing matches, which is the point here.
    const grep = spawnSync('git', ['-C', join(pc.home, 'sync'), 'grep', '-l', 'me@example.com', 'HEAD'], { encoding: 'utf8' });
    expect(grep.status).toBe(1);
    expect(grep.stdout).toBe('');
  });

  it('shows the newer tabs and drafts on the other device, without echoing them back', async () => {
    const [pc, nb] = await pair();
    const tabs: SharedUi = { order: ['c1', 'b1'], blanks: ['b1'], drafts: { c1: 'half a message' }, attachments: {} };
    nb.setUi({ order: ['old'], blanks: [], drafts: {}, attachments: {} }, Date.now() - 60_000);
    pc.setUi(tabs);
    await pc.sync();
    await nb.sync();
    expect(nb.got.ui).toEqual([tabs]);
    // The dashboard there now saves the same layout: it doesn't go back.
    nb.setUi(tabs);
    await nb.sync();
    await pc.sync();
    expect(pc.got.ui).toEqual([]);
  });

  it('passes on usage warnings shown and projects with unpushed work', async () => {
    const [pc, nb] = await pair();
    pc.engine.noteWarned('session:90');
    pc.engine.noteProjectStates({ car_radio: true, Harv: false });
    // Unchanged states aren't sent again.
    pc.engine.noteProjectStates({ car_radio: true, Harv: false });
    await pc.sync();
    await nb.sync();
    expect(nb.got.warned).toEqual(['session:90']);
    expect(nb.got.states).toEqual(['car_radio@PC:true']);
    pc.engine.noteProjectStates({ car_radio: false });
    await pc.sync();
    await nb.sync();
    expect(nb.got.states).toEqual(['car_radio@PC:true', 'car_radio@PC:false']);
  });
});
