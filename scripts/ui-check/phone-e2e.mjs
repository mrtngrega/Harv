// The phone, end to end (docs/PLAN.md §6q), from this PC over the real `tailscale serve` address:
// an emulated iPhone in headless Chrome with a virtual Face ID authenticator pairs (the code is
// read from this computer's dashboard connection), makes its passkey, opens the phone layout,
// tries the sheets and Settings, makes a Shortcut token, shares a picture, optionally asks Siri's
// endpoint one question (--ask, one small model turn), then removes the test phone again.
//   node scripts/ui-check/phone-e2e.mjs [--ask] [--keep]
// Needs: Settings › Phone access on, HTTPS certificates on in the tailnet.
import { createRequire } from 'node:module';
import { launch } from './cdp.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// This computer's own dashboard connection: phone access status, the pairing code, the phone list.
const pc = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:5173' } });
const waiters = [];
const seen = [];
pc.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  seen.push(m);
  for (const w of [...waiters]) if (w.test(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
});
const next = (test, ms = 15000) =>
  new Promise((resolve, reject) => {
    const hit = seen.find(test);
    if (hit) return resolve(hit);
    waiters.push({ test, resolve });
    setTimeout(() => reject(new Error('timed out waiting for the server')), ms);
  });
await new Promise((r) => pc.once('open', r));
pc.send(JSON.stringify({ type: 'phone.list' }));
const { access } = await next((m) => m.type === 'phone.list');
if (!access.serving || !access.url) {
  console.log('Phone access is not live:', access.problem ?? 'off');
  process.exit(1);
}
const url = access.url;
console.log('phone address', url);

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const phone = await launch({ width: 390, height: 844, port: 9339, profile: 'phone-profile' });
await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await phone.send('Emulation.setUserAgentOverride', { userAgent: IPHONE, platform: 'iPhone' });
await phone.send('Emulation.setTouchEmulationEnabled', { enabled: true });
await phone.send('WebAuthn.enable');
await phone.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
const text = () => phone.eval('document.body.innerText');
const step = async (name) => console.log(`${name}: ${await phone.shot(`phone-${name}`)}`);

await phone.goto(url);
await sleep(1500);
console.log('first screen:', (await text()).slice(0, 160).replace(/\s+/g, ' '));
await step('1-install');
if (/Home Screen first/.test(await text())) await phone.click('button', 'Use it in Safari instead');
await phone.click('button', 'Show a code on');
const { code } = await next((m) => m.type === 'phone.pairing');
console.log('pairing code shown on the PC:', code);
await step('2-code');
// A wrong code first: it must be refused and count down.
await phone.click('#pair-code');
await phone.type(code === '000000' ? '111111' : '000000');
await phone.click('button', 'Pair');
await sleep(800);
console.log('wrong code:', (await text()).match(/That’s not the code[^\n]*/)?.[0] ?? 'NOT REFUSED');
await phone.click('#pair-code');
await phone.type(code);
await phone.click('button', 'Pair');
await sleep(1500);
await step('3-passkey');
await phone.click('button', 'Set up Face ID');
await sleep(4000);
const opened = await phone.eval('!!document.querySelector("[data-tab]") || !!document.querySelector("#harv-cmd")');
console.log('dashboard open after Face ID:', opened);
await step('4-open');

// Every open tab, the way the phone shows it (chats the app shows in its browser, terminals, Settings…): nothing may break.
const broke = () => phone.eval('/Something in Harv’s window broke|Couldn’t show the/.test(document.body.innerText)');
const tabIds = await phone.eval('[...document.querySelectorAll("[data-tab]")].map(t => t.dataset.tab)');
for (const id of tabIds) {
  await phone.eval(`document.querySelector('[data-tab="${id}"]')?.click()`);
  await sleep(700);
  if (await broke()) {
    console.log(`BROKEN in tab ${id}`);
    await step(`broken-${id.slice(0, 8)}`);
  }
}
console.log(`tabs checked: ${tabIds.length}, broken: ${(await broke()) ? 'yes' : 'none at the end'}`);

await phone.click('button[aria-label="Chat history"]');
await sleep(600);
await step('5-history');
await phone.eval('document.querySelector("[role=dialog] button[aria-label=Close]").click()');
await phone.click('button[aria-label="System and plan"]');
await sleep(600);
await step('6-stats');
await phone.eval('document.querySelector("[role=dialog] button[aria-label=Close]").click()');
// The header's gear (the tab bar has a "Settings" tab too).
await phone.eval('document.querySelector("header button[aria-label=Settings]").click()');
await sleep(1000);
await phone.eval('[...document.querySelectorAll("h2")].find(h => h.textContent === "Phone")?.scrollIntoView()');
await step('7-settings');
await phone.click('button', 'Make the Shortcut token');
await sleep(1000);
const token = await phone.eval('[...document.querySelectorAll("code")].map(c => c.textContent).find(t => t.startsWith("Bearer "))');
console.log('shortcut token made:', !!token);
await step('8-token');

// The share sheet's request, as a Shortcut would send it: a small PNG, no note.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const share = await fetch(`${url}/api/phone/share?name=test-photo`, { method: 'POST', headers: { authorization: token, 'content-type': 'image/png' }, body: png });
console.log('share:', share.status, await share.text());
const shared = await next((m) => m.type === 'phone.shared').catch(() => null);
console.log('shared into the phone chat draft:', shared?.attachments?.map((a) => a.name));
const bad = await fetch(`${url}/api/phone/ask`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"text":"hi"}' });
console.log('ask with a wrong token:', bad.status);

if (process.argv.includes('--ask')) {
  const t0 = Date.now();
  const ask = await fetch(`${url}/api/phone/ask`, {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Test from the phone setup: say just "ready".' }),
  });
  console.log('ask:', ask.status, await ask.text(), `${Math.round((Date.now() - t0) / 1000)}s`);
}

// Locked out at once when removed.
if (!process.argv.includes('--keep')) {
  pc.send(JSON.stringify({ type: 'phone.list' }));
  await sleep(500);
  const list = seen.filter((m) => m.type === 'phone.list').at(-1);
  const mine = list.phones.at(-1);
  pc.send(JSON.stringify({ type: 'phone.revoke', id: mine.id }));
  await sleep(1500);
  const after = await phone.eval('fetch("/api/phone/state").then(r => r.json())');
  console.log('after Remove:', JSON.stringify(after));
}
console.log('page errors:', phone.logs.filter((l) => /EXCEPTION|error/i.test(l)).slice(0, 8));
await phone.close();
pc.close();
process.exit(0);
