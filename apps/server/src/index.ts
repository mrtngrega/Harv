import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { HARV_VERSION, MAX_ATTACHMENT_BYTES, SERVER_PORT, terminalId, type ClientMessage, type ServerMessage } from '@harv/shared';
import { isValidTab, saveAttachment } from './agent/attachments.ts';
import { loadCatalog } from './agent/catalog.ts';
import { ChatManager } from './agent/manager.ts';
import { backgroundVersion, findBackground, MAX_BACKGROUND_BYTES, removeBackground, saveBackground } from './background.ts';
import { MetricsCollector } from './metrics/collector.ts';
import { hasBattery } from './metrics/system.ts';
import { ensureLhmRunning } from './metrics/lhmLauncher.ts';
import { stripBilledCredentials } from './env.ts';
import { ensureHarvHome, HARV_HOME } from './paths.ts';
import { isSensitivePath } from './safety/classify.ts';
import { SafetyGate } from './safety/gate.ts';
import { Router } from './router/router.ts';
import { ActionStore } from './store/actions.ts';
import { ChatStore } from './store/chats.ts';
import { RouteStore } from './store/routes.ts';
import { UsageMeter } from './usage/meter.ts';
import { loadSettings, updateSettings, workDir } from './settings.ts';
import { applySharedUi, loadUi, resetUi, saveUi, sharedUi } from './ui.ts';
import { cleanPath, listFolder, openWithDefault, places, previewType, suggestPaths } from './tools/files.ts';
import {
  copyItems,
  deleteForever,
  drives,
  moveItems,
  newFile,
  newFolder,
  properties,
  recentFiles,
  recycle,
  renameItem,
  saveUpload,
  search,
} from './tools/fileOps.ts';
import type { FileOp } from '@harv/shared';
import { IS_WINDOWS, PLATFORM } from './platform.ts';
import { TerminalManager } from './tools/terminal.ts';
import { startWatchdog } from './watchdog/monitor.ts';
import { moveOldReportFile, SyncEngine } from './sync/engine.ts';
import { claudeMemoryDir } from './sync/files.ts';
import { WORKSPACE } from './safety/paths.ts';
import { SyncStore } from './sync/store.ts';
import { LiveLink } from './sync/live.ts';
import { Scheduler } from './schedule/scheduler.ts';

/** The file API's answer for passwords, keys and logins: the same rule as Harv's own tools. */
const SENSITIVE = 'Harv never opens or sends files with passwords, keys or logins (the same rule its own tools follow).';

const removed = stripBilledCredentials();
ensureHarvHome();

/** Sent in hello: the dashboard asks "continue or new session?" once per server start. */
const STARTED_AT = Date.now();
const app = Fastify({ logger: { level: 'info' } });
await app.register(websocket);

if (removed.length > 0) {
  app.log.warn({ removed }, 'Removed API credentials from the environment: Harv is subscription-only');
}

