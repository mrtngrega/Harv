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
let fallback = 0;

// Hidden rather than removed: the phone puts it back over the dashboard after Face ID (coverBoot).
function lift(motion: boolean) {
  if (lifted) return;
  lifted = true;
  window.clearTimeout(fallback);
  const el = document.getElementById('boot');
  if (!el) return;
  const hide = () => {
    if (lifted) el.style.display = 'none';
  };
  if (!motion) {
    hide();
    return;
  }
  el.style.opacity = '0';
  window.setTimeout(hide, 250);
}

/** The phone's pairing and Face ID screens show without the cover. */
export function liftBoot() {
  lift(false);
}

/**
 * The phone, once unlocked: the cover goes back over the dashboard until it's ready, as on the
 * computer (the glass showed blue for a moment while the settings and the photo came in).
 */
export function coverBoot() {
  if (!lifted) return;
  lifted = false;
  const el = document.getElementById('boot');
  if (el) {
    // At once, not faded in (the fade is for going).
    el.style.transition = 'none';
    el.style.display = '';
    el.style.opacity = '1';
    void el.offsetHeight;
    el.style.transition = '';
  }
  fallback = fallback = window.setTimeout(() => lift(true), MAX_MS);
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

fallback = window.setTimeout(() => lift(true), MAX_MS);
