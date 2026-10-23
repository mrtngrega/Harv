import type { Attachment } from '@harv/shared';
import { createStore } from './createStore.ts';

/** A file attached to a chat's draft: uploading, ready to send, or failed. */
export interface Pending {
  key: string;
  name: string;
  size: number;
  file?: Attachment;
  error?: string;
}

// Draft attachments per chat tab. Each upload lands in that tab's folder on the server.
// A store (not component state) so the file explorer tab can attach files to a chat too.
const drafts = createStore<Record<string, Pending[]>>({});

export const useDrafts = drafts.use;

export function updatePending(tabId: string, fn: (list: Pending[]) => Pending[]): void {
  drafts.set((all) => ({ ...all, [tabId]: fn(all[tabId] ?? []) }));
}

/** Adds a file that's already on the server (attached from the file explorer). */
export function addAttachment(tabId: string, file: Attachment): void {
  updatePending(tabId, (list) => [...list, { key: crypto.randomUUID(), name: file.name, size: file.size, file }]);
}
