import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { cancelSchedule, useSchedules, whenText } from '../lib/scheduleStore.ts';
import { useChat } from '../lib/chatStore.ts';
import { ACCENTS, COMPACT_ROWS, DEFAULT_SETTINGS, WARN_CHOICES, type BackupInfo, type CompactRow, type HarvSettings } from '@harv/shared';
import { comboOf, desktop, inApp, type AppSettings, type UpdateInfo } from '../lib/desktop.ts';
import { ago } from '../lib/format.ts';
import { disablePush, enablePush, isPhone, lockPhone, newShortcutToken, testPush } from '../lib/phone.ts';
import { askPhones, revokePhone, usePhones } from '../lib/phoneStore.ts';
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

/** The width of every row's label, so controls line up down a section. */
const LABEL = 'flex-none text-muted @md:w-28';
/** A label and its control side by side; stacked in a narrow window so text boxes keep their room. */
const ROW = 'flex flex-col items-stretch gap-1.5 text-xs @md:flex-row @md:items-center @md:gap-3';
const BUTTON =
  'min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs hover:bg-white/10 disabled:cursor-default disabled:opacity-40';
const INPUT =
  'min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60';

/** A big section (Appearance, Safety…): its own glass card, clearly apart from the next. Subsections flow in 1–2 columns inside. */
function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-black/25 p-4">
      <header className="flex flex-col gap-0.5 border-b border-line pb-2.5">
        <h2 className="m-0 text-sm font-semibold tracking-wide text-accent">{title}</h2>
        {hint && <p className="m-0 text-[11px] text-faint">{hint}</p>}
      </header>
      <div className="columns-1 gap-3 @3xl:columns-2">{children}</div>
    </section>
  );
}

/** A subsection inside a big section. */
function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3 flex break-inside-avoid flex-col gap-2.5 rounded-xl bg-white/[0.035] px-3 py-3">
      <h3 className="m-0 text-[12px] font-semibold text-ink">{title}</h3>
      {children}
    </div>
  );
}

/** A small grey note under a setting. */
const Note = ({ children, warn }: { children: ReactNode; warn?: boolean }) => (
  <p className={`m-0 text-[11px] leading-snug ${warn ? 'text-warn' : 'text-faint'}`}>{children}</p>
);

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
      <span className="w-20 flex-none text-muted @md:w-28">{label}</span>
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
      {/* A fixed width, so dragging never moves the slider ("7 days" → "180 days" needs the wider one). */}
      <span className={`${unit.length > 2 ? 'w-20' : 'w-12'} flex-none text-right whitespace-nowrap tabular-nums`}>
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
    <div role="radiogroup" aria-label={label} className={ROW}>
      <span className={LABEL}>{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">
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
    <div role="group" aria-label={label} className={ROW}>
      <span className={LABEL}>{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">
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
    </div>
  );
}

const LOOK_KEYS = [
  'motion',
  'accent',
  'backgroundBlur',
  'scrim',
  'glass',
  'glassBlur',
  'uiScale',
  'density',
] as const satisfies (keyof HarvSettings)[];
const ROW_NAMES: Record<CompactRow, string> = {
  cpu: 'CPU',
  gpu: 'GPU',
  ram: 'RAM',
  disk: 'Disk',
  net: 'Net',
  session: 'Session',
  weekly: 'Weekly',
};

/** A one-line text setting with a Save button (Enter saves too); Save lights up only when something changed. */
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
  const changed = draft !== null && draft.trim() !== value;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (changed) onSave(shown.trim());
    setDraft(null);
  };
  return (
    <form onSubmit={save} className={ROW}>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <div className="flex min-w-0 flex-1 gap-2">
        <input
          id={id}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className={INPUT}
        />
        <button type="submit" disabled={!changed} className={BUTTON}>
          Save
        </button>
      </div>
    </form>
  );
}

