# Stage 1 — global flight

Design for making the terrain window follow the camera, so the world is
unbounded rather than a fetched rectangle. Written before the code
because this is the first change that reorganises how the pieces fit.

**Status: built, with one premise reversed.** Everything here shipped,
and then zoom-from-speed was turned off by default. It works, but zoom
also sets `reliefScale`, so every level it shed changed how tall the
world looked; capping the top speed at Mach 10 instead lets a fixed
window keep up on its own. The mechanism is intact behind `Lock zoom`
and `?lock=0`. Sections below are marked where the implementation
diverged.

The load-bearing idea is the user's: **make zoom a function of speed.**
It replaces the coarse fallback layer rather than complementing it. A
clipmap's coarse level exists to cover the horizon while the fine window
streams; if the window's own zoom widens with speed, the same texture
covers the horizon and there is only ever one terrain layer.


## 1. Speed, in metres

Today's speeds are texel-relative and inherited from 2010, when the
world was 1792 texels of 1 m:

    v_cruise = ACCEL * DAMPING_TAU = 900 * 0.15 = 135 texels/s
    v_boost  = 4x that             = 540 texels/s

At 19 m/texel that is **2.3 km/s cruising and 9.2 km/s boosted** —
Mach 27. No streaming system can keep up with that, and it is the real
reason global flight looks hard.

Speeds become metres per second, converted through `metresPerTexel`. A
`Speed` slider sets cruise, 30 m/s by default; holding forward winds a
ramp up on top of it, and Shift multiplies by four inside the ceiling.
Datasets with no real-world scale (the 2010 map, `metresPerTexel ===
null`) keep the old constants, because their metres are arbitrary.

**As built**, the ramp is two-phase with a hard ceiling:

| held forward | speed |
|---|---|
| 1.9 s | Mach 1 |
| 4.4 s | Mach 2 |
| 7.6 s | Mach 5 |
| 10 s | Mach 10 — the ceiling |

Mach 10 rather than Mach 27 is what makes §2 optional rather than
mandatory. 3.43 km/s across a 98 km window is 31 s to cross and a
refetch every 15 s, which a *fixed* zoom can serve. The ceiling is what
lets the zoom stand still.


## 2. Window zoom from speed

Choose the zoom so the window is always a fixed **time to cross**:

    coverage(z) = tiles * 256 * 156543 * cos(lat) / 2^z
    wanted      = max(vSmooth * T_CROSS, MIN_COVERAGE)      T_CROSS = 60 s
    zoomF       = log2(coverage(zRef) / wanted) + zRef
    zoom        = clamp(floor(zoomF), 4, maxZoom)

As built: `floor`, not `round`, because coverage must be at least what
was asked for; the floor is z4, where sixteen tiles span the planet; and
the ceiling is the `Terrain zoom` setting, z12 by default, rather than a
constant 13.

At 12 tiles on the equator:

| speed | 60 s of flight | zoom | coverage |
|---|---|---|---|
| 30 m/s | 1.8 km | z13 (capped) | 59 km |
| 200 m/s | 12 km | z13 | 59 km |
| 2.3 km/s | 138 km | z11 | 235 km |
| 9.2 km/s | 552 km | z9 | 939 km |

Streaming then delivers at most one window a minute at any speed.

**All of which is now optional.** `Lock zoom` is on by default and skips
this whole mechanism: the window holds `liveZoom` however fast you fly.
Zoom-from-speed cost a change of vertical scale every time it fired,
because zoom also sets `reliefScale` (see §5), and with the speed
ceiling at Mach 10 the fixed window keeps up anyway. `?lock=0` puts the
ladder back, and the numbers above are what it does.

`MIN_COVERAGE` is not a constant. A flat 20 km floor never bound at
twelve tiles -- the window is 98 km -- but it bound hard once the tile
count became a panel control: a 2x2 window is 16 km, so the floor would
have dragged it a zoom level coarser on its first move, having booted at
the zoom that was asked for. It is now `drawDistance * mpt * 2`: a
window must hold at least twice what is drawn in it, whatever size it
is. At twelve tiles that is 77 km against a 98 km window, so it still
never binds and nothing about the old behaviour changes.

One trap in that, found the hard way: on a *resize* the draw distance in
`settings` is still the outgoing window's, because it is re-derived only
once the new window exists. Pairing it with the incoming tile count made
a 12x12 -> 4x4 switch measure four tiles against a twelve-tile view,
conclude they could not hold it, and drop two zoom levels -- which
multiplied `reliefScale` by four and rendered every mountain four times
too tall. The floor has to be fed the draw distance that will be in
force *after* the move.

`vSmooth` is an exponential average with a 3 s time constant, not the
instantaneous speed: tapping boost must not launch a 144-tile fetch.
Zoom is held unless the wanted level differs by more than 0.6, the same
hysteresis shape the imagery rings use.

