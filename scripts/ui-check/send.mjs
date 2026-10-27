// Sends one message to a chat on this device's Harv over its WebSocket, as the dashboard does,
// and waits for the reply to finish. Uses the user's plan: keep it to /haiku /low.
// Usage: node scripts/ui-check/send.mjs <tabId> "<message>"
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const [tabId, text] = process.argv.slice(2);
const ws = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:5173' } });
ws.on('open', () => ws.send(JSON.stringify({ type: 'chat.send', tabId, text, model: 'auto', effort: 'low' })));
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.tabId !== tabId) return;
  if (msg.type === 'chat.assistant') console.log('harv:', msg.text);
  if (msg.type === 'chat.context') console.log('context', msg.tokens);
  if (msg.type === 'chat.done') {
    console.log('done', msg.ok ? 'ok' : msg.error);
    ws.close();
  }
});
setTimeout(() => {
  console.log('timed out');
  process.exit(1);
}, 180_000).unref();
