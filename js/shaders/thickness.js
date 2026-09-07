/* ============================================================
   shaders/thickness.js — the signed additive optical-depth pass.
   ------------------------------------------------------------
   This is spec §2.4, the centrepiece of the renderer, plus the
   two chunks the rest of the animal's shaders share with it.

   WHAT THE PASS DOES. Every piece of jelly geometry is drawn once
   with culling DISABLED, depth OFF and blend ONE/ONE into an
   RG16F target cleared to zero. Back faces add, front faces
   subtract, so the sum over all the layers a ray crosses is the
   total optical path INSIDE the animal (R) and the total
   geometric path inside it (G). Any number of layers, any
   concavity, one pass, no depth peeling. The double-walled bell,
   an oral arm folded underneath it and a tentacle behind it all
   sum correctly and automatically.

   WHY THE DEPTH IS RELATIVE. The obvious version accumulates
   s·viewZ·density and is unusable: at a 2.5 m camera distance an
   fp16 ulp is about 2 mm, so a 6 mm bell wall is three ulps and
   the rim bands and flickers as the camera drifts. Every fragment
   here is instead referenced to the bell's own front depth, read
   from the ZFRONT prepass at the same pixel:

       d = vViewZ - zFront

   The zFront term cancels inside every front/back pair, so the
   signed sum is mathematically identical — but each term is now
   O(1 cm) instead of O(2.5 m), one ulp is ~15 µm, and the wall is
   ~400 ulps instead of 3. Same arithmetic, ~160× the precision.
   Nothing else in this file matters as much as that subtraction.

   WHY DENSITY IS A PATTERN. Real mesoglea is 96 % water and very
   nearly clear. A constant scattering coefficient gives an
   invisible animal and cranking it gives wax. What a photograph
   of an Aurelia actually shows is structure — the coronal muscle
   ring, sixteen radial canals, the dense margin, four gonad
   horseshoes — so `density(φ,θ)` is a map of the anatomy, and
   because it is summed inside the integral those features show
   THROUGH the bell, correctly occluding and correctly adding
   where an arm folds beneath. A baked per-vertex thickness map
   cannot do that.

   The shadow variant is the same program rendered from the sun,
   256², into an R16F light-space optical depth. It re-renders
   every frame: it costs about 0.03 ms and a one-second cache
   would visibly lag a 2.2 s pulse. It cannot reference a ZFRONT
   texture (there is no sun-side prepass in the eight-pass graph),
   so it references a SCALAR reference distance instead — every
   piece of the animal is within ±0.2 m of the body centre, so one
   uniform buys the same O(1 cm) terms that the texture buys in
   the camera pass, for nothing.

   THIS FILE IMPORTS ONLY cookie.js, for the one caustic field.
   bell.js and strands.js import the two shared GLSL chunks from
   here, so the dependency runs one way and there is no module
   cycle to trip over.
   ============================================================ */

import { CAUSTIC_GLSL } from './cookie.js';

/* --- Shared numbers ----------------------------------------------------- */

/**
 * Read-side clamps from §2.4. `tau` is hard-limited so that an unsealed rim —
 * a single mis-wound triangle anywhere in the shell — cannot blow out to
 * infinity and paint a white band across the frame; `dGeo` is limited because
 * it drives the refraction march distance and a runaway value would fling the
 * background tap off the far side of the screen.
 */
export const THICK_TAU_CLAMP = 6.0;
export const THICK_GEO_CLAMP = 0.40;

/**
 * The attribute layout is NOT declared here. `js/geometry/bell.js` owns it —
 * it is the file that fills the buffer — and every program that draws or
 * measures the animal binds `BELL_ATTRIBUTE_LOCATIONS` from there, so the
 * ZFRONT prepass, the thickness pass, the sun-side shadow render and both
 * shading programs share one VertexArray and cannot possibly disagree about
 * where the bell is. That shared VAO is the precondition for the front-depth
 * subtraction below being valid at all.
 *
 * For reference, since every stage below reads it:
 *   aRest   (loc 0) vec3  rest position, METRES, bell frame, §3.5 baked in
 *   aUV     (loc 1) vec2  (φ, θ); φ normalised arc length, θ radians
 *   aParam2 (loc 2) vec4  (lappetGain, density, shellTag, thickScale)
 *   aNextS  (loc 3) vec4  (offset to the next ROW's rest position, dφ)
 *   aNextT  (loc 4) vec4  (offset to the next COLUMN's rest position, dθ)
 *
 * The gonad tubes and the manubrium use the identical format, so there is no
 * separate mesh path and no MESH_GEOMETRY define anywhere in the project. They
 * differ only in their shell tag, which is 2 and 3 rather than +1/0/−1.
 */

