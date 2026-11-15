"""Round 3: eight evolutions of the original Delpat mark. Writes SVGs and two boards into icon4/."""
import importlib.util, json, math, sys
from pathlib import Path
from PIL import Image
HERE = Path(__file__).parent
OUT = HERE / 'icon4'; OUT.mkdir(exist_ok=True)
_spec = importlib.util.spec_from_file_location('mk', r"D:/Work/Delpat/projects/mailloom-B/scripts/make-icons.py")
mk = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(mk)
build = lambda nodes: mk.build(nodes)[0]
NAVY, BLUE = '#28306E', '#3F7CBD'

def hit(p0, d, c, r):
    """Furthest point along the ray p0 + t*d that lies on the circle (c, r)."""
    fx, fy = p0[0] - c[0], p0[1] - c[1]
    b = 2 * (fx * d[0] + fy * d[1]); cc = fx * fx + fy * fy - r * r
    t = (-b + math.sqrt(b * b - 4 * cc)) / 2
    return (p0[0] + t * d[0], p0[1] + t * d[1])

def geometry(slab_w=250, slant_y=220, gap=44, stem=140, r_ring=140, corner=12, split='orig', split_gap=0,
             merged=False, chamfer=None, H=720):
    R = H / 2
    L = slab_w + gap
    c = (L + stem, R)
    rc = r_ring - gap
    top = c[1] - r_ring
    # the split between the bowl and the lower piece: a line leaving the ring at angle phi in direction d
    if split == 'aligned':
        n = math.hypot(slab_w, slant_y); d = (slab_w / n, slant_y / n); phi = math.radians(14)
    else:
        n = math.hypot(0.4, 1); d = (0.4 / n, 1 / n); phi = math.radians(5.6)
    nrm = (d[1], -d[0])  # towards the bowl
    p_in = (c[0] + r_ring * math.cos(phi), c[1] + r_ring * math.sin(phi))
    def ends(off):
        p0 = (p_in[0] + nrm[0] * off - d[0] * 400, p_in[1] + nrm[1] * off - d[1] * 400)
        return hit(p0, d, c, r_ring), hit(p0, d, c, R)
    bi, bo = ends(split_gap / 2 if split_gap else -6)
    li, lo = ends(-split_gap / 2 if split_gap else 0)
    a_li = math.atan2(li[1] - c[1], li[0] - c[0]); lc = (c[0] + rc * math.cos(a_li), c[1] + rc * math.sin(a_li))
    g = {'w': c[0] + R, 'h': H, 'c': c, 'R': R, 'r_ring': r_ring, 'split': (li, lo), 'd': d, 'nrm': nrm, 'slab_w': slab_w, 'slant_y': slant_y, 'L': L}
    g['slab'] = build([((0, 0), corner, None), ((slab_w, slant_y), corner, None), ((slab_w, H), corner, None), ((0, H), corner, None)])
    bowl_start = [((L, 0), corner, None)] if not chamfer else [((L, chamfer[1]), corner, None), ((L + chamfer[0], 0), corner, None)]
    g['bowl'] = build(bowl_start + [((c[0], 0), 0, (R, 1)), (bo, 0, None), (bi, 0, (r_ring, 0)), ((c[0], top), 0, None), ((L, top), corner, None)])
    if merged:
        g['inner'] = build([((L, c[1] - rc), corner, None), ((c[0], c[1] - rc), 0, (rc, 1)), (lc, 0, None), (lo, 0, (R, 1)),
                            ((c[0], H), 0, None), ((L, H), corner, None)])
    else:
        g['counter'] = build([((L, c[1] - rc), corner, None), ((c[0], c[1] - rc), 0, (rc, 1)), ((c[0], c[1] + rc), 0, None), ((L, c[1] + rc), corner, None)])
        g['lower'] = build([((L, c[1] + r_ring), corner, None), ((c[0], c[1] + r_ring), 0, (r_ring, 0)), (li, 0, None), (lo, 0, (R, 1)),
                            ((c[0], H), 0, None), ((L, H), corner, None)])
    return g

def lin(i, x1, y1, x2, y2, stops, units='userSpaceOnUse'):
    s = ''.join(f'<stop offset="{o}" stop-color="{col}"{f" stop-opacity=\"{op}\"" if op is not None else ""}/>' for o, col, op in [(a[0], a[1], a[2] if len(a) > 2 else None) for a in stops])
    return f'<linearGradient id="{i}" gradientUnits="{units}" x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}">{s}</linearGradient>'

