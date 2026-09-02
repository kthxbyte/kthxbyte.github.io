// Binds the panel's plain HTML inputs to one settings object.

export const DEFAULTS = {
    terrain: 'place:0',   // Vina del Mar, fetched like anywhere else
    imagery: true,
    detailDistance: 2.2,   // km; where imagery detail steps down a level
    vertScale: 1.0,
    retro: false,
    terrainFollow: true,
    renderScale: 1.0,
    drawDistance: 1200,
    fogDensity: 0.0012,
    sunAzimuth: 135,
    sunElevation: 45,
    fov: 75,
    wind: 0.20,        // drone-like view drift, 0 disables it entirely
    // Cruise speed, held as log10(metres per second) so one slider spans
    // a drone and a missile without the useful end being a hair's width.
    speedLog: Math.log10(30),
    maxSteps: 256,
    debugGrid: false,
    roam: true,        // let the terrain window follow the camera
    // Tiles per side when fetching terrain at runtime. No longer a panel
    // control: the trade it makes is real but it is a thing you set once
    // and leave, not a thing you fly with, so it lives at `?tiles=`.
    liveTiles: 12,
    // z12 by default. z13 is where SRTM stops adding real relief, but a
    // level coarser doubles the ground a window covers for the same 144
    // tiles, which buys continuity and load time against detail that is
    // only visible when nearly stationary.
    liveZoom: 12,
    // Hold both ladders still: the terrain window stays at liveZoom
    // whatever the speed, and imagery detail stays at LOCK_DETAIL_ZOOM
    // whatever the distance. Costs reach and refetch rate; buys a world
    // whose scale and sharpness never change under you.
    lockZoom: true,
};

// Retro mode has no fog, so it needs a near horizon -- otherwise the
// terrain just ends in mid-air a long way off. Modern mode wants the
// fade much further out. Each remembers its own value, and the retro
// distance is per-dataset: 300 texels suits the 2010 map's small world
// but reads as a hard circular cutoff over open sea.
const RETRO_DRAW_DISTANCE = 300;

const FORMAT = {
    vertScale: (v) => `${v.toFixed(1)}x`,
    renderScale: (v) => `${Math.round(v * 100)}%`,
    drawDistance: (v) => `${v}`,
    detailDistance: (v) => `${v.toFixed(2)} km`,
    fogDensity: (v) => v.toFixed(4),
    sunAzimuth: (v) => `${v}°`,
    sunElevation: (v) => `${v}°`,
    fov: (v) => `${v}°`,
    wind: (v) => (v > 0 ? `${Math.round(v * 100)}%` : 'off'),
    speedLog: (v) => {
        const m = 10 ** v;
        return m >= 1000 ? `${(m / 1000).toFixed(1)} km/s` : `${Math.round(m)} m/s`;
    },
};

export class UI {
    constructor(settings, onChange) {
        this.settings = settings;
        this.onChange = onChange;
        this.panel = document.getElementById('panel');
        this.stats = document.getElementById('stats');
        this.savedDrawDistance = { true: RETRO_DRAW_DISTANCE, false: settings.drawDistance };

        for (const key of Object.keys(FORMAT)) {
            const el = document.getElementById(key);
            el.value = settings[key];
            this.show(key);
            el.addEventListener('input', () => {
                settings[key] = parseFloat(el.value);
                if (key === 'drawDistance') {
                    this.savedDrawDistance[settings.retro] = settings[key];
                }
                this.show(key);
                onChange(key);
            });
        }

        for (const key of ['retro', 'terrainFollow', 'imagery', 'debugGrid',
                           'roam', 'lockZoom']) {
            const el = document.getElementById(key);
            el.checked = settings[key];
            el.addEventListener('change', () => {
                settings[key] = el.checked;
                if (key === 'retro') this.applyMode();
                onChange(key);
            });
        }

        const sel = document.getElementById('terrain');
        sel.value = settings.terrain;
        sel.addEventListener('change', () => {
            settings.terrain = sel.value;
            onChange('terrain');
        });
    }

