# REDESIGN.md

A complete specification of the WebGL re-implementation of the SDL
voxel-space landscape demo. This document is written to be sufficient
on its own: someone with no access to the code in `src/` should be able
to rebuild a functionally identical application from it.

It covers what was built, the arithmetic it rests on, the numbers it
uses, why particular choices were made over the alternatives, and the
environment quirks that cost time to discover.

---

## 1. Provenance

The source material is a voxel-space landscape renderer written in
C++/SDL. The author dates it to roughly 2004; the files in the parent
directory are stamped March 2010 and are a later revision, not the
origin. The relevant files:

| File | What it is |
|---|---|
| `main.cpp` | the whole demo, ~330 lines, single file |
| `main.original.cpp` | an earlier revision, kept as a before/after of an optimisation pass |
| `heightmap.bmp` | 1792x1792, 8-bit, uncompressed |
| `texture.bmp` | 1792x1792, 8-bit, uncompressed, its own 256-colour palette |
| `sky.bmp` | 512x128 panorama strip, loaded but its blit is commented out |
| `paleta.pal` | JASC-PAL palette, unused by the running program |

The original renders at 320x240 in an 8-bit paletted SDL surface,
targets 30fps, and is driven with the arrow keys plus a scattering of
letter keys.

**Nothing in the parent directory is modified.** The port is additive
and self-contained in `html/`.

---

## 2. Facts established about the original

These were derived by reading `main.cpp` and inspecting the assets.
The implementation depends on all of them, and none are obvious on a
first read, so they are recorded with their derivations.

### 2.1 The heightmap's palette index is the terrain height

`heightmap.bmp` has a pure grayscale palette: entry N is RGB (N, N, N).
The palette index therefore *is* the height, needing no decoding.
Verified exact over all pixels; the observed range is 0-249, so the
tallest terrain sample is 249.

This is asserted at conversion time rather than assumed, because the
entire shader depends on it.

### 2.2 The sky is white

The frame is cleared with `memset(screen->pixels, 255, W*H)`, and
`texture.bmp`'s palette entry 255 is (255, 255, 255). Anything the
terrain does not cover is white. The `sky.bmp` blit is commented out
in the revision that ships.

### 2.3 The world tiles at 1792, and the original has a seam

The original wraps coordinates with `terrain.size = heightmap->w - 1`,
i.e. 1791. But the heightmap is seamless at period **1792**: column 0
and column 1791 differ by a mean of 0.75, consistent with any two
adjacent columns, whereas column 0 against column 1790 differs by 0.89.

So `w - 1` is an off-by-one that skips the last column and introduces a
one-column discontinuity. **This is a bug and is not reproduced.** The
port wraps at 1792, which is also what a GL `REPEAT` sampler does for
free.

### 2.4 Altitude is above-ground-level

Each frame the original samples the terrain height under the camera and
adds `cam.height` to it:

```c
h = *(heightmap->pixels + v*pitch + u);
int cam_height = h + (int)cam.height;
```

The camera therefore hugs the terrain at a fixed clearance — a
hovercraft, not an aircraft. `cam.height` is a clearance, not an
altitude.

### 2.5 The projection, and its anamorphism

The original builds a lookup table, once per depth step:

```c
int s = -(SCR_WIDTH * SCR_HEIGHT * 2) / (d + 1);
int constant = ((int)(-cam_height * s) >> 11) + (int)cam.inclination;
int factor = 0;
for (int i = 0; i < 256; i++) {
    int tmp = constant + ((factor += s) >> 11);
    if (tmp < 0) tmp = 0;
    terrain->projectiontable[i] = tmp;
}
```

Expanding it, for a terrain sample of height `h` at depth `d`:

```
screen_y = inclination + ((h - cam_height) * s) / 2048
         = inclination + (cam_height - h) * (W*H*2) / ((d+1) * 2048)
```

With W=320 and H=240, `(W*H*2)/2048 = 153600/2048 = 75` exactly, so:

```
screen_y = inclination + 75 * (cam_height - h) / (d + 1)
```

That is a standard perspective divide with a **vertical focal length of
75 pixels**.

The horizontal focal length is set independently, by the FOV. With
`FOV_EXTENDED` (a half-angle of pi/3, so a 120-degree total sweep) and
a half-width of 160 pixels:

```
f_h = 160 / tan(60 deg) = 92.376 px
```

The two do not match. A square-pixel projection would need
`f_v == f_h`. Instead:

- actual vertical FOV: `2*atan(120/75)` = **116.0 degrees**
- square-pixel vertical FOV: `2*atan(120/92.376)` = **104.8 degrees**
- ratio: `92.376 / 75` = **1.2317**

A *wider* vertical field fits more world into the same pixels, so the
2010 image is **squashed vertically** by a factor of 1.232. (An earlier
draft of this analysis called it a stretch. It is a squash; the factor
is the same.)

`cam.inclination` is a screen-space horizon offset added after the
divide — it is not a pitch. Looking up shears the image rather than
rotating the camera, which is why these engines feel the way they do.

### 2.6 Depth stepping

```c
for (int d = 0; d < cam->distance; d += (1 + (d >> 6)))
```

Step size grows linearly with distance, because distant samples cover
more screen area and can be coarser. This reasoning carries directly
into the port.

### 2.7 Speed has no drag

`ss += s*2` on every frame the up arrow is held, and `ss` never decays.
Holding forward makes you faster indefinitely. Angular speed `sa` does
decay, by 0.0002 per frame.

### 2.8 Dead code, not carried over

- `cam.hollow` and `cam.interpolation` are toggled by the `h` and `i`
  keys and never read. They also flip on *every frame* the key is held,
  since the code tests key state rather than a key-down edge.
- `landscape.lastc[]` is initialised and never used.
- `screenpitch` is assigned and never used.

---

## 3. What was built, and what was rejected

### 3.1 Chosen approach

A **per-pixel ray march in a WebGL2 fragment shader**. One fullscreen
triangle; every fragment casts its own ray and marches the heightmap.

The original's two defining optimisations do not survive, and should
not: the per-column high-water mark (`lasty[]`) and the per-depth-step
projection table both exist to let a single CPU fill 320x240 at 30fps.
Neither has a GPU analogue. The shader produces the same *image* by
different means.

### 3.2 Rejected: WebGPU compute shader, column-parallel

Because there is no camera roll, every pixel in a screen column shares
one azimuth. That permits one compute thread per column, walking
front-to-back and keeping the original's `lasty` occlusion mark — a
genuine translation of `View()`, and O(columns x depth) rather than
O(pixels x steps), likely 5-10x cheaper.

Rejected for now on three grounds: WebGPU is not universally available
(Chrome/Edge yes, Firefox recent, Safari 26+); the plumbing (storage
textures, bind groups, workgroup sizing) is substantially more code;
and per-pixel effects like slope lighting are awkward when writing
spans rather than pixels.

The module boundaries in section 5 are drawn so this could be added
later as a second backend without touching camera, input, or UI code.

### 3.3 Rejected: two-pass low-resolution march

March into a reduced-resolution buffer holding depth and terrain UV,
then shade at full resolution. Cheaper on weak hardware, but it adds
moving parts and produces edge artifacts where the coarse march
disagrees with the fine shading. A render-scale control solves the same
problem with none of the complexity.

### 3.4 Rejected: twin virtual joysticks

Built and then removed. A second stick for the camera claimed a corner
of a phone screen to do what a drag anywhere already does. On a device
where screen area is the scarce resource, drag-to-look wins. See
section 11.

---

## 4. Conventions

**Coordinate system.** Right-handed, **+Z up**. World X and Y map
directly onto heightmap and texture columns and rows. Terrain heights
are in the same units as X and Y — a 1:1 vertical scale, matching the
original.

**World size.** 1792 units square, tiling infinitely in both X and Y.

**Angles.** `yaw` is rotation about +Z, with yaw = 0 looking along +X.
`pitch` is positive looking up. There is no roll, ever — the shader's
basis assumes it, and the column-coherence argument in section 3.2
depends on it.

**Compass directions, and a handedness trap.** Web Mercator tile rows
run north to south, and world Y indexes those rows directly, so:

    +X = east      +Y = SOUTH      +Z = up

Treating that triple as right-handed is *physically* left-handed: in
reality east x south points down, not up. Anything that derives a
direction by cross product has to account for it, and getting it wrong
is invisible in play, because the image and the turn direction mirror
together and stay self-consistent. It only shows against a map. See
sections 8.6 and 10.1 for the two places it matters.

**Look deltas.** All look input is expressed in *mouse-pixel units*, a
common currency converted to radians in exactly one place
(`MOUSE_SENS`, section 10). Touch drags and tilt readings are scaled
into these units so every source composes without special cases.

---

## 5. File layout

```
html/
  index.html                 canvas, panel markup, all CSS, module script tag
  README.md                  how to run, controls, notes
  REDESIGN.md                this document
  src/
    main.js                  boot, asset load, frame loop, wiring
    renderer.js              WebGL2 context, program, textures, uniforms, draw
    camera.js                pose, integration, terrain-follow
    input.js                 keyboard, pointer lock, wheel -> intent
    touch.js                 movement joystick, drag-to-look
    tilt.js                  device-orientation look
    ui.js                    settings panel binding, defaults, error display
    gl.js                    shader/texture/image helpers
    shaders/
      terrain.vert
      terrain.frag
  assets/
    heightmap.png            473 KB, grayscale, height = pixel value
    texture.png              1910 KB, indexed
    sky.png                  47 KB, de-dithered panorama
  tools/
    convert-assets.py        BMP -> PNG, output committed
```

ES modules, no bundler, no runtime dependencies, no build step.

### 5.1 Module boundaries

These are load-bearing and should be preserved in any rewrite:

