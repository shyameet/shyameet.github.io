"""Draw the decorative SVGs the site repeats: public/art/ornaments/*.svg

  toran.svg    a doorway garland of marigolds and mango leaves (a repeating tile)
  mandala.svg  a rangoli-style petal mandala, single colour (used as a mask)
  lotus.svg    a five-petal lotus silhouette, single colour (used as a mask)

The two single-colour files are CSS masks: the page paints them in whatever colour
the theme wants (saffron by day, gold by night), so they follow light/dark mode.
The toran is full colour -- marigold and mango leaf look the same in either theme.

Run:  python src/make_ornaments.py
"""
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "art" / "ornaments"


def f(x):
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def pol(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)


def petal(length, width):
    """A teardrop petal with its base at the origin, pointing up (-y)."""
    L, W = length, width
    return (f"M0,0 C{f(W)},{f(-L * .30)} {f(W * .85)},{f(-L * .74)} 0,{f(-L)} "
            f"C{f(-W * .85)},{f(-L * .74)} {f(-W)},{f(-L * .30)} 0,0 Z")


def write(name, body, w, h):
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">\n'
           f'{body}\n</svg>\n')
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(svg, encoding="utf-8")
    print("wrote", OUT / name, len(svg), "bytes")


# ------------------------------------------------------------------ toran
def marigold(cx, cy):
    """A pom-pom marigold: ruffled outer ring, golden inner ring, a dark eye."""
    parts = []
    for k in range(11):
        x, y = pol(cx, cy, 4.9, k * 360 / 11 - 90)
        parts.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="3.1" fill="#ee8a0a"/>')
    for k in range(7):
        x, y = pol(cx, cy, 2.3, k * 360 / 7 - 90)
        parts.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="2.3" fill="#ffc531"/>')
    parts.append(f'<circle cx="{f(cx)}" cy="{f(cy)}" r="1.5" fill="#d2670a"/>')
    return "".join(parts)


def mango_leaf(cx, top, length):
    """A hanging mango leaf with a pale midrib."""
    bot = top + length
    body = (f"M{f(cx)},{f(top)} C{f(cx - 6.5)},{f(top + length * .28)} {f(cx - 6)},{f(top + length * .72)} {f(cx)},{f(bot)} "
            f"C{f(cx + 6)},{f(top + length * .72)} {f(cx + 6.5)},{f(top + length * .28)} {f(cx)},{f(top)} Z")
    return (f'<path d="{body}" fill="#3e9158"/>'
            f'<path d="M{f(cx)},{f(top + 2)} L{f(cx)},{f(bot - 2)}" stroke="#a6dcb0" stroke-width=".9" '
            f'stroke-linecap="round" fill="none"/>')


def toran():
    w, h = 72, 36
    body = ['<path d="M0,3 Q18,11 36,3 Q54,11 72,3" fill="none" stroke="#8c5a2b" stroke-width="1.5" stroke-linecap="round"/>']
    body.append('<path d="M54,7.2 L54,9.5" stroke="#8c5a2b" stroke-width="1.2" stroke-linecap="round"/>')
    body.append(mango_leaf(18, 6.2, 25))
    body.append(marigold(54, 15.4))
    write("toran.svg", "\n".join(body), w, h)


# ----------------------------------------------------------------- mandala
def mandala():
    c = 100
    sw = 'fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round"'
    g = [f'<circle cx="{c}" cy="{c}" r="96" {sw} stroke-width="1.4"/>',
         f'<circle cx="{c}" cy="{c}" r="91" {sw} stroke-width="2.6" stroke-dasharray="0.1 5.6"/>']
    for k in range(24):                                   # outer petals
        g.append(f'<path d="{petal(26, 7.5)}" transform="translate({c} {c}) rotate({f(k * 15)}) translate(0 -62)" {sw} stroke-width="1.5"/>')
    g.append(f'<circle cx="{c}" cy="{c}" r="60" {sw} stroke-width="1.2"/>')
    for k in range(12):                                   # middle petals, offset half a step
        g.append(f'<path d="{petal(23, 9.5)}" transform="translate({c} {c}) rotate({f(k * 30 + 15)}) translate(0 -34)" {sw} stroke-width="1.5"/>')
    g.append(f'<circle cx="{c}" cy="{c}" r="34" {sw} stroke-width="1.2"/>')
    for k in range(8):                                    # inner petals
        g.append(f'<path d="{petal(16, 7)}" transform="translate({c} {c}) rotate({f(k * 45)}) translate(0 -11)" {sw} stroke-width="1.4"/>')
    g.append(f'<circle cx="{c}" cy="{c}" r="9" {sw} stroke-width="1.5"/>')
    g.append(f'<circle cx="{c}" cy="{c}" r="3" fill="#000"/>')
    write("mandala.svg", "\n".join(g), 200, 200)


# ------------------------------------------------------------------- lotus
def lotus():
    """A layered pink lotus: back petals first, the centre petal last, so each
    front petal sits over the ones behind it. Full colour (pink reads on both the
    light and the dark theme), with a green pad to float on."""
    w, h = 64, 38
    bx, by = 32, 31
    out = ['<defs><linearGradient id="lp" x1="0" y1="1" x2="0" y2="0">'
           '<stop offset="0" stop-color="#e2628d"/><stop offset="1" stop-color="#fbc6d6"/></linearGradient>'
           '<linearGradient id="lg" x1="0" y1="0" x2="1" y2="0">'
           '<stop offset="0" stop-color="#2f7d4a"/><stop offset=".5" stop-color="#4aa468"/><stop offset="1" stop-color="#2f7d4a"/>'
           '</linearGradient></defs>']
    # the pad
    out.append(f'<ellipse cx="{bx}" cy="{by + 3}" rx="27" ry="4.2" fill="url(#lg)"/>')

    def p(rot, length, width, dx=0):
        out.append(f'<path d="{petal(length, width)}" transform="translate({f(bx + dx)} {by}) rotate({rot})" '
                   f'fill="url(#lp)" stroke="#c0446c" stroke-width=".9" stroke-linejoin="round"/>')

    p(-68, 15, 6.0, -3)
    p(68, 15, 6.0, 3)
    p(-44, 19.5, 6.8, -2)
    p(44, 19.5, 6.8, 2)
    p(-20, 23, 7.3, -1)
    p(20, 23, 7.3, 1)
    p(0, 26.5, 7.6)
    # a centre vein on the front petal
    out.append(f'<path d="M{bx},{by - 3} L{bx},{by - 18}" stroke="#c0446c" stroke-width=".7" stroke-linecap="round" opacity=".55"/>')
    write("lotus.svg", "\n".join(out), w, h)


if __name__ == "__main__":
    toran()
    mandala()
    lotus()
