// Start Harv when the computer turns on, before anyone logs in (Settings › This computer › Startup,
// the user's switch, per device). Linux only for now: a systemd user service plus "linger", which
// starts the user's services at boot instead of at login. Off removes both again.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PLATFORM } from './platform.ts';

const run = promisify(execFile);
const UNIT = 'harv.service';

/** Whether this device can start Harv at boot (Linux with systemd). */
export const bootStartSupported = () => PLATFORM === 'linux';

const unitPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', UNIT);

/** The service: harv.sh starts Harv detached and returns, so it's a oneshot that stays "active". */
export function unitText(script: string): string {
  return [
    '# Made by Harv (Settings › This computer › Startup). Turning the switch off removes it.',
    '[Unit]',
    'Description=Harv',
    // No network ordering: the user manager has no network-online.target. Harv's phone access and
    // sync retry on their own once the network (and Tailscale) is up.
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=/usr/bin/bash ${script} start --no-browser`,
    `ExecStop=/usr/bin/bash ${script} stop`,
    'TimeoutStartSec=180',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Makes the system match the switch. Returns a problem in plain words, or undefined when it worked. */
export async function applyBootStart(on: boolean, script: string): Promise<string | undefined> {
  if (!bootStartSupported()) return undefined;
  try {
    const file = unitPath();
    if (on) {
      const text = unitText(script);
      if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, text);
        await run('systemctl', ['--user', 'daemon-reload'], { timeout: 15_000 });
      }
      await run('systemctl', ['--user', 'enable', UNIT], { timeout: 15_000 });
      await run('loginctl', ['enable-linger'], { timeout: 15_000 });
    } else if (existsSync(file)) {
      await run('systemctl', ['--user', 'disable', UNIT], { timeout: 15_000 });
      rmSync(file);
      await run('systemctl', ['--user', 'daemon-reload'], { timeout: 15_000 });
      // Linger was turned on for Harv's sake (it was off before), so it goes back off with it.
      await run('loginctl', ['disable-linger'], { timeout: 15_000 });
    }
    return undefined;
  } catch (err) {
    return `Couldn't ${on ? 'set up' : 'remove'} starting Harv at boot: ${(err as Error).message.split('\n')[0]}`;
  }
}
