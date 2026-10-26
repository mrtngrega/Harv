#!/usr/bin/env bash
# Linux twin of install-shortcuts.ps1: puts Harv in the application menu (KDE, GNOME…).
# Run again any time to recreate it:
#   bash scripts/install-shortcuts.sh
#
# With the desktop app built (npm run app, docs/PLAN.md §6p) the entry opens the app, and KDE gets
# Ctrl+Alt+H for it (Wayland doesn't let apps take a global hotkey themselves; a second launch just
# shows the running app). Without it, the entry starts Harv in the browser, with Restart and Stop
# on its right-click menu. Nothing starts with the desktop unless the app's "Open Harv when I log in" is on.
set -eu
scripts="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$scripts")"
app="$repo/apps/desktop/src-tauri/target/release/harv"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$apps"

if [ -x "$app" ]; then
  cat > "$apps/harv.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Harv
Comment=Harv, a personal AI assistant
Exec="$app"
Icon=$repo/apps/desktop/src-tauri/icons/icon.png
Terminal=false
Categories=Utility;
StartupWMClass=harv
X-KDE-Shortcuts=Ctrl+Alt+H
EOF
  # KDE's global shortcut for launching it (applies at once if KDE picks it up, else after the next login).
  if command -v kwriteconfig6 >/dev/null; then
    kwriteconfig6 --file kglobalshortcutsrc --group services --group harv.desktop --key _launch 'Ctrl+Alt+H'
  fi
  message="Harv (the app) is in the application menu; Ctrl+Alt+H brings it up in KDE."
else
  cat > "$apps/harv.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Harv
Comment=Start Harv and open the dashboard
Exec=bash "$scripts/harv.sh" start
Icon=$scripts/icons/harv-start.ico
Terminal=false
Categories=Utility;
Actions=restart;stop;

[Desktop Action restart]
Name=Restart Harv
Exec=bash "$scripts/harv.sh" restart
Icon=$scripts/icons/harv-restart.ico

[Desktop Action stop]
Name=Stop Harv
Exec=bash "$scripts/harv.sh" stop
Icon=$scripts/icons/harv-stop.ico
EOF
  message="Harv is in the application menu (right-click it for Restart and Stop). Build the app with npm run app, then run this again."
fi
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" 2>/dev/null || true
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
echo "$message"