/** A list of paths (projects, read-only folders) with an × on each. */
function PathList({
  items,
  onRemove,
}: {
  items: { key: string; title?: string; path: string; label: string }[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
      {items.map((p) => (
        <li key={p.key} className="flex items-center gap-2 rounded-lg bg-black/15 py-1 pr-1 pl-2.5">
          <span className="flex min-w-0 flex-1 flex-col">
            {p.title && <span className="truncate">{p.title}</span>}
            <span className={`truncate ${p.title ? 'text-[11px] text-faint' : ''}`} title={p.path}>
              {p.path}
            </span>
          </span>
          <button
            type="button"
            aria-label={p.label}
            title={p.label}
            onClick={() => onRemove(p.key)}
            className="size-7 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A path box with an Add button (projects, read-only folders). */
function AddPath({ id, label, placeholder, onAdd }: { id: string; label: string; placeholder: string; onAdd: (path: string) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.trim()) return;
        onAdd(draft.trim());
        setDraft('');
      }}
      className="flex gap-2"
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={INPUT}
      />
      <button type="submit" disabled={!draft.trim()} className={BUTTON}>
        Add
      </button>
    </form>
  );
}

function WorkFolder() {
  const example = useExample('C:\\Users\\you\\Projects', '/home/you/Projects');
  const { workDir } = useSettings();
  return (
    <Sub title="Default folder">
      <Note>Where new terminals and the file explorer open, and where Harv works when you don’t say where. Empty = your home folder.</Note>
      <TextSetting id="harv-workdir" label="Folder" value={workDir} placeholder={example} onSave={(v) => updateSettings({ workDir: v })} />
    </Sub>
  );
}

/** Restarts the Harv server (to load changes to its own code); the page reconnects by itself. */
function RestartButton() {
  const [state, setState] = useState<'idle' | 'asking' | 'restarting'>('idle');
  if (state === 'restarting') return <Note>Restarting… the page reconnects in a few seconds.</Note>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        onClick={() => {
          if (state === 'idle') return setState('asking');
          setState('restarting');
          void fetch('/api/restart', { method: 'POST' }).catch(() => {});
        }}
        className={`${BUTTON} ${state === 'asking' ? 'border-warn/60 text-warn' : ''}`}
      >
        {state === 'asking' ? 'Yes, restart now' : 'Restart Harv'}
      </button>
      <span className="text-[11px] text-faint">
        {state === 'asking' ? 'A reply in progress stops; tabs, drafts and terminals come back.' : 'Loads changes to Harv’s own code.'}
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

  return (
    <Sub title="App">
      {!app ? (
        <Note>Reading the app’s settings…</Note>
      ) : (
        <>
          <div className={ROW}>
            <span className={LABEL}>Hotkey</span>
            {app.hotkeyWorks ? (
              <button
                type="button"
                title="Brings Harv up from anywhere, ready to type; again hides it"
                onClick={() => setRecording(true)}
                onKeyDown={recording ? onKey : undefined}
                onBlur={() => setRecording(false)}
                className={`${BUTTON} ${recording ? 'border-accent text-accent' : ''}`}
              >
                {recording ? 'Press the keys…' : app.hotkey}
              </button>
            ) : (
              <span className="text-faint">{app.hotkey}, set in KDE’s System Settings › Shortcuts.</span>
            )}
          </div>
          <Toggle
            on={app.autostart}
            label="Open Harv when I log in"
            hint="Starts in the tray, ready for the hotkey."
            onChange={(autostart) => change({ autostart })}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {update && update.behind > 0 ? (
              <button type="button" disabled={!!updating || update.dirty} onClick={() => run('updating')} className={BUTTON}>
                {updating === 'updating' ? 'Updating…' : `Update (${update.behind} new)`}
              </button>
            ) : (
              <button type="button" disabled={!!updating} onClick={() => run('checking')} className={BUTTON}>
                {updating === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            )}
            <span className="text-[11px] text-faint">
              {update?.error ??
                (update?.dirty && update.behind > 0
                  ? 'Harv’s folder has uncommitted changes; the update waits for them.'
                  : update && update.behind === 0
                    ? 'Up to date.'
                    : `App ${app.version}. Never updates by itself.`)}
            </span>
          </div>
          {error && <Note warn>{error}</Note>}
        </>
      )}
    </Sub>
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
    <>
      <Sub title="Connection">
        <Toggle
          on={settings.syncEnabled}
          label="Sync with my other devices"
          hint="Chats, memory, projects and shared settings, encrypted. Within seconds over Tailscale when both devices are on; otherwise through your private Git repo, every 2 minutes and after each reply."
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
      </Sub>
      <Sub title="Status">
        {!settings.syncEnabled && <Note>Sync is off: everything stays on this device.</Note>}
        {settings.syncEnabled &&
          (!settings.syncRepo ? (
            <Note>Add the repo’s address to start. Use a private repo, never the public Harv one.</Note>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
              <button type="button" onClick={syncNow} disabled={status?.busy} className={BUTTON}>
                Sync now
              </button>
              <span>{line}</span>
              {peers.length > 0 && (
                <span className="basis-full">
                  Other devices:{' '}
                  {peers
                    .map((p) => `${p.name}${p.live ? ' (live over Tailscale)' : p.lastChange ? ` (last change ${ago(p.lastChange)})` : ''}`)
                    .join(', ')}
                </span>
              )}
            </div>
          ))}
        {settings.syncEnabled && status?.error && <Note warn>{status.error}</Note>}
        {settings.syncEnabled && status?.needsKey && (
          <Note>
            The key is ~/.harv/sync.key on the device that synced first. Copy it to the same place here (it never goes through the repo),
            then press Sync now.
          </Note>
        )}
      </Sub>
    </>
  );
}

/** Settings › Phone on the computer: the switch, the address, the paired phones (docs/PLAN.md §6q). */
function PhoneAccessSettings() {
  const settings = useSettings();
  const { phones, access } = usePhones();
  useEffect(() => void askPhones(), []);
  return (
    <>
      <Sub title="Phone access">
        <Toggle
          on={settings.phoneAccess}
          label="Open Harv from my phone"
          hint="Only over Tailscale, only from your own account, and only on phones you pair here, with Face ID each time. Nothing is opened to the internet."
          onChange={(phoneAccess) => updateSettings({ phoneAccess })}
        />
        {settings.phoneAccess && access?.problem && <Note warn>{access.problem}</Note>}
        {settings.phoneAccess && access?.serving && access.url && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-faint">Address:</span>
              <code className="rounded bg-black/30 px-1.5 py-0.5 text-ink select-all">{access.url}</code>
              <CopyButton text={access.url} />
            </div>
            <Note>
              On the iPhone: Tailscale on (same account) → open the address in Safari → Share › Add to Home Screen → open Harv from the Home
              Screen → pair. The code shows up here.
            </Note>
          </>
        )}
        {settings.phoneAccess && !access?.serving && !access?.problem && <Note>Starting Tailscale’s phone address…</Note>}
      </Sub>
      <Sub title="Paired phones">
        {phones.length === 0 && <Note>None yet.</Note>}
        {phones.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-ink">{p.name}</span>
            <span className="text-[11px] text-faint">
              {[p.passkey ? 'Face ID' : 'Face ID not set up', p.push && 'notifications', p.shortcut && 'Siri'].filter(Boolean).join(' · ')}
              {p.lastSeen ? ` · seen ${ago(p.lastSeen)}` : ''}
            </span>
            <button type="button" className={`${BUTTON} ml-auto`} onClick={() => revokePhone(p.id)}>
              Remove
            </button>
          </div>
        ))}
        {phones.length > 0 && <Note>Remove a phone you lost or gave away: it’s locked out at once.</Note>}
      </Sub>
    </>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={BUTTON}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          },
          () => {},
        );
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** Settings › Phone on the phone itself: notifications, Siri and the share sheet (docs/PLAN.md §6q). */
function ThisPhoneSettings() {
  const [pushNote, setPushNote] = useState('');
  const [pushOn, setPushOn] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const [token, setToken] = useState<{ token: string; url: string } | null>(null);
  const [err, setErr] = useState('');
  return (
    <>
      <Sub title="This phone">
        <div className="flex flex-wrap gap-2">
          {!pushOn ? (
            <button
              type="button"
              className={BUTTON}
              onClick={() =>
                void enablePush().then((problem) => {
                  setPushNote(problem ?? 'Notifications are on.');
                  setPushOn(!problem);
                })
              }
            >
              Turn on notifications
            </button>
          ) : (
            <>
              <button
                type="button"
                className={BUTTON}
                onClick={() =>
                  void testPush().then((r) => setPushNote(r.sent ? 'Sent: it should show in a moment.' : 'No phone has notifications on.'))
                }
              >
                Send a test
              </button>
              <button
                type="button"
                className={BUTTON}
                onClick={() => void disablePush().then(() => (setPushOn(false), setPushNote('Notifications are off.')))}
              >
                Turn off notifications
              </button>
            </>
          )}
          <button type="button" className={BUTTON} onClick={() => void lockPhone().then(() => location.reload())}>
            Lock now
          </button>
        </div>
        <Note>
          Notifications: a reply you started here is done, usage and watchdog warnings, scheduled tasks, and “Harv wants to talk”.
        </Note>
        {pushNote && <Note>{pushNote}</Note>}
      </Sub>
      <Sub title="Siri and the share sheet">
        <Note>
          Two Shortcuts in Apple’s Shortcuts app: “Hey Siri, Harv” to talk to Harv (in CarPlay too), and “Send to Harv” in the share sheet
          for photos, files and links. They need this phone’s token.
        </Note>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              void newShortcutToken().then(
                (t) => (setToken(t), setErr('')),
                (e: Error) => setErr(e.message),
              )
            }
          >
            {token ? 'Make a new token' : 'Make the Shortcut token'}
          </button>
        </div>
        {err && <Note warn>{err}</Note>}
        {token && <ShortcutGuide url={token.url} token={token.token} />}
        {!token && <Note>Making a new token stops the old one: Shortcuts that use it need the new one.</Note>}
      </Sub>
    </>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
      <span className="text-faint">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-1.5 py-0.5 text-ink select-all">{value}</code>
      <CopyButton text={value} />
    </div>
  );
}

