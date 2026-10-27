// Drives a chat in the Harv app over CDP: sends messages and waits for each reply.
// Uses the user's plan: keep to /haiku /low turns. Start the app with a debug port first.
// Usage: node scripts/ui-check/app-chat.mjs <port> <shot-name> "<message>" ["<message>"…]
//   a message "!click <text>" clicks a button with that text, "!wait <ms>" waits, "!shot <name>" screenshots.
import { attach } from './cdp.mjs';

const [portArg, name, ...steps] = process.argv.slice(2);
const app = await attach({ port: Number(portArg ?? 9444) });

const busy = () => app.eval(`!!document.querySelector('[aria-label="Harv is thinking"]') || /esc to stop/.test(document.body.innerText)`);
async function waitIdle(maxMs = 240_000) {
  const start = Date.now();
  await app.sleep(1500);
  let quiet = 0;
  while (Date.now() - start < maxMs) {
    if (await busy()) quiet = 0;
    else if (++quiet >= 3) return true;
    // A card waiting for the user ends the wait too.
    if (
      await app.eval(
        `!!document.querySelector('section[aria-label="Harv asks you"], section[aria-label="Harv\\'s plan"], section[aria-label="Harv needs your approval"]')`,
      )
    )
      return true;
    await app.sleep(1000);
  }
  return false;
}

let i = 0;
for (const step of steps) {
  i++;
  if (step.startsWith('!css ')) {
    // "!css <selector>|<text>": the first element matching both
    const [sel, text] = step.slice(5).split('|');
    await app.click(sel, text || undefined);
    await waitIdle();
  } else if (step.startsWith('!click ')) {
    await app.click('button', step.slice(7));
    await waitIdle();
  } else if (step.startsWith('!wait ')) {
    await app.sleep(Number(step.slice(6)));
  } else if (step.startsWith('!shot ')) {
    console.log(await app.shot(`${name}-${step.slice(6)}`));
  } else if (step.startsWith('!eval ')) {
    console.log(JSON.stringify(await app.eval(step.slice(6))));
  } else {
    await app.eval(`(() => { const t = document.querySelector('#harv-cmd'); t.focus(); })()`);
    await app.type(step);
    await app.key('Enter', 'Enter', 13);
    const done = await waitIdle();
    console.log(`step ${i}: ${done ? 'idle' : 'TIMED OUT'}`);
  }
}
console.log(await app.shot(`${name}-end`));
const errors = app.logs.filter((l) => /error|EXCEPTION/i.test(l));
if (errors.length) console.log('console errors:', errors);
await app.close();
