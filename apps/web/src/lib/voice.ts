import { createStore } from './createStore.ts';
import { onServerMessage } from './socket.ts';

// Voice mode on the phone (docs/PLAN.md §6q): listen with the browser's speech recognition, send it
// as a spoken turn, read Harv's reply aloud sentence by sentence as it streams, then listen again.
// Free: Safari's own speech recognition and voices; no audio leaves for any paid service.

export type VoiceStage = 'off' | 'listening' | 'waiting' | 'speaking';

interface VoiceState {
  stage: VoiceStage;
  /** The chat voice mode talks in. */
  tabId: string | null;
  /** What's been heard so far (shown while listening). */
  heard: string;
  /** No speech recognition here: the keyboard's dictation mic is the way. */
  noRecognition: boolean;
  error: string;
}

const store = createStore<VoiceState>({ stage: 'off', tabId: null, heard: '', noRecognition: false, error: '' });
export const useVoice = store.use;

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionClass(): (new () => Recognition) | null {
  // On the iPhone, Safari's recognition asked for permission and then froze the Home Screen app
  // (2026-10-29): the keyboard's own dictation mic does the listening there instead.
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Markdown and code read badly aloud: plain words only. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code in the chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole sentences at the start of `text` (to speak now) and the rest (still coming). */
export function splitSentences(text: string): { done: string; rest: string } {
  const m = /^[\s\S]*[.!?…:](?=\s)/.exec(text);
  if (!m) return { done: '', rest: text };
  return { done: m[0], rest: text.slice(m[0].length) };
}

let recognition: Recognition | null = null;
let send: ((text: string) => void) | null = null;
/** What Harv said so far in the current reply (deltas), and how much of it was spoken. */
let buffer = '';
let spoken = 0;
let speaking = 0;
let turnDone = false;

const set = (patch: Partial<VoiceState>) => store.set((s) => ({ ...s, ...patch }));

function say(text: string) {
  const words = speakable(text);
  if (!words || typeof speechSynthesis === 'undefined') return;
  const u = new SpeechSynthesisUtterance(words);
  u.lang = navigator.language || 'en-US';
  speaking++;
  set({ stage: 'speaking' });
  u.onend = u.onerror = () => {
    speaking = Math.max(0, speaking - 1);
    afterSpeech();
  };
  speechSynthesis.speak(u);
}

/** Harv finished talking and the turn is over: listen again. */
function afterSpeech() {
  const s = store.get();
  if (s.stage === 'off' || speaking > 0) return;
  if (turnDone) listen();
  else set({ stage: 'waiting' });
}

function listen() {
  const s = store.get();
  if (s.stage === 'off') return;
  const Rec = recognitionClass();
  if (!Rec) {
    set({ stage: 'listening', noRecognition: true, heard: '' });
    return;
  }
  recognition?.abort();
  const rec = new Rec();
  recognition = rec;
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) finalText += r[0]!.transcript;
      else interim += r[0]!.transcript;
    }
    set({ heard: (finalText + interim).trim() });
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    set({
      error:
        e.error === 'not-allowed'
          ? 'Harv may not use the microphone: allow it in the phone’s Settings › Safari.'
          : `Listening stopped: ${e.error}`,
    });
  };
  rec.onend = () => {
    if (recognition !== rec || store.get().stage !== 'listening') return;
    const text = finalText.trim();
    if (!text) {
      // Heard nothing: stay in voice mode, but stop listening until the next tap.
      set({ heard: '' });
      recognition = null;
      return;
    }
    heard(text);
  };
  set({ stage: 'listening', heard: '', error: '', noRecognition: false });
  try {
    rec.start();
  } catch {
    set({ error: 'The microphone didn’t start. Tap the mic again.' });
  }
}

/** Sends what was heard as a spoken turn. */
function heard(text: string) {
  recognition = null;
  buffer = '';
  spoken = 0;
  turnDone = false;
  set({ stage: 'waiting', heard: text });
  send?.(text);
}

/**
 * Starts voice mode in a chat (from a tap, which iOS needs for the mic and for speech). `sendFn`
 * sends a spoken turn there. `greeting` is said first ("Harv wants to talk" from a notification).
 */
export function startVoice(tabId: string, sendFn: (text: string) => void, greeting?: string) {
  send = sendFn;
  turnDone = true;
  set({ stage: 'waiting', tabId, heard: '', error: '' });
  // iOS lets a page speak only after it spoke inside a tap once.
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  if (greeting) say(greeting);
  else listen();
}

/** Tap while listening: done talking; tap while Harv speaks: stop it and listen. */
export function tapVoice() {
  const s = store.get();
  if (s.stage === 'listening') {
    if (recognition) recognition.stop();
    else listen();
  } else if (s.stage === 'speaking') {
    speechSynthesis.cancel();
    speaking = 0;
    turnDone = true;
    listen();
  } else if (s.stage === 'waiting' && turnDone) listen();
}

/** Typed (keyboard dictation, where there's no recognition) instead of heard. */
export function sendHeard(text: string) {
  if (text.trim()) heard(text.trim());
}

export function stopVoice() {
  recognition?.abort();
  recognition = null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  speaking = 0;
  set({ stage: 'off', tabId: null, heard: '', error: '' });
}

onServerMessage((msg) => {
  const s = store.get();
  if (s.stage === 'off' || !('tabId' in msg) || msg.tabId !== s.tabId) return;
  if (msg.type === 'chat.delta') {
    buffer += msg.text;
    const { done } = splitSentences(buffer.slice(spoken));
    if (done) {
      spoken += done.length;
      say(done);
    }
  } else if (msg.type === 'chat.assistant') {
    // The message is complete: say what's left of it.
    const rest = msg.text.length > spoken ? msg.text.slice(spoken) : buffer.slice(spoken);
    buffer = '';
    spoken = 0;
    if (rest.trim()) say(rest);
  } else if (msg.type === 'chat.done') {
    turnDone = true;
    if (msg.error) say(`Something went wrong: ${msg.error}`);
    afterSpeech();
  }
});
