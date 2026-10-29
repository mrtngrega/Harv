import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type RefObject } from 'react';
import { FRESH_HINT_TOKENS, type PathSuggestion } from '@harv/shared';
import { formatSize, uploadAttachment } from '../lib/attachments.ts';
import { lineTime, resetTime, tokens } from '../lib/format.ts';
import { HELP, parseCommand } from '../lib/commands.ts';
import { useCatalog, useSettings, useUsage } from '../lib/useHarvSocket.ts';
import { chat, getChatState, SETTINGS_TAB, startQuestions, useChat, type Line } from '../lib/chatStore.ts';
import { useSafety } from '../lib/safetyStore.ts';
import { ActionBadge, ApprovalCard } from './ApprovalCard.tsx';
import { FileCards } from './chat/FileCards.tsx';
import { PreviewPane } from './chat/PreviewPane.tsx';
import { RichText } from './chat/RichText.tsx';
import { usePreviews } from '../lib/preview.ts';
import { SettingsView } from './SettingsView.tsx';
import { BrowserView } from './tools/BrowserView.tsx';
import { StartChoice } from './StartChoice.tsx';
import { StatusLine } from './StatusLine.tsx';
import { TaskStrip } from './TaskStrip.tsx';
import { matchCommands, SlashMenu } from './SlashMenu.tsx';
import { atToken, insideFolder, PathMenu, usePathSuggestions, withoutToken } from './PathMenu.tsx';
import { shownView, SpecialTab, TOOL_ICONS, ViewMenu } from './tools/TabParts.tsx';
import { addReference, lastPart, setDraftText, updatePending, useDrafts, useDraftTexts } from '../lib/drafts.ts';
import { desktop, inApp } from '../lib/desktop.ts';
import { ErrorBoundary, retryImport } from './ErrorBoundary.tsx';
import { isPhone } from '../lib/phone.ts';
import { MicButton, VoiceBar } from './phone/VoiceBar.tsx';

// The terminal (xterm) and the explorer load when first opened, keeping the dashboard's first load small.
const TerminalView = lazy(() => retryImport(() => import('./tools/TerminalView.tsx')).then((m) => ({ default: m.TerminalView })));
const Explorer = lazy(() => retryImport(() => import('./tools/explorer/Explorer.tsx')).then((m) => ({ default: m.Explorer })));

/** An attached file: an upload (▤), or a file or folder on the PC pointed at by its path (@, nothing copied). */
function FileChip({
  name,
  path,
  folder,
  detail,
  onRemove,
}: {
  name: string;
  path?: string;
  folder?: boolean;
  detail?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      title={path ? `${path} (by path: Harv works on it where it is)` : undefined}
      className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-[rgb(220_232_245/0.2)] bg-white/5 py-0.5 pr-1 pl-2 text-[11px]"
    >
      <span aria-hidden="true" className="text-accent">
        {path ? '@' : '▤'}
      </span>
      <span className="truncate text-ink">
        {name}
        {folder ? '/' : ''}
      </span>
      {detail && <span className="flex-none text-faint">{detail}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="size-6 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
        >
          ×
        </button>
      )}
    </span>
  );
}

function Thinking() {
  return (
    <span aria-label="Harv is thinking" className="inline-flex gap-1 text-accent">
      <span className="animate-blink">●</span>
      <span className="animate-blink [animation-delay:.2s]">●</span>
      <span className="animate-blink [animation-delay:.4s]">●</span>
    </span>
  );
}

function Time({ at }: { at: number }) {
  if (!useSettings().showTimes) return null;
  return (
    <time dateTime={new Date(at).toISOString()} className="mr-2 text-faint tabular-nums">
      {lineTime(at)}
    </time>
  );
}

/** Rewind (Claude Code's /rewind): asks once more, since the later messages go. */
function RewindButton({ line }: { line: Line }) {
  const [sure, setSure] = useState(false);
  const btn = 'cursor-pointer rounded px-1.5 text-[11px] hover:bg-white/10';
  if (!sure)
    return (
      <button
        type="button"
        onClick={() => setSure(true)}
        title="Rewind: put the files Harv changed and the conversation back to before this message (the later messages go)"
        className={`${btn} text-muted opacity-0 group-hover:opacity-100 hover:text-accent focus:opacity-100`}
      >
        ⟲ rewind
      </button>
    );
  return (
    <span className="text-[11px] text-warn">
      rewind to here? this and everything after it goes ·{' '}
      <button type="button" onClick={() => chat.rewind(line.id)} className={`${btn} text-warn`}>
        yes
      </button>
      <button type="button" onClick={() => setSure(false)} className={`${btn} text-muted`}>
        no
      </button>
    </span>
  );
}

