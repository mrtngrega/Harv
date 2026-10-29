// Phone access on this device (docs/PLAN.md §6q): status, or turn it on/off (uses no tokens).
//   node scripts/ui-check/phone.mjs [--on | --off]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const want = process.argv.includes('--on') ? true : process.argv.includes('--off') ? false : null;
const ws = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:5173' } });
let asked = false;
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'hello') {
    if (want !== null && m.settings.phoneAccess !== want) ws.send(JSON.stringify({ type: 'settings.update', patch: { phoneAccess: want } }));
    // serve takes a moment: ask for the list after it had time.
    setTimeout(() => ((asked = true), ws.send(JSON.stringify({ type: 'phone.list' }))), want === null ? 0 : 6000);
  } else if (m.type === 'phone.list' && asked) {
    console.log(JSON.stringify(m.access, null, 2));
    for (const p of m.phones) console.log(`- ${p.name}: ${p.passkey ? 'Face ID' : 'no passkey'}${p.push ? ', push' : ''}${p.shortcut ? ', Siri' : ''}`);
    process.exit(0);
  }
});
ws.on('error', (e) => {
  console.log('Harv is not reachable:', e.message);
  process.exit(1);
});
