// Binds the panel's plain HTML inputs to one settings object.

export const DEFAULTS = {
    terrain: 'caldera',
    imagery: true,
    detailDistance: 2.2,   // km; where imagery detail steps down a level
    vertScale: 2.5,
    retro: false,
    terrainFollow: true,
    renderScale: 1.0,
    drawDistance: 1200,
    fogDensity: 0.0012,
    sunAzimuth: 135,
    sunElevation: 45,
    fov: 75,
    wind: 0.20,        // drone-like view drift, 0 disables it entirely
    maxSteps: 256,
    debugGrid: false,
    liveTiles: 12,     // tiles per side when fetching terrain at runtime
    liveZoom: 13,      // z13 is where SRTM stops adding real relief
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

        for (const key of ['retro', 'terrainFollow', 'imagery', 'debugGrid']) {
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
        for (const key of ['retro', 'terrainFollow', 'imagery', 'debugGrid']) {
            document.getElementById(key).checked = this.settings[key];
        }
    }

    show(key) {
        document.getElementById(`${key}-v`).textContent =
            FORMAT[key](this.settings[key]);
    }

    toggle() { this.panel.hidden = !this.panel.hidden; }

    update(fps, camera, width, height, terrain, detail, lod) {
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
        const alt = camera.z / this.settings.vertScale * mpp;
        const ground = camera.groundAt(camera.x, camera.y)
                     / this.settings.vertScale * mpp;
        const { lat, lon } = terrain.latLon(camera.x, camera.y);
        const km = this.settings.drawDistance * mpp / 1000;
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
        const switchLine = lod
            ? `<br>switch @ <b>${(lod.threshold / 1000).toFixed(2)} km</b>` +
              (lod.limited ? ' (rect-limited)' : '') +
              ` · auto ${(lod.auto / 1000).toFixed(2)} km`
            : '';
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
            `view <b>${km.toFixed(1)} km</b> · ${mpp.toFixed(1)} m/texel` +
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
