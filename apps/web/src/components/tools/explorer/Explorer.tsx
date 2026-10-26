import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { DriveInfo, FileEntry, FilePlaces, FolderListing } from '@harv/shared';
import { chat, getChatState } from '../../../lib/chatStore.ts';
import { addReference } from '../../../lib/drafts.ts';
import { dateGroup } from '../../../lib/format.ts';
import { explorerPaths, saveLayoutSoon } from '../../../lib/layout.ts';
import { useProjects, useSettings } from '../../../lib/useHarvSocket.ts';
import { clipboard, files } from './api.ts';
import { FileIcon, iconKind, isImage, typeName } from './fileTypes.tsx';
import { bytes as formatSize, Icon } from './icons.tsx';
import {
  Breadcrumb,
  ConfirmDialog,
  DetailsPane,
  DropButton,
  HOME,
  locationName,
  PopupMenu,
  PropertiesDialog,
  THIS_PC,
  when,
  type MenuItem,
} from './parts.tsx';
import { baseName, dirOf, driveName, driveOf, osWords } from './paths.ts';

type View = 'details' | 'icons' | 'list';
type SortKey = 'name' | 'mtime' | 'type' | 'size';
const DRAG_TYPE = 'application/x-harv-paths';
type Sort = { key: SortKey; desc: boolean };
/** Newest first, folders and files together, like Windows shows Downloads. */
const DEFAULT_SORT: Sort = { key: 'mtime', desc: true };
/** Date and size start with the biggest/newest on top, like Explorer's column headers. */
const startsDesc = (key: SortKey) => key === 'mtime' || key === 'size';

function load<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not critical.
  }
}