    // The window's own draw distance. Draw distance is measured in
    // texels, which is what lets it survive a zoom change untouched --
    // but not a change of window size: 1200 texels is 39% of a 12-tile
    // window and wider than the whole of a 4-tile one. The shader is not
    // fooled -- heightAt returns sea level outside the window rather than
    // smearing the border -- so the failure is not garbage but phantom
    // ocean: a small island of real terrain ringed by a flat plane that
    // is not there. Retro keeps its own per-dataset value.
    setWindowDistance(d, pinned = false) {
        if (pinned) return;
        this.savedDrawDistance[false] = d;
        if (!this.settings.retro) {
            this.settings.drawDistance = d;
            this.sync();
        }
    }

    setRetroDistance(d, pinned = false) {
        this.savedDrawDistance[true] = d;
        if (this.settings.retro && !pinned) {
            this.settings.drawDistance = d;
            this.sync();
        }
    }

    // Vertical exaggeration only means anything for real elevation data;
    // the 2010 map's heights are already authored at the scale it wants.
    showDataset(terrain) {
        document.getElementById('vertScale-row').hidden = !terrain.procedural;
        document.getElementById('detailDistance-row').hidden = !terrain.procedural;
        document.getElementById('debugGrid').parentElement.hidden = !terrain.procedural;
        document.getElementById('imagery').parentElement.hidden = !terrain.procedural;
    }

    // Attribution is a legal requirement for both data sources, so it is
    // composed from whatever is actually on screen.
    setAttribution(lines) {
        document.getElementById('attrib').textContent = lines.join(' · ');
    }

    applyMode() {
        this.settings.drawDistance = this.savedDrawDistance[this.settings.retro];
        this.sync();
    }

    // Pushes the settings object back into the controls. Needed because
    // settings also change from outside the panel: the URL query, the
    // scroll wheel, and the retro draw-distance swap.
    sync() {
        for (const key of Object.keys(FORMAT)) {
            document.getElementById(key).value = this.settings[key];
            this.show(key);
        }
        for (const key of ['retro', 'terrainFollow', 'imagery', 'debugGrid',
                           'lockZoom']) {
            document.getElementById(key).checked = this.settings[key];
        }
    }

    show(key) {
        document.getElementById(`${key}-v`).textContent =
            FORMAT[key](this.settings[key]);
    }

    toggle() { this.panel.hidden = !this.panel.hidden; }

