import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DriveInfo, FileEntry, FileProps } from '@harv/shared';
import { files } from './api.ts';
import { FileIcon, iconKind, isImage, isMedia, isPdf, isTextLike, typeName } from './fileTypes.tsx';
import { bytes as formatSize } from './icons.tsx';

export const when = (ms?: number) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '');

// ---- Popup menus (right-click and the toolbar dropdowns) ---------------------

export type MenuItem =
  { label: string; hint?: string; icon?: ReactNode; disabled?: boolean; checked?: boolean; danger?: boolean; run: () => void } | 'sep';

/** A menu at a screen point, rendered on <body> (the glass panels break `position: fixed`). */
export function PopupMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });

  // Keep it on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }}
      className="fixed z-50 flex min-w-[220px] flex-col rounded-xl border border-[rgb(220_232_245/0.16)] bg-[rgb(16_24_34/0.96)] p-1.5 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.45)] backdrop-blur-[22px]"
      style={{ left: at.x, top: at.y }}
    >
      {items.map((item, i) =>
        item === 'sep' ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={i}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
            className={`flex min-h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-white/10 focus:bg-white/10 focus:outline-none disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent ${
              item.danger ? 'text-warn' : 'text-ink'
            }`}
          >
            <span aria-hidden="true" className="flex w-4 justify-center text-accent">
              {item.checked ? '•' : item.icon}
            </span>
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="text-[11px] text-faint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** A toolbar button that opens a menu below it. */
export function DropButton({ label, icon, items, title }: { label: string; icon?: ReactNode; items: () => MenuItem[]; title?: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.left, y: r.bottom + 4 });
        }}
        className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-white/10"
      >
        {icon}
        {label}
        <span className="text-[10px] text-faint">▾</span>
      </button>
      {at && <PopupMenu x={at.x} y={at.y} items={items()} onClose={() => setAt(null)} />}
    </>
  );
}

// ---- Address bar ----------------------------------------------------------------

export const HOME = 'home';
export const THIS_PC = 'thispc';

export function locationName(loc: string, drives: DriveInfo[]): string {
  if (loc === HOME) return 'Home';
  if (loc === THIS_PC) return 'This PC';
  const drive = drives.find((d) => d.path.toLowerCase() === loc.toLowerCase());
  if (drive) return `${drive.label} (${drive.path.slice(0, 2)})`;
  return loc.split('\\').filter(Boolean).at(-1) ?? loc;
}

