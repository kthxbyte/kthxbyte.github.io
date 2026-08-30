// Tilt-to-look, from the device orientation sensors.
//
// Feeds frame-to-frame *deltas* into the same intent object the mouse
// and touch drag use, so tilting composes with dragging instead of
// fighting it, and camera.js stays unaware of any of it.
//
// Two constraints shape this module:
//   - iOS 13+ requires requestPermission() to be called from a user
//     gesture, so enabling is always a button tap, never automatic.
//   - deviceorientation only fires in a secure context. localhost
//     counts; a plain http:// address on the LAN does not, which is
//     the case anyone testing on a real phone will hit first.

const YAW_GAIN = 6.0;     // degrees of device rotation -> mouse-pixel units
const PITCH_GAIN = 6.0;

export function tiltSupported() {
    return typeof DeviceOrientationEvent !== 'undefined';
}

export class Tilt {
    constructor({ onStateChange }) {
        this.enabled = false;
        this.onStateChange = onStateChange;
        this.last = null;        // previous reading, for deltas
        this.yawDelta = 0;
        this.pitchDelta = 0;
        this.unavailableReason = null;
        this.sawEvent = false;
        this.handler = (e) => this.onReading(e);
    }

    async toggle() {
        if (this.enabled) { this.disable(); return; }
        await this.enable();
    }

    async enable() {
        if (!tiltSupported()) {
            this.fail('This browser has no orientation sensors.');
            return;
        }
        // iOS gates the sensors behind an explicit grant.
        const req = DeviceOrientationEvent.requestPermission;
        if (typeof req === 'function') {
            let granted;
            try {
                granted = await req.call(DeviceOrientationEvent);
            } catch (err) {
                this.fail('Sensor permission request failed.');
                return;
            }
            if (granted !== 'granted') {
                this.fail('Sensor permission was denied.');
                return;
            }
        }
        this.last = null;
        this.sawEvent = false;
        addEventListener('deviceorientation', this.handler);
        this.enabled = true;
        this.unavailableReason = null;
        this.onStateChange(this);

        // If nothing arrives, the cause is almost always an insecure
        // context, and silence is the worst possible feedback.
        setTimeout(() => {
            if (this.enabled && !this.sawEvent) {
                this.fail(isSecureContext
                    ? 'No orientation data from this device.'
                    : 'Sensors need HTTPS. Open the page over https:// '
                      + 'or from localhost.');
                this.disable();
            }
        }, 1500);
    }

    disable() {
        removeEventListener('deviceorientation', this.handler);
        this.enabled = false;
        this.last = null;
        this.yawDelta = this.pitchDelta = 0;
        this.onStateChange(this);
    }

    fail(reason) {
        this.unavailableReason = reason;
        this.onStateChange(this);
    }

    // "Re-centre": treat however the phone is being held right now as
    // the neutral pose. Pitch goes level and the delta reference is
    // dropped so the next reading produces no jump.
    recentre(camera) {
        camera.pitch = 0;
        this.last = null;
        this.yawDelta = this.pitchDelta = 0;
    }

    onReading(e) {
        if (e.alpha === null && e.beta === null) return;
        this.sawEvent = true;

        // In landscape the device axes are swapped relative to the
        // screen, so read the screen's own rotation rather than
        // assuming portrait.
        const angle = (screen.orientation && screen.orientation.angle) || 0;
        const landscape = angle === 90 || angle === 270;
        const yawSrc = e.alpha || 0;
        const pitchSrc = landscape ? (e.gamma || 0) : (e.beta || 0);
        const pitchSign = angle === 270 ? -1 : 1;

        if (this.last === null) {
            this.last = { yaw: yawSrc, pitch: pitchSrc };
            return;
        }

        // alpha wraps at 360; take the short way round.
        let dYaw = yawSrc - this.last.yaw;
        if (dYaw > 180) dYaw -= 360;
        if (dYaw < -180) dYaw += 360;
        const dPitch = (pitchSrc - this.last.pitch) * pitchSign;

        this.last = { yaw: yawSrc, pitch: pitchSrc };

        // Ignore implausible jumps (sensor glitches, orientation flips).
        if (Math.abs(dYaw) > 45 || Math.abs(dPitch) > 45) return;

        this.yawDelta -= dYaw * YAW_GAIN;
        this.pitchDelta -= dPitch * PITCH_GAIN;
    }

    contribute(intent) {
        if (!this.enabled) return intent;
        intent.yawDelta += this.yawDelta;
        intent.pitchDelta += this.pitchDelta;
        this.yawDelta = 0;
        this.pitchDelta = 0;
        return intent;
    }
}
