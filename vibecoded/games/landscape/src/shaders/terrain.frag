#version 300 es
precision highp float;

/*
  Voxel-space landscape, per-pixel ray march.

  The 2010 original (../../main.cpp, View()) walked outward from the
  camera one depth step at a time, drawing a full scanline of 320
  samples per step back-to-front, and used a per-column high-water mark
  (lasty[]) so each pixel was written exactly once. That structure
  exists to let one CPU fill 320x240 at 30fps; it has no GPU analogue.

  Here every fragment marches its own ray. Two things carry over:

    - the step size grows with distance, exactly the reasoning behind
      the original's `d += 1 + (d >> 6)`: distant samples cover more
      screen area, so they can be coarser.

    - retro mode reproduces the original's projection, which is
      anamorphic. Its vertical focal length works out to 75px against a
      horizontal 92.4px, so the 2010 image is vertically squashed by
      1.232. See uTanHalf, set on the JS side.
*/

in vec2 vNdc;
out vec4 outColor;

uniform sampler2D uHeight;    // R channel = height in texel units
uniform sampler2D uTexture;   // terrain colour, original palette
uniform sampler2D uSky;       // 512x128 panorama strip
uniform sampler2D uImagery;   // satellite imagery, same extent as height
uniform sampler2D uDetail;    // finest ring, following the camera
uniform sampler2D uDetail2;   // one level coarser, twice the span

uniform vec3  uCamPos;        // world x, y, altitude
uniform vec3  uFwd;
uniform vec3  uRight;
uniform vec3  uUp;
uniform vec2  uTanHalf;       // tan(halfFov) horizontal, vertical
uniform float uTexelsPerPx;   // world texels one screen pixel spans, per
                              // unit of ray distance: 2*tanHalfY/height

uniform float uDrawDist;
uniform float uFogDensity;
uniform vec3  uSunDir;
uniform bool  uRetro;
uniform int   uMaxSteps;

uniform float uStepGrowth;    // solved on the CPU so that the step
                              // budget always spans the draw distance
uniform float uMaxHeight;     // tallest sample, already vertically scaled
uniform float uWorldSize;     // texels per side of the height texture
uniform float uVertScale;     // vertical exaggeration
uniform bool  uWrap;          // synthetic terrain tiles; real terrain does not
uniform bool  uProcedural;    // colour from elevation instead of a texture
uniform float uSeaTexels;     // the flat plane outside the window: real
                              // sea level where the window has coast,
                              // otherwise the window's own lowest ground
uniform bool  uHasSea;        // whether that plane is water

uniform bool  uDebugGrid;     // tile checkerboard + range rings
uniform float uBaseTileTexels;   // world texels per base imagery tile
uniform float uDetailTiles;      // tiles per side of the detail rectangle
uniform float uRingTexels;       // spacing between range rings
uniform float uThresholdTexels;  // switch distance, picked out in cyan
uniform float uMetresPerTexel; // ground resolution of the dataset
uniform bool  uUseImagery;
uniform float uImageryLodBias; // imagery is finer than the heightmap
uniform bool  uHasDetail2;
uniform vec2  uDetail2Origin;
uniform float uDetail2Span;
uniform float uDetail2LodBias;
uniform bool  uHasDetail;
uniform vec2  uDetailOrigin;   // world texels
uniform float uDetailSpan;     // world texels covered by the detail layer
uniform float uDetailLodBias;

const float STEP_MIN = 0.5;
const int   REFINE   = 6;

// The 2010 heightmap tiles seamlessly at 1792 and wraps. Real-world
// terrain is a finite window: outside it there is open sea, which suits
// a coastal scene and avoids smearing the edge texels to the horizon.

// --- terrain sampling ---------------------------------------------------

bool outside(vec2 p) {
    return !uWrap && (p.x < 0.0 || p.y < 0.0 ||
                      p.x >= uWorldSize || p.y >= uWorldSize);
}

// Smooth height, for modern mode.
float heightAt(vec2 p) {
    if (outside(p)) return uSeaTexels;
    return texture(uHeight, p / uWorldSize).r * uVertScale;
}