function ShortcutGuide({ url, token }: { url: string; token: string }) {
  const auth = `Bearer ${token}`;
  const Field = CopyField;
  return (
    <div className="flex flex-col gap-3 text-[11px] text-muted">
      <Note warn>Copy these now: the token isn’t shown again (make a new one if you lose it).</Note>
      <Field label="Ask address" value={`${url}/api/phone/ask`} />
      <Field label="Share address" value={`${url}/api/phone/share`} />
      <Field label="Authorization" value={auth} />
      <div>
        <p className="m-0 mb-1 text-ink">“Hey Siri, Harv”</p>
        <ol className="m-0 list-decimal space-y-1 pl-5">
          <li>Shortcuts › + . Name it “Harv”.</li>
          <li>Add “Dictate Text”.</li>
          <li>
            Add “Get Contents of URL”: the Ask address, Method POST, Headers: <code>Authorization</code> = the Authorization value, Request
            Body JSON with a Text field <code>text</code> = Dictated Text.
          </li>
          <li>
            Add “Get Dictionary Value”: key <code>reply</code> in Contents of URL.
          </li>
          <li>Add “Speak Text”: Dictionary Value.</li>
          <li>Say “Hey Siri, Harv”, then what you want.</li>
        </ol>
      </div>
      <div>
        <p className="m-0 mb-1 text-ink">“Send to Harv” (share sheet)</p>
        <ol className="m-0 list-decimal space-y-1 pl-5">
          <li>Shortcuts › + . Name it “Send to Harv”. In its ⓘ details turn on “Show in Share Sheet” (Images, Files, URLs, Text).</li>
          <li>Optional: “Ask for Input” (Text, “Anything for Harv?”), then “URL Encode” on Provided Input.</li>
          <li>For photos: “Convert Image” Shortcut Input to JPEG (Harv can’t read iPhone HEIC photos).</li>
          <li>
            Add “Get Contents of URL”: the Share address followed by <code>?name=</code> + Shortcut Input’s Name (and{' '}
            <code>&amp;text=</code> + URL Encoded Text), Method POST, the same Authorization header, Request Body File = the (converted)
            input.
          </li>
          <li>Add “Show Notification”: “Sent to Harv”.</li>
        </ol>
        <p className="m-0 mt-1">With a note, Harv gets to work on it in the Phone chat. Without one it waits there for you.</p>
      </div>
    </div>
  );
}

