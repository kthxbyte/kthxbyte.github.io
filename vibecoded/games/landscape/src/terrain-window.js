// The terrain window: which patch of the world is resident, at what
// zoom, and how coordinates move when it changes.
//
// The functions here are deliberately pure -- no GL, no DOM, no fetch --
// because the coordinate maths is the part that cannot be debugged by
// looking at it. A camera that teleports or sinks on a window swap looks
// like a dozen different bugs; the round-trip test in tools/ is the only
// way to know it is right before anything is drawn.

const EQUATOR = 156543.03392;   // metres per pixel at zoom 0, latitude 0

export function metresPerTexel(lat, zoom) {
    return EQUATOR * Math.cos(lat * Math.PI / 180) / 2 ** zoom;
}

// How much ground an n-tile window spans at a given zoom and latitude.
export function coverage(tiles, lat, zoom) {
    return tiles * 256 * metresPerTexel(lat, zoom);
}

// Zoom as a function of speed: hold the window at a fixed time to cross,
// so streaming delivers at most one window per T_CROSS however fast the
// camera moves. This is what removes the need for a separate coarse
// layer -- at speed the window IS the coarse layer, and it is wide
// enough to reach the horizon.
//
// floor() rather than round(), because coverage must be at least what
// was asked for; zoomF is returned continuous so the caller can apply
// hysteresis against it.
//
// The floor is z4 -- 16 tiles span the whole planet there, so a window
// is most of a hemisphere. Below about z6 the flat-plane and
// constant-scale assumptions this renderer makes stop being tenable:
// Web Mercator's cos(lat) varies enormously across a window that wide,
// and the true horizon is far nearer than the draw distance. What you
// get at z4-5 is a Mercator map you can fly over, not a globe.
export function windowZoom({
    speed, lat, tiles, tCross = 60, minCoverage = 20000,
    minZoom = 4, maxZoom = 13,
}) {
    const wanted = Math.max(speed * tCross, minCoverage);
    const zoomF = Math.log2(tiles * 256 * EQUATOR
                            * Math.cos(lat * Math.PI / 180) / wanted);
    return {
        zoomF,
        zoom: Math.max(minZoom, Math.min(maxZoom, Math.floor(zoomF))),
    };
}

// World texels relate to the global slippy grid by G = tileOrigin*256 + p,
// so moving between windows is affine rather than a translation: across a
// zoom change a texel changes size, and everything measured in texels
// changes with it.
export function scaleBetween(from, to) {
    return 2 ** (to.zoom - from.zoom);
}

export function rebase(p, from, to) {
    const k = scaleBetween(from, to);
    return [
        (from.tileOrigin[0] * 256 + p[0]) * k - to.tileOrigin[0] * 256,
        (from.tileOrigin[1] * 256 + p[1]) * k - to.tileOrigin[1] * 256,
    ];
}

// --- keeping the view inside the data ----------------------------------
//
// One inequality governs both of the functions below: the gap from the
// camera to the nearest window edge must stay above the draw distance.
// Cross it and the march walks off the end of the mosaic, where the
// shader has nothing to return but sea level -- a flat plane under a
// radial smear of the last row of imagery texels, which is what "the
// end of the heightmap" looks like from the air.
//
// Both of these used to be fractions of the window with no knowledge of
// the draw distance, and the fractions were bigger than the budget. At
// twelve tiles and z12 the half-extent is 1536 texels against a
// 1200-texel view -- 336 texels of slack in total -- and the lead alone
// spent 768. A fresh window was born with its trailing edge inside the
// view, so the artefact needed neither speed nor altitude, only a
// glance backwards. See REDESIGN 19.4.

// Distance to the nearest edge of a size x size window.
export function edgeGap(x, y, size) {
    return Math.min(x, y, size - x, size - y);
}

// How far off centre the camera may sit before a `drawDist` view runs
// off the end. Zero or less means the window cannot hold the view even
// from its own centre, which no amount of moving can fix.
export function safeMargin(size, drawDist) {
    return size / 2 - drawDist;
}

// Where the next window should be centred: ahead along the direction of
// travel rather than on the camera, so the ground being flown towards is
// the ground that gets fetched. With no meaningful velocity it degrades
// to the camera position.
//
// `maxLead` is what keeps the lead honest. Leading ahead buys runway in
// front and spends it behind, one for one, so a lead longer than the
// margin puts the trailing edge inside the view the instant the window
// lands. The caller passes the margin it has left after the speed lead.
export function nextCentre(x, y, vx, vy, spanTexels, lead = 0.25,
                           maxLead = Infinity) {
    const v = Math.hypot(vx, vy);
    if (v < 1e-3) return [x, y];
    const d = Math.min(spanTexels * lead, Math.max(0, maxLead));
    return [x + vx / v * d, y + vy / v * d];
}

// True when an edge has come within `reach` of the camera and the next
// window should already be on its way. `reach` is the draw distance plus
// however far the camera will travel while the fetch is in flight, so
// the trigger moves forward with speed rather than the edge moving back.
export function needsMove(x, y, size, reach) {
    return edgeGap(x, y, size) < reach;
}