/** "This PC › Local Disk (C:) › Users › you", each part clickable; click the empty space to type a path. */
export function Breadcrumb({
  loc,
  drives,
  onGo,
  onDropOn,
}: {
  loc: string;
  drives: DriveInfo[];
  onGo: (loc: string) => void;
  onDropOn: (dir: string, e: React.DragEvent) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [folded, setFolded] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) setTimeout(() => input.current?.select(), 0);
  }, [editing]);

  const parts: { label: string; loc: string }[] = [];
  if (loc === HOME) parts.push({ label: 'Home', loc: HOME });
  else {
    parts.push({ label: 'This PC', loc: THIS_PC });
    if (loc !== THIS_PC) {
      const [drive, ...rest] = loc.split('\\').filter(Boolean);
      let path = `${drive}\\`;
      parts.push({ label: locationName(path, drives), loc: path });
      for (const segment of rest) {
        path = path.endsWith('\\') ? `${path}${segment}` : `${path}\\${segment}`;
        parts.push({ label: segment, loc: path });
      }
    }
  }

  // Long paths: the first parts fold into a « menu, like Explorer, and the last three stay visible.
  const hidden = parts.length > 4 ? parts.slice(0, -3) : [];
  const shown = parts.length > 4 ? parts.slice(-3) : parts;

  if (editing) {
    return (
      <form
        className="min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          const text = draft.trim();
          if (!text) return;
          onGo(/^this pc$/i.test(text) ? THIS_PC : /^home$/i.test(text) ? HOME : text.replace(/\//g, '\\'));
        }}
      >
        <label className="sr-only" htmlFor="explorer-address">
          Address
        </label>
        <input
          id="explorer-address"
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          className="min-h-8 w-full rounded-lg border border-accent/60 bg-black/30 px-2.5 text-xs text-ink outline-none"
        />
      </form>
    );
  }

  return (
    <div
      className="flex min-h-8 min-w-0 flex-1 cursor-text items-center overflow-hidden rounded-lg border border-line bg-black/20 px-1 text-xs"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        setDraft(loc === HOME ? 'Home' : loc === THIS_PC ? 'This PC' : loc);
        setEditing(true);
      }}
      title="Click an empty spot to type a path"
    >
      <span aria-hidden="true" className="px-1">
        <FileIcon kind={loc === HOME || loc === THIS_PC ? 'drive' : 'folder'} size={15} />
      </span>
      {hidden.length > 0 && (
        <button
          type="button"
          aria-label="Earlier folders"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setFolded({ x: r.left, y: r.bottom + 4 });
          }}
          className="flex-none cursor-pointer rounded px-1.5 py-1 text-faint hover:bg-white/10"
        >
          «
        </button>
      )}
      {shown.map((p, i) => (
        <span key={p.loc} className="flex min-w-0 flex-none items-center last:flex-initial">
          {(i > 0 || hidden.length > 0) && <span className="px-0.5 text-faint">›</span>}
          <button
            type="button"
            onClick={() => onGo(p.loc)}
            onDragOver={(e) => p.loc !== HOME && p.loc !== THIS_PC && e.preventDefault()}
            onDrop={(e) => onDropOn(p.loc, e)}
            className="max-w-[200px] cursor-pointer truncate rounded px-1.5 py-1 whitespace-nowrap hover:bg-white/10"
            title={p.loc}
          >
            {p.label}
          </button>
        </span>
      ))}
      {folded && (
        <PopupMenu
          x={folded.x}
          y={folded.y}
          items={[...hidden].reverse().map((p) => ({
            label: p.label,
            icon: <FileIcon kind={p.loc === THIS_PC || p.loc.length === 3 ? 'drive' : 'folder'} size={13} />,
            run: () => onGo(p.loc),
          }))}
          onClose={() => setFolded(null)}
        />
      )}
      <span
        className="min-w-8 flex-1 self-stretch"
        onClick={() => {
          setDraft(loc === HOME ? 'Home' : loc === THIS_PC ? 'This PC' : loc);
          setEditing(true);
        }}
      />
    </div>
  );
}

// ---- Details pane -----------------------------------------------------------------

function PreviewBody({ entry }: { entry: FileEntry }) {
  const [text, setText] = useState<string | null>(null);
  const textual = isTextLike(entry.name) && (entry.size ?? 0) <= 256 * 1024;

  useEffect(() => {
    if (!textual) return;
    let live = true;
    fetch(files.raw(entry.path))
      .then((r) => r.text())
      .then((t) => live && setText(t.slice(0, 20_000)))
      .catch(() => live && setText(null));
    return () => {
      live = false;
    };
  }, [entry.path, textual]);

  if (isImage(entry.name)) return <img src={files.raw(entry.path)} alt="" className="max-h-[45vh] w-full rounded-lg object-contain" />;
  if (isPdf(entry.name)) return <iframe title={entry.name} src={files.raw(entry.path)} className="h-[45vh] w-full rounded-lg bg-white" />;
  if (isMedia(entry.name)) {
    return /\.(mp3|wav)$/i.test(entry.name) ? (
      <audio controls src={files.raw(entry.path)} className="w-full" />
    ) : (
      <video controls src={files.raw(entry.path)} className="max-h-[45vh] w-full rounded-lg" />
    );
  }
  if (textual && text !== null) {
    return (
      <pre className="m-0 max-h-[45vh] overflow-auto rounded-lg bg-black/25 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {text}
      </pre>
    );
  }
  return (
    <div className="flex justify-center py-6">
      <FileIcon kind={iconKind(entry)} size={72} />
    </div>
  );
}

