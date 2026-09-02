// Camera pose and integration. Knows nothing about WebGL or the DOM.
//
// The original accumulated forward speed with no drag (`ss += s*2` on
// every frame the up arrow was held, never decaying), so holding
// forward made you faster indefinitely. This uses damped velocity
// instead: release the key and you coast to a stop.

const PITCH_LIMIT = Math.PI / 2 - 0.01;
const BOOST = 4;
const DAMPING_TAU = 0.15;   // seconds to shed most of the velocity
const SPEED_TAU = 3.0;      // smoothing for the speed the streamer reads

// The 2010 map has no real-world scale, so its speed stays in texels:
// 900 units/s^2 against a 0.15 s damping settles at 135 texels/s, which
// is what that world was tuned for.
const LEGACY_TEXELS_PER_S = 135;

// Hold forward and you keep gaining speed, which is what the original
// did -- `ss += s*2` every frame with no drag at all, so a long press
// wound up arbitrarily fast. Reinstated deliberately, with two changes:
// it tops out, and it decays when you let go.
//
// Where it tops out is the whole question, because it is really a
// streaming budget in disguise. An earlier version ran to Mach 27 and
// relied on the window shedding zoom to keep up -- which worked, and
// cost a change of vertical scale every time it did. Mach 10 is the
// speed at which that trade stops being necessary: 3.43 km/s across a
// 105 km window is 31 s to cross and a refetch every 15 s, which a
// fixed zoom can serve. The ceiling is what lets the zoom stand still.
//
// Two phases, because getting airborne and going fast are different
// wishes. Below Mach 1 the ramp winds up hard, so a standing start
// reaches the speed of sound in a couple of seconds instead of crawling;
// above it the ramp keeps building but gently, so the climb from Mach 1
// to Mach 10 is something you feel happening rather than a step. Mach 10
// is a hard ceiling, applied after boost, so it is the real top speed
// and not a number the shift key can walk past.
const MACH = 343;           // m/s at sea level, near enough
const QUICK_MPS = 1 * MACH;    // wound up hard below this
const TOP_MPS = 10 * MACH;     // hard ceiling
const QUICK_TAU = 0.8;      // e-folding below Mach 1: ~2 s from cruise
const RAMP_TAU = 3.5;       // e-folding above it: ~8 s on to Mach 10
const RAMP_DECAY = 1.5;     // faster on release, so slowing down responds
const LEGACY_RAMP_MAX = 300;   // the 2010 map has no metres, so no Mach

// Real terrain gets metres. The old constant, applied to a 19 m texel,
// works out at 2.3 km/s cruising and 9.2 km/s boosted -- Mach 27, and
// the actual reason streaming a global world looks impossible. Nothing
// can fetch ahead of that.
const MOUSE_SENS = 0.0022;  // radians per pixel
const FLOOR_CLEARANCE = 2;

export class Camera {
    // groundAt(x, y) -> terrain height, supplied by the caller so this
    // module needs no knowledge of how the heightmap was loaded.
    constructor(groundAt) {
        this.groundAt = groundAt;
        this.vel = [0, 0, 0];
        this.ramp = 1;
        // Smoothed, in texels per second. The terrain window picks its
        // zoom from this, and must not react to a tapped boost key.
        this.speed = 0;
        // The original's opening view: (200, 200), 50 units above the
        // ground beneath that point, looking along +X.
        this.place(200, 200, 50, 0, 0);
    }

    // Drop the camera somewhere, at a clearance above the ground.
    place(x, y, clearance, yaw, pitch) {
        this.x = x;
        this.y = y;
        this.clearance = clearance;
        this.z = this.groundAt(x, y) + clearance;
        this.yaw = yaw;
        this.pitch = pitch;
        this.vel = [0, 0, 0];
        this.ramp = 1;
        // Also reset, or a teleport carries the old speed into the
        // terrain window's zoom choice and fetches a coarse world for a
        // camera that is now stationary.
        this.speed = 0;
    }

    // Unit basis. +Z is up; yaw 0 looks along +X.
    //
    // Handedness matters here, and getting it wrong is invisible until
    // the terrain is real. Web Mercator tile rows run north to south, so
    // world +Y is SOUTH. Screen-right is the direction at yaw + 90
    // degrees, which at yaw 0 -- facing east -- is +Y, i.e. south. That
    // is what your right hand does facing east.
    //
    // The earlier `right = [sy, -cy, 0]` pointed north instead, which
    // mirrored the image north-for-south. It was undetectable in play
    // because the view and the turn direction mirror together, so the
    // controls stay self-consistent; it only shows against a map.
    basis() {
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        const fwd = [cp * cy, cp * sy, sp];
        const right = [-sy, cy, 0];
        // fwd x right, not right x fwd: with +Y south the world triple is
        // physically left-handed, and this ordering is what puts screen-up
        // back on +Z.
        const up = [
            fwd[1] * right[2] - fwd[2] * right[1],
            fwd[2] * right[0] - fwd[0] * right[2],
            fwd[0] * right[1] - fwd[1] * right[0],
        ];
        return { fwd, right, up };
    }

