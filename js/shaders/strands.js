/* ============================================================
   shaders/strands.js — oral arms and tentacles.
   ------------------------------------------------------------
   Spec §2.6. One vertex stage and one fragment stage serve both
   the 40 tentacles and the 4 oral arms; the arms differ only in
   the density they carry and in the ruffled five-point cross-
   section their packer emits.

   TENTACLES ARE SCATTERERS, NOT SURFACES. This is the whole idea
   and it is worth stating plainly: a 1 mm translucent thread
   genuinely IS a low-density scatterer with a soft cross-section,
   not a hard boundary with an interior. Rendering it as one
   deletes the entire class of thin-geometry aliasing in a single
   move -- there is no silhouette, so there is nothing to alias,
   so there is no need for MSAA, no need for WBOIT, and no reason
   to drop to half resolution. Strands draw full-res, soft-edged,
   with a per-strand CPU depth sort. Forty chains sort in
   microseconds and the granularity error is invisible on an
   object that has no edge.

   WBOIT was dropped for a reason that is specific to this page:
   its weight function has a narrow usable range, and outside it
   the bundle collapses to a flat grey-blue smear. In a one-hue
   palette there is no chroma difference left to rescue that.

   THE TWO THINGS THAT MUST NOT BE TOUCHED. First, the exponent
   1.6 on the cross-section: a plain Gaussian reads as smoke and a
   hard edge aliases, and 1.6 is the value that gives a definite
   core with no boundary. Second, the screen-space minimum width
   with compensating alpha -- without it a 4K render shimmers into
   static, because a sub-pixel-wide ribbon is sampled or missed at
   random per frame. The geometry is widened to a 1.4 px floor and
   the alpha is scaled down by exactly the widening, so the total
   energy the strand puts on screen is unchanged and the tentacle
   simply fades instead of sparkling.

   This module imports only the shared lighting chunk, so that the
   strands are lit by the same mesoglea coefficients, the same sun
   and the same shadow map as the bell. A thread whose albedo
   disagrees with the animal it hangs from is immediately legible.
   ============================================================ */

import { CAUSTIC_GLSL } from './cookie.js';
import { JELLY_LIGHTING_GLSL } from './thickness.js';

/* --- Shared numbers ----------------------------------------------------- */

/**
 * §2.6's screen-space floor, in pixels. The fragment stage divides by this
 * exact number to compensate the alpha, so the two must stay equal — they are
 * emitted from this one constant into both stages.
 */
export const STRAND_MIN_WIDTH_PX = 1.4;

/** §3.4: world half-width of a tentacle ribbon, in metres. */
export const TENTACLE_HALF_WIDTH = 0.0009;

/**
 * §2.6's supergaussian. `exp(-pow(r*1.45, 1.6))`, r measured from the spine to
 * the ribbon edge. Exported so a ?dev=1 panel can plot it against the packer's
 * cross-section without duplicating the numbers.
 */
export const STRAND_FALLOFF_SCALE = 1.45;
export const STRAND_FALLOFF_EXPONENT = 1.6;

/**
 * How much of the light-space optical-depth column stands between a strand and
 * the sun. A thread is thin enough to contribute almost nothing to the column
 * it is reading, so essentially everything the map holds at that texel — the
 * bell above it, an arm beside it — is in front of it. The bell computes this
 * from its own orientation instead; see thickness.js.
 */
export const STRAND_SHADOW_FRACTION = 0.85;

/**
 * Attribute locations. These are geometry/strands.js's — it is the file that
 * fills the buffer — and both the tentacle strips and the oral-arm ribbons use
 * the layout, so one program draws both and the per-frame packer emits one
 * vertex format.
 *
 *   aPos      vec3   spine node position in METRES, render space (floating
 *                    origin — the animal stays near p ≈ 0 and the sea scrolls).
 *                    BOTH edge vertices of a node carry the same spine point.
 *   aTangent  vec3   unit tangent along the spine at this node. The ribbon is
 *                    turned to face the camera here rather than on the CPU, so
 *                    it is exactly edge-on-free at every pixel and the packer
 *                    does not have to know where the camera is.
 *   aParam2   vec4   (across, halfWidth m, density, ruffle m)
 *                    across is -1 at one edge and +1 at the other, taking the
 *                    intermediate values -0.5, 0, +0.5 on the arms' five-point
 *                    section. ruffle is §3.3's out-of-plane displacement, in
 *                    metres, and is zero for every tentacle.
 *
 * §3.3's frill is computed by the packer, not here. It is a modulation of the
 * half-width on RETARDED time — the wave arrives lower down the arm later —
 * and the packer already has the node's depth below its own root, which the
 * vertex shader does not: aPos.y is a scene coordinate, and the animal is not
 * at the scene origin. Putting the frill in the shader would make the ribbon's
 * width disagree with the ruffle the packer computed for the same node.
 */
