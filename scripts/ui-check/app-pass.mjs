// A look pass over the Harv app (docs/PLAN.md §6u review): Settings section by section, the chat at
// several widths with the stats panel narrow and wide, and live values watched for layout shifts.
// It puts the window's state back the way it found it. Usage: node scripts/ui-check/app-pass.mjs [port]
import { attach } from './cdp.mjs';

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const report = [];
const note = (s) => (report.push(s), console.log(s));

const overflow = () =>
  app.eval(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > innerWidth + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed' && !el.closest('[role="tablist"]')) out.push((el.className?.toString?.() ?? el.tagName).slice(0, 60));
    }
    return { scrollX: document.documentElement.scrollWidth > innerWidth, pageScrolled: scrollY, outside: out.slice(0, 5) };
  })()`);

// A fixed page size: the window may be minimized while the user works (screenshots came out 183×25).
await app.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1032, deviceScaleFactor: 1, mobile: false });
await app.sleep(500);

// Settings, top to bottom (the header's gear opens it even when its tab is closed).
await app.eval(`document.querySelector('header button[aria-label="Settings"], button[aria-label="Settings"]').click()`);
await app.sleep(800);
const scroller = `[...document.querySelectorAll('*')].find((e) => e.classList?.contains('@container') && /auto/.test(getComputedStyle(e).overflowY))`;
const height = await app.eval(`${scroller}.scrollHeight`);
for (let y = 0, i = 0; y < height; y += 900, i++) {
  await app.eval(`${scroller}.scrollTo(0, ${y})`);
  await app.sleep(300);
  console.log(await app.shot(`pass-settings-${i}`));
}
await app.eval(`${scroller}.scrollTo(0, 0)`);

// The chat at several widths, stats narrow and wide.
// The first chat tab, whatever it's called.
await app.eval(`[...document.querySelectorAll('[data-tab] button[role=tab]')].find((b) => !/Settings/.test(b.textContent))?.click()`);
await app.sleep(600);
const statsToggle = () =>
  app.eval(
    `(() => { const b = document.querySelector('button[aria-label="Expand system panel"], button[aria-label="Collapse system panel"]'); b?.click(); return b?.getAttribute('aria-label') ?? 'none' })()`,
  );
for (const width of [420, 1100, 1280, 1500]) {
  await app.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await app.sleep(500);
  note(`${width} narrow: ${JSON.stringify(await overflow())}`);
  console.log(await app.shot(`pass-${width}-narrow`));
  note(`toggle: ${await statsToggle()}`);
  await app.sleep(600);
  note(`${width} wide: ${JSON.stringify(await overflow())}`);
  console.log(await app.shot(`pass-${width}-wide`));
  await statsToggle();
  await app.sleep(300);
}
await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });

// Live values for 15 s: nothing outside the stats panel may move.
const watch = await app.eval(`new Promise((done) => {
  const pick = () => [...document.querySelectorAll('section, nav, form, header')].map((e) => { const r = e.getBoundingClientRect(); return [e.tagName, Math.round(r.top), Math.round(r.height)].join(':') }).join('|');
  const first = pick(); let moved = 0;
  const t = setInterval(() => { if (pick() !== first) moved++; }, 250);
  setTimeout(() => { clearInterval(t); done(moved); }, 15000);
})`);
note(`layout moved in ${watch} of 60 checks while the stats ticked`);
await app.send('Emulation.clearDeviceMetricsOverride');
const errors = app.logs.filter((l) => /error|EXCEPTION/i.test(l));
note(`console errors: ${errors.length ? errors.join(' / ') : 'none'}`);
await app.close();
