/* ============================================================
   shaders/sea.js — the water column, spec §2.3 / §5.1 / §5.2
   (pass 2, the fullscreen part).
   ------------------------------------------------------------
   This is the largest object in the frame and almost all of what
   anyone actually looks at. It is also the file where §5.1 is
   either honoured or quietly broken, so it is worth being blunt
   about what it does.

   THE SCENE IS BLUE BY DERIVATION. SUN_E0 is scene-referred and
   essentially white — (1.00, 1.02, 1.05) x 22 — and there is not
   one blue constant anywhere below. Every blue on screen is what
   is left of white light after per-channel absorption: at the
   camera's 14 m the downwelling ramp exp(KD * y) has already
   taken red to 0.0028 of its surface value while blue is still at
   0.639, and the ratio of the two coefficient sets does the rest.
   Pre-tinting the sun, or grading afterwards, double-counts the
   extinction and is precisely what makes a render look graded
   instead of photographed. §10 has a test for it: zeroing the red
   channel of SIG_A_G must visibly redden the animal.

   TWO COEFFICIENT SETS, AND THEY ARE NOT INTERCHANGEABLE.
   SIG_T_W is beam attenuation and belongs in every transmittance
   over a path. KD is diffuse downwelling attenuation and belongs
   only in the brightness-versus-depth ramp. §0 records that both
   losing proposals conflated them, which under-hazes the far
   field and makes the sea read as an aquarium tank. Both appear
   below, each in exactly one role.

   ---- The vertical gradient, in closed form ----

   §5.2 asks for the depth gradient to be analytic, from
   inscatter(y), never a painted ramp. §2.3's listing approximates
   it by sampling inscatter() 45 m along the view ray, and that
   approximation cannot ship: for a ray with rd.y = 1 it evaluates
   the medium at y = +31, thirty-one metres ABOVE the surface,
   where exp(KD.r * 45) is 1.5e8. The top of the frame would be a
   white hole.

   The exact integral is no more expensive and is strictly what
   §5.2 asks for. In-scattered radiance along a ray through a
   medium whose ambient radiance varies with depth is

     L = integral over t of  sigT * inscatter(y(t)) * exp(-sigT*t)
     with y(t) = camY + rd.y * t   and   inscatter(y) = A*exp(KD*y)

   which integrates per channel to

     L = inscatter(camY) * sigT/k * (1 - exp(-k * tMax)),
     k = sigT - KD * rd.y

   The source density is sigT * inscatter(y) and not something
   else, because that is the source whose steady state is exactly
   inscatter(y) — which is to say, this expression is the
   depth-varying generalisation of waterApply()'s own second term,
   and at rd.y = 0 it collapses back onto it to within the 4e-5
   that SEA_FAR truncates. The two cannot disagree about the
   medium, which is the whole point of §2.0.

   k is positive for every unit ray: its worst case is straight up
   at sigT - KD = (0.140, 0.155, 0.138). The formula has no
   singularity and needs no special case; the clamp below is
   belt-and-braces against a denormalised direction, not a real
   branch.

   What it produces, at 14 m: looking straight up multiplies the
   veil by (1.46, 1.16, 1.09) and straight down by (0.57, 0.75,
   0.84). The top of the frame is brighter and PALER, the bottom
   sinks towards indigo, and the hue drifts continuously between
   them — §5.2's gradient and §6's "hue drift with distance that
   reads as depth", both for free, both derived, neither painted.

   ---- Shafts ----

   RAYS (spec §2.2) is purely additive on top of this column; see
   the header of shafts.js for why the ambient term does not
   belong in it. It arrives at half resolution and is expanded by
   a bilateral upsample whose range term is the shaft buffer's own
   mean-scattering-distance guide, not scene depth: at the point
   this pass runs, SEA's depth attachment is still empty (snow and
   strands write it later in the same pass) and the shaft volume
   is unoccluded by design. Where the guide agrees across the four
   taps — which is everywhere except a shaft edge — the filter
   reduces to plain bilinear exactly.

   On the tier-4 and RGBA8 paths RAYS is never allocated at all
   and the march runs inline here at eight steps (§7). Because the
   march is energy conserving that is a change in sharpness, not
   in brightness, and the tier transition stays invisible.
   ============================================================ */

