import type { Attachment, UiState } from '@harv/shared';
import { getChatState, layoutRestored, onLayoutRestore, subscribeChat } from './chatStore.ts';
import { getDrafts, getDraftTexts, restoreDrafts, subscribeDrafts } from './drafts.ts';
import { sendMessage } from './socket.ts';

// The dashboard's layout is saved on the server (~/.harv/ui.json) so it comes back
// after a restart, like Chrome's tabs: tabs and their order, which one was showing,
// each chat's tools and explorer folder, and unsent drafts.

/** Where each chat's file explorer is. */
export const explorerPaths = new Map<string, string>();

function snapshot(): UiState {
  const s = getChatState();
  const ids = new Set(s.tabs.map((t) => t.id));
  const keep = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)));
  const files: Record<string, Attachment[]> = {};
  for (const [id, list] of Object.entries(getDrafts())) {
    const ready = list.flatMap((p) => (p.file ? [p.file] : []));
    if (ready.length) files[id] = ready;
  }
  return {
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    order: s.tabs.map((t) => t.id),
    // Chats with no messages exist only here until the first send.
    blanks: s.tabs.filter((t) => !t.stored).map((t) => t.id),
    tools: keep(s.tools),
    views: keep(s.views),
    explorer: keep(Object.fromEntries(explorerPaths)),
    drafts: keep(getDraftTexts()),
    attachments: keep(files),
  };
}

let timer: number | undefined;
let lastSaved = '';

function flush() {
  window.clearTimeout(timer);
  // Before the saved layout is back, saving would overwrite it with the empty start.
  if (!layoutRestored()) return;
  const state = snapshot();
  const json = JSON.stringify(state);
  if (json !== lastSaved && sendMessage({ type: 'ui.save', state })) lastSaved = json;
}

/** Saves the layout shortly (changes come in bursts, e.g. while Harv streams). */
export function saveLayoutSoon(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, 400);
}

subscribeChat(saveLayoutSoon);
subscribeDrafts(saveLayoutSoon);
window.addEventListener('pagehide', flush);

onLayoutRestore((ui) => {
  for (const [id, path] of Object.entries(ui.explorer)) if (!explorerPaths.has(id)) explorerPaths.set(id, path);
  restoreDrafts(ui.drafts, ui.attachments);
});

// Coming back to the dashboard (from the other device, say) syncs right away, not within 2 minutes.
let lastReturnSync = 0;
function syncOnReturn() {
  if (document.visibilityState !== 'visible' || Date.now() - lastReturnSync < 30_000) return;
  lastReturnSync = Date.now();
  sendMessage({ type: 'sync.now' });
}
window.addEventListener('focus', syncOnReturn);
document.addEventListener('visibilitychange', syncOnReturn);
