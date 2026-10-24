# UI checks

Small scripts for looking at the running dashboard the way a person would, without touching the user's own browser. They drive a separate headless Chrome (its own profile in `out/`) over the DevTools protocol (`cdp.mjs`, using the `ws` package already in the repo). Screenshots land in `out/shots/` (gitignored); open them to look.

| Script | What it does |
|---|---|
| `node scripts/ui-check/shots.mjs [widths…]` | Screenshots at 420/1100/1280/1500px (or the widths given), stats panel collapsed and expanded; reports sideways overflow and a page that scrolled by itself. |
| `node scripts/ui-check/watch-shifts.mjs [width] [seconds]` | Watches the stats panel while values tick and reports vertical layout shifts. |
| `node scripts/ui-check/usage.mjs` | Prints the Claude plan meters Harv knows (no tokens). |

For a custom check, import `launch` from `cdp.mjs`: `goto`, `click(selector, text?)`, `type`, `key`, `eval`, `shot(name)`, `logs`.

Notes:
- The dashboard's layout is shared with the user's open window (it's saved on the server), so a check that opens tabs or changes views should close what it opened.
- `click` calls `scrollIntoView` on its target; the app root is `overflow-clip`, so that can't shift the page any more.
- Checks that send messages to Harv use the user's plan; prefer Haiku·low and say so.
