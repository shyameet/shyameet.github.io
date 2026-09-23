"""Draw the deity medallions the site shows, one per weekday.

Line art in one ink (currentColor) plus one or two accents per deity, so every
medallion follows the site's light/dark theme instead of carrying fixed
colours. Geometry that repeats -- rays, petals, flames, chakra teeth -- is
computed here, never typed.

Symbols rather than faces, on purpose: the trishul, the conch and chakra, the
gada, the khadga, the dog at Bhairav's feet. Each one reads instantly, and a
symbol drawn in a few lines stays respectful where a hand-drawn face would not.

Run:  python src/make_art.py        (writes src/art/<id>.svg)
"""
import math
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent / "art"


def f(x):
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def pol(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)


def pts(seq):
    return " L".join(f"{f(x)},{f(y)}" for x, y in seq)


def mirror(d):
    """Mirror an absolute path (M/L/C/Q/Z only) across the centre line x = 100."""
    out, nums = [], []

    def flush():
        pairs = [f"{f(200 - nums[i])},{f(nums[i + 1])}" for i in range(0, len(nums), 2)]
        if pairs:
            out.append(" ".join(pairs))
        nums.clear()

    for tok in re.findall(r"[MLCQZ]|-?\d*\.?\d+", d):
        if tok.isalpha():
            flush()
            out.append(tok)
        else:
            nums.append(float(tok))
    flush()
    s = ""
    for t in out:
        s += t if (t.isalpha() or not s or s[-1].isalpha()) else " " + t
    return s


# ---------------------------------------------------------------- primitives
def frame():
    """Halo, fine outer ring, and a bead circle between them."""
    beads = "".join(
        f'<circle cx="{f(x)}" cy="{f(y)}" r="{1.35 if k % 2 == 0 else 0.8}"/>'
        for k in range(48)
        for (x, y) in [pol(100, 100, 94.2, k * 7.5)]
    )
    return [
        '<circle class="halo" cx="100" cy="100" r="91"/>',
        '<circle class="ring" cx="100" cy="100" r="97.5"/>',
        f'<g class="fl" opacity=".7">{beads}</g>',
    ]


def crescent(c1, R, c2, r, cls="fl", n=40):
    """Circle c1/R minus circle c2/r, sampled as a smooth polygon."""
    (x1, y1), (x2, y2) = c1, c2
    dx, dy = x2 - x1, y2 - y1
    d = math.hypot(dx, dy)
    a = (R * R - r * r + d * d) / (2 * d)
    h = math.sqrt(max(R * R - a * a, 0))
    px, py = x1 + a * dx / d, y1 + a * dy / d
    ux, uy = -dy / d, dx / d
    p1 = (px + h * ux, py + h * uy)
    p2 = (px - h * ux, py - h * uy)
    away = math.atan2(-dy, -dx)

    def arc(c, rad, pa, pb, via):
        a0 = math.atan2(pa[1] - c[1], pa[0] - c[0])
        a1 = math.atan2(pb[1] - c[1], pb[0] - c[0])
        pos = (a1 - a0) % (2 * math.pi)
        sweep = pos if (via - a0) % (2 * math.pi) < pos else pos - 2 * math.pi
        return [(c[0] + rad * math.cos(a0 + sweep * i / n),
                 c[1] + rad * math.sin(a0 + sweep * i / n)) for i in range(n + 1)]

    outer = arc(c1, R, p1, p2, away)
    inner = arc(c2, r, p2, p1, away)
    return f'<path class="{cls}" d="M{pts(outer + inner[1:])} Z"/>'


def petal(cx, cy, length, width, rot, cls):
    L, W = length, width
    d = (f"M0,0 C{f(W)},{f(-L * .28)} {f(W * .9)},{f(-L * .72)} 0,{f(-L)} "
         f"C{f(-W * .9)},{f(-L * .72)} {f(-W)},{f(-L * .28)} 0,0 Z")
    return f'<path class="{cls}" transform="translate({f(cx)} {f(cy)}) rotate({f(rot)})" d="{d}"/>'


