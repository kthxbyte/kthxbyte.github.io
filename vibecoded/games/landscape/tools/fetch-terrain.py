#!/usr/bin/env python3
"""Fetch a real-world terrain mosaic from the Tilezen terrain tiles.

    python3 html/tools/fetch-terrain.py                 # Caldera, Atacama, z13
    python3 html/tools/fetch-terrain.py --lat .. --lon .. --zoom ..

Writes the raw terrarium mosaic as a PNG plus a JSON sidecar of
metadata. The PNG is NOT a heightmap in the usual sense -- it is the
terrarium encoding, decoded in the browser:

    elevation_metres = (R * 256 + G + B / 256) - 32768

We keep the encoding rather than flattening to 8-bit grey because 8 bits
over this relief would quantise to ~10 m steps, which terraces visibly
on gentle slopes. The browser decodes to a float texture instead.

Data: Tilezen terrain tiles via AWS Open Data (no API key required).
Attribution obligations are recorded in the JSON sidecar and shown in
the UI. See https://github.com/tilezen/joerd/blob/master/docs/attribution.md
"""
import argparse, io, json, math, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

BUCKET = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
OUT = Path(__file__).resolve().parent.parent / "assets"

# Zoom 13 is the finest level carrying real information in this region:
# measured against a bilinear upsample of the level above, z13 adds
# ~5 m RMS of genuine detail while z14 adds 0.1-0.4 m, i.e. nothing.
# SRTM is the underlying source here. Regions covered by national lidar
# (the US via 3DEP, for one) keep gaining detail through z14-15.
DEFAULTS = dict(lat=-27.0678, lon=-70.8231, zoom=13, tiles=7,
                name="caldera", place="Caldera, Atacama, Chile")


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def tile_nw(x, y, z):
    """North-west corner of a tile, in degrees."""
    n = 2 ** z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lat, lon


def _decode(arr):
    return (arr[:, :, 0] * 256 + arr[:, :, 1] + arr[:, :, 2] / 256) - 32768


def _encode(e):
    # Inverse of the terrarium decode, byte-exact for values the encoding
    # can represent.
    import numpy as np
    v = np.clip((e + 32768) * 256.0, 0, 256 * 256 * 256 - 1)
    t = np.round(v).astype(np.int64)
    out = np.empty(e.shape + (3,), dtype=np.uint8)
    out[:, :, 0] = (t >> 16) & 255
    out[:, :, 1] = (t >> 8) & 255
    out[:, :, 2] = t & 255
    return out