/* --- density(φ,θ), spec §2.4 -------------------------------------------- */

/**
 * The anatomy map, and the rim fringe that rides on it.
 *
 * `density` is §2.4 verbatim; do not retune it here. Every coefficient in it is
 * a visible feature of the animal and they are balanced against the `tau`
 * clamp above and the mesoglea coefficients in §2.0.
 *
 * `bellFringe` is the rim band's contribution from §3.1: the band that stitches
 * the two shells together carries a noise-modulated density term, which is what
 * produces the dense short-tentacle fringe around the margin without a single
 * extra triangle or draw call. It is periodic in θ by construction — the lobe
 * index is taken modulo the spoke count — so there is no seam at θ = 0, and it
 * is built on `hash11`, whose JS twin in math.js is bit-exact, so the CPU can
 * reproduce the same fringe if it ever needs to.
 */
export const DENSITY_GLSL = `
// ---- shaders/thickness.js: density(phi, theta), spec 2.4 ----
//
// THE GONAD TERM'S SMOOTHSTEPS RUN BACKWARDS, edge0 > edge1, and the ES 3.00
// specification calls that undefined. It is shipped exactly as section 2.4
// writes it, because every driver in existence computes
// t = clamp((x - edge0) / (edge1 - edge0), 0, 1) and that expression is
// perfectly well behaved for a descending pair -- it simply reads as "1 below
// edge1, 0 above edge0". math.js's JS smoothstep does the same thing, so the
// CPU bake in geometry/bell.js and this function agree today. If a driver is
// ever found on which the four gonad horseshoes vanish or fill the whole bell,
// the fix is one line and no retuning: replace each descending pair with
// 1.0 - smoothstep(lo, hi, x).
float density(float phi, float theta){          // phi: 0 apex -> 1 margin
  float bulk   = 1.0;
  float muscle = 3.2 * smoothstep(0.45, 0.95, phi);                 // coronal ring
  float canal  = 2.0 * pow(abs(cos(8.0*theta)), 24.0)               // 16 radial canals
                     * smoothstep(0.25, 0.90, phi);
  float rim    = 3.6 * smoothstep(0.88, 1.00, phi);                 // dense margin
  float gonad  = 2.4 * smoothstep(0.55, 0.20, abs(cos(2.0*theta)))  // 4 horseshoes
                     * smoothstep(0.58, 0.34, phi) * smoothstep(0.16, 0.30, phi);
  return bulk + muscle + canal + rim + gonad;
}

// The short-tentacle fringe of section 3.1. band is 0 on either shell and 1 in
// the middle of the rim band, so this is identically 1.0 everywhere except on
// the 0.78 mm strip of geometry that closes the margin.
#define BELL_FRINGE_SPOKES 192.0
float bellFringe(float phi, float theta, float band){
  if (band <= 0.0) return 1.0;
  float t  = theta / TAU * BELL_FRINGE_SPOKES;
  float i  = floor(t);
  float f  = fract(t);
  float a  = hash11(mod(i,       BELL_FRINGE_SPOKES) + 3.7);
  float b  = hash11(mod(i + 1.0, BELL_FRINGE_SPOKES) + 3.7);
  float n  = mix(a, b, f*f*(3.0 - 2.0*f));
  return 1.0 + band * (0.6 + 1.8 * n);
}

// The one place tissue density is resolved, so the thickness pass, the shadow
// render and the analytic fallback cannot answer the question differently.
//
// The bell evaluates density(phi, theta) PER FRAGMENT rather than reading a
// baked per-vertex value, because the sixteen radial canals are the sharpest
// term in it: pow(abs(cos(8*theta)), 24.0) has a half-width of 0.03 rad against
// an azimuthal cell of 0.039 rad at LOD0, so a per-vertex bake undersamples the
// canals and they alias into a coarse ripple. The gonad tubes and the manubrium
// are not bell wall and carry their own constant, which the mesh bakes into
// aParam2.y and the vertex stage forwards as 'baked'; a zero there means "this
// is bell, evaluate the pattern".
float jellyDensity(float phi, float theta, float baked, float fringe){
  return baked > 0.0 ? baked : density(phi, theta) * fringe;
}
`;

