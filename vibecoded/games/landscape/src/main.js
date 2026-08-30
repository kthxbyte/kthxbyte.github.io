import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { Input } from './input.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { Tilt, tiltSupported } from './tilt.js';
import { UI, DEFAULTS, fail } from './ui.js';
import { loadImage, imageToBytes } from './gl.js';

const WORLD = 1792;

async function loadText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
    return res.text();
}

// A pinned pose and render settings can be supplied in the URL, which
// is what makes the screenshot check reproducible and cheap:
//   ?x=200&y=200&z=90&yaw=0.4&pitch=-0.2&retro=1&scale=0.5&steps=96
function applyQuery(camera, settings) {
    const q = new URLSearchParams(location.search);
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) {
        if (q.has(k)) camera[k] = parseFloat(q.get(k));
    }
    if (q.has('retro')) settings.retro = q.get('retro') !== '0';
    if (q.has('follow')) settings.terrainFollow = q.get('follow') !== '0';
    if (q.has('fov')) settings.fov = parseFloat(q.get('fov'));
    if (q.has('scale')) settings.renderScale = parseFloat(q.get('scale'));
    if (q.has('steps')) settings.maxSteps = parseInt(q.get('steps'), 10);
    if (q.has('dist')) settings.drawDistance = parseFloat(q.get('dist'));
    return q;
}

async function main() {
    const canvas = document.getElementById('view');
    const settings = { ...DEFAULTS };
    const query = new URLSearchParams(location.search);

    // Touch devices get the on-screen controls and a lower default
    // render scale, since mobile GPUs will not hold 60fps at native
    // resolution with a 256-step march.
    const touchMode = query.has('touch')
        ? query.get('touch') !== '0'
        : isTouchDevice();
    if (touchMode) settings.renderScale = 0.6;

    let sources, images;
    try {
        [sources, images] = await Promise.all([
            Promise.all([
                loadText('./src/shaders/terrain.vert'),
                loadText('./src/shaders/terrain.frag'),
            ]).then(([vert, frag]) => ({ vert, frag })),
            Promise.all([
                loadImage('./assets/heightmap.png'),
                loadImage('./assets/texture.png'),
                loadImage('./assets/sky.png'),
            ]).then(([heightmap, texture, sky]) => ({ heightmap, texture, sky })),
        ]);
    } catch (err) {
        // Overwhelmingly the most likely cause, and the most confusing
        // one to hit, so name it explicitly.
        fail('Could not load the demo’s files',
            `${err.message}\n\n` +
            'If you opened this file directly from disk, that is the ' +
            'problem: browsers block file:// access to the shaders and ' +
            'textures. Serve the folder over HTTP instead:\n\n' +
            '    cd html && python3 -m http.server 8000\n\n' +
            'then open http://localhost:8000/');
        return;
    }

    // CPU-side copy of the heightmap, for terrain-follow and the floor.
    const heights = imageToBytes(images.heightmap);
    const groundAt = (x, y) => {
        const u = ((Math.floor(x) % WORLD) + WORLD) % WORLD;
        const v = ((Math.floor(y) % WORLD) + WORLD) % WORLD;
        return heights[v * WORLD + u];
    };

    let renderer;
    try {
        renderer = new Renderer(canvas, sources, images);
    } catch (err) {
        fail('Could not start the renderer', err.message);
        return;
    }

    const camera = new Camera(groundAt);
    const ui = new UI(settings, () => {});
    applyQuery(camera, settings);
    // Selecting retro from the panel swaps in the original's near
    // horizon; arriving in retro mode from the URL has to do the same,
    // unless the URL asked for a particular distance.
    if (query.has('retro') && !query.has('dist')) ui.applyMode();
    ui.sync();
    if (touchMode && !query.has('panel')) ui.toggle();   // start out of the way

    const hint = document.getElementById('hint');
    let hintTimer = null;
    const say = (text, ms = 2600) => {
        hint.textContent = text;
        hint.hidden = false;
        clearTimeout(hintTimer);
        if (ms) hintTimer = setTimeout(() => { hint.hidden = true; }, ms);
    };

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
        if (!tiltSupported()) {
            document.getElementById('btn-tilt').disabled = true;
        }
        hint.hidden = true;
        document.querySelector('#panel .note').textContent =
            'Drag to look · stick to move · ⚙ hides';
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
        renderer.draw(camera, settings);

        frames++;
        if (now - fpsClock >= 500) {
            fps = frames * 1000 / (now - fpsClock);
            frames = 0; fpsClock = now;
            ui.update(fps, camera, canvas.width, canvas.height);
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // Lets the screenshot check wait for a frame that has actually
    // been drawn rather than guessing at a delay.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.dataset.ready = '1';
    }));

    // From here on the demo is running, and errors stop being fatal.
    booted = true;
}

// Error severity depends entirely on whether the demo is running yet.
//
// Before boot completes, nothing works, so a full-screen message is the
// right response. Once the renderer is live, a stray exception -- an
// input handler, a sensor callback -- must NOT destroy a working demo.
// It previously did: one throw from setPointerCapture replaced the
// whole page with an error screen.
let booted = false;
let notify = null;

function nonFatal(what, err) {
    console.error(`${what}:`, err);
    if (notify) notify('Recovered from an internal error — see console', 4000);
}

addEventListener('error', (e) => {
    if (booted) nonFatal('Non-fatal error', e.error || e.message);
    else fail('Unexpected error', e.message);
});
addEventListener('unhandledrejection', (e) => {
    if (booted) nonFatal('Non-fatal rejection', e.reason);
    else fail('Unexpected error', String(e.reason));
    e.preventDefault();
});

main().catch((err) => fail('Unexpected error', err.stack || String(err)));
