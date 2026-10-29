import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { IS_WINDOWS } from '../platform.ts';

/**
 * Secrets reached without naming them: a wildcard (`~/.cl?ude/.cred*`, `id_*`), a variable
 * (`$env:APPDATA\Microsoft\Cred*`) or a recursive search over a folder that holds them
 * (`grep -r token ~`). The literal-name check (SENSITIVE_PATHS in classify.ts) can't see those,
 * so this tests the words against where secrets really live on this computer.
 */

const home = homedir();
const env = (name: string, fallback: string) => process.env[name] || fallback;

/** Where secrets live, as full paths ("*" for a folder whose name differs per computer, like a profile). */
function secretPaths(): string[] {
  const h = (...p: string[]) => join(home, ...p);
  const common = [
    h('.claude', '.credentials.json'),
    h('.claude', 'settings.json'),
    ...['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'config'].map((k) => h('.ssh', k)),
    h('.aws', 'credentials'),
    h('.azure', '*'),
    h('.kube', 'config'),
    h('.gnupg', '*'),
    h('.git-credentials'),
    h('.npmrc'),
    h('.netrc'),
    h('.pypirc'),
    h('.docker', 'config.json'),
    h('.harv', 'sync.key'),
    h('.harv', 'browser-profile', '*'),
  ];
  if (!IS_WINDOWS) {
    const browsers = ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].flatMap((b) =>
      ['Login Data', 'Cookies', 'Web Data'].map((f) => h('.config', b, 'Default', f)),
    );
    return [
      ...common,
      ...browsers,
      ...['logins.json', 'key4.db', 'cookies.sqlite'].map((f) => h('.mozilla', 'firefox', '*', f)),
      h('.config', 'gh', 'hosts.yml'),
      h('.local', 'share', 'keyrings', '*'),
      h('.local', 'share', 'kwalletd', '*'),
      h('.password-store', '*'),
      '/etc/shadow',
      '/etc/gshadow',
      '/etc/sudoers',
    ];
  }
  const local = env('LOCALAPPDATA', h('AppData', 'Local'));
  const roaming = env('APPDATA', h('AppData', 'Roaming'));
  const browsers = [
    ['Google', 'Chrome'],
    ['Microsoft', 'Edge'],
    ['BraveSoftware', 'Brave-Browser'],
  ].flatMap((b) => [
    ...['Login Data', 'Cookies', 'Web Data'].map((f) => join(local, ...b, 'User Data', 'Default', f)),
    join(local, ...b, 'User Data', 'Local State'),
  ]);
  return [
    ...common,
    ...browsers,
    ...['logins.json', 'key4.db', 'cookies.sqlite'].map((f) => join(roaming, 'Mozilla', 'Firefox', 'Profiles', '*', f)),
    ...['Credentials', 'Vault', 'Protect'].flatMap((d) => [join(roaming, 'Microsoft', d, '*'), join(local, 'Microsoft', d, '*')]),
    join(roaming, 'GitHub CLI', 'hosts.yml'),
    join(env('SystemRoot', 'C:\\Windows'), 'System32', 'config', 'SAM'),
  ];
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
const SECRETS = secretPaths().map(norm);
const SECRET_NAMES = new Set(SECRETS.map((p) => p.split('/').at(-1)!).filter((n) => n !== '*'));

const GLOB = /[*?[]/;

/** `~`, `$HOME`, `$env:NAME`, `${env:NAME}` and `%NAME%` replaced by their values (unknown ones stay). */
export function expandVars(word: string): string {
  const value = (name: string) => (name.toUpperCase() === 'HOME' ? home : process.env[name] ?? process.env[name.toUpperCase()]);
  return word
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/\$\{?env:(\w+)\}?/gi, (m, n: string) => value(n) ?? m)
    .replace(/%(\w+)%/g, (m, n: string) => value(n) ?? m)
    .replace(/\$\{?(HOME|USERPROFILE)\}?(?=$|[\\/])/g, (m, n: string) => value(n) ?? m);
}

/** A glob as a regex over normalized paths (`*` within one folder, `**` across folders). */
function globRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A secret's own placeholder folder ("*") matches any name the pattern gives it. */
const secretRegex = (secret: string) => new RegExp(`^${secret.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
const SECRET_RES = SECRETS.map((s) => ({ path: s, re: secretRegex(s) }));

/** A path pattern that names a secret, or a folder of one (with letters of its own, so `~/*` alone isn't one). */
function globHitsSecret(pattern: string): boolean {
  const re = globRegex(pattern);
  const last = pattern.split('/').at(-1) ?? '';
  const ownLetters = /[^*?[\]/]{2,}/.test(last.replace(/\[[^\]]*\]/g, ''));
  return SECRET_RES.some(({ path, re: secret }) => {
    // The pattern can stand for the whole secret path (placeholders in the secret take any name)…
    const sample = path.replace(/\*/g, 'x');
    if (re.test(sample) || (!GLOB.test(pattern) && secret.test(pattern))) return true;
    // …or for one of its folders (`~/.s?h`, then read what's inside).
    if (!ownLetters) return false;
    const parts = sample.split('/');
    for (let n = 2; n < parts.length; n++) if (re.test(parts.slice(0, n).join('/'))) return true;
    return false;
  });
}

/** A file name pattern (`id_*`, `Login*`) that matches a secret's name. Needs letters of its own: `*` is everything. */
const nameHitsSecret = (name: string) =>
  /[^*?[\]]{2,}/.test(name.replace(/\[[^\]]*\]/g, '')) && [...SECRET_NAMES].some((s) => globRegex(norm(name)).test(s));

