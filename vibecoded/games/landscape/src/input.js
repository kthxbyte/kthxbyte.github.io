// Emits intent, never raw key state, so the camera model can change
// without touching input handling.

const KEYS = {
    KeyW: ['forward', 1], KeyS: ['forward', -1],
    KeyA: ['strafe', -1], KeyD: ['strafe', 1],
    Space: ['up', 1], ControlLeft: ['up', -1],
};

export class Input {
    constructor(canvas, { onToggleUI, onFov, onDocs, onEscape }) {
        this.canvas = canvas;
        this.down = new Set();
        this.yawDelta = 0;
        this.pitchDelta = 0;
        this.locked = false;
        // Set while an overlay owns the screen. Every control is off
        // then: holding a key would otherwise fly the camera behind it,
        // and typing in a field would fly it too.
        this.suspended = false;

        addEventListener('keydown', (e) => {
            if (e.repeat) return;
            // Keys typed into a field are text, not controls. The panel
            // has a lat/lon box, and without this a "d" in it flies east
            // while you type.
            const el = e.target;
            if (el && (el.isContentEditable ||
                       ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) {
                return;
            }
            if (this.suspended) {
                if (e.key === 'Escape') onEscape?.();
                return;
            }
            if (e.key === '?') { onDocs?.(); return; }
            if (e.code === 'KeyH') { onToggleUI(); return; }
            if (KEYS[e.code] || e.code === 'ShiftLeft') {
                this.down.add(e.code);
                e.preventDefault();
            }
        });
        addEventListener('keyup', (e) => this.down.delete(e.code));
        addEventListener('blur', () => this.down.clear());

        canvas.addEventListener('click', () => {
            if (!this.locked && !this.suspended) canvas.requestPointerLock();
        });
        document.addEventListener('pointerlockchange', () => {
            this.locked = document.pointerLockElement === canvas;
            if (!this.locked) this.down.clear();
        });
        addEventListener('mousemove', (e) => {
            if (!this.locked) return;
            this.yawDelta += e.movementX;
            this.pitchDelta += e.movementY;
        });
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            onFov(Math.sign(e.deltaY) * 2);
        }, { passive: false });
    }

    suspend() {
        this.suspended = true;
        // Whatever was held when the overlay opened is not held now.
        this.down.clear();
        this.yawDelta = 0;
        this.pitchDelta = 0;
    }

    resume() { this.suspended = false; }

    // Consumed once per frame; mouse deltas are cleared on read.
    intent() {
        const out = {
            forward: 0, strafe: 0, up: 0,
            boost: this.down.has('ShiftLeft'),
            yawDelta: this.yawDelta,
            pitchDelta: this.pitchDelta,
        };
        for (const code of this.down) {
            const binding = KEYS[code];
            if (binding) out[binding[0]] += binding[1];
        }
        this.yawDelta = 0;
        this.pitchDelta = 0;
        return out;
    }
}
