import { compileProgram, uniformLocations } from './gl.js';

// Satellite imagery, fetched at runtime and assembled into one texture.
//
// Esri's World Imagery uses the same Web Mercator tile grid as the
// terrain tiles, so the two register pixel-for-pixel with no
// reprojection: measured alignment against the elevation-derived
// coastline is dx=0, dy=0. Because the grids nest, imagery can be taken
// at a finer zoom than the terrain and still cover exactly the same
// ground -- z14 gives 8.5 m/px over 17 m/px terrain.
//
// Tiles are fetched live rather than baked into an asset. The terrain
// tiles are open data; Esri's imagery is not -- it is licensed under
// Esri's Master License Agreement, and while fetching tiles at runtime
// is the ordinary, universal usage pattern (it is what every Leaflet
// map does), caching a mosaic into a published repository would be
// redistribution. Hence: no imagery file in assets/.

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services' +
             '/World_Imagery/MapServer/tile';

export const IMAGERY_ATTRIBUTION =
    'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User ' +
    'Community · Powered by Esri';

const UNIT = 3;             // texture unit reserved for imagery
// Measured against Esri over HTTP/2, 100 z17 tiles: 3.09 s at 8, 1.83 s
// at 16, 1.92 s at 24, 1.99 s at 32. Sixteen is the knee -- 8 left most
// of the available throughput unused, and past 16 the server, not the
// client, is the limit.
const CONCURRENCY = 16;

// Esri puts the row before the column: /{z}/{y}/{x}, not the {z}/{x}/{y}
// that OpenStreetMap and the terrain tiles use. Getting this backwards
// silently returns a valid tile from the wrong place.
function tileUrl(z, x, y) {
    return `${ESRI}/${z}/${y}/${x}`;
}

function loadOnce(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';   // required to use it as a texture
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(url));
        img.src = url;
    });
}

// Fetching ~200 tiles at once reliably loses one or two to transient
// errors. A single delayed retry recovers them; without it the mosaic
// ships with visible holes.
async function loadTile(url) {
    try {
        return await loadOnce(url);
    } catch (err) {
        await new Promise((r) => setTimeout(r, 400));
        return loadOnce(url + '?retry=1');
    }
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

// Starts the fetch and returns immediately with a texture that fills in
// as tiles arrive, so the view is usable while it loads.
export function loadImagery(gl, meta, { zoom, onProgress }) {
    const k = 2 ** (zoom - meta.zoom);
    const n = meta.tiles * k;
    const size = n * 256;
    const x0 = meta.tileOrigin[0] * k;
    const y0 = meta.tileOrigin[1] * k;

    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);
    // LINEAR rather than a mipmapped filter until the mosaic is complete:
    // with no mip chain yet, a mipmapped filter would make the texture
    // incomplete and sample black.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Clear to a neutral desert tone. Freshly allocated texture memory
    // is undefined, so without this the mosaic fills in over black.
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, texture, 0);
    gl.clearColor(0.62, 0.55, 0.44, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);

    const state = { unit: UNIT, size, zoom, done: false };

    const jobs = [];
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) jobs.push([i, j]);
    }

    let done = 0, failed = 0;
    state.ready = pool(jobs, CONCURRENCY, async ([i, j]) => {
        try {
            const img = await loadTile(tileUrl(zoom, x0 + i, y0 + j));
            gl.activeTexture(gl.TEXTURE0 + UNIT);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, i * 256, j * 256,
                             gl.RGBA, gl.UNSIGNED_BYTE, img);
        } catch (err) {
            failed++;                     // a hole, not a failure
        }
        done++;
        if (onProgress && done % 16 === 0) onProgress(done, jobs.length, failed);
    }).then(() => {
        gl.activeTexture(gl.TEXTURE0 + UNIT);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                         gl.LINEAR_MIPMAP_LINEAR);
        const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
        if (aniso) {
            gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
                Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
        }
        if (onProgress) onProgress(jobs.length, jobs.length, failed);
        state.done = true;
        return { failed, total: jobs.length };
    });

    // `done` gates the detail layer's seeding: seeding from a mosaic
    // that is still all clear-colour paints flat sand over the terrain.
    state.texture = texture;
    return state;
}


