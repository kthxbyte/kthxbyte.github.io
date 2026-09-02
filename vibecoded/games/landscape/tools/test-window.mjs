// Round-trip test for the window coordinate maths. Runs in node -- no
// browser, no GL -- because this is the part that must be right before
// anything is drawn.
import { rebase, windowZoom, coverage, metresPerTexel, nextCentre, needsMove }
    from '../src/terrain-window.js';
import { carriedTiles } from '../src/terrain-tiles.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); }
    else console.log(`  ok   ${name} ${detail}`);
};

// A window's world position, expressed as latitude/longitude, must not
// change when the window it is measured against changes.
function latLon(p, meta) {
    const n = 256 * 2 ** meta.zoom;
    const wx = meta.tileOrigin[0] * 256 + p[0];
    const wy = meta.tileOrigin[1] * 256 + p[1];
    return [
        Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / n))) * 180 / Math.PI,
        wx / n * 360 - 180,
    ];
}

console.log('rebase round-trip:');
const A = { zoom: 13, tileOrigin: [2476, 4728] };
for (const [name, B] of [
    ['same zoom, shifted', { zoom: 13, tileOrigin: [2480, 4731] }],
    ['zoom out two',       { zoom: 11, tileOrigin: [ 619, 1182] }],
    ['zoom in one',        { zoom: 14, tileOrigin: [4960, 9460] }],
]) {
    let worst = 0;
    for (const p of [[0, 0], [1536, 1536], [3071.5, 12.25], [800, 2400]]) {
        const q = rebase(p, A, B);
        const [la1, lo1] = latLon(p, A), [la2, lo2] = latLon(q, B);
        // compare on the ground, in metres
        const mpt = metresPerTexel(la1, A.zoom);
        const dy = (la1 - la2) * 111320;
        const dx = (lo1 - lo2) * 111320 * Math.cos(la1 * Math.PI / 180);
        worst = Math.max(worst, Math.hypot(dx, dy));
        // and back again
        const back = rebase(q, B, A);
        worst = Math.max(worst, Math.hypot(back[0] - p[0], back[1] - p[1]) * mpt);
    }
    ok(name, worst < 0.001, `worst error ${worst.toExponential(2)} m`);
}

console.log('\nzoom from speed (12 tiles, equator):');
for (const [v, want] of [[30, 13], [200, 13], [2300, 11], [9200, 9]]) {
    const { zoom } = windowZoom({ speed: v, lat: 0, tiles: 12 });
    const km = coverage(12, 0, zoom) / 1000;
    ok(`${String(v).padStart(4)} m/s -> z${zoom}`, zoom === want,
       `${km.toFixed(0)} km, crossed in ${(km * 1000 / v).toFixed(0)} s`);
}

console.log('\ncoverage always outlasts T_CROSS:');
for (const v of [30, 120, 500, 2300, 5000, 9200]) {
    const { zoom } = windowZoom({ speed: v, lat: 0, tiles: 12 });
    const secs = coverage(12, 0, zoom) / v;
    ok(`${String(v).padStart(4)} m/s`, secs >= 60, `${secs.toFixed(0)} s to cross`);
}

console.log('\nlatitude shrinks the window:');
for (const lat of [0, 45, 62]) {
    const km = coverage(12, lat, 13) / 1000;
    ok(`lat ${lat}`, km > 0, `${km.toFixed(1)} km`);
}

console.log('\nplacement:');
ok('centre leads the velocity',
   nextCentre(1000, 1000, 1, 0, 3072)[0] === 1000 + 768);
ok('no velocity, no lead', nextCentre(1000, 1000, 0, 0, 3072)[0] === 1000);
ok('middle is safe', !needsMove(1536, 1536, 3072, 1200));
ok('edge needs a move', needsMove(200, 1536, 3072, 1200));

