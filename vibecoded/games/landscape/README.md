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

**Roam** streams the terrain window as you fly, so the world is
unbounded rather than a fetched rectangle. Turn it off to stay in one
window. The next window is started as soon as an edge comes within the
draw distance — plus however far you will travel while it is fetched —
so the view does not reach past the data. Only the newly exposed tiles
are downloaded; the overlap is copied out of the outgoing mosaic, which
in flight makes a move about 12 new tiles rather than 144. The HUD shows
both: `edge 42 km vs 38 km of view · last move 12 new + 132 kept`. If
`edge` ever drops below the view it says **past the data**, and what you
are seeing beyond that distance is a flat plane rather than terrain.

With **Lock zoom** off, the window's zoom follows your speed and is
always sized to take about a minute to cross, so fetching keeps up at
any speed: z13 over 60 km flying slowly, z11 over 235 km at 2 km/s. With
it on — the default — the window holds its zoom and the speed ceiling
does that job instead. At Mach 9 the whole margin between the view and
the window edge is about 3.6 seconds of flight, so a fetch that stalls
will briefly show the edge; unlocking the zoom is the way to buy more
ground.

**Speed** sets the cruise, in metres per second on real terrain: 30 m/s
is a brisk drone, and it is what you move at with no key held. Hold
forward and the camera winds up — hard below the speed of sound, then
more gradually above it:

| held for | speed |
|---|---|
| 1.9 s | Mach 1 |
| 4.4 s | Mach 2 |
| 7.6 s | Mach 5 |
| 10 s | **Mach 10** — the ceiling |

Shift boosts by four and reaches the ceiling in about 5 s, but does not
raise it: Mach 10 is the top speed, not a number the boost key walks
past. Let go and the wind-up decays in a second and a half. The 2010 map
keeps its original texel-relative speed and its old single-phase ramp,
since its metres are arbitrary and it has no Mach to speak of.

The sun is set by compass bearing (0 = north, 90 = east). The default
view sits at latitude -33, so its light comes from the north.
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

Two kinds of dataset, switchable in the panel: sixteen real-world
presets fetched from the tileset, and the synthetic 2010 map.

**Viña del Mar, Chile** (default) opens on Valparaíso Bay: 69 m of water
under the camera, the curve of the coast ahead, the city on the flat and
the hills behind it climbing to 300 m in six kilometres. It is fetched
from the tileset when the page loads like every other place. Position is
reported as real latitude, longitude and altitude in metres. Nothing is
baked: pick another preset, type a lat/lon, or pass `?lat=&lon=&tz=`.

Preset coordinates place the camera exactly. They used to be rounded to
the containing tile's north-west corner -- up to 8.2 km at z12, which is
invisible over a broad landscape and very visible on a coastline, where
it is the difference between open water and halfway up a hill.

Zoom 12 is the default window and the finest the roamer will pick;
`?tz=` moves it, and `windowZoom` clamps to the range z4-z13. Zoom 13 is
where the data stops. Measured against a bilinear upsample of the level
above it, z13 adds ~5 m RMS of genuine detail here while z14 adds
0.1-0.4 m -- nothing. The underlying source is SRTM. Regions covered by
national lidar (the US, via 3DEP) keep gaining real detail to z14-15, so
the useful ceiling is a property of the region, not of the tileset.

Real terrain is much gentler than the synthetic map -- 957 m of relief
over 30 km is 56 texels at true scale, against the 2010 map's 249 -- so
a **vertical scale** control exaggerates it. The slider defaults to
1.0x. Heights are held in a float texture, so there is no 0-255 ceiling
to clip against.

The slider is not the whole exaggeration, though. Relief measured in
texels vanishes as the window zooms out -- a texel is 17 m at z13 but
2.4 km at z6, which would leave Everest three texels tall in a
3000-texel world and render the planet as a plate -- so the engine also
applies `2^(13 - zoom)`, holding relief-in-texels constant across window
zooms. Total exaggeration is the slider times that, so the default 1.0x
is 2x over a z12 window and 1x over a z13 one, and the slider keeps
meaning "how exaggerated" rather than "how exaggerated at z13". The
consequence worth knowing: **anything that changes the window's zoom
changes how tall the mountains look**, which is why the window-size
control is careful not to.

