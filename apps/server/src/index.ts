import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { HARV_VERSION, MAX_ATTACHMENT_BYTES, SERVER_PORT, type ClientMessage, type ServerMessage } from '@harv/shared';
import { isValidTab, saveAttachment } from './agent/attachments.ts';
import { loadCatalog } from './agent/catalog.ts';
import { ChatManager } from './agent/manager.ts';
import { findBackground } from './background.ts';
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
  },
  () => routes.summary(),
);
const router = new Router(routes, undefined, () => meter.weeklyPercent());
const chats = new ChatManager(store, gate, router, meter, broadcast, (status) => broadcast({ type: 'harv.status', status }));

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
        send({ type: 'harv.status', status: chats.status });
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
        break;
      case 'chat.open':
        chats.open(msg.tabId);
        break;
      case 'chat.delete':
        chats.delete(msg.tabId);
        break;
      case 'approval.answer':
        gate.answer(msg.id, msg.approve, msg.command);
        break;
      case 'action.undo':
        gate.undo(msg.id);
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