/** A chat's file explorer (its view menu), laid out and behaving like Windows 11 File Explorer. `id` is the chat's. */
export function Explorer({ id }: { id: string }) {
  const { workDir } = useSettings();
  const { list: projects } = useProjects();
  const projectPath = projects.find((p) => p.id === getChatState().tabs.find((t) => t.id === id)?.projectId)?.path;
  // Opens where it was, else in its project, else in the user's default folder (Settings), else Home.
  const [loc, setLoc] = useState(() => explorerPaths.get(id) ?? (projectPath || workDir || HOME));
  const [back, setBack] = useState<string[]>([]);
  const [fwd, setFwd] = useState<string[]>([]);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [places, setPlaces] = useState<FilePlaces | null>(null);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [recent, setRecent] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => load('harv.explorer.view', 'details'));
  // Like Windows, each folder remembers its own sort order.
  const [sorts, setSorts] = useState<Record<string, Sort>>(() => load('harv.explorer.sorts', {}));
  const [showHidden, setShowHidden] = useState<boolean>(() => load('harv.explorer.hidden', false));
  const [showPane, setShowPane] = useState<boolean>(() => load('harv.explorer.pane', true));
  const [search, setSearch] = useState<{ query: string; results: FileEntry[]; complete: boolean; loading: boolean } | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [propsFor, setPropsFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const clip = clipboard.use();
  const root = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const isFolder = loc !== HOME && loc !== THIS_PC;
  const sort = sorts[loc.toLowerCase()] ?? DEFAULT_SORT;
  const setSort = (next: Sort) => {
    const all = { ...sorts, [loc.toLowerCase()]: next };
    setSorts(all);
    save('harv.explorer.sorts', all);
  };

  const say = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 5000);
  }, []);

  // ---- Loading ----

  const refresh = useCallback(
    async (target = loc, quiet = false) => {
      if (target === HOME) {
        setRecent(await files.recent().catch(() => []));
        setListing(null);
        return true;
      }
      if (target === THIS_PC) {
        setDrives(await files.drives().catch(() => []));
        setListing(null);
        return true;
      }
      try {
        const next = await files.list(target);
        setListing(next);
        if (!quiet) setError(null);
        return true;
      } catch (err) {
        if (!quiet) setError((err as Error).message);
        return false;
      }
    },
    [loc],
  );

  useEffect(() => {
    void files.places().then(setPlaces);
    void files.drives().then(setDrives);
  }, []);

  useEffect(() => {
    // Kept per chat (and saved), so switching away and back, or restarting, keeps the folder.
    explorerPaths.set(id, loc);
    saveLayoutSoon();
    // refresh() only sets state after its request comes back, not during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(loc);
  }, [id, loc, refresh]);

  // Windows updates the window when files change; a light re-read every few seconds does the same.
  useEffect(() => {
    if (!isFolder || search || renaming) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(loc, true);
    }, 4000);
    return () => clearInterval(timer);
  }, [isFolder, loc, refresh, search, renaming]);

  const go = (to: string, history = true) => {
    if (to === loc && !search) return void refresh(to);
    if (history) {
      setBack((b) => [...b, loc]);
      setFwd([]);
    }
    setSearch(null);
    setSearchDraft('');
    setSelected(new Set());
    setAnchor(null);
    setRenaming(null);
    setError(null);
    setLoc(to);
  };
  const goBack = () => {
    const prev = back.at(-1);
    if (prev === undefined) return;
    setBack((b) => b.slice(0, -1));
    setFwd((f) => [loc, ...f]);
    go(prev, false);
  };
  const goForward = () => {
    const next = fwd[0];
    if (next === undefined) return;
    setFwd((f) => f.slice(1));
    setBack((b) => [...b, loc]);
    go(next, false);
  };
  const goUp = () => {
    if (!isFolder) return go(THIS_PC);
    go(listing?.parent ?? THIS_PC);
  };

  // ---- What's shown ----

  const entries = useMemo(() => {
    const list = (search ? search.results : (listing?.entries ?? [])).filter((e) => showHidden || !e.hidden);
    const dir = sort.desc ? -1 : 1;
    const cmp = (a: FileEntry, b: FileEntry) => {
      switch (sort.key) {
        case 'mtime':
          return ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir;
        case 'size':
          return ((a.size ?? -1) - (b.size ?? -1)) * dir;
        case 'type':
          return typeName(a).localeCompare(typeName(b)) * dir || a.name.localeCompare(b.name);
        default:
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * dir;
      }
    };
    // By date, folders and files mix (newest first); otherwise folders stay on top, like Explorer.
    if (sort.key === 'mtime') return [...list].sort(cmp);
    return [...list].sort((a, b) => Number(b.dir) - Number(a.dir) || cmp(a, b));
  }, [listing, search, showHidden, sort]);

  // Sorted by date, the details view gets Windows' groups: Today, Yesterday, Earlier this week...
  const groups = sort.key === 'mtime' && !search ? entries.map((e) => dateGroup(e.mtime)) : null;
  const groupSizes = new Map<string, number>();
  for (const g of groups ?? []) groupSizes.set(g, (groupSizes.get(g) ?? 0) + 1);

  const selectedEntries = entries.filter((e) => selected.has(e.path));
  const cutPaths = new Set(clip?.mode === 'cut' ? clip.paths : []);

  // ---- Actions ----

  const run = async (op: Parameters<typeof files.op>[0], select = true) => {
    try {
      const result = await files.op(op);
      if (result.errors.length) say(result.errors.join(' · '));
      await refresh(loc, true);
      if (select && result.paths.length) {
        setSelected(new Set(result.paths));
        setAnchor(result.paths[0]!);
      }
      return result;
    } catch (err) {
      say((err as Error).message);
      return null;
    }
  };

  const open = (e: FileEntry) => (e.dir ? go(e.path) : void files.open(e.path).catch((err: Error) => say(err.message)));
  const newItem = async (kind: 'newFolder' | 'newFile') => {
    if (!isFolder) return;
    const result = await run({ op: kind, dir: loc });
    if (result?.paths[0]) setRenaming(result.paths[0]);
  };
  const copy = (mode: 'copy' | 'cut', paths = [...selected]) => {
    if (!paths.length) return;
    clipboard.set({ mode, paths });
    say(`${paths.length} item${paths.length > 1 ? 's' : ''} ${mode === 'cut' ? 'cut' : 'copied'}. Paste them in another folder.`);
  };
  const paste = async (dest = loc) => {
    if (!clip || dest === HOME || dest === THIS_PC) return;
    const result = await run({ op: clip.mode === 'cut' ? 'move' : 'copy', paths: clip.paths, dest });
    if (result && clip.mode === 'cut') clipboard.set(null);
  };
  const remove = async (paths = [...selected], forever = false) => {
    if (!paths.length) return;
    if (forever) return setConfirmDelete(paths);
    const result = await run({ op: 'recycle', paths }, false);
    if (result?.paths.length) say(`${result.paths.length} item${result.paths.length > 1 ? 's' : ''} moved to ${osWords().bin}.`);
    setSelected(new Set());
  };
  const rename = async (path: string, name: string) => {
    setRenaming(null);
    const current = baseName(path);
    if (!name.trim() || name === current) return;
    await run({ op: 'rename', path, name });
  };
  const copyPath = (paths = [...selected]) => {
    void navigator.clipboard.writeText(paths.map((p) => `"${p}"`).join('\r\n'));
    say('Path copied.');
  };
  /** Points this chat's next message at the files and folders (by path, nothing copied) and switches back to the chat to write it. */
  const sendToChat = (paths = [...selected]) => {
    for (const path of paths) {
      const entry = entries.find((x) => x.path === path);
      addReference(id, { path, folder: entry?.dir, size: entry?.size });
    }
    if (paths.length) chat.setView(id, 'chat');
  };
  const openTerminal = (dir: string) => chat.terminalAt(id, dir);
  const openTab = (dir: string) => explorerPaths.set(chat.newTab('files'), dir);
  const runSearch = async (query: string) => {
    if (!query.trim() || !isFolder) return setSearch(null);
    setSearch({ query, results: [], complete: false, loading: true });
    try {
      const { results, complete } = await files.search(loc, query);
      setSearch({ query, results, complete, loading: false });
    } catch (err) {
      setSearch(null);
      say((err as Error).message);
    }
  };

  // ---- Selection ----

  const click = (e: MouseEvent, entry: FileEntry) => {
    root.current?.focus();
    if (e.shiftKey && anchor) {
      const a = entries.findIndex((x) => x.path === anchor);
      const b = entries.findIndex((x) => x.path === entry.path);
      const range = entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path);
      setSelected(new Set(e.ctrlKey ? [...selected, ...range] : range));
      return;
    }
    if (e.ctrlKey) {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSelected(next);
    } else {
      setSelected(new Set([entry.path]));
    }
    setAnchor(entry.path);
  };

  const moveFocus = (delta: number, extend: boolean) => {
    if (!entries.length) return;
    const current = entries.findIndex((x) => x.path === (anchor ?? ''));
    const next = entries[Math.max(0, Math.min(entries.length - 1, current < 0 ? 0 : current + delta))]!;
    setAnchor(next.path);
    if (extend && anchor) {
      const a = entries.findIndex((x) => x.path === anchor);
      const b = entries.indexOf(next);
      setSelected(new Set(entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)));
    } else setSelected(new Set([next.path]));
    document.getElementById(`row-${id}-${next.path}`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const cols =
      view === 'icons' ? Math.max(1, Math.floor(((root.current?.querySelector('[data-items]')?.clientWidth ?? 600) - 16) / 116)) : 1;
    const handled = () => e.preventDefault();
    if (k === 'ArrowDown') return (handled(), moveFocus(cols, e.shiftKey));
    if (k === 'ArrowUp') return (handled(), moveFocus(-cols, e.shiftKey));
    if (k === 'ArrowRight' && view === 'icons') return (handled(), moveFocus(1, e.shiftKey));
    if (k === 'ArrowLeft' && view === 'icons') return (handled(), moveFocus(-1, e.shiftKey));
    if (k === 'ArrowLeft' && e.altKey) return (handled(), goBack());
    if (k === 'ArrowRight' && e.altKey) return (handled(), goForward());
    if (k === 'ArrowUp' && e.altKey) return (handled(), goUp());
    if (k === 'Home') return (handled(), moveFocus(-entries.length, e.shiftKey));
    if (k === 'End') return (handled(), moveFocus(entries.length, e.shiftKey));
    if (k === 'Enter' && selectedEntries.length)
      return (
        handled(),
        selectedEntries.length === 1 ? open(selectedEntries[0]!) : selectedEntries.forEach((x) => !x.dir && void files.open(x.path))
      );
    if (k === 'Backspace') return (handled(), goBack());
    if (k === 'Delete') return (handled(), void remove([...selected], e.shiftKey));
    if (k === 'F2' && selectedEntries.length === 1) return (handled(), setRenaming(selectedEntries[0]!.path));
    if (k === 'F5') return (handled(), void refresh());
    if (ctrl && k.toLowerCase() === 'a') return (handled(), setSelected(new Set(entries.map((x) => x.path))));
    if (ctrl && k.toLowerCase() === 'c') return (handled(), copy('copy'));
    if (ctrl && k.toLowerCase() === 'x') return (handled(), copy('cut'));
    if (ctrl && k.toLowerCase() === 'v') return (handled(), void paste());
    if (ctrl && e.shiftKey && k.toLowerCase() === 'n') return (handled(), void newItem('newFolder'));
    if (ctrl && k.toLowerCase() === 'f') return (handled(), searchBox.current?.focus());
    // Typing a letter jumps to the next item starting with it.
    if (k.length === 1 && !ctrl && !e.altKey) {
      const current = entries.findIndex((x) => x.path === anchor);
      const match = [...entries.slice(current + 1), ...entries.slice(0, current + 1)].find((x) =>
        x.name.toLowerCase().startsWith(k.toLowerCase()),
      );
      if (match) {
        setSelected(new Set([match.path]));
        setAnchor(match.path);
        document.getElementById(`row-${id}-${match.path}`)?.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  // ---- Drag and drop ----

  const dragStart = (e: DragEvent, entry: FileEntry) => {
    const paths = selected.has(entry.path) ? [...selected] : [entry.path];
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  const canDrop = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes('Files');
  const dropOn = async (dir: string, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    if (dir === HOME || dir === THIS_PC) return;
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      const paths = (JSON.parse(raw) as string[]).filter((p) => p !== dir);
      if (!paths.length) return;
      // Like Explorer: moving within a drive, copying to another one (Ctrl copies, Shift moves).
      const sameDrive = paths.every((p) => driveOf(p, drives) === driveOf(dir, drives));
      const op = e.ctrlKey ? 'copy' : e.shiftKey ? 'move' : sameDrive ? 'move' : 'copy';
      await run({ op, paths, dest: dir }, dir === loc);
      return;
    }
    const dropped = [...e.dataTransfer.files];
    for (const file of dropped) {
      try {
        await files.upload(dir, file);
      } catch (err) {
        say(`${file.name}: ${(err as Error).message}`);
      }
    }
    if (dropped.length) {
      say(`${dropped.length} file${dropped.length > 1 ? 's' : ''} copied here.`);
      void refresh(loc, true);
    }
  };
  const dropProps = (dir: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!canDrop(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      setDropTarget(dir);
    },
    onDragLeave: () => setDropTarget((t) => (t === dir ? null : t)),
    onDrop: (e: DragEvent) => void dropOn(dir, e),
  });

  // ---- Menus ----

  const viewItems = (): MenuItem[] => [
    { label: 'Large icons', checked: view === 'icons', run: () => (setView('icons'), save('harv.explorer.view', 'icons')) },
    { label: 'List', checked: view === 'list', run: () => (setView('list'), save('harv.explorer.view', 'list')) },
    { label: 'Details', checked: view === 'details', run: () => (setView('details'), save('harv.explorer.view', 'details')) },
    'sep',
    { label: 'Details pane', checked: showPane, run: () => (setShowPane(!showPane), save('harv.explorer.pane', !showPane)) },
    { label: 'Hidden items', checked: showHidden, run: () => (setShowHidden(!showHidden), save('harv.explorer.hidden', !showHidden)) },
  ];
  const sortItems = (): MenuItem[] => {
    const by = (key: SortKey, label: string): MenuItem => ({
      label,
      checked: sort.key === key,
      run: () => {
        setSort({ key, desc: sort.key === key ? sort.desc : startsDesc(key) });
      },
    });
    const order = (desc: boolean, label: string): MenuItem => ({
      label,
      checked: sort.desc === desc,
      run: () => {
        setSort({ ...sort, desc });
      },
    });
    return [
      by('name', 'Name'),
      by('mtime', 'Date modified'),
      by('type', 'Type'),
      by('size', 'Size'),
      'sep',
      order(false, 'Ascending'),
      order(true, 'Descending'),
    ];
  };
  const newItems = (): MenuItem[] => [
    {
      label: 'Folder',
      icon: <FileIcon kind="folder" size={14} />,
      hint: 'Ctrl+Shift+N',
      disabled: !isFolder,
      run: () => void newItem('newFolder'),
    },
    { label: 'Text Document', icon: <FileIcon kind="text" size={14} />, disabled: !isFolder, run: () => void newItem('newFile') },
  ];
  const moreItems = (): MenuItem[] => [
    { label: 'Select all', hint: 'Ctrl+A', run: () => setSelected(new Set(entries.map((x) => x.path))) },
    { label: 'Select none', run: () => setSelected(new Set()) },
    { label: 'Invert selection', run: () => setSelected(new Set(entries.filter((x) => !selected.has(x.path)).map((x) => x.path))) },
    'sep',
    { label: 'Copy path', disabled: !selected.size, run: () => copyPath() },
    { label: 'Open in Terminal', disabled: !isFolder, run: () => openTerminal(loc) },
    {
      label: `Open in ${osWords().fileManager}`,
      run: () => void files.open(isFolder ? loc : (places?.places[0]?.path ?? drives[0]?.path ?? '/')),
    },
    'sep',
    { label: 'Properties', disabled: !isFolder && !selected.size, run: () => setPropsFor([...selected][0] ?? loc) },
  ];

  const itemMenu = (e: MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    let paths = [...selected];
    if (!selected.has(entry.path)) {
      paths = [entry.path];
      setSelected(new Set(paths));
      setAnchor(entry.path);
    }
    const single = paths.length === 1;
    const items: MenuItem[] = [
      { label: 'Open', run: () => open(entry) },
      ...(entry.dir
        ? ([
            { label: 'Open in new tab', run: () => openTab(entry.path) },
            { label: 'Open in Terminal', run: () => openTerminal(entry.path) },
            { label: `Open in ${osWords().fileManager}`, run: () => void files.open(entry.path) },
          ] as MenuItem[])
        : ([{ label: `Show in ${osWords().fileManager}`, run: () => void files.open(entry.path, true) }] as MenuItem[])),
      ...(search ? ([{ label: 'Open file location', run: () => go(dirOf(entry.path)) }] as MenuItem[]) : []),
      'sep',
      { label: 'Cut', hint: 'Ctrl+X', icon: <Icon name="cut" size={13} />, run: () => copy('cut', paths) },
      { label: 'Copy', hint: 'Ctrl+C', icon: <Icon name="copy" size={13} />, run: () => copy('copy', paths) },
      ...(entry.dir && single && clip ? ([{ label: 'Paste into folder', run: () => void paste(entry.path) }] as MenuItem[]) : []),
      { label: 'Copy as path', run: () => copyPath(paths) },
      'sep',
      { label: 'Rename', hint: 'F2', disabled: !single, run: () => setRenaming(entry.path) },
      { label: 'Delete', hint: 'Del', icon: <Icon name="delete" size={13} />, run: () => void remove(paths) },
      { label: 'Delete permanently', hint: 'Shift+Del', danger: true, run: () => void remove(paths, true) },
      'sep',
      {
        label: 'Send to chat',
        hint: 'attach',
        run: () => sendToChat(paths),
      },
      'sep',
      { label: 'Properties', run: () => setPropsFor(entry.path) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const backgroundMenu = (e: MouseEvent) => {
    e.preventDefault();
    setSelected(new Set());
    const items: MenuItem[] = [
      ...viewItems().slice(0, 3),
      'sep',
      ...sortItems().slice(0, 4),
      'sep',
      { label: 'Refresh', hint: 'F5', run: () => void refresh() },
      { label: 'Paste', hint: 'Ctrl+V', disabled: !clip || !isFolder, run: () => void paste() },
      'sep',
      ...newItems().map((i) => (i === 'sep' ? i : { ...i, label: `New ${i.label.toLowerCase()}` })),
      'sep',
      { label: 'Open in Terminal', disabled: !isFolder, run: () => openTerminal(loc) },
      { label: `Open in ${osWords().fileManager}`, disabled: !isFolder, run: () => void files.open(loc) },
      { label: 'Properties', disabled: !isFolder, run: () => setPropsFor(loc) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---- Pieces ----

  const nameCell = (entry: FileEntry) =>
    renaming === entry.path ? (
      <input
        autoFocus
        defaultValue={entry.name}
        aria-label="New name"
        onClick={(e) => e.stopPropagation()}
        onFocus={(e) => {
          // Like Explorer: select the name without its extension.
          const dot = entry.dir ? -1 : entry.name.lastIndexOf('.');
          e.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') void rename(entry.path, e.currentTarget.value);
          if (e.key === 'Escape') setRenaming(null);
        }}
        onBlur={(e) => void rename(entry.path, e.target.value)}
        className="min-w-0 flex-1 rounded border border-accent/70 bg-black/40 px-1 text-xs text-ink outline-none"
      />
    ) : (
      <span className="min-w-0 flex-1 truncate" title={entry.name}>
        {entry.name}
      </span>
    );

  const rowProps = (entry: FileEntry) => ({
    id: `row-${id}-${entry.path}`,
    role: 'option',
    'aria-selected': selected.has(entry.path),
    draggable: renaming !== entry.path,
    onClick: (e: MouseEvent) => click(e, entry),
    onDoubleClick: () => open(entry),
    onContextMenu: (e: MouseEvent) => itemMenu(e, entry),
    onDragStart: (e: DragEvent) => dragStart(e, entry),
    ...(entry.dir ? dropProps(entry.path) : {}),
  });

  const rowClass = (entry: FileEntry) =>
    `cursor-default select-none ${selected.has(entry.path) ? 'bg-accent/20 outline outline-1 outline-accent/40' : 'hover:bg-white/5'} ${
      dropTarget === entry.path ? 'bg-accent/30' : ''
    } ${cutPaths.has(entry.path) || entry.hidden ? 'opacity-55' : ''}`;

  const header = (key: SortKey, label: string, className: string) => (
    <button
      type="button"
      onClick={() => {
        setSort({ key, desc: sort.key === key ? !sort.desc : startsDesc(key) });
      }}
      className={`flex cursor-pointer items-center gap-1 px-2 py-1.5 text-left hover:bg-white/5 ${className}`}
    >
      {label}
      {sort.key === key && <span className="text-[9px] text-accent">{sort.desc ? '▼' : '▲'}</span>}
    </button>
  );

  const folderName = locationName(loc, drives);
  const navItem = (label: string, target: string, icon: 'folder' | 'drive', indent = false) => (
    <button
      key={target}
      type="button"
      onClick={() => go(target)}
      {...(target !== HOME && target !== THIS_PC ? dropProps(target) : {})}
      className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-md text-left text-xs hover:bg-white/5 ${indent ? 'pl-6' : 'pl-2'} pr-2 ${
        loc.toLowerCase() === target.toLowerCase() ? 'bg-white/10' : ''
      } ${dropTarget === target ? 'bg-accent/30' : ''}`}
    >
      <FileIcon kind={icon} size={16} />
      <span className="truncate">{label}</span>
    </button>
  );

  const tool =
    'flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg text-sm hover:bg-white/10 disabled:cursor-default disabled:opacity-30';
  const cmd =
    'flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-white/10 disabled:cursor-default disabled:opacity-30';
  const one = selectedEntries.length === 1 ? selectedEntries[0]! : null;

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKey}
      className="relative flex min-h-0 flex-1 flex-col outline-none"
      onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && root.current?.focus()}
    >
      {/* Command bar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5">
        <DropButton
          label="New"
          icon={
            <span className="text-accent">
              <Icon name="plus" />
            </span>
          }
          items={newItems}
          title="New folder or file"
        />
        <span className="mx-1 h-5 border-l border-line" />
        <button type="button" className={cmd} disabled={!selected.size} onClick={() => copy('cut')} title="Cut (Ctrl+X)" aria-label="Cut">
          <Icon name="cut" />
        </button>
        <button
          type="button"
          className={cmd}
          disabled={!selected.size}
          onClick={() => copy('copy')}
          title="Copy (Ctrl+C)"
          aria-label="Copy"
        >
          <Icon name="copy" />
        </button>
        <button
          type="button"
          className={cmd}
          disabled={!clip || !isFolder}
          onClick={() => void paste()}
          title="Paste (Ctrl+V)"
          aria-label="Paste"
        >
          <Icon name="paste" />
        </button>
        <button
          type="button"
          className={cmd}
          disabled={!one}
          onClick={() => one && setRenaming(one.path)}
          title="Rename (F2)"
          aria-label="Rename"
        >
          <Icon name="rename" />
        </button>
        <button
          type="button"
          className={cmd}
          disabled={!selected.size}
          onClick={() => sendToChat()}
          title="Point this chat's next message at them (by path: nothing is copied)"
        >
          <Icon name="share" /> <span>Send to chat</span>
        </button>
        <button
          type="button"
          className={cmd}
          disabled={!selected.size}
          onClick={() => void remove()}
          title={`Delete (to ${osWords().bin})`}
          aria-label="Delete"
        >
          <Icon name="delete" />
        </button>
        <span className="mx-1 h-5 border-l border-line" />
        <DropButton
          label="Sort"
          icon={
            <span className="text-accent">
              <Icon name="sort" />
            </span>
          }
          items={sortItems}
        />
        <DropButton
          label="View"
          icon={
            <span className="text-accent">
              <Icon name="view" />
            </span>
          }
          items={viewItems}
        />
        <DropButton label="" icon={<Icon name="more" />} items={moreItems} title="See more" />
        <div className="flex-1" />
        <button
          type="button"
          className={`${cmd} ${showPane ? 'bg-white/10' : ''}`}
          onClick={() => (setShowPane(!showPane), save('harv.explorer.pane', !showPane))}
          title="Details pane"
        >
          <Icon name="pane" /> Details
        </button>
      </div>

      {/* Address row */}
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button type="button" className={tool} disabled={!back.length} onClick={goBack} aria-label="Back (Alt+Left)">
          <Icon name="back" />
        </button>
        <button type="button" className={tool} disabled={!fwd.length} onClick={goForward} aria-label="Forward (Alt+Right)">
          <Icon name="forward" />
        </button>
        <button type="button" className={tool} disabled={loc === HOME || loc === THIS_PC} onClick={goUp} aria-label="Up (Alt+Up)">
          <Icon name="up" />
        </button>
        <button type="button" className={tool} onClick={() => void refresh()} aria-label="Refresh (F5)">
          <Icon name="refresh" />
        </button>
        <Breadcrumb loc={loc} drives={drives} onGo={(to) => go(to)} onDropOn={(dir, e) => void dropOn(dir, e)} />
        <form
          className="w-[230px] flex-none"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(searchDraft);
          }}
        >
          <label htmlFor={`search-${id}`} className="sr-only">
            Search
          </label>
          <input
            id={`search-${id}`}
            ref={searchBox}
            value={searchDraft}
            disabled={!isFolder}
            onChange={(e) => {
              setSearchDraft(e.target.value);
              if (!e.target.value) setSearch(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchDraft('');
                setSearch(null);
              }
            }}
            placeholder={isFolder ? `Search ${folderName}` : 'Open a folder to search'}
            className="min-h-8 w-full rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60 disabled:opacity-50"
          />
        </form>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Navigation pane */}
        <nav aria-label="Navigation" className="flex w-[190px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-line p-2">
          {navItem('Home', HOME, 'folder')}
          <div className="my-1 border-t border-line" />
          {places?.places.slice(1).map((p) => navItem(p.name, p.path, 'folder'))}
          <div className="my-1 border-t border-line" />
          {navItem(osWords().computer, THIS_PC, 'drive')}
          {drives.map((d) => navItem(driveName(d), d.path, 'drive', true))}
        </nav>

        {/* Items */}
        <div
          data-items
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
          onContextMenu={(e) => isFolder && backgroundMenu(e)}
          onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
          {...(isFolder ? dropProps(loc) : {})}
        >
          {error && <p className="m-0 px-3 py-2 text-xs text-warn">! {error}</p>}
          {search && (
            <p className="m-0 border-b border-line px-3 py-1.5 text-[11px] text-muted">
              {search.loading
                ? `Searching ${folderName} for “${search.query}”…`
                : `${search.results.length} result${search.results.length === 1 ? '' : 's'} for “${search.query}” in ${folderName}${search.complete ? '' : ' (stopped early, narrow it down)'}`}
            </p>
          )}

          {loc === HOME && !search && (
            <div className="flex flex-col gap-4 p-4 text-xs">
              <section>
                <h3 className="m-0 mb-2 text-[11px] tracking-[2px] text-muted">QUICK ACCESS</h3>
                <div className="flex flex-wrap gap-2">
                  {places?.places.slice(1).map((p) => (
                    <button
                      key={p.path}
                      type="button"
                      onDoubleClick={() => go(p.path)}
                      onClick={() => go(p.path)}
                      className="flex w-[150px] cursor-pointer items-center gap-2.5 rounded-xl bg-black/20 p-3 text-left hover:bg-white/10"
                    >
                      <FileIcon kind="folder" size={30} />
                      <span className="flex flex-col">
                        <span>{p.name}</span>
                        <span className="text-[10px] text-faint">Stored locally</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <h3 className="m-0 mb-2 text-[11px] tracking-[2px] text-muted">RECENT</h3>
                {recent.length === 0 ? (
                  <p className="m-0 text-muted">Nothing recent.</p>
                ) : (
                  <ul role="listbox" className="m-0 list-none p-0">
                    {recent.map((r) => (
                      <li
                        key={r.path}
                        role="option"
                        aria-selected={false}
                        onDoubleClick={() => void files.open(r.path)}
                        className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5"
                        title="Double-click to open"
                      >
                        <FileIcon kind={iconKind({ name: r.name.replace(/\.lnk$/i, ''), dir: false })} size={16} />
                        <span className="min-w-0 flex-1 truncate">{r.name.replace(/\.lnk$/i, '')}</span>
                        <span className="w-36 text-right text-faint">{when(r.mtime)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}

          {loc === THIS_PC && !search && (
            <div className="flex flex-col gap-4 p-4 text-xs">
              <section>
                <h3 className="m-0 mb-2 text-[11px] tracking-[2px] text-muted">DEVICES AND DRIVES</h3>
                <div className="flex flex-wrap gap-2">
                  {drives.map((d) => {
                    const used = d.total ? ((d.total - d.free) / d.total) * 100 : 0;
                    return (
                      <button
                        key={d.path}
                        type="button"
                        onDoubleClick={() => go(d.path)}
                        onClick={() => go(d.path)}
                        className="flex w-[250px] cursor-pointer items-center gap-3 rounded-xl bg-black/20 p-3 text-left hover:bg-white/10"
                      >
                        <FileIcon kind="drive" size={34} />
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate">{driveName(d)}</span>
                          {d.total > 0 && (
                            <>
                              <span className="h-1.5 rounded-full bg-white/10">
                                <span
                                  className="block h-1.5 rounded-full"
                                  style={{ width: `${used}%`, background: used >= 90 ? 'var(--color-warn)' : 'var(--color-accent)' }}
                                />
                              </span>
                              <span className="text-[10px] text-faint">
                                {formatSize(d.free)} free of {formatSize(d.total)}
                              </span>
                            </>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          )}

          {(isFolder || search) && view === 'details' && (
            <div
              role="listbox"
              aria-label="Files"
              aria-multiselectable="true"
              className="min-w-[520px] text-xs"
              onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
            >
              <div className="sticky top-0 z-10 flex border-b border-line bg-[rgb(16_24_34/0.92)] text-[11px] text-muted backdrop-blur">
                {header('name', 'Name', 'flex-1 min-w-[160px]')}
                {search && <span className="w-56 px-2 py-1.5">Folder</span>}
                {header('mtime', 'Date modified', 'w-36')}
                {header('type', 'Type', 'w-32')}
                {header('size', 'Size', 'w-20 justify-end')}
              </div>
              {entries.map((entry, i) => (
                <div key={entry.path} role="presentation" className="contents">
                  {groups && groups[i] !== groups[i - 1] && (
                    <div role="presentation" className="flex items-center gap-2 px-2 pt-3 pb-1 text-[11px] text-accent">
                      <span>{groups[i]}</span>
                      <span className="text-faint">({groupSizes.get(groups[i]!)})</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  <div {...rowProps(entry)} className={`flex items-center ${rowClass(entry)}`}>
                    <span className="flex min-w-[160px] flex-1 items-center gap-2 px-2 py-1">
                      <FileIcon kind={iconKind(entry)} size={16} />
                      {nameCell(entry)}
                    </span>
                    {search && (
                      <span className="w-56 truncate px-2 text-faint" title={dirOf(entry.path)}>
                        {dirOf(entry.path)}
                      </span>
                    )}
                    <span className="w-36 truncate px-2 text-[11px] text-faint">{when(entry.mtime)}</span>
                    <span className="w-32 truncate px-2 text-faint" title={typeName(entry)}>
                      {typeName(entry)}
                    </span>
                    <span className="w-20 px-2 text-right text-faint tabular-nums">
                      {entry.size !== undefined ? formatSize(entry.size) : ''}
                    </span>
                  </div>
                </div>
              ))}
              {isFolder && !search && listing && entries.length === 0 && (
                <p className="m-0 px-3 py-6 text-center text-muted">This folder is empty.</p>
              )}
            </div>
          )}

          {(isFolder || search) && view === 'icons' && (
            <div
              role="listbox"
              aria-label="Files"
              aria-multiselectable="true"
              className="flex flex-wrap content-start gap-1 p-2 text-xs"
              onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
            >
              {entries.map((entry) => (
                <div
                  key={entry.path}
                  {...rowProps(entry)}
                  className={`flex w-[112px] flex-col items-center gap-1 rounded-lg p-2 ${rowClass(entry)}`}
                >
                  {isImage(entry.name) && (entry.size ?? 0) < 15 * 1024 * 1024 ? (
                    <img src={files.raw(entry.path)} alt="" loading="lazy" draggable={false} className="h-16 w-20 rounded object-cover" />
                  ) : (
                    <FileIcon kind={iconKind(entry)} size={56} />
                  )}
                  <span className="line-clamp-2 w-full text-center break-words" title={entry.name}>
                    {renaming === entry.path ? nameCell(entry) : entry.name}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(isFolder || search) && view === 'list' && (
            <div
              role="listbox"
              aria-label="Files"
              aria-multiselectable="true"
              className="grid auto-cols-[240px] grid-flow-col grid-rows-[repeat(auto-fill,28px)] content-start gap-x-2 overflow-x-auto p-2 text-xs"
              style={{ height: '100%' }}
            >
              {entries.map((entry) => (
                <div key={entry.path} {...rowProps(entry)} className={`flex h-7 items-center gap-2 rounded-md px-2 ${rowClass(entry)}`}>
                  <FileIcon kind={iconKind(entry)} size={16} />
                  {nameCell(entry)}
                </div>
              ))}
            </div>
          )}
        </div>

        {showPane && (isFolder || search) && <DetailsPane selected={selectedEntries} folderName={folderName} count={entries.length} />}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 border-t border-line px-3 py-1 text-[11px] text-muted">
        <span>{isFolder || search ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : folderName}</span>
        {selected.size > 0 && (
          <span>
            {selected.size} item{selected.size === 1 ? '' : 's'} selected
            {selectedEntries.some((x) => x.size !== undefined)
              ? ` · ${formatSize(selectedEntries.reduce((s, x) => s + (x.size ?? 0), 0))}`
              : ''}
          </span>
        )}
        {toast && <span className="animate-fade-in min-w-0 flex-1 truncate text-ink">{toast}</span>}
        <div className="ml-auto flex gap-0.5">
          <button
            type="button"
            aria-label="Details view"
            onClick={() => (setView('details'), save('harv.explorer.view', 'details'))}
            className={`flex size-6 cursor-pointer items-center justify-center rounded ${view === 'details' ? 'bg-white/10 text-ink' : 'hover:bg-white/5'}`}
          >
            <Icon name="details" size={13} />
          </button>
          <button
            type="button"
            aria-label="Large icons view"
            onClick={() => (setView('icons'), save('harv.explorer.view', 'icons'))}
            className={`flex size-6 cursor-pointer items-center justify-center rounded ${view === 'icons' ? 'bg-white/10 text-ink' : 'hover:bg-white/5'}`}
          >
            <Icon name="icons" size={13} />
          </button>
        </div>
      </div>

      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {propsFor && <PropertiesDialog path={propsFor} onClose={() => setPropsFor(null)} />}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete permanently"
          message={`Permanently delete ${confirmDelete.length === 1 ? `“${baseName(confirmDelete[0]!)}”` : `these ${confirmDelete.length} items`}? They won't go to ${osWords().bin} and can't be brought back.`}
          confirm="Delete"
          onYes={() =>
            void run({ op: 'deleteForever', paths: confirmDelete }, false).then((r) => {
              if (r?.paths.length) say(`${r.paths.length} item${r.paths.length > 1 ? 's' : ''} deleted.`);
              setSelected(new Set());
            })
          }
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
