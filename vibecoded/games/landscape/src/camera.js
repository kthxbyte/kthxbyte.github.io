// Camera pose and integration. Knows nothing about WebGL or the DOM.
//
// The original accumulated forward speed with no drag (`ss += s*2` on
// every frame the up arrow was held, never decaying), so holding
// forward made you faster indefinitely. This uses damped velocity
// instead: release the key and you coast to a stop.

const WORLD = 1792;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const ACCEL = 900;          // world units / s^2
const BOOST = 4;
const DAMPING_TAU = 0.15;   // seconds to shed most of the velocity
const MOUSE_SENS = 0.0022;  // radians per pixel
const FLOOR_CLEARANCE = 2;

export class Camera {
    // groundAt(x, y) -> terrain height, supplied by the caller so this
    // module needs no knowledge of how the heightmap was loaded.
    constructor(groundAt) {
        this.groundAt = groundAt;
        // The original's opening view: (200, 200), 50 units above the
        // ground beneath that point, looking along +X.
        this.x = 200;
        this.y = 200;
        this.clearance = 50;
        this.z = groundAt(200, 200) + this.clearance;
        this.yaw = 0;
        this.pitch = 0;
        this.vel = [0, 0, 0];
    }

    // Unit basis. +Z is up; yaw 0 looks along +X.
    basis() {
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        const fwd = [cp * cy, cp * sy, sp];
        const right = [sy, -cy, 0];
        const up = [
            right[1] * fwd[2] - right[2] * fwd[1],
            right[2] * fwd[0] - right[0] * fwd[2],
            right[0] * fwd[1] - right[1] * fwd[0],
        ];
        return { fwd, right, up };
    }

    update(dt, intent, settings) {
        this.yaw += intent.yawDelta * MOUSE_SENS;
        this.pitch -= intent.pitchDelta * MOUSE_SENS;
        this.pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, this.pitch));

        const { fwd, right } = this.basis();
        const speed = ACCEL * (intent.boost ? BOOST : 1);

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
            this.clearance = Math.max(2, this.clearance + intent.up * 60 * dt);
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

        // Keep coordinates in the first tile so floats stay precise no
        // matter how far you fly. The world repeats every 1792 units,
        // so this is invisible.
        this.x = ((this.x % WORLD) + WORLD) % WORLD;
        this.y = ((this.y % WORLD) + WORLD) % WORLD;
    }
}
