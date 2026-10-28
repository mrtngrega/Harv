import { randomUUID } from 'node:crypto';
import type { BrowserAction, BrowserServerMessage } from '@harv/shared';

// Harv's browser lives in the desktop app (docs/PLAN.md §6x): real web views the app's
// dashboard drives. The server reaches it through that dashboard's WebSocket: a browser.do
// goes out, a browser.result comes back.

type Send = (msg: BrowserServerMessage) => void;

const NO_APP =
  "The browser lives in the Harv app, which isn't open on this computer right now. Ask the user to open the Harv app (it can stay in the tray), then try again.";

export class BrowserHost {
  private send: Send | null = null;
  private pending = new Map<string, { ok: (v: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();

  /** The app's dashboard said hello: it drives the browser from now on. */
  attach(send: Send): void {
    this.send = send;
  }

  /** A dashboard went away: if it was the app's, what was waiting on it fails. */
  detach(send: Send): void {
    if (this.send !== send) return;
    this.send = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.fail(new Error(NO_APP));
      this.pending.delete(id);
    }
  }

  get ready(): boolean {
    return this.send !== null;
  }

  /** Asks the app to do something in the browser and waits for its answer. */
  call(action: BrowserAction, params: { id?: number; url?: string; script?: string } = {}, timeoutMs = 30_000): Promise<unknown> {
    const send = this.send;
    if (!send) return Promise.reject(new Error(NO_APP));
    const reqId = randomUUID();
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        fail(new Error('The browser didn’t answer in time.'));
      }, timeoutMs);
      this.pending.set(reqId, { ok, fail, timer });
      send({ type: 'browser.do', reqId, action, ...params });
    });
  }

  /** The app's answer to a call. */
  result(reqId: string, ok: boolean, value: unknown, error?: string): void {
    const p = this.pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    if (ok) p.ok(value);
    else p.fail(new Error(error ?? 'The browser couldn’t do that.'));
  }
}
