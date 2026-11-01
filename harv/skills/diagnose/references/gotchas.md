# Known traps on these computers

Traps already hit while building things on a Windows 11 PC and a Fedora (KDE Plasma) notebook. Check the ones that match before building a theory: each one has cost real hours once. When you hit a new one, add a line under its heading (symptom → cause → what works).

## Windows shells

- **Git Bash eats backslashes**: heredocs (even quoted `<<'EOF'`) and `node -e '…'` strings can lose `\` or turn `\\n` into something else, so Windows paths and escapes silently change. → Write scripts to a file with the editor, or use forward slashes.
- **Git Bash turns `/word` arguments into paths** (`/model` → `C:/Program Files/Git/model`). → `MSYS_NO_PATHCONV=1` before the command.
- **PowerShell 5.1**: no `&&`/`||` (use `; if ($?) { … }`), no `?:` or `??`; `2>&1` on a native program wraps stderr lines in errors and sets `$?` false even on exit code 0; `Set-Content` writes the ANSI code page (pass `-Encoding utf8`).
- **A process search finds itself**: `pgrep -f "<text>"` or a CIM query on `CommandLine -like '*text*'` matches the shell running the search, since its own command line contains the text. → `pgrep -x <name>`, or search from a script file.
- **`FindWindowW` with a null class** from PowerShell needs `[NullString]::Value`, not `$null` (which becomes an empty string).

## Files and line endings

- **Python on Windows writes CRLF** in text mode (`open(p, 'w')`), flipping a whole LF file and making a huge diff. → Open in binary (`'wb'`, encode yourself) or edit with the editor tool.
- **Locked files**: on Windows a file another program has open can't be deleted or renamed (`EBUSY`, `EPERM`): an editor, a running exe, antivirus scanning it, a terminal sitting in that folder. → Find who holds it (Resource Monitor, `handle.exe`), or retry after the program closes.
- **A test that writes Windows paths on Linux** can leave files literally named `\tmp\…` in the repo. → Delete them by exact name from Python; globs miss them.

## Node, Vite and dev servers

- **Orphaned servers on Windows**: stopping a background `npm run dev` can leave `tsx`/`vite`/`node` children holding the ports, and new servers then hang silently. → `netstat -ano | grep -E ":(4317|5173)"` (or the project's ports) and kill those PIDs with their tree. Never kill the Claude Code process.
- **Vite misses a change on Windows** now and then (the browser keeps old code). → Restart Vite before doubting the fix.
- **Editing a non-component module** (`lib/*.ts`) makes Vite reload the whole page: it looks like a restart while the server kept running. Check the server's own log before concluding it restarted.
- **A flaky test under full-suite load** (passes alone, fails in the full run, e.g. a pseudo-terminal test). → Run it alone to tell flake from bug; fix the timing with a wait on the real condition, not a longer sleep.
- **`npm install` refuses install scripts** of new packages (npm's allowScripts). → Review the package, then `npm install-scripts approve <pkg>`.

## Web views and desktop apps

- **`backdrop-filter` breaks `position: fixed`** inside it (the fixed element is placed relative to the blurred panel). → Render menus and popups in a portal at the body. A nested `backdrop-filter` inside another blurred panel doesn't blur at all.
- **Tauri with several webviews**: the window is no longer a `WebviewWindow`; look the window and each webview up separately (`get_window`, `get_webview("main")`), or move/minimize/close stop working.
- **CDP screenshots of a Tauri/WebView2 app miss child webviews**: capture the screen (PrintWindow) to see what the user sees.
- **WebKitGTK (Linux Tauri) has no CDP**: screenshot with `spectacle -b -n -f -o <file>` and drive it some other way. Linux stacks a window's webviews in a vertical box unless they're moved into an overlay.
- **Tauri's `dragDropEnabled`** takes drops from the page: with it on, HTML5 drag and drop inside the page breaks on Windows.

## Fedora / Linux

- **`sudo` and polkit can't ask for a password over SSH** (`systemd-inhibit`, `sudo`, many `systemctl` system calls). → The session's own tools through the user bus (`kde-inhibit`, `systemctl --user`), or leave it to the user with the exact command.
- **SELinux denials** look like permission errors with correct file rights. → `ausearch -m avc -ts recent` / `journalctl -t setroubleshoot`.
- **SSH commands that start a long-running program hang** the SSH call. → `nohup … >log 2>&1 </dev/null &`.
- **Non-login SSH shells miss PATH entries** from `~/.bashrc` (user-installed Node, CLIs). → Export PATH in the command.
- **A Wi-Fi password kept in KWallet** (user-only connection) means no network until the user logs in: anything at boot can't reach the internet.
