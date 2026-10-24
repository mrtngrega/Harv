#!/usr/bin/env bash
# Linux twin of install-shortcuts.ps1: puts Harv in the application menu (KDE, GNOME…),
# with "Restart Harv" and "Stop Harv" on its right-click menu. Run again any time to recreate it:
#   bash scripts/install-shortcuts.sh
# Nothing starts with the desktop; that's decided with the desktop app (M9).
set -eu
scripts="$(cd "$(dirname "$0")" && pwd)"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$apps"
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
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" 2>/dev/null || true
echo "Harv is in the application menu (right-click it for Restart and Stop)."