// Nearest height, for retro mode. texelFetch ignores the sampler's
// filtering and wrapping, so the wrap is done by hand.
float heightAtNearest(vec2 p) {
    if (outside(p)) return uSeaTexels;
    ivec2 t = ivec2(mod(floor(p), uWorldSize));
    return texelFetch(uHeight, t, 0).r * uVertScale;
}

float sampleHeight(vec2 p) {
    return uRetro ? heightAtNearest(p) : heightAt(p);
}

// Terrain colour. Modern mode picks an explicit LOD from distance:
// automatic derivatives are undefined inside the non-uniform control
// flow of the march loop, so textureLod is used rather than texture().
// Hypsometric tint for real terrain, which arrives with no colour map.
// Tuned for the Atacama: sea, a pale salt-and-sand coastal strip, then
// ochre through rust to bare grey rock on the ridges.
vec3 hypsometric(float h, float slope) {
    // Thresholds in metres above sea level, which is the only scale that
    // means anything here -- texel counts shift with the exaggeration.
    float m = h / max(uVertScale, 0.0001) * uMetresPerTexel;
    vec3 c = vec3(0.86, 0.80, 0.66);                                  // beach
    c = mix(c, vec3(0.74, 0.58, 0.38), smoothstep(  5.0,  40.0, m));  // sand
    c = mix(c, vec3(0.60, 0.42, 0.28), smoothstep( 40.0, 180.0, m));  // ochre
    c = mix(c, vec3(0.47, 0.36, 0.30), smoothstep(180.0, 420.0, m));  // rust
    c = mix(c, vec3(0.55, 0.52, 0.49), smoothstep(420.0, 900.0, m));  // rock
    // Steep faces are scoured back to bare stone.
    c = mix(c, vec3(0.36, 0.32, 0.30), smoothstep(0.6, 2.2, slope));
    return c;
}

// Imagery covers exactly the same ground as the heightmap -- the tile
// grids are identical -- so the normalised coordinates are shared. Only
// the LOD differs, because the imagery is a finer grid over that extent.
// One ring of the clipmap, blended over whatever is already there.
// Sampler parameters are legal in GLSL ES 3.00, so the inner and outer
// rings share this rather than duplicating it with different uniforms.
vec3 blendRing(vec3 under, sampler2D tex, vec2 origin, float span,
               float lodBias, vec2 p, float d) {
    vec2 duv = (p - origin) / span;
    if (duv.x < 0.0 || duv.y < 0.0 || duv.x > 1.0 || duv.y > 1.0) return under;
    vec3 det = textureLod(tex, duv, clamp(d + lodBias, 0.0, 9.0)).rgb;
    vec2 edge = min(duv, 1.0 - duv);
    return mix(under, det, smoothstep(0.0, 0.10, min(edge.x, edge.y)));
}

vec3 imageryAt(vec2 p, float dist) {
    // Mip level from the actual pixel footprint. This was a hard-coded
    // 0.004, which is 2*tanHalfY/height for a 380px-tall buffer -- fine
    // on the window it was tuned in, and 1.4 levels too blurry at 1000px,
    // 2.1 at 1440. Detail imagery suffered worst: at 2 km the z17 layer
    // was fetched at 1.06 m/px and then sampled at mip 3, which is 8.5
    // m/px -- exactly the base resolution it was there to improve on.
    float d = log2(max(dist, 1.0) * uTexelsPerPx);
    vec3 base = textureLod(uImagery, p / uWorldSize,
                           clamp(d + uImageryLodBias, 0.0, 9.0)).rgb;
    // Coarsest first, finest last, so the finer ring wins wherever the
    // two overlap. The outer ring exists because one rectangle cannot be
    // both fine and wide: at a fixed tile budget each level finer halves
    // the ground covered, so a single rectangle sharp enough for what is
    // straight ahead leaves the sides of the frame on base imagery.
    //
    // The fade is spatial only -- over the inner 10% of each border.
    // There used to be a second fade with distance from the camera, from
    // 0.45 to 0.9 of the span, on the reasoning that far ground does not
    // need detail because the base is already finer than the screen
    // resolves. That reasoning belonged to the altitude-driven layer. The
    // zoom is now chosen FROM the viewing distance, so the fade cancelled
    // precisely the ground it had just been sized for: at 2.14 km with a
    // 2.72 km span it left w = 0.16, and detail was only ever visible
    // below about 200 m. Distance is handled by the LOD choice and by
    // textureLod; the border fades alone hide the seams.
    if (uHasDetail2) {
        base = blendRing(base, uDetail2, uDetail2Origin, uDetail2Span,
                         uDetail2LodBias, p, d);
    }
    if (uHasDetail) {
        base = blendRing(base, uDetail, uDetailOrigin, uDetailSpan,
                         uDetailLodBias, p, d);
    }
    return base;
}