/* --- Shared lighting chunk ---------------------------------------------- */

/**
 * Everything the bell and the strands both need in order to be lit by the same
 * numbers: the mesoglea coefficients reduced by similarity theory, the sun's
 * sign convention, the caustic key, and the light-space shadow lookup.
 *
 * The caustic itself is not defined here. cookie.js owns `causticAt()`,
 * `seaWorld()`, `seaDepth()` and the `uSunDir` / `uCookie*` / `uWorldOrigin`
 * uniforms, and the shafts and the sea already include that chunk; the animal
 * includes exactly the same one. That is the whole point of §5.3 — the shafts
 * in open water, the ripple crawling over the bell and the twinkle on a snow
 * mote are the SAME fetch, so there is no separate godray system that can
 * disagree with the animal's key light.
 *
 * NOTE THE SUN CONVENTION, which cookie.js fixes and the whole project follows:
 * `uSunDir` points DOWN, along the direction the sunlight TRAVELS, so at the
 * spec's 72° elevation uSunDir.y ≈ −0.951. Every shading term below therefore
 * uses `L = -uSunDir` for the direction towards the light. Getting this
 * backwards flips every scattering phase in the frame.
 *
 * `shadowTransmittance` is the one place this file departs from a literal
 * reading of §2.5, and the reason is worth stating. The light-space map holds
 * the TOTAL optical depth of the animal along each sun ray; what a receiver
 * needs is the part of that column standing between it and the sun. Recovering
 * that exactly would need a second sun-side prepass, which the eight-pass graph
 * does not have. But for a closed convex-ish body the fraction is available for
 * free from the receiver's own orientation: a surface facing the sun IS the
 * entry point and is shadowed by none of the column, a surface facing away is
 * the exit point and is shadowed by all of it. `0.5 - 0.5·dot(N,L)` is exactly
 * that, it is continuous, it needs no bias tuning, and it produces the thing
 * §2.5 is actually after — a dark subumbrellar cavity under a bright dome, with
 * the oral arms' own column colouring the shadow they cast up into it.
 */
