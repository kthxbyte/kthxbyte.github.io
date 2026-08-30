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

uniform sampler2D uHeight;    // R channel = terrain height, 0..255
uniform sampler2D uTexture;   // terrain colour, original palette
uniform sampler2D uSky;       // 512x128 panorama strip

uniform vec3  uCamPos;        // world x, y, altitude
uniform vec3  uFwd;
uniform vec3  uRight;
uniform vec3  uUp;
uniform vec2  uTanHalf;       // tan(halfFov) horizontal, vertical

uniform float uDrawDist;
uniform float uFogDensity;
uniform vec3  uSunDir;
uniform bool  uRetro;
uniform int   uMaxSteps;

uniform float uStepGrowth;    // solved on the CPU so that the step
                              // budget always spans the draw distance
uniform float uMaxHeight;     // tallest terrain sample, 249

const float STEP_MIN = 0.5;
const int   REFINE   = 6;

const float WORLD = 1792.0;   // both terrain images are 1792x1792 and
                              // tile seamlessly at this period. The
                              // original wrapped at 1791 (w - 1), which
                              // left a one-column seam; not reproduced.

// --- terrain sampling ---------------------------------------------------

// Smooth height, for modern mode. REPEAT wrapping gives the infinite
// tiling world for free.
float heightAt(vec2 p) {
    return texture(uHeight, p / WORLD).r * 255.0;
}

// Nearest height, for retro mode. texelFetch ignores the sampler's
// filtering and wrapping, so the wrap is done by hand.
float heightAtNearest(vec2 p) {
    ivec2 t = ivec2(mod(floor(p), WORLD));
    return texelFetch(uHeight, t, 0).r * 255.0;
}

float sampleHeight(vec2 p) {
    return uRetro ? heightAtNearest(p) : heightAt(p);
}

// Terrain colour. Modern mode picks an explicit LOD from distance:
// automatic derivatives are undefined inside the non-uniform control
// flow of the march loop, so textureLod is used rather than texture().
vec3 colourAt(vec2 p, float dist) {
    if (uRetro) {
        return texelFetch(uTexture, ivec2(mod(floor(p), WORLD)), 0).rgb;
    }
    float lod = clamp(log2(max(dist, 1.0) * 0.004), 0.0, 8.0);
    return textureLod(uTexture, p / WORLD, lod).rgb;
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
    vec3 albedo = colourAt(p, dist);
    if (uRetro) {
        return albedo;      // the original was flat and unlit
    }
    // Normal from central differences, one world unit either side.
    float hl = heightAt(p - vec2(1.0, 0.0));
    float hr = heightAt(p + vec2(1.0, 0.0));
    float hd = heightAt(p - vec2(0.0, 1.0));
    float hu = heightAt(p + vec2(0.0, 1.0));
    vec3 n = normalize(vec3(hl - hr, hd - hu, 2.0));

    float lambert = max(dot(n, uSunDir), 0.0);
    float ambient = 0.35 + 0.15 * n.z;
    return albedo * (ambient + 0.85 * lambert);
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

    float tPrev = t;
    bool hit = false;

    for (int i = 0; i < uMaxSteps; i++) {
        if (t > uDrawDist) break;
        vec3 p = uCamPos + dir * t;
        if (p.z < sampleHeight(p.xy)) { hit = true; break; }
        tPrev = t;
        t += t * uStepGrowth + STEP_MIN;
    }

    if (!hit) {
        outColor = vec4(skyAt(dir), 1.0);
        return;
    }

    // Binary refinement between the last miss and the first hit. This
    // is the step the CPU version could not afford, and the reason
    // near geometry does not stair-step here.
    float lo = tPrev, hi = min(t, uDrawDist);
    for (int i = 0; i < REFINE; i++) {
        float mid = 0.5 * (lo + hi);
        vec3 p = uCamPos + dir * mid;
        if (p.z < sampleHeight(p.xy)) hi = mid; else lo = mid;
    }

    float dist = hi;
    vec2 hitXY = (uCamPos + dir * dist).xy;
    vec3 colour = shade(hitXY, dist, dir);

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

    outColor = vec4(colour, 1.0);
}
