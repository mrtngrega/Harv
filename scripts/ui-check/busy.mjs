// Is any chat mid-reply? Check before restarting Harv (uses no tokens).
//   node scripts/ui-check/busy.mjs   → exit 0 when idle, 2 when a chat is busy
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:5173' } });
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== 'hello') return;
  const busy = m.chats.filter((c) => c.busy);
  console.log(`Harv: ${m.status}${busy.length ? `; busy: ${busy.map((c) => c.title).join(', ')}` : '; no chat is replying'}`);
  process.exit(m.status === 'idle' && !busy.length ? 0 : 2);
});
ws.on('error', (e) => {
  console.log('Harv is not reachable:', e.message);
  process.exit(1);
});