// ---------------------------------------------------------------------
// Moving detail layer
// ---------------------------------------------------------------------
//
// The base mosaic covers the whole 30.5 km extent at a fixed zoom, which
// caps detail at 8.5 m/px however low you fly. This adds a second, much
// smaller texture that follows the camera at a zoom chosen from altitude,
// and the shader prefers it wherever it applies.
//
// Esri carries genuine detail down to z19 (0.27 m/px) here -- verified by
// comparing each level against a bilinear upsample of the level above.
// Note that a different source layer appears at z18: the tone can shift
// between levels, which is part of why the shader cross-fades rather than
// switching hard.
//
// This is deliberately two levels, not a clipmap. One moving layer over a
// static base covers the whole useful altitude range for a 30 km world,
// and costs a fraction of the machinery.

// A new rectangle is seeded from what is already on screen before its
// own tiles arrive, so it can be published immediately instead of after
// the whole load. Publishing late was costing the entire fetch as dead
// time; publishing early with an empty texture would have been worse
// than the base mosaic, which is why it was not done that way first.
// Seeding removes the dilemma: the new layer starts out identical to
// whatever it replaces and only ever improves from there.
const SEED_VERT = `#version 300 es
void main() {
    vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

const SEED_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBase;
uniform sampler2D uOld;
uniform vec2  uNewOrigin;
uniform float uNewSpan;
uniform vec2  uOldOrigin;
uniform float uOldSpan;
uniform float uWorldSize;
uniform float uSize;
uniform bool  uHasOld;
out vec4 outColor;
void main() {
    vec2 p = uNewOrigin + (gl_FragCoord.xy / uSize) * uNewSpan;
    vec3 c = texture(uBase, p / uWorldSize).rgb;
    if (uHasOld) {
        vec2 d = (p - uOldOrigin) / uOldSpan;
        if (d.x >= 0.0 && d.y >= 0.0 && d.x <= 1.0 && d.y <= 1.0) {
            c = texture(uOld, d).rgb;
        }
    }
    outColor = vec4(c, 1.0);
}`;

// Two rings: the finest level that reaches what is being looked at, and
// one level coarser over twice the ground. A single rectangle cannot be
// both fine and wide -- at a fixed tile budget each level finer halves
// the span -- so a rectangle sharp enough for the centre of the frame
// leaves its sides on the base mosaic. The outer ring costs a second
// texture and doubles the tiles per refresh, and is the smallest thing
// that fixes that.
const DETAIL_UNIT = 4;
const DETAIL_UNIT_2 = 5;
// Where a region has no high-resolution coverage, Esri serves a flat
// grey "Map data not yet available" placeholder rather than a 404. It is
// byte-identical at every tile position. Over Caldera that begins at
// z18; real imagery stops at z17 (1.06 m/px). The ceiling is a property
// of the region, so it is detected rather than assumed, starting
// optimistically here and walking down.
const MAX_DETAIL_ZOOM = 19;

// Probe canvas for placeholder detection. 16x16 is plenty: the
// placeholder is flat.
let probeCtx = null;
function isPlaceholder(img) {
    if (!probeCtx) {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        probeCtx = c.getContext('2d', { willReadFrequently: true });
    }
    probeCtx.drawImage(img, 0, 0, 16, 16);
    const d = probeCtx.getImageData(0, 0, 16, 16).data;
    let sum = 0, sum2 = 0, chroma = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const v = (r + g + b) / 3;
        sum += v; sum2 += v * v;
        chroma += Math.abs(r - g) + Math.abs(g - b);
    }
    const variance = sum2 / n - (sum / n) ** 2;
    // Flat AND colourless. Measured over Caldera at 16x16:
    //
    //   real imagery (z16, z17)   variance 370 - 943   chroma 14.0
    //   placeholder  (z18, z19)   variance      6.7    chroma  0.0
    //
    // The thresholds sit in that gap with room on both sides. Open water
    // is flat too, but it is blue -- chroma around 60 -- so the colour
    // test keeps ocean from being mistaken for missing coverage.
    return variance < 60 && chroma / n < 4;
}
// Extra slack beyond the half-level that rounding already provides.
// This was 0.6 on top of a full level, a keep-window of 1.6 levels -- a
// factor of three in viewing distance before the layer would move. It
// suppressed nearly every deliberate change to the switch distance, so
// the control read as dead.
const ZOOM_HYSTERESIS = 0.35;
const RECENTRE_AT = 0.38;      // fraction of the rect before refetching
const MAX_LOOK = 15000;        // metres; beyond this the base is plenty
const MIN_SIN = Math.sin(4 * Math.PI / 180);   // grazing-ray guard

