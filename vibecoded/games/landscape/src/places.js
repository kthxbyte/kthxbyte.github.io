// Preset locations for the terrain menu.
//
// Chosen for what this engine is: a heightfield ray marcher with
// satellite imagery draped over it. That favours strong relief with
// sharp edges -- canyons, fjords, volcanic cones, mountains meeting a
// coast -- and it does not favour flat ground, however famous, because
// a heightfield with no height is a photograph on a plane.
//
// `vs` is the vertical exaggeration each place wants. Real mountains
// need none; low coastal relief like Caldera's needs a couple of times
// to read as terrain at all. It is a starting point, not a lock -- the
// slider still moves.
//
// `tiles` sets the window: 12 is about 50 km at mid-latitudes, and the
// same tile count covers less ground the further from the equator you
// go, because Web Mercator.

export const PLACES = [
    { name: 'Grand Canyon, Arizona',   lat:  36.0980, lon: -112.0950, tiles: 12, vs: 1.0, yaw: 1.6 },
    { name: 'Monument Valley, Utah',   lat:  36.9980, lon: -110.0985, tiles: 10, vs: 1.4 },
    { name: 'Jungfrau, Switzerland',   lat:  46.5400, lon:    7.9800, tiles: 10, vs: 1.0 },
    { name: 'Matterhorn, Zermatt',     lat:  45.9950, lon:    7.6800, tiles: 10, vs: 1.0 },
    { name: 'Mount Fuji, Japan',       lat:  35.3606, lon:  138.7274, tiles: 12, vs: 1.0 },
    { name: 'Rio de Janeiro, Brazil',  lat: -22.9450, lon:  -43.2000, tiles: 10, vs: 1.3 },
    { name: 'Hong Kong',               lat:  22.2750, lon:  114.1600, tiles: 10, vs: 1.5 },
    { name: 'Cape Town, South Africa', lat: -33.9600, lon:   18.4100, tiles: 10, vs: 1.3 },
    { name: 'Machu Picchu, Peru',      lat: -13.1631, lon:  -72.5450, tiles: 10, vs: 1.0 },
    { name: 'Milford Sound, NZ',       lat: -44.6414, lon:  167.8974, tiles: 10, vs: 1.0 },
    { name: 'Santorini, Greece',       lat:  36.4064, lon:   25.4045, tiles:  8, vs: 1.8 },
    { name: 'Ha Long Bay, Vietnam',    lat:  20.9101, lon:  107.1839, tiles: 10, vs: 2.0 },
    { name: 'Torres del Paine, Chile', lat: -50.9423, lon:  -73.4068, tiles: 10, vs: 1.0 },
    { name: 'Faroe Islands',           lat:  62.1000, lon:   -7.0000, tiles: 10, vs: 1.2 },
];