function Projects() {
  const example = useExample('C:\\path\\to\\a\\project', '/path/to/a/project');
  const defaultRoot = useExample('your home\\Projects', 'your home/Projects');
  const { list, error } = useProjects();
  const { projectsDir } = useSettings();
  return (
    <Sub title="Projects">
      <Note>
        In a project chat Harv works like Claude Code in that folder. Say “let’s work on …”, or pick a project in a chat’s ≡ menu.
      </Note>
      <PathList
        items={list.map((p) => ({ key: p.id, title: `▣ ${p.name}`, path: p.path, label: `Forget ${p.name} (the folder and chats stay)` }))}
        onRemove={(id) => projectActions.remove(id)}
      />
      <AddPath id="harv-project-path" label="Project folder to add" placeholder={example} onAdd={(path) => projectActions.add(path)} />
      {error && <Note warn>{error}</Note>}
      <TextSetting
        id="harv-projects-dir"
        label="New ones in"
        value={projectsDir}
        placeholder={defaultRoot}
        onSave={(v) => updateSettings({ projectsDir: v })}
      />
    </Sub>
  );
}

const sizeText = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

/** This device's backups, biggest first, with "keep forever" (the cleanup skips kept ones; the user's wish for the car radio backup). */
function BackupList() {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [all, setAll] = useState(false);
  const load = () =>
    void fetch('/api/backups')
      .then((r) => r.json() as Promise<{ backups: BackupInfo[] }>)
      .then((r) => setBackups(r.backups))
      .catch(() => setBackups([]));
  useEffect(load, []);
  const keep = (name: string, kept: boolean) =>
    void fetch('/api/backups/keep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, keep: kept }),
    })
      .catch(() => {})
      .finally(load);
  if (!backups) return null;
  const total = backups.reduce((sum, b) => sum + b.bytes, 0);
  const kept = backups.filter((b) => b.kept);
  const bySize = [...backups].sort((a, b) => b.bytes - a.bytes);
  const shown = all ? bySize : [...kept, ...bySize.filter((b) => !b.kept).slice(0, 5)];
  const date = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const what = (b: BackupInfo) => {
    const first = b.originals[0]?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'backup';
    return b.originals.length > 1 ? `${first} +${b.originals.length - 1}` : first;
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Note>
        {backups.length} on this device, {sizeText(total)}
        {kept.length > 0 && `; ${kept.length} kept forever (${sizeText(kept.reduce((s, b) => s + b.bytes, 0))}, not counted in the limit)`}.
        Keep one and it’s never deleted.
      </Note>
      {shown.length > 0 && (
        <ul className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0 text-xs">
          {shown.map((b) => (
            <li key={b.name} className="flex min-w-0 items-center gap-2 rounded-lg bg-black/15 py-1 pr-1 pl-2.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate" title={b.originals.join('\n')}>
                  {what(b)}
                </span>
                <span className="truncate text-[11px] text-faint">
                  {date(b.at)} · {sizeText(b.bytes)}
                </span>
              </span>
              <button
                type="button"
                aria-pressed={b.kept}
                title={b.kept ? 'Kept forever. Click to let the cleanup delete it when it’s old.' : 'Keep this backup forever'}
                onClick={() => keep(b.name, !b.kept)}
                className={`flex-none cursor-pointer rounded border px-2 py-0.5 text-[11px] hover:bg-white/10 ${
                  b.kept ? 'border-accent/60 text-accent' : 'border-line text-muted'
                }`}
              >
                {b.kept ? 'kept' : 'keep'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {backups.length > shown.length || all ? (
        <button type="button" onClick={() => setAll(!all)} className="cursor-pointer self-start text-[11px] text-muted hover:text-ink">
          {all ? 'show fewer' : `show all ${backups.length}`}
        </button>
      ) : null}
    </div>
  );
}

/** Harv's scheduled tasks on this device: what runs when, in which chat, and Cancel. */
function ScheduledTasks() {
  const tasks = useSchedules();
  const { tabs } = useChat();
  const time = (ms: number) =>
    new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <Sub title="Scheduled tasks">
      <Note>
        Ask Harv in any chat (“every morning at 8 tell me the weather”, “check the build in an hour”). Each run is a turn in that chat, on
        this device while Harv is on; one missed while it was off runs once when it starts. Each run uses your plan.
      </Note>
      {tasks.length === 0 ? (
        <Note>Nothing scheduled.</Note>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-xs">
              <span className="text-accent">⏰</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink" title={t.prompt}>
                  {t.title}
                </span>
                <span className="block truncate text-[11px] text-faint">
                  {whenText(t)} · next {t.nextAt ? time(t.nextAt) : '—'} · in “{tabs.find((x) => x.id === t.tabId)?.title ?? 'its chat'}”
                </span>
              </span>
              <button
                type="button"
                onClick={() => cancelSchedule(t.id)}
                className="flex-none cursor-pointer rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-white/10 hover:text-warn"
              >
                cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sub>
  );
}

/** Pictures from Gemini: signing Harv's own Chrome profile in to the Google account kept for it (docs/PLAN.md §6w). */
function Pictures() {
  const [status, setStatus] = useState<string | null>(null);
  const open = async () => {
    setStatus('Opening…');
    try {
      const res = await fetch('/api/gemini/signin', { method: 'POST' });
      const body = (await res.json()) as { error?: string };
      setStatus(res.ok ? 'Sign in in the Chrome window, then close it.' : (body.error ?? 'Couldn’t open Chrome.'));
    } catch {
      setStatus('Couldn’t reach the Harv server.');
    }
  };
  return (
    <Sub title="Pictures">
      <Note>
        Ask Harv for a picture in any chat and Gemini makes it, on the Google account you sign in with here (once per computer, in a Chrome
        window of Harv’s own). The free Gemini app has a daily limit.
      </Note>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void open()}
          className="cursor-pointer rounded-lg border border-accent/50 px-3 py-1.5 text-xs text-accent hover:bg-accent/15"
        >
          Sign in to Gemini
        </button>
        {status && <span className="text-xs text-muted">{status}</span>}
      </div>
    </Sub>
  );
}

/** Settings › Devices: the Tapo account login for the user's lights (docs/PLAN.md §6z). The password only goes to the server. */
function TapoLogin() {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/devices')
      .then((r) => r.json() as Promise<{ tapoEmail: string | null }>)
      .then((d) => setSaved(d.tapoEmail))
      .catch(() => setSaved(null));
  }, []);
  const send = async (body: { email: string | null; password?: string }) => {
    setStatus('Saving…');
    try {
      const res = await fetch('/api/devices/tapo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { tapoEmail?: string | null; error?: string };
      if (!res.ok) return setStatus(data.error ?? 'Couldn’t save it.');
      setSaved(data.tapoEmail ?? null);
      setPassword('');
      setStatus(body.email ? 'Saved.' : 'Removed.');
    } catch {
      setStatus('Couldn’t reach the Harv server.');
    }
  };
  return (
    <Sub title="Tapo lights">
      <Note>
        The login of your Tapo app account: Harv controls your light strip on the home Wi-Fi with it (no cloud). It stays in a file on this
        computer that Harv’s chats can never read.
      </Note>
      {saved && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted">Signed in as</span>
          <span className="min-w-0 truncate text-ink">{saved}</span>
          <button type="button" className={BUTTON} onClick={() => void send({ email: null })}>
            Remove
          </button>
        </div>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ email, password });
        }}
      >
        <label className={ROW}>
          <span className={LABEL}>Email</span>
          <input
            className={INPUT}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={saved ?? 'you@example.com'}
          />
        </label>
        <label className={ROW}>
          <span className={LABEL}>Password</span>
          <input
            className={INPUT}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" className={BUTTON} disabled={!email.trim() || !password}>
            {saved ? 'Change login' : 'Save login'}
          </button>
          {status && <span className="text-xs text-muted">{status}</span>}
        </div>
      </form>
    </Sub>
  );
}

/** The photo: preview, choose, remove. */
function PhotoPicker() {
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
    <>
      <div className="flex items-center gap-3">
        <div
          aria-hidden="true"
          className="h-14 w-24 flex-none rounded-lg border border-line bg-ground bg-cover bg-center"
          style={{ backgroundImage: version ? `url(/api/background?v=${version})` : undefined }}
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => input.current?.click()} className={BUTTON}>
            {version ? 'Change photo…' : 'Choose photo…'}
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
      <Note>{status ?? 'JPEG, PNG or WebP up to 20 MB. It stays on your devices.'}</Note>
    </>
  );
}