// The reference ray is taken slightly below screen centre. Resolution
// demand is set by the nearest ground in view, but centring the layer on
// the nearest ground would put it under the camera rather than where the
// camera is pointed. A third of the way up from the bottom edge balances
// the two.
const REF_BELOW_CENTRE = 0.15;   // fraction of the vertical field

// How far along the view direction the rectangle is centred, as a
// fraction of the viewing distance. Half-way serves camera and look-at
// point evenly, but the look-at point then sits at the very rim, where
// the border fade has already eaten it. Slightly past half buys reach
// where it is needed, at the cost of detail on ground almost directly
// below -- which is out of frame at the shallow pitches this matters at.
const AHEAD = 0.55;

export class DetailImagery {
    constructor(gl, meta, {
        size, baseZoom, base, onChange, onCeiling, unit, zoomOffset,
        concurrency,
    }) {
        this.gl = gl;
        this.meta = meta;
        this.unit = unit === undefined ? DETAIL_UNIT : unit;
        // 0 for the inner ring, -1 for the outer. Applied after rounding
        // so the two rings are always exactly one level apart, whatever
        // the continuous zoom happens to be.
        this.zoomOffset = zoomOffset || 0;
        // Split unevenly between the rings. Both racing at full width
        // would put 32 requests in flight, past the measured knee, and
        // would delay the inner ring -- the one covering the centre of
        // the view -- behind tiles for the periphery.
        this.concurrency = concurrency || CONCURRENCY;
        this.base = base || null;    // full-extent mosaic, to seed from
        this.seed = null;            // lazily built blit program
        this.baseZoom = baseZoom;         // zoom of the full-extent mosaic
        this.size = size;                 // texture pixels per side
        this.tiles = size / 256;
        this.onChange = onChange || (() => {});
        this.onCeiling = onCeiling || (() => {});
        this.current = null;              // published layer
        this.generation = 0;
        this.loading = false;
        this.maxZoom = MAX_DETAIL_ZOOM;   // lowered when placeholders appear
        this.calibrated = false;
        this.calibrating = false;
        this.metresPerBaseTexel = meta.metresPerPixel;
    }

    // Find the finest level this region actually has, before anything
    // else runs. It cannot be discovered lazily as a side effect of
    // loading: a biased request lands on a level *below* the optimistic
    // ceiling, its probe finds real imagery, and the ceiling is never
    // tested at all -- leaving the bias anchored to a level that does not
    // exist. One tile per level, once; two over Caldera.
    async calibrate(cx, cy) {
        this.calibrating = true;
        while (this.maxZoom > this.baseZoom) {
            const k = 2 ** (this.maxZoom - this.meta.zoom) / 256;
            const tx = Math.floor((cx + this.meta.tileOrigin[0] * 256) * k);
            const ty = Math.floor((cy + this.meta.tileOrigin[1] * 256) * k);
            let img;
            try {
                img = await loadTile(tileUrl(this.maxZoom, tx, ty));
            } catch (err) {
                break;              // network trouble: keep the guess
            }
            let blank = false;
            try { blank = isPlaceholder(img); } catch (err) { blank = false; }
            if (!blank) break;
            this.maxZoom--;
            this.onCeiling(this.maxZoom);
        }
        this.calibrating = false;
        this.calibrated = true;
    }

    // What zoom, and where, given where the camera is looking.
    //
    // Altitude alone is the wrong input: it only equals the viewing
    // distance when the camera points straight down. Flying level, the
    // terrain being looked at is kilometres ahead, so an altitude-driven
    // layer lands under the camera and the detail arrives far too late.
    //
    // Instead: find how far away the terrain under the reference ray is,
    // ask what ground size one screen pixel covers there, and pick the
    // zoom that matches. The span that falls out is about three times
    // that distance, which comfortably spans camera to look-at point.
    // Distance at which the finest available level gives way to the next
    // one down, when the choice is left to the screen alone: the point
    // where one screen pixel covers more ground than that level holds.
    autoThreshold(s) {
        return this.metresPerBaseTexel * Math.max(s.screenPx, 1) / s.fovY
             * 2 ** (this.meta.zoom - this.maxZoom + 0.5);
    }