FLAME_OUT = ("M0,2 C-7,0 -8.5,-8 -4.5,-13.5 C-3.6,-10.4 -1.6,-9.4 -0.4,-10.4 "
             "C-1.4,-14.6 1,-19.6 5.2,-23 C4.4,-17.8 8.4,-14.4 8.4,-8.2 C8.4,-2.2 5.2,2 0,2 Z")
FLAME_IN = ("M0.6,0 C-3,-.8 -3.6,-4.6 -1.6,-7.6 C-1,-5.8 .4,-5.6 1.2,-6.6 "
            "C1,-9.4 2.4,-11.6 4.2,-13 C3.8,-10.2 5.6,-8 5.2,-4.8 C4.9,-1.6 3,0 .6,0 Z")


def flame(cx, cy, s, rot):
    """A two-tone flame pointing outward: round base, flicked tip. s = height."""
    k = s / 25
    return (f'<g transform="translate({f(cx)} {f(cy)}) rotate({f(rot)}) scale({f(k)})">'
            f'<path class="ac2" d="{FLAME_OUT}"/><path class="acy" d="{FLAME_IN}"/></g>')


def tube(d, outer=9.0, inner=5.2, cls_in="tube-in"):
    """A hollow tube along a centreline -- trunk, tail, serpent."""
    return (f'<path class="tube-out" style="stroke-width:{f(outer)}" d="{d}"/>'
            f'<path class="{cls_in}" style="stroke-width:{f(inner)}" d="{d}"/>')


def trishul(dx=0.0, top=24.0, bottom=178.0, s=1.0):
    """Shiva's trident. dx shifts it sideways, s scales the head."""
    def X(x):
        return f(100 + dx + (x - 100) * s)

    def Y(y):
        return f(top + (y - 24) * s)

    spear = (f"M{X(100)},{Y(24)} C{X(104.5)},{Y(32)} {X(107.5)},{Y(40)} {X(107.5)},{Y(48)} "
             f"C{X(107.5)},{Y(56)} {X(103.5)},{Y(62)} {X(102.2)},{Y(68)} L{X(97.8)},{Y(68)} "
             f"C{X(96.5)},{Y(62)} {X(92.5)},{Y(56)} {X(92.5)},{Y(48)} "
             f"C{X(92.5)},{Y(40)} {X(95.5)},{Y(32)} {X(100)},{Y(24)} Z")
    left = (f"M{X(93)},{Y(76)} C{X(77)},{Y(77)} {X(63.5)},{Y(68)} {X(63.5)},{Y(53)} "
            f"C{X(63.5)},{Y(46)} {X(65.5)},{Y(40)} {X(69)},{Y(33)} "
            f"C{X(70)},{Y(44)} {X(72)},{Y(55)} {X(80)},{Y(62)} "
            f"C{X(84)},{Y(66)} {X(89)},{Y(68)} {X(94)},{Y(69)} Z")
    right = (f"M{X(107)},{Y(76)} C{X(123)},{Y(77)} {X(136.5)},{Y(68)} {X(136.5)},{Y(53)} "
             f"C{X(136.5)},{Y(46)} {X(134.5)},{Y(40)} {X(131)},{Y(33)} "
             f"C{X(130)},{Y(44)} {X(128)},{Y(55)} {X(120)},{Y(62)} "
             f"C{X(116)},{Y(66)} {X(111)},{Y(68)} {X(106)},{Y(69)} Z")
    cx = 100 + dx
    bar_y = top + (67 - 24) * s
    shaft_top = top + (80 - 24) * s
    return [
        f'<rect class="kn" x="{f(cx - 2.6)}" y="{f(shaft_top)}" width="5.2" height="{f(bottom - shaft_top)}" rx="2.2"/>',
        f'<circle class="kn" cx="{f(cx)}" cy="{f(bottom + 3)}" r="4"/>',
        f'<path class="kn" d="{spear}"/>',
        f'<path class="kn" d="{left}"/>',
        f'<path class="kn" d="{right}"/>',
        f'<rect class="ac" x="{f(cx - 15 * s)}" y="{f(bar_y)}" width="{f(30 * s)}" height="{f(8 * s)}" rx="{f(3 * s)}"/>',
        f'<circle class="kn" cx="{f(cx)}" cy="{f(bar_y + 11.5 * s)}" r="{f(3.4 * s)}"/>',
    ]


