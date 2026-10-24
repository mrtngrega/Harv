// Shows (and can change) the running Harv's sync with the user's other devices (uses no tokens).
//   node scripts/ui-check/sync.mjs                    status
//   node scripts/ui-check/sync.mjs --now              sync now, then the status
//   node scripts/ui-check/sync.mjs --on <repo url> [--name <device name>]
//   node scripts/ui-check/sync.mjs --off
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? '') : undefined);

const ws = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:5173' } });
const print = (s) => {
  const when = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB') : 'never');
  console.log(`${s.device.name} (${s.device.id}): ${s.enabled ? 'on' : 'off'}${s.busy ? ', syncing' : ''}`);
  console.log(`last sync ${when(s.lastSync)}, ${s.pending} changes to send${s.needsKey ? ', NEEDS THE KEY' : ''}`);
  for (const p of s.peers) console.log(`peer ${p.name} (${p.id}), last change ${when(p.lastChange)}`);
  if (s.error) console.log(`error: ${s.error}`);
};
let acted = false;
let started = false;
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'hello') {
    const repo = arg('--on');
    if (repo !== undefined) {
      const name = arg('--name');
      ws.send(JSON.stringify({ type: 'settings.update', patch: { syncEnabled: true, syncRepo: repo, ...(name ? { deviceName: name } : {}) } }));
      acted = true;
    } else if (args.includes('--off')) {
      ws.send(JSON.stringify({ type: 'settings.update', patch: { syncEnabled: false } }));
      acted = true;
    } else if (args.includes('--now')) {
      ws.send(JSON.stringify({ type: 'sync.now' }));
      acted = true;
    }
    if (!acted) {
      print(m.sync);
      process.exit(0);
    }
    setTimeout(() => {
      console.log('(still syncing after 2 minutes)');
      process.exit(1);
    }, 120_000);
  }
  // Waits for the sync it asked for to finish.
  if (m.type === 'sync.status' && acted) {
    if (m.status.busy) started = true;
    if (!m.status.busy && (started || args.includes('--off'))) {
      print(m.status);
      process.exit(0);
    }
  }
});
ws.on('error', (e) => {
  console.log('Harv is not reachable:', e.message);
  process.exit(1);
});
