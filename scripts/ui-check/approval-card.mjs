// Shows a fake approval card in a headless dashboard, in the chat log and over the Files view,
// and screenshots both. The page never saves its layout and never answers the card.
// Usage: node scripts/ui-check/approval-card.mjs [width]
import { launch } from './cdp.mjs';

const width = Number(process.argv[2] ?? 1500);
const page = await launch({ width, height: 900 });
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (...args) { const ws = new Real(...args); if (String(args[0]).endsWith('/ws')) window.__harvSocket = ws; return ws; };
    window.WebSocket.prototype = Real.prototype;
    Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });
    const send = Real.prototype.send;
    Real.prototype.send = function (data) {
      if (typeof data === 'string' && /"(ui.save|approval.answer)"/.test(data)) return;
      return send.call(this, data);
    };
  })();`,
});
await page.goto('http://127.0.0.1:5173/');
for (let i = 0; i < 40 && !(await page.eval('typeof window.__harvSocket?.onmessage === "function"')); i++) await page.sleep(250);
const store = `(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/lib/chatStore.ts')))`;
const tabId = await page.eval(`import(${store}).then((m) => m.getChatState().activeId)`);
await page.eval(`(window.__harvSocket.onmessage({ data: ${JSON.stringify(
  JSON.stringify({
    type: 'approval.request',
    approval: {
      id: 'fake-approval',
      tabId,
      at: Date.now(),
      tool: 'PowerShell',
      summary: 'Remove both Ollama models',
      reason: 'Deletes files or folders.',
      command: 'ollama rm qwen3:8b',
      preview: 'PS> ollama rm qwen3:8b\n\nNo read-only folders set.',
      backups: [],
      backupNote: 'Nothing to back up was found, so Undo won’t be available for this one.',
      rules: ['ollama rm'],
    },
  }),
)} }), true)`);
await page.sleep(500);
console.log(await page.shot(`approval-chat-${width}`));
await page.eval(`import(${store}).then((m) => (m.chat.setView(${JSON.stringify(tabId)}, 'files'), true))`);
await page.sleep(1200);
console.log(await page.shot(`approval-files-${width}`));
console.log(page.logs.filter((l) => /error|exception/i.test(l)).join('\n'));
await page.close();
