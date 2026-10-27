// Minimal Chrome DevTools driver for UI checks of the Harv dashboard: a separate headless
// Chrome (its own profile in ./out), clicks, typing, script evaluation and screenshots.
// Used by the other scripts here; see README.md.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';

/** Chrome on Windows or Linux (Chromium too); HARV_CHROME picks another. */
const CHROME =
  process.env.HARV_CHROME ??
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : (['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'].find((p) => existsSync(p)) ?? 'google-chrome'));

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const OUT = fileURLToPath(new URL('./out', import.meta.url));
export const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1500, height = 900, port = 9333 } = {}) {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(OUT, 'chrome-profile')}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  return connect(port, { width, height, onClose: () => chrome.kill() });
}

/**
 * Drives the Harv app itself (the user only uses the app, 2026-10-27): start it with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port> (Windows; never 9333),
 * then attach here. The window keeps its own size; close() only lets go of it.
 */
export function attach({ port = 9444 } = {}) {
  return connect(port, { app: true });
}

async function connect(port, { width = 1500, height = 900, app = false, onClose = () => {} }) {
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page' && (!app || t.url.startsWith('http://127.0.0.1:5173')));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`EXCEPTION: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  if (!app) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const api = {
    send,
    logs,
    sleep,
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(2500);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    /** Clicks the first element matching a CSS selector whose text includes `text` (optional). */
    async click(selector, text) {
      const box = await api.eval(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => ${text ? `e.textContent.includes(${JSON.stringify(text)}) || (e.getAttribute('aria-label')||'').includes(${JSON.stringify(text)})` : 'true'});
        const el = els[0]; if (!el) return null;
        el.scrollIntoView({block:'center'});
        const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 };
      })()`);
      if (!box) throw new Error(`No element ${selector} ${text ?? ''}`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await sleep(400);
    },
    async type(text) {
      await send('Input.insertText', { text });
      await sleep(150);
    },
    async key(key, code = key, keyCode = 0) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
      await sleep(200);
    },
    async shot(name) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = join(SHOTS, `${name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
    async close() {
      if (!app) {
        try {
          await send('Browser.close');
        } catch {
          // Already closed.
        }
      }
      ws.close();
      onClose();
    },
  };
  return api;
}
