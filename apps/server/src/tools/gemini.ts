import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { HARV_HOME } from '../paths.ts';
import { WORKSPACE } from '../safety/paths.ts';
import { CdpPage, HarvChrome } from './chrome.ts';

// Image generation through the Gemini website (docs/PLAN.md §6w): Gemini's API has no
// free tier for images, the Gemini app does. A fixed script drives Harv's own Chrome
// profile, signed in once by the user with a Google account kept for this, so a picture
// costs one tool call of the Claude plan and nothing else.

export const GEMINI_URL = 'https://gemini.google.com/app';
const PROFILE = join(HARV_HOME, 'gemini-profile');
export const IMAGES_DIR = join(WORKSPACE, 'images');
/** Pictures Harv may hand to Gemini to edit. */
const INPUT_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const ANSWER_MS = 240_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tells Harv what to say: the user has something to do (sign in), or Gemini said no. */
export class GeminiProblem extends Error {}

/** "2026-10-28-1930-red-apple-on-a-table.png": a name that sorts by time and says what it is. */
export function imageFileName(prompt: string, at: Date, ext = '.png', n = 0): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const slug =
    prompt
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'image';
  return `${stamp}-${slug}${n ? `-${n + 1}` : ''}${ext}`;
}

/** The file extension for a picture's MIME type. */
export function extOf(mime: string): string {
  if (/jpe?g/i.test(mime)) return '.jpg';
  if (/webp/i.test(mime)) return '.webp';
  return '.png';
}

// ---- Page scripts (run inside gemini.google.com) ----

const SIGNED_IN = `!!document.querySelector('[aria-label*="Google Account" i], img.gb_P, a[href*="SignOutOptions"]')`;
const SIGNED_OUT = `!!document.querySelector('a[href*="ServiceLogin"], a[href*="accounts.google.com/v3/signin"]') || [...document.querySelectorAll('button, a')].some(e => e.innerText?.trim() === 'Sign in')`;
const EDITOR = `document.querySelector('div.ql-editor[contenteditable="true"]')`;
const BUSY = `!!document.querySelector('button[aria-label*="Stop" i]')`;
const LAST_ANSWER = `[...document.querySelectorAll('model-response')].at(-1)`;
/** The answer's big pictures (icons and avatars are small). */
const ANSWER_IMAGES = `(() => { const r = ${LAST_ANSWER}; if (!r) return []; return [...r.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth >= 256 && i.naturalHeight >= 256).map(i => i.src); })()`;

/** Gemini's own words in its last answer, for when no picture came. */
const ANSWER_TEXT = `(${LAST_ANSWER}?.querySelector('message-content')?.innerText ?? ${LAST_ANSWER}?.innerText ?? '').trim()`;

/**
 * Harv's Gemini: one picture request at a time, in a headless Chrome on Harv's Gemini
 * profile (started for the request, closed after). Signing in opens the same profile in
 * a window the user sees.
 */
