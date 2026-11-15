"""The Mailloom mark: one geometry, every asset.

The mark is a D and a P for Delpat: a navy P, whose stem is the Delpat slab with its slanted top, standing
inside a blue D (see mark() below). This script is its single source. It writes:
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


# ---------------------------------------------------------------- the mark

def mark(gap=46, radius=10):
    """A P inside a D, 690 x 720 units.

      slab   the navy stem of the P: the Delpat slab, its top cut on a slant
      pbowl  the navy bowl of the P; its top edge carries on from the foot of the slant
      dband  the blue D: one band that starts as an arm lying over the slant (cut parallel to it),
             runs round the P and comes back to the stem at the foot

    The D keeps one gap width from the stem, from the slant and from the top of the P.
    """
    H, SLAB_W = 720, 170
    BAND, R_OUT = 124, 360          # the D: band thickness and outer radius
    P_R, P_BAND = 160, 104          # the P bowl: outer radius and band thickness
    c = (330, H / 2)                # centre of the D
    r_in = R_OUT - BAND
    left = SLAB_W + gap             # where the D band comes back to the stem
    top = BAND + gap                # top of the P bowl = foot of the slant
    pc = (c[0], top + P_R)          # centre of the P bowl
    tuck = 6                        # the bowl tucks into the stem, so no hairline seam shows
    # The arm of the D ends on a line parallel to the slant, one gap away from it.
    slant_len = math.hypot(SLAB_W, top)
    arm0 = gap * slant_len / top                      # at y = 0
    arm1 = (gap * slant_len + SLAB_W * BAND) / top    # at y = BAND

    slab = build([((0, 0), radius, None), ((SLAB_W, top), 0, None),
                  ((SLAB_W, H), radius, None), ((0, H), radius, None)])
    pbowl = build([((SLAB_W - tuck, top), 0, None), ((pc[0], top), 0, (P_R, 1)),
                   ((pc[0], top + 2 * P_R), 0, None), ((SLAB_W - tuck, top + 2 * P_R), 0, None),
                   ((SLAB_W - tuck, pc[1] + P_R - P_BAND), 0, None), ((pc[0], pc[1] + P_R - P_BAND), 0, (P_R - P_BAND, 0)),
                   ((pc[0], pc[1] - P_R + P_BAND), 0, None), ((SLAB_W - tuck, pc[1] - P_R + P_BAND), 0, None)])
    dband = build([((arm0, 0), radius * 0.6, None), ((c[0], 0), 0, (R_OUT, 1)), ((c[0], H), 0, None),
                   ((left, H), radius, None), ((left, H - BAND), radius, None), ((c[0], H - BAND), 0, (r_in, 0)),
                   ((c[0], BAND), 0, None), ((arm1, BAND), radius, None)])

    def reach(pts, o):
        d = [math.hypot(x - o[0], y - o[1]) for x, y in pts]
        return min(d), max(d)

    def span(pts, o):
        """Where a clockwise sweep about `o` must start, and how far it must go, to pass over every point:
        it starts just after the widest empty angle."""
        dense = []  # straight edges have a point only at each end, so walk along them
        for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
            n = max(1, int(math.hypot(x1 - x0, y1 - y0) / 3))
            dense += [(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(n)]
        angs = sorted(math.degrees(math.atan2(y - o[1], x - o[0])) % 360 for x, y in dense)
        gaps = [((angs[(i + 1) % len(angs)] - a) % 360, i) for i, a in enumerate(angs)]
        widest, i = max(gaps)
        start = angs[(i + 1) % len(angs)] - 4
        return (start + 180) % 360 - 180, 360 - widest + 8

    # Sweeps (for the motion): a thick circle stroke, clipped to the piece, drawn clockwise from `from`.
    d_lo, d_hi = reach(dband[1], c)
    d_from, d_sweep = span(dband[1], c)
    p_lo, p_hi = reach(pbowl[1], pc)
    p_from, p_sweep = span(pbowl[1], pc)
    return {
        'w': c[0] + R_OUT, 'h': H,
        'd': {'c': c, 'r': (d_lo + d_hi) / 2, 'w': d_hi - d_lo + 24, 'from': d_from, 'sweep': d_sweep},
        'p': {'c': pc, 'r': (p_hi + 12) / 2, 'w': p_hi + 12, 'from': p_from, 'sweep': p_sweep},
        'parts': [('dband', 'b', dband), ('slab', 'a', slab), ('pbowl', 'a', pbowl)],
    }


MARK = mark()
BADGE_MARK = mark(gap=62)  # wider gaps: the badge is drawn at 24 px, in one colour


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


ANY_FRAC, MASK_FRAC, TILE_RX = 0.60, 0.52, 0.234  # mark width on the tile; tile corner radius


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
    side = max(MARK['w'], MARK['h'])
    bare = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{(MARK["w"] - side) / 2:.0f} {(MARK["h"] - side) / 2:.0f} {side:.0f} {side:.0f}">\n'
            f'  <style>.a{{fill:{NAVY}}}.b{{fill:{BLUE}}}'
            f'@media (prefers-color-scheme:dark){{.a{{fill:{DARK_INK}}}.b{{fill:{DARK_BLUE}}}}}</style>\n'
            + '\n'.join(f'  <path class="{tone}" d="{d}"/>' for _n, tone, (d, _p) in MARK['parts'])
            + '\n</svg>\n')
    (OUT / 'mark.svg').write_text(bare, encoding='utf-8')


def write_ts():
    m = MARK
    parts = {name: d for name, _t, (d, _p) in m['parts']}
    out = ['// Generated by scripts/make-icons.py from the mark geometry. Do not edit by hand.',
           f'export const MARK_W = {m["w"]:.0f};', f'export const MARK_H = {m["h"]:.0f};',
           '/**',
           ' * How to sweep a piece in: a circle stroke (centre cx/cy, radius r, width w) clipped to the piece,',
           ' * starting `from` degrees clockwise from 3 o\'clock and covering `sweep` degrees.',
           ' */']
    for key, name in (('d', 'D_SWEEP'), ('p', 'P_SWEEP')):
        v = m[key]
        out.append(f'export const {name} = {{ cx: {v["c"][0]:.0f}, cy: {v["c"][1]:.0f}, r: {v["r"]:.0f}, w: {v["w"]:.0f}, '
                   f'from: {v["from"]:.1f}, sweep: {math.ceil(v["sweep"])} }};')
    out += [f"export const {k.upper()} =\n  '{v}';" for k, v in parts.items()]
    TS.write_text('\n'.join(out) + '\n', encoding='utf-8')


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
