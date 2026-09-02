import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { Tilt, tiltSupported } from './tilt.js';
import { loadImagery, DetailImagery, IMAGERY_ATTRIBUTION } from './imagery.js';
import { UI, DEFAULTS, fail } from './ui.js';
import { loadImage, decodeHeights, createHeightTexture } from './gl.js';
import { windOffsets } from './wind.js';
import { fetchTerrain, tileXY } from './terrain-tiles.js';
import { PLACES } from './places.js';
import { windowZoom, rebase, scaleBetween, nextCentre, needsMove, safeMargin,
         edgeGap }
    from './terrain-window.js';

async function loadText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
    return res.text();
}

async function loadJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
    return res.json();
}

// A pinned pose and render settings can be supplied in the URL, which
// is what makes the screenshot check reproducible and cheap:
//   ?x=200&y=200&z=90&yaw=0.4&pitch=-0.2&retro=1&scale=0.5&steps=96
// Split in two because order matters: the settings decide which dataset
// loads and whether imagery is fetched, and must be read before that
// happens; the pose overrides the dataset's own starting view, and must
// be applied after.
// Returns the set of settings the URL pinned. Datasets carry their own
// defaults for fog and draw distance, and those are applied when the
// dataset is selected -- which would silently overwrite anything the URL
// asked for. Anything pinned here is left alone from then on.
function applyQuerySettings(settings) {
    const q = new URLSearchParams(location.search);
    const pinned = new Set();
    const put = (key, value) => { settings[key] = value; pinned.add(key); };
    if (q.has('retro')) put('retro', q.get('retro') !== '0');
    if (q.has('follow')) put('terrainFollow', q.get('follow') !== '0');
    if (q.has('fov')) put('fov', parseFloat(q.get('fov')));
    if (q.has('scale')) put('renderScale', parseFloat(q.get('scale')));
    if (q.has('steps')) put('maxSteps', parseInt(q.get('steps'), 10));
    if (q.has('dist')) put('drawDistance', parseFloat(q.get('dist')));
    if (q.has('detail')) put('detailDistance', parseFloat(q.get('detail')));
    if (q.has('grid')) put('debugGrid', q.get('grid') !== '0');
    if (q.has('wind')) put('wind', parseFloat(q.get('wind')));
    if (q.has('roam')) put('roam', q.get('roam') !== '0');
    if (q.has('lock')) put('lockZoom', q.get('lock') !== '0');
    if (q.has('speed')) put('speedLog', Math.log10(parseFloat(q.get('speed'))));
    if (q.has('tiles')) put('liveTiles', parseInt(q.get('tiles'), 10));
    if (q.has('tz')) put('liveZoom', parseInt(q.get('tz'), 10));
    if (q.has('fog')) put('fogDensity', parseFloat(q.get('fog')));
    if (q.has('vs')) put('vertScale', parseFloat(q.get('vs')));
    if (q.has('terrain')) put('terrain', q.get('terrain'));
    if (q.has('imagery')) put('imagery', q.get('imagery') !== '0');
    return pinned;
}

// Applied after the dataset has placed the camera at its own starting
// view, so an explicit pose in the URL overrides it.
function applyQueryPose(camera) {
    const q = new URLSearchParams(location.search);
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) {
        if (q.has(k)) camera[k] = parseFloat(q.get(k));
    }
}

// A latitude/longitude as texel coordinates inside a fetched window --
// the inverse of the terrain's own latLon(), and the only way a preset
// can mean a place rather than a tile.
function texelOf(lat, lon, meta) {
    const n = 256 * 2 ** meta.zoom;
    const r = lat * Math.PI / 180;
    return {
        x: (lon + 180) / 360 * n - meta.tileOrigin[0] * 256,
        y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n
           - meta.tileOrigin[1] * 256,
    };
}

// Draw distance as a fraction of the window: exactly 100 texels of view
// per tile, which reproduces the historical 1200 at twelve tiles and
// keeps a small window from being asked to draw past its own edge. Draw
// distance is measured in texels, which is what lets it survive a zoom
// change untouched -- but it is also why it cannot survive a resize
// untouched. What it buys is not correctness: the shader already returns
// sea level outside the window (19.4), so an over-long view degrades to
// a flat plane rather than to garbage. It buys the plane not being
// there, which at 4x4 would otherwise be most of the frame.
// Re-derived only when the window changes size, so the slider still owns
// the value in between.
const DRAW_PER_TILE = 100;
// How long a window fetch takes, and therefore how far ahead of the edge
// the next one has to be started. Measured cold, carrying the overlap
// across: a two-tile move over the Alps fetched 54 of 144 tiles in
// 10.5 s. Without the carry-over the same move took 22.1 s, which is
// also roughly what a first window costs. Rounded to the move case, and
// down rather than up -- overshooting the lead costs runway on the
// trailing edge, which is the thing being fixed.
//
// It is latency-bound, not count-bound: browsers hold six connections
// per host, so 54 tiles is nine rounds however high CONCURRENCY is set.
const FETCH_SECONDS = 12;
let drawDerivedFor = 0;