/** Messages Harv's own commands handled: never sent to Claude, so there's nothing to rewind to. */
const LOCAL_COMMAND = /^\/(report|btw)\b/i;

function ChatLineView({ line, onHarder }: { line: Line; onHarder?: () => void }) {
  const { showTimes, showTags } = useSettings();
  switch (line.kind) {
    case 'you':
      return (
        <div className="group animate-fade-in rounded-md border-l-2 border-accent bg-accent/10 px-2.5 py-1.5 whitespace-pre-wrap text-white">
          <div className="float-right ml-2">{!LOCAL_COMMAND.test(line.text) && <RewindButton line={line} />}</div>
          <Time at={line.at} />
          <span className="text-accent">you ›</span> {line.text}
          {line.files && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {/* Files and folders on the PC are stored by their full path, uploads by their name. */}
              {line.files.map((name, i) =>
                /^[a-z]:[\\/]|^\//i.test(name) ? <FileChip key={i} name={lastPart(name)} path={name} /> : <FileChip key={i} name={name} />,
              )}
            </div>
          )}
        </div>
      );
    case 'harv':
      return (
        <div className="animate-fade-in">
          <div className="flex items-baseline gap-2">
            <Time at={line.at} />
            <span className={`text-ok ${showTimes ? '-ml-2' : ''}`}>harv ›</span>
            {line.tag && showTags && (
              <span title={line.reason} className="cursor-help text-[11px] text-faint">
                {/* ↑: AUTO stepped up mid-reply because it was struggling (the reason says from what and why). */}[
                {line.reason?.startsWith('↑') && <span className="text-accent">↑ </span>}
                {line.tag}]
              </span>
            )}
            {line.streaming && line.text === '' && <Thinking />}
            {onHarder && (
              <button
                type="button"
                onClick={onHarder}
                title="Run that again one step up (a stronger model or more effort)"
                className="cursor-pointer rounded px-1.5 text-[11px] text-muted hover:bg-white/10 hover:text-accent"
              >
                ↑ try harder
              </button>
            )}
          </div>
          {line.text && (
            <div className="harv-md mt-1">
              <RichText text={line.text} streaming={line.streaming} />
            </div>
          )}
          {line.text && !line.streaming && <FileCards text={line.text} />}
        </div>
      );
    case 'tool':
      return <ToolLine line={line} />;
    case 'thinking':
      return <ThoughtLine line={line} />;
    case 'notice':
      return (
        <div className="animate-fade-in text-muted">
          <Time at={line.at} />— {line.text}
        </div>
      );
    case 'error':
      return (
        <div className="animate-fade-in text-warn">
          <Time at={line.at} />! {line.text}
        </div>
      );
  }
}

/**
 * A line re-renders only when it changes (lines are replaced, never edited in place), or
 * when "try harder" comes or goes. Typing re-renders the panel on every key, and parsing
 * every reply's Markdown again made typing lag in long chats.
 */
const ChatLine = memo(ChatLineView, (a, b) => a.line === b.line && !a.onHarder === !b.onHarder);

/** What Claude thought before answering, folded like Claude Code's: "✻ thought for 12s", open to read. */
function ThoughtLine({ line }: { line: Line }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="animate-fade-in text-faint">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? 'Hide the thinking' : 'Show what Harv thought'}
        className="cursor-pointer rounded hover:text-muted"
      >
        <Time at={line.at} />
        <span className="text-accent/70">✻</span> thought for {line.tag ?? 'a moment'} {open ? '▾' : '▸'}
      </button>
      {open && <div className="mt-1 border-l border-line pl-3 whitespace-pre-wrap text-muted italic">{line.text}</div>}
    </div>
  );
}

/** A tool call; non-green ones show their tier, status and Undo from the action log. */
function ToolLine({ line }: { line: Line }) {
  const { actions } = useSafety();
  const action = line.ref ? actions[line.ref] : undefined;
  return (
    <div className="animate-fade-in flex items-center gap-3 text-faint">
      <span className="min-w-0 truncate">
        <Time at={line.at} />
        &nbsp;&nbsp;▸ {line.text}
      </span>
      {action && action.tier !== 'green' && <ActionBadge action={action} />}
    </div>
  );
}

/** Where a tab dropped at `x` lands: before the first tab whose middle is right of it, else after the last. */
function dropSlot(bar: HTMLElement, x: number): { id: string; after: boolean } | null {
  const tabs = [...bar.querySelectorAll<HTMLElement>('[data-tab]')];
  const before = tabs.find((t) => {
    const r = t.getBoundingClientRect();
    return x < r.left + r.width / 2;
  });
  if (before) return { id: before.dataset.tab!, after: false };
  const last = tabs.at(-1);
  return last ? { id: last.dataset.tab!, after: true } : null;
}

