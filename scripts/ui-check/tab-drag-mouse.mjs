// Real mouse drags of chat tabs (Chrome's own drag and drop, via DevTools drag interception).
// The page never saves its layout (ui.save is dropped), so the user's own tabs aren't touched.
// Usage: node scripts/ui-check/tab-drag-mouse.mjs
import { launch } from './cdp.mjs';

const page = await launch({ width: 1500, height: 900 });
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string' && data.includes('"ui.save"')) return;
      return send.call(this, data);
    };
  })();`,
});
await page.goto('http://127.0.0.1:5173/');
const store = `(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/lib/chatStore.ts')))`;
await page.eval(`import(${store}).then((m) => { for (let i = 0; i < 3; i++) m.chat.newTab(); return true; })`);
await page.sleep(400);
const ids = await page.eval(`import(${store}).then((m) => m.getChatState().tabs.slice(-4).map((t) => t.id))`);
const name = Object.fromEntries(ids.map((id, i) => [id, 'ABCD'[i]]));
const order = async () =>
  (await page.eval(`[...document.querySelectorAll('[role=tablist] [data-tab]')].map((e) => e.dataset.tab)`))
    .map((id) => name[id] ?? '?')
    .join('');
const box = (id) =>
  page.eval(
    `(() => { const r = document.querySelector('[data-tab="${id}"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
  );

// Chrome hands the drag to DevTools instead of the OS; the drop then carries the tab id like a real one.
await page.send('Input.setInterceptDrags', { enabled: true });
async function drag(fromId, x, y) {
  const b = await box(fromId);
  const sx = b.x + b.w / 2;
  const sy = b.y + b.h / 2;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: sx + ((x - sx) * i) / 6,
      y: sy + ((y - sy) * i) / 6,
      button: 'left',
      buttons: 1,
    });
  }
  await page.sleep(100);
  const data = { items: [{ mimeType: 'application/x-harv-tab', data: fromId }], dragOperationsMask: 16 };
  for (const type of ['dragEnter', 'dragOver', 'dragOver']) await page.send('Input.dispatchDragEvent', { type, x, y, data });
  await page.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await page.sleep(200);
  return order();
}

const [A, , C] = ids;
console.log('start       ', await order());
const c = await box(C);
console.log('A → after C ', await drag(A, c.x + c.w * 0.75, c.y + c.h / 2));
const last = await box(await page.eval(`[...document.querySelectorAll('[role=tablist] [data-tab]')].at(-1).dataset.tab`));
console.log('C → past end', await drag(C, last.x + last.w + 6, last.y + last.h / 2));
await page.shot('tab-drag-mouse');
console.log(page.logs.filter((l) => /error|exception/i.test(l)).join('\n'));
await page.close();
