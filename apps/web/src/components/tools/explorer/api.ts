import type { Attachment, DriveInfo, FileEntry, FileOp, FilePlaces, FileProps, FolderListing } from '@harv/shared';
import { createStore } from '../../../lib/createStore.ts';

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const files = {
  places: () => fetch('/api/files/places').then((r) => json<FilePlaces>(r)),
  drives: () => fetch('/api/files/drives').then((r) => json<DriveInfo[]>(r)),
  recent: () => fetch('/api/files/recent').then((r) => json<FileEntry[]>(r)),
  list: (path: string) => fetch(`/api/files/list?${q({ path })}`).then((r) => json<FolderListing>(r)),
  search: (path: string, query: string) =>
    fetch(`/api/files/search?${q({ path, q: query })}`).then((r) => json<{ results: FileEntry[]; complete: boolean }>(r)),
  props: (path: string) => fetch(`/api/files/props?${q({ path })}`).then((r) => json<FileProps>(r)),
  op: (op: FileOp) => post('/api/files/op', op).then((r) => json<{ paths: string[]; errors: string[] }>(r)),
  open: (path: string, reveal = false) => post('/api/files/open', { path, reveal }).then((r) => json<{ ok: true }>(r)),
  attach: (path: string, tab: string) => post('/api/files/attach', { path, tab }).then((r) => json<Attachment>(r)),
  upload: (dir: string, file: File) =>
    fetch(`/api/files/upload?${q({ dir, name: file.name })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }).then((r) => json<{ path: string }>(r)),
  raw: (path: string) => `/api/files/raw?${q({ path })}`,
};

/** Cut/Copy shared by every explorer tab, like Windows' clipboard for files. */
export const clipboard = createStore<{ mode: 'copy' | 'cut'; paths: string[] } | null>(null);