/** Settings › Appearance › Background: photo, see-through (the app) or plain, and what each one takes. */
function Background() {
  const settings = useSettings();
  const onWindows = useConnection().platform === 'windows';
  // In a browser see-through can't work, so the photo shows: say so instead of hiding the choice.
  const shown = settings.backdrop === 'seeThrough' && !inApp ? 'photo' : settings.backdrop;
  return (
    <Sub title="Background">
      <Choice
        label="Show"
        value={settings.backdrop}
        options={[
          { value: 'photo', label: 'Photo' },
          { value: 'seeThrough', label: 'See-through' },
          { value: 'plain', label: 'Plain' },
        ]}
        onChange={(backdrop) => updateSettings({ backdrop })}
      />
      {settings.backdrop === 'seeThrough' && !inApp && <Note>See-through works in the Harv app; this browser window shows the photo.</Note>}
      {shown === 'photo' && (
        <>
          <PhotoPicker />
          <Slider
            label="Photo blur"
            value={settings.backgroundBlur}
            min={0}
            max={30}
            unit="px"
            onChange={(backgroundBlur) => updateSettings({ backgroundBlur })}
          />
        </>
      )}
      {shown === 'seeThrough' &&
        (onWindows ? (
          <Toggle
            on={settings.frost}
            label="Frost what’s behind"
            hint="Off is clear glass. Windows has one frost strength."
            onChange={(frost) => updateSettings({ frost })}
          />
        ) : (
          <Note>Your desktop shows behind Harv. KDE can’t frost it for an app yet.</Note>
        ))}
      {shown !== 'plain' && (
        <Slider
          label="Darkness"
          value={settings.scrim}
          min={0}
          max={90}
          step={5}
          unit="%"
          onChange={(scrim) => updateSettings({ scrim })}
        />
      )}
      <Note>Only on this device{shown === 'photo' ? '; the photo itself syncs' : ''}.</Note>
    </Sub>
  );
}

