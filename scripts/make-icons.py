"""The Mailloom mark: one geometry, every asset.

The mark is the Delpat logo redrawn on a clean grid (see mark() below): the navy slab with its slanted
top, the blue bowl, the navy counter and the lower piece. It is shown two ways:
  Aurora  the app icon: the mark in white, bowl in frosted white, on a navy-to-blue gradient tile
  Dusk    the mark inside the app: each piece carries a quiet gradient (see client/src/index.css)

This script is the single source. It writes:
  client/public/icon.svg                           the Aurora icon as a vector
  client/public/mark.svg                           the bare Dusk mark (favicon; goes light on dark tabs)
  client/public/icon-*.png, apple-touch-icon.png   raster icons (Aurora)
  client/public/badge-96.png                       notification badge: white, bowl half-clear
  client/src/components/markPaths.ts               the same paths for Logo.tsx and LogoMotion.tsx

Run: python scripts/make-icons.py   (needs Pillow). Nothing else is required.
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'client' / 'public'
TS = ROOT / 'client' / 'src' / 'components' / 'markPaths.ts'

WHITE = '#FFFFFF'
NAVY = '#28306E'  # Delpat navy: the launch screen behind the icon
# Aurora tile: top-left to bottom-right.
TILE_STOPS = [(0.0, '#232A66'), (0.45, '#2E4A9A'), (1.0, '#4A8FD6')]
FROST = 0.58  # opacity of the bowl on the Aurora tile and in the badge
# Dusk: gradient stops per piece, for light surfaces and for dark ones. Kept in step with index.css by brand.test.tsx.
DUSK = {
    'slab': ('#3A46A0', '#222960'), 'counter': ('#364195', '#262E6B'), 'lower': ('#2F3984', '#1E2458'),
    'bowl': ('#74B1F2', '#3F7CBD', '#2C63AC'),
}
DUSK_DARK = {
    'slab': ('#FFFFFF', '#D5E1F5'), 'counter': ('#F4F8FF', '#DCE7F8'), 'lower': ('#E6EEFB', '#C4D3EE'),
    'bowl': ('#8CC0F5', '#5B9BE0', '#3F7CBD'),
}


# ---------------------------------------------------------------- path building

def _arc_points(p0, r, sweep, p1, step=1.5):
    """Points along an SVG circular arc (small arc) from p0 to p1."""
    (x1, y1), (x2, y2) = p0, p1
    dx, dy = (x2 - x1) / 2, (y2 - y1) / 2
    d = math.hypot(dx, dy)
    r = max(r, d)
    h = math.sqrt(max(0.0, r * r - d * d))
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
    segs = []
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


def _hit(p0, d, c, r):
    """Furthest point along the ray p0 + t*d that lies on the circle (c, r)."""
    fx, fy = p0[0] - c[0], p0[1] - c[1]
    b = 2 * (fx * d[0] + fy * d[1])
    cc = fx * fx + fy * fy - r * r
    t = (-b + math.sqrt(b * b - 4 * cc)) / 2
    return (p0[0] + t * d[0], p0[1] + t * d[1])


def _reach(pts, o):
    d = [math.hypot(x - o[0], y - o[1]) for x, y in pts]
    return min(d), max(d)


def _span(pts, o):
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


# ---------------------------------------------------------------- the mark

def mark(gap=44, corner=14):
    """The Delpat mark on a clean grid, 794 x 720 units: one centre for every curve, one gap width, one
    corner radius.
      slab     the upright, its top cut on a slant that lands level with the bowl's inner edge
      bowl     the upper right of the D
      counter  the half-round inside
      lower    the lower right of the D, meeting the bowl on a diagonal
    """
    H, SLAB_W, SLANT, STEM, R_RING = 720, 250, 220, 140, 140
    R = H / 2
    left = SLAB_W + gap
    c = (left + STEM, R)
    rc = R_RING - gap
    top = c[1] - R_RING
    # The diagonal between the bowl and the lower piece leaves the ring 5.6 degrees below centre.
    n = math.hypot(0.4, 1)
    d = (0.4 / n, 1 / n)
    nrm = (d[1], -d[0])  # towards the bowl
    phi = math.radians(5.6)
    p_in = (c[0] + R_RING * math.cos(phi), c[1] + R_RING * math.sin(phi))

    def ends(off):
        p0 = (p_in[0] + nrm[0] * off - d[0] * 400, p_in[1] + nrm[1] * off - d[1] * 400)
        return _hit(p0, d, c, R_RING), _hit(p0, d, c, R)

    bi, bo = ends(-6)  # the bowl tucks 6 units under the lower piece, so no hairline seam shows
    li, lo = ends(0)
    slab = build([((0, 0), corner, None), ((SLAB_W, SLANT), corner, None), ((SLAB_W, H), corner, None), ((0, H), corner, None)])
    bowl = build([((left, 0), corner, None), ((c[0], 0), 0, (R, 1)), (bo, 0, None), (bi, 0, (R_RING, 0)),
                  ((c[0], top), 0, None), ((left, top), corner, None)])
    counter = build([((left, c[1] - rc), corner, None), ((c[0], c[1] - rc), 0, (rc, 1)),
                     ((c[0], c[1] + rc), 0, None), ((left, c[1] + rc), corner, None)])
    lower = build([((left, c[1] + R_RING), corner, None), ((c[0], c[1] + R_RING), 0, (R_RING, 0)), (li, 0, None),
                   (lo, 0, (R, 1)), ((c[0], H), 0, None), ((left, H), corner, None)])
    w = c[0] + R

    def sweep(pts):
        lo_r, hi_r = _reach(pts, c)
        start, deg = _span(pts, c)
        return {'r': (lo_r + hi_r) / 2, 'w': hi_r - lo_r + 24, 'from': start, 'sweep': deg}

    return {
        'w': w, 'h': H, 'c': c, 'split': d,
        'sweeps': {'bowl': sweep(bowl[1]), 'lower': sweep(lower[1])},
        'ring': {'r': (R_RING + R) / 2 + 20, 'w': R - R_RING + 90},
        # Dusk gradient lines (x1, y1, x2, y2), in mark units
        'grads': {'slab': (0, 0, 0, H), 'counter': (left, 250, c[0] + 90, 470), 'lower': (left, 480, w - 120, H),
                  'bowl': (left, 0, w - 60, 600)},
        # draw order: the bowl first, the lower piece covers its tucked edge
        'parts': [('bowl', bowl), ('slab', slab), ('counter', counter), ('lower', lower)],
    }


MARK = mark()
BADGE_MARK = mark(gap=58)  # wider gaps: the badge is drawn at 24 px


# ---------------------------------------------------------------- raster

def _rgb(hex_, a=255):
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5)) + (a,)


def tile_gradient(size):
    """The Aurora gradient, corner to corner. Drawn small and scaled up: it is smooth, so nothing is lost."""
    n = 96
    px = []
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            for (o0, c0), (o1, c1) in zip(TILE_STOPS, TILE_STOPS[1:]):
                if t <= o1:
                    k = (t - o0) / (o1 - o0)
                    a, b = _rgb(c0), _rgb(c1)
                    px.append(tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3)) + (255,))
                    break
    im = Image.new('RGBA', (n, n))
    im.putdata(px)
    return im.resize((size, size), Image.BICUBIC)


def white_mark(size, m, x, y, scale):
    """The mark in white on a clear layer, the bowl frosted."""
    layer = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    for name, (_d, pts) in m['parts']:
        piece = Image.new('L', (size, size), 0)
        ImageDraw.Draw(piece).polygon([(x + px * scale, y + py * scale) for px, py in pts], fill=255)
        if name == 'bowl':
            layer.putalpha(piece.point(lambda v: round(v * FROST)))
        else:
            layer.paste(_rgb(WHITE), (0, 0), piece)
    return layer


def optical_centre(m):
    """Centre of the mark's ink, so it sits balanced on a tile (the slab side is heavier)."""
    s = 0.25
    im = Image.new('L', (int(m['w'] * s) + 2, int(m['h'] * s) + 2), 0)
    d = ImageDraw.Draw(im)
    for _n, (_d, pts) in m['parts']:
        d.polygon([(px * s, py * s) for px, py in pts], fill=255)
    w, h = im.size
    px = im.load()
    sx = sy = n = 0
    for yy in range(h):
        for xx in range(w):
            if px[xx, yy]:
                sx += xx
                sy += yy
                n += 1
    return sx / n / s, sy / n / s


