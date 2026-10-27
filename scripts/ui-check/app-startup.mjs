// The app's first second after a reload: what the tab bar and the log show, frame by frame
// (the "old chats blink on startup" report). Usage: node scripts/ui-check/app-startup.mjs [port]
import { attach } from './cdp.mjs';

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
await app.send('Page.reload');
const seen = [];
const start = Date.now();
while (Date.now() - start < 2500) {
  const frame = await app
    .eval(
      `JSON.stringify({ tabs: [...document.querySelectorAll('[data-tab]')].map((t) => t.textContent.trim().slice(0, 16)), empty: /New chat. Ask Harv|No chat open/.test(document.body.innerText), dialog: !!document.querySelector('[role="dialog"]'), lines: document.querySelectorAll('.harv-md').length })`,
    )
    .catch(() => 'loading');
  if (seen.at(-1)?.frame !== frame) seen.push({ ms: Date.now() - start, frame });
  await app.sleep(15);
}
for (const s of seen) console.log(`${String(s.ms).padStart(5)} ms  ${s.frame}`);
await app.close();