/** Settings › Watchdog: on/off and the programs it ignores (alerts show as toasts, not here). */
function Watchdog() {
  const { watchdog, watchdogIgnored } = useSettings();
  const onWindows = useConnection().platform === 'windows';
  return (
    <Sub title="Watchdog">
      <Toggle
        on={watchdog}
        label="Watch my PC"
        hint={
          onWindows
            ? 'Warns about overheating, hidden programs hogging the CPU or GPU, Windows Defender threats, miners and remote-control tools. No Claude usage.'
            : 'Warns about overheating, miners, remote-control tools and programs from /tmp that keep working. No Claude usage.'
        }
        onChange={(on) => updateSettings({ watchdog: on })}
      />
      {watchdogIgnored.length > 0 && (
        <div className={ROW}>
          <span className={LABEL}>Never warns about</span>
          <div className="flex flex-1 flex-wrap gap-1.5">
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
        </div>
      )}
    </Sub>
  );
}

function ProtectedFolders() {
  const example = useExample('C:\\Users\\you\\Documents\\Taxes', '/home/you/Documents/Taxes');
  const { protectedPaths } = useSettings();
  return (
    <Sub title="Read-only folders">
      <Note>Harv can read these but never change, move or delete anything inside them.</Note>
      <PathList
        items={protectedPaths.map((p) => ({ key: p, path: p, label: `Remove ${p}` }))}
        onRemove={(p) => updateSettings({ protectedPaths: protectedPaths.filter((x) => x !== p) })}
      />
      <AddPath
        id="harv-protect"
        label="Folder to protect"
        placeholder={example}
        onAdd={(path) => updateSettings({ protectedPaths: [...protectedPaths, path] })}
      />
    </Sub>
  );
}

