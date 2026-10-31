import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {
  HARV_VERSION,
  HISTORY_QUERY_MAX,
  MAX_ATTACHMENT_BYTES,
  SERVER_PORT,
  terminalId,
  type ClientMessage,
  type ServerMessage,
} from '@harv/shared';
import { isValidTab, saveAttachment } from './agent/attachments.ts';
import { loadCatalog } from './agent/catalog.ts';
import { findTab, type OpenTab } from './agent/chatTools.ts';
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
import { loadSettings, onSettingsChange, updateSettings, workDir } from './settings.ts';
import { phoneOf, PhoneService } from './phone/service.ts';
import { keepBackup, listBackups, pruneBackups } from './safety/backup.ts';
import { applySharedUi, loadUi, resetUi, saveUi, sharedUi } from './ui.ts';
import { BrowserHost } from './tools/browserHost.ts';
import { GeminiImages, GeminiProblem } from './tools/gemini.ts';
import { DeviceStore } from './devices/store.ts';
import { LightsService } from './devices/lights.ts';
import { lightTools } from './devices/tools.ts';
import { AutoLights, findPlace } from './devices/autoLights.ts';
import { malformed } from './wsInput.ts';
import { HarvBrowser } from './tools/harvBrowser.ts';
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
import type { FileOp, UiState } from '@harv/shared';
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