def damaru(cx, cy, w=14.0, h=15.0):
    top, bot = cy - h, cy + h
    body = (f"M{f(cx - w)},{f(top)} L{f(cx + w)},{f(top)} L{f(cx + 3)},{f(cy)} "
            f"L{f(cx + w)},{f(bot)} L{f(cx - w)},{f(bot)} L{f(cx - 3)},{f(cy)} Z")
    lace = (f"M{f(cx - w + 3)},{f(top + 1.5)} L{f(cx + 1.2)},{f(cy - 3)} "
            f"M{f(cx + w - 3)},{f(top + 1.5)} L{f(cx - 1.2)},{f(cy - 3)} "
            f"M{f(cx - w + 3)},{f(bot - 1.5)} L{f(cx + 1.2)},{f(cy + 3)} "
            f"M{f(cx + w - 3)},{f(bot - 1.5)} L{f(cx - 1.2)},{f(cy + 3)}")
    # the knotted cord droops from the waist, a bead at each end -- the beads
    # are what strike the heads when it is shaken
    reach = w * 0.97
    cord = (f"M{f(cx + 4)},{f(cy)} C{f(cx + reach * .7)},{f(cy + 1)} {f(cx + reach * .92)},{f(cy + 4)} {f(cx + reach)},{f(cy + h * .72)} "
            f"M{f(cx - 4)},{f(cy)} C{f(cx - reach * .7)},{f(cy + 1)} {f(cx - reach * .92)},{f(cy + 4)} {f(cx - reach)},{f(cy + h * .72)}")
    return [
        f'<path class="ac" d="{body}"/>',
        f'<path class="lnt" d="{lace}"/>',
        f'<ellipse class="kn" cx="{f(cx)}" cy="{f(top)}" rx="{f(w)}" ry="3.4"/>',
        f'<ellipse class="kn" cx="{f(cx)}" cy="{f(bot)}" rx="{f(w)}" ry="3.4"/>',
        f'<rect class="fl" x="{f(cx - 4)}" y="{f(cy - 2.6)}" width="8" height="5.2" rx="1.5"/>',
        f'<path class="lnt" d="{cord}"/>',
        f'<circle class="fl" cx="{f(cx + reach)}" cy="{f(cy + h * .72 + 2.2)}" r="2.4"/>',
        f'<circle class="fl" cx="{f(cx - reach)}" cy="{f(cy + h * .72 + 2.2)}" r="2.4"/>',
    ]


# ------------------------------------------------------------------ deities
def surya():
    g = frame()
    for k in range(12):
        th = -90 + k * 30
        tip, b1, b2 = pol(100, 100, 74, th), pol(100, 100, 41, th - 7.5), pol(100, 100, 41, th + 7.5)
        g.append(f'<path class="ac" d="M{f(b1[0])},{f(b1[1])} L{f(tip[0])},{f(tip[1])} L{f(b2[0])},{f(b2[1])} Z"/>')
    for k in range(12):
        th = math.radians(-90 + 15 + k * 30)
        px, py = -math.sin(th), math.cos(th)
        line = []
        for i in range(25):
            t = i / 24
            r = 42 + 22 * t
            off = 2.8 * math.sin(t * 2 * math.pi * 1.5) * (1 - .35 * t)
            line.append((100 + r * math.cos(th) + px * off, 100 + r * math.sin(th) + py * off))
        g.append(f'<path class="ln" d="M{pts(line)}"/>')
    g.append('<circle class="ac2" cx="100" cy="100" r="35"/>')
    g.append('<circle class="lnt" cx="100" cy="100" r="28.5"/>')
    spokes = []
    for k in range(16):
        a, b = pol(100, 100, 7, k * 22.5), pol(100, 100, 28.5, k * 22.5)
        spokes.append(f"M{f(a[0])},{f(a[1])} L{f(b[0])},{f(b[1])}")
    g.append(f'<path class="ln" style="stroke-width:1.2" d="{" ".join(spokes[1::2])}"/>')
    g.append(f'<path class="ln" d="{" ".join(spokes[0::2])}"/>')
    g.append('<circle class="kn" cx="100" cy="100" r="7"/>')
    g.append('<circle class="fl" cx="100" cy="100" r="2.6"/>')
    return g