    // How far a given level's rectangle can serve. With the rect centred
    // AHEAD along the view and the border fade consuming 10% of each
    // side, the look-at point stays inside the full-weight region while
    // (1 - AHEAD) * dist <= 0.4 * span, i.e. dist <= 0.89 * span.
    //
    // Per level, and that distinction matters: each step down doubles the
    // span, so z16 reaches twice as far as z17 and z15 four times. An
    // earlier version clamped the switch DISTANCE to the finest level's
    // reach, which quietly forbade asking for "z16 out to 4 km" even
    // though a z16 rectangle covers 4.85 km comfortably. At the default
    // exaggeration that left three of the slider's five positions
    // identical: the control looked broken when it was only capped
    // against the wrong level.
    reach(zoom) {
        const span = this.tiles * 256 * 2 ** (this.meta.zoom - zoom);
        return span * this.metresPerBaseTexel * 0.89;
    }

    coverLimit() { return this.reach(this.maxZoom); }

    target(s) {
        if (!this.calibrated || this.maxZoom <= this.baseZoom) return null;
        const refPitch = s.pitch - REF_BELOW_CENTRE * s.fovY;
        const sinDown = Math.max(-Math.sin(refPitch), MIN_SIN);
        const dist = Math.min(Math.max(s.agl, 5) / sinDown, MAX_LOOK);

        // Ground covered by one screen pixel at that distance.
        const requiredMpp = dist * s.fovY / Math.max(s.screenPx, 1);

        // The screen-derived threshold is a floor, not a verdict: it says
        // when finer imagery stops being resolvable, which is not the same
        // as when it stops being worth fetching. A hand-set threshold
        // shifts the whole ladder by one bias, so the bands stay a factor
        // of two apart and only their placement moves.
        const auto = this.autoThreshold(s);
        const wanted = s.thresholdM > 0 ? s.thresholdM : auto;
        const asked = this.meta.zoom
                    + Math.log2(this.metresPerBaseTexel / requiredMpp)
                    + Math.log2(wanted / auto);

        // Cap by what a rectangle can actually reach, as a continuous
        // zoom rather than a hard step. Half a level comes off so that
        // round() lands on a level whose reach really does cover `dist`,
        // and keeping it continuous matters for the hysteresis below: a
        // hard clamp would sit permanently more than a level away from
        // the loaded zoom and refetch on every frame.
        const reachF = this.meta.zoom
                     + Math.log2(this.tiles * 256 * this.metresPerBaseTexel
                                 * 0.89 / dist) - 0.5;
        const zoomF = Math.min(asked, reachF);
        const limited = reachF < asked;

        // Below this the full-extent base mosaic is already as fine as
        // the screen can resolve.
        if (zoomF < this.baseZoom + 0.5) return null;

        const zoom = Math.min(this.maxZoom, Math.round(zoomF)) + this.zoomOffset;
        // Below this the ring adds nothing the base mosaic does not
        // already have, so it is better not to fetch it at all.
        if (zoom < this.baseZoom + 1) return null;

        // Centred between the camera and the point it is looking at, so
        // the rectangle serves both rather than trailing behind.
        const ahead = dist * Math.cos(refPitch) * AHEAD / this.metresPerBaseTexel;
        return {
            zoom, zoomF, dist, auto, threshold: wanted, limited,
            cx: s.x + s.dirX * ahead,
            cy: s.y + s.dirY * ahead,
        };
    }

