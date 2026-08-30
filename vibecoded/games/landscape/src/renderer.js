import { compileProgram, uniformLocations, createTexture } from './gl.js';

// The original's vertical focal length works out to 75px against a
// horizontal 92.4px (see the design doc, section 2), so its vertical
// field of view is 1.232x wider than a square-pixel projection would
// give -- which squashes the image vertically. Retro mode reproduces
// that; modern mode does not.
const RETRO_ANAMORPHIC = 92.4 / 75;

const T_NEAR = 1.0;
const STEP_MIN = 0.5;      // must match terrain.frag
const MAX_TERRAIN_HEIGHT = 249.0;

// The march advances t by `t * growth + STEP_MIN` each step, so the
// distance it reaches is fixed by the growth rate and the step budget.
// Picking growth by hand meant the budget silently fell short of the
// draw distance and far rays returned sky instead of terrain. Solve it
// instead, so changing draw distance or step count degrades quality
// rather than truncating the world.
function solveStepGrowth(drawDist, maxSteps) {
    let lo = 0.0, hi = 1.0;
    for (let i = 0; i < 48; i++) {
        const g = (lo + hi) / 2;
        let t = T_NEAR;
        for (let n = 0; n < maxSteps; n++) t += t * g + STEP_MIN;
        if (t < drawDist) lo = g; else hi = g;
    }
    return (lo + hi) / 2;
}

export class Renderer {
    constructor(canvas, sources, images) {
        const gl = canvas.getContext('webgl2', {
            antialias: false,
            depth: false,
            powerPreference: 'high-performance',
        });
        if (!gl) {
            throw new Error(
                'This browser did not provide a WebGL2 context. ' +
                'WebGL2 is required.');
        }
        this.gl = gl;
        this.canvas = canvas;

        this.program = compileProgram(gl, sources.vert, sources.frag);
        this.u = uniformLocations(gl, this.program);
        gl.useProgram(this.program);

        createTexture(gl, images.heightmap, { mipmap: false, unit: 0 });
        createTexture(gl, images.texture, { mipmap: true, unit: 1 });
        createTexture(gl, images.sky, { mipmap: false, unit: 2 });
        gl.uniform1i(this.u.uHeight, 0);
        gl.uniform1i(this.u.uTexture, 1);
        gl.uniform1i(this.u.uSky, 2);

        // Fullscreen triangle from gl_VertexID; no buffers needed, but
        // a bound VAO is still required by the spec.
        gl.bindVertexArray(gl.createVertexArray());
    }

    // Sizes the drawing buffer to renderScale * devicePixelRatio and
    // lets CSS stretch it to the window. Returns true if it changed.
    resize(renderScale) {
        const dpr = devicePixelRatio || 1;
        const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr * renderScale));
        const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr * renderScale));
        if (this.canvas.width === w && this.canvas.height === h) return false;
        this.canvas.width = w;
        this.canvas.height = h;
        this.gl.viewport(0, 0, w, h);
        return true;
    }

    draw(camera, settings) {
        const gl = this.gl;
        const { fwd, right, up } = camera.basis();
        const aspect = this.canvas.width / this.canvas.height;

        const tanY = Math.tan(settings.fov * Math.PI / 360);
        const tanHalfX = tanY * aspect;
        const tanHalfY = settings.retro ? tanY * RETRO_ANAMORPHIC : tanY;

        const az = settings.sunAzimuth * Math.PI / 180;
        const el = settings.sunElevation * Math.PI / 180;
        const sun = [
            Math.cos(el) * Math.cos(az),
            Math.cos(el) * Math.sin(az),
            Math.sin(el),
        ];

        gl.uniform3f(this.u.uCamPos, camera.x, camera.y, camera.z);
        gl.uniform3f(this.u.uFwd, fwd[0], fwd[1], fwd[2]);
        gl.uniform3f(this.u.uRight, right[0], right[1], right[2]);
        gl.uniform3f(this.u.uUp, up[0], up[1], up[2]);
        gl.uniform2f(this.u.uTanHalf, tanHalfX, tanHalfY);
        gl.uniform1f(this.u.uDrawDist, settings.drawDistance);
        gl.uniform1f(this.u.uFogDensity, settings.fogDensity);
        gl.uniform3f(this.u.uSunDir, sun[0], sun[1], sun[2]);
        gl.uniform1i(this.u.uRetro, settings.retro ? 1 : 0);
        gl.uniform1i(this.u.uMaxSteps, settings.maxSteps);

        // Only re-solved when the inputs actually change.
        if (settings.drawDistance !== this._dist ||
            settings.maxSteps !== this._steps) {
            this._dist = settings.drawDistance;
            this._steps = settings.maxSteps;
            this._growth = solveStepGrowth(this._dist, this._steps);
        }
        gl.uniform1f(this.u.uStepGrowth, this._growth);
        gl.uniform1f(this.u.uMaxHeight, MAX_TERRAIN_HEIGHT);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
}