def placement(m, size, width_frac):
    """Offset and scale that put the mark on a size x size tile: `width_frac` of the tile wide,
    placed halfway between its box centre and its ink centre."""
    scale = size * width_frac / m['w']
    ox, oy = optical_centre(m)
    cx = (m['w'] / 2 + ox) / 2
    cy = (m['h'] / 2 + oy) / 2
    return size / 2 - cx * scale, size / 2 - cy * scale, scale


ANY_FRAC, MASK_FRAC, TILE_RX = 0.62, 0.55, 0.234  # mark width on the tile; tile corner radius


def render(size, mode):
    ss = 8 if size <= 192 else 4
    s = size * ss
    if mode == 'badge':  # white on clear; Android tints it, and the frosted bowl keeps the two tones
        im = white_mark(s, BADGE_MARK, *placement(BADGE_MARK, s, 0.94))
    else:
        im = tile_gradient(s)
        im.alpha_composite(white_mark(s, MARK, *placement(MARK, s, MASK_FRAC if mode == 'maskable' else ANY_FRAC)))
        if mode == 'any':  # rounded tile, clear corners
            mask = Image.new('L', (s, s), 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=TILE_RX * s, fill=255)
            im.putalpha(mask)
    return im.resize((size, size), Image.LANCZOS)