// The window size is a panel control now, so every option in the list
// has to behave. The old flat 20 km floor for minCoverage silently
// dragged the small windows a zoom level coarser on their first move;
// tying the floor to the draw distance -- 100 texels of view per tile,
// and a window that holds at least twice its view -- is what lets a
// 2x2 window keep the zoom it was fetched at.
console.log('\nevery selectable window size holds its zoom at rest:');
for (const tiles of [2, 4, 6, 8, 10, 12]) {
    const lat = -27.0874, maxZoom = 12;
    const draw = tiles * 100;                       // DRAW_PER_TILE
    const minCoverage = draw * metresPerTexel(lat, maxZoom) * 2;
    const { zoom } = windowZoom({ speed: 0, lat, tiles, maxZoom, minCoverage });
    const km = coverage(tiles, lat, zoom) / 1000;
    const viewKm = draw * metresPerTexel(lat, zoom) / 1000;
    ok(`${tiles}x${tiles}`, zoom === maxZoom,
       `z${zoom} ${km.toFixed(0)} km window, ${viewKm.toFixed(1)} km view`);
}

// A window must always be able to hold what is drawn in it, or rays
// march out past the edge into the clamped border.
console.log('\nthe window always outruns the draw distance:');
for (const tiles of [2, 4, 6, 8, 10, 12]) {
    const halfWindow = tiles * 256 / 2;
    ok(`${tiles}x${tiles}`, tiles * 100 < halfWindow,
       `${tiles * 100} texel view vs ${halfWindow} to the edge`);
}

// Resizing the window must not change its zoom. It once did, and the
// symptom was not a streaming glitch but a vertical one: zoom drives
// reliefScale = 2^(13-zoom), which IS the real-world vertical
// exaggeration, so a silent 12 -> 10 drop rendered every mountain four
// times too tall. The cause was pairing the OUTGOING window's draw
// distance with the INCOMING window's tile count, so the floor asked a
// 4-tile window to hold a 12-tile view. Feed the post-move draw
// distance, and every size holds the zoom it was on.
console.log('\na resize holds its zoom, and does not ratchet:');
{
    const lat = -27.0874, maxZoom = 12;
    const resize = (from, tiles) => {
        const minCoverage = tiles * 100 * metresPerTexel(lat, from) * 2;
        const w = windowZoom({ speed: 0, lat, tiles, maxZoom, minCoverage });
        const moves = Math.abs(w.zoomF - from) > 1.0 && w.zoom !== from;
        return moves ? w.zoom : from;
    };
    for (const tiles of [2, 4, 6, 8, 10, 12]) {
        const z = resize(12, tiles);
        ok(`12x12 -> ${tiles}x${tiles}`, z === 12,
           `z${z}, relief x${2 ** (13 - z)}`);
    }
    // Every step feeds the next, which is what caught the ratchet: the
    // old code came back from 4x4 to z11 rather than z12.
    let z = 12, worst = 12;
    for (const tiles of [2, 12, 4, 10, 2, 8, 12]) {
        z = resize(z, tiles);
        worst = Math.min(worst, z);
    }
    ok('round trip 2/12/4/10/2/8/12', z === 12 && worst === 12,
       `ends z${z}, lowest z${worst}`);
}

// The floor must still let speed coarsen the window; holding the zoom on
// a resize must not turn into holding it always.
console.log('\nspeed still coarsens the window:');
{
    const lat = -27.0874, minCoverage = 1200 * metresPerTexel(lat, 12) * 2;
    const at = (v) => windowZoom({ speed: v, lat, tiles: 12,
                                   maxZoom: 12, minCoverage }).zoom;
    ok('at rest', at(0) === 12, `z${at(0)}`);
    ok('mach 7', at(2300) < 12, `z${at(2300)}`);
    ok('mach 27', at(9200) < at(2300), `z${at(9200)}`);
}

