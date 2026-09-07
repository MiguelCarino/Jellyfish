/* ============================================================
   shaders/shafts.js — raymarched godrays, spec §2.2 (pass 1).
   ------------------------------------------------------------
   Sixteen steps, jittered per pixel per frame, at half the scene
   resolution, blended into a four-frame history. About 0.55 ms
   at 1600x900.

   THE CLOSED FORM IS LOAD-BEARING. The obvious way to accumulate
   a volume is a Riemann sum, and the obvious way is wrong here:
   its brightness depends on the step count, so the moment the §7
   ladder drops from 16 steps to 12 the whole frame dims and the
   quality controller becomes something you can see. Hillaire's
   energy-conserving segment integral,

       Sint = (S - S * exp(-sigT * dt)) / sigT

   is the exact integral of a locally constant source across the
   segment. Sum it and 16, 12 or 8 steps differ in SHARPNESS and
   not in brightness, which is the entire reason §7 can claim its
   transitions are invisible. Do not replace it with S * dt.

   WHAT THIS BUFFER HOLDS, AND WHAT IT DOES NOT. RAYS carries the
   SUN term only — sunlight that crossed the surface, was shaped
   by the caustic gobo, and scattered into the view ray. It does
   NOT carry the ambient in-scatter of the water column. sea.js
   integrates that analytically and exactly in closed form, so
   putting it in here as well would both double it and lay
   sixteen-sample march noise over the calmest, largest and most
   stared-at region of the frame. §2.2's listing adds an
   `inscatter(p.y) * SIG_S_W` source term; carrying it here and
   treating the buffer as the whole column would leave the water
   2.1x too dark in blue and 12x too dark in red — which reads as
   a bluer frame, but blue by arithmetic error rather than by
   derivation, and §5.1 is explicit that that is the failure this
   project is trying not to commit. RAYS is therefore purely
   additive on top of sea.js's column.

   HISTORY, WITHOUT REPROJECTION. §2.2 blends 0.90 of last
   frame's buffer at the same uv and rejects the history when the
   camera translates more than 4 cm in a frame. There is
   deliberately no motion-vector reprojection, and the arithmetic
   says there does not need to be: a 0.90 blend has a tail of
   about ten frames, or 0.15 s; §4.5's camera drifts at under
   2 cm/s and its look-at is a tau = 5 s spring under a 0.25 Hz,
   0.0015 rad handheld, giving an angular rate near 0.0024 rad/s.
   Over 0.15 s that is 3.5e-4 rad, which at 1080p through a 38
   degree lens is a third of a pixel — and this buffer is half
   res. Reprojecting a volume at an estimated depth would trade
   that third of a pixel for ghosting wherever the estimate is
   wrong. The rejection rule stays, because a context restore, a
   resize or a tab wake genuinely does move the camera.

   WHAT THIS ACTUALLY LOOKS LIKE, MEASURED. The shaft-to-veil
   ratio is not a free parameter: it is c * hg(theta) / 0.75,
   where 0.75 is the flat factor §2.0's inscatter() uses in place
   of a phase function. With the caustic gobo normalised to mean 1
   and peaking near 6, and with §4.5 clamping the camera to 25
   degrees of elevation so the sun is never behind the subject,
   the brightest reachable filament lands about 1.4x the local
   veil at frame centre and about 1.9x at the top of the frame —
   half a stop to one stop. That is §5.3's "three or four columns,
   a suggestion of light, not a light show", arrived at by
   derivation rather than by turning it down, and it is also why
   §4.5's anti-flare geometry works: there is no camera angle from
   which this term can become an event.

   Step-count invariance measured on the same arithmetic: with a
   constant source, 8 and 16 steps agree to zero; with the depth
   ramp along the ray they agree to 0.75 % looking level and 1.8 %
   looking straight down, worst case over the jitter. §6 clamps
   auto-exposure to 0.25 EV, which is 18 %, so a tier change
   cannot be seen.

   THE ALPHA CHANNEL IS A GUIDE, NOT A COVERAGE. It holds the
   transmittance-weighted mean scattering distance along the ray,
   normalised by SHAFT_RANGE_METRES. sea.js uses it as the range
   term of a bilateral upsample, so the edge of a shaft column
   survives being blown up 2x instead of being smeared across two
   pixels. It cannot use scene depth for that: nothing has been
   drawn into SEA's depth attachment at the point the upsample
   runs, and the shaft volume is unoccluded by design — the bell
   is composited through itself much later, in pass 6.
   ============================================================ */

import { CAUSTIC_GLSL } from './cookie.js';

