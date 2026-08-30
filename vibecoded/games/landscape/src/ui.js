// Binds the panel's plain HTML inputs to one settings object.

export const DEFAULTS = {
    retro: false,
    terrainFollow: true,
    renderScale: 1.0,
    drawDistance: 1200,
    fogDensity: 0.0012,
    sunAzimuth: 135,
    sunElevation: 45,
    fov: 75,
    maxSteps: 256,
};

// Retro mode has no fog, so it needs the original's near horizon --
// otherwise the terrain just ends in mid-air a long way off. Modern
// mode wants the fade much further out. Each remembers its own value.
const RETRO_DRAW_DISTANCE = 300;

const FORMAT = {
    renderScale: (v) => `${Math.round(v * 100)}%`,
    drawDistance: (v) => `${v}`,
    fogDensity: (v) => v.toFixed(4),
    sunAzimuth: (v) => `${v}°`,
    sunElevation: (v) => `${v}°`,
    fov: (v) => `${v}°`,
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

        for (const key of ['retro', 'terrainFollow']) {
            const el = document.getElementById(key);
            el.checked = settings[key];
            el.addEventListener('change', () => {
                settings[key] = el.checked;
                if (key === 'retro') this.applyMode();
                onChange(key);
            });
        }
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
        for (const key of ['retro', 'terrainFollow']) {
            document.getElementById(key).checked = this.settings[key];
        }
    }

    show(key) {
        document.getElementById(`${key}-v`).textContent =
            FORMAT[key](this.settings[key]);
    }

    toggle() { this.panel.hidden = !this.panel.hidden; }

    update(fps, camera, width, height) {
        this.stats.innerHTML =
            `<b>${fps.toFixed(0)}</b> fps &nbsp; ${width}×${height}<br>` +
            `x <b>${camera.x.toFixed(0)}</b> ` +
            `y <b>${camera.y.toFixed(0)}</b> ` +
            `alt <b>${camera.z.toFixed(0)}</b>`;
    }
}

export function fail(title, body) {
    document.getElementById('error-title').textContent = title;
    document.getElementById('error-body').textContent = body;
    document.getElementById('error').classList.add('shown');
    document.getElementById('panel').hidden = true;
    document.getElementById('hint').hidden = true;
}
