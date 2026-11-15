"""The Mailloom mark: one geometry, every asset.

The mark is the Delpat 'D' redrawn on a clean grid (see mark() below). This script is its single
source. It writes:
  client/public/icon.svg, mark.svg                 vector icon (white tile) and the bare mark (favicon)
  client/public/icon-*.png, apple-touch-icon.png,  raster icons
  client/public/badge-96.png
  client/src/components/markPaths.ts               the same paths for Logo.tsx and LogoMotion.tsx

Run: python scripts/make-icons.py   (needs Pillow). Nothing else is required.
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'client' / 'public'
TS = ROOT / 'client' / 'src' / 'components' / 'markPaths.ts'

NAVY, BLUE, WHITE = '#28306E', '#3F7CBD', '#FFFFFF'
DARK_INK, DARK_BLUE = '#EAF1FB', '#5B9BE0'  # the mark on a dark surface


# ---------------------------------------------------------------- path building

def _arc_points(p0, r, sweep, p1, step=1.5):
    """Points along an SVG circular arc (small arc) from p0 to p1."""
    (x1, y1), (x2, y2) = p0, p1
    dx, dy = (x2 - x1) / 2, (y2 - y1) / 2
    d = math.hypot(dx, dy)
    r = max(r, d)
    h = math.sqrt(max(0.0, r * r - d * d))
    # centre lies to the left of travel for sweep=1 in SVG's y-down space
    sign = 1 if sweep else -1
    cx, cy = x1 + dx - sign * h * dy / d, y1 + dy + sign * h * dx / d
    a1, a2 = math.atan2(y1 - cy, x1 - cx), math.atan2(y2 - cy, x2 - cx)
    da = a2 - a1
    if sweep and da < 0:
        da += 2 * math.pi
    if not sweep and da > 0:
        da -= 2 * math.pi
    n = max(4, int(abs(da) * r / step))
    return [(cx + r * math.cos(a1 + da * i / n), cy + r * math.sin(a1 + da * i / n)) for i in range(1, n + 1)]


def _f(v):
    s = f'{v:.1f}'
    return s[:-2] if s.endswith('.0') else s


def build(nodes):
    """nodes: (point, corner_radius, arc) where arc = (radius, sweep) describes the edge leaving that
    node (None = straight). Returns (svg path data, polygon points). Corners are rounded only where
    two straight edges meet."""
    n = len(nodes)
    segs = []  # per node: (entry point, exit point, corner radius, corner sweep)
    for i, (p, r, _arc) in enumerate(nodes):
        prev, nxt = nodes[i - 1][0], nodes[(i + 1) % n][0]
        if r:
            u = (prev[0] - p[0], prev[1] - p[1])
            v = (nxt[0] - p[0], nxt[1] - p[1])
            lu, lv = math.hypot(*u), math.hypot(*v)
            u, v = (u[0] / lu, u[1] / lu), (v[0] / lv, v[1] / lv)
            theta = math.acos(max(-1, min(1, u[0] * v[0] + u[1] * v[1])))
            t = r / math.tan(theta / 2)
            a = (p[0] + u[0] * t, p[1] + u[1] * t)
            b = (p[0] + v[0] * t, p[1] + v[1] * t)
            cross = (-u[0]) * v[1] - (-u[1]) * v[0]
            segs.append((a, b, r, 1 if cross > 0 else 0))
        else:
            segs.append((p, p, 0, 0))
    d, pts = [], []
    a0 = segs[0][0]
    d.append(f'M{_f(a0[0])} {_f(a0[1])}')
    pts.append(a0)
    for i in range(n):
        a, b, r, sw = segs[i]
        if r:
            d.append(f'A{_f(r)} {_f(r)} 0 0 {sw} {_f(b[0])} {_f(b[1])}')
            pts += _arc_points(a, r, sw, b, step=0.5)
        arc = nodes[i][2]
        target = segs[(i + 1) % n][0]
        if arc:
            R, sweep = arc
            d.append(f'A{_f(R)} {_f(R)} 0 0 {sweep} {_f(target[0])} {_f(target[1])}')
            pts += _arc_points(b, R, sweep, target)
        elif i < n - 1:
            d.append(f'L{_f(target[0])} {_f(target[1])}')
            pts.append(target)
    d.append('Z')
    return ''.join(d), pts


def _line_circle(p, slope, c, r, lower):
    """Where the line x = p.x + slope * (y - p.y) meets the circle; `lower` picks the larger y."""
    # substitute x(y); solve the quadratic in y
    a = slope * slope + 1
    k = p[0] - slope * p[1] - c[0]
    b = 2 * (slope * k - c[1])
    cc = k * k + c[1] * c[1] - r * r
    disc = math.sqrt(b * b - 4 * a * cc)
    y = (-b + disc) / (2 * a) if lower else (-b - disc) / (2 * a)
    return (p[0] + slope * (y - p[1]), y)


# ---------------------------------------------------------------- the mark

def mark(gap=48, radius=16, split=0):
    """The Delpat 'D' on a clean grid, 790 x 720 units.

    One centre for every curve, one gap width between every piece, one corner radius.
      slab     the navy upright, its top cut on a slant that lands level with the bowl's inner edge
      bowl     the blue upper-right of the D
      counter  the navy half-round inside
      lower    the navy lower-right of the D, meeting the bowl on a diagonal
    `split` opens a gap along that diagonal too (used for the one-colour badge, where the two tones
    cannot tell the pieces apart).
    """
    H, SLAB_W, STEM = 720, 250, 140
    R_OUT, R_RING = 360, 140
    left = SLAB_W + gap
    c = (left + STEM, H / 2)
    r_counter = R_RING - gap
    # The diagonal: same lean as the original, ending 48 degrees round the outer edge.
    slope = 0.4
    end = (c[0] + R_OUT * math.cos(math.radians(48)), c[1] + R_OUT * math.sin(math.radians(48)))

    def diag(offset):
        """Inner and outer ends of the diagonal, moved `offset` units towards the bowl."""
        k = offset * math.hypot(1, slope)
        p = (end[0] + k, end[1])
        return _line_circle(p, slope, c, R_RING, True), _line_circle(p, slope, c, R_OUT, True)

    # No split: the bowl tucks 6 units under the lower piece, so no hairline seam shows between them.
    # Split: the gap is taken out of the lower piece (the bowl's end cannot move outwards past the ring).
    bi, bo = diag(0 if split else -6)
    li, lo = diag(-split)
    slab = build([((0, 0), radius, None), ((SLAB_W, R_OUT - R_RING), radius, None),
                  ((SLAB_W, H), radius, None), ((0, H), radius, None)])
    bowl = build([((left, 0), radius, None), ((c[0], 0), 0, (R_OUT, 1)), (bo, 0, None),
                  (bi, 0, (R_RING, 0)), ((c[0], c[1] - R_RING), 0, None), ((left, c[1] - R_RING), radius, None)])
    counter = build([((left, c[1] - r_counter), radius, None), ((c[0], c[1] - r_counter), 0, (r_counter, 1)),
                     ((c[0], c[1] + r_counter), 0, None), ((left, c[1] + r_counter), radius, None)])
    lower = build([((left, c[1] + R_RING), radius, None), ((c[0], c[1] + R_RING), 0, (R_RING, 0)),
                   (li, 0, None), (lo, 0, (R_OUT, 1)), ((c[0], H), 0, None), ((left, H), radius, None)])
    return {
        'w': c[0] + R_OUT, 'h': H, 'c': c, 'r_out': R_OUT, 'r_ring': R_RING, 'r_counter': r_counter,
        'bowl_end': math.degrees(math.atan2(bo[1] - c[1], bo[0] - c[0])),
        'lower_start': math.degrees(math.atan2(li[1] - c[1], li[0] - c[0])),
        'parts': [('slab', 'a', slab), ('bowl', 'b', bowl), ('counter', 'a', counter), ('lower', 'a', lower)],
    }


MARK = mark()
BADGE_MARK = mark(gap=56, radius=16, split=56)  # wider gaps: the badge is drawn at 24 px


# ---------------------------------------------------------------- raster

def _rgb(hex_):
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def draw_mark(im, m, x, y, scale, a, b):
    d = ImageDraw.Draw(im)
    for _name, tone, (_d, pts) in m['parts']:
        d.polygon([(x + px * scale, y + py * scale) for px, py in pts], fill=_rgb(a if tone == 'a' else b))


def optical_centre(m):
    """Centre of the mark's ink, so it sits balanced on a tile (the slab side is heavier)."""
    s = 0.25
    im = Image.new('RGBA', (int(m['w'] * s) + 2, int(m['h'] * s) + 2), (0, 0, 0, 0))
    draw_mark(im, m, 0, 0, s, WHITE, WHITE)
    alpha = im.getchannel('A')
    w, h = alpha.size
    px = alpha.load()
    sx = sy = n = 0
    for yy in range(h):
        for xx in range(w):
            if px[xx, yy]:
                sx += xx
                sy += yy
                n += 1
    return sx / n / s, sy / n / s