export const STRAND_ATTRIBUTE_LOCATIONS = Object.freeze({
  aPos: 0,
  aTangent: 1,
  aParam2: 2
});

/* --- Vertex stage -------------------------------------------------------- */

/**
 * Builds the camera-facing ribbon and does the minimum-width widening.
 *
 * UNIFORMS
 *   uViewProj      mat4
 *   uCameraPos     vec3, render space
 *   uWorldOrigin   vec3, declared by cookie.js's caustic chunk: the true world
 *                  position of the render origin, so seaDepth() can turn a
 *                  render-space y into the TRUE depth the medium is asked
 *                  about. Every depth handed to downwelling(), inscatter() or
 *                  waterApply() has to be that one; getting the sign or the
 *                  offset wrong is the easiest mistake in the project.
 *   uPixelScale    float, pixels per metre at one metre of view distance, i.e.
 *                  0.5 · viewportHeightPx / tan(fovY/2). One CPU-side number
 *                  instead of unpacking the projection matrix in the shader.
 */
export const STRAND_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aTangent;
layout(location = 2) in vec4 aParam2;   // (across, halfWidth m, density, ruffle m)

uniform mat4  uViewProj;
uniform vec3  uCameraPos;
uniform float uPixelScale;
/* Zero for the tentacles, the bell's axis for the oral arms. See below. */
uniform vec3  uRibbonAxis;

out vec3  vWorldPos;
out float vAcross;
out float vDensity;
out float vViewDist;
out float vWorldY;
out float vWorldWidthPx;

#define STRAND_MIN_WIDTH_PX ${STRAND_MIN_WIDTH_PX}