export const JELLY_LIGHTING_GLSL = `
// ---- shaders/thickness.js: shared jelly lighting ----

// Mesoglea, reduced by similarity theory at the use site as section 2.5 says.
vec3 gelSigmaS(){ return SIG_S_G * (1.0 - G_GEL); }
vec3 gelSigmaT(){ return SIG_A_G + gelSigmaS(); }
vec3 gelAlbedo(){ vec3 s = gelSigmaS(); return s / (SIG_A_G + s); }

// The direction TOWARDS the sun. uSunDir, declared by cookie.js, points the
// other way -- along the light's travel -- so this is where the sign is turned
// round, once, for every shader that lights the animal.
vec3 sunToward(){ return normalize(-uSunDir); }

// Scene-referred sun irradiance already carried down to the animal's depth,
// i.e. downwelling(seaDepth(bodyPos)). Never tinted blue -- every blue on
// screen is what survives absorption, not what was painted in.
uniform vec3 uSunCol;

// Amplitude 0.35 on the bell, per section 5.3. cookie.js normalises causticAt()
// to a mean of 1, so a straight mix towards it is already mean-preserving: the
// animal's average key light is unchanged and only its modulation depth moves.
// That matters more than it sounds -- a caustic that pumps mean luminance is a
// nameable effect, and section 10's rate budget forbids exactly that.
#define CAUSTIC_AMPLITUDE 0.35
float causticKey(vec3 renderPos){
  return mix(1.0, causticAt(renderPos), CAUSTIC_AMPLITUDE);
}

// Light-space optical depth, R16F, 256 squared, re-rendered every frame.
uniform sampler2D uShadowTau;
uniform mat4      uLightViewProj;
uniform vec2      uShadowTexel;     // 1.0 / shadow map size
uniform float     uShadowStrength;  // 0 disables the term entirely

float sampleShadowTau(vec3 worldPos){
  vec4 lp = uLightViewProj * vec4(worldPos, 1.0);
  if (lp.w <= 0.0) return 0.0;
  vec2 uv = (lp.xy / lp.w) * 0.5 + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  // The centre plus four diagonal neighbours, averaged. The shadow an oral arm
  // casts into the cavity has to be soft; a hard-edged one on a 256 squared map
  // reads as a bug rather than as a shadow.
  vec2 o = uShadowTexel * 1.5;
  float s = texture(uShadowTau, uv).r
          + texture(uShadowTau, uv + vec2( o.x,  o.y)).r
          + texture(uShadowTau, uv + vec2(-o.x,  o.y)).r
          + texture(uShadowTau, uv + vec2( o.x, -o.y)).r
          + texture(uShadowTau, uv + vec2(-o.x, -o.y)).r;
  return max(s * 0.2, 0.0);
}

// fraction is how much of the accumulated column stands between this point and
// the sun; see the note in the module header for why it is an orientation term.
vec3 shadowTransmittance(vec3 worldPos, float fraction){
  float tau = sampleShadowTau(worldPos) * clamp(fraction, 0.0, 1.0) * uShadowStrength;
  return exp(-gelSigmaT() * min(tau, ${THICK_TAU_CLAMP.toFixed(1)}));
}
`;

/* --- The pass itself ----------------------------------------------------- */

/**
 * The shared vertex stage for ZFRONT (pass 3), THICK (pass 4) and the sun-side
 * shadow render. It deliberately reads the rest position straight out of the
 * VBO and deforms it with `bellDeform()` from js/sim/deform.js — the same
 * function, from the same file, that places the tentacle roots on the CPU — so
 * the geometry rasterised here is the geometry the shading pass rasterises. If
 * the two ever differed by a float, the front-depth subtraction would leave a
 * residue and the rim would glow, which is exactly the artefact §10 asks to be
 * verified away by sweeping the camera from 1.9 m to 3.2 m.
 *
 * Requires, in the include list: COMMON_GLSL, DENSITY_GLSL and sim/deform.js's
 * DEFORM_GLSL. It does NOT need the profile chunk: the rest surface, with all
 * of §3.1's sculpting and §3.5's baked imperfection already in it, arrives in
 * `aRest`.
 *
 * `SHADOW_PASS` changes nothing here; it is a fragment-stage define. The sun
 * view is expressed entirely through uViewProj and uCameraPos.
 */
export const THICKNESS_VS = `
layout(location = 0) in vec3 aRest;
layout(location = 1) in vec2 aUV;       // (phi, theta)
layout(location = 2) in vec4 aParam2;   // (lappetGain, density, shellTag, thickScale)

uniform mat4  uViewProj;
uniform mat4  uModel;
uniform vec3  uCameraPos;

// The deformation state, shared with the shading programs. uPhase is an
// ACCUMULATED CYCLE COUNT from sim/swim.js, not uTime*uFreq: section 4.1's
// period wanders, jitters and occasionally doubles, and multiplying a changed
// frequency by absolute time teleports the phase.
uniform float uPhase;
uniform float uAmp;
uniform float uTwistTime;
uniform float uBellRadius;

out float vViewZ;      // positive distance from eye, this fragment
out float vPhi;
out float vTheta;
out float vBaked;      // constant density for the interior organs, 0 for bell
out float vFringe;     // section 3.1's rim-band fringe modulation

void main(){
  vec3 local = bellDeform(aRest, aUV.x, uPhase, aParam2.x, uAmp, uTwistTime, uBellRadius);
  vec4 world = uModel * vec4(local, 1.0);

  // The rim band is the only place the fringe is non-unit: the shell tag is +1
  // on the exumbrella, -1 on the subumbrella and 0 through the band, so this
  // peaks at 1 in the middle of the band and is 0 everywhere else. The gonad
  // and manubrium tags (2 and 3) drive it negative, which bellFringe reads as
  // "not the rim" and returns exactly 1.0 for.
  float band = 1.0 - abs(aParam2.z);
  vFringe = bellFringe(aUV.x, aUV.y, band);
  vBaked  = aParam2.z > 1.5 ? aParam2.y : 0.0;
  vPhi    = aUV.x;
  vTheta  = aUV.y;

  // Distance, not view-space z. ZFRONT stores the same quantity at the same
  // pixel, so the two are subtracted along the same ray and the difference is
  // the true path length between the two surfaces.
  vViewZ      = length(uCameraPos - world.xyz);
  gl_Position = uViewProj * world;
}
`;

