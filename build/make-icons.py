# Screenroom's and Parlor's icons: the Matinee ink-brown tile with one cream shape and an amber heart.
#   Screenroom: a single frame of film (sprocket holes down both sides), its picture lit amber.
#   Parlor: a record, its label amber.
# Run from the repository: python3 build/make-icons.py   (writes every size each platform needs)
import os
from PIL import Image, ImageDraw

INK_TOP, INK_BOT = (38, 29, 22), (20, 15, 11)
CREAM, AMBER = (243, 233, 220), (240, 167, 58)
GROOVE = (214, 202, 188)
SS = 4  # drawn 4× and scaled down, for smooth edges


def background(N, x0, y0, w, r):
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    grad = Image.new('RGBA', (N, N))
    gd = ImageDraw.Draw(grad)
    for y in range(N):
        t = max(0.0, min(1.0, (y - y0) / max(1, w)))
        gd.line([(0, y), (N, y)], fill=tuple(int(INK_TOP[i] + (INK_BOT[i] - INK_TOP[i]) * t) for i in range(3)) + (255,))
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([x0, y0, x0 + w - 1, y0 + w - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def film(img, cx, cy, s, under=None):
    """One film frame, s = the tile's width. Cream strip with holes cut through to the tile; amber picture."""
    N = img.size[0]
    fw, fh = s * 0.62, s * 0.52
    x0, y0 = cx - fw / 2, cy - fh / 2
    shape = Image.new('L', (N, N), 0)
    d = ImageDraw.Draw(shape)
    d.rounded_rectangle([x0, y0, x0 + fw, y0 + fh], radius=s * 0.045, fill=255)
    # sprocket holes: four down each side
    hw, hh, edge = s * 0.052, s * 0.072, s * 0.032
    n = 4
    step = fh / n
    for i in range(n):
        hy = y0 + step * i + (step - hh) / 2
        for hx in (x0 + edge, x0 + fw - edge - hw):
            d.rounded_rectangle([hx, hy, hx + hw, hy + hh], radius=s * 0.014, fill=0)
    img.paste(Image.new('RGBA', (N, N), CREAM + (255,)), (0, 0), shape)
    # the picture
    px0, px1 = x0 + edge * 2 + hw, x0 + fw - edge * 2 - hw
    py0, py1 = y0 + s * 0.045, y0 + fh - s * 0.045
    ImageDraw.Draw(img).rounded_rectangle([px0, py0, px1, py1], radius=s * 0.022, fill=AMBER + (255,))


def disc(img, cx, cy, s, under):
    """A record, s = the tile's width: cream, a few fine grooves, an amber label, the spindle hole."""
    N = img.size[0]
    R = s * 0.31
    shape = Image.new('L', (N, N), 0)
    d = ImageDraw.Draw(shape)
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=255)
    hole = s * 0.026
    d.ellipse([cx - hole, cy - hole, cx + hole, cy + hole], fill=0)
    img.paste(Image.new('RGBA', (N, N), CREAM + (255,)), (0, 0), shape)
    dd = ImageDraw.Draw(img)
    for f in (0.86, 0.74, 0.62):
        r = R * f
        dd.ellipse([cx - r, cy - r, cx + r, cy + r], outline=GROOVE + (255,), width=max(1, int(s * 0.007)))
    lab = R * 0.40
    dd.ellipse([cx - lab, cy - lab, cx + lab, cy + lab], fill=AMBER + (255,))
    # (the hole goes through the label too)
    cut = Image.new('L', (N, N), 0)
    ImageDraw.Draw(cut).ellipse([cx - hole, cy - hole, cx + hole, cy + hole], fill=255)
    img.paste(under, (0, 0), cut)


def tile(kind, size, style='bleed'):
    """bleed: full square (iOS and old Android launchers mask it); mac: a rounded tile with a margin (desktop);
    fg: the shape alone on transparent, sized for an Android adaptive icon's safe zone; bg: the tile alone."""
    N = size * SS
    if style == 'mac':
        w = int(N * 824 / 1024); x0 = (N - w) // 2; r = int(w * 0.225)
    elif style == 'win':
        w = N; x0 = 0; r = int(N * 0.18)
    else:
        w = N; x0 = 0; r = 0
    img = background(N, x0, x0, w, r) if style != 'fg' else Image.new('RGBA', (N, N), (0, 0, 0, 0))
    if style == 'bg':
        return img.resize((size, size), Image.LANCZOS)
    under = img.copy()
    s = w if style != 'fg' else N * 66 / 108 * 1.12  # (an adaptive icon's shape lives in the middle 66 of 108)
    (film if kind == 'screenroom' else disc)(img, N / 2, N / 2, s, under)
    return img.resize((size, size), Image.LANCZOS)


def main():
  ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
  P = lambda *a: os.path.join(ROOT, *a)

  # desktop (Linux, Mac, the TV box): Screenroom; Windows: Parlor
  tile('screenroom', 1024, 'mac').save(P('build/icon.png'))
  ico = tile('parlor', 256, 'win')
  ico.save(P('build/parlor.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

  # iPhone and iPad
  tile('screenroom', 1024).convert('RGB').save(P('ios/Screenroom/Assets.xcassets/AppIcon.appiconset/icon-1024.png'))
  tile('parlor', 1024).convert('RGB').save(P('ios/Screenroom/Assets.xcassets/ParlorIcon.appiconset/icon-1024.png'))

  # Android TV
  tile('screenroom', 96).save(P('android/app/src/main/res/mipmap-xhdpi/ic_launcher.png'))

  # Android phones: an adaptive icon (Pixel's round / squircle masks), the plain one for anything older
  res = P('android/phone/src/main/res')
  os.makedirs(f'{res}/mipmap-anydpi-v26', exist_ok=True)
  for kind, name in (('screenroom', 'ic_screenroom'), ('parlor', 'ic_parlor')):
      tile(kind, 192).save(f'{res}/mipmap-xxxhdpi/{name}.png')
      tile(kind, 432, 'fg').save(f'{res}/mipmap-xxxhdpi/{name}_fg.png')
      tile(kind, 432, 'bg').save(f'{res}/mipmap-xxxhdpi/{name}_bg.png')
      open(f'{res}/mipmap-anydpi-v26/{name}.xml', 'w').write(
          '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
          f'    <background android:drawable="@mipmap/{name}_bg" />\n    <foreground android:drawable="@mipmap/{name}_fg" />\n'
          f'    <monochrome android:drawable="@mipmap/{name}_fg" />\n</adaptive-icon>\n')
  print('done')


if __name__ == '__main__':
    main()