// Only the dashboard itself may talk to Harv. A web page in any browser tab can
// reach 127.0.0.1, so requests (and WebSocket upgrades) from other origins are refused.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${SERVER_PORT}`,
  `http://localhost:${SERVER_PORT}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reply.code(403).send({ error: 'Forbidden origin' });
  // A plain <img> or link from another site sends no Origin, but browsers mark it. Only the dashboard itself may read files.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return reply.code(403).send({ error: 'Forbidden' });
});

// Every connected dashboard window gets every update, so several windows stay in sync.
const clients = new Set<(msg: ServerMessage) => void>();
const broadcast = (msg: ServerMessage) => clients.forEach((send) => send(msg));

const metrics = new MetricsCollector(() => loadSettings().metricsMs);
/** A laptop (asked once at start; false until known). */
let onBattery = false;
void hasBattery().then((b) => (onBattery = b));
// The PC watchdog (Settings › Watchdog): overheating, background hogs, dangerous software.
startWatchdog(metrics, (alert) => {
  app.log.info({ kind: alert.kind, title: alert.title }, 'Watchdog');
  broadcast({ type: 'watchdog.alert', alert });
});
const store = new ChatStore(join(HARV_HOME, 'harv.db'));
const actions = new ActionStore(join(HARV_HOME, 'harv.db'));
actions.markInterrupted();
const gate = new SafetyGate(actions, {
  broadcast,
  notice: (tabId, message) => chats.notice(tabId, message),
  onChange: () => chats.refreshStatus(),
  // Project chats: the project folder is trusted (docs/PLAN.md §6f).
  projectOf: (tabId) => store.projectOf(tabId)?.path,
  projects: () => store.projects().map((p) => p.path),
  // Files and folders the user attached in a chat: trusted there (the user's wish, 2026-10-26).
  attachedOf: (tabId) => store.attachedPaths(tabId),
  allow: (rules) => broadcast({ type: 'settings', settings: updateSettings({ allowRules: [...loadSettings().allowRules, ...rules] }) }),
  onPlanMode: (tabId, on) => chats.planningChanged(tabId, on),
});
const routes = new RouteStore(join(HARV_HOME, 'harv.db'));
const meter = new UsageMeter(
  {
    onChange: (usage) => {
      broadcast({ type: 'usage.update', usage });
      chats.refreshStatus();
    },
    onResume: () => void chats.flushQueue(),
    onWarning: (warning) => {
      broadcast({ type: 'usage.warning', warning });
      // The other device shares the plan: it doesn't need to say the same.
      sync.noteWarned(`${warning.kind}:${warning.threshold}`);
    },
  },
  () => routes.summary(),
  undefined,
  () => {
    const s = loadSettings();
    return { session: s.warnSession, weekly: s.warnWeekly };
  },
);
// Each chat's terminal (its view menu); saved in ~/.harv/terminals across restarts.
const terminals = new TerminalManager(
  {
    data: (id, data) => broadcast({ type: 'term.data', id, data }),
    exit: (id, code) => broadcast({ type: 'term.exit', id, code }),
  },
  join(HARV_HOME, 'terminals'),
  // A project chat's terminal opens in the project.
  (id) => {
    const project = store.projectOf(id.slice('terminal-'.length));
    return project && existsSync(project.path) ? project.path : workDir();
  },
);

const router = new Router(
  routes,
  undefined,
  () => meter.weeklyPercent(),
  () => loadSettings().allowFable,
);
const chats = new ChatManager(
  store,
  gate,
  router,
  meter,
  (msg) => {
    broadcast(msg);
    // A finished reply goes to the other device soon (sync, docs/PLAN.md §6m).
    if (msg.type === 'chat.done') sync.soon();
  },
  (status) => broadcast({ type: 'harv.status', status, detail: chats.statusDetail }),
);
moveOldReportFile();
const syncStore = new SyncStore(join(HARV_HOME, 'harv.db'));
const BACKGROUND = /^background\.(jpg|jpeg|png|webp)$/;
const sync = new SyncEngine(
  HARV_HOME,
  store,
  routes,
  syncStore,
  {
    chats: (changes) => chats.remote(changes),
    settings: (settings) => broadcast({ type: 'settings', settings }),
    status: (status) => broadcast({ type: 'sync.status', status }),
    log: (message, data) => app.log.warn(data ?? {}, message),
    synced: () => void chats.pullProjects(),
    ui: (ui) => {
      chats.applyRemoteUi(ui);
      applySharedUi(ui);
      broadcast({ type: 'ui.synced', ui });
    },
    warned: (key) => meter.markWarned(key),
    projectState: (project, device, unsaved) => chats.peerProjectState(project, device, unsaved),
    fileWritten: (root, path) => {
      if (root === 'home' && BACKGROUND.test(path)) broadcast({ type: 'background', version: backgroundVersion() });
    },
  },
  undefined,
  undefined,
  undefined,
  // Everything else Harv needs on both devices (docs/PLAN.md §6m): each project's Claude Code memory,
  // attachments and Harv's own files, the background photo, and the open tabs with their drafts.
  {
    projectMemory: () =>
      Object.fromEntries(store.projects().flatMap((p) => (existsSync(p.path) ? [[p.name, claudeMemoryDir(p.path)]] : []))),
    folders: {
      workspace: { dir: WORKSPACE, accept: () => true },
      home: { dir: HARV_HOME, accept: (rel) => BACKGROUND.test(rel), beforeWrite: removeBackground, shallow: true },
    },
    ui: sharedUi,
  },
);
chats.onProjectStates = (states) => sync.noteProjectStates(states);
// Live sync over Tailscale (M10c): changes reach the other device in seconds when both are on.
const live = new LiveLink(sync, (message, data) => app.log.warn(data ?? {}, message));
// Scheduled tasks (docs/PLAN.md §6s C4): run by this server, on this device.
const scheduler = new Scheduler(
  join(HARV_HOME, 'harv.db'),
  { run: (task, late) => chats.runScheduled(task, late), broadcast },
  loadSettings().deviceName || hostname(),
);
chats.schedules = scheduler;
// "Reopen tabs" off: Harv starts with no tabs (the chats stay in history).
if (!loadSettings().restoreTabs) {
  for (const c of store.openChats()) store.setOpen(c.id, false);
  resetUi();
}
// Terminals of chats closed while Harv was off aren't coming back.
{
  const live = new Set([...store.openChats().map((c) => c.id), ...loadUi().blanks].map(terminalId));
  terminals.prune((id) => live.has(id));
}

app.get('/api/health', async () => ({ ok: true, version: HARV_VERSION, status: chats.status, home: HARV_HOME }));

app.get('/api/background', async (_req, reply) => {
  const bg = findBackground();
  if (!bg) return reply.code(404).send({ error: 'No background set' });
  return reply.type(bg.contentType).header('Cache-Control', 'no-cache').send(createReadStream(bg.path));
});

// Attachments arrive as the raw file body: POST /api/attachments?tab=<tabId>&name=<file name>.
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES }, (_req, body, done) =>
  done(null, body),
);
app.post<{ Querystring: { tab?: string; name?: string } }>('/api/attachments', async (req, reply) => {
  const { tab = '', name = '' } = req.query;
  if (!isValidTab(tab) || !name || !Buffer.isBuffer(req.body))
    return reply.code(400).send({ error: 'Expected ?tab=&name= and a file body' });
  // A dropped file only comes with its name: still, a key or a .env file never goes to Claude.
  if (isSensitivePath(name)) return reply.code(403).send({ error: SENSITIVE });
  return saveAttachment(tab, name, req.body);
});

// The background picker: the raw image as the body. Saved to ~/.harv, never the repo.
app.post('/api/background', async (req, reply) => {
  if (!Buffer.isBuffer(req.body) || req.body.length > MAX_BACKGROUND_BYTES) {
    return reply.code(400).send({ error: 'Expected an image up to 20 MB' });
  }
  if (!saveBackground(req.body)) return reply.code(415).send({ error: 'Use a JPEG, PNG or WebP image' });
  broadcast({ type: 'background', version: backgroundVersion() });
  return { ok: true };
});
app.delete('/api/background', async () => {
  removeBackground();
  broadcast({ type: 'background', version: null });
  return { ok: true };
});

// The file explorer tab: listings, previews, opening with the default app, and attaching to a chat.
app.get('/api/files/places', async () => places());
// `@` in the command line: files and folders to point Harv at.
app.get('/api/paths', async (req) => suggestPaths(String((req.query as { q?: unknown }).q ?? '')));
app.get<{ Querystring: { path?: string } }>('/api/files/list', async (req, reply) => {
  const path = cleanPath(req.query.path);
  if (!path) return reply.code(400).send({ error: `Expected an absolute path like ${IS_WINDOWS ? 'C:\\Users' : '/home'}` });
  try {
    return listFolder(path);
  } catch (err) {
    return reply
      .code(404)
      .send({ error: (err as NodeJS.ErrnoException).code === 'EPERM' ? 'No permission to open this folder' : 'Folder not found' });
  }
});
app.get<{ Querystring: { path?: string } }>('/api/files/raw', async (req, reply) => {
  const path = cleanPath(req.query.path);
  if (!path) return reply.code(400).send({ error: 'Bad path' });
  if (isSensitivePath(path)) return reply.code(403).send({ error: SENSITIVE });
  try {
    if (!statSync(path).isFile()) return reply.code(400).send({ error: 'Not a file' });
  } catch {
    return reply.code(404).send({ error: 'File not found' });
  }
  // Anything that isn't an image, PDF or media file is plain text: no sniffing, and a sandbox in case
  // the browser renders it anyway. (Chrome's PDF viewer won't run in a sandbox, so PDFs skip it.)
  const preview = previewType(path);
  reply.type(preview.mime).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
  if (preview.kind === 'text') reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
  return reply.send(createReadStream(path));
});
app.post<{ Body: { path?: string; reveal?: boolean } }>('/api/files/open', async (req, reply) => {
  const path = cleanPath(req.body?.path);
  if (!path) return reply.code(400).send({ error: 'Bad path' });
  openWithDefault(path, req.body?.reveal === true);
  return { ok: true };
});
app.post<{ Body: { path?: string; tab?: string } }>('/api/files/attach', async (req, reply) => {
  const path = cleanPath(req.body?.path);
  const tab = req.body?.tab ?? '';
  if (!path || !isValidTab(tab)) return reply.code(400).send({ error: 'Bad path or tab' });
  if (isSensitivePath(path)) return reply.code(403).send({ error: SENSITIVE });
  try {
    const st = statSync(path);
    if (!st.isFile()) return reply.code(400).send({ error: 'Not a file' });
    if (st.size > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: 'Bigger than 32 MB' });
    return saveAttachment(tab, basename(path), readFileSync(path));
  } catch {
    return reply.code(404).send({ error: 'File not found' });
  }
});

app.get('/api/files/drives', async () => drives());
app.get('/api/files/recent', async () => recentFiles());
app.get<{ Querystring: { path?: string; q?: string } }>('/api/files/search', async (req, reply) => {
  const path = cleanPath(req.query.path);
  if (!path || !req.query.q) return reply.code(400).send({ error: 'Expected a folder and words to search for' });
  return search(path, req.query.q);
});
app.get<{ Querystring: { path?: string } }>('/api/files/props', async (req, reply) => {
  const path = cleanPath(req.query.path);
  if (!path) return reply.code(400).send({ error: 'Bad path' });
  try {
    return properties(path);
  } catch {
    return reply.code(404).send({ error: 'Not found' });
  }
});
// Changes from the explorer: new, rename, copy, move, Recycle Bin, delete for good.
app.post<{ Body: FileOp }>('/api/files/op', async (req, reply) => {
  const body = req.body;
  const paths = (list: unknown) => (Array.isArray(list) ? list.map(cleanPath) : []);
  try {
    switch (body?.op) {
      case 'newFolder':
      case 'newFile': {
        const dir = cleanPath(body.dir);
        if (!dir) break;
        return { paths: [body.op === 'newFolder' ? newFolder(dir) : newFile(dir)], errors: [] };
      }
      case 'rename': {
        const path = cleanPath(body.path);
        if (!path || typeof body.name !== 'string') break;
        return { paths: [renameItem(path, body.name.trim())], errors: [] };
      }
      case 'copy':
      case 'move': {
        const list = paths(body.paths);
        const dest = cleanPath(body.dest);
        if (!dest || !list.length || list.some((p) => !p)) break;
        return (body.op === 'copy' ? copyItems : moveItems)(list as string[], dest);
      }
      case 'recycle':
      case 'deleteForever': {
        const list = paths(body.paths);
        // Never a whole drive (or the Linux root).
        if (!list.length || list.some((p) => !p || p === '/' || /^[a-z]:\\?$/i.test(p))) break;
        return body.op === 'recycle' ? await recycle(list as string[]) : deleteForever(list as string[]);
      }
    }
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
  return reply.code(400).send({ error: 'Bad request' });
});
// Files dropped into the explorer from Windows: the raw file as the body.
app.post<{ Querystring: { dir?: string; name?: string } }>('/api/files/upload', async (req, reply) => {
  const dir = cleanPath(req.query.dir);
  if (!dir || !req.query.name || !Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'Expected ?dir=&name= and a file body' });
  try {
    return { path: saveUpload(dir, req.query.name, req.body) };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// Lets the dashboard retry starting the sensors (e.g. after the UAC prompt was declined).
app.post('/api/sensors/start', async () => ({ result: await ensureLhmRunning() }));

// Stopping and restarting Harv (scripts/harv.ps1, harv.sh on Linux, the desktop shortcuts and Settings' Restart button).
const HARV_SCRIPT = fileURLToPath(new URL('../../../scripts/harv.ps1', import.meta.url));
const HARV_SH = fileURLToPath(new URL('../../../scripts/harv.sh', import.meta.url));
const shutdown = (reason: string) => {
  app.log.info({ reason }, 'Shutting down');
  setTimeout(() => {
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }, 200);
};
app.post('/api/shutdown', async () => {
  shutdown('asked to stop');
  return { ok: true };
});
app.post('/api/restart', async () => {
  if (!IS_WINDOWS) {
    // Its own session (setsid), so stopping Harv doesn't stop the script; it waits, then starts Harv again.
    spawn('setsid', ['bash', HARV_SH, 'restart', '--delay', '2', '--no-browser'], { detached: true, stdio: 'ignore' }).unref();
    shutdown('restarting');
    return { ok: true };
  }
  // `start` detaches the script from Harv's process tree, so stopping Harv doesn't stop it; it waits, then starts Harv again.
  // Passed verbatim: Node would otherwise escape start's empty "" window title and break the command.
  const command = `start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${HARV_SCRIPT}" -Action restart -Delay 2 -NoBrowser`;
  spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
  shutdown('restarting');
  return { ok: true };
});