/** A folder that holds secrets (home, a drive root, AppData…). */
const holdsSecrets = (dir: string) => {
  const d = norm(dir).replace(/\/$/, '');
  return d !== '' && SECRETS.some((s) => s.startsWith(`${d}/`));
};

/** Recursive search options of the usual tools. */
const RECURSIVE = /^(-r|-R|-rn|-rl|-ri|-Rn|--recursive|-recurse|\/s)$/i;
const NAME_FILTER = /^(-filter|-include|-name|-iname|-path|-ipath|--include|--glob|-g)$/i;
/** Tools that read what they find (as opposed to only listing names). */
const READERS = /^(grep|egrep|fgrep|rg|ag|ack|findstr|select-string|sls|get-content|gc|cat|type|more|less|head|tail|strings|xxd|od|copy-item|cp|copy)$/i;

/**
 * Does this command reach a secret without naming it? `segments` are the command's parts (a pipe
 * or chain splits them), each as its words without quotes; `cwd` is where it runs.
 */
export function reachesSecret(segments: string[][], cwd: string): boolean {
  const programs = segments.map((ws) => (ws[0] ?? '').toLowerCase().replace(/\.exe$/, ''));
  const reads = programs.some((p) => READERS.test(p));
  for (const ws of segments) {
    const program = (ws[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    const recursive = ws.some((w) => RECURSIVE.test(w)) || program === 'find' || (program === 'rg' && !ws.includes('--files'));
    let searchesSecrets = false;
    for (let i = 1; i < ws.length; i++) {
      const raw = ws[i]!;
      const value = raw.includes('=') && raw.startsWith('-') ? raw.slice(raw.indexOf('=') + 1) : raw;
      const word = expandVars(value);
      if (!word || (word.startsWith('-') && !GLOB.test(word))) continue;
      // A name filter (`-Filter id_* | Get-Content`, `find -name "Login*" -exec cat`) that finds secrets
      // and reads them. Only listing names (`find ~ -name "*.json"`) is fine.
      if (NAME_FILTER.test(ws[i - 1] ?? '') && !/[\\/]/.test(word)) {
        if (nameHitsSecret(word) && (reads || ws.includes('-exec') || ws.includes('-execdir'))) return true;
        continue;
      }
      const looksLikePath = /[\\/]/.test(word) || GLOB.test(word) || /^[a-z]:$/i.test(word);
      if (!looksLikePath) continue;
      const full = norm(isAbsolute(word) || /^[a-z]:/i.test(word) ? word : join(cwd, word));
      if (GLOB.test(word) ? globHitsSecret(full) : SECRET_RES.some(({ re }) => re.test(full))) return true;
      if (!GLOB.test(word) && holdsSecrets(full)) searchesSecrets = true;
    }
    // A recursive search through home (or a drive, AppData…) that reads the files it finds.
    if (searchesSecrets && recursive && (READERS.test(program) || reads || ws.includes('-exec') || ws.includes('-execdir'))) return true;
  }
  return false;
}