def safe_zone():
    """The maskable mark must sit inside a circle 80% of the icon wide."""
    x, y, scale = placement(MARK, 512, MASK_FRAC)
    return max(math.hypot(x + px * scale - 256, y + py * scale - 256) for _n, (_d, pts) in MARK['parts'] for px, py in pts)


# ---------------------------------------------------------------- vector

def write_svgs():
    m = MARK
    x, y, scale = placement(m, 512, ANY_FRAC)
    stops = ''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in TILE_STOPS)
    pieces = '\n'.join(f'    <path d="{d}" fill="{WHITE}"{f" fill-opacity=\"{FROST}\"" if name == "bowl" else ""}/>'
                       for name, (d, _p) in m['parts'])
    (OUT / 'icon.svg').write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
        f'  <defs><linearGradient id="t" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="512" y2="512">{stops}</linearGradient></defs>\n'
        f'  <rect width="512" height="512" rx="{TILE_RX * 512:.0f}" fill="url(#t)"/>\n'
        f'  <g transform="translate({x:.2f} {y:.2f}) scale({scale:.5f})">\n{pieces}\n  </g>\n</svg>\n', encoding='utf-8')

    # The bare Dusk mark. Stop colours are classes, so a dark tab gets the light variant.
    side = max(m['w'], m['h'])
    grads, css, dark = [], [], []
    for name, _ in m['parts']:
        x1, y1, x2, y2 = m['grads'][name]
        cols = DUSK[name]
        offs = (0, 1) if len(cols) == 2 else (0, 0.55, 1)
        grads.append(f'<linearGradient id="{name}" gradientUnits="userSpaceOnUse" x1="{x1:.0f}" y1="{y1:.0f}" x2="{x2:.0f}" y2="{y2:.0f}">'
                     + ''.join(f'<stop class="{name}{i}" offset="{o}"/>' for i, o in enumerate(offs)) + '</linearGradient>')
        css += [f'.{name}{i}{{stop-color:{c}}}' for i, c in enumerate(cols)]
        dark += [f'.{name}{i}{{stop-color:{c}}}' for i, c in enumerate(DUSK_DARK[name])]
    (OUT / 'mark.svg').write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{(m["w"] - side) / 2:.0f} {(m["h"] - side) / 2:.0f} {side:.0f} {side:.0f}">\n'
        f'  <style>{"".join(css)}@media (prefers-color-scheme:dark){{{"".join(dark)}}}</style>\n'
        f'  <defs>{"".join(grads)}</defs>\n'
        + '\n'.join(f'  <path d="{d}" fill="url(#{name})"/>' for name, (d, _p) in m['parts']) + '\n</svg>\n', encoding='utf-8')


def write_ts():
    m = MARK
    out = ['// Generated by scripts/make-icons.py from the mark geometry. Do not edit by hand.',
           f'export const MARK_W = {m["w"]:.0f};', f'export const MARK_H = {m["h"]:.0f};',
           '/** The one centre every curve of the D shares. */',
           f'export const MARK_CX = {m["c"][0]:.0f};', f'export const MARK_CY = {m["c"][1]:.0f};',
           '/**',
           ' * How to sweep a piece of the D in: a circle stroke about the centre (radius r, width w), starting',
           " * `from` degrees clockwise from 3 o'clock and covering `sweep` degrees.",
           ' */']
    for name, v in m['sweeps'].items():
        out.append(f'export const {name.upper()}_SWEEP = {{ r: {v["r"]:.0f}, w: {v["w"]:.0f}, from: {v["from"]:.1f}, sweep: {math.ceil(v["sweep"])} }};')
    out += ['/** A circle stroke that covers the whole ring of the D (bowl and lower piece). */',
            f'export const RING = {{ r: {m["ring"]["r"]:.0f}, w: {m["ring"]["w"]:.0f} }};',
            '/** Unit direction of the diagonal between the bowl and the lower piece (pointing down and right). */',
            f'export const SPLIT = {{ x: {m["split"][0]:.3f}, y: {m["split"][1]:.3f} }};',
            '/** Gradient lines for the Dusk fills, in mark units. */',
            'export const GRADS = {']
    out += [f'  {name}: {{ x1: {g[0]:.0f}, y1: {g[1]:.0f}, x2: {g[2]:.0f}, y2: {g[3]:.0f} }},' for name, g in m['grads'].items()]
    out.append('} as const;')
    out += [f"export const {name.upper()} =\n  '{d}';" for name, (d, _p) in m['parts']]
    TS.write_text('\n'.join(out) + '\n', encoding='utf-8')


if __name__ == '__main__':
    far = safe_zone()
    print(f'maskable: furthest ink {far:.1f}px from centre (limit 204.8)')
    assert far <= 0.4 * 512
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