def placement(m, size, width_frac):
    """Scale and offset that put the mark on a size x size tile: `width_frac` of the tile wide,
    placed halfway between its box centre and its ink centre."""
    scale = size * width_frac / m['w']
    ox, oy = optical_centre(m)
    cx = (m['w'] / 2 + ox) / 2
    cy = (m['h'] / 2 + oy) / 2
    return scale, size / 2 - cx * scale, size / 2 - cy * scale


ANY_FRAC, MASK_FRAC, TILE_RX = 0.62, 0.56, 0.234  # mark width on the tile; tile corner radius


def render(size, mode):
    ss = 8 if size <= 192 else 4
    s = size * ss
    if mode == 'any':  # white rounded tile, transparent corners
        im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        ImageDraw.Draw(im).rounded_rectangle([0, 0, s - 1, s - 1], radius=TILE_RX * s, fill=_rgb(WHITE))
        draw_mark(im, MARK, *_place(MARK, s, ANY_FRAC), NAVY, BLUE)
    elif mode == 'maskable':  # full bleed; the mark stays inside the 80% safe circle
        im = Image.new('RGBA', (s, s), _rgb(WHITE))
        draw_mark(im, MARK, *_place(MARK, s, MASK_FRAC), NAVY, BLUE)
    elif mode == 'apple':  # opaque square; iOS rounds it
        im = Image.new('RGBA', (s, s), _rgb(WHITE))
        draw_mark(im, MARK, *_place(MARK, s, ANY_FRAC), NAVY, BLUE)
    else:  # badge: white silhouette on transparent; Android tints it
        im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        draw_mark(im, BADGE_MARK, *_place(BADGE_MARK, s, 0.92), WHITE, WHITE)
    return im.resize((size, size), Image.LANCZOS)