def flat(g, a=NAVY, b=BLUE, bowl_op=1):
    navy = ''.join(f'<path d="{g[k]}" fill="{a}"/>' for k in ('counter', 'lower', 'inner') if k in g)
    return '', f'<path d="{g["bowl"]}" fill="{b}"{f" fill-opacity=\"{bowl_op}\"" if bowl_op != 1 else ""}/><path d="{g["slab"]}" fill="{a}"/>{navy}'

# ---- the eight
def v1(u):
    g = geometry(slab_w=276, slant_y=196, gap=54, stem=112, r_ring=152, corner=26); return g, *flat(g), '#FFFFFF'
def v2(u):
    g = geometry(gap=44, corner=6, split='aligned', split_gap=44); return g, *flat(g), '#FFFFFF'
def v3(u):
    g = geometry(gap=20, r_ring=128, corner=3, stem=140)
    defs = lin(u + 'b', g['L'], 0, g['w'], g['h'] * 0.8, [(0, '#7DB5F0'), (1, '#3F7CBD')]) + lin(u + 't', 0, 0, 512, 512, [(0, '#2E3884'), (1, '#1B2154')])
    body = f'<path d="{g["bowl"]}" fill="url(#{u}b)"/>' + ''.join(f'<path d="{g[k]}" fill="#FFFFFF"/>' for k in ('slab', 'counter', 'lower'))
    return g, defs, body, f'url(#{u}t)'
def v4(u):
    g = geometry(gap=48, corner=22, merged=True); return g, *flat(g), '#FFFFFF'
def v5(u):
    g = geometry(gap=42, corner=14)
    defs = (lin(u + 's', 0, 0, 0, 720, [(0, '#3A46A0'), (1, '#222960')]) + lin(u + 'l', g['L'], 480, g['w'] - 120, 720, [(0, '#2F3984'), (1, '#1E2458')])
            + lin(u + 'c', g['L'], 250, g['c'][0] + 90, 470, [(0, '#364195'), (1, '#262E6B')])
            + lin(u + 'b', g['L'], 0, g['w'] - 60, 600, [(0, '#74B1F2'), (0.55, '#3F7CBD'), (1, '#2C63AC')])
            + lin(u + 't', 0, 0, 0, 512, [(0, '#FFFFFF'), (1, '#EAF1FB')]))
    body = f'<path d="{g["bowl"]}" fill="url(#{u}b)"/><path d="{g["slab"]}" fill="url(#{u}s)"/><path d="{g["counter"]}" fill="url(#{u}c)"/><path d="{g["lower"]}" fill="url(#{u}l)"/>'
    return g, defs, body, f'url(#{u}t)'
def v6(u):
    g = geometry(gap=40, corner=10)
    (lix, liy), (lox, loy) = g['split']; n = g['nrm']
    mx, my = (lix + lox) / 2, (liy + loy) / 2
    defs = (lin(u + 'sh', mx, my, mx - n[0] * 130, my - n[1] * 130, [(0, '#0B1040', 0.55), (1, '#0B1040', 0)])
            + lin(u + 'b', g['L'], 0, g['w'], 560, [(0, '#5FA2E8'), (1, '#356FB4')])
            + lin(u + 'f', 0, 0, g['slab_w'] * 0.55, g['slant_y'] * 1.3, [(0, '#5560B8'), (1, '#39449A')])
            + lin(u + 's', 0, g['slant_y'], 0, 720, [(0, '#2C3579'), (1, '#232A62')])
            + f'<clipPath id="{u}cl"><path d="{g["lower"]}"/></clipPath><clipPath id="{u}cs"><path d="{g["slab"]}"/></clipPath>')
    sw, sy = g['slab_w'], g['slant_y']
    fold = f'<g clip-path="url(#{u}cs)"><path d="M0 0L{sw} {sy}L0 {sy * 1.95:.0f}Z" fill="url(#{u}f)"/></g>'
    body = (f'<path d="{g["bowl"]}" fill="url(#{u}b)"/><path d="{g["slab"]}" fill="url(#{u}s)"/>{fold}<path d="{g["counter"]}" fill="{NAVY}"/>'
            f'<path d="{g["lower"]}" fill="{NAVY}"/><g clip-path="url(#{u}cl)"><rect width="{g["w"]}" height="720" fill="url(#{u}sh)"/></g>')
    return g, defs, body, '#FFFFFF'
def v7(u):
    g = geometry(slant_y=176, gap=44, corner=12, chamfer=(122, 108)); return g, *flat(g), '#FFFFFF'
