// Thin WebGL2 helpers. No state of its own beyond what it returns.

export function compileProgram(gl, vertSrc, fragSrc) {
    const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        throw new Error(`Shader program failed to link:\n${log}`);
    }
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return prog;
}

function compileShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        const kind = type === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment';
        // Number the source so the driver's line numbers are usable.
        const listing = src.split('\n')
            .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
            .join('\n');
        console.error(`${kind} shader source:\n${listing}`);
        throw new Error(`${kind} shader failed to compile:\n${log}`);
    }
    return shader;
}

// Collect every active uniform location once, so draw calls are just
// lookups in a plain object.
export function uniformLocations(gl, prog) {
    const out = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, '');
        out[name] = gl.getUniformLocation(prog, name);
    }
    return out;
}

export function createTexture(gl, image, { mipmap, unit }) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA,
                  gl.UNSIGNED_BYTE, image);
    // Both terrain images are 1792x1792 -- not a power of two. WebGL2
    // supports NPOT with REPEAT and mipmaps without restriction, which
    // is what gives the tiling world for free.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mipmap) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                         gl.LINEAR_MIPMAP_LINEAR);
        const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
        if (aniso) {
            const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
            gl.texParameterf(gl.TEXTURE_2D,
                             aniso.TEXTURE_MAX_ANISOTROPY_EXT,
                             Math.min(8, max));
        }
    } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    return tex;
}

export function loadImage(url) {
    // The load event rather than img.decode(): decode() stalls
    // indefinitely in headless Chrome for images that were never
    // inserted into the document, which is exactly how these are used.
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Could not load ${url}`));
        img.src = url;
    });
}

// Read an image back as raw bytes, for the CPU-side heightmap.
export function imageToBytes(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const out = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
    return out;
}
