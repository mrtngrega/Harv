import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ACCENTS } from '@harv/shared';
import { updateSettings, useBackground, useSettings } from '../lib/useHarvSocket.ts';

const ACCENT_NAMES: Record<string, string> = {
  '#A8C8E8': 'Ice blue',
  '#9FE0C4': 'Mint',
  '#F2B880': 'Amber',
  '#C9B8F0': 'Lavender',
};

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
        {status ?? 'JPEG, PNG or WebP up to 20 MB. It stays on this PC (in ~/.harv), blurred behind the dashboard.'}
      </p>
    </Section>
  );
}

function ProtectedFolders() {
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
          placeholder="C:\Users\you\Documents\Taxes"
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
        />
        <button type="submit" className="min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs hover:bg-white/10">
          Add
        </button>
      </form>
    </Section>
  );
}

/** Harv's settings, shown as a tab in the chat bar: look and feel, the background photo, AUTO, and read-only folders. Saved in ~/.harv/settings.json. */
export function SettingsView() {
  const settings = useSettings();

  return (
    <div className="animate-fade-in mx-auto grid w-full max-w-[860px] grid-cols-1 content-start gap-2.5 md:grid-cols-2">
      <p className="m-0 px-1 text-xs text-muted md:col-span-2">
        Saved on this PC in ~/.harv/settings.json. Changes apply at once in every Harv window.
      </p>

      <Section title="Look">
        <Toggle
          on={settings.motion}
          label="Animations"
          hint="Subtle fades, pulses and bars. Off keeps everything still."
          onChange={(motion) => updateSettings({ motion })}
        />
        <div role="radiogroup" aria-label="Accent colour" className="flex items-center gap-2 pt-1 text-xs">
          <span className="mr-1 text-muted">Accent</span>
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
        </div>
      </Section>

      <BackgroundPicker />

      <Section title="AUTO">
        <Toggle
          on={settings.allowFable}
          label="Allow Fable 5.1"
          hint="Lets AUTO use Fable for the hardest tasks and as the top of Try harder. It's always available as a manual pick."
          onChange={(allowFable) => updateSettings({ allowFable })}
        />
      </Section>

      <ProtectedFolders />
    </div>
  );
}