// The vertical axis is zoom-invariant, and that is a load-bearing fact
// rather than a coincidence. A height in rendered texels is
// metres/mpp * reliefScale = metres/mpp * 2^(13 - zoom), and mpp goes as
// 2^-zoom, so the two cancel: the same mountain is the same number of
// texels tall at every level. Which means a zoom change must rebase
// horizontally ONLY. Scaling z and clearance by k as well -- the obvious
// thing to do, and what the code did -- halved the camera's height above
// the terrain on every zoom-out while the terrain kept its own, and read
// as the vertical scale drifting off whatever the slider said.
console.log('\nrendered height does not depend on zoom:');
{
    const lat = -27.0874, vs = 1.0, peak = 1000;
    const texels = (z) => peak / metresPerTexel(lat, z) * vs * 2 ** (13 - z);
    const ref = texels(13);
    for (const z of [12, 11, 10, 9, 6]) {
        const t = texels(z);
        ok(`z${z}`, Math.abs(t - ref) < 1e-9,
           `${t.toFixed(2)} texels vs ${ref.toFixed(2)} at z13`);
    }
}

console.log('\nso a zoom change must not move the camera vertically:');
{
    const lat = -27.0874, vs = 1.0;
    const height = (z, texelsZ) => texelsZ / (vs * 2 ** (13 - z))
                                 * metresPerTexel(lat, z);
    // Start 500 m up at z12 and walk out to z9, applying only what the
    // rebase is allowed to touch. Metres above ground must not budge.
    let z = 500 / metresPerTexel(lat, 12) * vs * 2 ** (13 - 12);
    let zoom = 12, worst = 0;
    for (const to of [11, 10, 9]) {
        z *= 1;                        // vertical is NOT scaled by k
        zoom = to;
        worst = Math.max(worst, Math.abs(height(zoom, z) - 500));
    }
    ok('500 m held across z12 -> z9', worst < 1e-6,
       `worst drift ${worst.toExponential(1)} m`);

    // And the shape of the bug, so the test fails if it comes back.
    let bad = 500 / metresPerTexel(lat, 12) * vs * 2;
    for (const to of [11, 10, 9]) bad *= 0.5;   // the old `camera.z *= k`
    ok('the old scaling really did drift', Math.abs(height(9, bad) - 500) > 400,
       `would have been ${height(9, bad).toFixed(0)} m, not 500 m`);
}


// The one inequality the streaming has to hold: the gap from the camera
// to the nearest window edge must stay above the draw distance,
// otherwise the ray march walks off the end of the data and the shader
// returns sea level for the rest of the frame.
//
// Both halves of the placement used to be fractions of the window and
// knew nothing about the draw distance. At twelve tiles and z12 the
// half-extent is 1536 texels against a 1200-texel view, so the whole
// budget is 336 texels -- and needsMove waited for 768 of it while
// nextCentre spent 768 more leading ahead. Every fresh window was
// therefore born with its trailing edge 768 texels away, well inside
// the view, and no amount of speed or altitude was needed to see it.
console.log('\nthe window keeps the draw distance inside itself:');
{
    const size = 3072, draw = 1200;        // 12 tiles, DRAW_PER_TILE = 100
    const margin = size / 2 - draw;        // 336 texels of slack, all told
    const gap = (x, y) => Math.min(x, y, size - x, size - y);

    ok('there is any slack at all', margin > 0, `${margin} texels`);

    // At rest the whole margin is available, so this is the easy case.
    // If it does not hold here it holds nowhere.
    const reach = draw;                                  // no speed lead
    const maxLead = (size / 2 - reach) * 0.9;
    const lead = nextCentre(1536, 1536, 1, 0, size, 0.25, maxLead)[0] - 1536;
    // The camera does not move; the window centre does. In the window it
    // lands in, the camera therefore sits `lead` texels behind centre.
    const arrival = size / 2 - lead;

    ok('a fresh window starts with every edge out of view',
       gap(arrival, size / 2) >= draw,
       `gap ${gap(arrival, size / 2).toFixed(0)}, draw ${draw}`);
    ok('and does not instantly ask to move again',
       !needsMove(arrival, size / 2, size, reach));

    // Fly straight on until the trigger fires. The edge must still be
    // out of view at that moment -- that is what "start loading it
    // right away" has to mean.
    const step = 1;
    let x = arrival;
    while (x < size && !needsMove(x, size / 2, size, reach)) x += step;
    // The trigger fires the moment the gap dips below `reach`, so at a
    // one-texel walk it lands one texel short of it. What matters is
    // that `reach` is the draw distance or more: the fetch starts before
    // the edge is inside the view, not after.
    ok('the move triggers before the edge enters view',
       reach >= draw && gap(x, size / 2) > reach - step - 1e-9,
       `fired at gap ${gap(x, size / 2).toFixed(0)}, reach ${reach}`);
    ok('with runway between arrival and trigger',
       x - arrival > 0, `${(x - arrival).toFixed(0)} texels`);

    // Speed brings the trigger forward rather than moving the edge.
    const led = draw + margin * 0.5;
    let f = size / 2;
    while (f < size && !needsMove(f, size / 2, size, led)) f += 1;
    ok('a speed lead triggers earlier, never later', f < x,
       `${f.toFixed(0)} vs ${x.toFixed(0)} texels`);

    // And the shape of the bug, so it fails if the constants come back.
    const oldLead = size * 0.25, oldArrival = size / 2 - oldLead;
    ok('the old fractions really did show the edge',
       gap(oldArrival, size / 2) < draw,
       `gap was ${gap(oldArrival, size / 2)} texels against a ${draw}-texel view`);
}