def v8(u):
    g = geometry(gap=44, corner=14)
    defs = lin(u + 't', 0, 0, 512, 512, [(0, '#232A66'), (0.45, '#2E4A9A'), (1, '#4A8FD6')])
    body = f'<path d="{g["bowl"]}" fill="#FFFFFF" fill-opacity="0.58"/>' + ''.join(f'<path d="{g[k]}" fill="#FFFFFF"/>' for k in ('slab', 'counter', 'lower'))
    return g, defs, body, f'url(#{u}t)'

VARS = [
    ('1', 'Poise', v1, 'Stance: heavier slab, shallower slant, a more compact D, bold channels and soft corners.'),
    ('2', 'Aligned', v2, 'Gap language: the split now runs parallel to the slab\'s slant and opens into a channel; crisp corners.'),
    ('3', 'Hairline', v3, 'Precision: hair-thin gaps and sharp cuts, reversed to white with a blue bowl on a deep navy tile.'),
    ('4', 'Unified', v4, 'Simplification: the counter and the lower piece become one navy form; three pieces instead of four.'),
    ('5', 'Dusk', v5, 'Colour: each piece carries a quiet gradient (navy deepening downwards, the bowl lit from the top).'),
    ('6', 'Fold', v6, 'Dimension: the slab\'s slant becomes a folded facet and the bowl lays a soft shadow on the piece below.'),
    ('7', 'Flap', v7, 'Mail nod: the bowl\'s corner is cut to mirror the slant, so the top reads as an open envelope.'),
    ('8', 'Aurora', v8, 'Tile: the mark in white, bowl in frosted white, on a navy-to-blue gradient tile.'),
]

def icon_svg(key, fn, frac=0.62, rx=120, standalone=True):
    u = f'v{key}'
    g, defs, body, tile = fn(u)
    s = 512 * frac / g['w']
    # optical: nudge right a little, the slab side is heavier
    x = (512 - g['w'] * s) / 2 + 6; y = (512 - g['h'] * s) / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>{defs}</defs>'
            f'<rect width="512" height="512" rx="{rx}" fill="{tile}"/><g transform="translate({x:.1f} {y:.1f}) scale({s:.4f})">{body}</g></svg>')

def mark_svg(key, fn):
    u = f'm{key}'
    g, defs, body, tile = fn(u)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {g["w"]:.0f} {g["h"]:.0f}"><defs>{defs}</defs>{body}</svg>'

