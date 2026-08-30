// Touch navigation: a virtual joystick for movement, and drag-to-look
// anywhere else on the view.
//
// A second stick for the camera was tried and removed: it claimed a
// whole corner of a phone screen to do what a drag already does, and
// the screen is the thing worth spending here.
//
// Produces the same intent shape as input.js and is merged into it by
// main.js, so camera.js needs no knowledge that touch exists.

const RADIUS = 52;         // px of travel to full deflection
const DEAD_ZONE = 0.14;
const LOOK_SENS = 1.6;     // touch drags are shorter than mouse moves

export function isTouchDevice() {
    return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

// Squaring the magnitude keeps small movements fine-grained while
// leaving full deflection at full speed.
function curve(v) {
    const m = Math.hypot(v.x, v.y);
    if (m < DEAD_ZONE) return { x: 0, y: 0 };
    const scaled = ((m - DEAD_ZONE) / (1 - DEAD_ZONE)) ** 2;
    return { x: v.x / m * scaled, y: v.y / m * scaled };
}

// Pointer capture is an enhancement, never a requirement, and it can
// fail for reasons this code does not control:
//
//   NotFoundError     - the pointer is already gone by the time the
//                       handler runs.
//   InvalidStateError - the element is not connected to the document,
//                       which is reachable during page teardown with a
//                       finger still down.
//
// Neither is a reason to interrupt anything. Before this was guarded, a
// throw here escaped into window.onerror and replaced the entire running
// demo with a full-screen error page.
function capture(el, pointerId) {
    try {
        el.setPointerCapture(pointerId);
    } catch (err) {
        // Tracking still works: move and up are bound on window.
    }
}

function releaseCapture(el, pointerId) {
    try {
        el.releasePointerCapture(pointerId);
    } catch (err) {
        // Already released, or never captured. Nothing to undo.
    }
}

class Stick {
    constructor(id, label) {
        this.el = document.createElement('div');
        this.el.className = 'stick';
        this.el.id = id;
        this.el.innerHTML = `<div class="stick-thumb"></div>
                             <span class="stick-label">${label}</span>`;
        this.thumb = this.el.querySelector('.stick-thumb');
        this.pointer = null;
        this.vec = { x: 0, y: 0 };

        this.el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            this.pointer = e.pointerId;
            this.el.classList.add('active');
            capture(this.el, e.pointerId);
            this.move(e);
        });

        // Bound on window rather than on the element. Pointer capture
        // would normally keep events retargeted here once the finger
        // slides off the stick, but capture is allowed to fail (see
        // capture() below), and a stick that stops receiving pointermove
        // freezes at its last value and never releases. Listening on
        // window makes tracking correct with or without it.
        addEventListener('pointermove', (e) => {
            if (e.pointerId === this.pointer) this.move(e);
        });
        for (const ev of ['pointerup', 'pointercancel']) {
            addEventListener(ev, (e) => {
                if (e.pointerId === this.pointer) this.release();
            });
        }
    }

    move(e) {
        const r = this.el.getBoundingClientRect();
        let dx = e.clientX - (r.left + r.width / 2);
        let dy = e.clientY - (r.top + r.height / 2);
        const len = Math.hypot(dx, dy);
        if (len > RADIUS) { dx = dx / len * RADIUS; dy = dy / len * RADIUS; }
        this.thumb.style.transform =
            `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        this.vec = { x: dx / RADIUS, y: dy / RADIUS };
    }

    release() {
        if (this.pointer !== null) releaseCapture(this.el, this.pointer);
        this.pointer = null;
        this.vec = { x: 0, y: 0 };
        this.el.classList.remove('active');
        this.thumb.style.transform = 'translate(-50%, -50%)';
    }
}

export class TouchControls {
    constructor(canvas, { onToggleUI }) {
        const root = document.createElement('div');
        root.id = 'touch';
        root.innerHTML = `
          <div id="touch-buttons">
            <button id="btn-tilt" aria-label="Toggle tilt look">◎</button>
            <button id="btn-center" aria-label="Re-centre view">⌖</button>
            <button id="btn-panel" aria-label="Toggle settings">⚙</button>
          </div>
          <div id="touch-lift">
            <button id="btn-up" aria-label="Ascend">▲</button>
            <button id="btn-down" aria-label="Descend">▼</button>
          </div>`;
        document.body.appendChild(root);
        this.root = root;

        this.move = new Stick('stick-move', 'MOVE');
        root.appendChild(this.move.el);

        this.lookPointer = null;
        this.lookDx = 0;
        this.lookDy = 0;
        this.bindLook(canvas);

        this.up = 0;
        const hold = (id, apply) => {
            const el = root.querySelector(id);
            const set = (v) => (e) => { e.preventDefault(); apply(v); };
            el.addEventListener('pointerdown', set(1));
            for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
                el.addEventListener(ev, set(0));
            }
        };
        hold('#btn-up', (v) => { this.up = v; });
        hold('#btn-down', (v) => { this.up = -v; });
        root.querySelector('#btn-panel').addEventListener('click', onToggleUI);

        // A finger leaving the page mid-drag would otherwise stick.
        addEventListener('blur', () => {
            this.move.release();
            this.lookPointer = null;
        });
    }

    // Anything that starts on the canvas is a look drag. The stick and
    // buttons sit above the canvas, so touches on them never arrive
    // here and the two never fight over a finger.
    bindLook(canvas) {
        canvas.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') return;   // mouse uses pointer lock
            if (this.lookPointer !== null) return;
            this.lookPointer = e.pointerId;
            this.lookLast = { x: e.clientX, y: e.clientY };
        });
        canvas.addEventListener('pointermove', (e) => {
            if (e.pointerId !== this.lookPointer) return;
            this.lookDx += e.clientX - this.lookLast.x;
            this.lookDy += e.clientY - this.lookLast.y;
            this.lookLast = { x: e.clientX, y: e.clientY };
        });
        for (const ev of ['pointerup', 'pointercancel']) {
            canvas.addEventListener(ev, (e) => {
                if (e.pointerId === this.lookPointer) this.lookPointer = null;
            });
        }
    }

    contribute(intent) {
        const m = curve(this.move.vec);
        intent.forward += -m.y;
        intent.strafe += m.x;
        intent.up += this.up;

        intent.yawDelta += this.lookDx * LOOK_SENS;
        intent.pitchDelta += this.lookDy * LOOK_SENS;
        this.lookDx = 0;
        this.lookDy = 0;
        return intent;
    }
}