import { CAUSTIC_GLSL } from './cookie.js';
import { VIEW_RAY_GLSL, SHAFT_MARCH_GLSL, SHAFT_BILATERAL_SHARPNESS } from './shafts.js';

/**
 * Where the analytic column stops integrating, in metres. Only the
 * exponential's tail lives beyond it: the slowest-decaying case is blue looking
 * straight down, k = 0.202, and exp(-0.202 * 60) is 5.5e-6. §5.2's "saturates
 * to the far-field value at ~28 m, so there is no visible back wall" is a
 * property of the medium, not of this number.
 */
export const SEA_FAR_METRES = 60.0;

/**
 * Spec §2.3's Snell's-window term. Refraction packs the entire sky into a 97.2
 * degree cone overhead, so even after diffusion there is a real brightening
 * straight up. §4.5 clamps the camera to 25 degrees of elevation, so this only
 * ever touches the top edge of the frame — which is the intent. It is applied
 * unattenuated, exactly as §2.3 writes it.
 */
export const SNELL_GAIN = 0.0028;
export const SNELL_EDGE0 = 0.66;
export const SNELL_EDGE1 = 1.0;

/** GLSL float literal: always carries a decimal point. */
function f(x, digits = 6) {
  if (!Number.isFinite(x)) throw new Error(`sea.js: refusing to emit non-finite GLSL constant ${x}`);
  return x.toFixed(digits);
}

/**
 * Pass 2's fullscreen fragment shader. Pair it with FULLSCREEN_TRIANGLE_VS from
 * gl.js and draw three vertices into SEA before the snow and the behind-strands
 * are drawn over it. Blend may be left premultiplied, since this writes alpha 1
 * and therefore replaces; depth test and write off; cull off.
 *
 * Uniforms:
 *   uInvViewProj  mat4   inverse of the SEA camera's view-projection, INCLUDING
 *                        the 8 % guard-band overscan of §2.5
 *   uCamPos       vec3   camera position in render space
 *   uCamY         float  the camera's TRUE depth, negative, about -14. Must
 *                        equal uCamPos.y + uWorldOrigin.y; it is passed
 *                        separately so the buffered path needs no caustic
 *                        uniforms at all
 *   uShafts       sampler2D  RAYS, half res, RGBA16F   (buffered path only)
 *   uShaftRes     ivec2      RAYS' pixel size          (buffered path only)
 *   uFrame        float      frame counter             (inline path only)
 *
 * Defines:
 *   SEA_INLINE_SHAFTS  set on the tier-4 / RGBA8 path, where RAYS does not
 *                      exist; then SHAFT_STEPS should also be set to 8
 */
