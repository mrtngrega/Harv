import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { HARV_VERSION, MAX_ATTACHMENT_BYTES, SERVER_PORT, terminalId, type ClientMessage, type ServerMessage } from '@harv/shared';
import { isValidTab, saveAttachment } from './agent/attachments.ts';
import { loadCatalog } from './agent/catalog.ts';
import { ChatManager } from './agent/manager.ts';
import { backgroundVersion, findBackground, MAX_BACKGROUND_BYTES, removeBackground, saveBackground } from './background.ts';
import { MetricsCollector } from './metrics/collector.ts';
import { ensureLhmRunning } from './metrics/lhmLauncher.ts';
import { stripBilledCredentials } from './env.ts';
import { ensureHarvHome, HARV_HOME } from './paths.ts';
import { SafetyGate } from './safety/gate.ts';
import { Router } from './router/router.ts';
import { ActionStore } from './store/actions.ts';
import { ChatStore } from './store/chats.ts';
import { RouteStore } from './store/routes.ts';
import { UsageMeter } from './usage/meter.ts';
import { loadSettings, updateSettings } from './settings.ts';
import { loadUi, saveUi } from './ui.ts';
import { cleanPath, listFolder, openWithDefault, places, previewType } from './tools/files.ts';
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
import { TerminalManager } from './tools/terminal.ts';

const removed = stripBilledCredentials();
ensureHarvHome();

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

const metrics = new MetricsCollector();
const store = new ChatStore(join(HARV_HOME, 'harv.db'));
const actions = new ActionStore(join(HARV_HOME, 'harv.db'));
actions.markInterrupted();
const gate = new SafetyGate(actions, {
  broadcast,
  notice: (tabId, message) => chats.notice(tabId, message),
  onChange: () => chats.refreshStatus(),
});
const routes = new RouteStore(join(HARV_HOME, 'harv.db'));
const meter = new UsageMeter(
  {
    onChange: (usage) => {
      broadcast({ type: 'usage.update', usage });
      chats.refreshStatus();
    },
    onResume: () => void chats.flushQueue(),
    onWarning: (warning) => broadcast({ type: 'usage.warning', warning }),
  },
  () => routes.summary(),
);
// Each chat's terminal (its view menu); saved in ~/.harv/terminals across restarts.
const terminals = new TerminalManager(
  {
    data: (id, data) => broadcast({ type: 'term.data', id, data }),
    exit: (id, code) => broadcast({ type: 'term.exit', id, code }),
  },
  join(HARV_HOME, 'terminals'),
);

const router = new Router(
  routes,
  undefined,
  () => meter.weeklyPercent(),
  () => loadSettings().allowFable,
);
const chats = new ChatManager(store, gate, router, meter, broadcast, (status) =>
  broadcast({ type: 'harv.status', status, detail: chats.statusDetail }),
);
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
app.get<{ Querystring: { path?: string } }>('/api/files/list', async (req, reply) => {
  const path = cleanPath(req.query.path);
  if (!path) return reply.code(400).send({ error: 'Expected an absolute path like C:\\Users' });
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
        // Never a whole drive.
        if (!list.length || list.some((p) => !p || /^[a-z]:\\?$/i.test(p))) break;
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
      case 'approval.answer':
        gate.answer(msg.id, msg.approve, msg.command);
        break;
      case 'action.undo':
        gate.undo(msg.id);
        break;
      case 'ui.save':
        saveUi(msg.state);
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
      case 'history.search':
        send({ type: 'history', items: chats.history(msg.query), query: msg.query });
        break;
    }
  });
});

app.addHook('onClose', async () => {
  metrics.stop();
  meter.stop();
  terminals.closeAll();
  chats.closeAll();
  store.close();
  actions.close();
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

// LibreHardwareMonitor starts with Harv (set HARV_START_LHM=0 to skip).
if (process.env.HARV_START_LHM !== '0') {
  void ensureLhmRunning().then((result) => app.log.info({ result }, 'LibreHardwareMonitor'));
}

loadCatalog()
  .then((catalog) => {
    chats.catalog = catalog;
    broadcast({ type: 'catalog', catalog });
    app.log.info({ plan: catalog.plan, models: catalog.models.map((m) => m.id) }, 'Claude models');
  })
  .catch((err: Error) => app.log.error({ err: err.message }, 'Could not load Claude models'));

// Plan usage: /usage now and every 10 minutes (no tokens), plus live rate-limit events.
meter.start();
