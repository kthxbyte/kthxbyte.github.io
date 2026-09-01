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

The panel's readout gives the live numbers behind the level of detail:
altitude, viewing distance, the ground a screen pixel covers there, the
switch distance in force next to what the screen alone would ask for,
and the imagery level and span in use.

**Wind** adds drone-like drift: a slow attitude wobble, a slower
positional sway, and a gust envelope that swells both. It sways the view
only -- your position and heading are untouched, so it never blows you
off course and never disturbs the imagery level of detail. At 0 it is
skipped entirely.

The sun is set by compass bearing (0 = north, 90 = east). Caldera sits at
latitude -27, so its light comes from the north.
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

## Terrain

Two datasets, switchable in the panel.

**Caldera, Atacama** (default) is real elevation, 30.5 km of the
Chilean coast around Caldera at 17 m per texel, sea level to 952 m.
Position is reported as real latitude, longitude and altitude in metres.
Regenerate it, or fetch anywhere else, with:

    python3 tools/fetch-terrain.py --lat -27.0678 --lon -70.8231 --zoom 13

Zoom 13 is deliberate. Measured against a bilinear upsample of the level
above it, z13 adds ~5 m RMS of genuine detail here while z14 adds
0.1-0.4 m -- nothing. The underlying source is SRTM. Regions covered by
national lidar (the US, via 3DEP) keep gaining real detail to z14-15, so
the useful ceiling is a property of the region, not of the tileset.

Real terrain is much gentler than the synthetic map -- 957 m of relief
over 30 km is 56 texels at true scale, against the 2010 map's 249 -- so
a **vertical scale** control exaggerates it. The default is 3x. Heights
are held in a float texture, so there is no 0-255 ceiling to clip
against.

**Satellite imagery** drapes Esri World Imagery over the elevation.
Esri's tiles use the same Web Mercator grid as the terrain tiles, so
they register pixel-for-pixel with no reprojection -- measured alignment
against the elevation-derived coastline is dx=0, dy=0. Because the grids
nest, the imagery is taken one zoom finer than the terrain: z14, 8.5 m
per pixel over 17 m terrain, a 3584px mosaic of 196 tiles (~1.3 MB).
Touch devices stay at z13 to keep the texture a quarter of the size.
Turn it off and the hypsometric elevation colouring comes back.

Detail is not capped at that, though. A second, smaller imagery texture
follows the camera at a zoom picked from **how far away the terrain being
looked at is** -- not from altitude, which is only the same thing when
the camera points straight down -- cross-fading into the base at its
edges and with distance. Fly low and roads and tracks
resolve; climb and it steps back down, then switches off once the base
is enough. The panel reports the level in use.

**Detail switch** sets the distance at which the finest level gives way
to the next one down; every band below and above it follows by halving
and doubling. Set it to 2.2 km and anything you look at inside 2.2 km
gets z17, out to 4.4 km z16, and so on. The screen-derived figure (shown
as `auto`) is where finer imagery stops being *resolvable*, which is not
the same as where it stops being *worth fetching* -- so the slider
defaults to 2.2 km, well past it.

**Tile grid + 1 km rings** is a debug overlay: alternate imagery tiles
are tinted, so tile size against distance is visible and the detail
rectangle shows up as a change of grid pitch, and range rings mark every
kilometre with the switch distance in cyan. Off by default, `?grid=1`
to pin it.

The slider runs to 8 km, and its upper end means *the finest level whose
rectangle can cover what you are looking at*: the rectangle is finite,
reaching 2.42 km at z17, 4.85 km at z16 and 9.69 km at z15 (half that on
touch). When reach rather than the slider decides, the readout says
`rect-limited`.

Note that **vertical scale moves the levels**. Heights are exaggerated
but horizontal distance is not, so at the default 2.5x a camera reading
500 m is looking 5.5 km at real ground when it looks near-level -- far
enough that the base mosaic is already as fine as the screen resolves.
z17 arrives from about 28 degrees down at 2.5x, 38 degrees at 3x, and
straight away at 1x, where a readout of 500 m means the camera really is
500 m up in the geometry the rays march. Fly lower, look down, or turn
the exaggeration down.

Three bugs used to hide all of this. The shader faded the detail layer
out with distance, on reasoning left over from an earlier
altitude-driven version; the texture LOD used a constant that assumed a
380px-tall window, so on a normal screen the detail layer was sampled at
the base mosaic's own resolution; and the layer's height input divided
the vertical exaggeration back out, which placed the rectangle at a
third of the distance it needed and left every pixel on screen outside
it. Between them, detail was only ever visible below about 200 m.

How far it can go depends on the region. Beyond its high-resolution
coverage Esri serves a flat grey "Map data not yet available"
placeholder rather than an error, so the demo probes one tile before
loading a level and walks the ceiling down until it finds real imagery.
At Caldera that ceiling is **z17, 1.06 m/px**; z18 and up are
placeholders.

The imagery is fetched **at runtime**, not shipped in `assets/`. The
terrain tiles are open data; Esri's imagery is not -- it is licensed
under Esri's Master License Agreement. Fetching tiles live is the
ordinary usage pattern that every web map follows, but caching a mosaic
into a published repository would be redistribution.

**Original 2010 map** is the synthetic heightmap the demo shipped with,
unchanged.

Elevation data: Tilezen terrain tiles via AWS Open Data, no API key
required. Imagery: Esri, Maxar, Earthstar Geographics and the GIS User
Community. Attribution for both is required and is shown in the panel;
see
`assets/terrain-*.json` and
<https://github.com/tilezen/joerd/blob/master/docs/attribution.md>.

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

`?x=&y=&z=&yaw=&pitch=&retro=&scale=&steps=&dist=&detail=&grid=&wind=&fov=&touch=&terrain=&vs=&hud=`
pin the camera and render settings from the URL, which is what makes
screenshots reproducible. `hud=0` strips the overlay.

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
    tools/fetch-terrain.py  real elevation tiles -> mosaic + metadata
