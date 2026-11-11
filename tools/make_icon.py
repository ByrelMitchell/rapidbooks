"""RapidBooks icon: an open ledger struck by a lightning bolt on a blue tile.

Regenerates packages/web/public/{favicon.ico,icon-192.png,icon-512.png,apple-touch-icon.png}
and deploy/rapidbooks.png. Needs Pillow.

    python tools/make_icon.py                # write the icons
    python tools/make_icon.py preview.png    # also write a contact sheet of every size
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

S = 1024


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def gradient(top, bottom, size=S):
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bottom, y / (size - 1)) + (255,))
    return img


def shadow(base, poly, offset=(0, 18), blur=22, alpha=120):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).polygon([(x + offset[0], y + offset[1]) for x, y in poly], fill=(4, 16, 48, alpha))
    return Image.alpha_composite(base, layer.filter(ImageFilter.GaussianBlur(blur)))


def render(detail=True):
    # --- tile ---
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([24, 24, S - 24, S - 24], radius=210, fill=255)
    tile = gradient((58, 142, 240), (14, 44, 122))
    # soft highlight from the top-left
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-300, -520, 900, 420], fill=(255, 255, 255, 46))
    tile = Image.alpha_composite(tile, glow.filter(ImageFilter.GaussianBlur(60)))
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(tile, (0, 0), mask)
    # inner rim
    rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle([34, 34, S - 34, S - 34], radius=200, outline=(255, 255, 255, 60), width=8)
    img = Image.alpha_composite(img, rim)

    # --- open book ---
    cx = S // 2
    top_o, top_i, bot_o, bot_i = 372, 432, 760, 830   # outer edges ride higher than the spine
    left, right = 132, S - 132
    cover_l = [(left - 26, top_o + 34), (cx, top_i + 44), (cx, bot_i + 46), (left - 26, bot_o + 40)]
    cover_r = [(S - x, y) for x, y in cover_l]
    page_l = [(left, top_o), (cx, top_i), (cx, bot_i), (left, bot_o)]
    page_r = [(S - x, y) for x, y in page_l]

    img = shadow(img, cover_l + cover_r[::-1], offset=(0, 26), blur=26, alpha=150)
    d = ImageDraw.Draw(img)
    d.polygon(cover_l, fill=(9, 30, 84))
    d.polygon(cover_r, fill=(7, 24, 70))
    d.polygon(page_l, fill=(255, 255, 255))
    d.polygon(page_r, fill=(226, 236, 250))

    if detail:
        # ledger rules, following the slope of each page
        for i in range(1, 6):
            t = i / 6
            yo = top_o + (bot_o - top_o) * t
            yi = top_i + (bot_i - top_i) * t
            for sign, col in ((1, (150, 180, 222)), (-1, (140, 168, 212))):
                x0, x1 = left + 44, cx - 40
                ya = yo + (yi - yo) * (x0 - left) / (cx - left)
                yb = yo + (yi - yo) * (x1 - left) / (cx - left)
                if sign < 0:
                    x0, x1 = S - x0, S - x1
                d.line([(x0, ya), (x1, yb)], fill=col, width=11)
        # red ledger margin on the left page
        mx = left + 96
        my = lambda y_o, y_i: y_o + (y_i - y_o) * (mx - left) / (cx - left)
        d.line([(mx, my(top_o, top_i) + 10), (mx, my(bot_o, bot_i) - 10)], fill=(232, 96, 96), width=9)
    # spine
    d.line([(cx, top_i), (cx, bot_i)], fill=(120, 150, 200), width=10 if detail else 22)

    # --- lightning bolt ---
    bolt = [(622, 86), (322, 560), (492, 560), (398, 946), (716, 440), (540, 440)]
    if not detail:  # fatter at tiny sizes
        bolt = [(650, 70), (286, 580), (480, 580), (380, 960), (752, 420), (556, 420)]
    img = shadow(img, bolt, offset=(10, 22), blur=20, alpha=170)
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.polygon(bolt, fill=(255, 255, 255, 255))
    ld.line(bolt + bolt[:2], fill=(255, 255, 255, 255), width=14, joint="curve")
    gold = gradient((255, 236, 110), (255, 150, 20))
    img.paste(gold, (0, 0), layer.split()[3])
    # dark keyline so the bolt separates from the white pages
    ImageDraw.Draw(img).line(bolt + bolt[:2], fill=(120, 58, 0), width=16 if detail else 30, joint="curve")
    inner = Image.new("L", (S, S), 0)
    ImageDraw.Draw(inner).polygon(bolt, fill=255)
    img.paste(gold, (0, 0), inner.filter(ImageFilter.GaussianBlur(1)))
    # glint down the bolt's leading edge
    hi = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hi).line([(606, 150), (372, 528)], fill=(255, 255, 255, 150), width=16)
    hi.putalpha(Image.composite(hi.split()[3], Image.new("L", (S, S), 0), inner))
    if detail:
        img = Image.alpha_composite(img, hi.filter(ImageFilter.GaussianBlur(3)))
    return img


def main(out_public, out_deploy, preview):
    full, simple = render(True), render(False)
    pick = lambda n: (simple if n <= 32 else full).resize((n, n), Image.LANCZOS)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [pick(n) for n in sizes]
    frames[-1].save(f"{out_public}/favicon.ico", format="ICO",
                    sizes=[(n, n) for n in sizes], append_images=frames[:-1])
    pick(180).save(f"{out_public}/apple-touch-icon.png")
    pick(192).save(f"{out_public}/icon-192.png")
    pick(512).save(f"{out_public}/icon-512.png")
    pick(256).save(f"{out_deploy}/rapidbooks.png")
    if not preview:
        return
    # contact sheet for eyeballing
    sheet = Image.new("RGBA", (512 + 20 + 256 + 20 + 128, 532), (240, 240, 240, 255))
    sheet.alpha_composite(pick(512), (0, 10))
    sheet.alpha_composite(pick(256), (532, 10))
    x = 532
    for n in (64, 48, 32, 24, 16):
        sheet.alpha_composite(pick(n), (x, 290)); x += n + 12
    dark = Image.new("RGBA", (300, 90), (30, 30, 30, 255))
    sheet.alpha_composite(dark, (532, 380))
    x = 545
    for n in (64, 48, 32, 24, 16):
        sheet.alpha_composite(pick(n), (x, 392)); x += n + 12
    sheet.save(preview)


if __name__ == "__main__":
    public = ROOT / "packages" / "web" / "public"
    public.mkdir(parents=True, exist_ok=True)
    main(public, ROOT / "deploy", sys.argv[1] if len(sys.argv) > 1 else None)