export const SEA_FS = `
uniform mat4  uInvViewProj;
uniform vec3  uCamPos;
uniform float uCamY;

#ifdef SEA_INLINE_SHAFTS
uniform float uFrame;
#else
uniform sampler2D uShafts;
uniform ivec2     uShaftRes;
#endif

in  vec2 vUV;
out vec4 fragColor;

// The RGBA8 fallback path writes SEA and FINAL pre-exposed by 1/8 so that a
// UNORM target can still carry a highlight; post.js undoes it with uHdrDecode.
// On the float path the define is simply absent and this is the identity.
#ifndef OUT_GAIN
#define OUT_GAIN 1.0
#endif

#define SEA_FAR ${f(SEA_FAR_METRES)}
#define SNELL_GAIN ${f(SNELL_GAIN)}
#define SNELL_EDGE0 ${f(SNELL_EDGE0)}
#define SNELL_EDGE1 ${f(SNELL_EDGE1)}
#define SHAFT_BILATERAL_SHARPNESS ${f(SHAFT_BILATERAL_SHARPNESS)}

#ifndef SEA_INLINE_SHAFTS
// Bilateral upsample of the half-res shaft buffer. The four taps are weighted
// by the usual bilinear kernel times a range term on the buffer's own mean
// scattering distance, so a shaft edge survives the 2x expansion instead of
// being smeared over two pixels. When the guide agrees across the taps every
// range term is exp(0) = 1 and this IS bilinear, to the bit.
vec3 upsampleShafts(vec2 uv){
  ivec2 hi   = uShaftRes - ivec2(1);
  vec2  fpos = uv * vec2(uShaftRes) - 0.5;
  vec2  base = floor(fpos);
  vec2  frc  = fpos - base;
  ivec2 i0   = ivec2(base);

  vec4 s00 = texelFetch(uShafts, clamp(i0,               ivec2(0), hi), 0);
  vec4 s10 = texelFetch(uShafts, clamp(i0 + ivec2(1, 0), ivec2(0), hi), 0);
  vec4 s01 = texelFetch(uShafts, clamp(i0 + ivec2(0, 1), ivec2(0), hi), 0);
  vec4 s11 = texelFetch(uShafts, clamp(i0 + ivec2(1, 1), ivec2(0), hi), 0);

  float b00 = (1.0 - frc.x) * (1.0 - frc.y);
  float b10 = frc.x         * (1.0 - frc.y);
  float b01 = (1.0 - frc.x) * frc.y;
  float b11 = frc.x         * frc.y;

  float guide = b00 * s00.a + b10 * s10.a + b01 * s01.a + b11 * s11.a;
  float k     = SHAFT_BILATERAL_SHARPNESS;

  float w00 = b00 * exp(-abs(s00.a - guide) * k);
  float w10 = b10 * exp(-abs(s10.a - guide) * k);
  float w01 = b01 * exp(-abs(s01.a - guide) * k);
  float w11 = b11 * exp(-abs(s11.a - guide) * k);

  vec3 sum = w00 * s00.rgb + w10 * s10.rgb + w01 * s01.rgb + w11 * s11.rgb;
  return sum / max(w00 + w10 + w01 + w11, 1e-5);
}
#endif

void main(){
  vec3 rd = seaViewRay(uInvViewProj, uCamPos, vUV);

  // An upward ray leaves the water; there is nothing past the surface for the
  // medium to scatter, so the integral stops there. Everything else runs to
  // SEA_FAR, by which point the exponential has closed.
  // The lower clamp is insurance only: uCamY is a depth and is negative, so
  // -uCamY is a positive distance to the surface. A positive uCamY would make
  // tMax negative and the exponential below would return negative radiance,
  // which is a black frame rather than an obviously wrong one.
  float tMax = rd.y > 1e-3 ? clamp(-uCamY / rd.y, 0.0, SEA_FAR) : SEA_FAR;

  // The closed form derived in this file's header. KD appears here and ONLY
  // here — it is the depth ramp, never a beam transmittance — and SIG_T_W
  // carries the path.
  vec3 k   = max(SIG_T_W - KD * rd.y, vec3(1e-4));
  vec3 col = inscatter(uCamY) * (SIG_T_W / k) * (1.0 - exp(-k * tMax));

  // Snell's window: the sky, compressed into a 97.2 degree cone overhead.
  col += SUN_E0 * SNELL_GAIN * smoothstep(SNELL_EDGE0, SNELL_EDGE1, rd.y);

#ifdef SEA_INLINE_SHAFTS
  col += marchShafts(uCamPos, rd, ign(gl_FragCoord.xy + uFrame * 7.0)).rgb;
#else
  col += upsampleShafts(vUV);
#endif

  fragColor = vec4(col * OUT_GAIN, 1.0);
}
`;

/**
 * Includes for the ordinary path, where the shafts come from the RAYS buffer.
 * The caustic field is not needed here — RAYS already carries it.
 */
export const SEA_INCLUDES = Object.freeze([VIEW_RAY_GLSL]);

/**
 * Includes for the tier-4 / RGBA8 path. Build with
 * `defines: { SEA_INLINE_SHAFTS: true, SHAFT_STEPS: 8 }` and bind the caustic
 * uniforms (uCookie, uCookieScale, uCookieDrift, uSunDir, uWorldOrigin) as well
 * as uFrame.
 */
export const SEA_INLINE_INCLUDES = Object.freeze([CAUSTIC_GLSL, VIEW_RAY_GLSL, SHAFT_MARCH_GLSL]);
