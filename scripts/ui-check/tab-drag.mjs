// Drags chat tabs around in a headless dashboard and reports the order after each drop.
// The page never saves its layout (ui.save is dropped), so the user's own tabs aren't touched.
// Usage: node scripts/ui-check/tab-drag.mjs
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

// The app's own chat store (Vite may load it with a ?t= version).
const store = `(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/lib/chatStore.ts')))`;
await page.eval(`import(${store}).then((m) => { for (let i = 0; i < 3; i++) m.chat.newTab(); return true; })`);
await page.sleep(400);
// The last four tabs are A, B, C, D in the report.
const ids = await page.eval(`import(${store}).then((m) => m.getChatState().tabs.slice(-4).map((t) => t.id))`);
const name = Object.fromEntries(ids.map((id, i) => [id, 'ABCD'[i]]));
const order = async () =>
  (await page.eval(`[...document.querySelectorAll('[role=tablist] [data-tab]')].map((e) => e.dataset.tab)`))
    .map((id) => name[id] ?? '?')
    .join('');

/** Drags tab `from` and drops it at `x` (fraction of the target's width) over tab `to`, or at a raw point. */
async function drag(from, to, frac = 0.75, point) {
  return page.eval(`(() => {
    const el = (id) => document.querySelector('[data-tab="' + id + '"]');
    const src = el(${JSON.stringify(from)});
    const dt = new DataTransfer();
    const fire = (target, type, x, y) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    const s = src.getBoundingClientRect();
    fire(src, 'dragstart', s.x + 5, s.y + 5);
    return new Promise((done) => setTimeout(() => {
      let x, y, target;
      ${
        point
          ? `x = ${point.x}; y = ${point.y}; target = document.elementFromPoint(x, y);`
          : `const r = el(${JSON.stringify(to)}).getBoundingClientRect(); x = r.x + r.width * ${frac}; y = r.y + r.height / 2; target = document.elementFromPoint(x, y);`
      }
      fire(target, 'dragenter', x, y);
      fire(target, 'dragover', x, y);
      setTimeout(() => {
        fire(target, 'dragover', x, y);
        const dropped = !fire(target, 'drop', x, y);
        fire(src, 'dragend', x, y);
        done({ target: target?.closest('[data-tab]')?.dataset.tab ?? target?.tagName, accepted: dropped });
      }, 50);
    }, 50));
  })()`);
}

const [A, B, C, D] = ids;
console.log('start         ', await order());
console.log('A → after C   ', JSON.stringify(await drag(A, C, 0.75)), await order());
console.log('D → before B  ', JSON.stringify(await drag(D, B, 0.25)), await order());
console.log('B → before B  ', JSON.stringify(await drag(B, B, 0.25)), await order());
// Past the last tab (empty bar space), where Chrome puts it at the end.
const bar = await page.eval(
  `(() => { const r = document.querySelector('[role=tablist]').getBoundingClientRect(); const last = [...document.querySelectorAll('[role=tablist] [data-tab]')].at(-1).getBoundingClientRect(); return { x: last.right + 2, y: r.y + r.height / 2 }; })()`,
);
console.log('C → gap/end   ', JSON.stringify(await drag(C, null, 0, bar)), await order());
// Into the 4px gap between two tabs.
const gap = await page.eval(
  `(() => { const t = [...document.querySelectorAll('[role=tablist] [data-tab]')]; const a = t[1].getBoundingClientRect(); return { x: a.right + 2, y: a.y + a.height / 2 }; })()`,
);
console.log('A → gap       ', JSON.stringify(await drag(A, null, 0, gap)), await order());
await page.shot('tab-drag');
console.log(page.logs.filter((l) => /error|exception/i.test(l)).join('\n'));
await page.close();
