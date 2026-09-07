"""Render the PNG app icons from the same geometry as public/icon.svg.
iOS home-screen icons must be PNG, so these cannot be the SVG."""
from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public"
BG, ORANGE, INK = "#262626", "#E97132", "#E8E6E1"


def blend(hex_fg, hex_bg, a):
    f = tuple(int(hex_fg[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(hex_bg[i:i + 2], 16) for i in (1, 3, 5))
    return tuple(round(f[i] * a + b[i] * (1 - a)) for i in range(3))


def render(size):
    s = size / 64.0
    im = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=14 * s, fill=BG)
    bars = [(18, 32, ORANGE, 1.0), (29.5, 32, INK, 0.55), (41, 19, INK, 0.30)]
    for y, w, col, alpha in bars:
        c = col if alpha == 1.0 else "#%02x%02x%02x" % blend(col, BG, alpha)
        d.rounded_rectangle(
            [16 * s, y * s, (16 + w) * s, (y + 5) * s], radius=2.5 * s, fill=c
        )
    return im


for n in (180, 192, 512):
    render(n).save(OUT / f"icon-{n}.png")
    print("wrote", OUT / f"icon-{n}.png")
