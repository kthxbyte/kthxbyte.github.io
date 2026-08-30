#!/usr/bin/env python3
"""Convert the 2010 demo's 8-bit BMPs into PNGs the browser can load.

The originals are left untouched. Output is committed to html/assets/
so that running the demo needs no build step; this script exists so the
derivation is reproducible and documented.

    python3 html/tools/convert-assets.py

Notes on the source data:
  - heightmap.bmp has a pure grayscale palette, so the palette index IS
    the terrain height. Verified below rather than assumed.
  - texture.bmp keeps its own 256-colour palette. It is written as an
    indexed PNG (1.9 MB) rather than RGB (5.8 MB); both are lossless,
    and retro mode depends on the palette colours being exact, which
    rules out lossy formats.
"""
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent.parent          # the original demo directory
OUT = TOOLS.parent / "assets"       # html/assets


def convert(src_name, dst_name, mode=None):
    src, dst = ROOT / src_name, OUT / dst_name
    if not src.exists():
        sys.exit(f"missing source asset: {src}")
    img = Image.open(src)
    if mode:
        img = img.convert(mode)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, optimize=True)
    print(f"{src_name:16} {img.size[0]}x{img.size[1]} {img.mode:2} "
          f"-> {dst_name:16} {dst.stat().st_size // 1024:5} KB")
    return img


def convert_sky(src_name, dst_name):
    """The sky strip is ordered dithering left over from 8-bit colour.

    Stretched across the screen at 24bpp that dither reads as coloured
    speckle rather than as a gradient, so it gets a light blur. The
    terrain texture is deliberately NOT treated this way: there the
    dither is the look, and retro mode needs its palette exact.

    The blur wraps horizontally -- it is a panorama, and blurring the
    edges independently would put a seam at due north.
    """
    from PIL import ImageFilter
    img = Image.open(ROOT / src_name).convert("RGB")
    w, h = img.size
    wide = Image.new("RGB", (w * 3, h))
    for i in range(3):
        wide.paste(img, (i * w, 0))
    wide = wide.filter(ImageFilter.GaussianBlur(1.4))
    out = wide.crop((w, 0, w * 2, h))
    dst = OUT / dst_name
    out.save(dst, optimize=True)
    print(f"{src_name:16} {w}x{h} RGB -> {dst_name:16} "
          f"{dst.stat().st_size // 1024:5} KB (de-dithered)")


def main():
    # The height == palette index claim the shader relies on.
    raw = Image.open(ROOT / "heightmap.bmp")
    idx = list(raw.getdata())
    grey = list(raw.convert("L").getdata())
    if idx != grey:
        sys.exit("heightmap palette is not a grayscale ramp; "
                 "the shader's height decoding would be wrong")
    print(f"verified: heightmap index == height, range "
          f"{min(idx)}-{max(idx)}")

    convert("heightmap.bmp", "heightmap.png", "L")
    convert("texture.bmp", "texture.png")
    convert_sky("sky.bmp", "sky.png")

    # Round-trip check: the PNGs must decode back to the same values.
    for a, b, m in (("heightmap.bmp", "heightmap.png", "L"),
                    ("texture.bmp", "texture.png", "RGB")):
        if list(Image.open(ROOT / a).convert(m).getdata()) != \
           list(Image.open(OUT / b).convert(m).getdata()):
            sys.exit(f"round-trip mismatch: {a} != {b}")
    print("verified: PNG round-trip is lossless")


if __name__ == "__main__":
    main()