/** Steps at tiers 1 and 2. The ladder drops this to 12 and then 8; see §7. */
export const SHAFT_STEPS_DEFAULT = 16;

/**
 * How far the march runs, in metres. 20 m is where §5.1 quotes the medium's own
 * reference figure — beam transmittance leaves blue at 0.033 and red at
 * 1.4e-5 — so under 5 % of the shaft light in the bluest channel comes from
 * beyond it and the truncation is invisible. It is NOT a quality knob: shorten
 * it and the frame dims, which is exactly what the closed-form integration
 * exists to prevent.
 */
export const SHAFT_RANGE_METRES = 20.0;

/**
 * Henyey-Greenstein asymmetry for the view/sun angle, spec §2.2. Forward
 * peaked, so the shafts bloom when the camera looks up towards the sun and fade
 * as it turns away. Distinct from G_GEL, which is the mesoglea's.
 */
export const SHAFT_PHASE_G = 0.62;

/** Spec §2.2's history weight. 0.90 of the previous frame, 0.10 of this one. */
export const SHAFT_HISTORY_BLEND = 0.90;

/** Spec §2.2: reject the history when the camera moved more than this in a frame. */
export const SHAFT_HISTORY_REJECT_METRES = 0.04;

/**
 * A ceiling applied to the history read. A single non-finite or absurd value —
 * from a driver hiccup, a context restore mid-frame, a resize that left one
 * garbage buffer — would otherwise be fed back into itself forever and burn a
 * bright dot into a page that stays open for eight hours. Two orders of
 * magnitude above anything the march can legitimately produce: the brightest
 * reachable filament integrates to about 4.5 in blue.
 */
export const SHAFT_HISTORY_CEILING = 512.0;

/**
 * Sharpness of sea.js's bilateral range term, in units of the normalised depth
 * guide. High enough that a genuine shaft edge stops the filter, low enough
 * that ordinary gradients pass through as plain bilinear.
 */
export const SHAFT_BILATERAL_SHARPNESS = 12.0;

/**
 * `uHistoryWeight` for this frame. Pass the distance the camera moved since the
 * last shaft pass, in metres, and `false` for `valid` on the first frame after a
 * resize, a context restore, a tab wake or any other event that leaves the
 * history buffer holding something that is not the previous frame.
 */
export function shaftHistoryWeight(cameraMoveMetres, valid = true) {
  if (!valid) return 0.0;
  if (!(cameraMoveMetres >= 0.0)) return 0.0;
  if (cameraMoveMetres > SHAFT_HISTORY_REJECT_METRES) return 0.0;
  return SHAFT_HISTORY_BLEND;
}

/** GLSL float literal: always carries a decimal point. */
function f(x, digits = 6) {
  if (!Number.isFinite(x)) throw new Error(`shafts.js: refusing to emit non-finite GLSL constant ${x}`);
  return x.toFixed(digits);
}

/**
 * Ray reconstruction, shared by the shaft march and the water column. Lives
 * here rather than in sea.js because this is the file that marches rays;
 * sea.js imports it so there is exactly one copy in any assembled program.
 */
export const VIEW_RAY_GLSL = `
// ---- shafts.js: screen uv -> world-space ray ------------------------------
// Unprojects the NEAR-plane point, not the far-plane one. mat4.perspective
// accepts an infinite far plane, and at z = +1 an infinite projection puts w at
// zero: the divide would produce a NaN direction on exactly the configuration
// that is otherwise the most correct one to use for an open ocean.
vec3 seaViewRay(mat4 invViewProj, vec3 camPos, vec2 uv){
  vec4 h = invViewProj * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  return normalize(h.xyz / h.w - camPos);
}
`;

/**
 * The march itself, as a reusable function. The half-res RAYS pass calls it,
 * and so does sea.js on the tier-4 / RGBA8 path where RAYS is never allocated
 * and the shafts are computed inline at 8 steps (§7).
 *
 * Requires COMMON_GLSL and CAUSTIC_GLSL ahead of it. `SHAFT_STEPS` may be
 * supplied as a define; it defaults to SHAFT_STEPS_DEFAULT.
 *
 * Returns vec4(in-scattered radiance, normalised mean scattering distance).
 */