- **`renderer.js`** receives a camera-pose object and a settings object.
  It touches no DOM beyond its own canvas and knows nothing about input.
- **`camera.js`** knows nothing about WebGL or the DOM. It consumes an
  intent object and produces a pose. It receives ground height through
  an injected `groundAt(x, y)` callback, so it needs no knowledge of how
  the heightmap was loaded.
- **`input.js`, `touch.js`, `tilt.js`** all emit the *same* intent
  shape and are merged additively. None of them knows the others exist.

---

## 6. Asset pipeline

`tools/convert-assets.py` reads the original BMPs from the parent
directory using Pillow and writes PNGs into `assets/`. Output is
committed so running the demo needs no build step; the script exists so
the derivation is reproducible and documented.

### 6.1 heightmap.bmp -> heightmap.png

Converted to mode `L`. **Before converting, assert that the palette
index equals the grayscale value for every pixel** — the shader's
height decoding is wrong if this does not hold, and it should fail
loudly rather than render subtly wrong terrain.

Result: 473 KB.

### 6.2 texture.bmp -> texture.png

Saved as an **indexed** PNG, preserving the original palette. The
browser decodes it to RGB on load.

Indexed rather than RGB because it is 1910 KB instead of 5666 KB, and
both are lossless. Lossy WebP was measured at 1156 KB but rejected: it
perturbs the exact palette colours that retro mode exists to reproduce.

**The terrain texture is not filtered or cleaned in any way.** Its
dithering is the look.

### 6.3 sky.bmp -> sky.png, with de-dithering

The sky strip carries ordered dithering from its 8-bit origins. Stretched
across a modern screen at 24bpp that dither reads as coloured speckle
rather than as a gradient.

It is therefore blurred with a **1.4px Gaussian**. The blur must **wrap
horizontally** — it is a 360-degree panorama, and blurring the edges
independently puts a visible seam at due north. Implementation: tile the
image three times horizontally, blur the triple-width image, crop the
centre third.

This treatment applies *only* to the sky. Retro mode does not use the
sky texture at all, so nothing faithful is lost.

Result: 47 KB.

### 6.4 Round-trip verification

After writing, the script re-reads both terrain PNGs and asserts their
pixel values equal the source BMPs' values. This is the only automated
correctness check in the project and it should be kept.

---

## 7. Boot sequence

`src/main.js`:

1. Read the canvas element and clone `DEFAULTS` into a `settings` object.
2. Parse the URL query (section 15).
3. Decide **touch mode**: `?touch=` if present, otherwise
   `matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0`.
   In touch mode, set `renderScale` to 0.6 — mobile GPUs will not hold
   60fps at native resolution with a 256-step march.
4. Load, in parallel: both shader sources via `fetch`, and all three
   images. **Any failure here shows the `file://` error message**
   (section 14) — it is the first failure a user hits and the most
   confusing.
5. Decode the heightmap image to a `Uint8Array` via an offscreen 2D
   canvas (`drawImage` then `getImageData`, taking every 4th byte).
   This backs `groundAt(x, y)` for terrain-follow and the soft floor.
6. Construct the `Renderer`. Failure here shows the WebGL2 / shader
   error message.
7. Construct `Camera`, `UI`, `Input`, and — in touch mode —
   `TouchControls` and `Tilt`.
8. Apply the URL query to the camera and settings, then `ui.sync()`.
   If the query set `retro` but not `dist`, also call `ui.applyMode()`
   so URL-driven retro gets the same 300-unit horizon the checkbox
   gives.
9. Start the `requestAnimationFrame` loop.
10. After two nested `requestAnimationFrame` callbacks, set
    `document.body.dataset.ready = '1'`. This lets the screenshot check
    wait for a frame that has actually been drawn instead of guessing a
    delay.

### 7.1 The frame loop

```
dt = min(0.1, (now - last) / 1000)      // clamp; a backgrounded tab
                                        // otherwise returns a huge dt
intent = input.intent()
touch?.contribute(intent)
tilt?.contribute(intent)
renderer.resize(settings.renderScale)
camera.update(dt, intent, settings)
renderer.draw(camera, settings)
```

FPS is averaged over 500ms windows and pushed to the panel.

---

## 8. Renderer

### 8.1 Context

```js
canvas.getContext('webgl2', {
    antialias: false,       // nothing to antialias; every pixel is a march
    depth: false,           // no depth buffer is ever used
    powerPreference: 'high-performance',
})
```

A null return is a hard failure with a clear message.

### 8.2 Geometry

A **fullscreen triangle** generated from `gl_VertexID`, with no vertex
buffers:

```glsl
vNdc = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
gl_Position = vec4(vNdc, 0.0, 1.0);
```

Drawn with `drawArrays(TRIANGLES, 0, 3)`. WebGL2 still requires a bound
VAO even with no attributes, so bind an empty one once at startup.

A triangle rather than a quad: no diagonal seam, and one fewer vertex.

### 8.3 Textures

All three are uploaded as `RGBA8` / `RGBA` / `UNSIGNED_BYTE`, with
`UNPACK_FLIP_Y_WEBGL` **false** — texture V therefore increases with
world Y, matching the heightmap's row order.

| Unit | Texture | Mipmaps | Min filter |
|---|---|---|---|
| 0 | heightmap | no | `LINEAR` |
| 1 | terrain texture | yes | `LINEAR_MIPMAP_LINEAR` |
| 2 | sky | no | `LINEAR` |

All use `REPEAT` on S and T and `LINEAR` magnification.

The terrain texture additionally requests
`EXT_texture_filter_anisotropic` at `min(8, MAX)` when available —
terrain is viewed at grazing angles almost everywhere, which is exactly
the case anisotropy exists for.

The heightmap gets **no mipmaps**: a mipmapped height is an averaged
height, which would round off peaks and let rays pass through ridges.

Both terrain images are 1792x1792, which is **not a power of two**.
WebGL2 supports NPOT textures with `REPEAT` and mipmaps without
restriction (WebGL1 did not), which is what makes the tiling world free.

### 8.4 Uniforms

Locations are collected once by iterating `ACTIVE_UNIFORMS`, so draw
calls are plain object lookups and unused uniforms cannot cause a null
location surprise.

| Uniform | Type | Value |
|---|---|---|
| `uHeight`, `uTexture`, `uSky` | `sampler2D` | units 0, 1, 2 |
| `uCamPos` | `vec3` | camera world X, Y, Z |
| `uFwd`, `uRight`, `uUp` | `vec3` | camera basis |
| `uTanHalf` | `vec2` | tan of half-FOV, horizontal and vertical |
| `uDrawDist` | `float` | world units |
| `uFogDensity` | `float` | |
| `uSunDir` | `vec3` | unit vector |
| `uRetro` | `bool` | mode switch |
| `uMaxSteps` | `int` | march budget |
| `uStepGrowth` | `float` | solved, section 9.3 |
| `uMaxHeight` | `float` | tallest sample, vertically scaled |
| `uWorldSize` | `float` | texels per side of the height texture |
| `uVertScale` | `float` | vertical exaggeration |
| `uWrap` | `bool` | dataset tiles (synthetic) or is finite (real) |
| `uProcedural` | `bool` | colour from elevation rather than a texture |
| `uSeaTexels` | `float` | sea level in scaled units (0) |
| `uMetresPerTexel` | `float` | ground resolution, for the colour ramp |
| `uImagery` | `sampler2D` | satellite imagery, unit 3 |
| `uUseImagery` | `bool` | drape imagery instead of hypsometric colour |
| `uImageryLodBias` | `float` | log2(imagery size / heightmap size) |

### 8.5 Projection

```js
tanY     = tan(fov * PI / 360)              // fov is the vertical FOV, degrees
tanHalfX = tanY * aspect
tanHalfY = retro ? tanY * 1.2317 : tanY     // 92.4 / 75
```

Modern mode is a correct square-pixel perspective. Retro mode widens
the vertical field by the anamorphic factor from section 2.5, which
reproduces the original's vertical squash at any window aspect ratio —
the factor is a ratio of focal lengths, so it does not assume 4:3.

`aspect` is taken from the **drawing buffer**, not the CSS size, so
render scale never distorts the image.

### 8.6 Sun direction

The sun is positioned by **compass bearing** -- 0 = north, 90 = east,
clockwise -- and elevation, both in degrees. Since north is -Y
(section 4):

```js
sun = [cos(el)*sin(bearing), -cos(el)*cos(bearing), sin(el)]
```

The bearing convention matters once the terrain is a real place. Caldera
is at latitude -27, where the sun is in the **north**; its dataset
default is a bearing of 330, giving raking afternoon light from the
north-west. The synthetic map keeps its own arbitrary default.

### 8.7 Resize

Called every frame; cheap, and it catches window resizes, device-pixel-
ratio changes, and render-scale changes with one code path.

```js
w = round(canvas.clientWidth  * devicePixelRatio * renderScale)
h = round(canvas.clientHeight * devicePixelRatio * renderScale)
```

Set `canvas.width/height` only when they differ (assigning them clears
the buffer), then `gl.viewport(0, 0, w, h)`. CSS holds the canvas at
`100vw x 100vh`, so the browser upscales.

---

## 9. The ray march

The whole renderer is one fragment shader. This section is its full
specification.

### 9.1 Ray construction

```glsl
dir = normalize(uFwd
              + uRight * (vNdc.x * uTanHalf.x)
              + uUp    * (vNdc.y * uTanHalf.y));
```

### 9.2 The height-ceiling skip

Terrain never exceeds `uMaxHeight` (249). While a ray is above that
ceiling it cannot possibly hit anything:

```glsl
float t = 1.0;
if (uCamPos.z > uMaxHeight) {
    if (dir.z >= 0.0) { output sky; return; }     // rising: never hits
    t = max(t, (uMaxHeight - uCamPos.z) / dir.z); // falling: skip to ceiling
}
```

