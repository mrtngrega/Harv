# Known traps on these computers

Traps already hit while building things on a Windows 11 PC and a Fedora (KDE Plasma) notebook. Check the ones that match before building a theory: each one has cost real hours once. When you hit a new one, add a line under its heading (symptom → cause → what works).

## Windows shells

- **Git Bash eats backslashes**: heredocs (even quoted `<<'EOF'`), `sed -i` replacements and `node -e '…'` strings can lose `\` or turn `\\n` into something else, so Windows paths and escapes silently change. → Write scripts to a file with the editor, or use forward slashes.
- **Git Bash turns `/word` arguments into paths** (`/model` → `C:/Program Files/Git/model`). → `MSYS_NO_PATHCONV=1` before the command.
- **PowerShell 5.1**: no `&&`/`||` (use `; if ($?) { … }`), no `?:` or `??`; `2>&1` on a native program wraps stderr lines in errors and sets `$?` false even on exit code 0; `Set-Content` writes the ANSI code page (pass `-Encoding utf8`).
- **A process search finds itself**: `pgrep -f "<text>"` or a CIM query on `CommandLine -like '*text*'` matches the shell running the search, since its own command line contains the text. → `pgrep -x <name>`, or search from a script file.
- **Headless Chrome/Edge screenshots from Git Bash**: `--screenshot=…` from Git Bash wrote no file in two runs (2026-11-03); the same command from PowerShell worked. → Take browser screenshots from PowerShell (or with Playwright/CDP).
- **A skill's text is loaded once per Claude Code session**: after editing a skill, the Skill tool (and subagents started from that session) still get the old text. → Test an edited skill in a new session, or have the test read the SKILL.md file directly.
- **No new programs during a Windows shutdown**: a process started after `WM_QUERYENDSESSION` fails with 0xc0000142 ("unable to start correctly", an error popup in the event log as Application Popup 26). → Start what the shutdown needs beforehand and keep it waiting.
- **`FindWindowW` with a null class** from PowerShell needs `[NullString]::Value`, not `$null` (which becomes an empty string).
- **Python on Windows can't see Git Bash's `/tmp`** (it reads `/tmp/x` as `C:/tmp/x` or the user's Temp). → Pass Windows paths, or files inside the working folder.
- **At shutdown Windows closes console programs early**: a server started in a hidden console (`cmd.exe` / `Start-Process -WindowStyle Hidden`) gets CTRL_SHUTDOWN_EVENT, which Node can't catch, often before other apps hear `WM_QUERYENDSESSION`. → Anything that must happen at shutdown runs in the GUI app itself, not in the server.
- **Windows holds startup apps back** for ~20 s after login (Run-key entries): "starts with Windows" isn't instant. → Do the urgent part first in whatever starts, and measure from the login.

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
- **A terminal window keeps popping up**: find who starts it by logging new processes with their parent (poll `Win32_Process`); a visible one shows as `OpenConsole.exe -Embedding` (Windows Terminal) next to it. A venv's `python.exe` started with no console (`DETACHED_PROCESS`) is only a launcher, and the real python under it opens a visible window. → Start `pythonw.exe` (no console, pipes still work), or a hidden console (`CREATE_NO_WINDOW` / Node's `windowsHide`).
- **Something that must happen at shutdown finds a helper process already gone**: Windows ends programs one by one by shutdown level, in no set order within one, and a windowless process is simply ended when its turn comes. A fake `WM_QUERYENDSESSION` sent to one window can't show this. → `SetProcessShutdownParameters`: the program that acts asks for 0x3FF (first), its helpers 0x100 (last). Proof is a real shutdown's log.

## Fedora / Linux

- **`sudo` and polkit can't ask for a password over SSH** (`systemd-inhibit`, `sudo`, many `systemctl` system calls). → The session's own tools through the user bus (`kde-inhibit`, `systemctl --user`), or leave it to the user with the exact command.
- **SELinux denials** look like permission errors with correct file rights. → `ausearch -m avc -ts recent` / `journalctl -t setroubleshoot`.
- **SSH commands that start a long-running program hang** the SSH call. → `nohup … >log 2>&1 </dev/null &`.
- **Non-login SSH shells miss PATH entries** from `~/.bashrc` (user-installed Node, CLIs). → Export PATH in the command.
- **A Wi-Fi password kept in KWallet** (user-only connection) means no network until the user logs in: anything at boot can't reach the internet.
- **A command over SSH (or a child process) never returns after `wl-copy`**: wl-copy stays behind to serve the clipboard and keeps the caller's stdout/stderr open. → Run it with stdin/stdout/stderr to `/dev/null` (`subprocess.DEVNULL`).
- **A KWin script's `print()` shows up nowhere** you can read (not in `journalctl --user`). → Use the script only to act (raise a window); read state another way, e.g. `xprop -root _NET_CLIENT_LIST` + `xprop -id <id> _NET_WM_NAME` for X11 apps under Xwayland.