vec3 colourAt(vec2 p, float dist) {
    if (uProcedural) return vec3(0.0);   // handled in shade()
    if (uRetro) {
        return texelFetch(uTexture, ivec2(mod(floor(p), uWorldSize)), 0).rgb;
    }
    float lod = clamp(log2(max(dist, 1.0) * uTexelsPerPx), 0.0, 8.0);
    return textureLod(uTexture, p / uWorldSize, lod).rgb;
}

// --- sky ----------------------------------------------------------------

vec3 skyAt(vec3 dir) {
    if (uRetro) {
        return vec3(1.0);   // the original's memset to palette index 255
    }
    float az = atan(dir.y, dir.x) / 6.2831853 + 0.5;
    float el = clamp(asin(clamp(dir.z, -1.0, 1.0)) / 1.5707963, 0.0, 1.0);
    return texture(uSky, vec2(az, 1.0 - el)).rgb;
}

// --- shading ------------------------------------------------------------

vec3 shade(vec2 p, float dist, vec3 dir) {
    // Normal from central differences, one world unit either side.
    float hl = heightAt(p - vec2(1.0, 0.0));
    float hr = heightAt(p + vec2(1.0, 0.0));
    float hd = heightAt(p - vec2(0.0, 1.0));
    float hu = heightAt(p + vec2(0.0, 1.0));
    vec3 n = normalize(vec3(hl - hr, hd - hu, 2.0));

    vec3 albedo;
    bool water = false;
    if (uProcedural) {
        float h = heightAt(p);
        water = uHasSea && h <= uSeaTexels + 0.02;
        float slope = length(vec2(hl - hr, hd - hu));
        if (uUseImagery) albedo = imageryAt(p, dist);
        else albedo = water ? vec3(0.06, 0.16, 0.24) : hypsometric(h, slope);
        if (water) n = vec3(0.0, 0.0, 1.0);   // flat sea
    } else {
        albedo = colourAt(p, dist);
    }

    if (uRetro) {
        return albedo;      // the original was flat and unlit
    }

    // Satellite imagery already contains the sun: shadows, shading and
    // all. Relighting it at full strength double-shades the terrain and
    // reads as mud, so imagery gets mostly flat light with only a hint
    // of relief.
    float lambert = max(dot(n, uSunDir), 0.0);
    // Kept so ambient + direct * lambert stays at or below 1.0 for a
    // flat surface under a 45-degree sun; above that the imagery washes
    // out to white.
    float ambient = uUseImagery ? 0.72 : 0.35 + 0.15 * n.z;
    float direct  = uUseImagery ? 0.28 : 0.85;
    vec3 lit = albedo * (ambient + direct * lambert);

    // A cheap specular glint so the sea reads as water rather than as
    // flat blue paint.
    if (water) {
        vec3 halfv = normalize(uSunDir - dir);
        lit += vec3(0.9, 0.95, 1.0) * pow(max(dot(n, halfv), 0.0), 64.0) * 0.6;
    }
    return lit;
}

