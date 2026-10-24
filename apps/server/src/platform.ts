import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { HarvPlatform } from '@harv/shared';

// Harv runs on the user's Windows PC and on their Fedora notebook (docs/PLAN.md §6m).
// Anything that differs between the two asks here instead of assuming Windows.

export const IS_WINDOWS = process.platform === 'win32';

/** Path rules of this OS: `win32` on Windows, `posix` elsewhere. */
export const osPath = IS_WINDOWS ? win32 : posix;

/** File names compare without case on Windows, with case elsewhere. */
export const pathKey = (p: string) => (IS_WINDOWS ? p.toLowerCase() : p);

/** The Linux distribution's name ("Fedora Linux 44 (KDE Plasma Desktop Edition)"), from /etc/os-release. */
function distro(): string | undefined {
  try {
    return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

/** What this machine is, for Harv's prompt: "Windows PC", "Linux computer (Fedora Linux 44 …)". */
export const OS_NAME = IS_WINDOWS
  ? 'Windows PC'
  : process.platform === 'darwin'
    ? 'Mac'
    : `Linux computer${distro() ? ` (${distro()})` : ''}`;

/** The OS, as the dashboard knows it (hello.platform). */
export const PLATFORM: HarvPlatform = IS_WINDOWS ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';

/**
 * Linux mounts that hold the user's files: the root, /home and drives plugged in under
 * /run/media, /media or /mnt (not /boot, firmware views or snap images).
 */
export const isUserMount = (mount: string, home = homedir()) =>
  ['/', '/home', home].includes(mount) || /^\/(run\/media|media|mnt)\//.test(mount);