    // The basis actually rendered from: the true pose with wind offsets
    // laid on top. Movement, terrain-follow and the imagery LOD all use
    // basis() instead, so drift never feeds back into them -- it sways
    // the view without blowing you off course, and without jiggling the
    // viewing distance the detail rectangle is chosen from.
    //
    // `sway` and `heave` arrive already in world units; this class has
    // no idea what a metre is.
    viewBasis(wind) {
        if (!wind) {
            return { ...this.basis(), eye: [this.x, this.y, this.z] };
        }
        const pitch = Math.max(-PITCH_LIMIT,
                      Math.min(PITCH_LIMIT, this.pitch + wind.pitch));
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        const cy = Math.cos(this.yaw + wind.yaw), sy = Math.sin(this.yaw + wind.yaw);
        const fwd = [cp * cy, cp * sy, sp];
        const right0 = [-sy, cy, 0];
        // Same ordering as basis(): fwd x right, not right x fwd. With
        // +Y south the world triple is physically left-handed.
        const up0 = [
            fwd[1] * right0[2] - fwd[2] * right0[1],
            fwd[2] * right0[0] - fwd[0] * right0[2],
            fwd[0] * right0[1] - fwd[1] * right0[0],
        ];
        // Roll: rotate right and up about fwd. The horizon tilt is the
        // cue that reads as a drone rather than as a wobble, and the
        // basis had no roll term before this.
        const cr = Math.cos(wind.roll), sr = Math.sin(wind.roll);
        const right = [0, 1, 2].map((i) => right0[i] * cr + up0[i] * sr);
        const up = [0, 1, 2].map((i) => up0[i] * cr - right0[i] * sr);

        // Sway is lateral, heave vertical, and the eye is kept above the
        // ground: a downward gust must not push the camera through a hill
        // that the true position is safely above.
        const eye = [
            this.x + right0[0] * wind.sway,
            this.y + right0[1] * wind.sway,
            this.z + wind.heave,
        ];
        const floor = this.groundAt(eye[0], eye[1]) + 1;
        if (eye[2] < floor) eye[2] = floor;
        return { fwd, right, up, eye };
    }

    update(dt, intent, settings) {
        this.yaw += intent.yawDelta * MOUSE_SENS;
        this.pitch -= intent.pitchDelta * MOUSE_SENS;
        this.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, this.pitch));

        const { fwd, right } = this.basis();
        // Target speed in texels, from metres where the dataset has a
        // real scale. Acceleration follows from it: with damped velocity
        // the steady state is accel * tau, so accel = target / tau.
        // Sustained forward winds the ramp up; anything else lets it fall.
        // The ramp is a multiple of cruise, but the phase change and the
        // ceiling are in metres per second, so they mean the same thing
        // whatever the slider is set to and whatever zoom the window is
        // at. Without a real scale -- the 2010 map -- there is no Mach to
        // speak of, so that path keeps the old single-phase ramp.
        const mps = settings.metresPerTexel ? settings.speedMps : 0;
        if (intent.forward > 0.1) {
            const tau = mps && mps * this.ramp < QUICK_MPS ? QUICK_TAU : RAMP_TAU;
            const cap = mps ? TOP_MPS / mps : LEGACY_RAMP_MAX;
            this.ramp = Math.min(cap, this.ramp * Math.exp(dt / tau));
        } else {
            this.ramp = Math.max(1, this.ramp * Math.exp(-dt / RAMP_DECAY));
        }
        const base = settings.metresPerTexel
            ? settings.speedMps / settings.metresPerTexel
            : LEGACY_TEXELS_PER_S;
        // Boost is inside the ceiling, not outside it: shift gets you to
        // the top faster, it does not raise the top.
        let target = base * this.ramp * (intent.boost ? BOOST : 1);
        if (settings.metresPerTexel) {
            target = Math.min(target, TOP_MPS / settings.metresPerTexel);
        }
        const speed = target / DAMPING_TAU;

        // In terrain-follow the camera rides the ground, so forward
        // motion is taken along the heading rather than the view
        // vector -- otherwise looking down would drive you into a hill
        // that the follow logic then lifts you back out of.
        const drive = settings.terrainFollow
            ? [Math.cos(this.yaw), Math.sin(this.yaw), 0]
            : fwd;

        for (let i = 0; i < 3; i++) {
            this.vel[i] += (drive[i] * intent.forward
                          + right[i] * intent.strafe) * speed * dt;
        }
        if (!settings.terrainFollow) {
            this.vel[2] += intent.up * speed * dt;
        }

        const damp = Math.exp(-dt / DAMPING_TAU);
        for (let i = 0; i < 3; i++) this.vel[i] *= damp;

        this.x += this.vel[0] * dt;
        this.y += this.vel[1] * dt;

        if (settings.terrainFollow) {
            // The original's hovercraft model: sample the ground under
            // the camera each frame and sit a fixed distance above it.
            this.clearance = Math.max(
                2, this.clearance + intent.up * target * 0.45 * dt);
            this.z = this.groundAt(this.x, this.y) + this.clearance;
            this.vel[2] = 0;
        } else {
            this.z += this.vel[2] * dt;
            const floor = this.groundAt(this.x, this.y) + FLOOR_CLEARANCE;
            if (this.z < floor) {
                this.z = floor;
                this.vel[2] = Math.max(0, this.vel[2]);
            }
            this.clearance = this.z - this.groundAt(this.x, this.y);
        }

        const v = Math.hypot(this.vel[0], this.vel[1], this.vel[2]);
        this.speed += (v - this.speed) * (1 - Math.exp(-dt / SPEED_TAU));

        // The synthetic map tiles, so coordinates are folded back into
        // the first tile to keep floats precise however far you fly --
        // invisible, because the world repeats. Real terrain is a finite
        // window with open sea around it, and must not wrap.
        if (settings.wrapWorld) {
            const w = settings.worldSize;
            this.x = ((this.x % w) + w) % w;
            this.y = ((this.y % w) + w) % w;
        }
    }
}