export const SHAFT_MARCH_GLSL = `
// ---- shafts.js: Hillaire closed-form segment march, spec §2.2 -------------
#ifndef SHAFT_STEPS
#define SHAFT_STEPS ${SHAFT_STEPS_DEFAULT}
#endif
#define SHAFT_RANGE ${f(SHAFT_RANGE_METRES)}
#define SHAFT_PHASE_G ${f(SHAFT_PHASE_G)}

vec4 marchShafts(vec3 ro, vec3 rd, float jitter){
  float dt   = SHAFT_RANGE / float(SHAFT_STEPS);
  // The segment transmittance is constant, so it is one exp() for the whole
  // march rather than one per step.
  vec3  segT = exp(-SIG_T_W * dt);

  // The phase depends only on the ray direction, so hoisting it out of the loop
  // is exact rather than an approximation. uSunDir points along the light's
  // travel (down), which is why the peak of dot(rd, -uSunDir) is the camera
  // looking up towards the sun.
  float phase = hg(dot(rd, -uSunDir), SHAFT_PHASE_G);

  vec3  L = vec3(0.0);
  vec3  T = vec3(1.0);
  float t = jitter * dt;

  // First moment of the scattered light along the ray, for sea.js's bilateral
  // upsample guide.
  float weightSum = 0.0;
  float momentSum = 0.0;

  for (int i = 0; i < SHAFT_STEPS; i++){
    vec3  p  = ro + rd * t;
    float wy = seaDepth(p);

    // downwelling(wy) is SUN_E0 * exp(KD * wy) from §2.0 — the SAME function
    // the bell and the snow use, so the shaft and the light on the animal
    // inside it cannot disagree about how much sun reached this depth.
    vec3 S = downwelling(wy) * causticAt(p) * phase * SIG_S_W;

    // The closed form. Read the header before touching this.
    vec3 Sint = (S - S * segT) / max(SIG_T_W, vec3(1e-5));
    vec3 dL   = T * Sint;

    L += dL;
    weightSum += dL.b;
    momentSum += dL.b * t;
    T *= segT;
    t += dt;
  }

  // With no light along the ray the mean distance is meaningless; the midpoint
  // is the neutral answer, and it keeps the bilateral filter from inventing an
  // edge between two equally dark pixels.
  float meanDist = weightSum > 1e-6 ? momentSum / weightSum : SHAFT_RANGE * 0.5;
  return vec4(L, clamp(meanDist / SHAFT_RANGE, 0.0, 1.0));
}
`;

/**
 * Pass 1's fragment shader. Pair it with FULLSCREEN_TRIANGLE_VS from gl.js and
 * draw into RAYS_A / RAYS_B alternately, reading the other as `uHistory`.
 * Blend off, depth off, cull off; no clear is needed, the pass writes every
 * texel.
 *
 * `uInvViewProj` and `uCamPos` MUST be the same camera sea.js is given,
 * including §2.5's 8 % guard-band overscan, or the upsampled shafts will not
 * line up with the water they are lighting.
 */
export const SHAFTS_FS = `
uniform mat4      uInvViewProj;
uniform vec3      uCamPos;
uniform sampler2D uHistory;
uniform float     uHistoryWeight;
uniform float     uFrame;

in  vec2 vUV;
out vec4 fragColor;

#define SHAFT_HISTORY_CEILING ${f(SHAFT_HISTORY_CEILING, 1)}

void main(){
  vec3 rd = seaViewRay(uInvViewProj, uCamPos, vUV);

  // Spec §2.2's jitter, verbatim: interleaved gradient noise in PIXEL
  // coordinates, advanced per frame. Combined with the history blend the march
  // sees SHAFT_STEPS x history-depth effective samples, which is what lets
  // sixteen steps cover twenty metres without banding.
  float jitter = ign(gl_FragCoord.xy + uFrame * 7.0);

  vec4 current = marchShafts(uCamPos, rd, jitter);

  // Scrubbed, not just read: a feedback buffer that can hold a non-finite value
  // holds it forever, and this page stays open for eight hours. The argument
  // order is deliberate. GLSL defines max(x, y) as "y if x < y, else x", so
  // max(0.0, NaN) asks whether 0 < NaN, gets false, and returns 0 — whereas
  // clamp(), which is specified as min(max(x, minVal), maxVal), puts the NaN
  // first and passes it straight through. See SHAFT_HISTORY_CEILING.
  vec4 history = min(max(vec4(0.0), texture(uHistory, vUV)), vec4(SHAFT_HISTORY_CEILING));

  fragColor = mix(current, history, uHistoryWeight);
}
`;

/**
 * The includes SHAFTS_FS needs, in order. Hand this straight to
 * assembleProgramSources({ includes: SHAFTS_INCLUDES }).
 */
export const SHAFTS_INCLUDES = Object.freeze([CAUSTIC_GLSL, VIEW_RAY_GLSL, SHAFT_MARCH_GLSL]);
