# Driving and capturing a UI

## Web pages and web projects

- **Playwright** (in the project, `npx playwright test` or a small script): real Chromium, Firefox and WebKit; `page.setViewportSize`, `page.screenshot({ fullPage })`, `page.emulateMedia({ colorScheme, reducedMotion })`, device presets for phones (`devices['iPhone 13']`). Best for repeatable flows.
- **Chrome over the DevTools protocol** (CDP) for a quick look without a test setup: start Chrome with `--remote-debugging-port=<port> --user-data-dir=<temp>` (never the user's own profile), then `Page.navigate`, `Runtime.evaluate`, `Page.captureScreenshot`, `Emulation.setDeviceMetricsOverride` for sizes, `Emulation.setEmulatedMedia` for dark mode or reduced motion.
- **Layout shifts**: a `PerformanceObserver` on `layout-shift` entries, or screenshots a few seconds apart compared side by side; also `document.scrollingElement.scrollTop` of the root (should stay 0 in an app shell) and `scrollWidth > clientWidth` (sideways overflow).

## Desktop apps

- **WebView2 / Tauri on Windows**: start the app with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` and attach over CDP like Chrome. Its window size is the user's: change the page's size with `Emulation.setDeviceMetricsOverride` (works even while minimized) and clear it after.
- **What CDP can't see**: native window frames, child webviews and overlays painted outside the page. Capture the real window instead: on Windows `PrintWindow` with flag 2 (`PW_RENDERFULLCONTENT`) via a small PowerShell script (GetWindowRect + PrintWindow, per-monitor DPI aware); real input with `SetCursorPos` + `mouse_event` or `SendKeys` when page events aren't enough.
- **WebKitGTK / Linux**: no CDP. Screenshots with KDE's `spectacle -b -n -f -o <file>` (or `-a` for the active window), input with `ydotool` or the app's own test hooks. Over SSH, export the session's `DISPLAY`/`WAYLAND_DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`.
- **Electron**: `--remote-debugging-port` on the command line, then CDP, or Playwright's `_electron.launch`.

## Phones

- **Emulation first**: Chrome device metrics + touch + the phone's user agent, or Playwright's device presets; safe-area insets and the on-screen keyboard aren't emulated, so check those on the real phone.
- **The real phone**: ask the user for a screenshot, or reach it through the app's own remote path; say exactly what to tap.

## Looking at screenshots

Open every screenshot and describe what you see before judging it. Compare with the previous version or the design when there is one: side by side at the same size. Crop to the area in question for small details (text clipping, 1 px gaps, misaligned icons).