    update(fps, camera, width, height, terrain, detail, lod, stream) {
        const head = `<b>${fps.toFixed(0)}</b> fps &nbsp; ${width}×${height}<br>`;
        if (!terrain.procedural) {
            this.stats.innerHTML = head +
                `x <b>${camera.x.toFixed(0)}</b> ` +
                `y <b>${camera.y.toFixed(0)}</b> ` +
                `alt <b>${camera.z.toFixed(0)}</b>`;
            return;
        }
        // Real data: report in metres and degrees. The engine works in
        // texels, so altitude is divided back out of the exaggeration.
        const mpp = terrain.metresPerTexel;
        const vs = this.settings.vertScale * (terrain.reliefScale || 1);
        const alt = camera.z / vs * mpp;
        const ground = camera.groundAt(camera.x, camera.y)
                     / vs * mpp;
        const { lat, lon } = terrain.latLon(camera.x, camera.y);
        const km = this.settings.drawDistance * mpp / 1000;
        // Speed and the window it implies. Both move now -- the window's
        // zoom is chosen so it always takes about a minute to cross --
        // so seeing them together is how the streaming makes sense.
        const v = camera.speed * mpp;
        const speedTxt = v >= 1000
            ? `<b>${(v / 1000).toFixed(1)} km/s</b> · mach ${(v / 343).toFixed(0)}`
            : `<b>${v.toFixed(0)} m/s</b>`;
        const win = terrain.meta
            ? ` · window <b>z${terrain.meta.zoom}</b> ${(terrain.size * mpp / 1000).toFixed(0)} km`
            : '';
        // The one number that says whether the streaming is keeping up:
        // how far the nearest edge of the data is, against how far the
        // eye can see. Below the draw distance the march runs off the
        // end of the mosaic and the rest of the frame is the flat plane
        // under a smear of the last row of imagery texels. The move is
        // triggered from exactly this quantity, so watching it is how
        // the trigger is checked.
        const streamLine = !stream ? '' :
            `<br>edge <b>${(stream.gap * mpp / 1000).toFixed(1)} km</b>` +
            ` vs ${km.toFixed(1)} km of view` +
            (stream.gap < this.settings.drawDistance ? ' — <b>past the data</b>'
             : stream.moving ? ' · fetching' : '') +
            (stream.move
                ? ` · last move <b>${stream.move.fetched}</b> new` +
                  ` + ${stream.move.reused} kept · ` +
                  `${stream.move.seconds.toFixed(1)} s`
                : '');
        // Enough numbers to reason about the level of detail: how far
        // away the ground being looked at is, what a screen pixel covers
        // there, and what the layer actually delivers.
        const pitchDeg = camera.pitch * 180 / Math.PI;
        const lookLine = lod
            ? `<br>look <b>${(lod.dist / 1000).toFixed(2)} km</b> ` +
              `@ ${pitchDeg.toFixed(0)}° · need ` +
              `${(lod.dist * (this.settings.fov * Math.PI / 180) / height).toFixed(2)} m/px`
            : `<br>look — @ ${pitchDeg.toFixed(0)}°`;
        // The switch distance is the knob; the auto figure beside it is
        // what the screen alone would have asked for, so the two can be
        // compared while flying. "capped" means the request was larger
        // than the detail rectangle can actually cover.
        // Locked, the switch distance decides nothing, so saying what it
        // would have asked for is noise. Report the lock and the reach
        // instead -- reach is the thing a locked ladder gives up, and it
        // is the number that explains why the far half of the frame is
        // base mosaic.
        const switchLine = !lod ? ''
            : this.settings.lockZoom
                ? `<br>zoom <b>locked</b> · reach ` +
                  `${(lod.reach / 1000).toFixed(2)} km` +
                  (lod.dist > lod.reach ? ' — <b>looking past it</b>' : '')
                : `<br>switch @ <b>${(lod.threshold / 1000).toFixed(2)} km</b>` +
                  (lod.limited ? ' (rect-limited)' : '') +
                  ` · auto ${(lod.auto / 1000).toFixed(2)} km`;
        // One line per clipmap ring. Tile progress matters now that a ring
        // is published before its tiles arrive, so "which level" and "how
        // much of it has landed" are two different questions.
        const ring = (r, name) => {
            if (!r) return `<br>${name} <b>off</b>`;
            return `<br>${name} <b>z${r.zoom}</b> · ` +
                `${r.metresPerPixel.toFixed(2)} m/px · ` +
                `${(r.span * mpp / 1000).toFixed(1)} km wide` +
                (r.loaded < r.total
                    ? ` · <b>${r.loaded}/${r.total}</b> tiles`
                    : (r.seconds ? ` · ${r.seconds.toFixed(1)} s` : ''));
        };
        const rings = detail || [null, null];
        const detailLine = (rings[0] || rings[1])
            ? ring(rings[0], 'inner') + ring(rings[1], 'outer')
            : '<br>detail <b>off</b> — base only';
        this.stats.innerHTML = head +
            `alt <b>${alt.toFixed(0)} m</b> ` +
            `(ground ${ground.toFixed(0)} m)<br>` +
            `<b>${lat.toFixed(4)}°, ${lon.toFixed(4)}°</b><br>` +
            `view <b>${km.toFixed(1)} km</b> · ${mpp.toFixed(1)} m/texel<br>` +
            speedTxt + win + streamLine +
            lookLine + switchLine + detailLine;
    }
}

export function fail(title, body) {
    document.getElementById('error-title').textContent = title;
    document.getElementById('error-body').textContent = body;
    document.getElementById('error').classList.add('shown');
    document.getElementById('panel').hidden = true;
    document.getElementById('hint').hidden = true;
}
