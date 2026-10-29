import type { Attachment } from './chat.ts';

// Harv on the phone (docs/PLAN.md §6q): the dashboard over `tailscale serve`, for paired phones only.

/** A paired phone, as Settings › Phone lists it. */
export interface PhoneInfo {
  id: string;
  name: string;
  pairedAt: number;
  /** Last request from it (ms), 0 = never since pairing. */
  lastSeen: number;
  /** It has a Face ID passkey (pairing isn't finished without one). */
  passkey: boolean;
  /** It gets notifications. */
  push: boolean;
  /** It has a Shortcut token (Siri, the share sheet). */
  shortcut: boolean;
}

/** Phone access on this device: `tailscale serve` and what's missing for it. */
export interface PhoneAccess {
  /** Settings › Phone › Phone access is on. */
  enabled: boolean;
  /** `tailscale serve` is running for Harv. */
  serving: boolean;
  /** The address the phone opens (https://<device>.<tailnet>.ts.net), once known. */
  url: string | null;
  /** Why it doesn't work yet, in the user's words (Tailscale down, HTTPS certificates off, the Linux operator…). */
  problem?: string;
}

/** What the phone's page asks before it connects (`GET /api/phone/state`). */
export interface PhoneState {
  /** This phone is paired (its device cookie is known). */
  paired: boolean;
  /** Paired, but its passkey is still to be made. */
  needsPasskey: boolean;
  /** Face ID was done recently: the dashboard can connect. */
  unlocked: boolean;
  /** This computer's name, for the screens. */
  device: string;
  /** The user's other Harv devices the phone can switch to (their phone addresses). */
  others: { name: string; url: string }[];
}

export type PhoneServerMessage =
  /** A phone asked to pair: the computer shows this code, the user types it on the phone. */
  | { type: 'phone.pairing'; name: string; code: string; until: number }
  /** Pairing finished (or failed): the code toast goes. */
  | { type: 'phone.paired'; name: string; ok: boolean }
  | { type: 'phone.list'; phones: PhoneInfo[]; access: PhoneAccess }
  /** The share sheet sent files without a note: they go into the phone chat's draft. */
  | { type: 'phone.shared'; tabId: string; attachments: Attachment[] };

export type PhoneClientMessage =
  | { type: 'phone.list' }
  /** A phone window came to the front or went away (no push while one is in front). */
  | { type: 'phone.visible'; visible: boolean }
  | { type: 'phone.revoke'; id: string }
  | { type: 'phone.rename'; id: string; name: string };