// Harv runs without auto-restart, so a stray error must be logged, never the end of the server.
process.on('uncaughtException', (err) => app.log.error({ err: err.message, stack: err.stack }, 'Uncaught error'));
process.on('unhandledRejection', (reason) =>
  app.log.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled rejection'),
);
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
// DNS rebinding: a page on evil.example can point its name at 127.0.0.1 and then make "same-origin"
// requests here. Its requests still carry its own name in Host, so only Harv's own names get in.
const ALLOWED_HOSTS = new Set([...ALLOWED_ORIGINS].map((o) => new URL(o).host));
app.addHook('onRequest', async (req, reply) => {
  const host = (req.headers.host ?? '').toLowerCase();
  // The phone address (`tailscale serve`, docs/PLAN.md §6q) has its own, stricter check: a paired phone with Face ID.
  if (!ALLOWED_HOSTS.has(host) && phone?.isPhoneHost(host)) {
    if (!phone.check(req, reply)) return reply;
    return;
  }
  if (!ALLOWED_HOSTS.has(host)) return reply.code(403).send({ error: 'Forbidden host' });
  // Came through `tailscale serve` but names a local host (a proxy that rewrote Host): never treat it as the PC's own dashboard.
  if (req.headers['tailscale-user-login'] || req.headers['x-forwarded-for']) return reply.code(403).send({ error: 'Forbidden' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reply.code(403).send({ error: 'Forbidden origin' });
  // A plain <img> or link from another site sends no Origin, but browsers mark it. Only the dashboard itself may read files.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return reply.code(403).send({ error: 'Forbidden' });
});

// Every connected dashboard window gets every update, so several windows stay in sync.
const clients = new Set<(msg: ServerMessage) => void>();
const broadcast = (msg: ServerMessage) => {
  clients.forEach((send) => send(msg));
  // Some events also go to the phone as a notification (docs/PLAN.md §6q).
  phone?.observe(msg);
};
// eslint-disable-next-line prefer-const -- made further down, once the chats and sync exist
let phone: PhoneService | undefined;

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

// Backups for Undo don't pile up: older than Settings › Safety's days, or over its size cap, they go (oldest first).
function cleanBackups() {
  try {
    const { backupDays, backupMaxGb } = loadSettings();
    const done = pruneBackups(backupDays, backupMaxGb * 1024 ** 3);
    if (!done.removed.length) return;
    actions.forgetBackups(done.removed);
    app.log.info(
      { removed: done.removed.length, freedMb: Math.round(done.freedBytes / 1024 ** 2), keptMb: Math.round(done.keptBytes / 1024 ** 2) },
      'Old backups cleaned up',
    );
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'Backup cleanup failed');
  }
}
setTimeout(cleanBackups, 60_000).unref();
setInterval(cleanBackups, 6 * 60 * 60 * 1000).unref();
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
      if (root === 'home' && path === 'devices.json') void lights.refresh();
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
      // The background photo, and devices.json (the Tapo login and chosen lights, docs/PLAN.md §6z), sealed with the sync key.
      home: {
        dir: HARV_HOME,
        accept: (rel) => BACKGROUND.test(rel) || rel === 'devices.json',
        beforeWrite: (rel) => BACKGROUND.test(rel) && removeBackground(),
        secret: (rel) => rel === 'devices.json',
        shallow: true,
      },
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
// Harv on the phone (docs/PLAN.md §6q): `tailscale serve`, pairing, Face ID, push, Siri and the share sheet.
const deviceLabel = () => loadSettings().deviceName || hostname();
phone = new PhoneService({
  enabled: () => loadSettings().phoneAccess,
  deviceName: deviceLabel,
  broadcast,
  log: (message) => app.log.warn(message),
  phoneTab: () => `phone-${sync.status().device.id}`,
  ask: (tabId, text, files, waitMs) => chats.askSpoken(tabId, 'Phone', text, files, waitMs),
  saveFile: (tabId, name, data) => saveAttachment(tabId, name, data),
  send: (tabId, text, files) => chats.send(tabId, text, 'auto', 'medium', files),
  title: (tabId) => store.title(tabId) ?? 'Chat',
  openChat: (tabId) => chats.ensureOpen(tabId, 'Phone'),
});
phone.routes(app);
void phone.refresh();
chats.phone = {
  notify: async (tabId, title, body, talk) => {
    const sent = await phone!.notify({ title, body, tabId, talk, tag: talk ? `talk-${tabId}` : undefined });
    return sent
      ? `Sent to ${sent} phone${sent > 1 ? 's' : ''}.`
      : 'No phone gets notifications yet: the user turns them on in the Harv app on the phone (Settings › Phone).';
  },
};
onSettingsChange((before, after) => {
  if (before.phoneAccess !== after.phoneAccess) void phone?.refresh();
});
// Harv's terminal_run / terminal_read: the chat's own terminal, shown in the dashboard while Harv uses it.
// Harv's generate_image: pictures from the Gemini website on Harv's own Chrome profile (docs/PLAN.md §6w).
const gemini = new GeminiImages();
const devices = new DeviceStore();
// The user's Tapo light strip (docs/PLAN.md §6z): read every 30 s while a dashboard is open.
const lights = new LightsService(devices, {
  broadcast: (status) => broadcast({ type: 'lights', status }),
  log: (message) => app.log.warn(message),
  watchers: () => clients.size,
});
lights.start();
chats.lights = lightTools(lights);
// Automatic lights: on when it's dark outside and the user is at this computer (docs/PLAN.md §6z).
const autoLights = new AutoLights(lights, {
  settings: loadSettings,
  log: (message) => app.log.info(message),
  changed: () => lights.publish(),
});
lights.autoStatus = () => autoLights.status();
autoLights.start();
chats.images = {
  async generate(prompt, images) {
    try {
      const { paths, text } = await gemini.generate(prompt, images);
      const said = text ? `\n\nGemini said: ${text.slice(0, 800)}` : '';
      const saved = paths.length === 1 ? 'the picture' : `${paths.length} pictures`;
      return `Saved ${saved}:\n${paths.join('\n')}${said}\n\nName the full path in your reply so it shows in the chat.`;
    } catch (err) {
      if (err instanceof GeminiProblem && err.message === 'signed-out') {
        await gemini.openSignIn().catch(() => undefined);
        return "Gemini isn't signed in yet. I opened a Chrome window with Gemini: the user signs in there once with the Google account they keep for pictures, then closes the window and asks again. (Settings › This computer › Pictures opens it too.)";
      }
      if (err instanceof GeminiProblem) return err.message;
      return `Gemini didn't work: ${(err as Error).message}`;
    }
  },
};
// Harv's browser (docs/PLAN.md §6x): in the app, driven through its dashboard's connection.
const browserHost = new BrowserHost();
/** How long the browser tab says "Harv is using the browser" after Harv's last action. */
const BROWSER_BUSY_MS = 6000;
chats.browser = new HarvBrowser(browserHost, () => broadcast({ type: 'browser.busy', until: Date.now() + BROWSER_BUSY_MS }));
/** The open chats (saved ones and blank tabs), for using another chat's terminal. */
const openTabs = (): OpenTab[] => {
  const ui = loadUi();
  const tab = (id: string, title: string) => ({ id, title, terminal: ui.views[id] === 'terminal' });
  return [...store.openChats().map((c) => tab(c.id, c.title)), ...ui.blanks.map((id) => tab(id, 'New chat'))];
};
/** The chat whose terminal a call means: this one, or the one `chat` names (an error text if unclear). */
const terminalTab = (tabId: string, chat?: string): { id: string; note: string } | string => {
  if (!chat) return { id: tabId, note: '' };
  const found = findTab(chat, openTabs(), tabId);
  return typeof found === 'string' ? found : { id: found.id, note: found.id === tabId ? '' : ` (in "${found.title}")` };
};
chats.terminal = {
  async run(tabId, command, opts) {
    const target = terminalTab(tabId, opts.chat);
    if (typeof target === 'string') return target;
    broadcast({ type: 'term.show', tabId: target.id });
    const cwd = opts.cwd ? (cleanPath(opts.cwd) ?? undefined) : undefined;
    const r = await terminals.run(terminalId(target.id), command, { ...opts, cwd });
    const state = r.exited
      ? 'The shell has exited (a new one starts on the next terminal_run).'
      : r.running
        ? 'Still printing when the wait ended: it keeps running in the terminal; terminal_read shows more later.'
        : 'The output went quiet (finished, or waiting for input).';
    return `${r.output || '(no output)'}\n\n[${state}${target.note}]`;
  },
  read(tabId, lines, chat) {
    const target = terminalTab(tabId, chat);
    if (typeof target === 'string') return target;
    return terminals.read(terminalId(target.id), lines) ?? "That chat's terminal isn't open; terminal_run starts it.";
  },
};
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
  if (isSensitivePath(path)) return reply.code(403).send({ error: SENSITIVE });
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
// Settings › Safety › Backups: every backup, and "keep forever" (the cleanup skips kept ones).
app.get('/api/backups', async () => ({ backups: listBackups() }));
app.post('/api/backups/keep', async (req, reply) => {
  const { name, keep } = (req.body ?? {}) as { name?: unknown; keep?: unknown };
  if (typeof name !== 'string' || typeof keep !== 'boolean' || !keepBackup(name, keep)) {
    return reply.code(400).send({ error: 'No such backup' });
  }
  return { ok: true };
});
// Settings › Devices: the Tapo account login for the user's lights (docs/PLAN.md §6z). The password goes in, never out.
app.get('/api/devices', async () => devices.summary());
// Settings › Devices › Install: the light helper's venv with the reviewed python-kasa (once per computer).
// Settings › Devices › Automatic lights: the place the weather is read for, found by name.
app.post('/api/devices/place', async (req, reply) => {
  const { name } = (req.body ?? {}) as { name?: unknown };
  if (typeof name !== 'string' || !name.trim()) return reply.code(400).send({ error: 'Type a town or village.' });
  try {
    const found = await findPlace(name);
    if (!found) return reply.code(404).send({ error: `Couldn’t find “${name.trim()}”.` });
    broadcast({ type: 'settings', settings: updateSettings({ autoLightsPlace: found }) });
    void autoLights.tick();
    return { place: found };
  } catch (err) {
    return reply.code(502).send({ error: `The place search didn’t answer: ${(err as Error).message}` });
  }
});
// The Harv app hears Windows going to sleep, shutting down or logging off: a light automatic lights
// turned on goes off first, or it stays on all night (docs/PLAN.md §6z).
app.post('/api/lights/leaving', async (req) => {
  const { why } = (req.body ?? {}) as { why?: unknown };
  const reason =
    why === 'shutdown' ? 'the computer is shutting down' : why === 'logoff' ? 'you signed out' : 'the computer is going to sleep';
  return { off: await autoLights.leaving(reason) };
});
app.post('/api/devices/setup', async () => {
  void lights.install().then(() => lights.scan());
  return { ok: true };
});
app.post('/api/devices/tapo', async (req, reply) => {
  const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
  if (email === null) {
    devices.setTapo(null);
    return devices.summary();
  }
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim()) || typeof password !== 'string' || !password) {
    return reply.code(400).send({ error: 'Type the email and password of your Tapo account.' });
  }
  devices.setTapo({ email, password });
  void lights.refresh();
  return devices.summary();
});
// Settings › This computer › Pictures: Gemini in a window on Harv's profile, to sign in once.
app.post('/api/gemini/signin', async (_req, reply) => {
  try {
    await gemini.openSignIn();
    return { ok: true };
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

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

app.get('/ws', { websocket: true }, (socket, req) => {
  const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
  /** This window is a paired phone (docs/PLAN.md §6q). */
  const phoneId = phoneOf(req);
  const fromPhone = !!phoneId;
  const detachPhone = phoneId ? phone?.attachSocket(phoneId, () => socket.close(4401, 'revoked')) : undefined;
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
    browserHost.detach(send);
    phone?.setVisible(send, false);
    detachPhone?.();
  });

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    const bad = malformed(msg);
    if (bad) {
      app.log.warn({ type: (msg as { type?: unknown } | null)?.type, why: bad }, 'A malformed dashboard message was dropped');
      return;
    }
    // A phone's Face ID unlock ends after 30 minutes idle; each message keeps it alive.
    if (phoneId && !phone?.stillUnlocked(phoneId, req.headers.cookie)) return socket.close(4401, 'locked');
    // One bad message must never take Harv down (it doesn't restart by itself): log it and go on.
    try {
      handle(msg);
    } catch (err) {
      app.log.error({ err: (err as Error).message, type: msg.type }, 'A dashboard message failed');
    }
  });

  function handle(msg: ClientMessage) {
    switch (msg.type) {
      case 'ping':
        send({ type: 'harv.status', status: chats.status, detail: chats.statusDetail });
        break;
      case 'browser.hello':
        browserHost.attach(send);
        break;
      case 'browser.result':
        browserHost.result(msg.reqId, msg.ok, msg.value, msg.error);
        break;
      case 'phone.visible':
        if (fromPhone) phone?.setVisible(send, msg.visible === true);
        break;
      case 'phone.list':
        phone?.publish();
        break;
      case 'phone.revoke':
        phone?.revoke(String(msg.id));
        break;
      case 'phone.rename':
        phone?.phones.rename(String(msg.id), String(msg.name));
        phone?.publish();
        break;
      case 'chat.send':
        if (fromPhone) phone?.markPhoneTurn(msg.tabId);
        void chats.send(msg.tabId, msg.text, msg.model, msg.effort, msg.attachments, msg.spoken === true);
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
      case 'chat.load': {
        const chat = chats.openChats().find((c) => c.id === msg.tabId);
        if (chat) send({ type: 'chat.opened', chat, focus: false });
        break;
      }
      case 'chat.delete':
        chats.delete(msg.tabId);
        terminals.close(terminalId(msg.tabId));
        break;
      case 'chat.rename':
        if (typeof msg.title === 'string') chats.rename(msg.tabId, msg.title);
        break;
      case 'schedule.cancel':
        scheduler.cancel(String(msg.id));
        break;
      case 'lights.get':
        send({ type: 'lights', status: lights.status() });
        void lights.refresh();
        break;
      case 'lights.scan':
        void lights.scan();
        break;
      case 'lights.choose':
        if (typeof msg.id === 'string') void lights.choose(msg.id, msg.chosen === true);
        break;
      case 'lights.set':
        if (typeof msg.id === 'string' && msg.change && typeof msg.change === 'object')
          void lights
            .set(msg.id, msg.change)
            .catch((err: Error) => send({ type: 'lights', status: { ...lights.status(), problem: err.message } }));
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
      case 'ui.save': {
        const shared = ({ order, blanks, drafts, attachments, tools, views }: UiState) =>
          JSON.stringify({ order, blanks, drafts, attachments, tools, views });
        const before = shared(loadUi());
        const state = chats.keepRemoteTabs(msg.state);
        // Every open chat is a tab: one this window hasn't heard of yet (another window just made it)
        // stays in the order, and this window gets it.
        const unknown = chats.openChats().filter((c) => !state.order.includes(c.id));
        for (const chat of unknown) send({ type: 'chat.opened', chat, focus: false });
        saveUi(unknown.length ? { ...state, order: [...state.order, ...unknown.map((c) => c.id)] } : state);
        const after = loadUi();
        // The other windows of this Harv (the phone, the app, a browser) show the same tabs: one Harv, not one per window.
        if (shared(after) !== before) {
          const { order, blanks, drafts, attachments, tools, views } = after;
          for (const other of clients)
            if (other !== send) other({ type: 'ui.synced', ui: { order, blanks, drafts, attachments }, windows: { tools, views } });
        }
        live.soon();
        break;
      }
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
        if (!msg.patch || typeof msg.patch !== 'object') break;
        broadcast({ type: 'settings', settings: updateSettings(msg.patch) });
        // Automatic lights switched on (or tuned): check at once instead of within the minute.
        if (Object.keys(msg.patch).some((k) => k.startsWith('autoLights'))) void autoLights.tick();
        break;
      case 'sync.now':
        void sync.now();
        break;
      case 'history.search': {
        const query = typeof msg.query === 'string' ? msg.query.slice(0, HISTORY_QUERY_MAX) : '';
        send({ type: 'history', items: chats.history(query), query });
        break;
      }
    }
  }
});

app.addHook('onClose', async () => {
  metrics.stop();
  meter.stop();
  sync.stop();
  live.stop();
  scheduler.stop();
  terminals.closeAll();
  gemini.close();
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