/** Harv's settings, shown as a tab in the chat bar. Saved in ~/.harv/settings.json and applied at once in every window. */
export function SettingsView() {
  const settings = useSettings();
  const onWindows = useConnection().platform === 'windows';
  const lookChanged = LOOK_KEYS.some((k) => settings[k] !== DEFAULT_SETTINGS[k]);
  const resetLook = () => updateSettings(Object.fromEntries(LOOK_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])) as Partial<HarvSettings>);

  return (
    // Big sections, one under the other; their subsections flow in two columns when there's room (the user's wish, 2026-10-27).
    <div className="animate-fade-in mx-auto flex w-full max-w-[1000px] flex-col gap-4">
      <p className="m-0 px-1 text-xs text-muted">
        Changes apply at once in every Harv window. With Sync on, most of them follow you to your other devices; folders, size, background
        and startup stay on this one.
      </p>

      <Group title="Appearance">
        <Sub title="Theme">
          <div role="radiogroup" aria-label="Accent colour" className={ROW}>
            <span className={LABEL}>Accent</span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
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
        </Sub>
        <Sub title="Glass panels">
          <Slider
            label="Opacity"
            value={settings.glass}
            min={20}
            max={95}
            step={5}
            unit="%"
            onChange={(glass) => updateSettings({ glass })}
          />
          <Slider
            label="Frost"
            value={settings.glassBlur}
            min={0}
            max={40}
            unit="px"
            onChange={(glassBlur) => updateSettings({ glassBlur })}
          />
          <Note>How see-through the panels are, and how much they blur what’s behind them.</Note>
          {lookChanged && (
            <button
              type="button"
              onClick={resetLook}
              className="cursor-pointer self-start rounded px-1 text-[11px] text-muted hover:text-accent"
            >
              Reset the whole look to default
            </button>
          )}
        </Sub>
        <Background />
      </Group>

      <Group title="Chat">
        <Sub title="Messages">
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
          <Note>{settings.sendKey === 'enter' ? 'Shift+Enter makes a new line.' : 'Enter makes a new line.'}</Note>
        </Sub>
        <Sub title="AUTO">
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
            hint="AUTO may use Fable for the hardest tasks and as the top of Try harder. You can always pick it by hand."
            onChange={(allowFable) => updateSettings({ allowFable })}
          />
        </Sub>
      </Group>

      <Group title="Stats & usage">
        <Sub title="Stats panel">
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
              { value: 3000, label: '3 s' },
              { value: 5000, label: '5 s' },
            ]}
            onChange={(metricsMs) => updateSettings({ metricsMs })}
          />
        </Sub>
        <Sub title="Usage warnings">
          <Note>A note pops up when your Claude plan use crosses these marks. Turn them all off for no warnings.</Note>
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
        </Sub>
      </Group>

      <Group
        title="Safety"
        hint="Blocked things (formatting drives, the system folders, turning off antivirus, stored passwords) always stay blocked."
      >
        <Sub title="Approvals">
          <Toggle
            on={settings.askRisky}
            label="Ask before risky actions"
            hint="Deleting, installing, stopping programs, system changes, sending data. Off: they run right away, backed up and logged with Undo."
            onChange={(askRisky) => updateSettings({ askRisky })}
          />
          <Toggle
            on={settings.confirmYellow}
            label="Ask before changing my files too"
            hint="Off: Harv backs up and changes your files right away, and you can Undo."
            onChange={(confirmYellow) => updateSettings({ confirmYellow })}
          />
          {/* The rules only matter while cards are on. */}
          {settings.askRisky && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs">Don’t ask again for</span>
              {settings.allowRules.length === 0 ? (
                <Note>Nothing yet. “Don’t ask again” on an approval card adds the kind of command here.</Note>
              ) : (
                <PathList
                  items={settings.allowRules.map((rule) => ({ key: rule, path: `${rule} …`, label: `Ask again for ${rule}` }))}
                  onRemove={(rule) => updateSettings({ allowRules: settings.allowRules.filter((x) => x !== rule) })}
                />
              )}
            </div>
          )}
        </Sub>
        <Sub title="Backups">
          <Note>Every change Harv makes is backed up first, so Undo can bring it back. Older backups are deleted, oldest first.</Note>
          <Slider
            label="Keep for"
            value={settings.backupDays}
            min={7}
            max={180}
            unit=" days"
            onChange={(backupDays) => updateSettings({ backupDays })}
          />
          <Slider
            label="At most"
            value={settings.backupMaxGb}
            min={1}
            max={50}
            unit=" GB"
            onChange={(backupMaxGb) => updateSettings({ backupMaxGb })}
          />
          <BackupList />
        </Sub>
        <ProtectedFolders />
      </Group>

      <Group title="Folders & projects">
        <WorkFolder />
        <Projects />
      </Group>

      <Group title="This computer" hint="These stay on this device.">
        <Sub title="Startup">
          <Toggle
            on={settings.restoreTabs}
            label="Reopen tabs"
            hint="After a restart, bring back the tabs, their files and terminals, and unsent messages."
            onChange={(restoreTabs) => updateSettings({ restoreTabs })}
          />
          {onWindows && (
            <Toggle
              on={settings.startSensors}
              label="Start the hardware sensors"
              hint="Starts LibreHardwareMonitor with Harv (Windows asks first). Off: no temperatures or fans until you press Start sensors."
              onChange={(startSensors) => updateSettings({ startSensors })}
            />
          )}
          <RestartButton />
        </Sub>
        <ScheduledTasks />
        <Pictures />
        <Watchdog />
        {inApp && <AppSection />}
      </Group>

      {!isPhone && (
        <Group title="Devices" hint="Smart-home devices Harv controls.">
          <TapoLogin />
        </Group>
      )}

      <Group title="Sync">
        <Sync />
      </Group>

      <Group title="Phone" hint={isPhone ? 'This phone.' : 'Harv on your iPhone, over Tailscale. Per device.'}>
        {isPhone ? <ThisPhoneSettings /> : <PhoneAccessSettings />}
      </Group>
    </div>
  );
}