def fetch(z, x, y):
    url = f"{BUCKET}/{z}/{x}/{y}.png"
    req = urllib.request.Request(url, headers={"User-Agent": "landscape-demo/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    p = argparse.ArgumentParser()
    for k in ("lat", "lon"):
        p.add_argument(f"--{k}", type=float, default=DEFAULTS[k])
    p.add_argument("--zoom", type=int, default=DEFAULTS["zoom"])
    p.add_argument("--tiles", type=int, default=DEFAULTS["tiles"],
                   help="tiles per side; 7 gives a 1792x1792 mosaic")
    p.add_argument("--despike", type=float, default=25.0,
                   help="replace pixels standing this many metres clear "
                        "of every neighbour; 0 disables")
    p.add_argument("--name", default=DEFAULTS["name"])
    p.add_argument("--place", default=DEFAULTS["place"])
    a = p.parse_args()

    z, n = a.zoom, a.tiles
    fx, fy = tile_xy(a.lat, a.lon, z)
    x0, y0 = int(fx) - n // 2, int(fy) - n // 2
    size = n * 256

    print(f"{a.place}  lat {a.lat} lon {a.lon}  zoom {z}")
    print(f"fetching {n}x{n} = {n*n} tiles -> {size}x{size} px")

    jobs = [(i, j) for j in range(n) for i in range(n)]

    def get(job):
        i, j = job
        return i, j, fetch(z, x0 + i, y0 + j)

    with ThreadPoolExecutor(max_workers=8) as ex:
        tiles = list(ex.map(get, jobs))

    mosaic = Image.new("RGB", (size, size))
    for i, j, data in tiles:
        mosaic.paste(Image.open(io.BytesIO(data)).convert("RGB"), (i * 256, j * 256))

    # Despike. SRTM carries occasional single-pixel voids and returns
    # that no neighbour supports -- a lone peak with nothing around it to
    # confirm the height. They are rare but they cost twice: a needle in
    # the terrain, and a raised global maximum, which pushes uMaxHeight
    # up and defeats the marcher's ceiling skip for every ray in the
    # scene.
    #
    # Only pixels that stand clear of EVERY neighbour are touched, and
    # they are replaced by the neighbour median. A blanket median filter
    # would round off real ridge lines, which are exactly what this
    # terrain is made of.
    if a.despike > 0:
        try:
            import numpy as np
            e = _decode(np.asarray(mosaic, dtype=np.float64))
            pad = np.pad(e, 1, mode="edge")
            nb = np.stack([pad[0:-2, 0:-2], pad[0:-2, 1:-1], pad[0:-2, 2:],
                           pad[1:-1, 0:-2],                  pad[1:-1, 2:],
                           pad[2:, 0:-2],   pad[2:, 1:-1],   pad[2:, 2:]])
            excess = e - nb.max(axis=0)          # above every neighbour
            deficit = nb.min(axis=0) - e         # below every neighbour
            bad = (excess > a.despike) | (deficit > a.despike)
            n_bad = int(bad.sum())
            if n_bad:
                print(f"despike: {n_bad} isolated px "
                      f"(worst +{excess.max():.0f} / -{deficit.max():.0f} m), "
                      f"peak {e.max():.0f} -> ", end="")
                e = np.where(bad, np.median(nb, axis=0), e)
                print(f"{e.max():.0f} m")
                mosaic = Image.fromarray(_encode(e), "RGB")
            else:
                print(f"despike: none over {a.despike} m -- data is clean")
        except ImportError:
            print("despike: numpy not available, skipped")

    OUT.mkdir(parents=True, exist_ok=True)
    png = OUT / f"terrain-{a.name}.png"
    mosaic.save(png, optimize=True)

    # Decode once here purely to record the elevation range. numpy is
    # optional: without it the mosaic is still written, just without the
    # range in the sidecar.
    try:
        import numpy as np
        arr = np.asarray(mosaic, dtype=np.float64)
        elev = (arr[:, :, 0] * 256 + arr[:, :, 1] + arr[:, :, 2] / 256) - 32768
        lo, hi = float(elev.min()), float(elev.max())
    except ImportError:
        px = mosaic.load()
        lo, hi = 1e9, -1e9
        for yy in range(0, size, 4):
            for xx in range(0, size, 4):
                r, g, b = px[xx, yy]
                e = (r * 256 + g + b / 256) - 32768
                lo, hi = min(lo, e), max(hi, e)

    nw = tile_nw(x0, y0, z)
    se = tile_nw(x0 + n, y0 + n, z)
    mpp = 156543.03392 * math.cos(math.radians(a.lat)) / (2 ** z)

    meta = {
        "place": a.place, "centre": [a.lat, a.lon], "zoom": z,
        "size": size, "tiles": n, "tileOrigin": [x0, y0],
        "metresPerPixel": round(mpp, 4),
        "bounds": {"north": round(nw[0], 6), "west": round(nw[1], 6),
                   "south": round(se[0], 6), "east": round(se[1], 6)},
        "elevation": {"min": round(lo, 1), "max": round(hi, 1)},
        "encoding": "terrarium: (R*256 + G + B/256) - 32768 = metres",
        "source": "Tilezen terrain tiles, AWS Open Data (elevation-tiles-prod)",
        "attribution": [
            "United States 3DEP (formerly NED) and global GMTED2010 and SRTM "
            "terrain data courtesy of the U.S. Geological Survey",
            "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric "
            "Administration",
        ],
    }
    (OUT / f"terrain-{a.name}.json").write_text(json.dumps(meta, indent=2) + "\n")

    print(f"  {png.name}  {png.stat().st_size // 1024} KB")
    print(f"  elevation {lo:.0f} .. {hi:.0f} m   ({hi-lo:.0f} m relief)")
    print(f"  {mpp:.2f} m/px  ->  {size*mpp/1000:.1f} km across")
    print(f"  at 1:1 vertical scale that is {(hi-lo)/mpp:.0f} texels of relief")


if __name__ == "__main__":
    main()