    // Paint the base mosaic -- and the outgoing detail layer where it
    // overlaps -- into a freshly allocated rectangle, so it can go on
    // screen straight away and never looks worse than what it replaced.
    //
    // All GL state touched here is saved and restored: the renderer sets
    // its program and viewport outside the draw loop, so leaving either
    // changed would break the next frame rather than this one, which is
    // an unpleasant bug to track down.
    seedTexture(texture, origin, span) {
        const gl = this.gl;
        if (!this.base) return false;
        if (!this.seed) {
            const prog = compileProgram(gl, SEED_VERT, SEED_FRAG);
            this.seed = {
                prog, u: uniformLocations(gl, prog), fb: gl.createFramebuffer(),
            };
        }
        const { prog, u, fb } = this.seed;
        const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevVp = gl.getParameter(gl.VIEWPORT);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                                gl.TEXTURE_2D, texture, 0);
        gl.viewport(0, 0, this.size, this.size);
        gl.useProgram(prog);
        gl.uniform1i(u.uBase, this.base.unit);
        gl.uniform2f(u.uNewOrigin, origin[0], origin[1]);
        gl.uniform1f(u.uNewSpan, span);
        gl.uniform1f(u.uWorldSize, this.meta.size);
        gl.uniform1f(u.uSize, this.size);
        const old = this.current;
        gl.uniform1i(u.uHasOld, old ? 1 : 0);
        if (old) {
            gl.uniform1i(u.uOld, old.unit);
            gl.activeTexture(gl.TEXTURE0 + old.unit);
            gl.bindTexture(gl.TEXTURE_2D, old.texture);
            gl.uniform2f(u.uOldOrigin, old.origin[0], old.origin[1]);
            gl.uniform1f(u.uOldSpan, old.span);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
        if (prevProg) gl.useProgram(prevProg);
        return true;
    }

    // A deliberate change to the switch distance must take effect at once,
    // rather than waiting for flying to drift past the hysteresis window.
    invalidate() { this.stale = true; }

    // Called every frame; cheap unless something actually needs to change.
    update(s) {
        if (!this.calibrated) {
            if (!this.calibrating) this.calibrate(s.x, s.y);
            this.lastTarget = null;
            return;
        }
        const target = this.target(s);
        this.lastTarget = target;      // exposed for the telemetry readout
        if (this.loading) return;
        if (!target) {
            if (this.current) { this.dispose(); this.onChange(null); }
            return;
        }
        const cur = this.current;
        if (cur && !this.stale) {
            // Compare like with like: `zoomF` is the unoffset continuous
            // zoom, while a ring's loaded level already has zoomOffset
            // folded in. Without undoing it here the outer ring sits a
            // permanent ~1.0 from its own target, never inside the
            // keep-window, and refetches its whole rectangle every frame.
            const zoomOk = Math.abs(target.zoomF - (cur.zoom - this.zoomOffset))
                         < 0.5 + ZOOM_HYSTERESIS;
            const dx = Math.abs(target.cx - (cur.origin[0] + cur.span / 2));
            const dy = Math.abs(target.cy - (cur.origin[1] + cur.span / 2));
            const placed = Math.max(dx, dy) < cur.span * RECENTRE_AT;
            if (zoomOk && placed) return;
        }
        this.stale = false;
        this.load(target.zoom, target.cx, target.cy);
    }

