import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ACCENTS, COMPACT_ROWS, DEFAULT_SETTINGS, WARN_CHOICES, type CompactRow, type HarvSettings } from '@harv/shared';
import { comboOf, desktop, inApp, type AppSettings, type UpdateInfo } from '../lib/desktop.ts';
import { ago } from '../lib/format.ts';
import {
  projectActions,
  syncNow,
  updateSettings,
  useBackground,
  useConnection,
  useProjects,
  useSettings,
  useSync,
} from '../lib/useHarvSocket.ts';

const ACCENT_NAMES: Record<string, string> = {
  '#A8C8E8': 'Ice blue',
  '#9FE0C4': 'Mint',
  '#F2B880': 'Amber',
  '#C9B8F0': 'Lavender',
};

/** An example path in the form of the OS Harv runs on (C:\… on Windows, /home/… on Linux). */
function useExample(windows: string, linux: string): string {
  return useConnection().platform === 'windows' ? windows : linux;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl bg-black/20 px-3 py-2.5">
      <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({ on, label, hint, onChange }: { on: boolean; label: string; hint?: string; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-xs">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-5 w-9 flex-none items-center rounded-full p-0.5 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${
          on ? 'bg-accent' : 'bg-white/15'
        }`}
      >
        <span className={`size-4 rounded-full bg-[#0f1620] transition-transform ${on ? 'translate-x-4' : ''}`} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-ink">{label}</span>
        {hint && <span className="text-faint">{hint}</span>}
      </span>
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  // Moves freely while dragging; saved when let go, so the settings file isn't written 60 times a second.
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? value;
  const save = () => {
    if (live !== null && live !== value) onChange(live);
    setLive(null);
  };
  return (
    <label className="flex items-center gap-3 text-xs">
      <span className="w-24 flex-none text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setLive(Number(e.target.value))}
        onPointerUp={save}
        onKeyUp={save}
        onBlur={save}
        className="min-w-0 flex-1 accent-[var(--color-accent)]"
      />
      <span className="w-12 flex-none text-right tabular-nums">
        {shown}
        {unit}
      </span>
    </label>
  );
}

/** A small row of choices (one picked). */
function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="w-24 flex-none text-muted">{label}</span>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-8 cursor-pointer rounded-lg border px-2.5 ${
            value === o.value ? 'border-accent/60 bg-accent/15 text-ink' : 'border-line text-muted hover:bg-white/5'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Several choices that can each be on or off. */
function Chips<T extends string | number>({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: T[];
  options: { value: T; label: string }[];
  onChange: (v: T[]) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="w-24 flex-none text-muted">{label}</span>
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() =>
              onChange(
                on ? values.filter((v) => v !== o.value) : options.map((x) => x.value).filter((v) => v === o.value || values.includes(v)),
              )
            }
            className={`min-h-8 cursor-pointer rounded-lg border px-2.5 ${on ? 'border-accent/60 bg-accent/15 text-ink' : 'border-line text-faint hover:bg-white/5'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const LOOK_KEYS = ['motion', 'accent', 'backgroundBlur', 'scrim', 'glass', 'uiScale', 'density'] as const satisfies (keyof HarvSettings)[];
const ROW_NAMES: Record<CompactRow, string> = {
  cpu: 'CPU',
  gpu: 'GPU',
  ram: 'RAM',
  disk: 'Disk',
  net: 'Net',
  session: 'Session',
  weekly: 'Weekly',
};

function WorkFolder() {
  const example = useExample('C:\\Users\\you\\Projects', '/home/you/Projects');
  const { workDir } = useSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? workDir;
  const save = (e: FormEvent) => {
    e.preventDefault();
    updateSettings({ workDir: value.trim() });
    setDraft(null);
  };
  return (
    <Section title="Default folder">
      <p className="m-0 text-[11px] text-faint">
        Where new terminals and the file explorer open, and where Harv works on files when you don't say where. Harv's own scratch files
        stay in ~/.harv/workspace. Empty = your home folder.
      </p>
      <form onSubmit={save} className="flex gap-2">
        <label htmlFor="harv-workdir" className="sr-only">
          Default folder
        </label>
        <input
          id="harv-workdir"
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={example}
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
        />
        <button type="submit" className="min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs hover:bg-white/10">
          Save
        </button>
      </form>
      {draft !== null && draft.trim() !== workDir && <p className="m-0 text-[11px] text-faint">Not saved yet: press Save.</p>}
    </Section>
  );
}

/** Restarts the Harv server (to load changes to its own code); the page reconnects by itself. */
function RestartButton() {
  const [state, setState] = useState<'idle' | 'asking' | 'restarting'>('idle');
  if (state === 'restarting') return <p className="m-0 text-[11px] text-accent">Restarting… the page reconnects in a few seconds.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
      <button
        type="button"
        onClick={() => {
          if (state === 'idle') return setState('asking');
          setState('restarting');
          void fetch('/api/restart', { method: 'POST' }).catch(() => {});
        }}
        className="min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 hover:bg-white/10"
      >
        {state === 'asking' ? 'Yes, restart now' : 'Restart Harv'}
      </button>
      <span className="text-[11px] text-faint">
        {state === 'asking'
          ? 'Any reply in progress stops. Tabs, drafts and terminals come back.'
          : inApp
            ? 'Loads changes to Harv’s own server code. Quit Harv from the tray icon.'
            : 'Loads changes to Harv’s own server code. Stop and start from the desktop shortcuts.'}
      </span>
    </div>
  );
}

/** The desktop app's own settings (this device only, ~/.harv/app.json): hotkey, autostart, updates. */
function AppSection() {
  const [app, setApp] = useState<AppSettings | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState<'checking' | 'updating' | null>(null);

  useEffect(() => {
    desktop.settings().then(setApp, () => {});
  }, []);

  const change = (patch: { hotkey?: string; autostart?: boolean }) => {
    setError(null);
    desktop.setSettings(patch).then(setApp, (e: unknown) => setError(String(e)));
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') return setRecording(false);
    const combo = comboOf(e);
    if (!combo) return;
    setRecording(false);
    change({ hotkey: combo });
  };
  const run = (what: 'checking' | 'updating') => {
    setUpdating(what);
    setError(null);
    (what === 'checking' ? desktop.checkUpdates() : desktop.applyUpdate())
      .then(setUpdate, (e: unknown) => setError(String(e)))
      .finally(() => setUpdating(null));
  };

  if (!app) return null;
  const button =
    'min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 hover:bg-white/10 disabled:cursor-default disabled:opacity-50';
  return (
    <Section title="App">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="w-24 flex-none text-muted">Hotkey</span>
        {app.hotkeyWorks ? (
          <button
            type="button"
            onClick={() => setRecording(true)}
            onKeyDown={recording ? onKey : undefined}
            onBlur={() => setRecording(false)}
            className={`${button} ${recording ? 'border-accent text-accent' : ''}`}
          >
            {recording ? 'Press the keys…' : app.hotkey}
          </button>
        ) : (
          <span className="text-faint">
            {app.hotkey}, set in KDE’s System Settings › Shortcuts (Wayland doesn’t let apps take a hotkey).
          </span>
        )}
      </div>
      {app.hotkeyWorks && <p className="m-0 text-[11px] text-faint">Brings Harv up from anywhere, ready to type; again hides it.</p>}
      <Toggle
        on={app.autostart}
        label="Open Harv when I log in"
        hint="Starts Harv in the tray, ready for the hotkey."
        onChange={(autostart) => change({ autostart })}
      />
      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
        {update && update.behind > 0 ? (
          <button type="button" disabled={!!updating || update.dirty} onClick={() => run('updating')} className={button}>
            {updating === 'updating' ? 'Updating…' : `Update (${update.behind} new)`}
          </button>
        ) : (
          <button type="button" disabled={!!updating} onClick={() => run('checking')} className={button}>
            {updating === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        <span className="text-[11px] text-faint">
          {update?.error ??
            (update?.dirty && update.behind > 0
              ? 'Harv’s folder has uncommitted changes; the update waits for them.'
              : update && update.behind === 0
                ? 'Up to date.'
                : `App ${app.version}. Updates pull Harv’s repo and restart it; never by themselves.`)}
        </span>
      </div>
      {error && <p className="m-0 text-[11px] text-warn">{error}</p>}
    </Section>
  );
}

/** A one-line text setting with a Save button (Enter saves too). */
function TextSetting({
  id,
  label,
  value,
  placeholder,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const save = (e: FormEvent) => {
    e.preventDefault();
    onSave(shown.trim());
    setDraft(null);
  };
  return (
    <form onSubmit={save} className="flex items-center gap-2 text-xs">
      <label htmlFor={id} className="w-24 flex-none text-muted">
        {label}
      </label>
      <input
        id={id}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
      />
      <button
        type="submit"
        disabled={draft === null || draft.trim() === value}
        className="min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs hover:bg-white/10 disabled:cursor-default disabled:opacity-40"
      >
        Save
      </button>
    </form>
  );
}

/** Sync with the user's other devices through their private Git repo (docs/PLAN.md §6m). */
function Sync() {
  const settings = useSettings();
  const status = useSync();
  const peers = status?.peers ?? [];
  const line = status?.busy
    ? 'Syncing…'
    : status?.lastSync
      ? `Last synced ${ago(status.lastSync)}${status.pending ? `, ${status.pending} changes still to send` : ''}.`
      : 'Not synced yet.';
  return (
    <Section title="Sync">
      <Toggle
        on={settings.syncEnabled}
        label="Sync with my other devices"
        hint="Chats, Harv's memory and shared settings (look, chat, safety rules) go through your private Git repo, encrypted with a key only your devices have. Folders, sensors, terminals and the tab layout stay on each device. Every 2 minutes and after each reply."
        onChange={(syncEnabled) => updateSettings({ syncEnabled })}
      />
      <TextSetting
        id="harv-sync-repo"
        label="Private repo"
        value={settings.syncRepo}
        placeholder="https://github.com/you/harv-sync.git"
        onSave={(syncRepo) => updateSettings({ syncRepo })}
      />
      <TextSetting
        id="harv-device-name"
        label="This device"
        value={settings.deviceName}
        placeholder={status?.device.name ?? 'This computer'}
        onSave={(deviceName) => updateSettings({ deviceName })}
      />
      {settings.syncEnabled && (
        <div className="flex flex-col gap-1.5 text-[11px] text-faint">
          {!settings.syncRepo ? (
            <p className="m-0">Add the repo’s address to start. Use a private repo: never the public Harv one.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={syncNow}
                  disabled={status?.busy}
                  className="min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs text-ink hover:bg-white/10 disabled:cursor-default disabled:opacity-40"
                >
                  Sync now
                </button>
                <span>{line}</span>
              </div>
              {peers.length > 0 && (
                <p className="m-0">
                  Other devices: {peers.map((p) => `${p.name}${p.lastChange ? ` (last change ${ago(p.lastChange)})` : ''}`).join(', ')}
                </p>
              )}
            </>
          )}
          {status?.error && <p className="m-0 leading-snug text-warn">{status.error}</p>}
          {status?.needsKey && (
            <p className="m-0 leading-snug">
              The key is the file ~/.harv/sync.key on the device that synced first. Copy it to the same place here (it never goes through
              the repo), then press Sync now.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

function Projects() {
  const example = useExample('C:\\path\\to\\a\\project', '/path/to/a/project');
  const defaultRoot = useExample('your home\\Projects', 'your home/Projects');
  const { list, error } = useProjects();
  const { projectsDir } = useSettings();
  const [path, setPath] = useState('');
  const [root, setRoot] = useState<string | null>(null);
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    projectActions.add(path.trim());
    setPath('');
  };
  const input =
    'min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60';
  const button = 'min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs hover:bg-white/10';
  return (
    <Section title="Projects">
      <p className="m-0 text-[11px] text-faint">
        In a project chat Harv works like Claude Code in that folder, with its CLAUDE.md and memory. Tell Harv "we're starting a new
        project" or "let's work on …", or pick a project in a chat's ≡ menu.
      </p>
      {list.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <span className="text-accent">▣</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{p.name}</span>
                <span className="truncate text-[11px] text-faint" title={p.path}>
                  {p.path}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Forget ${p.name}`}
                title="Forget this project (the folder and chats stay)"
                onClick={() => projectActions.remove(p.id)}
                className="size-7 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex gap-2">
        <label htmlFor="harv-project-path" className="sr-only">
          Project folder to add
        </label>
        <input id="harv-project-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder={example} className={input} />
        <button type="submit" className={button}>
          Add
        </button>
      </form>
      {error && <p className="m-0 text-[11px] text-warn">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (root !== null) updateSettings({ projectsDir: root.trim() });
          setRoot(null);
        }}
        className="flex items-center gap-2 pt-1 text-xs"
      >
        <label htmlFor="harv-projects-dir" className="w-24 flex-none text-muted">
          New projects in
        </label>
        <input
          id="harv-projects-dir"
          value={root ?? projectsDir}
          onChange={(e) => setRoot(e.target.value)}
          placeholder={defaultRoot}
          className={input}
        />
        <button type="submit" className={button}>
          Save
        </button>
      </form>
    </Section>
  );
}

function BackgroundPicker() {
  const { version } = useBackground();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  const upload = async (file: File) => {
    setStatus('Uploading…');
    try {
      const res = await fetch('/api/background', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const body = (await res.json()) as { error?: string };
      setStatus(res.ok ? null : (body.error ?? 'Upload failed'));
    } catch {
      setStatus('Upload failed: is the Harv server running?');
    }
  };

  return (
    <Section title="Background">
      <div className="flex items-center gap-3">
        <div
          aria-hidden="true"
          className="h-14 w-24 flex-none rounded-lg border border-line bg-ground bg-cover bg-center"
          style={{ backgroundImage: version ? `url(/api/background?v=${version})` : undefined }}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs hover:bg-white/10"
          >
            Choose photo…
          </button>
          {version && (
            <button
              type="button"
              onClick={() => void fetch('/api/background', { method: 'DELETE' })}
              className="min-h-9 cursor-pointer rounded-lg px-3 text-xs text-muted hover:bg-white/10"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = '';
        }}
      />
      <p className="m-0 text-[11px] text-faint">
        {status ?? 'JPEG, PNG or WebP up to 20 MB. It stays on this computer (in ~/.harv), blurred behind the dashboard.'}
      </p>
    </Section>
  );
}

/** Settings › Watchdog: on/off and the programs it ignores (alerts show as toasts, not here). */
function Watchdog() {
  const { watchdog, watchdogIgnored } = useSettings();
  const onWindows = useConnection().platform === 'windows';
  return (
    <Section title="Watchdog">
      <Toggle
        on={watchdog}
        label="Watch my PC"
        hint={
          onWindows
            ? 'Warns when something overheats for minutes, a program without a window hogs the CPU or GPU for 5+ minutes, Windows Defender finds a threat or is off, or a known miner or remote-control tool runs. Quiet by design: no Claude usage, at most one ordinary warning per 10 minutes.'
            : 'Warns when something overheats for minutes, a known miner or remote-control tool runs, or a program from /tmp keeps working. Quiet by design: no Claude usage, at most one ordinary warning per 10 minutes.'
        }
        onChange={(on) => updateSettings({ watchdog: on })}
      />
      {watchdogIgnored.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-faint">Never warns about</span>
          {watchdogIgnored.map((app) => (
            <span key={app} className="inline-flex items-center gap-1 rounded-md border border-line bg-white/5 py-0.5 pr-0.5 pl-2">
              {app}
              <button
                type="button"
                aria-label={`Warn about ${app} again`}
                onClick={() => updateSettings({ watchdogIgnored: watchdogIgnored.filter((x) => x !== app) })}
                className="size-5 cursor-pointer rounded text-muted hover:bg-white/10"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </Section>
  );
}

function ProtectedFolders() {
  const example = useExample('C:\\Users\\you\\Documents\\Taxes', '/home/you/Documents/Taxes');
  const { protectedPaths } = useSettings();
  const [draft, setDraft] = useState('');

  const add = (e: FormEvent) => {
    e.preventDefault();
    const path = draft.trim();
    if (!path) return;
    updateSettings({ protectedPaths: [...protectedPaths, path] });
    setDraft('');
  };

  return (
    <Section title="Read-only folders">
      <p className="m-0 text-[11px] text-faint">Harv can read these but never change, move or delete anything inside them.</p>
      {protectedPaths.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
          {protectedPaths.map((p) => (
            <li key={p} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={p}>
                {p}
              </span>
              <button
                type="button"
                aria-label={`Remove ${p}`}
                onClick={() => updateSettings({ protectedPaths: protectedPaths.filter((x) => x !== p) })}
                className="size-7 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex gap-2">
        <label htmlFor="harv-protect" className="sr-only">
          Folder to protect
        </label>
        <input
          id="harv-protect"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={example}
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
        />
        <button type="submit" className="min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs hover:bg-white/10">
          Add
        </button>
      </form>
    </Section>
  );
}

/** Harv's settings, shown as a tab in the chat bar. Saved in ~/.harv/settings.json and applied at once in every window. */
export function SettingsView() {
  const settings = useSettings();
  const onWindows = useConnection().platform === 'windows';
  const lookChanged = LOOK_KEYS.some((k) => settings[k] !== DEFAULT_SETTINGS[k]);
  const resetLook = () => updateSettings(Object.fromEntries(LOOK_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])) as Partial<HarvSettings>);

  return (
    <div className="animate-fade-in mx-auto grid w-full max-w-[920px] grid-cols-1 content-start gap-2.5 md:grid-cols-2">
      <p className="m-0 px-1 text-xs text-muted md:col-span-2">
        Saved in ~/.harv/settings.json and applied at once in every Harv window. With Sync on, the look, chat and safety settings follow you
        to your other devices; folders, size and startup stay on this one.
      </p>

      <Section title="Look">
        <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="w-24 flex-none text-muted">Accent</span>
          {ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={settings.accent === c}
              aria-label={ACCENT_NAMES[c]}
              title={ACCENT_NAMES[c]}
              onClick={() => updateSettings({ accent: c })}
              className={`size-7 cursor-pointer rounded-full border-2 ${settings.accent === c ? 'border-ink' : 'border-transparent'}`}
              style={{ background: c }}
            />
          ))}
          <label
            title="Any colour"
            className={`relative size-7 cursor-pointer overflow-hidden rounded-full border-2 ${
              (ACCENTS as readonly string[]).includes(settings.accent) ? 'border-dashed border-line' : 'border-ink'
            }`}
            style={{ background: (ACCENTS as readonly string[]).includes(settings.accent) ? undefined : settings.accent }}
          >
            <span className="sr-only">Custom accent colour</span>
            {(ACCENTS as readonly string[]).includes(settings.accent) && (
              <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-muted">
                +
              </span>
            )}
            <input
              type="color"
              value={settings.accent.toLowerCase()}
              onChange={(e) => updateSettings({ accent: e.target.value.toUpperCase() })}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
        <Slider
          label="Size"
          value={settings.uiScale}
          min={80}
          max={130}
          step={5}
          unit="%"
          onChange={(uiScale) => updateSettings({ uiScale })}
        />
        <Slider label="Glass" value={settings.glass} min={20} max={95} step={5} unit="%" onChange={(glass) => updateSettings({ glass })} />
        <Choice
          label="Chat spacing"
          value={settings.density}
          options={[
            { value: 'comfy', label: 'Comfy' },
            { value: 'compact', label: 'Compact' },
          ]}
          onChange={(density) => updateSettings({ density })}
        />
        <Toggle
          on={settings.motion}
          label="Animations"
          hint="Subtle fades, pulses and bars. Off keeps everything still."
          onChange={(motion) => updateSettings({ motion })}
        />
        {lookChanged && (
          <button
            type="button"
            onClick={resetLook}
            className="cursor-pointer self-start rounded px-1 text-[11px] text-muted hover:text-accent"
          >
            Reset the look to default
          </button>
        )}
      </Section>

      <div className="flex flex-col gap-2.5">
        <BackgroundPicker />
        <Section title="Background effect">
          <Slider
            label="Blur"
            value={settings.backgroundBlur}
            min={0}
            max={30}
            unit="px"
            onChange={(backgroundBlur) => updateSettings({ backgroundBlur })}
          />
          <Slider
            label="Darkness"
            value={settings.scrim}
            min={0}
            max={90}
            step={5}
            unit="%"
            onChange={(scrim) => updateSettings({ scrim })}
          />
        </Section>
      </div>

      <Section title="Chat">
        <Toggle on={settings.showTimes} label="Times on chat lines" onChange={(showTimes) => updateSettings({ showTimes })} />
        <Toggle
          on={settings.showTags}
          label="Model tag on replies"
          hint="The [sonnet·medium] after harv ›. Hover it to see why AUTO picked it."
          onChange={(showTags) => updateSettings({ showTags })}
        />
        <Choice
          label="Send with"
          value={settings.sendKey}
          options={[
            { value: 'enter', label: 'Enter' },
            { value: 'ctrlEnter', label: 'Ctrl+Enter' },
          ]}
          onChange={(sendKey) => updateSettings({ sendKey })}
        />
        <p className="m-0 text-[11px] text-faint">
          {settings.sendKey === 'enter' ? 'Shift+Enter makes a new line.' : 'Enter makes a new line, so long messages are easier to write.'}
        </p>
      </Section>

      <Section title="AUTO">
        <Choice
          label="Start on"
          value={settings.startModel}
          options={[
            { value: 'auto', label: 'AUTO' },
            { value: 'last', label: 'Last model picked' },
          ]}
          onChange={(startModel) => updateSettings({ startModel })}
        />
        <Toggle
          on={settings.allowFable}
          label="Allow Fable 5.1"
          hint="Lets AUTO use Fable for the hardest tasks and as the top of Try harder. It's always available as a manual pick."
          onChange={(allowFable) => updateSettings({ allowFable })}
        />
      </Section>

      <Section title="Stats panel">
        <Toggle on={settings.statsExpanded} label="Start expanded" onChange={(statsExpanded) => updateSettings({ statsExpanded })} />
        <Chips
          label="Narrow view"
          values={settings.compactRows}
          options={COMPACT_ROWS.map((r) => ({ value: r, label: ROW_NAMES[r] }))}
          onChange={(compactRows) => updateSettings({ compactRows })}
        />
        <Choice
          label="Temperature"
          value={settings.tempUnit}
          options={[
            { value: 'C', label: '°C' },
            { value: 'F', label: '°F' },
          ]}
          onChange={(tempUnit) => updateSettings({ tempUnit })}
        />
        <Choice
          label="Update every"
          value={settings.metricsMs}
          options={[
            { value: 1000, label: '1 s' },
            { value: 2000, label: '2 s' },
            { value: 5000, label: '5 s' },
          ]}
          onChange={(metricsMs) => updateSettings({ metricsMs })}
        />
      </Section>

      <Section title="Usage warnings">
        <p className="m-0 text-[11px] text-faint">
          A note pops up when your Claude plan use crosses these marks, once per window. Turn them all off for no warnings.
        </p>
        <Chips
          label="Session"
          values={settings.warnSession}
          options={WARN_CHOICES.session.map((v) => ({ value: v as number, label: `${v}%` }))}
          onChange={(warnSession) => updateSettings({ warnSession })}
        />
        <Chips
          label="Weekly"
          values={settings.warnWeekly}
          options={WARN_CHOICES.weekly.map((v) => ({ value: v as number, label: `${v}%` }))}
          onChange={(warnWeekly) => updateSettings({ warnWeekly })}
        />
      </Section>

      <WorkFolder />

      <Projects />

      <Section title="Safety">
        <Toggle
          on={settings.confirmYellow}
          label="Ask before changing my files too"
          hint="Normally Harv backs up and changes your files right away (you can Undo). On, it shows an approval card first, like for deleting."
          onChange={(confirmYellow) => updateSettings({ confirmYellow })}
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs">Don’t ask again for</span>
          {settings.allowRules.length === 0 ? (
            <p className="m-0 text-[11px] text-faint">
              Nothing yet. “Don’t ask again” on an approval card adds the kind of command here (it then runs without a card, backed up
              first, with Undo). Blocked things always stay blocked.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
              {settings.allowRules.map((rule) => (
                <li key={rule} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate">{rule} …</code>
                  <button
                    type="button"
                    aria-label={`Ask again for ${rule}`}
                    title="Ask again for these"
                    onClick={() => updateSettings({ allowRules: settings.allowRules.filter((x) => x !== rule) })}
                    className="size-7 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Watchdog />

      {inApp && <AppSection />}

      <Section title="Startup">
        <Toggle
          on={settings.restoreTabs}
          label="Reopen tabs"
          hint="After a restart, bring back the tabs, their files and terminals, and unsent messages, like Chrome."
          onChange={(restoreTabs) => updateSettings({ restoreTabs })}
        />
        {onWindows && (
          <Toggle
            on={settings.startSensors}
            label="Start the hardware sensors"
            hint="Starts LibreHardwareMonitor with Harv (Windows asks for permission). Off, temperatures and fans stay hidden until you press Start sensors."
            onChange={(startSensors) => updateSettings({ startSensors })}
          />
        )}
        <RestartButton />
      </Section>

      <Sync />

      <ProtectedFolders />
    </div>
  );
}
