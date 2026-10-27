// In the Harv app: a screenshot, where the tab bar's context label sits, and frames of a
// reload (the "old chats blink on startup" report). Start the app with a debug port first.
// Usage: node scripts/ui-check/app-look.mjs [port] [name]
import { attach, SHOTS } from './cdp.mjs';

const port = Number(process.argv[2] ?? 9444);
const name = process.argv[3] ?? 'app';
const app = await attach({ port });
console.log('window', await app.eval('`${innerWidth}x${innerHeight} zoom ${getComputedStyle(document.documentElement).zoom}`'));
console.log(
  'context label',
  await app.eval(`(() => {
    const el = [...document.querySelectorAll('div')].find((d) => /^context · /.test(d.textContent ?? '') && d.children.length <= 2);
    if (!el) return 'not shown';
    const r = el.getBoundingClientRect();
    const bar = el.parentElement.getBoundingClientRect();
    const tab = document.querySelector('[data-tab]')?.getBoundingClientRect();
    return { label: [r.top, r.bottom, r.height].map(Math.round), bar: [bar.top, bar.bottom].map(Math.round), tab: tab && [tab.top, tab.bottom].map(Math.round), display: getComputedStyle(el).display };
  })()`),
);
console.log(await app.shot(`${name}-now`));

if (process.argv.includes('--reload')) {
  await app.send('Page.reload');
  for (const ms of [60, 150, 300, 500, 800, 1200, 2000]) {
    await app.sleep(ms === 60 ? 60 : ms - [60, 150, 300, 500, 800, 1200, 2000][[60, 150, 300, 500, 800, 1200, 2000].indexOf(ms) - 1]);
    const tabs = await app
      .eval('[...document.querySelectorAll("[data-tab]")].map((t) => t.textContent.trim().slice(0, 18))')
      .catch(() => []);
    console.log(`${ms} ms: ${tabs.length} tabs`, JSON.stringify(tabs));
    await app.shot(`${name}-reload-${ms}`).catch(() => {});
  }
}
console.log('logs', app.logs.slice(-10));
console.log('shots in', SHOTS);
await app.close();
