import { createReadStream } from 'node:fs';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { HARV_VERSION, SERVER_PORT, type ClientMessage, type HarvStatus, type ServerMessage } from '@harv/shared';
import { findBackground } from './background.ts';
import { MetricsCollector } from './metrics/collector.ts';
import { stripBilledCredentials } from './env.ts';
import { ensureHarvHome, HARV_HOME } from './paths.ts';

const removed = stripBilledCredentials();
ensureHarvHome();

const app = Fastify({ logger: { level: 'info' } });
await app.register(websocket);

if (removed.length > 0) {
  app.log.warn({ removed }, 'Removed API credentials from the environment: Harv is subscription-only');
}

const status: HarvStatus = 'idle';

app.get('/api/health', async () => ({ ok: true, version: HARV_VERSION, status, home: HARV_HOME }));

app.get('/api/background', async (_req, reply) => {
  const bg = findBackground();
  if (!bg) return reply.code(404).send({ error: 'No background set' });
  return reply.type(bg.contentType).header('Cache-Control', 'no-cache').send(createReadStream(bg.path));
});

const metrics = new MetricsCollector();

app.get('/ws', { websocket: true }, (socket) => {
  const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
  send({ type: 'hello', version: HARV_VERSION, status, metrics: metrics.latest });

  const unsubscribe = metrics.onSnapshot((snapshot) => send({ type: 'metrics.tick', metrics: snapshot }));
  socket.on('close', unsubscribe);

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === 'ping') send({ type: 'harv.status', status });
  });
});

app.addHook('onClose', async () => metrics.stop());

// Localhost only: Harv controls this PC, so it must never be reachable from the network.
await app.listen({ host: '127.0.0.1', port: SERVER_PORT });
await metrics.start();
