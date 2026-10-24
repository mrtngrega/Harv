// Watches the stats panel while live values tick and reports anything that moves or wraps.
//   node scripts/ui-check/watch-shifts.mjs [width] [seconds]     (default: 1100 15)
// Sideways moves of right-aligned numbers are normal; any vertical move (dy) is a layout shift worth fixing.
import { launch } from './cdp.mjs';

const width = Number(process.argv[2] ?? 1100);
const seconds = Number(process.argv[3] ?? 15);
const b = await launch({ width, height: 900 });
await b.goto('http://127.0.0.1:5173/');
await b.sleep(2000);

const snap = `(() => {
  const aside = document.querySelector('aside');
  const out = { panel: Math.round(aside.getBoundingClientRect().width), items: {} };
  const walk = (el, path) => [...el.children].forEach((c, i) => {
    const p = path + '/' + c.tagName + i;
    if (c.children.length === 0 && c.textContent.trim()) {
      const r = c.getBoundingClientRect();
      out.items[p] = { x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height), t: c.textContent.trim().slice(0, 40) };
    }
    walk(c, p);
  });
  walk(aside, '');
  return out;
})()`;

async function watch(label) {
  const moved = new Map();
  let before = await b.eval(snap);
  const widthsSeen = new Set([before.panel]);
  for (let i = 0; i < seconds * 2; i++) {
    await b.sleep(500);
    const now = await b.eval(snap);
    widthsSeen.add(now.panel);
    for (const [k, v] of Object.entries(now.items)) {
      const was = before.items[k];
      if (!was) continue;
      const dy = Math.max(Math.abs(v.y - was.y), Math.abs(v.h - was.h));
      if (dy > 1) moved.set(k, `${was.t} → ${v.t} (dy ${dy})`);
    }
    before = now;
  }
  console.log(`${label} at ${width}px: panel widths ${[...widthsSeen].join(', ')}`);
  console.log(moved.size ? [...moved.values()].map((m) => `  vertical shift: ${m}`).join('\n') : '  no vertical shifts');
}

await watch('collapsed');
await b.eval(`document.querySelector('button[aria-label="Expand system panel"]')?.click()`);
await b.sleep(1000);
await watch('expanded');
console.log(await b.shot(`shifts-${width}`));
await b.eval(`document.querySelector('button[aria-label="Collapse system panel"]')?.click()`);
await b.close();
