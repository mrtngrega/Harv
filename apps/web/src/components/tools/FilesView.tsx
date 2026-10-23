import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { Attachment, FileEntry, FilePlaces, FolderListing } from '@harv/shared';
import { chat } from '../../lib/chatStore.ts';
import { addAttachment } from '../../lib/drafts.ts';
import { formatSize } from '../../lib/attachments.ts';
import { lineTime } from '../../lib/format.ts';

/** Selects a box's text after the click that focused it (selecting on focus alone gets undone by mouseup). */
export const selectAll = (input: HTMLInputElement) => setTimeout(() => input.select(), 0);

/** Where each files tab was, so switching tabs and back keeps the folder. */
const lastPath = new Map<string, string>();

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const MEDIA = /\.(mp4|webm|mp3|wav)$/i;
const PDF = /\.pdf$/i;
const BINARY = /\.(exe|dll|msi|zip|7z|rar|iso|bin|dat|db|sqlite|lnk|sys|tar|gz|docx?|xlsx?|pptx?)$/i;
/** Text previews stop here; bigger files open in their own app. */
const MAX_TEXT_BYTES = 512 * 1024;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
}

const raw = (path: string) => `/api/files/raw?path=${encodeURIComponent(path)}`;

function Preview({ entry, onStatus }: { entry: FileEntry; onStatus: (s: string | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const isText = !IMAGE.test(entry.name) && !MEDIA.test(entry.name) && !PDF.test(entry.name) && !BINARY.test(entry.name);
  const tooBig = (entry.size ?? 0) > MAX_TEXT_BYTES;

  useEffect(() => {
    if (!isText || tooBig) return;
    let live = true;
    fetch(raw(entry.path))
      .then((r) => r.text())
      .then((t) => live && setText(t))
      .catch(() => live && setText('(Couldn’t read this file.)'));
    return () => {
      live = false;
    };
  }, [entry.path, isText, tooBig]);

  const attach = async () => {
    onStatus('Attaching…');
    try {
      const tabId = chat.ensureTab();
      const file = await postJson<Attachment>('/api/files/attach', { path: entry.path, tab: tabId });
      addAttachment(tabId, file);
      onStatus(null);
    } catch (err) {
      onStatus(`Couldn’t attach: ${(err as Error).message}`);
    }
  };

  const button = 'min-h-8 cursor-pointer rounded-lg border border-line bg-white/5 px-2.5 text-xs hover:bg-white/10';
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold" title={entry.path}>
          {entry.name}
        </span>
        <span className="text-[11px] text-faint">{entry.size !== undefined ? formatSize(entry.size) : ''}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={button} onClick={() => void attach()} title="Attach to your chat and switch to it">
          Send to chat
        </button>
        <button type="button" className={button} onClick={() => void postJson('/api/files/open', { path: entry.path })}>
          Open
        </button>
        <button type="button" className={button} onClick={() => void postJson('/api/files/open', { path: entry.path, reveal: true })}>
          Show in Explorer
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg bg-black/25 p-2">
        {IMAGE.test(entry.name) ? (
          <img src={raw(entry.path)} alt={entry.name} className="mx-auto max-h-full max-w-full object-contain" />
        ) : PDF.test(entry.name) ? (
          <iframe title={entry.name} src={raw(entry.path)} className="h-[60vh] w-full rounded bg-white" />
        ) : MEDIA.test(entry.name) ? (
          /\.(mp3|wav)$/i.test(entry.name) ? (
            <audio controls src={raw(entry.path)} className="w-full" />
          ) : (
            <video controls src={raw(entry.path)} className="max-h-full w-full" />
          )
        ) : !isText ? (
          <p className="m-0 text-xs text-muted">No preview for this kind of file. Open it with its app instead.</p>
        ) : tooBig ? (
          <p className="m-0 text-xs text-muted">Too big to preview here ({formatSize(entry.size ?? 0)}). Open it with its app instead.</p>
        ) : (
          <pre className="m-0 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">{text ?? 'Loading…'}</pre>
        )}
      </div>
    </div>
  );
}

/** The file explorer tab: browse folders, preview files, open them, or send them to a chat. */
export function FilesView({ id }: { id: string }) {
  const [places, setPlaces] = useState<FilePlaces | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [back, setBack] = useState<string[]>([]);
  const [forward, setForward] = useState<string[]>([]);

  const load = useCallback(
    async (path: string, history: 'push' | 'none' = 'push') => {
      try {
        const next = await getJson<FolderListing>(`/api/files/list?path=${encodeURIComponent(path)}`);
        if (history === 'push' && listing && listing.path !== next.path) {
          setBack((b) => [...b, listing.path]);
          setForward([]);
        }
        setListing(next);
        setPathDraft(next.path);
        setSelected(null);
        setFilter('');
        setError(null);
        lastPath.set(id, next.path);
      } catch (err) {
        setError((err as Error).message);
        setPathDraft(listing?.path ?? path);
      }
    },
    [id, listing],
  );

  useEffect(() => {
    void getJson<FilePlaces>('/api/files/places').then((p) => {
      setPlaces(p);
      void load(lastPath.get(id) ?? p.places[0]?.path ?? p.drives[0] ?? 'C:\\', 'none');
    });
    // Only on first show of this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (listing?.entries ?? []).filter((e) => (showHidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)));
  }, [listing, filter, showHidden]);

  const activate = (e: FileEntry) => (e.dir ? void load(e.path) : setSelected(e));
  const goBack = () => {
    const prev = back.at(-1);
    if (!prev || !listing) return;
    setBack((b) => b.slice(0, -1));
    setForward((f) => [listing.path, ...f]);
    void load(prev, 'none');
  };
  const goForward = () => {
    const next = forward[0];
    if (!next || !listing) return;
    setForward((f) => f.slice(1));
    setBack((b) => [...b, listing.path]);
    void load(next, 'none');
  };

  const onRowKey = (e: KeyboardEvent, entry: FileEntry) => {
    if (e.key === 'Enter') activate(entry);
    if (e.key === 'Backspace' && listing?.parent) void load(listing.parent);
  };

  const iconButton = 'size-8 flex-none cursor-pointer rounded-lg text-sm hover:bg-white/10 disabled:cursor-default disabled:opacity-30';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <button type="button" className={iconButton} onClick={goBack} disabled={!back.length} aria-label="Back">
          ←
        </button>
        <button type="button" className={iconButton} onClick={goForward} disabled={!forward.length} aria-label="Forward">
          →
        </button>
        <button
          type="button"
          className={iconButton}
          onClick={() => listing?.parent && void load(listing.parent)}
          disabled={!listing?.parent}
          aria-label="Up one folder"
        >
          ↑
        </button>
        <form
          className="min-w-[200px] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void load(pathDraft);
          }}
        >
          <label htmlFor={`path-${id}`} className="sr-only">
            Folder path
          </label>
          <input
            id={`path-${id}`}
            value={pathDraft}
            onFocus={(e) => selectAll(e.target)}
            onChange={(e) => setPathDraft(e.target.value)}
            className="min-h-8 w-full rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none focus:border-accent/60"
          />
        </form>
        <button type="button" className={iconButton} onClick={() => listing && void load(listing.path, 'none')} aria-label="Refresh">
          ⟳
        </button>
        <label htmlFor={`filter-${id}`} className="sr-only">
          Filter this folder
        </label>
        <input
          id={`filter-${id}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          className="min-h-8 w-32 rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
        />
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          hidden
        </label>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav aria-label="Places" className="flex w-36 flex-none flex-col gap-0.5 overflow-y-auto border-r border-line p-2 text-xs">
          {places?.places.map((p) => (
            <button
              key={p.path}
              type="button"
              onClick={() => void load(p.path)}
              className={`cursor-pointer truncate rounded-md px-2 py-1.5 text-left hover:bg-white/5 ${listing?.path === p.path ? 'bg-white/10' : ''}`}
            >
              {p.name}
            </button>
          ))}
          <div className="mt-2 px-2 text-[11px] tracking-[2px] text-faint">DRIVES</div>
          {places?.drives.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => void load(d)}
              className={`cursor-pointer rounded-md px-2 py-1.5 text-left hover:bg-white/5 ${listing?.path === d ? 'bg-white/10' : ''}`}
            >
              {d}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-[260px] flex-1 flex-col overflow-y-auto">
          {error && <p className="m-0 px-3 py-2 text-xs text-warn">! {error}</p>}
          {status && <p className="m-0 px-3 py-2 text-xs text-muted">{status}</p>}
          <ul role="listbox" aria-label="Files" className="m-0 list-none p-1 text-xs">
            {entries.length === 0 && listing && (
              <li className="px-2 py-3 text-muted">{filter ? 'Nothing matches.' : 'This folder is empty.'}</li>
            )}
            {entries.map((e) => (
              <li
                key={e.path}
                role="option"
                aria-selected={selected?.path === e.path}
                tabIndex={0}
                onClick={() => (e.dir ? undefined : setSelected(e))}
                onDoubleClick={() => activate(e)}
                onKeyDown={(k) => onRowKey(k, e)}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5 ${
                  selected?.path === e.path ? 'bg-white/10' : ''
                } ${e.hidden ? 'opacity-60' : ''}`}
              >
                <span aria-hidden="true" className={e.dir ? 'text-accent' : 'text-faint'}>
                  {e.dir ? '▸' : '·'}
                </span>
                <span className="min-w-0 flex-1 truncate" title={e.name}>
                  {e.name}
                </span>
                <span className="w-16 flex-none text-right text-faint tabular-nums">{e.mtime ? lineTime(e.mtime) : ''}</span>
                <span className="w-16 flex-none text-right text-faint tabular-nums">{e.size !== undefined ? formatSize(e.size) : ''}</span>
              </li>
            ))}
          </ul>
        </div>

        {selected && (
          <aside
            aria-label="Preview"
            className="flex min-h-0 w-[40%] max-w-[460px] min-w-[260px] flex-none flex-col border-l border-line p-3"
          >
            <Preview key={selected.path} entry={selected} onStatus={setStatus} />
          </aside>
        )}
      </div>
      <p className="m-0 border-t border-line px-3 py-1.5 text-[11px] text-faint">
        Double-click a folder to open it, a file to preview it. Send to chat attaches the file to your last chat.
      </p>
    </div>
  );
}
