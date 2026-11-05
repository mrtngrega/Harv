"""Types one line into DaVinci Resolve's Console on Linux (KDE Plasma, Wayland) and presses Enter.

The Linux twin of console.ps1, used by resolve.mjs to start Harv's bridge. Wayland lets no program
type into another's window, so:
  - KWin (over D-Bus) brings Resolve's window to the front and reports the Console's state,
  - the line goes on the clipboard (wl-copy), the user's clipboard text is put back afterwards,
  - a virtual keyboard (/dev/uinput, which the logged-in user may write) presses F6 when the
    Console isn't open, then Ctrl+V and Enter. Key codes, not characters: no keyboard-layout trouble.
Prints TYPED, PROJECT_MANAGER, NO_WINDOW or an error. Usage: console_linux.py <line base64>
"""

import base64
import json
import fcntl
import os
import struct
import subprocess
import sys
import tempfile
import time

# linux/input-event-codes.h
EV_SYN, EV_KEY, SYN_REPORT = 0x00, 0x01, 0
KEY_LEFTCTRL, KEY_V, KEY_ENTER, KEY_F6 = 29, 47, 28, 64
# linux/uinput.h
UI_SET_EVBIT, UI_SET_KEYBIT = 0x40045564, 0x40045565
UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502

# wl-copy stays behind to serve the clipboard: it must not hold our caller's pipes open.
QUIET = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}


def resolve_windows() -> list[str]:
    """Titles of Resolve's windows. Resolve runs on X11 (Xwayland), so xprop sees them."""
    def prop(*args):
        return subprocess.run(["xprop", *args], capture_output=True, text=True).stdout

    titles = []
    for wid in prop("-root", "_NET_CLIENT_LIST").split("#", 1)[-1].replace(",", " ").split():
        out = prop("-id", wid, "_NET_WM_NAME", "WM_CLASS")
        if "resolve" in out.lower() or "Project Manager" in out:
            name = out.split('"', 2)[1] if '"' in out else ""
            titles.append(name)
    return titles


def state() -> str:
    """console / main / pm / welcome / none."""
    titles = resolve_windows()
    # The Console's window is titled "Resolve" on Windows and "resolve" here.
    if any(t.lower() in ("resolve", "console") for t in titles):
        return "console"
    if any(t.startswith("DaVinci Resolve") for t in titles):
        return "main"
    if "Project Manager" in titles:
        return "pm"
    if any(t.startswith("Welcome") for t in titles):
        return "welcome"
    return "none"


def kwin_activate(titles: list[str]) -> None:
    """Brings the first window whose title is in `titles` (or starts with one ending in '*') to the front."""
    script = (
        "const want = " + json.dumps(titles) + ";\n"
        "const hit = (c) => want.some((t) => t.endsWith('*') ? c.startsWith(t.slice(0, -1)) : c === t);\n"
        "for (const t of want) for (const w of workspace.windowList()) {\n"
        "  if (hit(w.caption || '') && (w.caption === t || t.endsWith('*'))) {\n"
        "    if (w.minimized) w.minimized = false; workspace.activeWindow = w; break; } }\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(script)
        path = f.name
    name = f"harv-resolve-{os.getpid()}"
    call = ["gdbus", "call", "--session", "--dest", "org.kde.KWin"]
    try:
        out = subprocess.run([*call, "--object-path", "/Scripting", "--method",
                              "org.kde.kwin.Scripting.loadScript", path, name],
                             capture_output=True, text=True, check=True).stdout
        sid = out.strip("()\n, ").split(",")[0].split()[-1]
        subprocess.run([*call, "--object-path", f"/Scripting/Script{sid}", "--method", "org.kde.kwin.Script.run"],
                       capture_output=True, check=True)
        time.sleep(0.4)
    finally:
        subprocess.run([*call, "--object-path", "/Scripting", "--method",
                        "org.kde.kwin.Scripting.unloadScript", name], capture_output=True)
        os.unlink(path)


class Keyboard:
    def __init__(self):
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        for key in (KEY_LEFTCTRL, KEY_V, KEY_ENTER, KEY_F6):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, key)
        # struct uinput_user_dev: name[80], input_id (4 x u16), ff_effects_max, abs arrays
        dev = struct.pack("80sHHHHi", b"Harv keyboard", 0x03, 0x1, 0x1, 1, 0) + b"\0" * (64 * 4 * 4)
        os.write(self.fd, dev)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        time.sleep(0.5)  # let the compositor pick the new device up

    def _ev(self, typ, code, value):
        now = time.time()
        os.write(self.fd, struct.pack("llHHi", int(now), int(now % 1 * 1e6), typ, code, value))

    def press(self, *keys):
        for k in keys:
            self._ev(EV_KEY, k, 1)
        self._ev(EV_SYN, SYN_REPORT, 0)
        time.sleep(0.03)
        for k in reversed(keys):
            self._ev(EV_KEY, k, 0)
        self._ev(EV_SYN, SYN_REPORT, 0)
        time.sleep(0.15)

    def close(self):
        fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        os.close(self.fd)


def main() -> None:
    line = base64.b64decode(sys.argv[1]).decode("utf-8")
    now = state()
    if now == "pm":
        print("PROJECT_MANAGER")
        return
    if now == "welcome":
        print("WELCOME")
        return
    if now not in ("console", "main"):
        print("NO_WINDOW")
        return
    saved = subprocess.run(["wl-paste", "--no-newline", "--type", "text"], capture_output=True)
    subprocess.run(["wl-copy", line], check=True, **QUIET)
    kb = Keyboard()
    try:
        if now == "main":
            kwin_activate(["DaVinci Resolve*"])
            kb.press(KEY_F6)
            time.sleep(1.5)
            if state() != "console":
                print("NO_CONSOLE")
                return
        kwin_activate(["resolve", "Resolve", "Console"])
        time.sleep(0.3)
        kb.press(KEY_LEFTCTRL, KEY_V)
        kb.press(KEY_ENTER)
        print("TYPED")
    finally:
        kb.close()
        time.sleep(0.3)
        if saved.returncode == 0:
            subprocess.run(["wl-copy", "--", saved.stdout.decode("utf-8", "replace")], **QUIET)
        else:
            subprocess.run(["wl-copy", "--clear"], **QUIET)


if __name__ == "__main__":
    main()