def original_tile():
    im = Image.open(r"D:/Work/Delpat/projects/cutroom/films/demos/brand/delpatlogo.png").convert('RGBA').crop((137, 0, 925, 714))
    S = 1024; t = Image.new('RGBA', (S, S), (255, 255, 255, 255))
    w = int(S * 0.62); h = int(w * im.height / im.width)
    t.alpha_composite(im.resize((w, h), Image.LANCZOS), ((S - w) // 2 + 12, (S - h) // 2))
    t.save(OUT / 'original-tile.png')

if __name__ == '__main__':
    original_tile()
    ranks = json.loads((HERE / 'ranks4.json').read_text()) if (HERE / 'ranks4.json').exists() else {}
    cards = []
    orig = '<img src="original-tile.png" style="width:100%;height:100%;border-radius:23.4%">'
    items = [('0', 'Original', None, 'The Delpat mark as it is today, traced from the logo file. Shown on the same white tile for a fair comparison.')] + VARS
    for key, name, fn, note in items:
        if fn:
            (OUT / f'v{key}-{name.lower()}-icon.svg').write_text(icon_svg(key, fn), encoding='utf-8')
            (OUT / f'v{key}-{name.lower()}-mark.svg').write_text(mark_svg(key, fn), encoding='utf-8')
            big = icon_svg(key, fn); small = icon_svg(key, fn).replace(f'v{key}', f's{key}'); small2 = icon_svg(key, fn).replace(f'v{key}', f'd{key}')
        else:
            big = small = small2 = orig
        r = ranks.get(key, {})
        badge = f'<span class="rank r{r["rank"]}">No. {r["rank"]}</span>' if r.get('rank') else ''
        cards.append(f'''<div class="card"><div class="head"><b>{key if fn else ""}{"&nbsp; " if fn else ""}{name}</b>{badge}</div>
          <div class="row"><div class="big">{big}</div>
            <div class="chips"><div class="chip light"><div class="t48">{small}</div><span>Mailloom</span></div>
            <div class="chip dark"><div class="t48">{small2}</div><span>Mailloom</span></div></div></div>
          <p class="note">{note}</p><p class="verdict">{r.get("verdict", "")}</p></div>''')
    css = '''body{margin:0;font-family:"Segoe UI",sans-serif;background:#EEF2F8;color:#28306E}
      h1{font-size:26px;margin:0;padding:26px 30px 6px} .sub{padding:0 30px 14px;font-size:15px;color:#444C7A}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:8px 24px 28px}
      .card{background:#fff;border-radius:20px;padding:20px 22px 14px;box-shadow:0 1px 2px rgba(40,48,110,.08)}
      .head{font-size:19px;display:flex;align-items:center;gap:12px;margin-bottom:14px}
      .rank{font-size:13px;font-weight:700;padding:3px 10px;border-radius:99px;color:#fff;background:#28306E}.r1{background:#1B6B3E}.r2{background:#3F7CBD}.r3{background:#566082}
      .row{display:flex;gap:22px;align-items:stretch}.big{width:300px;height:300px;flex:none;background:#DCE3EE;border-radius:26px;padding:34px;box-sizing:border-box;filter:none}
      .big svg,.big img{display:block;width:100%;height:100%;filter:drop-shadow(0 6px 14px rgba(20,28,80,.18))}
      .chips{display:flex;flex-direction:column;gap:12px;flex:1}.chip{flex:1;border-radius:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;font-size:11px}
      .chip.light{background:linear-gradient(160deg,#E6ECF5,#D3DCEA);color:#28306E}.chip.dark{background:linear-gradient(160deg,#1A1E2B,#0C0E15);color:#fff}
      .t48{width:48px;height:48px}.t48 svg,.t48 img{width:48px;height:48px;display:block}
      .note{font-size:14px;line-height:1.4;margin:14px 0 4px;color:#444C7A}.verdict{font-size:14px;line-height:1.4;margin:0 0 6px;font-weight:600;min-height:38px}'''
    html = f'<!doctype html><meta charset="utf-8"><style>{css}</style><h1>Delpat mark for Mailloom: eight evolutions</h1><div class="sub">Each starts from the original and changes one real design property. Large on its tile, then at 48 px on a light and a dark home screen.</div><div class="grid">{"".join(cards)}</div>'
    (OUT / 'variations.html').write_text(html, encoding='utf-8')
    top = [k for k, v in sorted(ranks.items(), key=lambda kv: kv[1].get('rank', 9)) if v.get('rank')]
    panels = ''
    for theme, bg, ink in (('Light home screen', 'linear-gradient(160deg,#EDF1F7,#CBD6E6)', '#28306E'), ('Dark home screen', 'linear-gradient(160deg,#1B2030,#0A0C12)', '#fff')):
        cols = ''
        for k in top:
            name, fn = next((n, f) for kk, n, f, _ in VARS if kk == k)
            sv = lambda p: icon_svg(k, fn).replace(f'v{k}', p + k)
            cols += f'''<div class="col"><div class="i192">{sv(theme[0] + "a")}</div>
              <div class="pair"><div><div class="i96">{sv(theme[0] + "b")}</div><span>Mailloom</span></div><div><div class="i48">{sv(theme[0] + "c")}</div><span>Mailloom</span></div></div>
              <b>No. {ranks[k]["rank"]} &nbsp;{name}</b></div>'''
        panels += f'<div class="panel" style="background:{bg};color:{ink}"><h2>{theme}</h2><div class="cols">{cols}</div></div>'
    css2 = '''body{margin:0;font-family:"Segoe UI",sans-serif}.panel{padding:26px 40px 40px}h2{margin:0 0 22px;font-size:20px}
      .cols{display:flex;gap:70px}.col{display:flex;flex-direction:column;align-items:center;gap:22px;font-size:15px}
      .i192{width:192px;height:192px}.i96{width:96px;height:96px}.i48{width:48px;height:48px}svg{width:100%;height:100%;display:block;filter:drop-shadow(0 4px 10px rgba(0,0,20,.22))}
      .pair{display:flex;gap:34px;align-items:flex-end;font-size:12px;text-align:center}.pair span{display:block;margin-top:6px}'''
    (OUT / 'top3.html').write_text(f'<!doctype html><meta charset="utf-8"><style>{css2}</style>{panels}', encoding='utf-8')
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge')
        pg = b.new_page(viewport={'width': 1740, 'height': 900}, device_scale_factor=1.5)
        pg.goto((OUT / 'variations.html').as_uri()); pg.screenshot(path=str(OUT / 'variations.png'), full_page=True)
        if top:
            pg.set_viewport_size({'width': 980, 'height': 600}); pg.goto((OUT / 'top3.html').as_uri()); pg.screenshot(path=str(OUT / 'top3-tiles.png'), full_page=True)
        b.close()
    print('ok', top)
