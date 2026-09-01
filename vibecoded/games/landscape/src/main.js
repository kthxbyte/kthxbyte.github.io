import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { Tilt, tiltSupported } from './tilt.js';
import { loadImagery, DetailImagery, IMAGERY_ATTRIBUTION } from './imagery.js';
import { UI, DEFAULTS, fail } from './ui.js';
import { loadImage, decodeHeights, createHeightTexture } from './gl.js';
import { windOffsets } from './wind.js';
import { fetchTerrain } from './terrain-tiles.js';
import { PLACES } from './places.js';

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
// Four to six per cent at the edges of the frame does not pay for double
// the tiles per refresh and another 52 MB of texture. The machinery
// stays (DetailImagery takes `unit` and `zoomOffset`, the shader blends
// two rings coarsest-first), so adding `-1` here turns it back on; the
// measurements above are the case that would need to change.
const RING_OFFSETS = [0];

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
    const hasSea = mpp ? minTexels * mpp < 5 : true;
    const heightTex = createHeightTexture(gl, heights, size,
                                          { wrap: spec.wrap, unit: 0 });
    const meta = spec.meta;
    return {
        name: spec.name, size, heights, heightTex, maxTexels, minTexels, hasSea,
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

    let sources, images, calderaMeta;
    try {
        [sources, images, calderaMeta] = await Promise.all([
            Promise.all([
                loadText('./src/shaders/terrain.vert'),
                loadText('./src/shaders/terrain.frag'),
            ]).then(([vert, frag]) => ({ vert, frag })),
            Promise.all([
                loadImage('./assets/heightmap.png'),
                loadImage('./assets/texture.png'),
                loadImage('./assets/sky.png'),
                loadImage('./assets/terrain-caldera.png'),
            ]).then(([heightmap, texture, sky, caldera]) =>
                ({ heightmap, texture, sky, caldera })),
            loadJSON('./assets/terrain-caldera.json'),
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
        caldera: makeTerrain(gl, {
            name: 'caldera', image: images.caldera, encoding: 'terrarium',
            meta: calderaMeta, wrap: false, procedural: true,
            // Offshore, looking east: 5.5 km of water, then the
            // coastline, then the range climbing to 950 m. The approach
            // from the sea shows the whole structure at once.
            // The mosaic grew from 7x7 tiles to 16x16, and its tile
            // origin moved with it (2481,4733 -> 2476,4728), so world
            // coordinates shifted by 5 tiles = 1280 texels on each axis.
            // This is the same patch of coast as before, renumbered.
            start: { x: 1710, y: 2176, altitudeMetres: 500, yaw: 0, pitch: -0.04 },
            // Atacama air is exceptionally clear; the 2010 map's haze
            // was tuned for a much smaller world.
            // Caldera is at latitude -27: the sun is in the NORTH.
            // A bearing of 330 gives raking afternoon light from the
            // north-west, which is what this coast actually sees.
            defaults: { fogDensity: 0.0006, sunAzimuth: 330, sunElevation: 40 },
            // 15 km, so retro's hard horizon lands beyond the bay rather
            // than cutting a visible circle out of the open sea.
            retroDistance: 900,
        }),
    };

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
    async function flyTo(key, { lat, lon, tiles, zoom, label, vs, yaw }) {
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
                x: got.meta.size / 2, y: got.meta.size / 2,
                altitudeMetres: 900, yaw: yaw || 0, pitch: -0.10,
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

    let current = terrains[settings.terrain] || terrains.caldera;

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
        const scale = t.procedural ? settings.vertScale : 1;
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
                    tiles: pl.tiles || settings.liveTiles,
                    zoom: pl.zoom || settings.liveZoom,
                    label: pl.name, vs: pl.vs, yaw: pl.yaw,
                });
            } else {
                if (m) settings.vertScale = PLACES[+m[1]].vs || settings.vertScale;
                selectTerrain(settings.terrain);
                if (m) ui.sync();
            }
        }
        if (key === 'imagery') ensureImagery();
        if (key === 'detailDistance') for (const d of detail) d.invalidate();
    });

    // Imagery is fetched live rather than shipped as an asset: the
    // terrain tiles are open data, Esri's imagery is not, and runtime
    // fetching is the ordinary usage pattern where baking a mosaic into
    // the repository would be redistribution.
    const imageryCache = {};
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
        const im = loadImagery(gl, t.meta, {
            zoom,
            onProgress: (done, total, failed) => {
                if (done < total) { say(`Loading imagery ${done}/${total}…`, 0); return; }
                say(failed
                    ? `Imagery loaded — ${failed} of ${total} tiles missing`
                    : `Imagery loaded — ${zoom === t.meta.zoom ? '17' : '8.5'} m/px`);
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
        current = terrains[name] || terrains.caldera;
        settings.wrapWorld = current.wrap;
        settings.worldSize = current.size;
        renderer.useTerrain(current);
        ui.showDataset(current);
        ui.setRetroDistance(current.retroDistance, pinned.has('drawDistance'));
        renderer.setImagery(imageryCache[current.name] || null);
        ensureImagery();
        if (keepPose) return;
        for (const [k, v] of Object.entries(current.defaults)) {
            if (!pinned.has(k)) settings[k] = v;
        }
        ui.sync();
        const s = current.start;
        const clearance = s.altitudeMetres !== undefined
            ? s.altitudeMetres / current.metresPerTexel * settings.vertScale
            : s.altitude;
        camera.place(s.x, s.y, clearance, s.yaw, s.pitch);
    }
    selectTerrain(settings.terrain);
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
                tiles: pl.tiles || settings.liveTiles,
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

    let last = performance.now();
    let fps = 0, frames = 0, fpsClock = last;

    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;

        const intent = input.intent();
        if (touch) touch.contribute(intent);
        if (tilt) tilt.contribute(intent);

        renderer.resize(settings.renderScale);
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
            };
            for (const d of detail) d.update(state);
        }

        // Wind offsets arrive in metres and degrees; the camera works in
        // world texels, and the vertical is exaggerated, so heave is
        // scaled the same way altitude is.
        const w = windOffsets(now / 1000, settings.wind);
        const mpt = current.metresPerTexel || 1;
        const vs = current.procedural ? settings.vertScale : 1;
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
                      detail.length ? detail[0].lastTarget : null);
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
