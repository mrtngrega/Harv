// Screenshots the ideas-round UI with made-up server messages handed to this headless page's WebSocket
// (no plan usage, nothing saved): the background task strip, the "/fresh?" hint at 200k context, and a
// project sync notice. Usage: node scripts/ui-check/ideas-round.mjs [width]
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
const tabId = await page.eval(`(() => {
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/lib/chatStore.ts'));
  return import(url).then((m) => m.getChatState().activeId);
})()`);
const fake = (msg) => page.eval(`(window.__harvSocket.onmessage({ data: ${JSON.stringify(JSON.stringify(msg))} }), true)`);
const now = Date.now();

await fake({ type: 'chat.started', tabId, model: 'Sonnet 5.5', effort: 'medium', auto: true, reason: 'test' });
await fake({ type: 'chat.assistant', tabId, text: 'Started two agents to look around the car radio app.' });
await fake({ type: 'chat.done', tabId, ok: true, stopped: false, usage: { inputTokens: 1, outputTokens: 120, durationMs: 4000 } });
await fake({ type: 'chat.context', tabId, tokens: 212_400 });
await fake({
  type: 'chat.tasks',
  tabId,
  tasks: [
    {
      id: 'a',
      kind: 'local_agent',
      agent: 'general-purpose',
      description: 'Find how the radio reads CAN data',
      status: 'running',
      startedAt: now - 125_000,
      lastTool: 'Grep',
    },
    { id: 'b', kind: 'local_bash', description: 'npm run dev', status: 'running', startedAt: now - 40_000 },
    {
      id: 'c',
      kind: 'local_agent',
      agent: 'Explore',
      description: 'List the SYU apps',
      status: 'completed',
      startedAt: now - 300_000,
      endedAt: now - 60_000,
      summary: 'Found 14 apps; com.syu.ms is the CAN service.',
    },
    {
      id: 'd',
      kind: 'local_agent',
      agent: 'general-purpose',
      description: 'Decompile the launcher',
      status: 'failed',
      startedAt: now - 200_000,
      endedAt: now - 20_000,
      summary: 'jadx ran out of memory',
    },
  ],
});
if (process.argv[3] !== 'notoast')
  await fake({
    type: 'project.notice',
    message: 'New project from the other device: "weather-app", cloned into C:\\My files\\Code\\Projects\\weather-app.',
  });
await page.sleep(1200);
const report = await page.eval(`(() => {
  const strip = document.querySelector('[aria-label="Background tasks"]');
  const hint = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('/fresh?'));
  const toast = [...document.querySelectorAll('[role=status]')].find((e) => e.textContent.includes('other device'));
  return JSON.stringify({
    rows: strip ? [...strip.querySelectorAll('li')].map((li) => li.textContent) : null,
    hint: hint ? hint.textContent.trim() : (document.body.innerText.match(/context ·[^\\n]*/) || ['label hidden at this width'])[0],
    toast: toast ? toast.textContent : null,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  });
})()`);
console.log(report);
await page.shot(`ideas-round-${width}${process.argv[3] ? `-${process.argv[3]}` : ''}`);
if (await page.eval(`!![...document.querySelectorAll('button')].find((b) => b.textContent.includes('/fresh?'))`)) {
  await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('/fresh?')).click(), true`);
  console.log('input after clicking the hint:', await page.eval(`document.querySelector('#harv-cmd').value`));
}
await page.close();
process.exit(0);
