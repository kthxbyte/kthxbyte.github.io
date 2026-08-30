# Landscape — WebGL

A browser re-implementation of the 2010 SDL voxel-space landscape demo
that sits in the parent directory. Same terrain, same textures; the
renderer is a WebGL2 fragment shader instead of a CPU inner loop.

## Running it

This will not work by double-clicking `index.html`: browsers block
`file://` access to the shaders and textures. Serve the folder:

    cd html
    python3 -m http.server 8000

then open <http://localhost:8000/>.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | move along the view direction |
| mouse | look (click the view to capture the pointer, `Esc` releases) |
| `Space` / `Ctrl` | ascend / descend |
| `Shift` | boost |
| wheel | field of view |
| `H` | hide the settings panel |

On a touch device the page switches to a movement joystick plus
drag-anywhere to look, with buttons for altitude, the settings panel,
and tilt.

**Tilt look** (`◎`) steers the view with the device orientation
sensors, and `⌖` re-centres — it takes however you are holding the
phone right now as level. Two things to know: iOS only grants the
sensors from a tap, which is why it is a button rather than automatic;
and the sensors only work in a secure context, so a plain
`http://192.168.x.x` address on your LAN will not get readings. Use
HTTPS or a tunnel to try it on a real phone.

## The two modes

**Modern** is the default: filtered textures, slope-based sun
lighting, distance fog fading into the sky panorama, and a correct
square-pixel perspective.

**Retro** reproduces the 2010 image: nearest-neighbour palette
sampling, no lighting, no fog, a hard horizon at the draw distance, and
the white sky the original got from clearing the screen to palette
index 255. It also reproduces the original's anamorphic projection —
its vertical focal length was 75px against a horizontal 92.4px, so the
image is squashed vertically by a factor of 1.232.

## Assets

`assets/*.png` are generated from the original BMPs by
`tools/convert-assets.py`, and are committed so that running the demo
needs no build step. Re-generate with:

    python3 tools/convert-assets.py

The heightmap's palette is a grayscale ramp, so a pixel's value is its
terrain height directly; the script asserts this rather than assuming
it. The sky strip is lightly blurred to remove 8-bit dithering that
reads as speckle at full screen size. The terrain texture is left
exactly as it was — there the dithering is the look, and retro mode
needs the palette colours intact.

## Notes on the port

The original's two defining optimisations do not survive the move to a
GPU, and shouldn't: the per-column high-water mark (`lasty[]`) and the
per-depth-step projection lookup table both exist to let one CPU fill
320x240 at 30fps. Here every fragment marches its own ray.

Two things did carry over. The step size grows with distance, which is
the same reasoning as the original's `d += 1 + (d >> 6)`. And the
growth rate is solved on the CPU so the step budget always spans the
draw distance — picking it by hand meant far rays quietly ran out of
steps and returned sky instead of terrain.

The original wrapped the world at `heightmap->w - 1` = 1791. The
heightmap actually tiles seamlessly at 1792, so that left a
one-column seam. Not reproduced.

`?x=&y=&z=&yaw=&pitch=&retro=&scale=&steps=&dist=&fov=&touch=` pin the
camera and render settings from the URL, which is what makes
screenshots reproducible.

## Layout

    index.html              canvas, panel markup
    src/main.js             boot, asset load, frame loop
    src/renderer.js         WebGL2 context, uniforms, draw
    src/camera.js           pose, integration, terrain-follow
    src/input.js            keyboard, pointer lock, wheel
    src/touch.js            movement joystick, drag-to-look
    src/tilt.js             device-orientation look
    src/ui.js               settings panel
    src/gl.js               shader/texture helpers
    src/shaders/            the ray march
    tools/convert-assets.py BMP -> PNG