**z13 is where SRTM stops adding relief** — measured at 0.1-0.4 m RMS
from z13 to z14 over Chile. Regions on national lidar could go further;
that is a per-region ceiling to detect, exactly as the imagery ceiling
is detected. The shipped default is a level below that, z12: a coarser
window doubles the ground covered for the same 144 tiles, which buys
continuity and load time against detail only visible when nearly
stationary.


## 3. Relocation, and why same-zoom moves are free

**The rule is one inequality: the gap from the camera to the nearest
window edge must stay above the draw distance.** Cross it and the ray
march walks off the end of the mosaic, where `heightAt` has nothing to
return but sea level -- a flat plane, under a radial smear of the last
row of imagery texels, since the imagery is `CLAMP_TO_EDGE`. That is
what "the end of the heightmap" looks like from altitude (19.4).

So a new window is fetched when an edge comes within the draw distance
plus however far the camera will travel while the fetch is in flight,
or when the speed-derived zoom changes. It is centred ahead along the
velocity, not on the camera, for the same reason the imagery rectangle
is -- but the lead is capped, because leading ahead buys runway in front
by spending exactly as much behind.

Both halves of that used to be fractions of the window that knew nothing
about the draw distance, and the fractions were larger than the budget:

| | texels | km at z12, lat -33 |
|---|---|---|
| half-window | 1536 | 49.2 |
| draw distance | 1200 | 38.5 |
| **margin: everything the camera has to play with** | **336** | **10.8** |
| old trigger (`keep = 0.5`) | 768 | 24.6 |
| old lead (`0.25 * size`) | 768 | 24.6 |

The trigger waited for more than twice the margin, and the lead spent
more than twice the margin again. The second is the sharper failure: a
lead of 768 texels drops the camera 768 texels behind the centre of the
window it just fetched, so the trailing edge is 768 texels away against
a 1200-texel view. **Every fresh window was born with an edge inside the
frame** -- no speed and no altitude required, only a glance backwards.
Altitude is merely what removes the relief that was hiding it.

Measured over the same 120 s run, Vina to Argentina at Mach 9: the old
constants put the view past the data on a roughly 15 s sawtooth even
with every tile already cached, because the failure is structural rather
than a matter of bandwidth. Standing the trigger and the lead off the
draw distance instead holds the edge at 38-48 km against a 38 km view
for the length of the flight, and gives way only when an individual
fetch stalls (see §3.1).

### 3.1 What a move costs, and the ceiling that leaves

A move used to refetch the whole mosaic. It no longer does: at the same
zoom the two windows are cut from the *same* slippy grid, so the shift
is a whole number of tiles, the overlap blits across exactly, and only
the newly exposed edge is fetched (`carriedTiles`). Measured on two
equivalent two-tile steps off one cold window over the Alps -- 144 tiles
in 22.1 s the old way against 54 in 10.5 s carrying the overlap, with
the two mosaics identical across all 9,437,184 pixels. In flight at Mach
9 a move is typically **12 new tiles and 132 kept, in about a second**.

It is worth being exact about what that does and does not buy, because
the margin is small in *time*. At Mach 9 the whole 10.8 km margin is
3.6 seconds of flight. A one-second move fits inside it comfortably; a
fetch that stalls to seven or eight seconds does not, and the view does
run past the data until the next window lands. That is a data rate, not
a policy: no trigger can start a fetch earlier than the moment the
camera enters the margin. Raising it means a wider window in ground
terms -- more tiles, or the coarser zoom that unchecking **Lock zoom**
restores, which is the escape hatch the speed-driven `windowZoom` was
built to be (§2).

The fetch is double-buffered: the old window keeps rendering, and the
new one is swapped in complete. On swap, everything holding world
coordinates is rebased. World texels relate to a global slippy grid by

    G = tileOrigin * 256 + p

so converting between windows, including across zooms, is

    p_new = (tileOrigin_old * 256 + p_old) * 2^(z_new - z_old)
            - tileOrigin_new * 256

which applies to `camera.x/y`, to each imagery ring's `origin`, and —
because a texel changes size — as a scale factor `k = 2^(z_new - z_old)`
on ring `span` and on the horizontal velocity.

**Not on `camera.z` or `clearance`**, and this design got that wrong.
The vertical axis does not scale with zoom: a height in rendered texels
is `metres / mpp * 2^(13 - zoom)` and `mpp` goes as `2^-zoom`, so the
two cancel and a 1000 m peak is 58.78 texels tall at every level (§5).
Scaling `z` by `k` as well left the terrain at its height while pulling
the camera down to half its clearance on every zoom-out — 500 m over a
peak became 250, then 125, then 63 — which reads as the vertical scale
drifting off whatever the slider says, every time a new heightmap
loads. Rebase horizontally only.