Put the other way round, rendered height is *zoom-invariant*: a 1000 m
peak is 58.78 texels tall at z13, z12, z11 and z6 alike, because
`metres / mpp` and `2^(13 - zoom)` cancel. That is what the exaggeration
buys, and it is why a window move rebases horizontally only -- the
camera's height above the ground is in units the zoom does not touch.

**Satellite imagery** drapes Esri World Imagery over the elevation.
Esri's tiles use the same Web Mercator grid as the terrain tiles, so
they register pixel-for-pixel with no reprojection -- measured alignment
against the elevation-derived coastline is dx=0, dy=0. Because the grids
nest, the imagery would like to be one zoom finer than the terrain.

Whether it gets to be depends on the window, and over the default window
it does not. The mosaic spans the whole terrain extent, so its side is
`tiles * 256 * 2^step` pixels, and that is capped at 4096. At twelve
tiles the finer step would need 6144 px, so it is refused and the base
falls back to the terrain's own zoom -- **z12, 32 m/px**. Eight tiles or
fewer fit, and get z13 at 16 m/px. Touch devices always stay at the
terrain's zoom.

That 32 m/px base is why there are two detail rings rather than one; see
**Lock zoom** below. Turn imagery off and the hypsometric elevation
colouring comes back.

Detail is not capped at that. Two smaller imagery textures follow the
camera, cross-fading into the base at their edges and into each other
where they overlap, finest last. The panel reports both:

    inner z17 - 1.00 m/px -  2.6 km wide
    outer z15 - 4.01 m/px - 10.3 km wide

With **Lock zoom** on, which is the default, those levels are fixed. Off,
they are picked from **how far away the terrain being looked at is** --
not from altitude, which is only the same thing when the camera points
straight down -- and step down as you climb, switching off once the base
is enough.

**Detail switch** is the knob for that unlocked mode: the distance at
which the finest level gives way to the next, with every band below and
above following by halving and doubling. Set it to 2.2 km and anything
inside 2.2 km gets z17, out to 4.4 km z16, and so on. The screen-derived
figure (shown as `auto`) is where finer imagery stops being *resolvable*,
which is not the same as where it stops being *worth fetching*, so the
slider defaults to 2.2 km, well past it. **Locked, this slider does
nothing** -- the readout replaces it with the lock's own reach.

**Lock zoom** holds both ladders still, and is on by default. The
terrain window stays at its chosen zoom however fast you fly, and
imagery detail stays at z17 however far you look. Nothing about the
world's scale or sharpness changes under you.

It is a trade, not a free win, and the readout names the price: `reach`.
A 2560 px rectangle at z17 spans 2.7 km and serves to about 2.3 km, and
past that there is no coarser ring to step down into -- that is what
locking gives up. When the point you are looking at is beyond it, the
readout says `looking past it`.

Which is why there are **two rings**, not one: z17 for the near ground
and z15 beneath it, four times the span at a quarter the sharpness.

| ring | m/px | serves to |
|---|---|---|
| z17 | 1.00 | 2.3 km |
| z15 | 4.01 | 9.1 km |
| base mosaic | 32.05 | everywhere |

The base is the number that makes the second ring necessary. Over a
twelve-tile window the imagery's free zoom step is refused -- 12 x 256 x
2 = 6144 exceeds the 4096 px cap -- so the base is the terrain's own
zoom, 32 m/px. Without a middle ring the frame falls from 1 m/px to
32 m/px in one step at 2.3 km, which does not read as lower resolution
so much as melted. The z15 ring covers the band between, eight times
finer than the base, for 100 tiles and 35 MB.

The terrain half has a cost too, and it is refetch rate. Zoom-from-speed
existed to hold the window at a fixed time to cross -- a minute -- which
a 98 km window manages up to about 1.6 km/s. The top speed is Mach 10,
3.43 km/s, so at full tilt a 12x12 window is crossed in 31 s and
refetched every 15 s: twice the intended rate, comfortably servable, and
the reason the speed ceiling and the locked zoom belong together. Below
about Mach 5 it costs nothing at all. `?lock=0` restores the ladders.

### Window size, at `?tiles=`

