import { useState } from 'react';
import { chat } from '../../lib/chatStore.ts';
import { sendHeard, startVoice, stopVoice, tapVoice, useVoice } from '../../lib/voice.ts';

// Voice mode's bar above the phone's input (docs/PLAN.md §6q): what Harv hears, when it thinks,
// when it talks; a tap to finish talking or to cut Harv short, × to leave voice mode.

/** Starts voice mode in the active chat (needs a tap: iOS asks for the mic and speech then). */
export function startVoiceHere(greeting?: string) {
  const tabId = chat.ensureTab();
  startVoice(tabId, (text) => chat.send(text, [], true), greeting);
}

export function MicButton() {
  const { stage } = useVoice();
  return (
    <button
      type="button"
      onClick={() => (stage === 'off' ? startVoiceHere() : tapVoice())}
      aria-label={stage === 'off' ? 'Talk to Harv' : 'Voice mode'}
      aria-pressed={stage !== 'off'}
      className={`grid min-h-11 min-w-11 cursor-pointer place-items-center rounded-[10px] border text-base ${
        stage === 'off' ? 'border-[rgb(220_232_245/0.2)] bg-white/5 text-ink' : 'border-accent/60 bg-accent/20 text-accent'
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
        <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function VoiceBar() {
  const { stage, heard, noRecognition, error } = useVoice();
  const [typed, setTyped] = useState('');
  if (stage === 'off') return null;
  const label =
    stage === 'listening'
      ? noRecognition
        ? 'Use the keyboard’s mic, then send'
        : heard
          ? 'Listening… tap when done'
          : 'Listening…'
      : stage === 'waiting'
        ? 'Harv is thinking…'
        : 'Harv is talking · tap to cut in';
  return (
    <div className="mx-3 mb-2 flex flex-col gap-2 rounded-xl border border-accent/40 bg-[rgb(16_24_34/0.92)] px-3 py-2.5 text-xs">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={tapVoice}
          aria-label={label}
          className={`grid size-10 flex-none cursor-pointer place-items-center rounded-full ${
            stage === 'listening'
              ? 'animate-pulse-ring bg-accent/30 text-accent'
              : stage === 'speaking'
                ? 'bg-ok/25 text-ok'
                : 'bg-white/10 text-muted'
          }`}
        >
          {stage === 'speaking' ? '◖◗' : stage === 'waiting' ? '…' : '●'}
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-ink">{label}</span>
          {heard && <span className="truncate text-faint">“{heard}”</span>}
        </div>
        <button
          type="button"
          onClick={stopVoice}
          aria-label="Leave voice mode"
          className="size-8 flex-none cursor-pointer rounded-md text-muted hover:bg-white/10"
        >
          ×
        </button>
      </div>
      {stage === 'listening' && noRecognition && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            sendHeard(typed);
            setTyped('');
          }}
        >
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="What you said"
            placeholder="Tap the keyboard’s mic and talk"
            className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-black/30 px-2.5 text-sm text-ink outline-none focus:border-accent/60"
          />
          <button type="submit" className="min-h-10 rounded-lg bg-accent px-3 font-semibold text-[#0f1620]">
            Send
          </button>
        </form>
      )}
      {error && <span className="text-warn">{error}</span>}
    </div>
  );
}
