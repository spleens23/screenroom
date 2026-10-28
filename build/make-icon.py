# Screenroom's Matinee icon: an ink-brown tile, a cream italic serif S and the wordmark's amber dot.
import sys
from PIL import Image, ImageDraw, ImageFont
FONT = sys.argv[1]
INK_TOP, INK_BOT = (38, 29, 22), (20, 15, 11)
CREAM, AMBER = (243, 233, 220), (240, 167, 58)

def tile(size, bleed):
    """bleed=True: full square (iOS, Android masks it); False: macOS-style rounded tile with margin."""
    S = 4
    N = size * S
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    if bleed:
        x0, y0, w, r = 0, 0, N, 0
    else:
        w = int(N * 824 / 1024); x0 = y0 = (N - w) // 2; r = int(w * 0.225)
    grad = Image.new('RGBA', (N, N))
    gd = ImageDraw.Draw(grad)
    for y in range(N):
        t = max(0.0, min(1.0, (y - y0) / max(1, w)))
        c = tuple(int(INK_TOP[i] + (INK_BOT[i] - INK_TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (N, y)], fill=c)
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([x0, y0, x0 + w - 1, y0 + w - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # a thin amber line along the bottom of the tile: the edge of the stage
    # (kept off: the letter and dot carry it)
    f = ImageFont.truetype(FONT, int(w * 0.78))
    bb = d.textbbox((0, 0), 'S', font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    dot = int(w * 0.085)
    gap = int(w * 0.02)
    total = tw + gap + dot
    tx = x0 + (w - total) / 2 - bb[0]
    ty = y0 + (w - th) / 2 - bb[1] - w * 0.01
    d.text((tx, ty), 'S', font=f, fill=CREAM)
    base = ty + bb[3]
    dx = tx + bb[2] + gap
    d.ellipse([dx, base - dot, dx + dot, base], fill=AMBER)
    return img.resize((size, size), Image.LANCZOS)

def banner(w, h):
    S = 4
    img = Image.new('RGBA', (w * S, h * S), INK_BOT + (255,))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(sys.argv[2], int(h * S * 0.30))
    t = 'Screenroom'
    bb = d.textbbox((0, 0), t, font=f)
    dot = int(h * S * 0.05); gap = int(h * S * 0.015)
    total = bb[2] - bb[0] + gap + dot
    x = (w * S - total) / 2 - bb[0]; y = (h * S - (bb[3] - bb[1])) / 2 - bb[1]
    d.text((x, y), t, font=f, fill=CREAM)
    base = y + bb[3]; dx = x + bb[2] + gap
    d.ellipse([dx, base - dot, dx + dot, base], fill=AMBER)
    return img.resize((w, h), Image.LANCZOS)

out = sys.argv[3]
tile(1024, False).save(f'{out}/build/icon.png')
tile(1024, True).convert('RGB').save(f'{out}/ios/Screenroom/Assets.xcassets/AppIcon.appiconset/icon-1024.png')
tile(96, True).save(f'{out}/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png')
banner(320, 180).save(f'{out}/android/app/src/main/res/drawable-xhdpi/banner.png')
