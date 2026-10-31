// Reads the lights Harv controls on this computer and (with --touch) sends a change that keeps the
// first one as it is (proves writing works without a visible change). docs/PLAN.md §6z.
import { createRequire } from 'node:module';

const WebSocket = createRequire(import.meta.url)('ws');
const ws = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:5173' } });
await new Promise((r) => ws.once('open', r));
const next = (test, ms = 30000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'lights' && test(m.status)) {
        clearTimeout(t);
        resolve(m.status);
      }
    });
  });
ws.send(JSON.stringify({ type: 'lights.get' }));
const read = await next((s) => s.lights.every((l) => l.at));
const line = (l) =>
  `${l.name}: ${l.reachable ? (l.on ? `on ${l.brightness}% ${l.temp ? `${l.temp}K` : `hue ${l.hue}`}` : 'off') : `unreachable (${l.error})`}`;
console.log('setup:', read?.setup, '|', read?.lights.map(line).join('; ') || 'no lights', read?.problem ? `| ${read.problem}` : '');
if (process.argv.includes('--touch') && read?.lights[0]?.reachable) {
  const l = read.lights[0];
  const since = Date.now();
  ws.send(JSON.stringify({ type: 'lights.set', id: l.id, change: { brightness: l.brightness } }));
  const after = await next((s) => s.lights[0]?.at > since);
  console.log('after a no-change write:', after ? line(after.lights[0]) : 'NO ANSWER');
}
ws.close();