**A same-zoom shift is seamless by construction.** `k = 1`, and the
overlapping tiles are byte-identical, so the ground does not move at
all. Only a zoom change alters geometry, and it only happens when the
speed changed enough to warrant it — which is to say, while moving fast
enough for the change to be masked.

On a zoom change the imagery rings are disposed rather than rescaled.
They re-centre from camera position anyway, and rescaling a rectangle
mid-flight is a subtle-bug generator for no gain.

In-flight loads are discarded by bumping the generation counters that
already exist.


## 4. Capping the imagery rings by speed

A ring is only worth fetching if it survives long enough to be looked
at. Its span is fixed by its level; loading it takes a measured 1.83 s
for 100 tiles:

    speedF = metaZoom + log2(tiles * 256 * mpp / (v * MARGIN * T_load))

with `MARGIN * T_load` about 5 s. Then

    zoomF = min(asked, reachF, speedF)

as a third continuous cap alongside the reach cap, so the hysteresis
keeps comparing like with like. What it produces:

| speed | finest ring worth loading |
|---|---|
| 30 m/s | no cap (z17) |
| 2.3 km/s | z15 |
| 9.2 km/s | rings off entirely |

At 2.3 km/s a z17 rectangle is crossed in 1.3 s against a 1.83 s load:
it is stale before it arrives. The cap states that arithmetic rather
than discovering it as jitter.


## 5. Files

As built:

| file | change |
|---|---|
| `camera.js` | speeds in m/s via `metresPerTexel`; smoothed speed exposed; two-phase ramp to a Mach 10 ceiling |
| `ui.js` | `Speed` and `Lock zoom` controls; defaults. Window size is a setting, not a control -- `?tiles=` |
| `terrain-window.js` | new, and **pure** — zoom, coverage, rebase, placement predicates, no GL, no DOM, no fetch, so the coordinate maths can be tested in node |
| `terrain-tiles.js` | new — terrarium tiles into a height mosaic, with a retry |
| `imagery.js` | `speedF` cap; a locked level; base carry-over across moves |
| `main.js` | wiring; `moveWindow` does fetch, swap and rebase |
| `terrain.frag` | a second ring, a debug overlay, and the LOD in texels-per-pixel |

The shader's *world model* not moving is the point: the window is still
a single R16F texture spanning `[0, size]`, with sea outside it. The
camera simply never reaches the edge any more. What did change in the
shader is all imagery and debug work, none of it about the heightfield.


## 6. Verification

- **Rebasing round-trip**: transform camera and rings across a synthetic
  shift and a zoom change; assert reported lat/lon is unchanged to
  within a texel. Pure computation, no browser. *Done* — worst error
  0.00e+0 m, in `tools/test-window.mjs`.
- **Zoom ladder**: assert the speed-to-zoom table above, in node,
  against the real function. *Done*, alongside a coverage-outlasts-
  `T_CROSS` invariant and the placement predicates.
- **Vertical invariance**: assert rendered height is the same at every
  zoom, and that a zoom change does not move the camera vertically.
  *Done*, and added only after the bug in §3 shipped.
- **Window sizes**: assert every tile count `?tiles=` accepts holds its
  zoom at rest, and that a resize does not ratchet the zoom downward.
  *Done.*
- **Seamlessness**: capture a frame either side of a same-zoom swap and
  assert the images are *pixel-identical*. This is the strongest test
  available and it should pass exactly, not approximately. **Not done**
  — it needs a swap staged mid-world, which the headless harness cannot
  arrange.
- **Fetch budget**: fly a scripted path at each speed tier and count
  window fetches; expect roughly one per `T_CROSS`. **Not done** —
  driving sustained flight headlessly did not work; the software
  rasteriser plus virtual time never advanced the acceleration ramp.


## 7. Not in this stage

- Toroidal window updates (upload only newly exposed rows). The
  double-buffered full fetch is simpler and, at one window a minute,
  fast enough. Still true, and the cheap half of it is now the obvious
  next step: the imagery base already carries its overlap across a move
  with `copyTexSubImage2D` and skips the tiles it kept, and terrain
  could do the same. A typical move keeps 33-50% of its tiles.
- Decoding in a worker. 144 tiles is ~9.4M pixels and will hitch on
  swap; measure it first, since it happens once a minute rather than
  once a frame. Still unmeasured, and now the leading suspect for the
  worst hitch in the page: `decodeHeights` does `getImageData` over the
  whole mosaic and then a 9.4M-iteration loop, on the main thread.
- A per-region terrain ceiling above z13. The imagery has one, detected
  by probing for Esri's placeholder tile; terrain has no equivalent
  because there is no placeholder to probe for.
- Despiking. The offline tool replaced pixels standing clear of every
  neighbour with the neighbour median; the runtime path never gained it.
  Measured zero spikes over Caldera at 7x7 and 16x16, but the runtime
  path now covers the whole world and the whole world has not been
  checked.