app.get('/ws', { websocket: true }, (socket) => {
  const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
  clients.add(send);
  send({
    type: 'hello',
    version: HARV_VERSION,
    status: chats.status,
    metrics: metrics.latest,
    catalog: chats.catalog,
    chats: chats.openChats(),
    history: chats.history(),
    approvals: gate.approvals(),
    actions: actions.recent(30),
    usage: meter.snapshot(),
    settings: loadSettings(),
    background: backgroundVersion(),
    ui: loadUi(),
    projects: store.projects(),
    platform: PLATFORM,
    battery: onBattery,
    startedAt: STARTED_AT,
    sync: sync.status(),
    schedules: scheduler.list(),
  });

  const unsubscribe = metrics.onSnapshot((snapshot) => send({ type: 'metrics.tick', metrics: snapshot }));
  socket.on('close', () => {
    unsubscribe();
    clients.delete(send);
  });

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ping':
        send({ type: 'harv.status', status: chats.status, detail: chats.statusDetail });
        break;
      case 'chat.send':
        void chats.send(msg.tabId, msg.text, msg.model, msg.effort, msg.attachments);
        break;
      case 'chat.stop':
        void chats.stop(msg.tabId);
        break;
      case 'chat.stopTask':
        void chats.stopTask(msg.tabId, msg.taskId).catch(() => {});
        break;
      case 'chat.unqueue':
        chats.unqueue(msg.tabId, msg.id);
        break;
      case 'chat.sendNow':
        void chats.sendNow(msg.tabId, msg.id);
        break;
      case 'chat.harder':
        void chats.harder(msg.tabId);
        break;
      case 'chat.close':
        chats.close(msg.tabId);
        terminals.close(terminalId(msg.tabId));
        break;
      case 'chat.open':
        chats.open(msg.tabId);
        break;
      case 'chat.delete':
        chats.delete(msg.tabId);
        terminals.close(terminalId(msg.tabId));
        break;
      case 'chat.rename':
        chats.rename(msg.tabId, msg.title);
        break;
      case 'schedule.cancel':
        scheduler.cancel(String(msg.id));
        break;
      case 'chat.plan':
        chats.setPlanning(msg.tabId, msg.on === true);
        break;
      case 'chat.rewind':
        void chats.rewind(msg.tabId, Number(msg.fromEnd) || 0);
        break;
      case 'approval.answer':
        gate.answer(msg.id, msg.approve, msg.command, msg.always === true, msg.all === true, {
          ...(msg.answers && typeof msg.answers === 'object' ? { answers: msg.answers } : {}),
          ...(typeof msg.why === 'string' ? { why: msg.why.slice(0, 4000) } : {}),
        });
        break;
      case 'action.undo':
        gate.undo(msg.id);
        break;
      case 'project.add': {
        const error = typeof msg.path === 'string' ? chats.addProject(msg.path, msg.name) : 'No folder given.';
        if (error) send({ type: 'project.error', message: error });
        break;
      }
      case 'project.remove':
        chats.removeProject(msg.id);
        break;
      case 'chat.setProject': {
        const error = chats.setProject(msg.tabId, msg.projectId);
        if (error) send({ type: 'project.error', message: error });
        break;
      }
      case 'ui.save':
        saveUi(chats.keepRemoteTabs(msg.state));
        live.soon();
        break;
      case 'term.attach': {
        try {
          const replay = terminals.attach(msg.id, cleanPath(msg.cwd) ?? undefined);
          if (replay) send({ type: 'term.data', id: msg.id, data: replay.data, reset: true, restored: replay.restored });
        } catch (err) {
          app.log.error({ err: (err as Error).message }, 'Could not start a terminal');
        }
        break;
      }
      case 'term.close':
        terminals.close(msg.id);
        break;
      case 'term.input':
        if (typeof msg.data === 'string') terminals.input(msg.id, msg.data);
        break;
      case 'term.resize':
        terminals.resize(msg.id, msg.cols, msg.rows);
        break;
      case 'settings.update':
        broadcast({ type: 'settings', settings: updateSettings(msg.patch) });
        break;
      case 'sync.now':
        void sync.now();
        break;
      case 'history.search':
        send({ type: 'history', items: chats.history(msg.query), query: msg.query });
        break;
    }
  });
});