def _place(m, size, frac):
    scale, x, y = placement(m, size, frac)
    return x, y, scale


def safe_zone_ok():
    """The maskable mark must sit inside a circle 80% of the icon wide."""
    scale, x, y = placement(MARK, 512, MASK_FRAC)
    far = max(math.hypot(x + px * scale - 256, y + py * scale - 256)
              for _n, _t, (_d, pts) in MARK['parts'] for px, py in pts)
    return far, far <= 0.4 * 512


# ---------------------------------------------------------------- vector

def svg_paths(m, a, b, indent='  '):
    return '\n'.join(f'{indent}<path class="{tone}" d="{d}" fill="{a if tone == "a" else b}"/>'
                     for _name, tone, (d, _pts) in m['parts'])


def write_svgs():
    scale, x, y = placement(MARK, 512, ANY_FRAC)
    icon = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
            f'  <rect width="512" height="512" rx="{TILE_RX * 512:.0f}" fill="{WHITE}"/>\n'
            f'  <g transform="translate({x:.2f} {y:.2f}) scale({scale:.5f})">\n'
            f'{svg_paths(MARK, NAVY, BLUE, "    ")}\n  </g>\n</svg>\n')
    (OUT / 'icon.svg').write_text(icon.replace(' class="a"', '').replace(' class="b"', ''), encoding='utf-8')
    pad = (MARK['w'] - MARK['h']) / 2
    bare = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {-pad:.0f} {MARK["w"]:.0f} {MARK["w"]:.0f}">\n'
            f'  <style>.a{{fill:{NAVY}}}.b{{fill:{BLUE}}}'
            f'@media (prefers-color-scheme:dark){{.a{{fill:{DARK_INK}}}.b{{fill:{DARK_BLUE}}}}}</style>\n'
            + '\n'.join(f'  <path class="{tone}" d="{d}"/>' for _n, tone, (d, _p) in MARK['parts'])
            + '\n</svg>\n')
    (OUT / 'mark.svg').write_text(bare, encoding='utf-8')


def write_ts():
    m = MARK
    parts = {name: d for name, _t, (d, _p) in m['parts']}
    TS.write_text(
        '// Generated by scripts/make-icons.py from the mark geometry. Do not edit by hand.\n'
        f'export const MARK_W = {m["w"]:.0f};\n'
        f'export const MARK_H = {m["h"]:.0f};\n'
        f'/** The one centre every curve of the D shares, and the middle of its counter. */\n'
        f'export const MARK_CX = {m["c"][0]:.0f};\n'
        f'export const MARK_CY = {m["c"][1]:.0f};\n'
        f'/** Radius and width of a stroke that covers the D\'s ring (used to sweep it in). */\n'
        f'export const RING_R = {(m["r_out"] + m["r_ring"]) / 2:.0f};\n'
        f'export const RING_W = {m["r_out"] - m["r_ring"] + 90:.0f};\n'
        f'/** Degrees clockwise from 3 o\'clock where the bowl ends and the lower piece starts. */\n'
        f'export const BOWL_END = {m["bowl_end"]:.1f};\n'
        f'export const LOWER_START = {m["lower_start"]:.1f};\n'
        + ''.join(f"export const {k.upper()} =\n  '{v}';\n" for k, v in parts.items()),
        encoding='utf-8')


if __name__ == '__main__':
    far, ok = safe_zone_ok()
    print(f'maskable: furthest ink {far:.1f}px from centre (limit 204.8) -> {"ok" if ok else "TOO BIG"}')
    assert ok
    write_svgs()
    write_ts()
    for name, size, mode in [
        ('icon-192.png', 192, 'any'), ('icon-512.png', 512, 'any'),
        ('icon-maskable-192.png', 192, 'maskable'), ('icon-maskable-512.png', 512, 'maskable'),
        ('apple-touch-icon.png', 180, 'apple'), ('badge-96.png', 96, 'badge'),
    ]:
        img = render(size, mode)
        if mode == 'apple':
            img = img.convert('RGB')
        img.save(OUT / name, optimize=True)
        print('wrote', name)
