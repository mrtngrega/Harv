// The app's tabs right now: order, which is active, lines in each, a start question. Usage: node scripts/ui-check/app-tabs.mjs [port] [--reload]
import { attach } from './cdp.mjs';
const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const look = () =>
  app.eval(
    `JSON.stringify({ tabs: [...document.querySelectorAll('[data-tab]')].map((t) => (t.getAttribute('aria-selected') === 'true' ? '*' : '') + t.textContent.trim().replace('×', '')), dialog: document.querySelector('[role="dialog"]')?.innerText.slice(0, 40) ?? null, lines: document.querySelectorAll('#harv-cmd') && [...document.querySelectorAll('.harv-md')].length })`,
  );
console.log('now   ', await look());
if (process.argv.includes('--reload')) {
  await app.send('Page.reload');
  await app.sleep(3000);
  console.log('reload', await look());
}
await app.close();
