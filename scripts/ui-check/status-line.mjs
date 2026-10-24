// Screenshots the status line above the command line, idle and during a fake turn (made-up
// server messages handed to this headless page's WebSocket: no plan usage, nothing saved).
// Usage: node scripts/ui-check/status-line.mjs [width]
import { launch } from './cdp.mjs';

const width = Number(process.argv[2] ?? 1500);
const page = await launch({ width, height: 900 });
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (...args) { const ws = new Real(...args); if (String(args[0]).endsWith("/ws")) window.__harvSocket = ws; return ws; };
    window.WebSocket.prototype = Real.prototype;
    Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });
  })();`,
});
await page.goto('http://127.0.0.1:5173/');
for (let i = 0; i < 40 && !(await page.eval('typeof window.__harvSocket?.onmessage === "function"')); i++) await page.sleep(250);
// The app's own copy of the chat store (Vite may load it with a ?t= version; a plain import would be a second copy).
const tabId = await page.eval(`(() => {
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/lib/chatStore.ts'));
  return import(url).then((m) => m.getChatState().activeId);
})()`);
const fake = (msg) => page.eval(`(window.__harvSocket.onmessage({ data: ${JSON.stringify(JSON.stringify({ tabId, ...msg }))} }), true)`);
const status = () => page.eval(`document.querySelector('[role=status][aria-label^="Harv is"]')?.textContent`);

console.log('idle:', await status());
await page.shot(`status-idle-${width}`);
await fake({ type: 'chat.started', model: 'Sonnet 5.5', effort: 'medium', auto: true, reason: 'test' });
await fake({ type: 'chat.delta', text: 'Looking at your Downloads folder…' });
await fake({ type: 'chat.progress', outputTokens: 340 });
await page.sleep(2300);
console.log('thinking:', await status());
await page.shot(`status-thinking-${width}`);
await fake({ type: 'chat.tool', id: 'fake-tool', name: 'PowerShell', detail: 'Get-ChildItem Downloads' });
await fake({ type: 'chat.progress', outputTokens: 1260 });
await fake({ type: 'chat.queued', items: [{ id: 'q1', text: 'also check my Desktop folder' }] });
await page.sleep(1100);
console.log('working:', await status());
await page.shot(`status-working-${width}`);
await fake({ type: 'chat.done', ok: true, stopped: false, usage: { inputTokens: 9000, outputTokens: 1302, durationMs: 4200 } });
await page.sleep(300);
console.log('done:', await status());
console.log(page.logs.filter((l) => /error|exception/i.test(l)).join('\n'));
await page.close();