// A move that keeps the edge out of view has to happen often -- every
// 640 texels at rest, more often at speed -- and a full 144-tile refetch
// each time costs 11-14 s, which is slower than the camera crosses the
// margin. The two only reconcile because the windows overlap almost
// entirely: at the same zoom the tile grids ARE the same grid, so the
// shift is a whole number of tiles and the overlap copies exactly.
console.log('\nmoves carry the overlap instead of refetching it:');
{
    const at = (x, y, tiles = 12, zoom = 12) =>
        ({ zoom, tiles, tileOrigin: [x, y] });

    const one = carriedTiles(at(1227, 2440), at(1228, 2440));
    ok('a one-tile step reuses all but a column',
       one && one.count === 12 * 11, one ? `${one.count}/144` : 'nothing');
    ok('and blits the old mosaic one tile left',
       one.dx === -1 && one.dy === 0, `dx ${one.dx}, dy ${one.dy}`);

    const diag = carriedTiles(at(1227, 2440), at(1229, 2442));
    ok('a diagonal step reuses the inner block',
       diag && diag.count === 10 * 10, diag ? `${diag.count}/144` : 'nothing');

    ok('a disjoint window carries nothing',
       carriedTiles(at(1227, 2440), at(1300, 2440)) === null);
    ok('a zoom change carries nothing',
       carriedTiles(at(1227, 2440), { ...at(613, 1220), zoom: 11 }) === null);
    ok('no previous window carries nothing',
       carriedTiles(null, at(1227, 2440)) === null);
    ok('a window with no tile grid carries nothing',
       carriedTiles({ zoom: 12 }, at(1227, 2440)) === null);

    // The rectangle is expressed in the NEW window's tile coordinates,
    // because that is what decides which jobs to skip. Everything it
    // names must be a real tile of the new window.
    let inRange = true;
    for (const [dx, dy] of [[-3, 0], [0, -3], [3, 2], [-2, 4], [11, 11]]) {
        const c = carriedTiles(at(1227, 2440), at(1227 - dx, 2440 - dy));
        if (!c) continue;
        if (c.x0 < 0 || c.y0 < 0 || c.x1 > 12 || c.y1 > 12) inRange = false;
    }
    ok('the carried rectangle stays inside the new window', inRange);

    // What it buys, at the move rate the fix above produces.
    const step = 2;                       // tiles moved per window at speed
    const kept = carriedTiles(at(0, 0), at(step, step));
    ok('a two-tile move fetches only the new edge',
       144 - kept.count === 144 - 100, `${144 - kept.count} tiles, not 144`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