/** The right-hand Details pane: a preview and the facts about what's selected. */
export function DetailsPane({ selected, folderName, count }: { selected: FileEntry[]; folderName: string; count: number }) {
  const one = selected.length === 1 ? selected[0]! : null;
  const total = selected.reduce((sum, e) => sum + (e.size ?? 0), 0);
  return (
    <aside aria-label="Details" className="flex w-[300px] flex-none flex-col gap-3 overflow-y-auto border-l border-line p-3 text-xs">
      {one ? (
        <>
          <div className="flex items-center gap-2">
            <FileIcon kind={iconKind(one)} size={20} />
            <span className="min-w-0 flex-1 truncate font-semibold" title={one.name}>
              {one.name}
            </span>
          </div>
          {!one.dir && <PreviewBody key={one.path} entry={one} />}
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted">Type</dt>
            <dd className="m-0">{typeName(one)}</dd>
            {one.size !== undefined && (
              <>
                <dt className="text-muted">Size</dt>
                <dd className="m-0">{formatSize(one.size)}</dd>
              </>
            )}
            <dt className="text-muted">Modified</dt>
            <dd className="m-0">{when(one.mtime)}</dd>
            <dt className="text-muted">Location</dt>
            <dd className="m-0 break-all">{one.path.slice(0, one.path.lastIndexOf('\\')) || one.path}</dd>
          </dl>
        </>
      ) : selected.length > 1 ? (
        <p className="m-0 text-muted">
          {selected.length} items selected{total ? ` · ${formatSize(total)}` : ''}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <FileIcon kind="folder" size={20} />
            <span className="font-semibold">{folderName}</span>
          </div>
          <p className="m-0 text-muted">{count} items. Select a file to preview it here.</p>
        </>
      )}
    </aside>
  );
}

// ---- Dialogs ----------------------------------------------------------------------

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgb(10_16_24/0.55)]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className="animate-fade-in flex w-full max-w-[440px] flex-col gap-3 rounded-2xl border border-[rgb(220_232_245/0.16)] bg-[rgb(16_24_34/0.97)] p-4 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.45)]"
      >
        <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirm,
  onYes,
  onClose,
}: {
  title: string;
  message: string;
  confirm: string;
  onYes: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="m-0 leading-relaxed text-muted">{message}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="min-h-8 cursor-pointer rounded-lg border border-line px-3 hover:bg-white/10">
          Cancel
        </button>
        <button
          type="button"
          autoFocus
          onClick={() => {
            onClose();
            onYes();
          }}
          className="min-h-8 cursor-pointer rounded-lg bg-warn px-3 font-semibold text-[#0f1620]"
        >
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** Explorer's Properties: type, location, size (with what's inside a folder) and dates. */
export function PropertiesDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [props, setProps] = useState<FileProps | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    files.props(path).then(setProps, (e: Error) => setError(e.message));
  }, [path]);
  const rows: [string, string][] = props
    ? [
        ['Type', typeName(props)],
        ['Location', path.slice(0, path.lastIndexOf('\\')) || path],
        ['Size', `${formatSize(props.size)} (${props.size.toLocaleString()} bytes)${props.partial ? ', at least' : ''}`],
        ...(props.dir ? [['Contains', `${props.files ?? 0} files, ${props.folders ?? 0} folders`] as [string, string]] : []),
        ['Created', when(props.created)],
        ['Modified', when(props.modified)],
        ['Accessed', when(props.accessed)],
        ['Attributes', props.readOnly ? 'Read-only' : '—'],
      ]
    : [];
  return (
    <Dialog title={`${props?.name ?? path.split('\\').at(-1)} Properties`} onClose={onClose}>
      {error ? (
        <p className="m-0 text-warn">! {error}</p>
      ) : !props ? (
        <p className="m-0 text-muted">Counting…</p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <FileIcon kind={iconKind(props)} size={36} />
            <span className="font-semibold break-all">{props.name}</span>
          </div>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="m-0 break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="min-h-8 cursor-pointer rounded-lg border border-line px-3 hover:bg-white/10"
        >
          OK
        </button>
      </div>
    </Dialog>
  );
}
