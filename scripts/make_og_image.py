#!/usr/bin/env python3
"""Generate the default Open Graph / social share image (public/og-image.png).

Self-contained: only Pillow + system fonts. 1200x630 is the canonical OG size.
Regenerate:
    uv run --with pillow python scripts/make_og_image.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630

# palette
BG = (13, 17, 23)          # #0d1117 GitHub dark
PANEL = (22, 27, 34)        # #161b22
BORDER = (48, 54, 61)       # #30363d
WHITE = (240, 246, 252)
GRAY = (139, 148, 158)      # #8b949e
LIGHT = (201, 209, 217)     # #c9d1d9
BRAND = (62, 175, 124)      # #3eaf7c (theme-color)
PROMPT = (86, 211, 100)     # green $
YELLOW = (242, 204, 96)

BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
MONO = "/System/Library/Fonts/Menlo.ttc"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    if os.path.exists(path):
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def main() -> int:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # top brand accent bar
    d.rectangle([0, 0, W, 10], fill=BRAND)

    pad = 80

    # brand mark: rounded green square with a monospace ">"
    d.rounded_rectangle([pad, 62, pad + 64, 126], radius=14, fill=BRAND)
    d.text((pad + 16, 66), ">_", font=font(MONO, 34), fill=BG)

    # wordmark
    d.text((pad + 88, 60), "Recotem", font=font(BOLD, 76), fill=WHITE)

    # tagline
    d.text((pad, 178), "Recipe-driven recommender systems",
           font=font(REG, 46), fill=LIGHT)
    # value line (brand color)
    d.text((pad, 244), "one YAML  =  one model  =  one recommendation API",
           font=font(BOLD, 38), fill=BRAND)

    # terminal panel
    tx0, ty0, tx1, ty1 = pad, 330, W - pad, 512
    d.rounded_rectangle([tx0, ty0, tx1, ty1], radius=16, fill=PANEL, outline=BORDER, width=2)
    # window dots
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([tx0 + 26 + i * 26, ty0 + 22, tx0 + 26 + i * 26 + 14, ty0 + 36], fill=c)

    mono = font(MONO, 30)
    lx = tx0 + 40
    ly = ty0 + 66
    lines = [
        [("$ ", PROMPT), ("recotem train ", WHITE), ("recipe.yaml", (121, 192, 255))],
        [("$ ", PROMPT), ("recotem serve ", WHITE), ("--recipes ./", (121, 192, 255))],
        [("  ", WHITE), ("✓ ", PROMPT), ("serving /v1/recipes/{name}:recommend", GRAY)],
    ]
    for segs in lines:
        x = lx
        for text, color in segs:
            d.text((x, ly), text, font=mono, fill=color)
            x += int(mono.getlength(text))
        ly += 40

    # footer
    d.text((pad, 556), "recotem.org", font=font(BOLD, 30), fill=BRAND)
    right = "pip install recotem"
    rf = font(MONO, 28)
    d.text((W - pad - rf.getlength(right), 558), right, font=rf, fill=GRAY)

    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "public", "og-image.png")
    img.save(out, "PNG")
    print(f"wrote {out}  ({os.path.getsize(out) / 1024:.0f} KiB, {W}x{H})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
