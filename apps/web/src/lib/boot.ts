/**
 * The boot cover (#boot in index.html) looks like the app's starting page and stays until the
 * dashboard is really ready: the server's hello (settings, so the colours are right), the restored
 * layout, the fonts and the background photo. Only then does it go, so starting the app shows no
 * background blinking or colours loading (the user's wish). A slow or missing server lifts it
 * anyway after MAX_MS, and the dashboard shows its own offline state.
 */
const MAX_MS = 8000;
const PHOTO_MS = 3000;

let lifted = false;

function lift(motion: boolean) {
  if (lifted) return;
  lifted = true;
  const el = document.getElementById('boot');
  if (!el) return;
  if (!motion) return el.remove();
  el.style.opacity = '0';
  window.setTimeout(() => el.remove(), 250);
}

/** Resolves when the photo is loaded and decoded (or failed, or took too long). */
function photoLoaded(url: string): Promise<void> {
  const img = new Image();
  img.src = url;
  return Promise.race([img.decode().catch(() => {}), new Promise<void>((r) => window.setTimeout(r, PHOTO_MS))]);
}

/** Two frames, so React has painted what it just rendered before the cover goes. */
const painted = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** Called by App once the hello and the layout are in; `photo` is the background's URL, if one shows. */
export function revealWhenReady(photo: string | null, motion: boolean) {
  if (lifted) return;
  void Promise.all([document.fonts.ready, photo ? photoLoaded(photo) : null])
    .then(painted)
    .then(() => lift(motion));
}

window.setTimeout(() => lift(true), MAX_MS);
