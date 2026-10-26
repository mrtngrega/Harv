"""Draws the Harv app icon and the tray's status icons (no packages needed).

    python apps/desktop/make-icons.py
    npx tauri icon apps/desktop/src-tauri/icons/source.png   (from apps/desktop: every size Windows and Linux need)

The app icon: an ice-blue ring and dot on Harv's dark rounded tile. The tray icons show Harv's status:
idle (ice dot), busy (ice ring and dot), waiting for an approval (amber dot), paused or offline (dim ring).
"""

import math
import struct
import zlib
from pathlib import Path

ICE = (168, 200, 232)
AMBER = (242, 184, 128)
DIM = (120, 136, 152)
GROUND = (20, 27, 35)


def png(size, pixels):
    raw = b''.join(b'\x00' + bytes(c for px in row for c in px) for row in pixels)

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def cover(distance):
    """How much of a pixel a shape covers, from its signed distance to the edge (negative = inside)."""
    return min(max(0.5 - distance, 0.0), 1.0)


def over(below, color, alpha):
    """Paints color with alpha over an RGBA pixel."""
    a = alpha + below[3] / 255 * (1 - alpha)
    if a == 0:
        return (0, 0, 0, 0)
    rgb = tuple(round((c * alpha + b * below[3] / 255 * (1 - alpha)) / a) for c, b in zip(color, below))
    return (*rgb, round(a * 255))


def draw(size, layers):
    """layers: (color, distance(x, y, r) in pixels) pairs, painted in order; r = distance from the centre."""
    c = (size - 1) / 2
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            px = (0, 0, 0, 0)
            r = math.hypot(x - c, y - c)
            for color, shape in layers:
                alpha = cover(shape(x - c, y - c, r))
                if alpha:
                    px = over(px, color, alpha)
            row.append(px)
        rows.append(row)
    return png(size, rows)


def tile(half, radius):
    """A rounded square (signed distance)."""

    def shape(x, y, r):
        qx, qy = abs(x) - half + radius, abs(y) - half + radius
        outside = math.hypot(max(qx, 0), max(qy, 0))
        return outside + min(max(qx, qy), 0) - radius

    return shape


def disc(radius):
    return lambda x, y, r: r - radius


def ring(radius, width):
    return lambda x, y, r: abs(r - radius) - width / 2


out = Path(__file__).parent / 'src-tauri' / 'icons'
out.mkdir(parents=True, exist_ok=True)

S = 512
(out / 'source.png').write_bytes(
    draw(S, [(GROUND, tile(S * 0.46, S * 0.2)), (ICE, ring(S * 0.27, S * 0.055)), (ICE, disc(S * 0.11))])
)

T = 32
for name, layers in (
    ('tray-idle', [(ICE, disc(T * 0.22))]),
    ('tray-busy', [(ICE, ring(T * 0.36, T * 0.09)), (ICE, disc(T * 0.16))]),
    ('tray-waiting', [(AMBER, ring(T * 0.36, T * 0.09)), (AMBER, disc(T * 0.16))]),
    ('tray-off', [(DIM, ring(T * 0.3, T * 0.08))]),
):
    (out / f'{name}.png').write_bytes(draw(T, layers))
print('icons written to', out)