// The sea surface, shaded as a plane rather than as terrain.
vec3 shadeSea(vec3 dir, float dist) {
    vec3 n = vec3(0.0, 0.0, 1.0);
    vec3 base = vec3(0.05, 0.13, 0.20);
    if (uUseImagery) {
        // The imagery has the real ocean in it, surf and all.
        base = imageryAt((uCamPos + dir * dist).xy, dist);
    }
    if (uRetro) return base;
    float lambert = max(dot(n, uSunDir), 0.0);
    // Imagery already contains the sun on the water, the surf and the
    // shallows, so it needs almost none of this added back.
    vec3 lit = uUseImagery ? base * (0.86 + 0.14 * lambert)
                           : base * (0.45 + 0.70 * lambert);
    vec3 halfv = normalize(uSunDir - dir);
    lit += vec3(0.85, 0.92, 1.0) * pow(max(dot(n, halfv), 0.0), 90.0)
         * (uUseImagery ? 0.25 : 0.8);
    // Grazing reflection of the sky towards the horizon.
    lit = mix(lit, skyAt(vec3(dir.xy, abs(dir.z))) * 0.55,
              pow(1.0 - min(abs(dir.z), 1.0), uUseImagery ? 7.0 : 5.0));
    return lit;
}

// --- debug overlay ------------------------------------------------------
//
// Two cues, both from quantities the march already carries, so neither
// costs a texture fetch or a second pass.
//
// The checkerboard tints alternate imagery tiles. Tile size against
// distance becomes directly visible, and the detail rectangle announces
// itself as a change of grid pitch rather than something to infer.
//
// The rings mark every uRingTexels along the ray, with the switch
// distance picked out in cyan. Their width is scaled by uTexelsPerPx so
// they stay about a pixel and a half wide at any distance -- a fixed
// world width would alias into a solid sheet towards the horizon.
//
// Drawn after the fog so it stays readable whatever the fog is set to.
vec3 debugOverlay(vec3 colour, vec2 p, float dist) {
    float tile = uBaseTileTexels;
    float amp = 0.05;
    if (uHasDetail2) {
        vec2 duv = (p - uDetail2Origin) / uDetail2Span;
        if (duv.x >= 0.0 && duv.y >= 0.0 && duv.x <= 1.0 && duv.y <= 1.0) {
            tile = uDetail2Span / uDetailTiles;
            amp = 0.08;
        }
    }
    if (uHasDetail) {
        vec2 duv = (p - uDetailOrigin) / uDetailSpan;
        if (duv.x >= 0.0 && duv.y >= 0.0 && duv.x <= 1.0 && duv.y <= 1.0) {
            tile = uDetailSpan / uDetailTiles;
            amp = 0.12;      // the finest grid is the one being explained
        }
    }
    vec2 cell = floor(p / max(tile, 1e-3));
    colour *= 1.0 + amp * (mod(cell.x + cell.y, 2.0) * 2.0 - 1.0);

    float w = max(1.5 * dist * uTexelsPerPx, 0.05);
    float m = mod(dist, max(uRingTexels, 1e-3));
    float dr = min(m, uRingTexels - m);

    // Dark core with a light halo. A single tint fails on one background
    // or the other -- white vanishes into bright desert, dark vanishes
    // into the sea -- and the pair reads on both.
    // Both bands must stay comfortably over a pixel wide. At w * 0.6 the
    // dark core was about 0.9 px and aliased into a dashed line, while
    // the cyan ring beside it -- drawn at w * 1.5 -- stayed smooth. That
    // contrast is what identified the cause: it is width, not the hit
    // distance. Step count makes no difference to it (verified at 48 and
    // 256 steps, mean run length 3.8 px against 3.9 px).
    float core = 1.0 - smoothstep(0.0, w * 1.1, dr);
    float halo = max(1.0 - smoothstep(w * 1.1, w * 2.4, dr) - core, 0.0);

    // Rings crowd together towards the horizon, where a kilometre is a
    // fraction of a pixel; without this they merge into a solid sheet
    // and read as haze rather than as scale.
    float spacingPx = uRingTexels / max(dist * uTexelsPerPx, 1e-4);
    float vis = smoothstep(5.0, 14.0, spacingPx);

    colour = mix(colour, vec3(0.03), core * 0.75 * vis);
    colour = mix(colour, vec3(1.0), halo * 0.55 * vis);

    if (uThresholdTexels > 0.0) {
        float sw = 1.0 - smoothstep(0.0, w * 1.5, abs(dist - uThresholdTexels));
        colour = mix(colour, vec3(0.15, 0.85, 1.0), sw * 0.75);
    }
    return colour;
}

