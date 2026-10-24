"""Draws the three desktop-shortcut icons (start, restart, stop) as .ico files in scripts/icons.

Run once with Python (no packages needed): python scripts/make-icons.py
"""

import math
import struct
import zlib
from pathlib import Path

SIZE = 64
ICE = (168, 200, 232)
AMBER = (242, 184, 128)
GROUND = (20, 27, 35)


def png(pixels):
    raw = b''.join(b'\x00' + bytes(c for px in row for c in px) for row in pixels)

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def ico(png_bytes):
    # One 64x64 image stored as PNG (fine for Windows Vista and later).
    return struct.pack('<HHH', 0, 1, 1) + struct.pack('<BBBBHHII', SIZE, SIZE, 0, 0, 1, 32, len(png_bytes), 22) + png_bytes


def draw(shape):
    rows = []
    c = (SIZE - 1) / 2
    for y in range(SIZE):
        row = []
        for x in range(SIZE):
            d = math.hypot(x - c, y - c)
            # A dark rounded tile behind every icon, so they read on any wallpaper.
            corner = max(abs(x - c) - 22, 0) ** 2 + max(abs(y - c) - 22, 0) ** 2
            if corner > 9 ** 2:
                row.append((0, 0, 0, 0))
                continue
            row.append(shape(x, y, d, c) or (*GROUND, 255))
        rows.append(row)
    return rows


def start(x, y, d, c):
    if d < 17:
        return (*ICE, 255)
    return None


def restart(x, y, d, c):
    angle = math.degrees(math.atan2(y - c, x - c)) % 360
    if 12 < d < 19 and not (300 < angle < 350):
        return (*ICE, 255)
    return None


def stop(x, y, d, c):
    if abs(x - c) < 14 and abs(y - c) < 14:
        return (*AMBER, 255)
    return None


out = Path(__file__).parent / 'icons'
out.mkdir(exist_ok=True)
for name, shape in (('harv-start', start), ('harv-restart', restart), ('harv-stop', stop)):
    (out / f'{name}.ico').write_bytes(ico(png(draw(shape))))
print('icons written to', out)
