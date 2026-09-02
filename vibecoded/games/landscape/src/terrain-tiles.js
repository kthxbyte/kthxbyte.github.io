// Terrain fetched at runtime, so the world can be built anywhere rather
// than only where a mosaic was baked.
//
// Take a latitude and longitude, pull an n x n block of terrarium tiles
// around it, and hand back a mosaic plus the metadata the rest of the
// engine expects. These tiles are open data -- Tilezen via AWS Open
// Data, no key -- so unlike the satellite imagery they could equally be
// baked. They are not: fetching them live is what stops the place being
// a build-time decision, and there is no longer any offline path.

const BUCKET = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const CONCURRENCY = 16;

export const TERRAIN_ATTRIBUTION = [
    'United States 3DEP (formerly NED) and global GMTED2010 and SRTM ' +
    'terrain data courtesy of the U.S. Geological Survey',
    'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric ' +
    'Administration',
];

export function tileXY(lat, lon, z) {
    const n = 2 ** z;
    const r = lat * Math.PI / 180;
    return [
        Math.floor((lon + 180) / 360 * n),
        Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n),
    ];
}

function tileNW(x, y, z) {
    const n = 2 ** z;
    return {
        lon: x / n * 360 - 180,
        lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI,
    };
}

// Fetching a hundred-odd tiles at once reliably loses one or two to
// transient errors -- measured at 4 of 64 over Santorini, where every
// one of those tiles serves 200 on a direct request. A hole matters
// more here than in the imagery: imagery falls back to a coarser
// picture, terrain falls back to sea level, which punches a flat square
// through an island. One delayed retry, as the imagery loader does.
async function loadTile(url) {
    try {
        return await loadOnce(url);
    } catch (err) {
        await new Promise((r) => setTimeout(r, 400));
        return loadOnce(url + '?retry=1');
    }
}

function loadOnce(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';   // required to read the pixels back
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(url));
        img.src = url;
    });
}

async function pool(items, limit, worker) {
    let next = 0;
    const runners = [];
    for (let i = 0; i < limit; i++) {
        runners.push((async () => {
            while (next < items.length) await worker(items[next++]);
        })());
    }
    await Promise.all(runners);
}

// Metres per texel is latitude-dependent in Web Mercator, so a window
// over Iceland covers far less ground than the same tiles over Ecuador.
// Taken at the centre latitude and held constant across the window,
// which is what the offline tool does too.
export function metresPerTexel(lat, zoom) {
    return 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** zoom;
}

// Which tiles of a window about to be fetched are already sitting in the
// one being replaced. A move leads only as far as the safe margin -- a
// tile or two at twelve tiles -- so the overlap is nearly the whole
// mosaic, and refetching it was most of the cost of a move.
//
// Measured on two equivalent two-tile steps off the same cold window
// over the Alps, one each way: 144 tiles in 22.1 s the old way against
// 54 in 10.5 s carrying the overlap, and the two mosaics identical
// across all 9,437,184 pixels. The tiles carry no Cache-Control, only a
// Last-Modified from 2017, so how much the browser serves from its own
// cache is a heuristic and cannot be relied on -- which is the other
// reason to do this here rather than hope.
//
// Tile indices are the raw slippy ones, unwrapped, exactly as
// `tileOrigin` stores them, so this is plain integer arithmetic. The one
// case it declines is a window that crosses the antimeridian, where
// `tileXY` wraps and the two origins stop being in the same continuous
// space: the offset jumps by a full grid, no overlap is found, and the
// fetch falls back to fetching everything. Conservative, and rare.
//
// Returns null when nothing can be carried, otherwise the pixel offset
// to blit the old mosaic at and the half-open tile rectangle -- in the
// NEW window's tile coordinates -- that therefore needs no fetching.
export function carriedTiles(prev, next) {
    if (!prev || prev.zoom !== next.zoom) return null;
    if (!prev.tileOrigin || !Number.isFinite(prev.tiles)) return null;
    const dx = prev.tileOrigin[0] - next.tileOrigin[0];
    const dy = prev.tileOrigin[1] - next.tileOrigin[1];
    const x0 = Math.max(0, dx), x1 = Math.min(next.tiles, dx + prev.tiles);
    const y0 = Math.max(0, dy), y1 = Math.min(next.tiles, dy + prev.tiles);
    if (x1 <= x0 || y1 <= y0) return null;
    return { dx, dy, x0, y0, x1, y1, count: (x1 - x0) * (y1 - y0) };
}

