// Prints the Claude plan meters the running Harv server knows (uses no tokens).
//   node scripts/ui-check/usage.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:5173' } });
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== 'hello') return;
  for (const meter of m.usage.meters) {
    const reset = meter.resetsAt
      ? new Date(meter.resetsAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : '?';
    console.log(`${meter.label}: ${meter.percent}% (resets ${reset})`);
  }
  const at = m.usage.fetchedAt ? new Date(m.usage.fetchedAt).toLocaleTimeString('en-GB') : 'not yet';
  console.log(`checked ${at}; paused: ${m.usage.pausedUntil ? 'yes' : 'no'}`);
  process.exit(0);
});
ws.on('error', (e) => {
  console.log('Harv is not reachable:', e.message);
  process.exit(1);
});
