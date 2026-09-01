import { compileProgram, uniformLocations, createTexture } from './gl.js';

// The original's vertical focal length works out to 75px against a
// horizontal 92.4px (see the design doc, section 2), so its vertical
// field of view is 1.232x wider than a square-pixel projection would
// give -- which squashes the image vertically. Retro mode reproduces
// that; modern mode does not.
const RETRO_ANAMORPHIC = 92.4 / 75;

const T_NEAR = 1.0;
const STEP_MIN = 0.5;      // must match terrain.frag

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

        // Unit 0 is the height texture, rebound per dataset in draw().
        createTexture(gl, images.texture, { mipmap: true, unit: 1 });
        createTexture(gl, images.sky, { mipmap: false, unit: 2 });
        gl.uniform1i(this.u.uHeight, 0);
        gl.uniform1i(this.u.uTexture, 1);
        gl.uniform1i(this.u.uSky, 2);

        // Fullscreen triangle from gl_VertexID; no buffers needed, but
        // a bound VAO is still required by the spec.
        gl.bindVertexArray(gl.createVertexArray());
        this.terrain = null;
        this.imagery = null;
        this.detail = [null, null];
    }

    // Imagery lives on its own texture unit and is bound once; it is
    // filled in progressively by the loader as tiles arrive.
    setImagery(imagery) {
        this.imagery = imagery;
        if (imagery) {
            this.gl.uniform1i(this.u.uImagery, imagery.unit);
        }
    }

    // A clipmap ring, republished by its DetailImagery whenever a new
    // rectangle is seeded. Slot 0 is the finest, slot 1 one level
    // coarser over twice the ground.
    setDetail(detail, slot = 0) {
        this.detail[slot] = detail;
        if (detail) {
            this.gl.uniform1i(slot ? this.u.uDetail2 : this.u.uDetail,
                              detail.unit);
        }
    }

    useTerrain(terrain) {
        this.terrain = terrain;
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

    draw(camera, settings, view) {
        const gl = this.gl;
        const t = this.terrain;
        const { fwd, right, up, eye } = view
            || { ...camera.basis(), eye: [camera.x, camera.y, camera.z] };

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t.heightTex);

        const vertScale = t.procedural ? settings.vertScale : 1.0;
        gl.uniform1f(this.u.uWorldSize, t.size);
        gl.uniform1f(this.u.uVertScale, vertScale);
        gl.uniform1i(this.u.uWrap, t.wrap ? 1 : 0);
        gl.uniform1i(this.u.uProcedural, t.procedural ? 1 : 0);
        // Where the window has coast, the plane is real sea level. Where
        // it does not, it sits at the lowest ground in the window, so the
        // world does not fall away to a 2 km cliff at its edge.
        gl.uniform1f(this.u.uSeaTexels,
                     t.hasSea ? 0.0 : (t.minTexels || 0) * vertScale);
        gl.uniform1i(this.u.uHasSea, t.hasSea ? 1 : 0);
        gl.uniform1f(this.u.uMetresPerTexel, t.metresPerTexel || 1.0);

        const useImagery = !!(this.imagery && t.procedural && settings.imagery);
        gl.uniform1i(this.u.uUseImagery, useImagery ? 1 : 0);
        // The imagery grid is finer than the heightmap over the same
        // ground, so its LOD is offset by that ratio.
        gl.uniform1f(this.u.uImageryLodBias,
                     this.imagery ? Math.log2(this.imagery.size / t.size) : 0);

        const d = useImagery ? this.detail[0] : null;
        const d2 = useImagery ? this.detail[1] : null;
        gl.uniform1i(this.u.uHasDetail, d ? 1 : 0);
        if (d) {
            gl.activeTexture(gl.TEXTURE0 + d.unit);
            gl.bindTexture(gl.TEXTURE_2D, d.texture);
            gl.uniform2f(this.u.uDetailOrigin, d.origin[0], d.origin[1]);
            gl.uniform1f(this.u.uDetailSpan, d.span);
            gl.uniform1f(this.u.uDetailLodBias, d.lodBias);
        }
        gl.uniform1i(this.u.uHasDetail2, d2 ? 1 : 0);
        if (d2) {
            gl.activeTexture(gl.TEXTURE0 + d2.unit);
            gl.bindTexture(gl.TEXTURE_2D, d2.texture);
            gl.uniform2f(this.u.uDetail2Origin, d2.origin[0], d2.origin[1]);
            gl.uniform1f(this.u.uDetail2Span, d2.span);
            gl.uniform1f(this.u.uDetail2LodBias, d2.lodBias);
        }
        // Debug overlay. The base tile is 256 imagery pixels, so its
        // width in world texels is the extent divided by the tile count
        // across it; rings are every kilometre of real ground.
        gl.uniform1i(this.u.uDebugGrid, settings.debugGrid ? 1 : 0);
        if (settings.debugGrid) {
            const mpt = t.metresPerTexel || 1.0;
            gl.uniform1f(this.u.uBaseTileTexels, this.imagery
                ? t.size / (this.imagery.size / 256) : 128.0);
            gl.uniform1f(this.u.uDetailTiles, d ? d.tiles : (d2 ? d2.tiles : 1.0));
            gl.uniform1f(this.u.uRingTexels, 1000.0 / mpt);
            gl.uniform1f(this.u.uThresholdTexels,
                useImagery ? settings.detailDistance * 1000.0 / mpt : 0.0);
        }

        const aspect = this.canvas.width / this.canvas.height;

        const tanY = Math.tan(settings.fov * Math.PI / 360);
        const tanHalfX = tanY * aspect;
        const tanHalfY = settings.retro ? tanY * RETRO_ANAMORPHIC : tanY;

        // Sun position as a compass bearing: 0 = north, 90 = east,
        // clockwise. World +X is east and +Y is south, so north is -Y.
        const az = settings.sunAzimuth * Math.PI / 180;
        const el = settings.sunElevation * Math.PI / 180;
        const sun = [
            Math.cos(el) * Math.sin(az),
            -Math.cos(el) * Math.cos(az),
            Math.sin(el),
        ];

        gl.uniform3f(this.u.uCamPos, eye[0], eye[1], eye[2]);
        gl.uniform3f(this.u.uFwd, fwd[0], fwd[1], fwd[2]);
        gl.uniform3f(this.u.uRight, right[0], right[1], right[2]);
        gl.uniform3f(this.u.uUp, up[0], up[1], up[2]);
        gl.uniform2f(this.u.uTanHalf, tanHalfX, tanHalfY);
        // Texture LOD is a pixel-footprint question, so it needs the real
        // buffer height rather than the constant it used to assume.
        gl.uniform1f(this.u.uTexelsPerPx, 2.0 * tanHalfY / this.canvas.height);
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
        gl.uniform1f(this.u.uMaxHeight, t.maxTexels * vertScale + 1.0);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
}