This is **exact, not an approximation** — it cannot skip geometry — and
it saves the entire descent when flying high.

### 9.3 The march loop, and solving the growth rate

```glsl
float tPrev = t;
bool hit = false;
for (int i = 0; i < uMaxSteps; i++) {
    if (t > uDrawDist) break;
    vec3 p = uCamPos + dir * t;
    if (p.z < sampleHeight(p.xy)) { hit = true; break; }
    tPrev = t;
    t += t * uStepGrowth + STEP_MIN;      // STEP_MIN = 0.5
}
```

The step grows with distance — the same reasoning as the original's
`d += 1 + (d >> 6)`.

**This is where the one significant bug of the port lived.** With a
hand-picked growth of 0.01 from `t = 1`, the recurrence reaches only

```
t_256 ~= 600 world units
```

which is *less than the default draw distance of 1200*. Rays beyond
600 units silently exhausted their budget and returned sky, so the
lower half of the frame filled with haze instead of terrain. At
`steps=96` the reach is about 82 units and almost nothing renders.

The fix is to stop guessing. The recurrence is

```
t_0   = T_NEAR = 1.0
t_n+1 = t_n * (1 + g) + STEP_MIN
```

and `g` is **solved on the CPU by bisection** so that `t_N` equals the
draw distance exactly:

```js
function solveStepGrowth(drawDist, maxSteps) {
    let lo = 0.0, hi = 1.0;
    for (let i = 0; i < 48; i++) {
        const g = (lo + hi) / 2;
        let t = 1.0;
        for (let n = 0; n < maxSteps; n++) t += t * g + 0.5;
        if (t < drawDist) lo = g; else hi = g;
    }
    return (lo + hi) / 2;
}
```

Re-solved only when `drawDistance` or `maxSteps` changes, and cached.
48 bisection iterations over at most a few hundred steps is trivial at
that frequency.

Reference values:

| draw distance | steps | growth | reaches |
|---|---|---|---|
| 1200 | 256 | 0.01377 | 1200.0 |
| 300 | 256 | 0.00586 | 300.0 |
| 3000 | 256 | 0.01845 | 3000.0 |
| 1200 | 96 | 0.05023 | 1200.0 |

The property this buys: **changing draw distance or step count degrades
quality gracefully instead of silently truncating the world.** Any
rewrite that hard-codes a growth constant reintroduces the bug.

`STEP_MIN` (0.5) and `T_NEAR` (1.0) appear in both the shader and the
solver and must agree. The shader keeps `STEP_MIN` as a constant; the
solver keeps its own copy with a comment saying so.

### 9.4 Binary refinement

On a hit, six bisection iterations between the last miss (`tPrev`) and
the first hit:

```glsl
float lo = tPrev, hi = min(t, uDrawDist);
for (int i = 0; i < 6; i++) {
    float mid = 0.5 * (lo + hi);
    if ((uCamPos + dir*mid).z < sampleHeight((uCamPos + dir*mid).xy)) hi = mid;
    else lo = mid;
}
float dist = hi;
```

This is the step the CPU version could not afford, and it is why near
geometry does not stair-step the way the original does.

### 9.5 Height sampling

```glsl
// modern: filtered, wrapping handled by the sampler
float heightAt(vec2 p) { return texture(uHeight, p / 1792.0).r * 255.0; }

// retro: nearest. texelFetch ignores sampler filtering AND wrapping,
// so the wrap must be done by hand.
float heightAtNearest(vec2 p) {
    return texelFetch(uHeight, ivec2(mod(floor(p), 1792.0)), 0).r * 255.0;
}
```

### 9.6 Terrain colour

```glsl
// retro: exact palette colour, nearest
texelFetch(uTexture, ivec2(mod(floor(p), 1792.0)), 0).rgb

// modern: explicit LOD from distance
lod = clamp(log2(max(dist, 1.0) * 0.004), 0.0, 8.0);
textureLod(uTexture, p / 1792.0, lod).rgb
```

**`textureLod`, not `texture`.** Automatic derivatives are undefined
inside the non-uniform control flow of the march loop — neighbouring
fragments exit at different iterations — so the implicit-LOD form
produces garbage mip selection. The LOD is computed from distance
instead.

### 9.7 Sky

```glsl
if (uRetro) return vec3(1.0);           // the original's white

az = atan(dir.y, dir.x) / TAU + 0.5;
el = clamp(asin(clamp(dir.z, -1, 1)) / (PI/2), 0.0, 1.0);
return texture(uSky, vec2(az, 1.0 - el)).rgb;
```

The strip spans horizon (bottom row) to zenith (top row) over 0-90
degrees of elevation. Below-horizon directions clamp to the bottom row.

### 9.8 Shading

Retro mode returns the albedo unmodified — the original was flat and
unlit.

Modern mode takes the normal from central differences on the heightmap,
one world unit either side:

```glsl
n = normalize(vec3(hl - hr, hd - hu, 2.0));
lambert = max(dot(n, uSunDir), 0.0);
ambient = 0.35 + 0.15 * n.z;
colour  = albedo * (ambient + 0.85 * lambert);
```

The `0.15 * n.z` term is a cheap sky-occlusion approximation: upward-
facing ground gets slightly more ambient than a vertical cliff face.

These four extra height samples are taken with the *filtered* sampler
even in retro mode's absence, because a nearest-sampled normal would be
piecewise constant and faceted.

### 9.9 Fog and the horizon fade

```glsl
if (!uRetro) {
    vec3 sky = skyAt(dir);
    float f = exp2(-pow(dist * uFogDensity, 2.0));
    colour = mix(sky, colour, clamp(f, 0.0, 1.0));
    colour = mix(colour, sky, smoothstep(0.8, 1.0, dist / uDrawDist));
}
```

The second `mix` is the **horizon fade**, and it matters. Terrain simply
stops at the draw distance; if fog has not finished hiding it by then,
the cutoff appears as a hard edge along the horizon. With the default
density of 0.0012 at 1200 units, fog leaves 24% of the terrain visible
at the cutoff — clearly banded.

Fading the last 20% of the draw distance to sky makes the cutoff
invisible **at any fog setting**, including zero, rather than relying on
the two sliders being tuned against each other.

Retro mode deliberately keeps the hard cutoff. That is what the
original did.

---

## 10. Camera

`src/camera.js`. Constants:

| Constant | Value | Meaning |
|---|---|---|
| `WORLD` | 1792 | wrap period |
| `PITCH_LIMIT` | `PI/2 - 0.01` | avoids a degenerate basis at the poles |
| `ACCEL` | 900 | world units / s^2 |
| `BOOST` | 4 | multiplier while boost is held |
| `DAMPING_TAU` | 0.15 s | velocity decay time constant |
| `MOUSE_SENS` | 0.0022 | radians per mouse-pixel unit |
| `FLOOR_CLEARANCE` | 2 | soft floor above ground in free flight |

**Initial pose**, matching the original's opening view: position
(200, 200), yaw 0, pitch 0, clearance 50 above the ground beneath that
point, terrain-follow on.

### 10.1 Basis

```js
fwd   = [cos(pitch)*cos(yaw), cos(pitch)*sin(yaw), sin(pitch)]
right = [-sin(yaw), cos(yaw), 0]      // the direction at yaw + 90 deg
up    = cross(fwd, right)
```

`right` is derived analytically rather than by normalising a cross
product with world-up, which would be undefined looking straight up.

Both lines are consequences of the handedness note in section 4. Screen
right is the direction at yaw + 90 degrees, which at yaw 0 -- facing
east -- is +Y, i.e. **south**: what your right hand does facing east.
And `up` is `fwd x right`, not `right x fwd`, because with +Y south the
world triple is physically left-handed and that ordering is what puts
screen-up back on +Z.

This was originally written as `right = [sin(yaw), -cos(yaw), 0]` with
`up = cross(right, fwd)`, which put screen-right on **north** and
mirrored every rendered frame north-for-south. Nothing about the
controls felt wrong -- view and turn direction mirror together -- and
the synthetic 2010 map has no ground truth to check against, so it
survived until real terrain was rendered beside a real map. Confirmed
by rendering a near-orthographic nadir view and comparing it with the
source aerial imagery.

### 10.2 Integration

```js
yaw   += intent.yawDelta   * MOUSE_SENS
pitch -= intent.pitchDelta * MOUSE_SENS      // screen Y is inverted
pitch  = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT)

speed = ACCEL * (intent.boost ? BOOST : 1)
vel  += (drive * intent.forward + right * intent.strafe) * speed * dt
vel  *= exp(-dt / DAMPING_TAU)               // frame-rate independent
pos  += vel * dt
```

Exponential damping rather than a per-frame multiplier, so behaviour
does not change with frame rate. This is the deliberate departure from
the original's undamped `ss` (section 2.7): release a key and you coast
to a stop.

### 10.3 Terrain-follow vs free flight

