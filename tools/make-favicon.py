"""December's favicon: the wordmark's own D, not a system sans.

The wordmark is `--font-serif` (Georgia), so the mark is too. It takes the
BOLD cut at these sizes — Georgia's regular weight has strokes thin enough
that a 16px downsample eats them. That is optical sizing, not a different
typeface. The accent dot is drawn after the downsample and snapped to the
pixel grid, so it stays a mark instead of three fuzzy pixels.

The glyph is positioned by its RENDERED ink, not by font metrics: PIL's
draw origin and getbbox disagree by the side bearing, which put the D hard
against the left edge at 16px.
"""
from PIL import Image, ImageDraw, ImageFont
import sys

FONT = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf"
INK  = (0x26, 0x25, 0x21, 255)   # --text-1
BLUE = (0x3D, 0xA8, 0xDC, 255)   # --accent
SS   = 8                          # supersample factor


def render_D(px):
    """The D alone, cropped to its ink, at `px` cap height (supersampled)."""
    probe = ImageFont.truetype(FONT, px * 2)
    l, t, r, b = probe.getbbox("D")
    fs = max(1, round(px * (px * 2) / (b - t)))
    font = ImageFont.truetype(FONT, fs)
    pad = fs
    tmp = Image.new("RGBA", (fs * 3, fs * 3), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((pad, pad), "D", font=font, fill=INK)
    return tmp.crop(tmp.getbbox())


def make(size, out):
    margin = 2 if size <= 16 else 3
    dot    = 2 if size <= 16 else 3
    gap    = 1 if size <= 16 else 2
    big, SSm = size * SS, margin * SS

    cap = 0.58
    while cap > 0.30:
        glyph = render_D(round(cap * big))
        if glyph.width / SS + gap + dot <= size - 2 * margin:
            break
        cap -= 0.01

    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    total_w = glyph.width + (gap + dot) * SS
    x = round((big - total_w) / 2)
    baseline = round(0.80 * big)
    img.paste(glyph, (x, baseline - glyph.height), glyph)
    img = img.resize((size, size), Image.LANCZOS)

    d = ImageDraw.Draw(img)
    dx = round((x + glyph.width) / SS) + gap
    by = round(0.80 * size)
    d.rectangle([dx, by - dot, dx + dot - 1, by - 1], fill=BLUE)
    img.save(out)
    bb = img.getbbox()
    print(f"{out.split('/')[-1]:14s} cap={cap:.2f} bbox={bb}  "
          f"margins  L{bb[0]} R{size-bb[2]} T{bb[1]} B{size-bb[3]}")


make(16, sys.argv[1])
make(32, sys.argv[2])
