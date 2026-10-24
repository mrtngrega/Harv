// Screenshots of the dashboard at several window widths, with the stats panel collapsed and expanded,
// plus checks for sideways overflow and a page that scrolled by itself.
//   node scripts/ui-check/shots.mjs [width ...]     (default: 420 1100 1280 1500)
// It only looks: it doesn't open tabs or send messages. Files go to scripts/ui-check/out/shots.
import { launch } from './cdp.mjs';

const widths = process.argv.slice(2).map(Number).filter(Boolean);
const b = await launch({ width: 1500, height: 900 });
await b.goto('http://127.0.0.1:5173/');
await b.sleep(2000);

const measure = `JSON.stringify({ rootScrollTop: document.querySelector('#root > div').scrollTop, pageWidth: document.scrollingElement.scrollWidth, windowWidth: innerWidth })`;
for (const width of widths.length ? widths : [420, 1100, 1280, 1500]) {
  await b.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await b.sleep(800);
  console.log(`${width}px collapsed`, await b.eval(measure), await b.shot(`w${width}-collapsed`));
  if (await b.eval(`!!document.querySelector('button[aria-label="Expand system panel"]')`)) {
    await b.eval(`document.querySelector('button[aria-label="Expand system panel"]').click()`);
    await b.sleep(800);
    console.log(`${width}px expanded`, await b.eval(measure), await b.shot(`w${width}-expanded`));
    await b.eval(`document.querySelector('button[aria-label="Collapse system panel"]')?.click()`);
  }
}
const errors = b.logs.filter((l) => /EXCEPTION|error/i.test(l));
if (errors.length) console.log('Console errors:\n' + errors.join('\n'));
await b.close();
