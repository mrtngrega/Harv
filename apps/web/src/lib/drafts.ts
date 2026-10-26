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
// A store (not component state) so the file explorer can attach files to a chat too.
const drafts = createStore<Record<string, Pending[]>>({});
// Unsent message text per chat, so switching tabs (or restarting) keeps what was typed.
const texts = createStore<Record<string, string>>({});

export const useDrafts = drafts.use;
export const useDraftTexts = texts.use;
export const getDrafts = drafts.get;
export const getDraftTexts = texts.get;
export const subscribeDrafts = (fn: () => void) => {
  const a = drafts.subscribe(fn);
  const b = texts.subscribe(fn);
  return () => (a(), b());
};

export function updatePending(tabId: string, fn: (list: Pending[]) => Pending[]): void {
  drafts.set((all) => ({ ...all, [tabId]: fn(all[tabId] ?? []) }));
}

/** Adds a file that's already on the server. */
export function addAttachment(tabId: string, file: Attachment): void {
  updatePending(tabId, (list) => [...list, { key: crypto.randomUUID(), name: file.name, size: file.size, file }]);
}

/** The last part of a path (`C:\Users\me\Reports` → `Reports`), either OS. */
export const lastPart = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * Points the chat's next message at a file or folder on the PC (the app's picker, `@`, the file
 * explorer): nothing is uploaded, Harv works on it where it is. The same path twice is kept once.
 */
export function addReference(tabId: string, ref: { path: string; folder?: boolean; size?: number }): void {
  const file: Attachment = { id: '', name: lastPart(ref.path), size: ref.size ?? 0, mime: '', path: ref.path, folder: ref.folder };
  updatePending(tabId, (list) =>
    list.some((p) => p.file?.path === ref.path) ? list : [...list, { key: crypto.randomUUID(), name: file.name, size: file.size, file }],
  );
}

export function setDraftText(tabId: string, text: string): void {
  texts.set((all) => {
    const { [tabId]: _old, ...rest } = all;
    return text ? { ...rest, [tabId]: text } : rest;
  });
}

/** A chat closed: its drafts go too. */
export function dropDrafts(tabId: string): void {
  setDraftText(tabId, '');
  drafts.set(({ [tabId]: _gone, ...rest }) => rest);
}

/**
 * The other device's drafts (sync): they replace these, text and ready files alike. Files
 * still uploading here stay.
 */
export function replaceDrafts(text: Record<string, string>, files: Record<string, Attachment[]>): void {
  texts.set(() => ({ ...text }));
  drafts.set((all) => {
    const out: Record<string, Pending[]> = {};
    for (const id of new Set([...Object.keys(all), ...Object.keys(files)])) {
      const uploading = (all[id] ?? []).filter((p) => !p.file && !p.error);
      const ready = (files[id] ?? []).map((file) => ({ key: crypto.randomUUID(), name: file.name, size: file.size, file }));
      if (uploading.length || ready.length) out[id] = [...ready, ...uploading];
    }
    return out;
  });
}

/** Puts back drafts saved before a restart. */
export function restoreDrafts(text: Record<string, string>, files: Record<string, Attachment[]>): void {
  texts.set((all) => ({ ...text, ...all }));
  for (const [tabId, list] of Object.entries(files)) {
    if (!drafts.get()[tabId]?.length)
      updatePending(tabId, () => list.map((file) => ({ key: crypto.randomUUID(), name: file.name, size: file.size, file })));
  }
}
