"""Prints the PC's monitors as JSON: device, primary, and bounds in physical pixels.

The same coordinates Windows-MCP uses (one virtual desktop across all monitors), so Harv can tell
which monitor a click lands on and limit Snapshots to one (windowsMcp.ts, desktop control). Only
the standard library; run with the Windows-MCP venv's python -I.
"""

import ctypes
import json
from ctypes import wintypes

user32 = ctypes.windll.user32
try:
    # Per-monitor aware, so a monitor at 125% reports its real pixels, like Windows-MCP sees them.
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except (AttributeError, OSError):
    pass


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ('cbSize', wintypes.DWORD),
        ('rcMonitor', wintypes.RECT),
        ('rcWork', wintypes.RECT),
        ('dwFlags', wintypes.DWORD),
        ('szDevice', wintypes.WCHAR * 32),
    ]


monitors = []
MonitorEnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)


def each(handle, _dc, _rect, _data):
    info = MONITORINFOEXW()
    info.cbSize = ctypes.sizeof(info)
    if user32.GetMonitorInfoW(handle, ctypes.byref(info)):
        r = info.rcMonitor
        monitors.append(
            {'device': info.szDevice, 'primary': bool(info.dwFlags & 1), 'left': r.left, 'top': r.top, 'right': r.right, 'bottom': r.bottom}
        )
    return True


user32.EnumDisplayMonitors(None, None, MonitorEnumProc(each), 0)
print(json.dumps(monitors))
