"""Starts Windows-MCP (0.8.8, reviewed) without its own on-screen indicator.

Windows-MCP draws a blue glow around the screen and its own notice pill while it uses the mouse and
keyboard. Harv shows its own pill instead (apps/desktop/src-tauri/src/pill.rs), so two indicators
said the same thing (the user's wish, 2026-11-06: only Harv's). 0.8.8 has no switch for it, and its
control logic waits for the indicator, so this swaps the indicator module for one that draws
nothing and always reports itself shown. Everything else is untouched: it still refuses to act
while the user uses the mouse or keyboard (USER_CONTROL), stops when they move (CONTROL_PREEMPTED),
and Ctrl+Alt+Shift+Backspace still takes control back. Its screenshot flash is off by its own
switch (WINDOWS_MCP_DISABLE_FLASH, set by windowsMcp.ts).

Usage (windowsMcp.ts): <venv>/Scripts/python.exe -I windows_mcp_quiet.py serve --transport stdio
"""

import contextlib
import sys

from windows_mcp.desktop import control_overlay as indicator

# Same names and signatures as windows_mcp/desktop/control_overlay.py in 0.8.8; a version bump
# needs a new review of that module before this runs on it.
indicator.start = lambda: None
indicator.stop = lambda: None
indicator.set_active = lambda active, *, generation=None: True
indicator.set_pending = lambda pending, *, generation=None: True
indicator.is_healthy = lambda: True
indicator.suspend_for_capture = contextlib.nullcontext

from windows_mcp.__main__ import main  # noqa: E402  (after the swap, so it uses it)

sys.exit(main())