/**
 * §2.4's fragment stage, with the read-side guards the flaw report demanded.
 *
 * Two variants:
 *   default        RG16F target, relative to the ZFRONT texture at this pixel.
 *   SHADOW_PASS    R16F target, relative to the scalar `uRefZ`. The sun-side
 *                  render has no prepass to reference, and it does not need
 *                  one: the whole animal fits in a 0.4 m box, so a single
 *                  distance to the body centre keeps every term at O(1 cm)
 *                  just as the texture does for the camera.
 */
export const THICKNESS_FS = `
in float vViewZ;      // positive distance from eye, this fragment
in float vPhi;
in float vTheta;
in float vBaked;
in float vFringe;

#ifdef SHADOW_PASS
uniform float uRefZ;  // light-space distance to the body centre, metres
out float fragColor;
#else
uniform sampler2D uZFront;
uniform vec2      uInvRes;
out vec2 oThick;
#endif

void main(){
  // ---- THE FIX ----------------------------------------------------------
  // Reference every layer to the bell's own front depth. The signed sum is
  // mathematically unchanged, but each term is now O(1 cm) instead of O(2.5 m).
  // fp16 ulp at magnitude 0.02 is ~15 um; a 6 mm wall is ~400 ulps instead of 3.
#ifdef SHADOW_PASS
  float zf = uRefZ;
#else
  float zf = texture(uZFront, gl_FragCoord.xy * uInvRes).r;
#endif
  float d  = vViewZ - zf;                 // relative depth, metres
  // -----------------------------------------------------------------------
  float s = gl_FrontFacing ? -1.0 : 1.0;  // back faces add, front faces subtract
  float rho = jellyDensity(vPhi, vTheta, vBaked, vFringe);

#ifdef SHADOW_PASS
  fragColor = s * d * rho;
#else
  oThick = vec2(s * d * rho, s * d);
#endif
}
`;

/**
 * Pass 3. The front-depth prepass whose output the subtraction above is
 * relative to: bell front faces only, cull BACK, depth test and write ON,
 * blend off, into an R16F target. It shares THICKNESS_VS, so the depth it
 * writes is measured with exactly the same arithmetic that reads it back.
 *
 * The clear value matters: clear ZFRONT to a large distance, not to zero. A
 * pixel with no bell in it must not turn every stray fragment's `d` into an
 * absolute distance again.
 *
 * A fragment stage is free to leave a vertex output unread, so this one
 * declares only the varying it uses.
 */
export const ZFRONT_FS = `
in float vViewZ;
out float fragColor;

void main(){
  fragColor = vViewZ;
}
`;

/**
 * The GLSL chunks this module contributes to a program's include list, in
 * order: cookie.js's caustic chunk first (JELLY_LIGHTING_GLSL calls into it),
 * then DENSITY_GLSL, which uses `hash11` and `TAU` from §2.0, then the lighting
 * helpers. Nothing here redefines anything from §2.0 or from cookie.js.
 *
 * Do NOT append cookie.js's CAUSTIC_GLSL again alongside this list — it is
 * already in it, and a second copy is a redefinition error at link time.
 * bell.js re-exports these inside its own list so that a caller building any of
 * the animal's programs passes exactly one array.
 */
export const THICKNESS_GLSL_INCLUDES = Object.freeze([
  CAUSTIC_GLSL,
  DENSITY_GLSL,
  JELLY_LIGHTING_GLSL
]);
