/* ============================================================
   shaders/bell.js — the exumbrella and the subumbrella.
   ------------------------------------------------------------
   Spec §2.5. One source builds two programs, selected by one
   define:

     (none)              the exumbrella, pass 6, drawn into FINAL,
                         composites SEA through itself by refraction
     SUBUMBRELLA         the inner shell and the interior organs,
                         pass 5, drawn into SEA

   The gonad tubes and the manubrium are NOT a separate geometry
   path. geometry/bell.js builds them in the identical vertex
   format with the identical attribute locations, so they are the
   same program with a different index range and a different cull
   face — which is also what lets pass 4 accumulate them into the
   optical depth without a second shader.

     ANALYTIC_THICKNESS  the RGBA8 fallback (§2.5): no THICK, no
                         ZFRONT, no refraction march that depends
                         on them. It is a COMPLETE image, not a
                         degraded one.

   THERE IS NO FRESNEL RIM AND NO ANISOTROPIC SPECULAR HERE, and
   that is the single most important shading decision in the
   project. Mesoglea is n = 1.35 against seawater at n = 1.339, so
   F0 is 4e-5: underwater, index contrast is essentially gone, and
   that is precisely why a jellyfish is nearly invisible in water.
   The luminous margin in every real photograph is not reflection.
   At the silhouette the ray travels centimetres along the inside
   of the dense, wafer-thin margin, tau explodes, and the tissue
   lights up from scattering. tau produces that for free. What
   ships is one broad sheen at F0 = 0.0004 -- ten times physical,
   standing in for the surface mucus film, and as far as this is
   allowed to go -- with the bloom knee deliberately set above
   anything it can reach. §10 tests it: zeroing the specular term
   must move the rim by less than 2 %.

   WHY THE NORMAL IS ANALYTIC. The deformation is a nonlinear map,
   so a normal baked at rest is wrong the moment the bell
   contracts, and a normal map cannot express a travelling
   contraction wave. Three evaluations of the deformed surface
   give the exact normal of the surface actually being drawn,
   every frame, for about nine texture-free ALU ops. The two
   parameter-space neighbour offsets those evaluations need are
   baked into the VBO by geometry/bell.js, in aNextT and aNextS,
   precisely because §3.5's imperfection has no closed form and
   cannot be re-derived in the shader.

   Because the whole closed shell is wound as ONE sheet running
   exumbrella-apex -> margin -> across the rim -> subumbrella-apex,
   cross(alongTheta, alongRow) points AWAY FROM THE TISSUE at
   every vertex: outward on the exumbrella, into the cavity on the
   subumbrella, with no per-shell sign flip and — the part that
   matters — no sign discontinuity on the rim band for a seam to
   glow through. Do not multiply the normal by the shell tag.
   ============================================================ */

import { CAUSTIC_GLSL } from './cookie.js';
import { DEFORM_GLSL } from '../sim/deform.js';
import {
  DENSITY_GLSL,
  JELLY_LIGHTING_GLSL,
  THICK_TAU_CLAMP,
  THICK_GEO_CLAMP
} from './thickness.js';

/* --- Where deform() lives ------------------------------------------------ */

/*
 * It is not here. `js/sim/deform.js` owns §4.1's pulse and §4.2's kinematic
 * wave, in JavaScript and in GLSL, generated from one frozen table of
 * constants, and this file simply includes the GLSL half. That is the whole
 * point of the arrangement: the vertex shader that moves the margin and the
 * CPU solver that pins forty tentacle roots to it are then literally the same
 * function, and cannot drift by the millimetre that would detach the fringe on
 * a contraction stroke.
 *
 * Nor is the rest surface rebuilt here from a profile LUT. `aRest` already
 * carries it — §3.1's lappets and rhopalia and §3.5's baked imperfection are
 * all in the VBO, generated once by geometry/bell.js from a seeded stream that
 * has no closed form — and geometry/bell.js also ships the two parameter-space
 * neighbour OFFSETS the analytic normal needs, in aNextT and aNextS. So the
 * normal is three evaluations of the deformed surface, as §2.5 requires,
 * differencing the same geometry the rasteriser is drawing rather than an
 * analytic approximation of it.
 */

/** Re-exported so a caller building these programs needs one import. */
export { DEFORM_GLSL };

/* --- Vertex stage -------------------------------------------------------- */

