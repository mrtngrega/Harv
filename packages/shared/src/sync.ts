/** Sync between the user's devices (docs/PLAN.md §6m, M10b: through a private Git repo). */

export interface SyncPeer {
  id: string;
  name: string;
  /** When its newest change was written there (epoch ms). */
  lastChange?: number;
  /** The last live exchange with it over Tailscale (epoch ms; M10c). */
  live?: number;
}

export interface SyncStatus {
  enabled: boolean;
  /** This device. */
  device: { id: string; name: string };
  /** A sync is running right now. */
  busy: boolean;
  /** The last sync that finished without an error (epoch ms). */
  lastSync?: number;
  /** What went wrong in the last sync, in plain words. */
  error?: string;
  /** Changes made here that haven't been pushed yet. */
  pending: number;
  /** The other devices seen in the repo. */
  peers: SyncPeer[];
  /** There's no key on this device yet (copy ~/.harv/sync.key from the other one). */
  needsKey?: boolean;
}

export type SyncClientMessage = { type: 'sync.now' };

export type SyncServerMessage = { type: 'sync.status'; status: SyncStatus };