def shiva():
    g = frame()
    g.append('<clipPath id="clip-shiva"><circle cx="100" cy="100" r="91"/></clipPath>')
    kailash = "M4,178 L40,146 L54,154 L74,128 L90,142 L104,132 L130,108 L152,138 L166,130 L198,164 L198,200 L4,200 Z"
    snow = ("M122,116 L130,108 L139,121 L133,118 L129,124 L125,117 Z "
            "M68,136 L74,128 L81,137 L76,135 L73,139 Z")
    g.append(f'<g clip-path="url(#clip-shiva)"><path class="mt" d="{kailash}"/>'
             f'<path class="kn" style="stroke-width:1.2" d="{snow}"/></g>')
    g.append(crescent((47, 58), 17, (54, 52.5), 14.2))
    g += trishul(top=22, bottom=176)
    g += damaru(100, 118, w=14, h=14)
    return g


def vishnu():
    g = frame()
    # lotus below
    for rot, L, W in [(-62, 22, 7.5), (62, 22, 7.5), (-32, 28, 8.5), (32, 28, 8.5), (0, 33, 9.5)]:
        g.append(petal(100, 170, L, W, rot, "ac2"))
    g.append('<path class="ln" d="M80,170 Q100,178 120,170"/>')
    # namam
    g.append('<path class="ln" style="stroke-width:6.5" d="M89,58 L89,120 C89,134 111,134 111,120 L111,58"/>')
    g.append('<path class="acs" d="M100,63 L100,125"/>')
    # shankha: spire and whorls on top, the pink mouth opening toward the centre
    conch = ("M0,-40 C3,-37 6,-35 9,-33 C12,-31 14,-27 15,-22 C19,-10 19,7 13,19 "
             "C9,27 5,33 2.4,42 L-2.4,42 C-5,34 -9,27 -13,19 C-19,7 -19,-9 -15,-21 "
             "C-13,-27 -10,-31 -7,-34 C-4,-36 -2,-38 0,-40 Z")
    whorls = ("M-13,-25 C-6,-29.5 6,-29.5 14,-24 M-9,-32 C-4,-35 4,-35 9.5,-32 "
              "M-15,-17 C-7,-21.5 7,-21.5 15.5,-16")
    mouth = "M14,-12 C22,-2 21,14 10,25 C9,14 9,-2 14,-12 Z"
    g.append(f'<g transform="translate(51 97) rotate(-10)">'
             f'<path class="iv" d="{conch}"/><path class="lnt" d="{whorls}"/>'
             f'<path class="ac2" style="stroke-width:1.4" d="{mouth}"/>'
             f'<path class="lnt" d="M-3,-14 C-6,0 -6,14 -2,30"/></g>')
    # sudarshana chakra
    cx, cy = 150, 95
    teeth = []
    for k in range(18):
        th = k * 20
        a, b, t = pol(cx, cy, 21, th - 7), pol(cx, cy, 21, th + 7), pol(cx, cy, 29, th + 3)
        teeth.append(f"M{f(a[0])},{f(a[1])} Q{f(t[0])},{f(t[1])} {f(b[0])},{f(b[1])} Z")
    g.append(f'<path class="ac" style="stroke-width:1.3" d="{" ".join(teeth)}"/>')
    g.append(f'<circle class="iv" cx="{cx}" cy="{cy}" r="21"/>')
    g.append(f'<circle class="lnt" cx="{cx}" cy="{cy}" r="15.5"/>')
    sp = []
    for k in range(8):
        a, b = pol(cx, cy, 4.5, k * 45 + 22.5), pol(cx, cy, 15.5, k * 45 + 22.5)
        sp.append(f"M{f(a[0])},{f(a[1])} L{f(b[0])},{f(b[1])}")
    g.append(f'<path class="ln" style="stroke-width:1.8" d="{" ".join(sp)}"/>')
    g.append(f'<circle class="ac" cx="{cx}" cy="{cy}" r="4.5"/>')
    return g