// Clipmap rings, as zoom offsets from the level the LOD picks. One ring
// only, and the second one was built and measured before being taken out
// again, which is worth recording so it is not rebuilt on the same
// reasoning.
//
// The argument for it is sound as far as it goes: at a fixed tile budget
// each level finer halves the ground covered, so a rectangle sharp
// enough for the centre of the frame is too narrow for its sides, and
// nothing about the switch distance can fix that. What the argument
// leaves out is that the exposed sides are far away, where a screen
// pixel already covers more ground than the base mosaic's 8.5 m/px --
// so there is almost no headroom for a second ring to fill.
//
// Measured, one ring against two, at a 1000x560 buffer:
//
//   500 m, pitch -17    x1.00 overall, 0.6% of pixels changed
//   150 m, pitch  -2    x1.02 overall, 2.0% of pixels, x1.04 and x1.06
//                       at the outer sixths -- real, and confined to
//                       exactly where the geometry predicted
//
// Four to six per cent at the edges of the frame did not pay for double
// the tiles per refresh and another 35 MB of texture, and the ring came
// back out.
//
// The case did change, twice over, and the second ring is back at a
// different offset. Both premises above have gone:
//
//  - "the exposed sides are far away, where a screen pixel already
//    covers more than the base mosaic" assumed an 8.5 m/px base. Over a
//    twelve-tile window there is no such base: the imagery's free zoom
//    step is refused because 12 * 256 * 2 = 6144 exceeds the 4096 cap,
//    so the base is the terrain's own zoom, 32 m/px. There is a great
//    deal of headroom.
//  - the old experiment used -1. A z16 ring reaches 4.56 km against
//    z17's 2.28, so it duplicated the ring above it and left the rest of
//    the frame exactly as it was. That is why it measured x1.00.
//
// -2 straddles the gap instead of nesting inside it: z15 is 4 m/px out
// to 9.13 km, eight times the base, over the band between the sharp
// rectangle and the horizon. With the zoom ladder locked that band is
// most of the picture, because nothing steps down into it any more.
//
//   ring   m/px    serves to
//   z17    1.00     2.28 km    <- offset  0
//   z15    4.01     9.13 km    <- offset -2
//   base  32.05     everywhere
//
// Use -3 instead to trade sharpness for reach: z14 is 8 m/px to 18 km.
const RING_OFFSETS = [0, -2];

// A terrain dataset: heights on the GPU for the march, the same heights
// on the CPU for terrain-follow and the floor, and enough metadata to
// report real-world position when there is one.
function makeTerrain(gl, spec) {
    const size = spec.image.naturalWidth || spec.image.width;
    const mpp = spec.meta ? spec.meta.metresPerPixel : null;
    const heights = decodeHeights(spec.image, spec.encoding, mpp);
    let maxTexels = 0, minTexels = Infinity;
    for (let i = 0; i < heights.length; i++) {
        if (heights[i] > maxTexels) maxTexels = heights[i];
        if (heights[i] < minTexels) minTexels = heights[i];
    }
    // A window reaching the coast gets a real sea; an inland one does
    // not, or the flat plane outside the data is painted as ocean at
    // whatever altitude the valley floor happens to be.
    //
    // This is the only thing the minimum still decides, and it is the
    // safe thing for it to decide: a boolean, and one that answers a
    // question the minimum genuinely knows the answer to. The plane's
    // *height* used to come from it too, and that was unstable -- see
    // renderer.js, where the plane is now pinned at zero. `minTexels` is
    // an outlier by definition; asking it for a colour decision is fine,
    // asking it for a geometric one was not.
    const hasSea = mpp ? minTexels * mpp < 5 : true;
    // Relief in texels vanishes as the window zooms out: a texel is
    // 17 m at z13 but 2.4 km at z6, so Everest is 3 texels tall in a
    // 3000-texel world and the planet renders as a plate. Scaling the
    // exaggeration by the texel size holds relief-in-texels constant, so
    // a mountain keeps its shape at any zoom and the slider keeps
    // meaning "how exaggerated", not "how exaggerated at z13". Identity
    // at z13, so nothing changes for ordinary flying.
    const reliefScale = spec.meta ? 2 ** (13 - spec.meta.zoom) : 1;
    const heightTex = createHeightTexture(gl, heights, size,
                                          { wrap: spec.wrap, unit: 0 });
    const meta = spec.meta;
    // The mosaic is kept, not dropped, so the next window can blit the
    // overlap out of it instead of refetching it. It costs one RGBA copy
    // of the window -- 37.7 MB at twelve tiles -- held for exactly as
    // long as the window is current, and it buys back the 11.6 s a
    // measured two-tile move spent re-downloading ground it already had.
    // Only live mosaics arrive on a canvas; the 2010 map is an <img> and
    // never moves, so it keeps nothing.
    const canvas = typeof spec.image.getContext === 'function'
        ? spec.image : null;
    return {
        name: spec.name, size, heights, heightTex, maxTexels, minTexels, hasSea,
        reliefScale, canvas,
        defaults: spec.defaults || {},
        retroDistance: spec.retroDistance || 300,
        wrap: spec.wrap, procedural: spec.procedural,
        metresPerTexel: mpp, meta,
        attribution: meta ? meta.attribution : null,
        start: spec.start,

        // Texel coordinates back to WGS84, through the slippy-map
        // pixel grid the mosaic was cut from.
        latLon(x, y) {
            if (!meta) return { lat: 0, lon: 0 };
            const n = 256 * 2 ** meta.zoom;
            const wx = meta.tileOrigin[0] * 256 + x;
            const wy = meta.tileOrigin[1] * 256 + y;
            return {
                lon: wx / n * 360 - 180,
                lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / n))) * 180 / Math.PI,
            };
        },
    };
}