    async load(zoom, centreX, centreY) {
        const gl = this.gl;
        const meta = this.meta;
        const k = 2 ** (zoom - meta.zoom);          // detail pixels per base texel
        const n = this.tiles;

        // Camera position in this zoom's global pixel grid, then the tile
        // block centred on it.
        const px = (centreX + meta.tileOrigin[0] * 256) * k;
        const py = (centreY + meta.tileOrigin[1] * 256) * k;
        const x0 = Math.floor(px / 256) - (n >> 1);
        const y0 = Math.floor(py / 256) - (n >> 1);

        // Back to world texels, the space the shader marches in.
        const span = (n * 256) / k;
        const origin = [
            (x0 * 256) / k - meta.tileOrigin[0] * 256,
            (y0 * 256) / k - meta.tileOrigin[1] * 256,
        ];

        const gen = ++this.generation;
        this.loading = true;
        const started = performance.now();

        // The centre tile is still checked for the placeholder graphic,
        // but the check no longer gates the rectangle: it used to be
        // awaited first, adding a full round trip to every switch. Since
        // the ceiling is now calibrated up front, a blank here is rare,
        // and the generation counter throws the rectangle away if it
        // happens. One wasted rectangle in a rare case beats a round trip
        // on every single one.
        const probe = loadTile(tileUrl(zoom, x0 + (n >> 1), y0 + (n >> 1)))
            .then((img) => { try { return isPlaceholder(img); } catch (e) { return false; } })
            .catch(() => false);

        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + this.unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.size, this.size, 0,
                      gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        // Seeded from what is already on screen, then published at once so
        // that everything after this point sharpens a layer the viewer is
        // already looking at rather than being dead time in front of it.
        //
        // Only when there is something worth seeding FROM, though. On a
        // cold start the base mosaic is still all clear-colour, and
        // publishing that early paints flat sand over the terrain -- the
        // seed is taken as soon as the ceiling calibrates, well before
        // the mosaic's first tiles land. With nothing to copy, fall back
        // to the original behaviour and publish when complete.
        const publishNow = !!((this.base && this.base.done) || this.current);
        this.seedTexture(texture, origin, span);
        // seedTexture binds the OUTGOING layer to sample it, and both
        // layers live on DETAIL_UNIT, so the binding has to be restored
        // before anything else touches TEXTURE_2D on this unit.
        gl.activeTexture(gl.TEXTURE0 + this.unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                         gl.LINEAR_MIPMAP_LINEAR);
        const layer = {
            texture, zoom, origin, span, tiles: n, unit: this.unit,
            lodBias: Math.log2(this.size / span),
            metresPerPixel: this.metresPerBaseTexel / (2 ** (zoom - meta.zoom)),
            loaded: 0, total: n * n, seconds: 0,
        };
        if (publishNow) {
            if (this.current) gl.deleteTexture(this.current.texture);
            this.current = layer;
            this.onChange(layer);
        }

        const jobs = [];
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) jobs.push([i, j]);
        }

        // Ordered from the middle out, so the part of the rectangle the
        // camera is actually pointed at resolves first.
        const c = (n - 1) / 2;
        jobs.sort((a, b) => (Math.abs(a[0] - c) + Math.abs(a[1] - c))
                          - (Math.abs(b[0] - c) + Math.abs(b[1] - c)));

        probe.then((blank) => {
            if (!blank || gen !== this.generation) return;
            this.maxZoom = zoom - 1;
            this.generation++;              // abandon the rectangle in flight
            this.loading = false;
            this.onCeiling(this.maxZoom);
            if (this.maxZoom > this.baseZoom) this.load(this.maxZoom, centreX, centreY);
            else if (this.current) { this.dispose(); this.onChange(null); }
        });

        try {
            await pool(jobs, this.concurrency, async ([i, j]) => {
                if (gen !== this.generation) return;   // superseded mid-flight
                try {
                    const img = await loadTile(tileUrl(zoom, x0 + i, y0 + j));
                    if (gen !== this.generation) return;
                    gl.activeTexture(gl.TEXTURE0 + this.unit);
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, i * 256, j * 256,
                                     gl.RGBA, gl.UNSIGNED_BYTE, img);
                    // Mips go stale as tiles land, and the shader samples
                    // them at distance. Rebuilding every 25 tiles keeps
                    // far ground from aliasing mid-load without paying
                    // for a full chain on every tile.
                    layer.loaded++;
                    if (layer.loaded % 25 === 0) gl.generateMipmap(gl.TEXTURE_2D);
                } catch (err) { /* a hole; the base shows through */ }
            });
        } catch (err) {
            gl.deleteTexture(texture);
            this.loading = false;
            return;
        }

        // Never delete a texture that is already on screen: with the early
        // publish this one may be the live layer.
        if (gen !== this.generation) {
            if (this.current !== layer) gl.deleteTexture(texture);
            return;
        }

        if (!publishNow) {
            if (this.current) gl.deleteTexture(this.current.texture);
            this.current = layer;
        }

        gl.activeTexture(gl.TEXTURE0 + this.unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.generateMipmap(gl.TEXTURE_2D);
        // Now that the mip level is the geometrically correct one rather
        // than a blurred guess, grazing angles need anisotropy to stay
        // clean -- the base mosaic has had it all along.
        const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
        if (aniso) {
            gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
                Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
        }
        layer.seconds = (performance.now() - started) / 1000;
        this.loading = false;
        this.onChange(layer);
    }

    dispose() {
        this.generation++;
        if (this.current) this.gl.deleteTexture(this.current.texture);
        this.current = null;
        this.loading = false;
    }
}