def ganesha():
    g = frame()
    ear_l = ("M80,66 C62,52 38,60 37,86 C36,108 54,122 70,114 "
             "C77,110 82,105 86,99 C84,88 82,77 80,66 Z")
    ear_r = mirror(ear_l)
    g.append(f'<path class="ac2" d="{ear_l}"/>')
    g.append(f'<path class="ac2" d="{ear_r}"/>')
    g.append('<path class="lnt" d="M76,74 C62,66 48,72 48,88 C48,100 58,108 68,105"/>')
    g.append(f'<path class="lnt" d="{mirror("M124,74 C138,66 152,72 152,88 C152,100 142,108 132,105")}"/>')
    face = ("M78,63 L122,63 C123,76 121,90 114,100 C110,105 90,105 86,100 C79,90 77,76 78,63 Z")
    g.append(f'<path class="ac" d="{face}"/>')
    trunk = "M100,98 C99,116 95,134 101,148 C106,158 120,158 124,149 C127,142 121,136 115,140"
    g.append(tube(trunk, outer=13, inner=8.4, cls_in="tube-ac"))
    g.append('<path class="iv" d="M108,99 C118,102 126,110 129,122 C122,115 115,110 105,106 Z"/>')
    g.append('<path class="iv" d="M92,99 C88,100 85.5,102 84.5,105.5 L90,104.5 Z"/>')
    g.append('<path class="ln" d="M84,83 Q89.5,87.5 95,83 M105,83 Q110.5,87.5 116,83"/>')
    g.append('<path class="ln" style="stroke-width:1.6" d="M89,69.5 L111,69.5 M90.5,74 L109.5,74"/>')
    g.append('<circle class="acd" cx="100" cy="78" r="2.4"/>')
    crown = ("M77,64 L123,64 L121,52 C119,42 110,35 100,25 C90,35 81,42 79,52 Z")
    g.append(f'<path class="iv" d="{crown}"/>')
    g.append('<path class="lnt" d="M79.5,56 L120.5,56 M84,47 L116,47"/>')
    g.append('<circle class="ac" cx="100" cy="41" r="4"/>')
    g.append('<circle class="fl" cx="100" cy="22" r="2.6"/>')
    return g


def hanuman():
    g = frame()
    # his tail rises behind the gada and curls over at the top
    tail = ("M52,160 C64,146 84,140 104,139 C134,137 156,124 158,98 "
            "C160,74 151,55 136,51 C124,48 119,61 127,65 C133,68 139,61 135,56")
    g.append(tube(tail, outer=8.5, inner=4.8))
    # gada: fluted head, collar, handle, pommel
    g.append('<rect class="iv" x="96.4" y="104" width="7.2" height="66" rx="2.5"/>')
    for y in (118, 138, 158):
        g.append(f'<rect class="ac" x="94.6" y="{y}" width="10.8" height="5" rx="1.8"/>')
    g.append('<circle class="ac" cx="100" cy="176" r="6.5"/>')
    g.append('<path class="ac" d="M89,100 L111,100 L108,108 L92,108 Z"/>')
    g.append('<ellipse class="ac" cx="100" cy="70" rx="25" ry="30"/>')
    ribs = []
    for k in (-0.62, -0.25, 0.25, 0.62):
        ribs.append(f"M100,41 Q{f(100 + 25 * k * 1.55)},70 100,99")
    g.append(f'<path class="lnt" d="{" ".join(ribs)}"/>')
    g.append('<path class="lnt" d="M78,58 Q100,64 122,58 M78,82 Q100,88 122,82"/>')
    g.append('<rect class="iv" x="91" y="37.5" width="18" height="6" rx="2.5"/>')
    g.append('<path class="iv" d="M95.5,38 L100,24 L104.5,38 Z"/>')
    g.append('<circle class="fl" cx="100" cy="22" r="2.6"/>')
    return g


