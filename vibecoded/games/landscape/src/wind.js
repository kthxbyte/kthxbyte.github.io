// Drone-like camera drift.
//
// Offsets are produced from summed sines at incommensurate periods
// rather than from a noise texture or a random walk. Three reasons:
// there is no state to keep or reset, the result is identical on every
// machine and every reload, and periods chosen with irrational ratios
// never line up, so the motion does not visibly repeat.
//
// The offsets are applied to the basis at render time and never to the
// stored pose. That keeps the controls honest -- you do not slowly get
// blown off course -- lets terrain-follow and the floor clamp work on
// the true position, and keeps the imagery LOD out of it: the detail
// rectangle is chosen from camera.pitch and camera.x/y, so drift folded
// into the pose would jiggle the viewing distance and could refetch a
// hundred tiles for a wobble.

const DEG = Math.PI / 180;

// Amplitudes at full strength. Attitude is what reads as a drone; the
// positional sway is deliberately slower and smaller, and the gust
// envelope swells both so the motion has a shape rather than a texture.
const YAW = 1.5 * DEG;
const PITCH = 1.0 * DEG;
const ROLL = 3.0 * DEG;
const SWAY = 3.0;      // metres, lateral
const HEAVE = 2.0;     // metres, vertical

// Periods in seconds. Ratios are irrational-ish on purpose: the pattern
// would repeat at the least common multiple, and there isn't one.
function osc(t, a, b, c) {
    return 0.6 * Math.sin(t / a) + 0.3 * Math.sin(t / b + 1.7)
         + 0.1 * Math.sin(t / c + 4.1);
}

export function windOffsets(t, strength) {
    if (strength <= 0) return null;
    // Gusts: a slow swell between roughly half and full strength, so it
    // eases off rather than buzzing continuously.
    const gust = strength * (0.65 + 0.35 * osc(t, 11.3, 27.7, 41.9));
    return {
        yaw: YAW * gust * osc(t, 2.3, 5.1, 8.7),
        pitch: PITCH * gust * osc(t, 3.1, 6.7, 11.9),
        roll: ROLL * gust * osc(t, 2.7, 4.3, 9.1),
        sway: SWAY * gust * osc(t, 8.9, 17.3, 29.1),
        heave: HEAVE * gust * osc(t, 12.1, 21.7, 33.5),
    };
}
