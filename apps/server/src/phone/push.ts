import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';
import type { ServerMessage } from '@harv/shared';
import type { PhoneStore } from './phones.ts';

// Notifications on the phone (docs/PLAN.md §6q): web push through Apple's push service, free.
// A push carries a short title and line only, never chat content beyond that line.

export interface PushNote {
  title: string;
  body: string;
  /** Opens this chat when tapped. */
  tabId?: string;
  /** Tapping opens the chat in voice mode and Harv says `body` ("Harv wants to talk"). */
  talk?: boolean;
  /** Same tag = replaces the older notification. */
  tag?: string;
}

interface Vapid {
  publicKey: string;
  privateKey: string;
}

/** The server's VAPID keys, made once. */
export function loadVapid(file: string): Vapid {
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as Vapid;
      if (v.publicKey && v.privateKey) return v;
    } catch {
      /* made again below */
    }
  }
  const v = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
  return v;
}

/** What a dashboard event means for the phone, if anything (pure, tested). `phoneTurn`: the turn came from the phone. */
export function noteFor(msg: ServerMessage, phoneTurn: (tabId: string) => boolean, title: (tabId: string) => string): PushNote | null {
  switch (msg.type) {
    case 'chat.done':
      if (!phoneTurn(msg.tabId) || msg.stopped) return null;
      return {
        title: msg.ok ? 'Harv is done' : 'Harv ran into a problem',
        body: title(msg.tabId),
        tabId: msg.tabId,
        tag: `done-${msg.tabId}`,
      };
    // Harv waits for the user (approve, answer, a plan): the phone is how they hear of it away from the computer.
    case 'approval.request': {
      const a = msg.approval;
      const title = a.kind === 'question' ? 'Harv has a question' : a.kind === 'plan' ? 'Harv’s plan is ready' : 'Harv needs your OK';
      return { title, body: `${a.summary}`.slice(0, 140), tabId: a.tabId, tag: `approval-${a.id}` };
    }
    case 'usage.warning':
      return {
        title: `Claude ${msg.warning.label} at ${msg.warning.percent}%`,
        body: 'Your plan limit is getting close.',
        tag: `usage-${msg.warning.kind}`,
      };
    case 'watchdog.alert':
      return { title: msg.alert.title, body: msg.alert.detail.slice(0, 140), tag: `watchdog-${msg.alert.kind}` };
    case 'schedule.ran':
      return {
        title: `Scheduled: ${msg.task.title}`,
        body: msg.late ? 'Ran late (Harv was off when it was due).' : 'Ran just now.',
        tabId: msg.task.tabId,
      };
    default:
      return null;
  }
}

export class PhonePush {
  private vapid: Vapid;

  constructor(
    private phones: PhoneStore,
    vapidFile: string,
    private log: (msg: string) => void,
  ) {
    this.vapid = loadVapid(vapidFile);
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  /** To every paired phone that allowed notifications. Gone subscriptions are dropped. */
  async send(note: PushNote): Promise<number> {
    let sent = 0;
    for (const phone of this.phones.list()) {
      const sub = this.phones.get(phone.id)?.push;
      if (!sub) continue;
      try {
        await webpush.sendNotification(sub, JSON.stringify(note), {
          TTL: 3600,
          urgency: note.talk ? 'high' : 'normal',
          // Apple refuses a subject that isn't a real https: or mailto: contact; the public repo is one.
          vapidDetails: { subject: 'https://github.com/mrtngrega/Harv', ...this.vapid },
        });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) this.phones.setPush(phone.id, undefined);
        this.log(`Push to ${phone.name} failed: ${status ?? (err as Error).message}`);
      }
    }
    return sent;
  }
}
