import { answerStart } from '../lib/chatStore.ts';

/**
 * A chat from before Harv started asks, inside its own tab, whether to continue
 * its session with Claude or start a new one. Only that chat's area is blurred:
 * the other tabs and the rest of the dashboard stay usable, and it waits until
 * the user opens the chat and answers.
 *
 * Readable without blur: inside the chat panel's own glass the overlay's backdrop blur doesn't
 * take (nested backdrop-filter), so the chat showed sharp through a card that follows the user's
 * panel opacity (the test pass, 2026-10-31). A firm dim and a nearly solid card instead.
 */
export function StartChoice({ tabId, title }: { tabId: string; title: string }) {
  const name = title.trim() || 'this chat';
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="start-choice-title"
      className="animate-fade-in absolute inset-0 z-20 flex items-center justify-center bg-[rgb(10_16_24/0.62)] p-4 backdrop-blur-md"
    >
      <div className="w-full max-w-md rounded-2xl border border-[rgb(220_232_245/0.2)] bg-[rgb(16_24_34/0.94)] p-6 text-center shadow-[0_16px_48px_rgb(0_0_0/0.45)]">
        <h2 id="start-choice-title" className="text-sm text-white">
          Continue “{name}”?
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Keep this chat’s session with Claude, or start a new one. A new session opens a blank chat here; this one stays in history.
        </p>
        <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
          <button
            type="button"
            autoFocus
            onClick={() => answerStart(tabId, 'continue')}
            className="flex-1 cursor-pointer rounded-lg border border-accent/60 bg-accent/15 px-4 py-2.5 text-sm text-accent hover:bg-accent/25"
          >
            Continue session
          </button>
          <button
            type="button"
            onClick={() => answerStart(tabId, 'new')}
            className="flex-1 cursor-pointer rounded-lg border border-[rgb(220_232_245/0.2)] bg-white/5 px-4 py-2.5 text-sm text-ink hover:bg-white/10"
          >
            New session
          </button>
        </div>
      </div>
    </div>
  );
}
