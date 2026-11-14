"""Regenerate the PNG icons from the artwork in client/public/icon.svg (same geometry, drawn with Pillow).
Run: python scripts/make-icons.py   (needs Pillow). No other tooling is required."""
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'client' / 'public'
BLUE, WHITE, GOLD = (47, 108, 181, 255), (255, 255, 255, 255), (242, 176, 30, 255)
SS = 4  # supersampling


def arc(p0, rx, ry, large, sweep, p1, n=24):
    """SVG endpoint arc (no rotation) as points, per the SVG implementation notes."""
    x1, y1 = p0
    x2, y2 = p1
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    lam = (dx / rx) ** 2 + (dy / ry) ** 2
    if lam > 1:
        rx *= math.sqrt(lam)
        ry *= math.sqrt(lam)
    num = rx**2 * ry**2 - rx**2 * dy**2 - ry**2 * dx**2
    den = rx**2 * dy**2 + ry**2 * dx**2
    co = math.sqrt(max(0, num / den)) * (-1 if large == sweep else 1)
    cx_, cy_ = co * rx * dy / ry, -co * ry * dx / rx
    cx, cy = cx_ + (x1 + x2) / 2, cy_ + (y1 + y2) / 2
    a1 = math.atan2((dy - cy_) / ry, (dx - cx_) / rx)
    a2 = math.atan2((-dy - cy_) / ry, (-dx - cx_) / rx)
    d = a2 - a1
    if sweep and d < 0:
        d += 2 * math.pi
    if not sweep and d > 0:
        d -= 2 * math.pi
    return [(cx + rx * math.cos(a1 + d * i / n), cy + ry * math.sin(a1 + d * i / n)) for i in range(1, n + 1)]


def poly_slab():
    return [(3, 2.5), (11, 9.5), (11, 30), (3, 30)]


def poly_gold():
    pts = [(13, 2.5), (18, 2.5)]
    pts += arc(pts[-1], 13.5, 13.5, 0, 1, (27.6, 25.5))
    pts.append((27.6 - 4.2, 25.5 - 10.3))
    pts += arc(pts[-1], 7.6, 7.6, 0, 0, (18, 8.6))
    pts.append((13, 8.6))
    return pts


def poly_r_top():
    pts = [(13, 10.6), (18, 10.6)]
    pts += arc(pts[-1], 4.7, 4.7, 0, 1, (18, 20))
    pts.append((13, 20))
    return pts


def poly_r_leg():
    pts = [(13, 22), (18, 22)]
    pts += arc(pts[-1], 9.5, 9.5, 0, 0, (23.6, 20.1))
    pts.append((23.6 + 3.2, 20.1 + 7.7))
    pts += arc(pts[-1], 13.4, 13.4, 0, 1, (18, 30))
    pts.append((13, 30))
    return pts


GLYPH = [(poly_slab(), WHITE), (poly_gold(), GOLD), (poly_r_top(), WHITE), (poly_r_leg(), WHITE)]


def draw_glyph(d, size, scale, offset, colour=None):
    for pts, col in GLYPH:
        d.polygon([(offset + x * scale * size / 512, offset + y * scale * size / 512) for x, y in pts], fill=colour or col)


def render(size, mode):
    s = size * SS
    if mode == 'any':  # rounded square, transparent corners (the SVG: rx 112 of 512)
        im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        ImageDraw.Draw(im).rounded_rectangle([0, 0, s - 1, s - 1], radius=112 * s / 512, fill=BLUE)
        draw_glyph(ImageDraw.Draw(im), s, 10, 96 * s / 512)
    elif mode == 'maskable':  # full bleed, glyph inside the safe zone
        im = Image.new('RGBA', (s, s), BLUE)
        draw_glyph(ImageDraw.Draw(im), s, 10, 96 * s / 512)
    elif mode == 'apple':  # opaque square, the system rounds it
        im = Image.new('RGBA', (s, s), BLUE)
        draw_glyph(ImageDraw.Draw(im), s, 10, 96 * s / 512)
    else:  # badge: white mark on transparent (the system tints it)
        im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        draw_glyph(ImageDraw.Draw(im), s, 12, 64 * s / 512, WHITE)
    return im.resize((size, size), Image.LANCZOS)


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
