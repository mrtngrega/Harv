// Shows a fake PC-watchdog alert in a headless dashboard and screenshots it (no server change,
// no plan usage): the page's WebSocket is captured and handed a made-up `watchdog.alert`.
// Usage: node scripts/ui-check/watchdog-toast.mjs [width]
import { launch } from './cdp.mjs';

const width = Number(process.argv[2] ?? 1500);
const page = await launch({ width, height: 900 });
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (...args) { const ws = new Real(...args); window.__harvSocket = ws; return ws; };
    window.WebSocket.prototype = Real.prototype;
    Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });
  })();`,
});
await page.goto('http://127.0.0.1:5173/');
for (let i = 0; i < 40 && !(await page.eval('typeof window.__harvSocket?.onmessage === "function"')); i++) await page.sleep(250);
const fake = (alert) =>
  page.eval(`(() => {
    const ws = window.__harvSocket;
    ws.onmessage({ data: JSON.stringify({ type: 'watchdog.alert', alert: ${JSON.stringify(alert)} }) });
    return true;
  })()`);

await fake({
  id: 'fake-1',
  at: Date.now(),
  kind: 'hog',
  severity: 'warning',
  title: 'svchost.exe has used 38% CPU for 6 minutes without a window',
  detail: 'A background program kept the CPU busy. If you didn’t start it, it may be worth a look.',
  app: 'svchost.exe',
});
await page.sleep(600);
console.log(await page.shot(`watchdog-warning-${width}`));
await fake({
  id: 'fake-2',
  at: Date.now(),
  kind: 'defender',
  severity: 'critical',
  title: 'Windows Defender found a threat',
  detail:
    'In file:_C:\\Users\\me\\AppData\\Local\\Packages\\Microsoft.MicrosoftEdge_8wekyb3d8bbwe\\TempState\\Downloads\\some_really_long_installer_name_v2.1.0_x64_setup.exe->(SFX)->payload.bin. Defender dealt with it.',
});
await page.sleep(600);
console.log(await page.shot(`watchdog-critical-${width}`));
console.log(page.logs.filter((l) => /error|exception/i.test(l)).join('\n'));
await page.close();
