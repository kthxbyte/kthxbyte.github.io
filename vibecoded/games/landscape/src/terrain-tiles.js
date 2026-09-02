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

export async function fetchTerrain({ lat, lon, zoom, tiles, onProgress }) {
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

    const jobs = [];
    for (let j = 0; j < tiles; j++) {
        for (let i = 0; i < tiles; i++) jobs.push([i, j]);
    }
    // Longitude wraps, latitude does not. At low zoom a window is wider
    // than the tile grid -- 16 tiles span the planet at z4 -- so without
    // this every tile past the antimeridian 404s and the world is half
    // ocean.
    const grid = 2 ** zoom;
    const wrapX = (x) => ((x % grid) + grid) % grid;

    let done = 0, failed = 0;
    await pool(jobs, CONCURRENCY, async ([i, j]) => {
        const ty = y0 + j;
        if (ty < 0 || ty >= grid) { done++; return; }   // past a pole
        try {
            const img = await loadTile(
                `${BUCKET}/${zoom}/${wrapX(x0 + i)}/${ty}.png`);
            ctx.drawImage(img, i * 256, j * 256);
        } catch (err) {
            failed++;                       // left at sea level
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
        meta: {
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
