"""Render the app icons: an ivory Om on a saffron tile, the same mark the site
header uses. iOS home-screen icons must be PNG, so these are PNGs; icon.svg
just wraps the 192px one for browsers that ask for an SVG favicon.

The glyph comes from Nirmala UI, which ships with Windows -- run this on a
Windows machine (or point FONT at any font with a Devanagari Om).
"""
import base64
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public"
FONT = r"C:\Windows\Fonts\Nirmala.ttc"
SAFFRON, IVORY = (198, 90, 30), (255, 247, 232)
OM = "\u0950"


def render(size):
    big = size * 4                      # draw large, shrink once: smooth edges
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=SAFFRON)
    font = ImageFont.truetype(FONT, int(big * 0.62))
    l, t, r, b = d.textbbox((0, 0), OM, font=font)
    x = (big - (r - l)) / 2 - l
    y = (big - (b - t)) / 2 - t - big * 0.01
    d.text((x, y), OM, font=font, fill=IVORY)
    return im.resize((size, size), Image.LANCZOS)


def render_maskable(size):
    """A maskable icon: the saffron fills the whole square (the phone cuts its own shape out of it)
    and the Om stays inside the central 80% circle that every shape keeps."""
    big = size * 4
    im = Image.new("RGB", (big, big), SAFFRON)
    d = ImageDraw.Draw(im)
    font = ImageFont.truetype(FONT, int(big * 0.46))
    l, t, r, b = d.textbbox((0, 0), OM, font=font)
    d.text(((big - (r - l)) / 2 - l, (big - (b - t)) / 2 - t - big * 0.008), OM, font=font, fill=IVORY)
    return im.resize((size, size), Image.LANCZOS)


for n in (192, 512):
    render_maskable(n).save(OUT / f"icon-maskable-{n}.png")
    print("wrote", OUT / f"icon-maskable-{n}.png")

for n in (180, 192, 512):
    img = render(n)
    if n == 180:                        # iOS draws its own corners; give it a full square
        flat = Image.new("RGB", (n, n), SAFFRON)
        flat.paste(img, (0, 0), img)
        img = flat
    img.save(OUT / f"icon-{n}.png")
    print("wrote", OUT / f"icon-{n}.png")

png = (OUT / "icon-192.png").read_bytes()
(OUT / "icon.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">'
    f'<image width="192" height="192" href="data:image/png;base64,{base64.b64encode(png).decode()}"/></svg>\n',
    encoding="utf-8",
)
print("wrote", OUT / "icon.svg")
