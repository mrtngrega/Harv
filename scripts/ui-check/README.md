# UI checks

Small scripts for looking at the running dashboard the way a person would, without touching the user's own browser. They drive a separate headless Chrome (its own profile in `out/`) over the DevTools protocol (`cdp.mjs`, using the `ws` package already in the repo). Screenshots land in `out/shots/` (gitignored); open them to look.

| Script | What it does |
|---|---|
| `node scripts/ui-check/shots.mjs [widths…]` | Screenshots at 420/1100/1280/1500px (or the widths given), stats panel collapsed and expanded; reports sideways overflow and a page that scrolled by itself. |
| `node scripts/ui-check/watch-shifts.mjs [width] [seconds]` | Watches the stats panel while values tick and reports vertical layout shifts. |
| `node scripts/ui-check/usage.mjs` | Prints the Claude plan meters Harv knows (no tokens). |
| `bash scripts/ui-check/battery.sh <label>` | Linux: 10 s average CPU of the Harv app and its WebKit process, and GPU busy %. Change one setting between runs to see what costs battery (docs/PLAN.md §6p "Battery"). |
| `node scripts/ui-check/busy.mjs` | Is a chat replying? Exit 0 when Harv is idle: check before a restart (no tokens). |
| `node scripts/ui-check/phone.mjs` | Phone access status and the paired phones (docs/PLAN.md §6q; no tokens). |
| `node scripts/ui-check/phone-e2e.mjs [--ask] [--keep]` | The phone end to end over the real `tailscale serve` address: an emulated iPhone pairs (code read from the PC), makes a passkey with a virtual authenticator, opens the phone layout and Settings, makes a Shortcut token, shares a picture, then is removed again. `--ask` also asks Siri's endpoint one question (one small turn). |
| `node scripts/ui-check/sync.mjs [--now \| --on <repo> [--name <device>] \| --off]` | Sync status with the other devices; can sync now or turn it on/off (no tokens). |

For a custom check, import `launch` from `cdp.mjs`: `goto`, `click(selector, text?)`, `type`, `key`, `eval`, `shot(name)`, `logs`.

Notes:
- The dashboard's layout is shared with the user's open window (it's saved on the server), so a check that opens tabs or changes views should close what it opened.
- `click` calls `scrollIntoView` on its target; the app root is `overflow-clip`, so that can't shift the page any more.
- Checks that send messages to Harv use the user's plan; prefer Haiku·low and say so.
- Works on Windows and Linux: it finds Chrome (or Chromium) itself; `HARV_CHROME=/path/to/chrome` picks another.
