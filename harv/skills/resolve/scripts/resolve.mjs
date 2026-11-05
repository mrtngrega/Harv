#!/usr/bin/env node
// Harv's side of the Resolve bridge (see ../bridge.lua and ../SKILL.md).
//
//   node resolve.mjs status              is the bridge running? (exit 0 yes, 1 no)
//   node resolve.mjs start               start Resolve if needed, then the bridge in its Console
//   node resolve.mjs run <file.lua>      run a Lua file inside Resolve, print the JSON answer
//   node resolve.mjs run -e "<lua>"      the same with inline Lua
//   node resolve.mjs stop                end the bridge
// Options: --timeout <s> for run (default 120).
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolvePath(HERE, '..', 'bridge.lua');
const DIR = join(process.env.HARV_HOME ?? join(homedir(), '.harv'), 'resolve-bridge');
const REQ = join(DIR, 'request.lua');
const RESP = join(DIR, 'response.json');
const BEAT = join(DIR, 'heartbeat');
const STOP = join(DIR, 'stop');
const WIN = process.platform === 'win32';
const RESOLVE_EXE = 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => process.stdout.write(s + '\n');

/** The heartbeat: its age in seconds, the bridge's Resolve pid, busy; null without a bridge. */
function heartbeat() {
  try {
    const [epoch, , pid, busy] = readFileSync(BEAT, 'utf8').trim().split(' ');
    return { age: Date.now() / 1000 - Number(epoch), pid: Number(pid), busy: busy === 'busy' };
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A request may run long (the heartbeat isn't refreshed while it runs), so a busy bridge counts as
// up while its Resolve process lives; a crash leaves the last heartbeat behind with a dead pid.
const up = () => {
  const b = heartbeat();
  return !!b && alive(b.pid) && (b.age < 6 || b.busy);
};

function resolveRunning() {
  if (!WIN) return spawnSync('pgrep', ['-x', 'resolve']).status === 0;
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Resolve.exe', '/NH'], { encoding: 'utf8' });
  return /Resolve\.exe/i.test(r.stdout ?? '');
}

async function start() {
  mkdirSync(DIR, { recursive: true });
  if (up()) return say('bridge: already running');
  const line = `dofile([[${BRIDGE.replaceAll('\\', '/')}]])`;
  if (!WIN) {
    say(`Free Resolve on Linux: ask the user to open Workspace > Console (F6) and run this line:\n${line}`);
    process.exit(1);
  }
  if (!resolveRunning()) {
    if (!existsSync(RESOLVE_EXE)) throw new Error(`DaVinci Resolve isn't installed at ${RESOLVE_EXE}`);
    say('starting DaVinci Resolve…');
    spawn(RESOLVE_EXE, [], { detached: true, stdio: 'ignore' }).unref();
  }
  const ps = join(HERE, 'console.ps1');
  const b64 = Buffer.from(line, 'utf8').toString('base64');
  rmSync(BEAT, { force: true }); // a stale one must not pass for the new bridge
  const deadline = Date.now() + 120_000;
  let last = '';
  while (Date.now() < deadline) {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, b64], {
      encoding: 'utf8',
    });
    last = (r.stdout || r.stderr || '').trim();
    if (last.endsWith('TYPED')) {
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (up()) return say("bridge: running (started in Resolve's Console)");
      }
      throw new Error(
        "typed the start line into the Console but the bridge didn't answer. Is a project open? " +
          `Ask the user to look at Resolve's Console (F6); the line is: ${line}`,
      );
    }
    if (last.endsWith('PROJECT_MANAGER'))
      throw new Error(
        'Resolve shows its Project Manager: no project is open, and the Console only exists inside one. ' +
          'Ask the user which project to open (or to open it), then run start again.',
      );
    // NO_WINDOW / NO_CONSOLE: Resolve is still starting (splash screen). Wait.
    await sleep(3000);
  }
  throw new Error(`couldn't reach Resolve's Console (${last}). The user can run this line in it (F6): ${line}`);
}

async function run(code, timeoutS) {
  if (!up()) {
    say("bridge isn't running: starting it");
    await start();
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  rmSync(RESP, { force: true });
  writeFileSync(REQ + '.tmp', `-- id: ${id}\n${code}`);
  renameSync(REQ + '.tmp', REQ);
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!existsSync(RESP)) {
      const b = heartbeat();
      if (!b || (b.age > 10 && !b.busy)) throw new Error('the bridge stopped (Resolve closed?)');
      if (!alive(b.pid)) throw new Error('DaVinci Resolve closed or crashed while running this');
      continue;
    }
    let answer;
    try {
      answer = JSON.parse(readFileSync(RESP, 'utf8'));
    } catch {
      continue; // being written
    }
    if (answer.id !== id) continue;
    rmSync(RESP, { force: true });
    say(JSON.stringify(answer, null, 1));
    process.exit(answer.ok ? 0 : 1);
  }
  throw new Error(`no answer within ${timeoutS} s (still running inside Resolve? check with status)`);
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const timeout = Number(opt('--timeout', '120'));
const [cmd, ...rest] = args;

try {
  if (cmd === 'status') {
    const b = heartbeat();
    say(
      up()
        ? `bridge: running${b?.busy ? ' (busy with a request)' : ''}`
        : `bridge: not running (Resolve ${resolveRunning() ? 'is open' : 'is closed'})`,
    );
    process.exit(up() ? 0 : 1);
  } else if (cmd === 'start') {
    await start();
  } else if (cmd === 'stop') {
    if (!up()) say('bridge: not running');
    else {
      writeFileSync(STOP, '');
      for (let i = 0; i < 20 && existsSync(BEAT); i++) await sleep(250);
      say(existsSync(BEAT) ? 'bridge: asked to stop' : 'bridge: stopped');
    }
  } else if (cmd === 'run') {
    const code = rest[0] === '-e' ? rest.slice(1).join(' ') : readFileSync(rest[0], 'utf8');
    if (!code?.trim()) throw new Error('nothing to run');
    await run(code, timeout);
  } else {
    say('usage: resolve.mjs status | start | run <file.lua> | run -e "<lua>" | stop  [--timeout s]');
    process.exit(2);
  }
} catch (e) {
  say(`error: ${e.message}`);
  process.exit(1);
}