app.addHook('onClose', async () => {
  metrics.stop();
  meter.stop();
  sync.stop();
  live.stop();
  scheduler.stop();
  terminals.closeAll();
  chats.closeAll();
  store.close();
  actions.close();
  syncStore.close();
});

// Claude Code subprocesses would otherwise keep the process alive on restart (tsx watch hangs).
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'Shutting down');
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// Localhost only: Harv controls this PC, so it must never be reachable from the network.
await app.listen({ host: '127.0.0.1', port: SERVER_PORT });
await metrics.start();
// After the catalog had a moment: a run missed while Harv was off happens now, once.
setTimeout(() => scheduler.start(), 5000).unref();

// LibreHardwareMonitor starts with Harv (Settings › Startup, or HARV_START_LHM=0, turns that off).
if (process.env.HARV_START_LHM !== '0' && loadSettings().startSensors) {
  void ensureLhmRunning().then((result) => app.log.info({ result }, 'LibreHardwareMonitor'));
}

// The plan and model names. Harv may start before Claude Code is logged in (a new machine), so
// without a plan it asks again: after 1 minute, then 2, 4… up to every 15 (no tokens, a short-lived process).
let catalogTries = 0;
const refreshCatalog = () => {
  const retry = () => setTimeout(refreshCatalog, Math.min(60_000 * 2 ** catalogTries++, 15 * 60_000)).unref();
  loadCatalog()
    .then((catalog) => {
      chats.catalog = catalog;
      broadcast({ type: 'catalog', catalog });
      app.log.info({ plan: catalog.plan, models: catalog.models.map((m) => m.id) }, 'Claude models');
      if (!catalog.plan) retry();
    })
    .catch((err: Error) => {
      app.log.error({ err: err.message }, 'Could not load Claude models');
      retry();
    });
};
refreshCatalog();

// Plan usage: /usage now and every 10 minutes (no tokens), plus live rate-limit events.
meter.start();

// Sync with the user's other devices (Settings › Sync): pull and push now and every 2 minutes.
// Projects with a GitHub repo go along (docs/PLAN.md §6n): note the remotes of ones added before, then sync.
void chats.noteRemotes().finally(() => sync.start());
if (process.env.HARV_LIVE !== '0' && loadSettings().syncEnabled) void live.start();