How many tiles a terrain window is cut from, 2 to 12 per side. Not a
panel control -- it is a thing you set once and leave, not a thing you
fly with -- but it is the setting with the largest effect on what the
demo costs. At the default latitude, z12:

| | 12x12 (default) | 4x4 |
|---|---|---|
| world | 98 km wide | 33 km wide |
| horizon | 38 km | 13 km |
| height texture | 18 MB | 2 MB |
| tiles at load | 144 + 144 | 16 + 64 |

plus 200 tiles of detail rings either way, since those follow the camera
rather than the window. Smaller windows are refetched more often but
move far less data per kilometre flown.

Two things about that are not monotonic. **8x8 gives a sharper picture
than 10x10**, because the satellite base gets its free zoom step while
`tiles * 512` still fits in a 4096 px texture -- 8 tiles and below get a
16 m/px base, 10 and 12 fall back to 32 m/px. And **8x8 uses more memory
than 12x12** for the same reason: a sharper base is a bigger one.

**Draw distance follows the window** at 100 texels of view per tile,
1200 at 12x12, which is exactly what it has always been. Draw distance
is measured in texels: that is what lets it survive a zoom change
untouched, and for the same reason it cannot survive a change of window
size untouched. Looking further than the window holds is not a rendering
error -- outside it the ground reads as sea level, by design -- but it
does surround the terrain with an ocean that is not there. Move the
slider afterwards and your value stands; pin it with `?dist=`.

**Tile grid + 1 km rings** is a debug overlay: alternate imagery tiles
are tinted, so tile size against distance is visible and the detail
rectangle shows up as a change of grid pitch, and range rings mark every
kilometre with the switch distance in cyan. Off by default, `?grid=1`
to pin it.

The slider runs to 8 km, and its upper end means *the finest level whose
rectangle can cover what you are looking at*: the rectangle is finite,
reaching 2.28 km at z17, 4.56 km at z16 and 9.13 km at z15 over a z12
window (half that on touch, where the rectangle is 1280 px). When reach
rather than the slider decides, the readout says `rect-limited`.

Note that **vertical scale moves the levels**. Heights are exaggerated
but horizontal distance is not, so a camera reading 500 m over a z12
window sits 31 texels up -- the slider's 1.0 times reliefScale's 2 --
and looks at ground correspondingly further away than its metric
altitude implies.
With the ladder locked this no longer gates anything -- z17 is loaded
whatever the pose -- but unlocked, a higher exaggeration pushes the
finest level further down the pitch range. Fly lower, look down, or turn
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
Over Viña del Mar that ceiling is **z17, 1.00 m/px**; z18 and up are
placeholders. It is also what the locked ladder aims at, and the lock
respects it: `min(maxZoom, 17)`, so a region that tops out lower gets its
own ceiling rather than a rectangle of grey.

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
`TERRAIN_ATTRIBUTION` in `src/terrain-tiles.js` and
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

Everything the panel does can be pinned from the URL, which is what
makes screenshots reproducible. Anything pinned here is left alone
afterwards, so a dataset's own defaults cannot overwrite it.

| | |
|---|---|
| pose | `x` `y` `z` `yaw` `pitch` |
| where | `terrain` (`original`, `place:N`), `place` (index or name), `lat` `lon` |
| window | `tiles` (2-12), `tz` (terrain zoom), `roam=0`, `lock=0` |
| imagery | `imagery=0`, `detail` (km), `grid=1` |
| render | `scale` `steps` `dist` `fov` `fog` `vs` `retro` `follow=0` |
| motion | `speed` (m/s), `wind` |
| shell | `touch=0/1`, `panel`, `hud=0` |

`hud=0` strips the overlay, `touch=0` forces the desktop UI on a machine
that reports a touchscreen, and `lock=0` restores the zoom ladders.

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
    src/imagery.js          base mosaic and the two detail rings
    src/terrain-tiles.js    terrarium tiles -> a height mosaic
    src/terrain-window.js   window coordinate maths, pure, no GL or DOM
    src/places.js           the preset locations
    src/wind.js             drone-like view drift
    src/shaders/            the ray march
    tools/convert-assets.py BMP -> PNG (the 2010 assets, one-time)
    tools/test-window.mjs   window coordinate maths, runs in node