/** Tailwind's `sm` and up: room for the long placeholder on one line. */
/** An element's width, kept up to date (0 until it's shown). `again` re-attaches when the element is swapped. */
function useWidth(ref: RefObject<HTMLElement | null>, again: unknown): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, again]);
  return width;
}

export function ChatPanel() {
  const { tabs: allTabs, activeId, settingsOpen, views, hydrated } = useChat();
  // Nothing until the saved chats are here: the starter tab only flashed "New chat" before them.
  const tabs = hydrated ? allTabs : [];
  const inSettings = activeId === SETTINGS_TAB;
  const { approvals } = useSafety();
  const usage = useUsage();
  const { density, sendKey } = useSettings();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingByTab = useDrafts();
  const draftTexts = useDraftTexts();
  const [dragging, setDragging] = useState(false);
  /** The tab whose name is being edited (right-click or F2 on it). */
  const [renaming, setRenaming] = useState<string | null>(null);
  // Tab being dragged, and where it would land (before or after `id`).
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const renameCancelled = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  /** The active chat's log, or one of its tools (the view menu). */
  const view = active ? shownView(views[active.id]) : 'chat';
  /** Settings or a tool is showing: no chat input or attachments. */
  const nonChat = inSettings || view !== 'chat';
  // The long hints only where they fit on one line: the box's own width, not the window's (side panels take room).
  const inputWidth = useWidth(inputRef, nonChat);
  // Each chat keeps its own unsent text.
  const draft = (active && draftTexts[active.id]) || '';
  const setDraft = (text: string) => setDraftText(active?.id ?? chat.ensureTab(), text);
  const pending = (activeId && pendingByTab[activeId]) || [];
  const uploading = pending.some((p) => !p.file && !p.error);
  const waiting = approvals.filter((a) => a.tabId === activeId);
  const previews = usePreviews();
  const preview = active && view === 'chat' ? previews[active.id] : undefined;
  // "Try harder" sits on the newest reply, once the tab is idle.
  const lastReplyId = active?.lines.findLast((l) => l.kind === 'harv' && l.tag)?.id;
  // Chats from before Harv started ask "continue or new session?" in their own tab (not while a turn runs in them).
  const asking = startQuestions.use();
  const askHere = !inSettings && view === 'chat' && active && !active.busy && asking.includes(active.id);
  // Typing "/" opens the command list (the dashboard's and Claude Code's); Esc closes it until the text changes.
  const catalog = useCatalog();
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosedAt, setMenuClosedAt] = useState<string | null>(null);
  const menuItems = nonChat || menuClosedAt === draft ? [] : matchCommands(draft, active?.commands ?? catalog?.commands ?? []);
  const menuAt = Math.min(menuIndex, Math.max(menuItems.length - 1, 0));
  // Typing "@" suggests files and folders on the PC (like Claude Code's): picking one attaches it by path.
  const [pathIndex, setPathIndex] = useState(0);
  const [pathClosedAt, setPathClosedAt] = useState<string | null>(null);
  const token = nonChat || menuItems.length > 0 || pathClosedAt === draft ? null : atToken(draft);
  const pathItems = usePathSuggestions(token ? token.query : null);
  const pathAt = Math.min(pathIndex, Math.max(pathItems.length - 1, 0));
  /** Enter (or a click) attaches it; Tab on a folder walks into it instead. */
  const pickPath = (s: PathSuggestion, walk = false) => {
    if (!token) return;
    setPathIndex(0);
    if (walk && s.folder) return setDraft(`${draft.slice(0, token.start)}@${insideFolder(s.path)}`);
    addReference(active?.id ?? chat.ensureTab(), s);
    setDraft(withoutToken(draft, token.start));
    inputRef.current?.focus();
  };
  // ATTACH in the app: the system's own picker for files or folders (by path), or an uploaded copy.
  const [attachMenu, setAttachMenu] = useState(false);
  const pickFromPc = async (folders: boolean) => {
    setAttachMenu(false);
    const picked = await desktop.pickPaths(folders).catch(() => []);
    const tabId = chat.ensureTab();
    for (const p of picked) addReference(tabId, p);
    inputRef.current?.focus();
  };
  const openAttach = () => (inApp ? setAttachMenu((open) => !open) : fileInputRef.current?.click());
  const pickCommand = (name: string) => {
    setDraft(`/${name} `);
    setMenuIndex(0);
    inputRef.current?.focus();
  };

  // Esc is the stop hotkey: it halts the active tab and denies its waiting approvals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !active?.busy || view !== 'chat') return;
      // Esc that closes a menu, a dialog or a rename belongs to them.
      if (document.querySelector('[role="menu"], [role="dialog"]') || (e.target as HTMLElement).closest?.('[role="tablist"] input')) return;
      e.preventDefault();
      chat.stop(active.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active?.busy, active?.id, view]);

  const attach = (files: Iterable<File>) => {
    const tabId = chat.ensureTab();
    for (const file of files) {
      const key = crypto.randomUUID();
      updatePending(tabId, (list) => [...list, { key, name: file.name || 'pasted-image.png', size: file.size }]);
      uploadAttachment(tabId, file).then(
        (uploaded) => updatePending(tabId, (list) => list.map((p) => (p.key === key ? { ...p, file: uploaded } : p))),
        (err: Error) => updatePending(tabId, (list) => list.map((p) => (p.key === key ? { ...p, error: err.message } : p))),
      );
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // A dropped folder has no path the page can see (browsers and the app's web view hide it), so it can't come this way.
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const folders = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory);
    const dropped = items.filter((i) => !folders.includes(i)).flatMap((i) => i.getAsFile() ?? []);
    if (folders.length)
      chat.localNotice(
        inApp
          ? 'Folders can’t be dropped (only copies of files can). Use + ATTACH › Folder…, type @ and the path, or Send to chat in the file explorer.'
          : 'Folders can’t be dropped. Type @ and the path, or use Send to chat in the file explorer.',
      );
    if (dropped.length) attach(dropped);
  };

  // The active tab scrolls into view in the tab bar (by hand: scrollIntoView would also scroll the page),
  // also when the bar gets narrower (a smaller window, a side panel opening), or it slid out of sight.
  useEffect(() => {
    const bar = tabsRef.current;
    if (!bar) return;
    const show = () => {
      const tab = bar.querySelector<HTMLElement>(`[data-tab="${activeId}"]`);
      if (!tab) return;
      const left = tab.offsetLeft - bar.offsetLeft;
      if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
      else if (left + tab.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left + tab.offsetWidth - bar.clientWidth + 8;
    };
    show();
    const watch = new ResizeObserver(show);
    watch.observe(bar);
    return () => watch.disconnect();
  }, [activeId, tabs.length, settingsOpen]);

  // Opening or switching to a chat puts the cursor in its command line, ready to type (the user's wish).
  // Not while a tab is being renamed, or when the start question covers the chat.
  useEffect(() => {
    if (nonChat || renaming || askHere) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [activeId, nonChat, renaming, askHere]);

  // The desktop app's hotkey brings Harv up with the cursor in the command line.
  useEffect(() => {
    const onFocus = () => !nonChat && inputRef.current?.focus({ preventScroll: true });
    window.addEventListener('harv-focus', onFocus);
    return () => window.removeEventListener('harv-focus', onFocus);
  }, [nonChat]);

  // Keep the newest output in view while Harv streams, unless the user scrolled up to read (the user's wish):
  // then it stays put until they scroll back down, press ↓ or send something.
  const lastLine = active?.lines.at(-1);
  const lastText = lastLine?.text;
  const stuck = useRef(true);
  /** The chat whose log is scrolled up (it shows the ↓ button); its scroll event keeps this right. */
  const [scrolledUp, setScrolledUp] = useState<string | null>(null);
  const toBottom = () => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
  };
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setScrolledUp(stuck.current ? null : activeId);
  };
  useLayoutEffect(toBottom, [activeId]);
  useEffect(() => {
    if (lastLine?.kind === 'you') stuck.current = true;
    if (stuck.current) toBottom();
  }, [active?.lines.length, lastText, waiting.length, lastLine?.kind]);

  // The message box grows with what's typed (up to its max height).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
  }, [draft, nonChat]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    const ready = pending.flatMap((p) => (p.file ? [p.file] : []));
    const command = ready.length === 0 ? parseCommand(text) : null;
    if (command) {
      setDraft('');
      if (command.kind === 'attach') openAttach();
      else if (command.kind === 'new') chat.newTab();
      else if (command.kind === 'help') chat.localNotice(HELP);
      else if (command.kind === 'plan') chat.setPlanning(chat.ensureTab(), command.on ?? !active?.planning);
      else if (command.kind === 'rewind') chat.rewindLast(chat.ensureTab());
      else if (command.kind === 'error') chat.localNotice(command.message, 'error');
      else {
        if (command.model) chat.setModel(command.model);
        if (command.effort) chat.setEffort(command.effort);
        const { model, effort } = getChatState();
        chat.localNotice(model === 'auto' ? 'Model: AUTO (Harv picks model and effort).' : `Model: ${model} · ${effort}.`);
      }
      return;
    }
    // While Harv answers, a message waits its turn (queued on the server, shown above the input).
    if ((!text && ready.length === 0) || uploading) return;
    chat.send(text, ready);
    setDraft('');
    if (activeId) updatePending(activeId, () => []);
  };

  return (
    <section
      aria-label="Chat"
      onDragOver={(e) => {
        // The explorer takes its own drops (copying files into the folder).
        if (nonChat || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => !nonChat && onDrop(e)}
      className={`glass relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl ${
        // The phone's layout gives the chat all the height that's left (docs/PLAN.md §6q).
        isPhone ? 'min-h-0' : 'h-[calc(var(--app-h)-140px)] min-h-[420px] lg:h-auto lg:max-h-[calc(var(--app-h)-110px)] lg:min-h-0'
      }`}
    >
      {/* The whole bar takes a dragged tab: gaps, the space past the last tab and the + too (the nearest slot wins). */}
      <div
        onDragOver={(e) => {
          if (!dragTab || !e.dataTransfer.types.includes('application/x-harv-tab')) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const bar = tabsRef.current;
          if (!bar) return;
          // Near either end of an overflowing bar, scroll it along.
          const box = bar.getBoundingClientRect();
          if (e.clientX < box.left + 24) bar.scrollLeft -= 12;
          else if (e.clientX > box.right - 24) bar.scrollLeft += 12;
          const next = dropSlot(bar, e.clientX);
          if (next && (dropAt?.id !== next.id || dropAt.after !== next.after)) setDropAt(next);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData('application/x-harv-tab');
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          const slot = tabsRef.current ? dropSlot(tabsRef.current, e.clientX) : null;
          if (slot) chat.moveTab(id, slot.id, slot.after);
          setDragTab(null);
          setDropAt(null);
        }}
        className="flex items-end gap-1 border-b border-line px-2 pt-2"
      >
        {/* Tabs shrink like Chrome's, then scroll sideways (mouse wheel too); + and the view menu stay put. */}
        <div
          ref={tabsRef}
          role="tablist"
          aria-label="Open chats"
          onWheel={(e) => {
            if (e.deltaY && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) e.currentTarget.scrollLeft += e.deltaY;
          }}
          className="no-scrollbar flex min-w-0 flex-[0_1_auto] items-end gap-1 overflow-x-auto"
        >
          {tabs.map((t) => {
            const on = t.id === activeId;
            return (
              <div
                key={t.id}
                data-tab={t.id}
                draggable={renaming !== t.id}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-harv-tab', t.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDragTab(t.id);
                }}
                onDragEnd={() => {
                  setDragTab(null);
                  setDropAt(null);
                }}
                className={`animate-fade-in flex max-w-[200px] min-w-[84px] flex-[0_1_200px] items-center gap-0.5 rounded-t-[10px] border border-b-0 ${
                  on ? 'border-[rgb(220_232_245/0.18)] bg-white/10' : 'border-transparent'
                } ${dragTab === t.id ? 'opacity-40' : ''} ${
                  dragTab && dragTab !== t.id && dropAt?.id === t.id
                    ? dropAt.after
                      ? 'shadow-[2px_0_0_0_var(--color-accent)]'
                      : 'shadow-[-2px_0_0_0_var(--color-accent)]'
                    : ''
                }`}
              >
                {renaming === t.id ? (
                  <input
                    aria-label="Chat name"
                    autoFocus
                    defaultValue={t.title}
                    maxLength={60}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        renameCancelled.current = true;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      // Enter and clicking away save; Escape doesn't.
                      const name = e.target.value.trim();
                      if (!renameCancelled.current && name && name !== t.title) chat.rename(t.id, name);
                      renameCancelled.current = false;
                      setRenaming(null);
                    }}
                    className="my-1 ml-1.5 min-h-7 w-[150px] rounded-md border border-accent/60 bg-black/30 px-1.5 text-xs text-ink outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    title={`${t.title} · right-click to rename`}
                    onClick={() => chat.setActive(t.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setRenaming(t.id);
                    }}
                    onKeyDown={(e) => {
                      // F2 renames too, for the keyboard.
                      if (e.key === 'F2') setRenaming(t.id);
                    }}
                    className={`flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 truncate pr-1 pl-3 text-xs ${on ? 'text-ink' : 'text-muted'}`}
                  >
                    {approvals.some((a) => a.tabId === t.id) ? (
                      <span title="Needs your approval" className="flex-none font-semibold text-warn">
                        !
                      </span>
                    ) : (
                      t.busy && <span aria-hidden="true" className="animate-blink size-1.5 flex-none rounded-full bg-accent" />
                    )}
                    {!t.busy && asking.includes(t.id) && (
                      <span aria-hidden="true" title="Asks: continue or new session" className="flex-none text-accent">
                        ?
                      </span>
                    )}
                    {t.projectId && (
                      <span aria-hidden="true" title="Project chat" className="flex-none text-accent">
                        ▣
                      </span>
                    )}
                    {shownView(views[t.id]) !== 'chat' && (
                      <span aria-hidden="true" className="flex-none text-accent">
                        {TOOL_ICONS[shownView(views[t.id])]}
                      </span>
                    )}
                    <span className="truncate">{t.title}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => chat.closeTab(t.id)}
                  aria-label={`Close ${t.title}`}
                  className="mr-1 size-7 flex-none cursor-pointer rounded-md text-[13px] text-muted hover:bg-white/10"
                >
                  ×
                </button>
              </div>
            );
          })}
          {settingsOpen && (
            <SpecialTab
              id={SETTINGS_TAB}
              icon={TOOL_ICONS.settings}
              title="Settings"
              active={inSettings}
              onSelect={chat.openSettings}
              onClose={chat.closeSettings}
            />
          )}
        </div>
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={() => chat.newTab()}
          className="size-9 flex-none cursor-pointer text-base hover:text-accent"
        >
          +
        </button>
        <div className="flex-1" />
        {view === 'chat' && active?.context && (
          <div
            className="mb-1.5 hidden min-h-7 items-center px-2 text-[11px] whitespace-nowrap text-muted xl:flex"
            title="The conversation's size: what Harv sent with its latest message, plus what it wrote"
          >
            context · {tokens(active.context)} tokens
            {active.context >= FRESH_HINT_TOKENS && (
              <button
                type="button"
                onClick={() => {
                  setDraft('/fresh');
                  inputRef.current?.focus();
                }}
                title="This chat is big, so every reply costs more. /fresh saves memory and a summary, then goes on in a new session."
                className="ml-1.5 cursor-pointer rounded px-1 text-warn hover:bg-warn/15"
              >
                · /fresh?
              </button>
            )}
          </div>
        )}
        {active && <ViewMenu tabId={active.id} />}
      </div>

      {/* Everything under the tab bar, so a chat's start question covers only this part. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* A chat showing its files or terminal still shows what it waits for (hidden, the turn just hung). */}
        {!inSettings && view !== 'chat' && waiting.length > 0 && (
          <div className="flex max-h-[60%] flex-none flex-col gap-2 overflow-y-auto border-b border-line p-3">
            {waiting.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )}
        {inSettings ? (
          <div className="@container flex flex-1 flex-col overflow-y-auto px-5 py-4">
            <SettingsView />
          </div>
        ) : active && view === 'browser' ? (
          <BrowserView />
        ) : active && view === 'terminal' ? (
          <ErrorBoundary key={`t-${active.id}`} label="terminal">
            <Suspense fallback={<p className="m-auto text-muted">Starting the terminal…</p>}>
              <TerminalView key={active.id} chatId={active.id} />
            </Suspense>
          </ErrorBoundary>
        ) : active && view === 'files' ? (
          <ErrorBoundary key={`e-${active.id}`} label="file explorer">
            <Suspense fallback={<p className="m-auto text-muted">Opening the explorer…</p>}>
              <Explorer key={active.id} id={active.id} />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <div className={`relative flex min-h-0 flex-1 ${preview ? 'flex-col gap-2 pb-2 lg:flex-row lg:pr-2' : ''}`}>
            {scrolledUp !== null && scrolledUp === activeId && (
              <button
                type="button"
                onClick={toBottom}
                title="Back to the newest output"
                className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-accent/50 bg-[rgb(16_24_34/0.9)] px-3 py-1 text-[11px] text-accent hover:bg-accent/15"
              >
                ↓ {active?.busy ? 'live' : 'newest'}
              </button>
            )}
            <div
              ref={logRef}
              onScroll={onLogScroll}
              className={`flex min-w-0 flex-1 flex-col overflow-y-auto px-5 ${preview ? 'max-lg:max-h-[45%] lg:max-w-[50%]' : ''} ${density === 'compact' ? 'gap-1.5 py-3 leading-normal' : 'gap-3.5 py-4 leading-relaxed'}`}
            >
              {!hydrated ? null : !active || active.lines.length === 0 ? (
                <p className="m-auto text-center text-muted">
                  {active ? 'New chat. Ask Harv anything.' : 'No chat open. Press + to start one.'}
                </p>
              ) : (
                active.lines.map((l) => (
                  <ChatLine
                    key={l.id}
                    line={l}
                    onHarder={!active.busy && l.id === lastReplyId ? () => chat.harder(active.id) : undefined}
                  />
                ))
              )}
              {waiting.map((a) => (
                <ApprovalCard key={a.id} approval={a} />
              ))}
            </div>
            {active && preview && <PreviewPane tabId={active.id} preview={preview} />}
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-[rgb(10_16_24/0.7)] text-accent">
            drop files to attach
          </div>
        )}

        {!nonChat && active?.queued && active.queued.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-line px-5 pt-2 text-xs">
            {active.queued.map((q) => (
              <div key={q.id} className="flex min-w-0 items-center gap-2">
                <span className="flex-none text-faint">queued ›</span>
                <button
                  type="button"
                  onClick={() => {
                    chat.editQueued(active.id, q.id);
                    inputRef.current?.focus();
                  }}
                  title="Edit: takes it back into the input (↑ in an empty input does too)"
                  className="min-w-0 flex-1 cursor-pointer truncate rounded text-left text-muted hover:text-ink"
                >
                  {q.text || q.files?.join(', ')}
                </button>
                <button
                  type="button"
                  onClick={() => chat.sendNow(active.id, q.id)}
                  title="Stop the current reply and send this now"
                  className="flex-none cursor-pointer rounded border border-accent/50 px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/15"
                >
                  send now
                </button>
                <button
                  type="button"
                  onClick={() => chat.unqueue(active.id, q.id)}
                  aria-label="Remove queued message"
                  title="Remove"
                  className="size-6 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
                >
                  ×
                </button>
              </div>
            ))}
            <p className="text-[11px] text-faint">
              Runs when Harv finishes · click one (or ↑) to edit it · “send now” stops this reply and sends it right away
            </p>
          </div>
        )}

        {!nonChat && pending.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-line px-5 pt-2.5">
            {pending.map((p) => (
              <FileChip
                key={p.key}
                name={p.name}
                path={p.file?.path}
                folder={p.file?.folder}
                detail={
                  p.error
                    ? `! ${p.error}`
                    : p.file?.path
                      ? p.file.folder
                        ? undefined
                        : p.size
                          ? formatSize(p.size)
                          : undefined
                      : p.file
                        ? formatSize(p.size)
                        : 'uploading…'
                }
                onRemove={() => activeId && updatePending(activeId, (list) => list.filter((x) => x.key !== p.key))}
              />
            ))}
          </div>
        )}

        {!nonChat && usage?.pausedUntil && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 pt-2 text-xs text-warn">
            <span>
              Claude Pro limit reached: messages queue until {resetTime(usage.pausedUntil)}
              {usage.queued > 0 && ` (${usage.queued} waiting)`}.
            </span>
            {active && usage.queued > 0 && (
              <button
                type="button"
                onClick={() => chat.stop(active.id)}
                className="cursor-pointer rounded px-1.5 text-muted hover:bg-white/10 hover:text-ink"
              >
                cancel this tab’s queue
              </button>
            )}
          </div>
        )}

        {!nonChat && <TaskStrip tab={active ?? undefined} />}
        {!nonChat && <StatusLine tab={active ?? undefined} />}
        {!nonChat && active?.planning && (
          <div className="flex items-center gap-2 px-5 pt-1 text-[11px] text-accent">
            <span>◇ plan mode</span>
            <span className="text-faint">Harv only reads and plans, then shows you the plan to approve</span>
            <button
              type="button"
              onClick={() => chat.setPlanning(active.id, false)}
              className="cursor-pointer rounded px-1.5 text-muted hover:bg-white/10 hover:text-accent"
            >
              turn off
            </button>
          </div>
        )}

        {!nonChat && isPhone && <VoiceBar />}
        {!nonChat && (
          <form
            onSubmit={send}
            // The phone's line is narrow: small gaps and buttons, so the text gets the room (docs/PLAN.md §6q).
            className={`relative flex items-end ${isPhone ? 'gap-1.5 pt-1 pr-2 pb-2 pl-3' : 'gap-2.5 pt-1 pr-3 pb-2.5 pl-5'}`}
          >
            {menuItems.length > 0 && <SlashMenu items={menuItems} index={menuAt} onPick={(c) => pickCommand(c.name)} />}
            {pathItems.length > 0 && <PathMenu items={pathItems} index={pathAt} onPick={(p) => pickPath(p)} />}
            <label htmlFor="harv-cmd" className="pb-3 leading-5 font-semibold text-accent">
              {isPhone ? '›' : 'harv>'}
            </label>
            <textarea
              ref={inputRef}
              id="harv-cmd"
              rows={1}
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (menuItems.length > 0 && !e.nativeEvent.isComposing) {
                  const typed = draft.slice(1).toLowerCase();
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMenuIndex((menuAt + (e.key === 'ArrowDown' ? 1 : menuItems.length - 1)) % menuItems.length);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuClosedAt(draft);
                    return;
                  }
                  // Tab, or Enter on a name not fully typed yet, completes it; Enter on a full name sends it.
                  if (e.key === 'Tab' || (e.key === 'Enter' && menuItems[menuAt]!.name.toLowerCase() !== typed)) {
                    e.preventDefault();
                    pickCommand(menuItems[menuAt]!.name);
                    return;
                  }
                }
                if (pathItems.length > 0 && !e.nativeEvent.isComposing) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setPathIndex((pathAt + (e.key === 'ArrowDown' ? 1 : pathItems.length - 1)) % pathItems.length);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setPathClosedAt(draft);
                    return;
                  }
                  if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault();
                    pickPath(pathItems[pathAt]!, e.key === 'Tab');
                    return;
                  }
                }
                // ↑ in an empty input takes the newest queued message back to edit.
                if (e.key === 'ArrowUp' && !draft && pending.length === 0 && active?.queued?.length) {
                  e.preventDefault();
                  chat.editQueued(active.id, active.queued.at(-1)!.id);
                  return;
                }
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                // Settings › Chat: Enter sends (Shift+Enter = new line), or Ctrl+Enter sends (Enter = new line).
                const sends = sendKey === 'enter' ? !e.shiftKey : e.ctrlKey;
                if (!sends) return;
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }}
              onPaste={(e) => {
                // Pasted screenshots arrive as files.
                if (e.clipboardData.files.length === 0) return;
                e.preventDefault();
                attach(e.clipboardData.files);
              }}
              placeholder={
                active?.busy
                  ? inputWidth >= 400
                    ? 'queue a message · it runs when Harv finishes'
                    : 'queue a message'
                  : inputWidth >= 270
                    ? 'ask anything · / for commands'
                    : 'ask anything'
              }
              title={`${sendKey === 'enter' ? 'Enter sends, Shift+Enter' : 'Ctrl+Enter sends, Enter'} makes a new line. /help lists the commands.`}
              className="max-h-40 min-h-11 min-w-0 flex-1 resize-none overflow-y-hidden bg-transparent py-3 text-sm leading-5 outline-none placeholder:text-faint"
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) attach(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="relative">
              {attachMenu && (
                <div
                  role="menu"
                  aria-label="Attach"
                  className="absolute right-0 bottom-full z-30 mb-1 flex w-56 flex-col rounded-xl border border-[rgb(220_232_245/0.18)] bg-[rgb(16_24_34/0.96)] py-1 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)]"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void pickFromPc(false)}
                    className="cursor-pointer px-3 py-1.5 text-left hover:bg-white/10"
                  >
                    Files… <span className="text-faint">by path</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void pickFromPc(true)}
                    className="cursor-pointer px-3 py-1.5 text-left hover:bg-white/10"
                  >
                    Folder… <span className="text-faint">by path</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAttachMenu(false);
                      fileInputRef.current?.click();
                    }}
                    className="cursor-pointer px-3 py-1.5 text-left hover:bg-white/10"
                  >
                    Upload a copy…
                  </button>
                  <p className="m-0 px-3 pt-1 pb-0.5 text-[11px] text-faint">
                    By path, Harv works on it where it is. Tip: type @ in the line.
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={openAttach}
                onBlur={(e) => {
                  if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) setAttachMenu(false);
                }}
                aria-label="Attach"
                aria-expanded={inApp ? attachMenu : undefined}
                title={
                  inApp
                    ? 'Attach files or folders by path, or upload a copy (or type @ in the line)'
                    : 'Attach files (or drop them on the chat, or paste a screenshot); type @ to point Harv at a file or folder by path'
                }
                className={`min-h-11 cursor-pointer rounded-[10px] border border-[rgb(220_232_245/0.2)] bg-white/5 text-xs hover:bg-white/10 ${
                  isPhone ? 'min-w-11 px-0 text-base' : 'px-3.5'
                }`}
              >
                +<span className="hidden sm:inline"> ATTACH</span>
              </button>
            </div>
            {isPhone && <MicButton />}
            {active?.busy ? (
              <button
                type="button"
                onClick={() => chat.stop(active.id)}
                title="Stop (Esc)"
                aria-label="Stop"
                className={`min-h-11 cursor-pointer rounded-[10px] bg-warn text-xs font-semibold text-[#0f1620] ${isPhone ? 'min-w-11 px-0' : 'px-4'}`}
              >
                {isPhone ? '■' : 'STOP ■'}
              </button>
            ) : (
              <button
                type="submit"
                disabled={uploading}
                aria-label="Send"
                className={`min-h-11 cursor-pointer rounded-[10px] bg-accent text-xs font-semibold text-[#0f1620] disabled:cursor-wait disabled:opacity-60 ${
                  isPhone ? 'min-w-11 px-0 text-base' : 'px-4'
                }`}
              >
                {isPhone ? '↑' : 'RUN ⏎'}
              </button>
            )}
          </form>
        )}
        {askHere && <StartChoice key={active.id} tabId={active.id} title={active.title} />}
      </div>
    </section>
  );
}
