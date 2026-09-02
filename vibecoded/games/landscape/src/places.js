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
// There is deliberately no per-place window size. How many tiles a
// window is cut from is a global trade -- reach against resolution,
// memory and load time against refetch frequency -- and it is now a
// panel control, so a preset that quietly overrode it would make the
// control lie.

export const PLACES = [
    // First, and the default. Viña del Mar sits on the eastern shore of
    // Valparaíso Bay, which is the reason to open here: the frame holds
    // open water, a curved coastline, a city on the flat, and the hills
    // behind it climbing to 300 m in six kilometres -- everything a
    // heightfield with imagery draped over it is good at, in one view.
    //
    // The coordinates are offshore rather than on the city, and that is
    // deliberate: they place the CAMERA, and 69 m of water under it means
    // the opening shot starts on the sea and travels inland. Viña itself
    // is 7.8 km away on a bearing of 21°, comfortably inside a frame
    // aimed at 29°, which also takes in the Valparaíso headland to the
    // south. The window is 98 km across at this latitude, so the city and
    // both sides of the bay are well within it.
    { name: 'Viña del Mar, Chile',     lat: -33.0000, lon: -71.6300,
      vs: 1.0, yaw: 0.50, alt: 600, pitch: -0.06 },

    // The coast this demo was built against: offshore, looking east over
    // open water to the coastline and the ground rising behind it.
    //
    // These coordinates were once tuned against the tile-corner snap and
    // have been left alone now that placement is exact, which moves the
    // opening position 4.6 km east and 3.2 km south -- still over water,
    // and about 1 km off the beach instead of 5. That is the better side
    // of the change to be on: a locked z17 ring reaches 2.42 km, so the
    // coastline now falls inside the detail rectangle rather than beyond
    // it.
    { name: 'Caldera, Atacama, Chile', lat: -27.0874, lon: -70.8810, vs: 1.0, alt: 500, pitch: -0.04 },
    { name: 'Grand Canyon, Arizona',   lat:  36.0980, lon: -112.0950, vs: 1.0, yaw: 1.6 },
    { name: 'Monument Valley, Utah',   lat:  36.9980, lon: -110.0985, vs: 1.4 },
    { name: 'Jungfrau, Switzerland',   lat:  46.5400, lon:    7.9800, vs: 1.0 },
    { name: 'Matterhorn, Zermatt',     lat:  45.9950, lon:    7.6800, vs: 1.0 },
    { name: 'Mount Fuji, Japan',       lat:  35.3606, lon:  138.7274, vs: 1.0 },
    { name: 'Rio de Janeiro, Brazil',  lat: -22.9450, lon:  -43.2000, vs: 1.3 },
    { name: 'Hong Kong',               lat:  22.2750, lon:  114.1600, vs: 1.5 },
    { name: 'Cape Town, South Africa', lat: -33.9600, lon:   18.4100, vs: 1.3 },
    { name: 'Machu Picchu, Peru',      lat: -13.1631, lon:  -72.5450, vs: 1.0 },
    { name: 'Milford Sound, NZ',       lat: -44.6414, lon:  167.8974, vs: 1.0 },
    { name: 'Santorini, Greece',       lat:  36.4064, lon:   25.4045, vs: 1.8 },
    { name: 'Ha Long Bay, Vietnam',    lat:  20.9101, lon:  107.1839, vs: 2.0 },
    { name: 'Torres del Paine, Chile', lat: -50.9423, lon:  -73.4068, vs: 1.0 },
    { name: 'Faroe Islands',           lat:  62.1000, lon:   -7.0000, vs: 1.2 },
];