// `prev` is the window being replaced -- { canvas, meta } -- and is what
// turns a move from a full refetch into an incremental one. Omit it and
// this behaves exactly as it did.
export async function fetchTerrain({ lat, lon, zoom, tiles, onProgress, prev }) {
    const [tx, ty] = tileXY(lat, lon, zoom);
    const x0 = tx - (tiles >> 1);
    const y0 = ty - (tiles >> 1);
    const size = tiles * 256;

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Sea level everywhere first: a tile that fails to arrive then reads
    // as ocean rather than as the 32768 m cliff an empty canvas decodes
    // to. Terrarium's zero is (128, 0, 0).
    ctx.fillStyle = 'rgb(128,0,0)';
    ctx.fillRect(0, 0, size, size);

    // Carry the overlap across before anything is fetched: the tile grids
    // are the same grid at the same zoom, so the shift is a whole number
    // of pixels and the blit is exact. drawImage clips a negative
    // destination for us, so a shift in either direction needs no cases.
    const carried = carriedTiles(prev && prev.meta, {
        zoom, tiles, tileOrigin: [x0, y0],
    });
    if (carried && prev.canvas) {
        ctx.drawImage(prev.canvas, carried.dx * 256, carried.dy * 256);
    }
    // Tiles that failed last time were left at sea level, and carrying
    // that across would make a transient network error permanent for as
    // long as the hole stayed inside the window. They are refetched.
    const stale = new Set((prev && prev.meta && prev.meta.missing) || []);

    const jobs = [];
    let reused = 0;
    for (let j = 0; j < tiles; j++) {
        for (let i = 0; i < tiles; i++) {
            const have = carried && prev.canvas
                && i >= carried.x0 && i < carried.x1
                && j >= carried.y0 && j < carried.y1
                && !stale.has(`${x0 + i},${y0 + j}`);
            if (have) reused++;
            else jobs.push([i, j]);
        }
    }
    // Longitude wraps, latitude does not. At low zoom a window is wider
    // than the tile grid -- 16 tiles span the planet at z4 -- so without
    // this every tile past the antimeridian 404s and the world is half
    // ocean.
    const grid = 2 ** zoom;
    const wrapX = (x) => ((x % grid) + grid) % grid;

    let done = 0, failed = 0;
    const missing = [];
    await pool(jobs, CONCURRENCY, async ([i, j]) => {
        const ty = y0 + j;
        if (ty < 0 || ty >= grid) { done++; return; }   // past a pole
        try {
            const img = await loadTile(
                `${BUCKET}/${zoom}/${wrapX(x0 + i)}/${ty}.png`);
            ctx.drawImage(img, i * 256, j * 256);
        } catch (err) {
            failed++;                       // left at sea level
            missing.push(`${x0 + i},${y0 + j}`);
        }
        done++;
        if (onProgress && done % 8 === 0) onProgress(done, jobs.length, failed);
    });
    if (onProgress) onProgress(jobs.length, jobs.length, failed);

    const nw = tileNW(x0, y0, zoom);
    const se = tileNW(x0 + tiles, y0 + tiles, zoom);
    return {
        canvas,
        failed,
        fetched: jobs.length,
        reused,
        meta: {
            missing,
            place: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
            centre: [lat, lon],
            zoom, size, tiles,
            tileOrigin: [x0, y0],
            metresPerPixel: metresPerTexel(lat, zoom),
            bounds: { north: nw.lat, west: nw.lon, south: se.lat, east: se.lon },
            attribution: TERRAIN_ATTRIBUTION,
        },
    };
}