export class GeminiImages {
  private chrome: HarvChrome | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private profile = PROFILE,
    private outDir = IMAGES_DIR,
  ) {}

  /** Opens Gemini in a Chrome window on Harv's profile, for the user to sign in (or check the account). */
  async openSignIn(): Promise<void> {
    if (this.chrome?.running && !this.chrome.headless) {
      await this.chrome.open(GEMINI_URL).then((p) => p.close());
      return;
    }
    this.chrome?.quit();
    const chrome = await HarvChrome.launch(this.profile, { headless: false, url: GEMINI_URL });
    this.chrome = chrome;
    chrome.onExit(() => {
      if (this.chrome === chrome) this.chrome = null;
    });
  }

  /** Makes pictures for `prompt` (optionally from the user's pictures) and returns where they were saved and what Gemini said. */
  generate(prompt: string, inputs: string[] = []): Promise<{ paths: string[]; text: string }> {
    const run = this.queue.then(() => this.run(prompt, inputs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(prompt: string, inputs: string[]): Promise<{ paths: string[]; text: string }> {
    const files = inputs.map(checkInput);
    // The sign-in window may still be open: use it (a profile can't be opened twice).
    const own = !this.chrome?.running;
    if (own) this.chrome = await HarvChrome.launch(this.profile, { headless: true });
    const chrome = this.chrome!;
    const page = await chrome.open(GEMINI_URL);
    try {
      await page.send('Network.enable');
      const images = new Map<string, string>();
      page.on('Network.responseReceived', (p) => {
        const r = p.response as { url: string; mimeType: string };
        if (/^image\//.test(r.mimeType)) images.set(r.url, p.requestId as string);
      });
      if (chrome.headless) {
        // Headless Chrome says so in its user agent; Gemini gets the normal one.
        const ua = await page.eval<string>('navigator.userAgent');
        await page.send('Network.setUserAgentOverride', { userAgent: ua.replace('HeadlessChrome', 'Chrome') });
        await page.send('Page.reload');
      }
      await page.send('Page.enable');
      // A value, not the element itself (an element can't be sent back by value).
      if (!(await page.waitFor(`!!${EDITOR}`, 30_000)))
        throw new GeminiProblem('The Gemini page changed (no prompt box found), so the image script needs an update.');
      // A cookie question (signed out, or a new profile) is answered with the least.
      await page.eval(
        `[...document.querySelectorAll('button')].find(e => /^(Reject all|Odmietnuť všetko)$/.test(e.innerText.trim()))?.click()`,
      );
      await sleep(1200);
      if (!(await page.eval<boolean>(SIGNED_IN)) && (await page.eval<boolean>(SIGNED_OUT))) {
        throw new GeminiProblem('signed-out');
      }
      for (const file of files) await this.attach(page, file);
      await page.eval(`${EDITOR}.focus()`);
      await page.send('Input.insertText', { text: prompt });
      await sleep(400);
      const sent = await page.eval<boolean>(
        `(() => { const b = document.querySelector('button[aria-label*="Send" i]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
      );
      if (!sent) throw new GeminiProblem('The Gemini page changed (no Send button), so the image script needs an update.');

      // The answer: done when Gemini stops writing and its pictures have loaded.
      const start = Date.now();
      let srcs: string[] = [];
      let quietSince = 0;
      while (Date.now() - start < ANSWER_MS) {
        await sleep(1500);
        const busy = await page.eval<boolean>(BUSY).catch(() => true);
        srcs = await page.eval<string[]>(ANSWER_IMAGES).catch(() => []);
        if (busy) {
          quietSince = 0;
          continue;
        }
        quietSince ||= Date.now();
        // Pictures can arrive a moment after the text.
        if (srcs.length && Date.now() - quietSince > 2500) break;
        if (!srcs.length && Date.now() - quietSince > 12_000 && Date.now() - start > 15_000) break;
      }
      const text = await page.eval<string>(ANSWER_TEXT).catch(() => '');
      if (!srcs.length) {
        throw new GeminiProblem(
          text
            ? `Gemini answered without a picture: "${text.slice(0, 600)}"`
            : 'Gemini gave no picture in time (4 minutes), or the page changed.',
        );
      }
      mkdirSync(this.outDir, { recursive: true });
      const at = new Date();
      const paths: string[] = [];
      for (const [i, src] of srcs.entries()) {
        const img = await this.bytes(page, src, images);
        if (!img) continue;
        let name = imageFileName(prompt, at, extOf(img.mime), i);
        for (let n = 2; existsSync(join(this.outDir, name)); n++) name = imageFileName(`${prompt} ${n}`, at, extOf(img.mime), i);
        const path = join(this.outDir, name);
        writeFileSync(path, img.data);
        paths.push(path);
      }
      if (!paths.length) throw new GeminiProblem('Gemini made a picture, but Harv couldn’t save it (the page changed?).');
      return { paths, text };
    } finally {
      page.close();
      if (own) {
        chrome.quit();
        if (this.chrome === chrome) this.chrome = null;
      }
    }
  }

  /** One of the user's pictures into the prompt box, pasted like Ctrl+V. */
  private async attach(page: CdpPage, file: { path: string; mime: string }): Promise<void> {
    const b64 = readFileSync(file.path).toString('base64');
    const before = await page.eval<number>(`document.querySelectorAll('img').length`);
    await page.eval(`(() => {
      const bin = atob(${JSON.stringify(b64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(basename(file.path))}, { type: ${JSON.stringify(file.mime)} });
      const data = new DataTransfer();
      data.items.add(file);
      const editor = ${EDITOR};
      editor.focus();
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    const shown = await page.waitFor(`document.querySelectorAll('img').length > ${before}`, 15_000);
    if (!shown) throw new GeminiProblem(`Gemini didn’t take the picture ${basename(file.path)} (the page changed?).`);
    await sleep(1500);
  }

  /** A picture's bytes: fetched by the page, else from Chrome's network log, else a screenshot of it. */
  private async bytes(page: CdpPage, src: string, seen: Map<string, string>): Promise<{ data: Buffer; mime: string } | null> {
    const fetched = await page
      .eval<string | null>(
        `(async () => { try { const r = await fetch(${JSON.stringify(src)}, { credentials: 'include' }); if (!r.ok) return null; const b = await r.blob(); return await new Promise(ok => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); }); } catch { return null; } })()`,
      )
      .catch(() => null);
    const m = fetched && /^data:([^;]+);base64,(.+)$/.exec(fetched);
    if (m && m[1]!.startsWith('image/')) return { mime: m[1]!, data: Buffer.from(m[2]!, 'base64') };
    const requestId = seen.get(src);
    if (requestId) {
      const body = await page.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId }).catch(() => null);
      if (body?.base64Encoded) return { mime: 'image/png', data: Buffer.from(body.body, 'base64') };
    }
    const box = await page.eval<{ x: number; y: number; width: number; height: number } | null>(
      `(() => { const i = [...document.querySelectorAll('img')].find(e => e.src === ${JSON.stringify(src)}); if (!i) return null; i.scrollIntoView(); const r = i.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    if (!box) return null;
    const shot = await page
      .send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } })
      .catch(() => null);
    return shot ? { mime: 'image/png', data: Buffer.from(shot.data, 'base64') } : null;
  }

  close(): void {
    this.chrome?.quit();
    this.chrome = null;
  }
}

/** A picture the user gave Harv: it must exist, be a picture and fit. */
function checkInput(path: string): { path: string; mime: string } {
  const mime = INPUT_TYPES[extname(path).toLowerCase()];
  if (!mime) throw new GeminiProblem(`${basename(path)} isn’t a PNG, JPG or WebP picture.`);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new GeminiProblem(`${path} doesn’t exist.`);
  if (st.size > MAX_INPUT_BYTES) throw new GeminiProblem(`${basename(path)} is bigger than 10 MB.`);
  return { path, mime };
}