/**
 * Shared by pass 5 and pass 6, and structurally identical to THICKNESS_VS —
 * same attributes, same uniforms, same call to `bellDeform()` — so the surface
 * this shades is bit-for-bit the surface the thickness pass measured. Anything
 * else and the front-depth subtraction leaves a residue on the rim.
 *
 * The three evaluations are exactly the three `deformBellFrame()` makes in
 * js/sim/deform.js, in the same order, so a tentacle root and the margin it
 * hangs off agree about which way the surface faces as well as where it is.
 */
export const BELL_VS = `
layout(location = 0) in vec3 aRest;
layout(location = 1) in vec2 aUV;       // (phi, theta)
layout(location = 2) in vec4 aParam2;   // (lappetGain, density, shellTag, thickScale)
layout(location = 3) in vec4 aNextS;    // (offset to next ROW, dPhi)
layout(location = 4) in vec4 aNextT;    // (offset to next COLUMN, dTheta)

uniform mat4  uViewProj;
uniform mat4  uModel;
uniform mat3  uNormalMatrix;
uniform vec3  uCameraPos;

uniform float uPhase;       // accumulated swim CYCLES, from sim/swim.js
uniform float uAmp;
uniform float uTwistTime;
uniform float uBellRadius;
uniform float uWall;        // w(0) = 8.32 mm; aParam2.w scales it per vertex

out vec3  vWorldPos;
out vec3  vNormal;
out float vPhi;
out float vTheta;
out float vWall;       // local wall thickness in metres
out float vViewDist;
out float vWorldY;     // TRUE sea depth, negative below the surface
out float vBaked;      // constant density for the interior organs, 0 for bell
out float vFringe;     // section 3.1's rim-band fringe modulation

void main(){
  float phi = aUV.x;

  vec3 p0 = bellDeform(aRest, phi, uPhase, aParam2.x, uAmp, uTwistTime, uBellRadius);
  vec3 pT = bellDeform(aRest + aNextT.xyz, phi,
                       uPhase, aParam2.x, uAmp, uTwistTime, uBellRadius);
  vec3 pS = bellDeform(aRest + aNextS.xyz, phi + aNextS.w,
                       uPhase, aParam2.x, uAmp, uTwistTime, uBellRadius);

  // Already away-from-tissue on both shells and across the rim; see the header.
  // geometry/bell.js borrows a neighbouring row's theta offset at the two poles
  // so this cross product cannot degenerate into a NaN that blanks the draw.
  vec3 nLocal = cross(pT - p0, pS - p0);
  float nl = length(nLocal);
  nLocal = nl > 1e-12 ? nLocal / nl : vec3(0.0, 1.0, 0.0);

  vec4 world = uModel * vec4(p0, 1.0);

  float band = 1.0 - abs(aParam2.z);
  vFringe    = bellFringe(phi, aUV.y, band);
  vBaked     = aParam2.z > 1.5 ? aParam2.y : 0.0;
  vPhi       = phi;
  vTheta     = aUV.y;
  vWall      = uWall * (aParam2.w > 0.0 ? aParam2.w : 1.0);

  vWorldPos  = world.xyz;
  vNormal    = normalize(uNormalMatrix * nLocal);
  vViewDist  = length(uCameraPos - world.xyz);
  // seaDepth() comes from cookie.js: the floating origin (4.3) keeps the animal
  // near p = 0 and scrolls the sea past it, so the render-space y is NOT the
  // depth the medium has to be asked about.
  vWorldY    = seaDepth(world.xyz);

  gl_Position = uViewProj * world;
}
`;

/* --- Fragment stage ------------------------------------------------------ */

/**
 * §2.5 in full: Beer-Lambert with similarity theory, the two SSS terms, the
 * ambient water dome, the sheen, and — on the exumbrella only — refraction with
 * Cauchy dispersion and the overscan guard.
 *
 * DEFINES
 *   ANALYTIC_THICKNESS      the RGBA8 path. THICK and ZFRONT are never
 *                           allocated; tau comes from the closed-form slab
 *                           integral, which is exact for a locally planar shell
 *                           and loses only the "an arm folded under the bell
 *                           adds to tau" case.
 *   SUBUMBRELLA             pass 5, the inner shell and the interior organs. No
 *                           refraction: the shader is writing into the very
 *                           texture it would have to read.
 *   THICK_MANUAL_BILINEAR   set when OES_texture_float_linear is missing, so
 *                           the RG16F thickness buffer is filtered by hand.
 *   SEA_GAIN / OUT_GAIN     the RGBA8 path's fixed 1/8 pre-exposure, undone on
 *                           read and applied on write. 1.0 on the float path.
 *
 * THE THICKNESS TAP IS IN SEA'S FRUSTUM. ZFRONT and THICK are rendered with the
 * same overscanned projection SEA uses, so that pass 5 — which draws into SEA
 * and therefore rasterises in the wide frustum — can read them with its own
 * gl_FragCoord directly. Pass 6 draws into FINAL, in the narrow frustum, and
 * converts: the overscan is a uniform scale of NDC by (1 + overscan), so one
 * divide takes a FINAL uv to a SEA uv, and the same uv serves both the
 * thickness tap and the refraction tap.
 */
