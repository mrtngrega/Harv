# Checking Harv's own UI

The user uses **only the Harv app**, not the web dashboard in a browser: every change is checked in the app. The scripts live in `scripts/ui-check/` of the Harv repo (its README lists them all).

- **Attach to the app**: if it isn't already running with a debugging port, start it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444` (9444 is the habit; `launch()` in `cdp.mjs` uses 9333 for its own headless Chrome) and drive it with `attach()` from `scripts/ui-check/cdp.mjs`. Restarting the app closes the user's window: say so first, and avoid it while they use it.
- **Ready-made checks**: `app-look.mjs` (screenshots), `app-chat.mjs <port> <name> "<message>"…` (sends messages and clicks; Haiku·low only; in Git Bash `MSYS_NO_PATHCONV=1`), `app-tabs.mjs`, `app-startup.mjs`, `app-pass.mjs`, `status-line.mjs`, `shots.mjs [widths]` and `watch-shifts.mjs [width] [seconds]` (headless dashboard), `phone-e2e.mjs` (the phone end to end, emulated iPhone).
- **Sizes**: the user often keeps the app minimized: use `Emulation.setDeviceMetricsOverride` at 420/1100/1280/1500 and clear it afterwards.
- **The browser view**: its pages are child webviews that CDP screenshots leave out: capture the window with PrintWindow.
- **The notebook** (Fedora, WebKitGTK, over Tailscale SSH): `spectacle -b -n -f -o <file>` for a screenshot, `scripts/ui-check/send.mjs` to send a message.
- **Shared layout**: tabs and views are shared by every window of a Harv (and synced to the other computer). Close test tabs and delete test chats afterwards (`scripts/ui-check/out/delete-chats.cjs <id>`).
- **Plan usage**: anything that sends a message costs plan usage: Haiku·low unless the check needs more, and say so.
- **After a restart**: every chat asks "Continue / New session" once per server start: answer or expect it in screenshots.