void main(){
  vec3  toEye = uCameraPos - aPos;
  float dist  = max(length(toEye), 1e-4);
  vec3  V     = toEye / dist;

  // The ribbon lies across the spine and faces the camera. When the spine points
  // straight at the eye the cross product degenerates; any perpendicular will do
  // there, because a ribbon seen exactly end-on covers no pixels either way.
  vec3  T = normalize(aTangent);
  vec3  fallback = normalize(abs(T.y) < 0.9 ? cross(T, vec3(0.0, 1.0, 0.0))
                                            : cross(T, vec3(1.0, 0.0, 0.0)));

  /*
   * A tentacle is a tube: it has no orientation of its own, so its strip is
   * built across the eye vector and is broadside from everywhere. An oral arm
   * is a SHEET, and billboarding one is what turned four ribbons into four
   * sails that never once showed their edge -- the single most artificial thing
   * about the animal. Given the bell's axis the ribbon lies in the plane the
   * arm hangs in, so the camera sees it broadside from one side of the animal,
   * foreshortened as it swings past, and as a bright thread edge-on. It is also
   * what lets the arms cross each other visibly instead of sliding through one
   * another as four parallel cards.
   */
  float axisLen = length(uRibbonAxis);
  vec3  B;
  if (axisLen > 0.5) {
    B = cross(T, uRibbonAxis / axisLen);
  } else {
    B = cross(T, V);
  }
  float bl = length(B);
  B = bl > 1e-4 ? B / bl : fallback;

  float halfW = max(aParam2.y, 1e-6);

  // The projected width BEFORE widening, foreshortened by how far the ribbon
  // has turned away from the eye. the face term is identically 1 for the tentacles,
  // whose B is perpendicular to V by construction, so their arithmetic is
  // unchanged; for an arm it is what makes an edge-on ribbon thin instead of
  // just as wide as a broadside one. The fragment stage divides by the same
  // floor to take back exactly the energy this widening adds.
  float bv   = dot(B, V);
  float face = sqrt(max(1.0 - bv * bv, 0.0));
  float widthPx = 2.0 * halfW * uPixelScale * face / dist;
  float expand  = max(1.0, STRAND_MIN_WIDTH_PX / max(widthPx, 1e-5));

  // §3.3's ruffle, out of the ribbon plane. Ignoring aParam2.w would still give
  // a correct ribbon, merely a flat one; N is the ribbon's own face normal, so
  // the displacement is the one direction the camera-facing widening cannot see.
  vec3 N = cross(B, T);
  vec3 world = aPos + B * (aParam2.x * halfW * expand) + N * aParam2.w;

  vWorldPos     = world;
  vAcross       = aParam2.x;
  vDensity      = aParam2.z;
  vWorldWidthPx = widthPx;
  vViewDist     = length(uCameraPos - world);
  vWorldY       = seaDepth(world);

  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

/* --- Fragment stage ------------------------------------------------------ */

/**
 * §2.6 verbatim, with the shared lighting chunk supplying the albedo, the sun
 * and the shadow lookup.
 *
 * The output is PREMULTIPLIED, matching passes 2 and 6. There is no depth test
 * and no depth write anywhere in the strand draws: ordering is per-strand and
 * done on the CPU, which is the right granularity for an object with no
 * silhouette and means a strand crossing the rim gets fogged rather than
 * clipped.
 *
 * OUT_GAIN carries the RGBA8 path's fixed pre-exposure; it is 1.0 on the float
 * path and the define is simply absent there.
 */
export const STRAND_FS = `
in vec3  vWorldPos;
in float vAcross;
in float vDensity;
in float vViewDist;
in float vWorldY;
in float vWorldWidthPx;

#ifndef OUT_GAIN
#define OUT_GAIN 1.0
#endif

#define STRAND_MIN_WIDTH_PX     ${STRAND_MIN_WIDTH_PX}
#define STRAND_FALLOFF_SCALE    ${STRAND_FALLOFF_SCALE}
#define STRAND_FALLOFF_EXPONENT ${STRAND_FALLOFF_EXPONENT}
#define STRAND_SHADOW_FRACTION  ${STRAND_SHADOW_FRACTION}

uniform vec3 uCameraPos;
uniform float uCoverage;

out vec4 fragColor;

void main(){
  // Supergaussian cross-section: a definite core, no hard edge, no silhouette.
  // Exponent 1.6 -- a plain Gaussian reads as smoke, a hard edge aliases.
  float r = abs(vAcross);
  float a = exp(-pow(r * STRAND_FALLOFF_SCALE, STRAND_FALLOFF_EXPONENT));

  // A tentacle is a tube: what it covers across the screen is also what the
  // ray travels through, so the profile above IS its opacity. An oral arm is a
  // SHEET -- twelve centimetres wide and a couple of millimetres thick -- and
  // reading its width as its depth turned four ribbons into opaque sails that
  // hid the entire animal behind them. uCoverage is that geometry correction,
  // one number per draw call: 1 for the tentacles, the arms' thickness-to-width
  // ratio for the arms. It scales the premultiplied colour with the alpha,
  // which is right -- less tissue on the ray scatters proportionally less.
  a *= uCoverage;

  // Screen-space minimum width with compensating alpha: without this a 4K render
  // shimmers into static.
  a *= min(1.0, vWorldWidthPx / STRAND_MIN_WIDTH_PX);

  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 L = sunToward();          // uSunDir points along the light's TRAVEL
  vec3 alb = gelAlbedo();
  vec3 shadowG = shadowTransmittance(vWorldPos, STRAND_SHADOW_FRACTION);

  // The ambient term is the water's own radiance, undiminished. It used to
  // carry a 0.5, and that is the slip the exumbrella's ambient dome had in its
  // 0.6: a strand's cross-section IS its opacity here, so at the spine the
  // ribbon replaces the column behind it outright, and mesoglea -- sea water
  // with a little collagen in it -- cannot return half the radiance of the
  // water standing in its place. The visible cost was that every tentacle
  // crossing the bell stamped a dark line into it, 52 % below the tissue
  // around it, which is what made forty threads read as forty wires.
  vec3 sc = alb * uSunCol * hg(dot(-L, V), 0.55) * vDensity * shadowG
          + inscatter(vWorldY);
  vec3 col = waterApply(sc, vViewDist, vWorldY);
  fragColor = vec4(col * a * OUT_GAIN, a);          // premultiplied
}
`;

/**
 * The include list for the strand program: cookie.js's caustic chunk, which is
 * where uSunDir, uWorldOrigin and seaDepth() come from, then the shared jelly
 * lighting. PROFILE_GLSL and the deform chunk are deliberately NOT pulled in —
 * the strand shape comes from the verlet solver on the CPU, and a shader that
 * cannot evaluate the bell cannot silently start disagreeing with it.
 *
 * Do not append CAUSTIC_GLSL again; it is already the first element.
 */
export const STRAND_GLSL_INCLUDES = Object.freeze([CAUSTIC_GLSL, JELLY_LIGHTING_GLSL]);