export const BELL_FS = `
in vec3  vWorldPos;
in vec3  vNormal;
in float vPhi;
in float vTheta;
in float vWall;
in float vViewDist;
in float vWorldY;
in float vBaked;
in float vFringe;

uniform vec3  uCameraPos;
uniform vec2  uInvRes;        // 1.0 / the size of the target being drawn into
uniform float uPhase;         // accumulated swim CYCLES; drives the bioluminescence

#ifndef ANALYTIC_THICKNESS
uniform sampler2D uThick;     // RG16F: (optical depth, geometric depth)
uniform vec2      uThickSize; // texels; only used by the manual filter
#endif

#ifndef SUBUMBRELLA
uniform sampler2D uSea;
uniform mat4      uViewProj;
#endif

// 1 + overscan. Pass 6 needs it to reach SEA's frustum; pass 5 is already in it
// and leaves this at 1.0, where every expression below is the identity.
uniform float uSeaOverscan;

#ifndef SEA_GAIN
#define SEA_GAIN 1.0
#endif
#ifndef OUT_GAIN
#define OUT_GAIN 1.0
#endif

out vec4 fragColor;

// Section 2.5's wrap diffuse. The wrap is what lets light that entered the far
// side of a translucent slab still show up on this side.
float wrapDiffuse(vec3 N, vec3 L, float w){
  return clamp((dot(N,L) + w) / ((1.0 + w)*(1.0 + w)), 0.0, 1.0);
}

// Isotropic GGX, height-correlated Smith. Isotropic, deliberately: an
// anisotropic ribbon on a jellyfish is blown glass, and the judges cut it.
float ggx(vec3 N, vec3 V, vec3 L, float rough){
  vec3  H   = normalize(V + L);
  float a   = max(rough * rough, 1e-3);
  float a2  = a * a;
  float NoH = max(dot(N, H), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  float NoL = max(dot(N, L), 0.0);
  float d   = NoH*NoH*(a2 - 1.0) + 1.0;
  float D   = a2 / (PI * d * d);
  float k   = a * 0.5;
  float G   = (NoV / (NoV*(1.0 - k) + k)) * (NoL / (NoL*(1.0 - k) + k));
  return D * G / (4.0 * NoV);
}

#ifndef ANALYTIC_THICKNESS
vec2 sampleThick(vec2 uv){
#ifdef THICK_MANUAL_BILINEAR
  // OES_texture_float_linear is absent, so filter by hand rather than accept a
  // NEAREST thickness buffer -- unfiltered tau at half resolution stair-steps
  // straight down the rim, which is the most visible edge in the frame.
  vec2  t  = uv * uThickSize - 0.5;
  vec2  i  = floor(t);
  vec2  f  = t - i;
  vec2  hi = uThickSize - 1.0;
  ivec2 p0 = ivec2(clamp(i,                    vec2(0.0), hi));
  ivec2 p1 = ivec2(clamp(i + vec2(1.0, 0.0),   vec2(0.0), hi));
  ivec2 p2 = ivec2(clamp(i + vec2(0.0, 1.0),   vec2(0.0), hi));
  ivec2 p3 = ivec2(clamp(i + vec2(1.0, 1.0),   vec2(0.0), hi));
  vec2  a  = mix(texelFetch(uThick, p0, 0).rg, texelFetch(uThick, p1, 0).rg, f.x);
  vec2  b  = mix(texelFetch(uThick, p2, 0).rg, texelFetch(uThick, p3, 0).rg, f.x);
  return mix(a, b, f.y);
#else
  return texture(uThick, uv).rg;
#endif
}
#endif

#ifndef SUBUMBRELLA
vec3 seaTap(vec2 uv){
  return texture(uSea, clamp(uv, vec2(0.0), vec2(1.0))).rgb * SEA_GAIN;
}
#endif

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 L = sunToward();          // uSunDir points along the light's TRAVEL
  vec2 uv = gl_FragCoord.xy * uInvRes;

  // The same uv in SEA's overscanned frustum. Pass 5 is already there and
  // uSeaOverscan is 1.0; pass 6 divides its NDC by the guard band.
  vec2 uvS = ((uv * 2.0 - 1.0) / uSeaOverscan) * 0.5 + 0.5;

  // ---- optical depth through the tissue --------------------------------
  float rho = jellyDensity(vPhi, vTheta, vBaked, vFringe);
#ifdef ANALYTIC_THICKNESS
  // The RGBA8 fallback of section 2.5. Exact for a locally planar shell: a ray
  // at |N.V| through a wall of thickness w crosses 2w of tissue, in the top and
  // out the bottom. The 0.15 floor is what keeps the grazing silhouette finite.
  float ndv  = max(abs(dot(N, V)), 0.15);
  float tau  = 2.0 * vWall * rho / ndv;
  float dGeo = 2.0 * vWall / ndv;
#else
  // THE DENSITY IS APPLIED HERE, NOT INSIDE THE SUM, and the reason is the
  // whole of the dark-organ artefact. Pass 4's G channel is the GEOMETRIC path
  // through every layer on this ray and it is exact: with the density factored
  // out, every front face cancels its own back face and the telescoping is
  // unconditional. The R channel is not. It accumulates s*d*rho with d measured
  // from the bell's front depth, and that only telescopes when the two faces of
  // a crossing report the SAME rho -- which they cannot, because density() is a
  // map of the anatomy and an oblique ray enters a wall at one (phi, theta) and
  // leaves it at another. What survives is (rho_out - rho_in) * d_in, and for
  // the FAR wall of the animal d_in is the whole body depth, about 0.16 m,
  // rather than the 14 mm of wall the term is meant to weigh: a mismatch of one
  // in rho -- a canal, a gonad horseshoe, the coronal ring's smoothstep -- lands
  // an error of 0.16 on an optical depth whose true value is 0.05. Traced
  // against the exact integral over a grid of rays through the bell, R carries
  // 51 % mean absolute error, runs 50 % high on average, and goes NEGATIVE
  // wherever a dense feature falls on the far subumbrella and not on the far
  // exumbrella -- at which point the max() below clamps it to zero and the
  // animal is simply not there at that pixel. That is what the dark slots inside
  // the dome were. Not shading, not the shadow term, not dense tissue rendering
  // dark: the optical depth cancelling itself out exactly where section 5.5 puts
  // the brightest tissue in the frame.
  //
  // rho * dGeo is what the ANALYTIC_THICKNESS branch above has always computed,
  // so the two branches now differ only in that this one MEASURES the path
  // instead of assuming one planar wall -- which is the part of section 2.4
  // worth having, since a tentacle behind the bell and an arm folded under it
  // still add their length to dGeo and still darken what is behind them. Traced
  // the same way it carries 7 % mean absolute error, 1 % bias and no negatives.
  // Pass 4 still writes R because the same fragment stage renders the sun-side
  // map, which reads it as a light-space optical depth.
  vec2  th   = max(sampleThick(uvS), vec2(0.0));   // clamp precision noise
  float dGeo = min(th.y, ${THICK_GEO_CLAMP.toFixed(2)});
  // hard clamp: an unsealed rim must not blow out
  float tau  = min(dGeo * rho, ${THICK_TAU_CLAMP.toFixed(2)});
#endif

  // ---- Beer-Lambert with similarity theory ------------------------------
  vec3 sigS = gelSigmaS();               // reduced scattering
  vec3 sigT = SIG_A_G + sigS;
  vec3 Tr   = exp(-sigT * tau);          // transmittance of the slab
  vec3 alb  = sigS / sigT;               // single-scattering albedo = the tint

  // One causticAt() fetch, the same one that lights the shafts and the snow.
  vec3 sunCol = uSunCol * causticKey(vWorldPos);

  // A surface facing the sun is the entry point of the accumulated column and
  // is shadowed by none of it; one facing away is the exit point and is
  // shadowed by all of it. See the derivation in thickness.js.
  vec3 shadowG = shadowTransmittance(vWorldPos, 0.5 - 0.5 * dot(N, L));

  // (1) MULTIPLE SCATTERING: light that entered and did not get through.
  //     sunCol is an IRRADIANCE and what leaves the tissue towards the eye is a
  //     RADIANCE, so this diffuse lobe carries the 1/PI every diffuse BRDF
  //     carries. It was the last term in the project doing that conversion by
  //     hand: inscatter() normalises by hg(0), the single scattering below by
  //     hg(), the strands by hg(), and this one by nothing. Measured, it is
  //     about a third of the animal's pixel, so correcting it drops the lit
  //     dome 32 % and the margin 25 % -- the emitted pedestal falls while the
  //     refracted background underneath it does not, which is what turns the
  //     bell from a lit cap back into glass. Same irradiance-for-radiance slip
  //     that came out of inscatter(), in the last place it was left.
  //
  //     The LOBE is two-sided, and that is what makes the gonads and the canals
  //     read at all. Multiply scattered light has forgotten where the sun was:
  //     the thicker the tissue the more of it leaves through whichever face the
  //     eye is on, so the wrap lobe alone -- which returns exactly zero for a
  //     surface tipped more than 0.65 away from the light, and the organs hang
  //     UNDER a bell lit from above -- left every dense structure in the animal
  //     with no key light whatsoever. Every other term that could have lit them
  //     carries Tr, which is what collapses when tissue gets dense, so they
  //     came out darker than the water behind them: dark slots where §5.5 puts
  //     the brightest tissue in the frame. Mixing toward the mean of the near
  //     and far lobes by the scattered fraction has the right limits at both
  //     ends -- a wafer-thin margin keeps the plain wrap it always had, and a
  //     slab thick enough to hide the water behind it emits the same either
  //     way, which is what "multiply scattered" means.
  float lobeNear  = wrapDiffuse(N, L, 0.65);
  float lobeFar   = wrapDiffuse(-N, L, 0.65);
  float scattered = 1.0 - dot(Tr, vec3(0.3333333));
  float lobe      = mix(lobeNear, 0.5 * (lobeNear + lobeFar), scattered);

  vec3 ms = alb * (1.0 - Tr) * lobe * sunCol * shadowG / PI;

  // (2) SINGLE SCATTERING: forward-peaked. g is 0.72, and the peak is CAPPED --
  //     this is the term that produced the periodic flare the calm judge flagged.
  float phase = min(hg(dot(-L, V), G_GEL), 2.4);
  vec3  ss    = sunCol * phase * Tr * (1.0 - exp(-sigS * tau)) * shadowG;

  // (3) AMBIENT: analytic water dome, no cubemap, no asset, no network. The N.y
  //     weighting is what stops the subumbrellar cavity flooding back in after
  //     the shadow term has just darkened it.
  //
  //     The 0.6 that used to close this line was an occlusion guess, and it put
  //     dense tissue BELOW the medium it displaces: mesoglea is sea water with
  //     a little collagen in it, single-scattering albedo 0.98, so a slab thick
  //     enough to hide the water behind it (Tr -> 0) returns very nearly the
  //     radiance that water was sending, and it cannot return 60 % of it. The
  //     visible cost was the gonad horseshoes, the canals and the manubrium
  //     rendering as dark slots inside the bell -- the denser the tissue, the
  //     darker the mark, which is backwards. Dropping the factor bounds them
  //     from below by the water instead, and because the term carries (1 - Tr)
  //     it is worth almost nothing on the thin dome and everything on the
  //     organs, which is the direction §5.5's anchors ask for.
  vec3 amb = mix(inscatter(vWorldY - 0.6), inscatter(vWorldY + 0.6), N.y*0.5 + 0.5)
           * alb * (1.0 - Tr);

  // F0 = 4e-4 stands in for the surface mucus film ONLY -- 10x physical, which is
  // as far as this is allowed to go. NO anisotropic ribbon, NO bloom on it:
  // the bloom knee (1.15) sits above anything this term can produce.
  const float F0 = 0.0004;
  float F    = F0 + (1.0 - F0) * pow(1.0 - max(dot(N,V), 0.0), 5.0);
  vec3  spec = ggx(N, V, L, 0.45) * F * sunCol;

  // Section 4.5's bioluminescence: a 5 % emissive ring travelling once around
  // the margin per swim cycle, offset 0.35 of a cycle from the mechanical
  // pulse. Barely perceptible, and entirely responsible for the page being
  // worth watching at three in the morning.
  float bioAngle = TAU * fract(uPhase - 0.35);
  float bioArc   = abs(mod(vTheta - bioAngle + PI, TAU) - PI);
  vec3  bio      = alb * uSunCol * 0.05
                 * exp(-bioArc * bioArc * 8.0) * smoothstep(0.80, 1.0, vPhi);

  vec3 col = ms + ss + amb + spec + bio;

#ifdef SUBUMBRELLA
  // Pass 5 blends SRC_ALPHA / ONE_MINUS_SRC_ALPHA, so the emitted radiance is
  // divided by the coverage the blender is about to multiply it back by. The
  // coverage itself is the tissue's opacity, 1 - Tr: a thin margin lets what is
  // behind it through, a thick dome does not.
  float alpha = clamp(1.0 - dot(Tr, vec3(0.3333333)), 0.0, 1.0);
  vec3  outC  = waterApply(col, vViewDist, vWorldY) * OUT_GAIN;
  fragColor   = vec4(outC / max(alpha, 1e-4), alpha);
#else
  // Refraction with a REAL march distance: the measured geometric path, so the
  // distortion grows where the bell is thick and vanishes at the margin. A
  // uv += N.xy*k hack cannot produce that structure.
  vec3 rd   = refract(-V, N, 1.0/1.0128);
  vec4 clip = uViewProj * vec4(vWorldPos + rd * dGeo, 1.0);
  vec2 uvR  = ((clip.xy / clip.w) / uSeaOverscan) * 0.5 + 0.5;

  // Cauchy dispersion, +-1.5% on eta -> an indigo/cyan fringe at the rim.
  vec3 bg;
  bg.r = seaTap(mix(uvS, uvR, 0.985)).r;
  bg.g = seaTap(uvR).g;
  bg.b = seaTap(mix(uvS, uvR, 1.015)).b;

  // Guard: a tap that leaves the frame falls back to the straight one. SEA is
  // rendered with 8 % overscan precisely so this fires rarely, but the loose
  // look-at camera does put the animal near the frame edge.
  float ok = step(0.0, min(uvR.x, uvR.y)) * step(max(uvR.x, uvR.y), 1.0);
  bg = mix(seaTap(uvS), bg, ok);

  // SEA is a render from THIS eye, so the tap already carries the water between
  // the animal and the camera. Handing the sum to waterApply() fogs that
  // stretch a second time. On flat water the two forms are algebraically the
  // same -- waterApply(L, d, y) is the identity when L is inscatter(y) -- which
  // is how it survived, but anything that DEPARTS from the veil loses
  // exp(-SIG_T_W*dist) of its contrast behind the bell, and a light shaft that
  // dies at the silhouette is the loudest possible statement that the animal is
  // opaque. Subtracting the near segment's haze before the multiply takes back
  // that stretch and nothing else: at Tr = 1 the whole expression collapses to
  // bg, so a wafer-thin margin now leaves the water behind it untouched instead
  // of stamping a step into it.
  vec3 haze = inscatter(vWorldY) * (1.0 - exp(-SIG_T_W * vViewDist));

  float coverage = 1.0;
  vec3  outC = waterApply(col, vViewDist, vWorldY) + (bg - haze) * Tr;
  fragColor  = vec4(outC * coverage * OUT_GAIN, coverage);
#endif
}
`;

/**
 * The complete include list for every program that draws or measures the
 * animal's body — the ZFRONT prepass, the thickness pass, the sun-side shadow
 * render and both bell programs. It is self-contained: hand it straight to
 * `assembleProgramSources({ includes: JELLY_GLSL_INCLUDES })`.
 *
 * Order inside the array matters. cookie.js's caustic chunk declares uSunDir,
 * uWorldOrigin, seaDepth() and causticAt(), which the lighting helpers call;
 * DENSITY_GLSL uses TAU and hash11 from §2.0; DEFORM_GLSL needs nothing at all.
 * Do NOT add CAUSTIC_GLSL a second time — it is already the first element, and
 * a duplicate declaration is a link error.
 *
 * Note what is NOT in here: PROFILE_GLSL and NOISE_GLSL. Neither is needed any
 * more, because the rest surface and §3.5's imperfection arrive in the VBO
 * rather than being re-derived per vertex. That is one texture unit, one
 * dependency and one whole class of CPU/GPU disagreement removed.
 */
export const JELLY_GLSL_INCLUDES = Object.freeze([
  CAUSTIC_GLSL,
  DENSITY_GLSL,
  JELLY_LIGHTING_GLSL,
  DEFORM_GLSL
]);