// --- march --------------------------------------------------------------

void main() {
    vec2 ndc = vNdc;
    vec3 dir = normalize(uFwd
                       + uRight * (ndc.x * uTanHalf.x)
                       + uUp    * (ndc.y * uTanHalf.y));

    float t = 1.0;

    // Nothing is taller than uMaxHeight, so while the ray is above that
    // ceiling it cannot possibly hit. Skip straight to where it comes
    // back down through the ceiling -- exact, not an approximation, and
    // it saves the whole descent when flying high.
    if (uCamPos.z > uMaxHeight) {
        if (dir.z >= 0.0) {
            outColor = vec4(skyAt(dir), 1.0);
            return;
        }
        t = max(t, (uMaxHeight - uCamPos.z) / dir.z);
    }

    // The sea is an exact plane, so it is intersected analytically
    // rather than marched. Marching it is what produced blocky chunks
    // along the shoreline: over a flat surface the ray runs nearly
    // parallel to it, so the hit quantises to the step size.
    float tSea = 1e30;
    if (uProcedural && dir.z < -1e-6 && uCamPos.z > uSeaTexels) {
        tSea = (uSeaTexels - uCamPos.z) / dir.z;
    }

    float tPrev = t;
    bool hit = false;

    for (int i = 0; i < uMaxSteps; i++) {
        if (t > uDrawDist) break;
        vec3 p = uCamPos + dir * t;
        if (p.z < sampleHeight(p.xy)) { hit = true; break; }
        tPrev = t;
        t += t * uStepGrowth + STEP_MIN;
    }

    if (!hit && tSea > uDrawDist) {
        outColor = vec4(skyAt(dir), 1.0);
        return;
    }

    // Binary refinement between the last miss and the first hit. This
    // is the step the CPU version could not afford, and the reason
    // near geometry does not stair-step here.
    float dist = uDrawDist;
    if (hit) {
        float lo = tPrev, hi = min(t, uDrawDist);
        for (int i = 0; i < REFINE; i++) {
            float mid = 0.5 * (lo + hi);
            vec3 p = uCamPos + dir * mid;
            if (p.z < sampleHeight(p.xy)) hi = mid; else lo = mid;
        }
        dist = hi;
    }

    // Whichever surface is actually nearer wins. A marched hit at sea
    // level is the sea, and the analytic distance to it is exact.
    bool onSea = false;
    if (tSea < min(dist, uDrawDist) || !hit) {
        vec2 seaXY = (uCamPos + dir * tSea).xy;
        if (!hit || sampleHeight(seaXY) <= uSeaTexels + 0.02) {
            dist = tSea;
            onSea = true;
        }
    }

    vec2 hitXY = (uCamPos + dir * dist).xy;
    // The plane is still intersected analytically wherever it is -- a
    // flat surface at a grazing angle is the marcher's worst case -- but
    // it is only shaded as water when the window actually reaches the
    // coast. Inland it is the valley floor continuing past the edge of
    // the data, and painting that blue put an ocean at 2000 m.
    vec3 colour = (onSea && uHasSea) ? shadeSea(dir, dist)
                                     : shade(hitXY, dist, dir);

    if (!uRetro) {
        vec3 sky = skyAt(dir);
        float f = exp2(-pow(dist * uFogDensity, 2.0));
        colour = mix(sky, colour, clamp(f, 0.0, 1.0));
        // Terrain simply stops at the draw distance, and if fog has not
        // finished hiding it by then the cutoff shows as a hard edge
        // along the horizon. Fade the last stretch out regardless of
        // what the fog slider is set to. Retro mode keeps the hard
        // cutoff, which is what the original did.
        colour = mix(colour, sky,
                     smoothstep(0.8, 1.0, dist / uDrawDist));
    }

    if (uDebugGrid) colour = debugOverlay(colour, hitXY, dist);

    outColor = vec4(colour, 1.0);
}