**Terrain-follow** (the original's model):

```js
drive     = [cos(yaw), sin(yaw), 0]          // heading, not view vector
clearance = max(2, clearance + intent.up * 60 * dt)
z         = groundAt(x, y) + clearance
vel.z     = 0
```

Movement is taken along the **heading**, not the view vector. If it
followed the view, looking down would drive you into a hill that the
follow logic then lifts you back out of — the camera would fight
itself. The vertical intent retargets clearance instead of velocity.

**Free flight**:

```js
vel.z += intent.up * speed * dt
z     += vel.z * dt
floor  = groundAt(x, y) + FLOOR_CLEARANCE
if (z < floor) { z = floor; vel.z = max(0, vel.z); }   // soft floor
```

Zeroing only *downward* velocity at the floor lets you climb away
immediately instead of sticking.

### 10.4 Coordinate wrapping

After integrating, X and Y are wrapped into `[0, 1792)`. Float
precision would otherwise degrade without limit as you fly. Because the
world repeats at exactly that period, the wrap is invisible.

---

## 11. Input

All three sources produce the same **intent object**, merged additively
in the frame loop:

```js
{ forward, strafe, up,      // -1 .. 1 (touch is continuous)
  boost,                    // bool
  yawDelta, pitchDelta }    // mouse-pixel units, consumed per frame
```

### 11.1 Keyboard and mouse (`input.js`)

| Binding | |
|---|---|
| `W` `A` `S` `D` | forward / strafe |
| `Space` / `ControlLeft` | up / down |
| `ShiftLeft` | boost |
| `H` | toggle panel |
| mouse move | look, **only while pointer-locked** |
| click on canvas | request pointer lock |
| wheel | FOV, +/- 2 degrees per notch, clamped 30-120 |

Held keys live in a `Set` keyed by `event.code`. `keydown` with
`e.repeat` is ignored so autorepeat does not double-count. The set is
cleared on window `blur` and on losing pointer lock, otherwise a key
held while tabbing away sticks down forever.

Mouse deltas accumulate from `movementX/Y` and are **cleared when
read**, so a slow frame accumulates the whole movement rather than
dropping it.

The wheel listener must be `{ passive: false }` for `preventDefault` to
suppress page zoom.

### 11.2 Touch (`touch.js`)

Shown only in touch mode. Layout:

- **movement joystick**, bottom-left, 132px base with a 58px thumb and
  52px of travel to full deflection
- **drag anywhere on the canvas** to look
- **altitude buttons** (up / down), bottom-right
- **tilt, re-centre, and settings buttons**, top-right

Response curve, applied to the stick vector:

```js
m = length(v)
if (m < 0.14) return zero                         // dead zone
scaled = ((m - 0.14) / (1 - 0.14)) ** 2           // squared response
return v/m * scaled
```

Squaring keeps small deflections fine-grained while leaving full
deflection at full speed.

Drag-to-look accumulates client-coordinate deltas scaled by
`LOOK_SENS = 1.6` — touch drags cover less distance than mouse moves —
and is cleared on read, exactly like the mouse.

Implementation notes that matter:

- **Pointer Events throughout**, tracking `pointerId`. This is what
  allows steering and looking with two fingers simultaneously.
- **The stick's `pointermove` / `pointerup` / `pointercancel` listeners
  are bound on `window`, not on the stick element**, filtered by
  `pointerId`. Pointer capture would normally retarget those events to
  the element once the finger slides off it, but capture is allowed to
  fail (below), and a stick that stops receiving `pointermove` freezes
  at its last deflection and never releases — leaving the camera
  flying. Binding on `window` makes tracking correct with or without
  capture.
- **`setPointerCapture` is an enhancement and must be wrapped in
  try/catch.** Chromium's `Element::setPointerCapture` has exactly two
  throwing branches, and both are reachable from conditions the page
  does not control:

  | Condition | Exception | Message |
  |---|---|---|
  | pointer no longer active | `NotFoundError` | "No active pointer with the given id is found." |
  | `!element.isConnected()` | `InvalidStateError` | "InvalidStateError" |

  The second fires when a touch lands on the stick while the element is
  detached — reachable during page teardown with a finger still down.
  `releasePointerCapture` is guarded for the same reason.

  This was a real bug: the unguarded call threw out of the handler,
  reached `window.onerror`, and replaced the entire running demo with a
  full-screen error page. See section 14.
- The stick and buttons are DOM siblings stacked *above* the canvas, so
  touches on them never reach the canvas listener and the two never
  fight over a finger. No hit-testing or coordinate exclusion needed.
- `pointerdown` on a control calls `preventDefault` to stop synthetic
  mouse events and text selection.
- Canvas and controls set `touch-action: none` so drags do not scroll
  or pinch-zoom the page.
- The container is `position: fixed; inset: 0; pointer-events: none`,
  with `pointer-events: auto` restored on the controls themselves.
- On window `blur`, release the stick and drop the look pointer.

### 11.3 Tilt (`tilt.js`)

Optional device-orientation steering, off by default, toggled by the
`◎` button.

It contributes **frame-to-frame deltas**, not absolute angles, into the
same `yawDelta`/`pitchDelta` fields. That is what lets tilting and
dragging compose instead of fighting: neither one owns the camera.

```js
yawSrc   = event.alpha
pitchSrc = landscape ? event.gamma : event.beta   // from screen.orientation.angle
dYaw     = shortestAngle(yawSrc - last.yaw)       // alpha wraps at 360
dPitch   = (pitchSrc - last.pitch) * (angle === 270 ? -1 : 1)
if (|dYaw| > 45 || |dPitch| > 45) return          // reject sensor glitches
yawDelta   -= dYaw   * 6.0                        // degrees -> mouse-pixel units
pitchDelta -= dPitch * 6.0
```

Screen orientation is read from `screen.orientation.angle` rather than
assuming portrait, because the device axes swap in landscape.

**Re-centre** (`⌖`) sets `camera.pitch = 0` and drops the delta
reference, so however the phone is being held right now becomes level,
with no jump on the next reading.

Two platform constraints, both handled explicitly:

1. **iOS 13+ requires `DeviceOrientationEvent.requestPermission()` to be
   called from a user gesture.** This is why enabling tilt is a button
   tap and can never be automatic.
2. **The events only fire in a secure context.** `localhost` qualifies;
   a plain `http://192.168.x.x` address on a LAN does not — and it
   fails *silently*, which is the worst possible feedback. So after
   enabling, a 1500ms timer checks whether any event arrived, and if
   not, reports the likely cause (checking `isSecureContext` to choose
   the message) and disables itself.

---

## 12. Settings and UI

`src/ui.js` binds plain HTML inputs to one settings object. No
framework.

| Setting | Default | Range |
|---|---|---|
| `retro` | false | checkbox |
| `terrainFollow` | true | checkbox |
| `renderScale` | 1.0 (0.6 on touch) | 0.25 - 1.0, step 0.05 |
| `drawDistance` | 1200 | 200 - 3000, step 50 |
| `fogDensity` | 0.0012 | 0 - 0.005, step 0.0001 |
| `sunAzimuth` | 135 | 0 - 360 degrees |
| `sunElevation` | 45 | 2 - 88 degrees |
| `fov` | 75 | 30 - 120 degrees (vertical) |
| `maxSteps` | 256 | not exposed; URL only |

**Draw distance is per-mode.** Retro has no fog, so it needs the
original's near horizon (300) or terrain visibly ends in mid-air.
Modern wants the fade much further out (1200). Each mode remembers its
own value in a `{ true: …, false: … }` map, swapped by `applyMode()`
whenever the retro checkbox changes — and also on boot when the URL
sets `retro` without setting `dist`.

`sync()` pushes the settings object back into every control. It is
needed because settings change from outside the panel: the URL query,
the scroll wheel, and the draw-distance swap.

The panel starts hidden in touch mode, and its hint line is rewritten
for touch (`Drag to look · stick to move · ⚙ hides`).

Stats readout: FPS, drawing-buffer dimensions, and camera X / Y /
altitude, refreshed twice a second.

---

## 13. Styling

All CSS lives inline in `index.html`. Dark translucent panels with
`backdrop-filter: blur()`, a monospace UI font stack, and one accent
colour (`#7fc4ff`) used for the accent text, slider thumbs, and active
control states.

Two media queries:

- `max-width: 560px` — the panel becomes nearly full-width and scrolls
  internally, capped at 56vh, so it cannot bury the view.
- `max-height: 480px` — landscape phones are short, so the joystick
  shrinks from 132px to 108px and the altitude buttons move down.

The viewport meta includes `maximum-scale=1, user-scalable=no,
viewport-fit=cover`: pinch-zoom on a first-person view is never wanted
and interferes with drag-to-look.

---

## 14. Failure handling

**Severity depends on whether the demo is running yet.** This
distinction is essential and was missing from the first implementation,
with bad consequences.

**Before boot completes**, nothing works, so any error is fatal and
replaces the canvas with a readable full-screen message:

- **WebGL2 unavailable** — `getContext` returned null.
- **Shader compile or link failure** — the message carries the driver's
  info log. The compiler also logs the *line-numbered* shader source to
  the console, so the driver's line numbers are directly usable.
- **Asset load failure** — this is the `file://` case. The message says
  explicitly that browsers block `file://` access to shaders and
  textures, and gives the `python3 -m http.server` command. This is the
  first failure a new user hits and the one they are least likely to
  diagnose.
- **Anything else** — a top-level `addEventListener('error')`, an
  `addEventListener('unhandledrejection')`, and a `.catch()` on the boot
  promise. Without these, a failure leaves a blank page and a console
  message the user will never open.

**After boot completes**, a stray exception must *not* destroy a
working demo. A `booted` flag flips once the frame loop is running;
from then on the same handlers log to the console and show a transient
line in the hint area, and the renderer keeps running.

The original implementation escalated everything to fatal. The result
was that a single failed `setPointerCapture` in a touch handler — an
event of no consequence, in code that is purely an input enhancement —
replaced a perfectly healthy running renderer with a full-screen error
page. An error handler that cannot distinguish "the app never started"
from "an input handler hiccupped" will eventually do this to you.

Rule of thumb for a rewrite: **fatal is for the boot path only.**
Anything raised by an input handler, a sensor callback, or a frame
should be reported and survived.

---

### 14a. Wind

Drone-like drift, `wind.js` plus `Camera.viewBasis`, on a 0-100% slider
that defaults to 20%.

Offsets come from summed sines at incommensurate periods rather than a
noise texture or a random walk: no state to keep or reset, identical on
every machine and every reload, and no visible repeat because the
periods have no least common multiple. Three bands, which is what makes
it read as a drone rather than a wobble:

| band | periods | peak at 100% |
|---|---|---|
| attitude | 2.3 - 9.1 s | yaw 1.31 deg, pitch 0.89 deg, roll 2.76 deg |
| position | 8.9 - 33.5 s | sway 2.70 m, heave 1.83 m |
| gust envelope | 11.3 - 41.9 s | swells both between 0.65x and 1.0x |

Peaks land under the nominal amplitudes because the three sines never
crest together, which is the point of choosing the ratios that way. At
the 20% default, roll is 0.19 deg rms and 0.55 deg peak.

**Applied to the basis at render time, never to the stored pose.** Three
reasons, and the third is the one that would not have been obvious:

- the controls stay honest -- drift never blows you off course
- terrain-follow and the floor clamp keep working on the true position
- **the imagery LOD does not see it.** The detail rectangle is chosen
  from `camera.pitch` and `camera.x/y`; drift folded into the pose would
  jiggle the viewing distance and could refetch a hundred tiles for a
  wobble.

`basis()` had no roll term, and roll is the cue that reads as a drone,
so `viewBasis` rotates `right` and `up` about `fwd`. That is the same
function whose handedness caused the north-south inversion in section
20, so the ordering is repeated there deliberately and orthonormality is
asserted rather than assumed: over 600 s at full strength, max
`|len - 1|` is 3.3e-16 and max `|dot|` is 1.9e-16. With wind at 0,
`viewBasis` returns `basis()` unchanged, bit for bit.

Heave is scaled by `vertScale` the way altitude is, and the eye is
clamped above the ground: a downward gust must not push the camera
through a hill the true position is safely above.

## 15. URL parameters

These pin camera pose and render settings, which is what makes
screenshots reproducible:

| Parameter | Effect |
|---|---|
| `x`, `y`, `z` | camera position |
| `yaw`, `pitch` | camera orientation, radians |
| `retro` | `0`/`1`; also applies the retro draw distance unless `dist` is given |
| `follow` | `0`/`1` terrain-follow |
| `fov` | vertical FOV, degrees |
| `scale` | render scale |
| `steps` | march step budget |
| `dist` | draw distance |
| `fog` | fog density |
| `terrain` | dataset name |
| `imagery` | `0`/`1` satellite imagery |
| `vs` | vertical exaggeration |
| `touch` | `0`/`1`, force touch UI on or off |
| `panel` | present = keep the panel open in touch mode |
| `detail` | imagery detail switch distance, km |
| `wind` | camera drift strength, 0 to 1 |
| `hud` | `0` strips the overlay, for clean screenshots |

Anything set here is **pinned**: datasets carry their own defaults for
fog, draw distance and sun position, applied when the dataset is
selected, and those skip any key the URL specified. Without that, a
pinned `fog` or `dist` was silently overwritten a moment after being
read -- which cost real time while diagnosing the orientation bug,
because the diagnostic renders were quietly ignoring `fog=0`.

Example:

```
index.html?x=760&y=980&z=140&yaw=1.1&pitch=-0.05&scale=0.4&steps=128
```

---

## 16. Verification

There is no meaningful unit-test surface here; most of it is verified by
looking at it. The checks that do exist:

1. **Asset round-trip.** `convert-assets.py` asserts the heightmap
   palette is a grayscale ramp and that both terrain PNGs decode back to
   the source BMP values. Run it and read the output.

2. **Rendered screenshot**, per mode:

   ```
   python3 -m http.server 8000     # from html/
   google-chrome --headless --disable-gpu --enable-unsafe-swiftshader \
     --window-size=760,480 --virtual-time-budget=25000 \
     --screenshot=out.png \
     "http://localhost:8000/?x=760&y=980&z=140&yaw=1.1&pitch=-0.05&scale=0.4&steps=128"
   ```

   Then inspect the image. A frame that is uniformly sky, uniformly
   black, or banded across the horizon is a failure — that last one is
   exactly how the step-budget bug of section 9.3 presented.

3. **DOM assertions** without rendering, via `--dump-dom`: check that
   `data-ready` is set, that `#error-title` is empty, and that panel
   values match expectations.

4. **FPS**, from the panel readout, in a real browser at render scale
   1.0.

### 16.1 Environment quirks that cost time

Worth knowing before repeating this work:

- **`img.decode()` never settles in headless Chrome** for images that
  were never inserted into the document. It hung the entire boot
  sequence with no error. Use the `load` event instead — it is the more
  portable primitive regardless.
- **Headless Chrome clamps window width to a 500px minimum.**
  `--window-size=390,720` lays out at `innerWidth = 500` and the
  screenshot merely crops. Mobile layout captured this way looks broken
  when it is fine. Verify at >= 500px wide, or measure
  `getBoundingClientRect` and check the numbers rather than the picture.
- **Headless falls back to SwiftShader**, a software rasteriser. It
  renders correctly but tells you nothing about performance, and it is
  slow enough that a full-resolution 256-step march will exceed a
  two-minute timeout. Use `scale` and `steps` to keep checks cheap, and
  never quote a headless frame rate as a result.
- **Chrome's `--enable-logging=stderr --v=1` does not surface page
  console output** amid its own noise. Route page errors into the DOM
  and read them with `--dump-dom`.

---

## 17. Performance notes

At render scale 1.0 on a 1080p display, the shader issues roughly 250M
texture fetches per frame. That is comfortable on a discrete GPU and
borderline on Intel integrated graphics; the render-scale control is the
mitigation, and touch devices default to 0.6.

The height-ceiling skip (section 9.2) removes most of the cost when
flying high. The dominant remaining cost is near-horizon rays, which
travel furthest and use the full step budget.

**Real-hardware frame rates are unmeasured.** The only browser available
during development was headless Chrome on SwiftShader.

---

## 18. Deliberately not built

Water, shadows, LOD or quadtree acceleration, multiple maps, a WebGPU
backend, and the original's unused `hollow` and `interpolation` flags.


## 19. Real-world terrain

The engine renders two datasets: the synthetic 2010 heightmap, and real
elevation fetched from the Tilezen terrain tiles. Both go through the
same march; the differences are confined to how heights are decoded and
how the surface is coloured.

### 19.1 Why the engine did not have to move to metres

The obvious approach -- convert everything to metres -- is the wrong
one, and the arithmetic says why. A texel at zoom 13 is **17 m**. So a
20 km view is 1200 texels: precisely the draw distance the demo already
used. Real-world scale does not stress this renderer, it relaxes it.

Consequently **the engine still works in texel units throughout**. Only
two places know about metres: the height decode (metres -> texels), and
the UI readout (texels -> metres). Every constant in `camera.js`, the
step-growth solver, the draw-distance ranges and the fog defaults carry
over untouched.

Conversions:

    height_texels = elevation_metres / metresPerTexel * vertScale
    altitude_m    = camera.z / vertScale * metresPerTexel
    view_km       = drawDistance * metresPerTexel / 1000

### 19.2 The data

`tools/fetch-terrain.py` fetches a 7x7 mosaic of 256 px tiles -- 1792
px, the same dimensions as the 2010 heightmap -- from

    https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png

served by AWS Open Data with **no API key**. The default is Caldera,
Atacama, at zoom 13: 30.5 km across, 17.02 m/texel, -5 m to 952 m.

Zoom 13 is chosen from measurement, not assumption. Comparing each level
against a bilinear upsample of the level above it:

| step | Atacama | Andes inland | Mt Rainier (US) |
|---|---|---|---|
| z11 -> z12 | 3.56 m | 7.90 m | 8.23 m |
| z12 -> z13 | 1.10 m | 5.45 m | 3.35 m |
| **z13 -> z14** | **0.10 m** | **0.40 m** | 2.43 m |
| z14 -> z15 | 0.12 m | 0.23 m | 0.91 m |

There is a cliff between z13 and z14 in Chile: detail falls by an order
of magnitude to below any real terrain feature. z14 and z15 exist there
but are interpolation. z16 is a 404 everywhere. The US keeps gaining
detail because it is covered by 3DEP lidar rather than SRTM, so the
useful ceiling is a property of the **region**, not the tileset.

The mosaic is stored as the **raw terrarium PNG**, not flattened to
grey. Eight bits over 957 m of relief would quantise to ~4 m steps and
terrace visibly on the gentle slopes that dominate real terrain.

### 19.3 Decoding, and the filtering trap

Terrarium packs elevation across three channels:

    elevation_metres = (R * 256 + G + B / 256) - 32768

**This texture must never be linearly filtered.** The hardware would
interpolate R, G and B independently, and wherever R steps across a
256 m boundary while G wraps 255 -> 0, the decoded result is a garbage
spike.

So `decodeHeights()` in `gl.js` decodes on the CPU into a `Float32Array`
of texel units, which is then uploaded as a single-channel **R16F**
texture. R16F is filterable in WebGL2 without an extension (R32F is
not), and half-float precision at these magnitudes is well under a
metre. The same array serves `groundAt()` for terrain-follow and the
floor.

The 2010 heightmap goes through the identical path with `encoding:
'grey'` -- its pixel value is already a height in texel units -- so
there is exactly one height-sampling path in the shader.

### 19.4 A finite world

The synthetic map tiles seamlessly and wraps. Real terrain is a finite
window, so:

- its texture uses `CLAMP_TO_EDGE`, and `heightAt` returns sea level for
  anything outside `[0, uWorldSize)`, giving open ocean rather than
  edge texels smeared to the horizon;
- `camera.js` only folds coordinates back into the first tile when
  `settings.wrapWorld` is set.

### 19.5 The sea is a plane, not terrain

At this zoom the tiles carry no bathymetry: the ocean is flat at 0 m,
and 32% of the Caldera window is sea.

Marching a flat surface is the ray marcher's worst case. The ray runs
nearly parallel to it, so which texel it samples between steps is close
to arbitrary and the hit position quantises to the step size. The sea is
therefore **intersected analytically** -- `t = -camZ / dir.z` -- and
whichever of that and the terrain hit is nearer wins. It is exact, it
costs nothing, and it gives a clean horizon.

Sea shading is a separate function: flat normal, a tight specular glint
so it reads as water rather than blue paint, and a grazing-angle sky
reflection that strengthens toward the horizon.

### 19.6 Colour without a texture

Real elevation arrives with no colour map, so `uProcedural` switches
`shade()` to a hypsometric ramp. Its thresholds are in **metres**, not
texels, because texel counts shift with the exaggeration:

    beach 0 m -> sand 5-40 m -> ochre 40-180 m -> rust 180-420 m
    -> bare rock 420-900 m, darkened on slopes above ~0.6

### 19.7 Per-dataset defaults

Some settings are properties of the world rather than of the renderer,
so each dataset carries its own and they are applied on switch:

| | Original 2010 | Caldera |
|---|---|---|
| fog density | 0.0012 | 0.0006 (Atacama air is very clear) |
| retro horizon | 300 texels | 900 texels (~15 km) |
| vertical scale | fixed 1x | 3x, adjustable |

Retro's horizon needed to become per-dataset: 300 texels suits the 2010
map's small world, but over open sea it cuts a visible circle out of the
water.

### 19.8 What this is not

This is a **static** window: one mosaic, fetched at build time. There is
no tile streaming, no window recentring, no multi-resolution clipmap.
The groundwork is there for it -- the numbers in 19.1 show a single
2048 px window would cover 70 km, and at cruising speed that takes
minutes to cross, so streaming would be a fetch-and-swap rather than a
clipmap -- but none of it is built.


## 20. Satellite imagery

Real elevation with a hypsometric ramp reads as a relief map. Draping
photography over it reads as a place. `src/imagery.js` fetches Esri
World Imagery at runtime and assembles it into one texture.

### 20.1 Why it registers for free

Esri's World Imagery uses the **same Web Mercator tile grid** as the
Tilezen terrain tiles. There is no reprojection and no resampling: tile
`{z}/{x}/{y}` covers identical ground in both. Verified by comparing the
imagery's water against the elevation-derived coastline over the whole
Caldera extent -- best alignment offset **dx=0, dy=0**, 98.9% agreement,
the remainder being surf and the crudeness of the water test.

Because the imagery covers exactly the terrain's extent, the shader
shares normalised coordinates between them: `p / uWorldSize` indexes
both. Only the LOD differs, by `log2(imagerySize / heightmapSize)`.

**One trap.** Esri puts the row before the column:

    OSM and terrarium:  .../{z}/{x}/{y}.png
    Esri World Imagery: .../MapServer/tile/{z}/{y}/{x}

Reversing them does not error. It silently returns a valid tile from the
wrong place.

Both `server.arcgisonline.com` and the terrain bucket send
`Access-Control-Allow-Origin: *`, so tiles load as WebGL textures with
`crossOrigin = 'anonymous'`. Without that attribute the texture upload
throws a security error instead.

### 20.2 Choosing the zoom

Because the grids nest, imagery at `terrainZoom + k` covers the same
ground at 2^k the detail. Measured over the Caldera extent:

| imagery zoom | mosaic | tiles | download | resolution | VRAM (RGBA) |
|---|---|---|---|---|---|
| z13 | 1792 px | 49 | 352 KB | 17.0 m/px | 13 MB |
| **z14** | **3584 px** | **196** | **1.3 MB** | **8.5 m/px** | **51 MB** |
| z15 | 7168 px | 784 | ~5 MB | 4.25 m/px | 205 MB |

z14 is the choice: four times the terrain's detail for 1.3 MB, and
3584 px stays inside `MAX_TEXTURE_SIZE` on mobile GPUs where 7168 px
would not. Touch devices drop to z13, a quarter of the texture memory.
World Imagery itself goes to z19, so there is far more available to a
streaming implementation.

### 20.3 Loading

One texture is allocated up front and filled by `texSubImage2D` as tiles
arrive, eight at a time, so the view stays usable while it loads. Two
details matter:

- The texture is **cleared to a neutral desert tone** through a
  framebuffer first. Freshly allocated texture memory is undefined, so
  without it the mosaic fills in over black.
- `MIN_FILTER` starts as `LINEAR`, not a mipmapped filter. With no mip
  chain yet the texture would be incomplete and sample black.
  `generateMipmap` and `LINEAR_MIPMAP_LINEAR` are set once every tile
  has landed.

Fetching ~200 tiles at once reliably loses one or two to transient
errors -- the first run left 2 of 196 holes. Each tile gets **one
delayed retry**, which closed the gap. A tile that still fails leaves
the cleared tone behind rather than aborting the mosaic.

### 20.4 Relighting photography

Satellite imagery already contains the sun: shading, shadows and all.
Relighting it at full strength double-shades the terrain and reads as
mud. Imagery therefore gets mostly flat light:

| | ambient | direct |
|---|---|---|
| hypsometric | 0.35 + 0.15 n.z | 0.85 |
| imagery | 0.72 | 0.28 |

The pair is kept at or below 1.0 for a flat surface under a
45-degree sun; above that the imagery washes out to white. The sea gets
the same treatment -- the photography already has the ocean, the surf
and the shallows in it, so its specular glint drops from 0.8 to 0.25 and
the horizon sky reflection is tightened.

### 20.5 The moving detail layer

The base mosaic covers the whole extent at a fixed zoom, which caps
detail at 8.5 m/px however low you fly. A second, much smaller texture
follows the camera at a zoom chosen from altitude, and the shader
prefers it wherever it applies.

**Where the imagery actually stops, and how that was got wrong.**
The first attempt reused the elevation method -- compare each level
against a bilinear upsample of the level above -- and concluded detail
ran to z19. It does not. That test measures *difference*, and beyond a
region's high-resolution coverage Esri serves a flat grey "Map data not
yet available" placeholder instead of a 404, which maximises difference
just as effectively as real detail. The z17 -> z18 reading of 95.4 RMS,
against ~17 elsewhere, was the placeholder arriving; it was initially
misread as a change of source layer.

The test that settles it is that the placeholder is *identical at every
tile position*. Fetching two widely separated tiles per zoom:

| zoom | m/px | two tiles identical? | verdict |
|---|---|---|---|
| z15 | 4.25 | no | real imagery |
| z16 | 2.13 | no | real imagery |
| **z17** | **1.06** | **no** | **real imagery -- the ceiling here** |
| z18 | 0.53 | yes (sha 1660d86a) | placeholder |
| z19 | 0.27 | yes (sha 1660d86a) | placeholder |

**The ceiling is detected, not assumed**, because it is a property of
the region: dense metropolitan areas go further, and much of the world
stops earlier. Before committing to a rectangle, one tile at its centre
is drawn to a 16x16 canvas and tested:

|  | variance | chroma |
|---|---|---|
| real imagery (z16, z17) | 370 - 943 | 14.0 |
| placeholder (z18, z19) | 6.7 | 0.0 |

Flagged when `variance < 60 && chroma < 4`. Both conditions are needed:
open water is flat too, but it is blue -- chroma around 60 -- so the
colour test stops the sea being mistaken for missing coverage. On a hit
the ceiling drops a level and the probe repeats, so the first descent
walks z19 -> z18 -> z17 for the cost of two tiles rather than two
wasted 64-tile rectangles.

**The descent runs once, up front, before any rectangle is requested.**
Discovering the ceiling lazily -- as a side effect of the first load --
works only while the zoom is chosen purely from the screen, because that
choice starts at the optimistic ceiling and walks down through it. Once
a hand-set switch distance can bias the choice (below), a request lands
on a level *underneath* the assumed ceiling, its probe finds real
imagery, and the levels above are never tested at all. The ceiling then
stays at its guess forever, and everything anchored to it -- the bias,
the cover limit, the `auto` readout -- is measured against a level that
does not exist. Calibrating first costs the same two tiles and removes
the dependency. The walk-down inside `load()` stays as a safety net for
extents whose coverage is not uniform.

**Two rings over a static base.** This began as one moving layer, on
the reasoning that a single rectangle over a static mosaic covers the
useful altitude range for a 30 km world at a fraction of a clipmap's
machinery. That held while the layer was altitude-driven. It stopped
holding once the zoom was chosen from viewing distance, because of a
constraint that is easy to state and easy to miss:

**at a fixed tile budget, each level finer halves the ground covered.**

| level | m/px | span | reaches |
|---|---|---|---|
| z15 | 4.25 | 10.9 km | 9.69 km |
| z16 | 2.13 | 5.4 km | 4.85 km |
| z17 | 1.06 | 2.7 km | 2.42 km |

So a rectangle sharp enough for the centre of the frame is too narrow
for its sides -- at a 2.4 km look distance the frame spans about
+/-2.6 km while a z17 rectangle reaches +/-1.36 km, and the difference
falls back to the 8.5 m/px base. No switch distance fixes that; it is
geometry, not tuning. Forcing the finest level everywhere makes it
worse rather than better, and a single z17 rectangle reaching 10 km
would need 42x42 tiles and a 447 MB texture.

A second ring is the obvious answer, and it was built, measured, and
taken out again. The reasoning that argues for it is sound as far as it
goes, and what it leaves out is the whole point: **the sides it would
cover are far away, where a screen pixel already covers more ground than
the base mosaic's 8.5 m/px.** There is almost no headroom for a second
ring to fill.

Measured, one ring against two, at a 1000x560 buffer (aspect 1.79, the
shape that most exposes the sides):

| pose | overall | pixels changed | edges |
|---|---|---|---|
| 500 m, pitch -17 | x1.00 | 0.6% | x1.00 |
| 150 m, pitch -2 | x1.02 | 2.0% | x1.04 / x1.06 |

The edges do improve at low altitude, precisely where the geometry says
they should. Four to six per cent over the outer sixths of the frame
does not pay for double the tiles per refresh and another 52 MB of
texture, so `RING_OFFSETS` in `main.js` is `[0]`.

The machinery stays: `DetailImagery` takes `unit` and `zoomOffset`, and
the shader blends two rings coarsest-first, so adding `-1` turns it back
on. The measurements above are the case that would have to change first.

Three things that only showed up in the building, worth having written
down before anyone rebuilds it:

- **The hysteresis compares the wrong pair.** `update()` tests
  `|target.zoomF - cur.zoom|`, but `zoomF` is the unoffset continuous
  zoom while a ring's loaded level already has `zoomOffset` folded in.
  For an offset ring that difference sits permanently near 1.0, outside
  the 0.85 keep-window, so it refetched its entire rectangle every
  frame. The two-ring render failed to settle in 250 s before the fix
  and completed in under 115 s after it. `cur.zoom - this.zoomOffset`
  is the correct comparison.
- **Rings need distinct texture units**, 4 and 5, and the seeding blit
  binds the outgoing layer on its own unit -- see the note under
  Publishing.
- **Bandwidth wants splitting** 16/8 rather than 16/16: both at full
  width put 32 requests in flight, past the measured knee, and delay the
  ring covering the centre of the view behind tiles for the periphery.

**Choosing the zoom -- from viewing distance, not altitude.** The first
version drove the zoom from height above ground. That is only right for
a camera pointing straight down. Flying level at 500 m, the terrain
being looked at is two kilometres ahead, so an altitude-driven layer is
both too fine and too small, and lands under the camera instead of where
the eye is. The symptom is that detail appears to arrive "too late" --
you have to descend almost onto the ground before it engages.

What actually sets the required resolution is **how much ground one
screen pixel covers at the distance being viewed**:

    refPitch     = pitch - 0.15 * fovY          // a third up from the bottom
    distance     = agl / max(-sin(refPitch), sin 4 deg)   , capped at 15 km
    requiredMpp  = distance * fovY / drawingBufferHeight
    zoom         = terrainZoom + log2(metresPerTerrainTexel / requiredMpp)

clamped to `[baseZoom + 1, detected ceiling]`, and switched off when it
falls below `baseZoom + 0.5`, where the full-extent mosaic is already as
fine as the screen resolves.

The reference ray is taken slightly below screen centre rather than at
it. Resolution demand is set by the *nearest* ground in view, but
centring on the nearest ground would put the layer under the camera
again; a third of the way up from the bottom edge balances the two.

A useful property falls out of the formula: the span it produces,
`size * requiredMpp`, is about three times the viewing distance, which
comfortably contains both the camera and the point it is looking at
without needing a separate rule.

Note that `drawingBufferHeight` is deliberate, not `clientHeight`. At a
reduced render scale there are genuinely fewer pixels to resolve detail
with, and the layer correctly backs off.

Measured, at a 900px-tall buffer and 75 degree vertical field:

| altitude | pitch | look distance | need | detail |
|---|---|---|---|---|
| 500 m | -3 deg | 2.03 km | 2.95 m/px | z16, 4.4 km span |
| 500 m | -34 deg | 0.70 km | 1.02 m/px | z17, 2.2 km span |
| 170 m | -15 deg | 0.38 km | 0.56 m/px | z17 (ceiling) |
| 1 500 m | -10 deg | 4.14 km | 6.02 m/px | off |
| 1 500 m | -30 deg | 2.27 km | 3.31 m/px | z15, 8.7 km span |
| 9 983 m | -10 deg | 15.0 km | 21.8 m/px | off |

The rows that matter are the first two: the same altitude gives
different answers depending on where the camera looks, which is the
whole point.

Because zoom is a base-2 scale, each level owns a distance band exactly
half the width of the one above it. At a 900px buffer and the z17
ceiling: z17 under 1.03 km, z16 to 2.07 km, z15 to 4.14 km, off beyond.
The boundaries are proportional to buffer height, so they move with the
window and the render scale.

**The switch distance is a control, not a constant.** The formula above
says when finer imagery stops being *resolvable*, which is not the same
question as when it stops being *worth fetching* -- a slightly soft
texture at 1.5 km may still read better than the base mosaic, and only
flying it tells you where the line is. So the screen-derived figure is
treated as an auto default, and the panel exposes the distance at which
the finest available level gives way to the next one down:

    auto      = metresPerTerrainTexel * bufferHeight / fovY
              * 2^(terrainZoom - ceiling + 0.5)
    zoomF    += log2(wanted / auto)

One bias applied to `zoomF` shifts the whole ladder at once, so the
bands stay a factor of two apart and only their placement moves. At the
default 2.2 km: z17 to 2.2 km, z16 to 4.4 km, z15 to 8.8 km, off beyond.
Because the bias is defined against the *detected* ceiling rather than a
hard-coded z17, it stays correct in a region whose imagery stops higher
or goes further.

Substituting the definitions collapses the whole expression, and the
result is worth knowing:

    zoomF = ceiling - 0.5 + log2(wanted / distance)

Buffer height cancels exactly. In auto mode the bands move with the
window and the render scale, because resolution is the whole input; the
moment a switch distance is set by hand the ladder becomes purely
geometric -- `distance == wanted` puts you precisely on the boundary of
the finest level, whatever the screen is doing. That is the property
that makes the slider mean what its label says.

**Capped by reach -- per level, not per request.** A level is worth
choosing only if its rectangle covers the ground being looked at, and
each step down doubles the span:

    reach(zoom) = tiles * 256 * 2^(terrainZoom - zoom)
                * metresPerTerrainTexel * 0.89

which for the 2560px desktop rectangle is 2.42 km at z17, 4.85 km at
z16, 9.69 km at z15 (halve all three for the 1280px touch rectangle).

The first version clamped the switch *distance* to `reach(ceiling)`, and
that was the wrong level to clamp against: it forbade asking for "z16
out to 4 km" even though a z16 rectangle covers 4.85 km comfortably. At
the default exaggeration it left three of the slider's five positions
returning the same answer, and the control read as dead. Measured at
500 m, 2.5x, before the fix:

| look | 0.4 km | 1 km | 1.5 km | 2 km | 2.5 km |
|---|---|---|---|---|---|
| 5.45 km | off | off | z15 | z15 | z15 |

The clamp is now applied to the level instead, as a continuous zoom so
the hysteresis still compares like with like -- a hard step would sit
permanently more than a level away from the loaded zoom and refetch
every frame:

    reachF = terrainZoom + log2(tiles * 256 * mPerTexel * 0.89 / dist) - 0.5
    zoomF  = min(asked, reachF)

The half level comes off so `round()` lands on a level whose reach
really does cover `dist`. The slider now runs to 8 km, and its upper end
has a clean meaning: *the finest level whose rectangle can cover what
you are looking at*. The readout marks that state `rect-limited`, which
distinguishes "the slider is holding this back" from "the geometry is".
Same measurement after:

| look | 0.4 km | 1 km | 2 km | 3 km | 4 km |
|---|---|---|---|---|---|
| 5.45 km (-2 deg) | off | off | z15 | z15* | z15* |
| 3.45 km (-10 deg) | off | z15 | z16 | z16* | z16* |
| 2.41 km (-20 deg) | off | z15 | z16 | z17* | z17* |
| 1.90 km (-30 deg) | off | z16 | z17 | z17* | z17* |

`*` = rect-limited. The -2 degree row still tops out at z15, and that is
honest rather than a shortcoming: z16 would need to reach 5.45 km when
it reaches 4.85, and at that distance a screen pixel covers about 7.9 m
while z15 already delivers 4.25 m/px. Buying it would mean a 12x12
rectangle, 144 tiles a refresh against 100, for resolution below what
the screen can show.

**Height must be taken in the geometry the rays march, not the one the
readout shows.** This is the mistake that made the whole feature look
broken, and it is worth stating precisely. Heights are exaggerated by
`vertScale` (2.5 by default); horizontal distance is not. A camera whose
readout says 500 m therefore sits 88 texels above the terrain, and the
ground under a reference ray at 13.5 degrees below horizontal is
`88 / sin(13.5) = 375` texels away -- **6.4 km**, not the 2.14 km the
metric altitude implies. Exactly `vertScale` too small.

Passing `clearance / vertScale * metresPerTexel` as the height put the
rectangle at a third of the distance it needed, so above roughly 200 m
every pixel on screen fell outside it. The fix is one line -- pass
`clearance * metresPerTexel` -- but it was hard to see, because the
readout was computed from the same quantity and so agreed with itself.
It took rendering the blend weight and the in/out test as colour to show
that the entire frame was outside the rectangle.

The coherence check that now holds, and did not before: **the span must
contain the look distance it was chosen for.**

| pitch | look distance | level | span |
|---|---|---|---|
| -2 deg | 6.41 km | z15, 4.25 m/px | 10.9 km |
| -20 deg | 2.89 km | z16, 2.13 m/px | 5.4 km |
| -52 deg | 1.69 km | z17, 1.06 m/px | 2.7 km |

A consequence worth stating plainly: **the exaggeration setting decides
which levels are reachable**, because it decides how far away the ground
under the reference ray is. Measured at 500 m with the switch distance
at 2.2 km:

| pitch | vs 1 | vs 2.5 (default) | vs 3 |
|---|---|---|---|
| -2 deg | 2.18 km, z17 | 5.45 km, z15 | 6.54 km, z15 |
| -10 deg | 1.38 km, z17 | 3.45 km, z16 | 4.14 km, z16 |
| -20 deg | 0.96 km, z17 | 2.41 km, z16 | 2.89 km, z16 |
| -30 deg | 0.76 km, z17 | 1.90 km, z17 | 2.27 km, z16 |
| -52 deg | 0.56 km, z17 | 1.40 km, z17 | 1.68 km, z17 |

Only at 1x does the opening view reach the ceiling level, because that
is the setting where a readout of 500 m means the camera really is 500 m
up in the geometry the rays march. At 2.5x the ceiling arrives from
about 28 degrees down; at 3x, 38 degrees. None of this is tunable away
-- covering a 6.4 km look distance at z17 would need a 13 km rectangle,
which is thousands of tiles.

**Avoiding thrash.** The layer is refetched when the wanted zoom drifts
more than 0.85 levels from the current one, or the camera leaves the
middle 76% of the rectangle.

That window was 1.6 levels, and it was wrong twice over. `round()`
already grants half a level of slack, so adding a *whole* level on top
double-counted it; the result was a factor of three in viewing distance
before the layer would move. Flying, it merely felt sticky. Against a
slider it was fatal: a deliberate change moves `zoomF` by a fraction of
a level, the window swallowed all of it, and the control read as dead
even though the chosen zoom underneath was changing correctly. Hence
both halves of the fix -- a keep-window of `0.5 + 0.35` levels, and an
explicit `invalidate()` that a settings change calls so a deliberate act
never waits on a threshold meant for continuous motion. Loads carry a generation counter, so a
request superseded mid-flight discards its tiles and its texture.

**Publishing, and the latency it used to cost.** The first version
swapped a rectangle in only once every tile had arrived, on the
reasoning that a half-filled rectangle over perfectly good base imagery
looks worse than no detail at all. That reasoning is right, and the
consequence was that the entire fetch was dead time in front of the
viewer -- the level appeared to change seconds after the camera did.
Three things were stacked:

| | cost |
|---|---|
| `CONCURRENCY = 8` | 3.09 s for 100 tiles; 16 does it in 1.83 s |
| centre tile probed serially before the rectangle | one round trip per switch |
| publish only when complete | the whole 1.8-3 s, invisible |

Measured against Esri over HTTP/2, 100 z17 tiles: 3.09 s at concurrency
8, 1.83 s at 16, 1.92 s at 24, 1.99 s at 32. Sixteen is the knee.

The probe no longer gates the rectangle. It exists to catch the
placeholder graphic, but the ceiling is calibrated up front now, so a
blank is rare; it runs in parallel and the generation counter throws the
rectangle away in the rare case it fires. One wasted rectangle
occasionally beats a round trip on every switch.

**Seeding** removes the publish dilemma rather than trading against it.
Before any tile is requested, the new texture is painted -- by a small
blit program, into a framebuffer -- with the base mosaic, and with the
outgoing detail layer wherever the two overlap. The new layer therefore
starts out identical to whatever it replaces and only improves, so it
can go on screen immediately. There is no regression during a z16 to
z17 transition either, because the z16 content is copied forward.

Two things this got wrong first time, both worth keeping in mind:

- **Seeding from an empty mosaic.** The seed is taken as soon as the
  ceiling calibrates, which on a cold start is well before the base
  mosaic's first tiles land -- so the seed was the clear colour and the
  layer published flat sand over the terrain. Early publish is now
  gated on `base.done || current`: with nothing worth copying, it falls
  back to publishing when complete. A finished-image test cannot catch
  this, because the tiles overwrite the seed; it was found by
  suppressing the tile pool so only the seed rendered.
- **Both layers live on `DETAIL_UNIT`.** `seedTexture` binds the
  outgoing layer to sample it, which clobbers the binding of the
  incoming one, so the `generateMipmap` after it was rebuilding the
  wrong texture's chain whenever a previous layer existed. The binding
  is restored explicitly now.

Tiles are ordered middle-out so the part of the rectangle the camera is
pointed at resolves first, and mipmaps rebuild every 25 tiles -- the
shader samples them at distance, and a stale chain aliases mid-load.
The panel reports `loaded/total` while filling and the elapsed time once
done.

**Blending.** The detail is cross-faded rather than switched, by
`smoothstep` over the inner 10% of the rectangle border, so its edge is
not a straight line drawn across the terrain. Levels can also differ in
capture date and colour balance, which the fade hides.

There was a second fade, with distance from the camera, between 0.45 and
0.9 of the span -- on the reasoning that distant ground does not need
detail because the base is already finer than the screen resolves. That
reasoning belonged to the altitude-driven layer. Once the zoom is chosen
*from* the viewing distance, the fade cancels precisely the ground the
rectangle was just sized for: at a 2.14 km look distance with a 2.72 km
span it left `w = 0.16`, so detail was visible only below about 200 m --
which is exactly how the bug was reported. Distance is the LOD's job and
`textureLod`'s; the border fade alone hides the seam.

**Texture LOD, and a constant that hid the whole feature.** The mip
level came from `log2(dist * 0.004)`. That 0.004 is `2 * tanHalfY /
height` for a 380px-tall buffer -- correct in the window it was tuned
in, and wrong everywhere else, because a pixel's ground footprint
depends on how many pixels there are. It is now computed:

    uTexelsPerPx = 2 * tanHalfY / drawingBufferHeight
    mip          = log2(dist * uTexelsPerPx) + log2(texturePixelsPerWorldTexel)

The second term is the existing `uImageryLodBias` / `uDetailLodBias`, so
only the first changed. What it was costing, at the default view's look
point:

| buffer | one screen pixel | z17 sampled at, before | after |
|---|---|---|---|
| 380 px | 7.4 m | 8.53 m/px | 8.61 m/px |
| 900 px | 3.1 m | 8.53 m/px | 3.64 m/px |
| 1440 px | 1.9 m | 8.53 m/px | 2.27 m/px |

**8.53 m/px on every screen** -- the base mosaic's own resolution. The
detail layer was fetched at 1.06 m/px and then thrown away by the
sampler, on any buffer taller than the one the constant assumed. Close
to the camera `dist` is small enough that mip 0 is selected regardless,
which is why detail was visible below 200 m and nowhere else; the two
bugs produced the same symptom and had to be found separately.

Sampling at the geometrically correct level rather than a blurred guess
puts the burden back on filtering, so the detail texture now gets the
same anisotropy 8 the base mosaic has always had.

**Cost.** One 2560px ring (1280 on touch) is 100 tiles per refresh,
around 3 MB, on top of the 51 MB base texture -- roughly 105 MB of
texture memory with mipmaps on desktop, 25 MB on touch.

**Debug overlay** (`Tile grid + 1 km rings`, off by default). Two cues,
both from quantities the march already carries, so neither costs a
texture fetch or a second pass:

    vec2 cell = floor(p / tile);
    colour *= 1.0 + amp * (mod(cell.x + cell.y, 2.0) * 2.0 - 1.0);

The checkerboard uses the detail rectangle's tile pitch inside it and the
base mosaic's 128-texel tiles outside, so the rectangle announces itself
as a change of grid pitch. That matters: it shows the rectangle's real
shape -- a square, offset ahead along the view -- which is exactly what a
camera-centred sphere would have misrepresented. Laterally the two
disagree badly: at a 2.41 km look distance the rectangle reaches
+/-1.36 km sideways while a 2.2 km sphere claims 2.2 km.

Range rings mark every kilometre of ray distance, with the switch
distance picked out in cyan. Two details that are not optional:

- **Width scales with distance** (`1.5 * dist * uTexelsPerPx`). A fixed
  world width aliases into a solid sheet towards the horizon.
- **Each band stays over a pixel wide.** The dark core was first drawn
  at `w * 0.6`, about 0.9 px, and aliased into a dashed line. The cause
  was identified by the cyan switch ring sitting right beside it,
  drawn at `w * 1.5` and perfectly smooth -- the difference was width,
  not the hit distance. Step count was the obvious suspect and was
  wrong: rendered at 48 and 256 steps the beading is identical, mean
  run length 3.8 px against 3.9 px. Core is now `w * 1.1`, halo
  `w * 2.4`.
- **Dark core plus light halo**, because a single tint fails on one
  background or the other: white vanishes into bright desert, dark
  vanishes into the sea.
- **Faded out where they crowd**, below about 5 px of screen spacing,
  or the horizon turns into a band that reads as haze rather than scale.

A camera-centred sphere was considered first and rejected. It is trivial
to draw -- every ray starts at the centre, so the intersection
degenerates to `dist > R` -- but it does not correspond to where the
imagery actually changes, and it draws nothing at all when the switch
distance is under the camera's height in marched geometry. Tracing a
line from each tile centre to the camera was also considered: those
lines are view rays, so each projects to a single point.

**Telemetry.** The panel reports the viewing distance, the ground size a
screen pixel covers there, the switch distance in force alongside what
the screen alone would have asked for, and the level and span actually
in use -- which is what makes any of this arguable with numbers rather
than impressions. Stats refresh four times a second.

**Placement.** The rectangle is centred midway between the camera and
the point it is looking at, along the horizontal view direction. Centred
on the camera, roughly half of it sits behind the viewer and does
nothing. The cost is that turning can trigger a refetch, which the
recentre threshold (38% of the span) absorbs for ordinary movement.

### 20.6 Licensing shapes the architecture

This is why imagery is fetched at runtime rather than baked into
`assets/` the way the terrain is.

The terrain tiles are open data with no key. Esri's imagery is
proprietary, licensed under Esri's Master License Agreement. Fetching
tiles live is the ordinary usage pattern that every web map follows;
committing a mosaic to a public repository is redistribution, which is a
different thing. Required attribution is composed from whatever is
actually on screen and shown in the panel:

    Source: Esri, Maxar, Earthstar Geographics, and the GIS User
    Community · Powered by Esri

If a bakeable source is ever wanted, Sentinel-2 cloudless (EOX,
CC BY-NC-SA, 10 m/px) or USGS Landsat (public domain, 30 m/px) carry
licences that permit it.