async function main() {
    const canvas = document.getElementById('view');
    const settings = { ...DEFAULTS };
    const query = new URLSearchParams(location.search);

    const touchMode = query.has('touch')
        ? query.get('touch') !== '0'
        : isTouchDevice();
    if (touchMode) settings.renderScale = 0.6;
    const pinned = applyQuerySettings(settings);

    let sources, images;
    try {
        [sources, images] = await Promise.all([
            Promise.all([
                loadText('./src/shaders/terrain.vert'),
                loadText('./src/shaders/terrain.frag'),
            ]).then(([vert, frag]) => ({ vert, frag })),
            Promise.all([
                loadImage('./assets/heightmap.png'),
                loadImage('./assets/texture.png'),
                loadImage('./assets/sky.png'),
            ]).then(([heightmap, texture, sky]) => ({ heightmap, texture, sky })),
        ]);
    } catch (err) {
        fail('Could not load the demo’s files',
            `${err.message}\n\n` +
            'If you opened this file directly from disk, that is the ' +
            'problem: browsers block file:// access to the shaders and ' +
            'textures. Serve the folder over HTTP instead:\n\n' +
            '    cd html && python3 -m http.server 8000\n\n' +
            'then open http://localhost:8000/');
        return;
    }

    let renderer;
    try {
        renderer = new Renderer(canvas, sources, images);
    } catch (err) {
        fail('Could not start the renderer', err.message);
        return;
    }
    const gl = renderer.gl;

    const terrains = {
        original: makeTerrain(gl, {
            name: 'original', image: images.heightmap, encoding: 'grey',
            meta: null, wrap: true, procedural: false,
            start: { x: 200, y: 200, altitude: 50, yaw: 0, pitch: 0 },
            defaults: { fogDensity: 0.0012, sunAzimuth: 135, sunElevation: 45 },
            retroDistance: 300,
        }),
    };
    // No terrain is baked any more: every real-world dataset, Caldera
    // included, is fetched from the tileset at runtime. The 2010 map
    // stays because it is not tiled terrain -- it is the demo this port
    // came from.

    // Build a world anywhere, from tiles fetched at runtime. The baked
    // Caldera mosaic stays the default and the offline path stays
    // supported; this only removes "where" from the list of build-time
    // decisions.
    //
    // Replacing a dataset frees the old one explicitly. At 12 tiles the
    // height texture alone is 18 MB and the imagery mosaic 38 MB, so
    // relocating a few times while leaving them to the collector would
    // be a real leak rather than a tidy-up.
    // `key` is the dataset name the result is filed under, and also the
    // <select> value. Registering presets under their own key rather
    // than a single shared 'live' matters: ui.sync() writes
    // settings.terrain back into the select, so a preset filed as 'live'
    // would jump the menu back to the generic entry on the next sync.
    async function flyTo(key, {
        lat, lon, tiles, zoom, label, vs, yaw, alt, pitch,
    }) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        say(`Fetching terrain for ${lat.toFixed(4)}, ${lon.toFixed(4)}…`, 0);
        let got;
        try {
            got = await fetchTerrain({
                lat, lon, zoom, tiles,
                onProgress: (d, total) => {
                    if (d < total) say(`Terrain ${d}/${total} tiles…`, 0);
                },
            });
        } catch (err) {
            say(`Terrain fetch failed (${err && err.message})`, 6000);
            return;
        }
        const old = terrains[key];
        const t = makeTerrain(gl, {
            name: key, image: got.canvas, encoding: 'terrarium',
            meta: got.meta, wrap: false, procedural: true,
            start: {
                // Where the coordinates actually are, not where the tile
                // grid rounds them to. fetchTerrain centres the window on
                // the tile CONTAINING the point, so size/2 is that tile's
                // north-west corner -- up to a whole tile away, 8.2 km at
                // z12. That was invisible while every preset was a broad
                // landscape and is not invisible at all on a coastline,
                // where 8 km is the difference between open water and
                // halfway up a hill. The offset is a fraction of a tile,
                // so the camera still starts well inside the keep box.
                ...texelOf(lat, lon, got.meta),
                altitudeMetres: alt || 900,
                yaw: yaw || 0,
                pitch: pitch === undefined ? -0.10 : pitch,
            },
            // The sun is in the south from the northern hemisphere and in
            // the north from the southern one, so a bearing tuned for
            // Caldera at latitude -27 lights Switzerland from behind.
            defaults: {
                fogDensity: 0.0006, sunElevation: 40,
                sunAzimuth: lat < 0 ? 330 : 210,
            },
            retroDistance: 900,
        });
        terrains[key] = t;
        settings.terrain = key;
        const sel = document.getElementById('terrain');
        if (!sel.querySelector(`option[value="${key}"]`)) {
            sel.insertAdjacentHTML('beforeend', `<option value="${key}"></option>`);
        }
        sel.querySelector(`option[value="${key}"]`).textContent =
            label || `Live — ${got.meta.place}`;
        sel.value = key;
        if (vs) { settings.vertScale = vs; ui.sync(); }
        document.getElementById('place-note').textContent =
            `${(t.size * t.metresPerTexel / 1000).toFixed(0)} km · z${got.meta.zoom}`;
        if (old) {
            gl.deleteTexture(old.heightTex);
            const im = imageryCache[key];
            if (im) { gl.deleteTexture(im.texture); delete imageryCache[key]; }
        }
        selectTerrain(key);
        say(got.failed
            ? `Terrain ready — ${got.failed} tiles missing, shown as sea`
            : `Terrain ready — ${(t.size * t.metresPerTexel / 1000).toFixed(1)} km across`);
    }

    // The terrain window follows the camera, so the world is unbounded
    // rather than a fetched rectangle. Two things can trigger a move: the
    // camera leaving the middle half of the current window, or the speed
    // asking for a different zoom.
    //
    // Zoom from speed is what makes this tractable, and it replaces a
    // coarse fallback layer rather than complementing it: at speed the
    // window IS coarse and wide enough to reach the horizon, so there is
    // only ever one terrain layer. See GLOBAL-FLIGHT.md.
    let windowBusy = false;
    // What the last move actually cost, for the HUD: the point of the
    // carry-over is that "new" stays small however often a move happens.
    let lastMove = null;
    async function moveWindow() {
        const t = current;
        if (windowBusy || !t.procedural || !t.meta) return;
        const tiles = settings.liveTiles;
        // Roam governs automatic moves. Resizing the window is not one --
        // it is something the user just asked for -- so it goes through
        // even with streaming switched off.
        if (tiles === t.meta.tiles && !settings.roam) return;
        const here = t.latLon(camera.x, camera.y);
        const speedMps = camera.speed * t.metresPerTexel;
        // A resize cannot be done in place -- the mosaic is one texture
        // and the tile origin shifts -- so it goes through the same
        // fetch-and-rebase path as any other move. rebase() works off the
        // global slippy grid, so it does not care that the window changed
        // shape as well as position.
        //
        // Currently unreachable: `liveTiles` was a panel control and is
        // now read only from `?tiles=`, which boot honours directly, so
        // nothing changes it mid-flight. Kept because it is the tested
        // path -- the vertical-scale bug lived here -- and because it is
        // what a re-exposed control would use.
        const sizeMove = tiles !== t.meta.tiles;
        // The draw distance that will be in force AFTER this move, not the
        // one in force now. On a resize the two differ: the setting still
        // holds the outgoing window's value, because it is re-derived in
        // selectTerrain once the new window exists. Feeding the stale one
        // in made a 12x12 -> 4x4 switch measure a 4-tile window against a
        // 1200-texel view, decide it could not hold one, and drop to z10 --
        // which multiplies reliefScale by four and renders the mountains
        // four times too tall. Worse, it ratcheted: coming back from 4x4
        // landed on z11, not z12.
        const drawTexels = sizeMove ? tiles * DRAW_PER_TILE : settings.drawDistance;
        const want = windowZoom({
            speed: speedMps, lat: here.lat, tiles,
            maxZoom: settings.liveZoom,
            // The old floor was a flat 20 km, which never bound at twelve
            // tiles and bound hard at two -- a 17 km window would have
            // been dragged a zoom level coarser the moment it moved. Tie
            // it to what is actually being drawn instead: a window should
            // hold at least twice the view, whatever size it is.
            minCoverage: drawTexels * t.metresPerTexel * 2,
        });
        // Hysteresis on the zoom, and the smoothed speed underneath it,
        // so a tapped boost key cannot launch a 144-tile fetch.
        //
        // Locked, none of that runs: the window stays at liveZoom however
        // fast the camera moves. Zoom-from-speed was built to hold the
        // window at a fixed time to cross, and it does -- but zoom also
        // sets reliefScale, so every level it shed changed how tall the
        // world looked. Holding it still is the trade: the terrain keeps
        // one scale and one sharpness, and pays for it in refetch rate
        // once the speed is high enough to cross a window inside a
        // minute (about 1.7 km/s at twelve tiles, z12).
        const zoomMove = !settings.lockZoom
                      && Math.abs(want.zoomF - t.meta.zoom) > 1.0
                      && want.zoom !== t.meta.zoom;
        // How far ahead the fetch has to be started. The camera can see
        // `drawDistance` texels and it keeps travelling while a window
        // is in flight, so the trigger has to stand off by both. Speed
        // moves the trigger forward; it cannot move the edge back.
        //
        // The lead is capped at half the margin. Spend all of it and the
        // trigger lands exactly where the previous move dropped the
        // camera, and the window refetches without pause; half leaves
        // runway on both sides of centre.
        //
        // What is left is a limit in time rather than in policy. At
        // twelve tiles and z12 the margin is 336 texels, 10.8 km, which
        // at Mach 9 is 3.6 seconds of flight. Carrying the overlap makes
        // a move about a second, which fits; a fetch that stalls to
        // seven or eight does not, and the view runs past the data until
        // the next window lands. Measured over a 120 s run at Mach 9:
        // held for the length of it apart from one such stall, which it
        // recovered from on its own. More ground per window is the only
        // real answer, which is what unlocking the zoom buys.
        const margin = safeMargin(t.meta.size, settings.drawDistance);
        const lead = Math.min(camera.speed * FETCH_SECONDS,
                              Math.max(0, margin * 0.5));
        // A window that cannot hold its own view from the centre is a
        // configuration error rather than something a move can fix, so
        // the trigger is clamped short of "always true".
        const reach = Math.min(settings.drawDistance + lead,
                               t.meta.size * 0.45);
        if (!zoomMove && !sizeMove
            && !needsMove(camera.x, camera.y, t.meta.size, reach)) return;

        windowBusy = true;
        // A resize centres on the camera; only a move leads ahead of it.
        // Lead ahead by whatever the reach leaves over, less a tenth so
        // the camera lands strictly inside the trigger rather than on
        // it. Leading further would buy runway in front by handing the
        // same distance to the edge behind, which is the trade that put
        // the trailing edge inside the view on every move.
        const [cx, cy] = sizeMove
            ? [camera.x, camera.y]
            : nextCentre(camera.x, camera.y,
                         camera.vel[0], camera.vel[1], t.meta.size,
                         0.25, (t.meta.size / 2 - reach) * 0.9);
        const centre = t.latLon(cx, cy);
        const zoom = zoomMove ? want.zoom : t.meta.zoom;
        // A move is only worth making if it actually shifts the tile
        // grid. Windows are cut on whole tiles, so a camera less than a
        // tile from the centre re-fetches the identical origin -- and
        // now that the trigger stands off by the draw distance rather
        // than by a quarter of the window, that case is reachable: the
        // grid quantisation is 256 texels and the trigger can sit inside
        // it. Without this the window would ask again on the next tick,
        // fetch nothing, and never stop. If the origin cannot move, the
        // view really does reach past the data, and the HUD says so.
        const [ntx, nty] = tileXY(centre.lat, centre.lon, zoom);
        if (!zoomMove && !sizeMove
            && ntx - (tiles >> 1) === t.meta.tileOrigin[0]
            && nty - (tiles >> 1) === t.meta.tileOrigin[1]) {
            windowBusy = false;
            return;
        }
        let got;
        const began = performance.now();
        try {
            got = await fetchTerrain({
                lat: centre.lat, lon: centre.lon, zoom, tiles,
                // Same zoom and the same slippy grid, so the overlap is
                // a whole number of pixels and copies exactly. A lead of
                // a tile or two leaves most of the window already in
                // hand; only the newly exposed edge is fetched.
                prev: { canvas: t.canvas, meta: t.meta },
            });
        } catch (err) {
            windowBusy = false;
            return;
        }
        lastMove = {
            fetched: got.fetched, reused: got.reused,
            seconds: (performance.now() - began) / 1000,
        };
        // The old window has been rendering throughout; swap only now.
        const key = t.name;
        const next = makeTerrain(gl, {
            name: key, image: got.canvas, encoding: 'terrarium',
            meta: got.meta, wrap: false, procedural: true,
            start: t.start, defaults: t.defaults,
            retroDistance: t.retroDistance,
        });

        // Rebase. World texels sit on a global slippy grid, so this is
        // affine, not a translation: across a zoom change a texel changes
        // size and everything measured in texels changes with it. A
        // same-zoom move has k = 1 and identical overlapping tiles, so
        // the ground does not shift at all.
        //
        // Horizontally, that is. The vertical axis does NOT scale with
        // zoom, and it is reliefScale that makes it so: a height in
        // rendered texels is metres/mpp * 2^(13 - zoom), and mpp goes as
        // 2^-zoom, so the two cancel exactly -- a 1000 m peak is 58.8
        // texels at z13, z12, z11, z9, every level. That invariance is
        // the whole point of reliefScale, and scaling z by k as well
        // broke it from the other side: the terrain kept its height
        // while the camera was pulled down to half its clearance on
        // every zoom-out. 500 m over a peak became 250, then 125, then
        // 63 -- which looks exactly like the vertical scale drifting off
        // 1.0 each time a new window loads.
        const k = scaleBetween(t.meta, got.meta);
        const [nx, ny] = rebase([camera.x, camera.y], t.meta, got.meta);
        camera.x = nx; camera.y = ny;
        camera.vel[0] *= k;
        camera.vel[1] *= k;
        camera.speed *= k;

        gl.deleteTexture(t.heightTex);
        // The outgoing mosaic is handed to the incoming one rather than
        // dropped: the overlap is a whole number of pixels, so it copies
        // across exactly and the world never blanks. Only then is it
        // freed -- the copy is synchronous inside loadImagery.
        const oldIm = imageryCache[key];
        delete imageryCache[key];
        imagerySeed = oldIm;
        terrains[key] = next;
        selectTerrain(key, true);      // keep the pose we just rebased
        imagerySeed = null;
        if (oldIm) gl.deleteTexture(oldIm.texture);
        windowBusy = false;
    }

    // Something must be current before the first fetch lands; the 2010
    // map is the only dataset that exists without a network round trip.
    let current = terrains[settings.terrain] || terrains.original;

    // Ground height in the engine's texel units, vertical exaggeration
    // included. Outside a finite dataset there is open sea.
    const groundAt = (x, y) => {
        const t = current;
        const size = t.size;
        let u, v;
        if (t.wrap) {
            u = ((Math.floor(x) % size) + size) % size;
            v = ((Math.floor(y) % size) + size) % size;
        } else {
            if (x < 0 || y < 0 || x >= size || y >= size) return 0;
            u = Math.floor(x);
            v = Math.floor(y);
        }
        const scale = t.procedural ? settings.vertScale * t.reliefScale : 1;
        return t.heights[v * size + u] * scale;
    };

    // Defined before anything that might report through it: the imagery
    // loader can fail during start-up, and its handler needs this.
    const hint = document.getElementById('hint');
    let hintTimer = null;
    const say = (text, ms = 2600) => {
        hint.textContent = text;
        hint.hidden = false;
        clearTimeout(hintTimer);
        if (ms) hintTimer = setTimeout(() => { hint.hidden = true; }, ms);
    };

    const camera = new Camera(groundAt);
    const ui = new UI(settings, (key) => {
        if (key === 'terrain') {
            // A preset that has already been fetched is just a dataset;
            // one that has not needs fetching first.
            const m = /^place:(\d+)$/.exec(settings.terrain);
            if (m && !terrains[settings.terrain]) {
                const pl = PLACES[+m[1]];
                flyTo(settings.terrain, {
                    lat: pl.lat, lon: pl.lon,
                    tiles: settings.liveTiles,
                    zoom: pl.zoom || settings.liveZoom,
                    label: pl.name, vs: pl.vs, yaw: pl.yaw, alt: pl.alt, pitch: pl.pitch,
                });
            } else {
                if (m) settings.vertScale = PLACES[+m[1]].vs || settings.vertScale;
                selectTerrain(settings.terrain);
                if (m) ui.sync();
            }
        }
        // Both ladders move at once, so both need waking: the rings
        // re-target on the next frame, and the window is re-examined
        // in case unlocking has left it at a level speed no longer wants.
        if (key === 'lockZoom') { for (const d of detail) d.invalidate(); moveWindow(); }
        if (key === 'imagery') ensureImagery();
        if (key === 'detailDistance') for (const d of detail) d.invalidate();
    });

    // Imagery is fetched live rather than shipped as an asset: the
    // terrain tiles are open data, Esri's imagery is not, and runtime
    // fetching is the ordinary usage pattern where baking a mosaic into
    // the repository would be redistribution.
    const imageryCache = {};
    // Set for the duration of one selectTerrain call, so a window move
    // can hand the outgoing mosaic to the incoming one.
    let imagerySeed = null;
    let detail = [];            // clipmap rings, real data only
    let detailInfo = [null, null];   // published rectangles, for the readout

    function ensureImagery() {
        const t = current;
        showAttribution();
        if (!t.procedural || !settings.imagery) return;
        if (imageryCache[t.name]) {
            renderer.setImagery(imageryCache[t.name]);
            return;
        }
        // z14 over z13 terrain is 8.5 m/px, a 3584px mosaic, ~51 MB of
        // texture. Touch devices stay at the terrain's own zoom, where
        // the mosaic is a quarter of the size.
        // The base mosaic is (tiles * 2^(zoom - meta.zoom) * 256)^2, so a
        // finer base zoom quadruples it: over the 16-tile extent, z14
        // would be 8192px and 268 MB of texture. Cap the side at 4096 and
        // fall back to the terrain's own zoom, which costs base sharpness
        // beyond the detail rings' reach and nothing within it.
        const step = touchMode ? 0 : 1;
        const zoom = t.meta.tiles * 256 * 2 ** step <= 4096
            ? t.meta.zoom + step : t.meta.zoom;
        let im;
        im = loadImagery(gl, t.meta, {
            zoom, seed: imagerySeed,
            onProgress: (done, total, failed) => {
                if (done < total) { say(`Loading imagery ${done}/${total}…`, 0); return; }
                if (im && im.carried) {
                    say(`Imagery — ${im.carried} tiles carried over, ${total} fetched`);
                    return;
                }
                const mpx = t.metresPerTexel / 2 ** (zoom - t.meta.zoom);
                say(failed
                    ? `Imagery loaded — ${failed} of ${total} tiles missing`
                    : `Imagery loaded — ${mpx.toFixed(1)} m/px`);
            },
        });
        imageryCache[t.name] = im;
        renderer.setImagery(im);
        showAttribution();

        // The base mosaic caps out at 8.5 m/px however low you fly, so two
        // rings follow the camera above it: the finest level that reaches
        // what is being looked at, and one level coarser over twice the
        // ground. One ring alone cannot be both fine and wide -- each
        // level finer halves the span for the same tile budget -- so the
        // sides of the frame were dropping to the base mosaic whatever
        // the switch distance was set to.
        for (const d of detail) d.dispose();
        detailInfo = [null, null];
        const size = touchMode ? 1280 : 2560;
        detail = RING_OFFSETS.map((zoomOffset, slot) => new DetailImagery(gl, t.meta, {
            size,
            baseZoom: zoom,
            base: im,
            unit: slot === 0 ? 4 : 5,
            zoomOffset,
            concurrency: slot === 0 ? 16 : 8,
            onChange: (layer) => {
                detailInfo[slot] = layer;
                renderer.setDetail(layer, slot);
            },
            // Only the inner ring announces the ceiling; both discover it,
            // but one toast is enough.
            onCeiling: slot === 0
                ? (z) => say(`Imagery detail tops out at z${z} here`, 4000)
                : undefined,
        }));
        im.ready.catch((err) => {
            console.error('Imagery failed:', err);
            say(`Imagery unavailable (${err && err.message}) — using elevation colours`, 8000);
            settings.imagery = false;
            ui.sync();
            showAttribution();
        });
    }

    function showAttribution() {
        const lines = [...(current.attribution || [])];
        if (current.procedural && settings.imagery) lines.push(IMAGERY_ATTRIBUTION);
        ui.setAttribution(lines);
    }

    function selectTerrain(name, keepPose = false) {
        current = terrains[name] || terrains.original;
        settings.wrapWorld = current.wrap;
        settings.worldSize = current.size;
        renderer.useTerrain(current);
        ui.showDataset(current);
        ui.setRetroDistance(current.retroDistance, pinned.has('drawDistance'));
        renderer.setImagery(imageryCache[current.name] || null);
        ensureImagery();
        // Ahead of the keepPose bail: a window resize deliberately keeps
        // the pose, and is exactly the case where the draw distance has
        // to move with it.
        if (current.procedural && current.meta
            && current.size !== drawDerivedFor) {
            drawDerivedFor = current.size;
            ui.setWindowDistance(current.meta.tiles * DRAW_PER_TILE,
                                 pinned.has('drawDistance'));
        }
        if (keepPose) return;
        for (const [k, v] of Object.entries(current.defaults)) {
            if (!pinned.has(k)) settings[k] = v;
        }
        ui.sync();
        const s = current.start;
        const clearance = s.altitudeMetres !== undefined
            ? s.altitudeMetres / current.metresPerTexel
              * settings.vertScale * current.reliefScale
            : s.altitude;
        camera.place(s.x, s.y, clearance, s.yaw, s.pitch);
    }
    // A preset selected at boot has to be fetched before it can be shown.
    const bootPlace = /^place:(\d+)$/.exec(settings.terrain);
    if (bootPlace && PLACES[+bootPlace[1]]) {
        selectTerrain('original');
        const pl = PLACES[+bootPlace[1]];
        flyTo(settings.terrain, {
            lat: pl.lat, lon: pl.lon,
            tiles: settings.liveTiles,
            zoom: pl.zoom || settings.liveZoom,
            label: pl.name, vs: pl.vs, yaw: pl.yaw, alt: pl.alt, pitch: pl.pitch,
        });
    } else {
        selectTerrain(settings.terrain);
    }
    applyQueryPose(camera);

    // The preset menu. Each entry is a dataset key of its own, so
    // re-selecting one reuses nothing and rebuilds cleanly.
    {
        const sel = document.getElementById('terrain');
        const g = document.createElement('optgroup');
        g.label = 'Fetched live';
        for (let i = 0; i < PLACES.length; i++) {
            const o = document.createElement('option');
            o.value = `place:${i}`;
            o.textContent = PLACES[i].name;
            g.appendChild(o);
        }
        sel.appendChild(g);
    }

    // "Fly to", from the URL and from the panel. Enter submits, which is
    // what a single text field wants; the form-less markup means the key
    // has to be caught by hand.
    const placeGo = () => {
        const m = document.getElementById('place').value
            .split(/[ ,]+/).map(parseFloat).filter(Number.isFinite);
        if (m.length >= 2) {
            flyTo('live', { lat: m[0], lon: m[1],
                            tiles: settings.liveTiles, zoom: settings.liveZoom });
        }
    };
    document.getElementById('place-go').addEventListener('click', placeGo);
    document.getElementById('place').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); placeGo(); }
    });
    // ?place= takes an index or any part of the name, so a preset is as
    // shareable as a pinned pose.
    if (query.has('place')) {
        const q = query.get('place').toLowerCase();
        const i = /^\d+$/.test(q) ? +q
            : PLACES.findIndex((pl) => pl.name.toLowerCase().includes(q));
        const pl = PLACES[i];
        if (pl) {
            document.getElementById('terrain').value = `place:${i}`;
            flyTo(`place:${i}`, {
                lat: pl.lat, lon: pl.lon,
                tiles: settings.liveTiles,
                zoom: pl.zoom || settings.liveZoom,
                label: pl.name, vs: pl.vs, yaw: pl.yaw,
            });
        } else {
            say(`No preset matching "${query.get('place')}"`, 5000);
        }
    }
    if (query.has('lat') && query.has('lon')) {
        document.getElementById('place').value =
            `${query.get('lat')}, ${query.get('lon')}`;
        flyTo('live', {
            lat: parseFloat(query.get('lat')), lon: parseFloat(query.get('lon')),
            tiles: settings.liveTiles, zoom: settings.liveZoom,
        });
    }
    if (query.has('retro') && !query.has('dist')) ui.applyMode();
    ui.sync();
    if (touchMode && !query.has('panel')) ui.toggle();
    // ?hud=0 strips the overlay, for screenshots of the render alone.
    const noHud = query.get('hud') === '0';
    if (noHud) document.getElementById('panel').hidden = true;

    const input = new Input(canvas, {
        onToggleUI: () => ui.toggle(),
        onFov: (d) => {
            settings.fov = Math.min(120, Math.max(30, settings.fov + d));
            ui.sync();
        },
    });

    let touch = null;
    let tilt = null;
    if (touchMode) {
        touch = new TouchControls(canvas, { onToggleUI: () => ui.toggle() });
        tilt = new Tilt({
            onStateChange: (t) => {
                const btn = document.getElementById('btn-tilt');
                btn.classList.toggle('on', t.enabled);
                if (t.unavailableReason) say(t.unavailableReason, 5000);
                else say(t.enabled ? 'Tilt look on — ⌖ re-centres' : 'Tilt look off');
            },
        });
        document.getElementById('btn-tilt')
            .addEventListener('click', () => tilt.toggle());
        document.getElementById('btn-center')
            .addEventListener('click', () => {
                tilt.recentre(camera);
                say('View re-centred');
            });
        if (!tiltSupported()) document.getElementById('btn-tilt').disabled = true;
        hint.hidden = true;
        document.querySelector('#panel .note').textContent =
            'Drag to look · stick to move · ⚙ hides';
    } else if (noHud) {
        hint.hidden = true;
    } else {
        say('Click to capture the mouse', 0);
        document.addEventListener('pointerlockchange', () => {
            hint.hidden = document.pointerLockElement === canvas;
        });
    }

    notify = say;

    let lastRoamCheck = 0;
    let last = performance.now();
    let fps = 0, frames = 0, fpsClock = last;

    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;

        const intent = input.intent();
        if (touch) touch.contribute(intent);
        if (tilt) tilt.contribute(intent);

        renderer.resize(settings.renderScale);
        // The camera needs the dataset's scale to turn a speed in metres
        // into one in texels; datasets without a real scale keep the
        // 2010 constants.
        settings.metresPerTexel = current.procedural ? current.metresPerTexel : null;
        settings.speedMps = 10 ** settings.speedLog;
        camera.update(dt, intent, settings);

        // Detail LOD is driven by how far away the terrain being looked
        // at is, not by altitude -- the two only coincide when the
        // camera points straight down.
        if (detail.length && settings.imagery && current.procedural) {
            const fwd = camera.basis().fwd;
            const flat = Math.hypot(fwd[0], fwd[1]) || 1;
            const state = {
                x: camera.x,
                y: camera.y,
                // Height in the geometry the rays actually march, not the
                // metric altitude the readout shows. Heights are
                // exaggerated by vertScale while horizontal distance is
                // not, so a camera reading 500 m sits 88 texels up and
                // looks at ground three times further away than its
                // metric altitude implies. Dividing the exaggeration out
                // here put the detail rectangle at a third of the
                // distance it needed to be, and every pixel on screen
                // fell outside it above ~200 m.
                agl: camera.clearance * current.metresPerTexel,
                pitch: camera.pitch,
                dirX: fwd[0] / flat,
                dirY: fwd[1] / flat,
                fovY: settings.fov * Math.PI / 180,
                screenPx: canvas.height,
                thresholdM: settings.detailDistance * 1000,
                speedMps: camera.speed * (current.metresPerTexel || 1),
                lockZoom: settings.lockZoom,
            };
            for (const d of detail) d.update(state);
        }

        // Wind offsets arrive in metres and degrees; the camera works in
        // world texels, and the vertical is exaggerated, so heave is
        // scaled the same way altitude is.
        const w = windOffsets(now / 1000, settings.wind);
        const mpt = current.metresPerTexel || 1;
        const vs = current.procedural ? settings.vertScale * current.reliefScale : 1;
        // Checked a few times a second, not every frame: it is a
        // predicate over smoothed speed and position, and it starts
        // network work.
        if (now - lastRoamCheck > 400) { lastRoamCheck = now; moveWindow(); }

        renderer.draw(camera, settings, camera.viewBasis(w && {
            yaw: w.yaw, pitch: w.pitch, roll: w.roll,
            sway: w.sway / mpt,
            heave: w.heave / mpt * vs,
        }));

        frames++;
        if (now - fpsClock >= 250) {
            fps = frames * 1000 / (now - fpsClock);
            frames = 0; fpsClock = now;
            ui.update(fps, camera, canvas.width, canvas.height, current,
                      settings.imagery ? detailInfo : [null, null],
                      detail.length ? detail[0].lastTarget : null,
                      current.procedural ? {
                          gap: edgeGap(camera.x, camera.y, current.size),
                          moving: windowBusy, move: lastMove,
                      } : null);
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.dataset.ready = '1';
    }));

    booted = true;
}

// Error severity depends entirely on whether the demo is running yet.
//
// Before boot completes, nothing works, so a full-screen message is the
// right response. Once the renderer is live, a stray exception -- an
// input handler, a sensor callback -- must NOT destroy a working demo.
let booted = false;
let notify = null;

function nonFatal(what, err) {
    console.error(`${what}:`, err);
    if (notify) notify('Recovered from an internal error — see console', 4000);
}

// A boot failure is worth a stack: the message alone rarely says which
// of the start-up steps went wrong.
const details = (err, fallback) =>
    (err && err.stack) ? err.stack : String(fallback);

addEventListener('error', (e) => {
    if (booted) nonFatal('Non-fatal error', e.error || e.message);
    else fail('Unexpected error', details(e.error, e.message));
});
addEventListener('unhandledrejection', (e) => {
    if (booted) nonFatal('Non-fatal rejection', e.reason);
    else fail('Unexpected error', details(e.reason, e.reason));
    e.preventDefault();
});

main().catch((err) => fail('Unexpected error', err.stack || String(err)));