def kali():
    g = frame()
    for k in range(16):
        th = k * 22.5 - 90
        x, y = pol(100, 100, 69, th)
        g.append(flame(x, y, 20, th + 90))
    # khadga: broad curved blade, crossguard, grip, pommel
    blade = ("M95.5,142 C94,120 88,98 86,76 C84.5,60 89,46 101,33 "
             "C112,44 120,58 118,76 C116,96 107,118 104.5,142 Z")
    g.append(f'<path class="iv" d="{blade}"/>')
    g.append('<path class="lnt" d="M100,138 C99,112 96,86 99,50"/>')
    g.append('<path class="ln" d="M91,74 Q101,64 111,74 Q101,84 91,74 Z"/>')
    g.append('<circle class="ac" cx="101" cy="74" r="3.6"/>')
    g.append('<path class="ac" d="M84,144 Q100,136 116,144 L116,149.5 Q100,142 84,149.5 Z"/>')
    g.append('<rect class="iv" x="96.8" y="149" width="6.4" height="19" rx="2"/>')
    g.append('<path class="lnt" d="M96.8,155 L103.2,155 M96.8,161 L103.2,161"/>')
    g.append('<circle class="ac" cx="100" cy="172" r="5"/>')
    # jaba -- the red hibiscus offered to her
    hx, hy = 64, 146
    for k in range(5):
        g.append(petal(hx, hy, 17, 9.5, k * 72 - 18, "ac"))
    g.append(f'<path class="ln" style="stroke-width:1.6" d="M{hx},{hy} Q{hx + 10},{hy - 8} {hx + 17},{hy - 18}"/>')
    for (dx, dy) in [(17, -18), (14.5, -20), (19, -15.5)]:
        g.append(f'<circle class="fl" cx="{f(hx + dx)}" cy="{f(hy + dy)}" r="1.5"/>')
    return g


def bhairav():
    g = frame()
    g.append(crescent((152, 52), 13, (157.5, 47.5), 11))
    g += trishul(dx=-26, top=24, bottom=176, s=0.9)
    g += damaru(74, 116, w=11.5, h=11.5)
    # the dog at his feet: seated, facing the trishul
    dog = ("M-16,0 L-6,0 C-6,-8 -5,-17 -4,-25 C0,-19 4,-7 8,0 L27,0 "
           "C33,-2 35,-11 31,-21 C29,-29 23,-38 17,-44 C13,-48 9,-52 7,-58 "
           "C7,-62 9,-68 8,-75 L3,-66 L-1,-77 C-3,-70 -5,-66 -8,-64 "
           "C-14,-62 -20,-60 -26,-58 C-28.5,-56 -28.5,-52.5 -25.5,-51.5 "
           "C-20,-50.5 -14,-50 -10,-46 C-12,-40 -14,-32 -14,-24 "
           "C-14,-16 -15,-8 -16,0 Z")
    g.append(f'<g transform="translate(138 178)">'
             f'<path class="tube-out" style="stroke-width:5" d="M29,-4 C42,-4 47,-16 40,-25"/>'
             f'<path class="fl dog" d="{dog}"/>'
             f'<path class="acn" d="M-11,-47.5 C-4,-43 3,-44 8,-50.5 L7.4,-54.5 C3,-49 -4,-48 -10.4,-52 Z"/>'
             f'<circle class="acn" cx="-3" cy="-43.6" r="2.2"/>'
             f'</g>')
    return g


DEITIES = [
    ("surya", "Surya", surya),
    ("shiva", "Shiva", shiva),
    ("hanuman", "Hanuman", hanuman),
    ("ganesha", "Ganesha", ganesha),
    ("vishnu", "Vishnu", vishnu),
    ("kali", "Kali Mata", kali),
    ("bhairav", "Kal Bhairav", bhairav),
]


def main():
    OUT.mkdir(exist_ok=True)
    for key, name, fn in DEITIES:
        body = "\n  ".join(fn())
        svg = (f'<svg class="deity deity-{key}" viewBox="0 0 200 200" role="img" '
               f'aria-label="{name}" xmlns="http://www.w3.org/2000/svg">\n  {body}\n</svg>\n')
        (OUT / f"{key}.svg").write_text(svg, encoding="utf-8")
        print("wrote", OUT / f"{key}.svg", len(svg), "bytes")


if __name__ == "__main__":
    main()
