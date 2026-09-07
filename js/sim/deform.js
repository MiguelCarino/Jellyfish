/* ============================================================
   sim/deform.js — the bell deformation, defined exactly once.
   ------------------------------------------------------------
   §4.1's pulse waveform and §4.2's kinematic-wave deformation,
   written twice in this file and nowhere else: once in JavaScript
   and once, immediately below it, as the GLSL string that the
   bell vertex shader includes. Both halves read their constants
   from the same frozen `DEFORM` object, which is interpolated
   into the GLSL at module load, so a retuned constant lands on
   the CPU and the GPU in the same edit.

   WHY THIS FILE EXISTS AT ALL. The vertex shader moves the bell;
   the verlet solver pins forty tentacle roots to the bell margin;
   the swim integrator reads dp/dt off the same waveform to make
   thrust. If any two of those three disagree about where the
   margin is by even a millimetre, the tentacles detach from the
   animal on the contraction stroke — the single most visible
   failure mode in the project, and one that only shows up in
   motion. One definition, two languages, generated from one set
   of numbers, is the only arrangement that cannot drift.

   HOW TO VERIFY THEY STILL AGREE — see `deformProbe()` at the
   bottom of the file. It evaluates a fixed grid of inputs and
   returns the JS answers; the same grid can be pushed through the
   GLSL from the `?dev=1` panel and differenced. The probe grid is
   deliberately dull: apex, shoulder, margin, mid-contraction,
   mid-recoil, and the wrap point where the recoil term is still
   negative.

   PHASE IS A CYCLE COUNT, NOT A TIME. §4.2's listing writes the
   phase as `uTime * uFreq`, which is only correct while the
   period is constant — and §4.1 requires the period to wander
   ±14 % on a 96 s carrier, jitter ±6 % per beat, and occasionally
   skip or double. Multiplying a *changed* frequency by absolute
   time teleports the phase. So sim/swim.js integrates
   `phase += freq * dt` and hands the accumulated cycle count to
   both halves of this file. At a constant frequency the two are
   identical, which is why the spec's listing is right about the
   arithmetic and wrong only about the bookkeeping.
   ============================================================ */

import { clamp, fract, smoothstep } from '../math.js';
import { BELL_RADIUS } from '../geometry/profile.js';

/* --- Constants ---------------------------------------------------------- */

/**
 * Every number §4.1 and §4.2 pin down, plus the two they leave to the
 * implementer (`AMPLITUDE`, and the finite-difference step the analytic normal
 * uses). Frozen because the GLSL twin below is generated from this object: a
 * value edited here changes both languages, and a value edited anywhere else
 * changes neither.
 */
export const DEFORM = Object.freeze({
  /** §4.1: the fraction of the cycle spent contracting. Fast in, slow out. */
  CONTRACTION_FRACTION: 0.26,
  /** §4.1 recoil envelope: exp(-DECAY·u)·cos(RING·u), deliberately unclamped. */
  RECOIL_DECAY: 2.4,
  RECOIL_RING: 2.6,
  /** §4.1 contraction easing exponent applied to the smoothstep ramp. */
  CONTRACTION_EASE: 0.8,

  /** §4.2: the margin's phase lag behind the apex, in cycles. */
  WAVE_LAG: 0.20,
  /** §4.2: the contraction only engages past the crown. */
  ACTIVATION_EDGE0: 0.12,
  ACTIVATION_EDGE1: 1.0,
  /** §4.2: radial squeeze coefficient. */
  RADIAL_SQUEEZE: 0.34,
  /** §4.2: the margin curls UNDER — this is what closes the subumbrellar cavity. */
  MARGIN_CURL: 0.62,
  CURL_EDGE0: 0.55,
  CURL_EDGE1: 1.0,
  /** §4.2: the apex domes up as the margin comes in. */
  APEX_DOME: 0.11,
  /** §4.2: the lazy twist about the bell axis that keeps the animal asymmetric. */
  TWIST_AMPLITUDE: 0.04,
  TWIST_RATE: 0.13,
  TWIST_PHI_SCALE: 2.1,

  /**
   * Stroke amplitude. §4.2 leaves `uAmp` as a free coefficient, so it is fixed
   * here from the anatomy rather than by eye: at 0.50 the peak contraction
   * takes 17 % off the bell diameter (0.34 × 0.50), pulls the margin 3.2 cm
   * under (0.62 × 0.50 × R), and lifts the apex 7 mm (0.11 × 0.50 × R, on a
   * 4.4 cm relaxed height). Those are the numbers high-speed Aurelia footage
   * shows. Larger values fold the margin further under the bell than its own
   * height, which reads as an umbrella closing rather than an animal swimming.
   */
  AMPLITUDE: 0.50,

  /**
   * Finite-difference steps for the analytic normal. Not arbitrary: they are
   * roughly one tessellation cell at LOD1 (36 rings, 112 azimuth), which is
   * the largest cell either LOD produces. Smaller steps sample inside a cell
   * and amplify the pulse waveform's own curvature into the normal; larger
   * ones smooth the lappets away.
   */
  NORMAL_DPHI: 1 / 36,
  NORMAL_DTHETA: 0.056
});

/**
 * §4.1's peak recoil, computed rather than quoted: the recoil envelope
 * exp(-2.4u)·cos(2.6u) reaches its minimum where tan(2.6u) = -2.4/2.6, i.e.
 * u = 0.9218, value -0.0807. That is the spec's "dips to ≈ -0.081" and the
 * reason the term is left unclamped — the bell flares 8 % of a stroke past its
 * rest radius before settling, which is the visible signature of an
 * under-damped elastic body and cannot be faked with an eased sine.
 */
export const PULSE_MIN = -0.08066;

/* --- The pulse ---------------------------------------------------------- */

/**
 * §4.1's swim waveform on x ∈ [0,1): a fast muscular contraction over the
 * first 26 % of the cycle, then a slow passive elastic recoil. A symmetric
 * sine reads as a beating toy; this asymmetry is the entire tell.
 *
 * The recoil is NOT clamped at zero (see PULSE_MIN). It is also not continuous
 * across the cycle wrap: it arrives at x → 1 still at ≈ -0.078 and the next
 * contraction starts from 0. That step is where the next muscular contraction
 * begins, it is 7.8 % of one stroke, and §4.2's kinematic wave spreads it over
 * 0.20 of a cycle up the bell so it never happens everywhere at once.
 */
export function pulse(x) {
  const C = DEFORM.CONTRACTION_FRACTION;
  if (x < C) {
    // Below zero the Hermite `u*u*(3-2u)` turns positive again and pow() would
    // report a contraction that is not happening. The phase is always fract()ed
    // so this is unreachable, and it is one comparison to keep it that way.
    if (x <= 0) return 0;
    const u = x / C;
    const s = u * u * (3 - 2 * u);
    return Math.pow(s, DEFORM.CONTRACTION_EASE);
  }
  const u = (x - C) / (1 - C);
  return Math.exp(-DEFORM.RECOIL_DECAY * u) * Math.cos(DEFORM.RECOIL_RING * u);
}

/**
 * d(pulse)/dx, analytically. sim/swim.js can difference `pulse` across the
 * frame instead — §4.3 writes the thrust that way — but sim/flow.js needs
 * dp/dt at a sub-frame time to size the aperture jet, and differencing there
 * would alias the 26 %-of-a-cycle contraction badly at 30 Hz.
 *
 * The 0.8 power looks as though it must make the slope infinite at x = 0, and
 * it does not: near zero the Hermite is s ~ 3u², so the derivative goes as
 * e·s^(e-1)·ds/du ~ u^(2e-1) = u^0.6, which tends to ZERO. The whole contraction
 * branch peaks at about 5.5 and there is nothing to clamp. An earlier version of
 * this function guarded a singularity that does not exist and put a small hole
 * in the curve at x ≈ 1e-4 doing it; tests/check.mjs compares this against
 * sim/swim.js's consumer over twenty thousand samples so that cannot come back.
 */
export function pulseVelocity(x) {
  const C = DEFORM.CONTRACTION_FRACTION;
  if (x < C) {
    if (x <= 0) return 0;
    const u = x / C;
    const s = u * u * (3 - 2 * u);
    if (s <= 0) return 0;
    const dsdu = 6 * u * (1 - u);
    return DEFORM.CONTRACTION_EASE * Math.pow(s, DEFORM.CONTRACTION_EASE - 1) * dsdu / C;
  }
  const u = (x - C) / (1 - C);
  const e = Math.exp(-DEFORM.RECOIL_DECAY * u);
  return e * (-DEFORM.RECOIL_DECAY * Math.cos(DEFORM.RECOIL_RING * u)
            - DEFORM.RECOIL_RING * Math.sin(DEFORM.RECOIL_RING * u)) / (1 - C);
}

/**
 * §4.2's travelling wave: the local phase at `phi`, in [0,1). `phase` is the
 * accumulated cycle count from sim/swim.js. The margin (φ = 1) runs one fifth
 * of a cycle — 0.44 s at the 2.2 s base period — behind the crown, and that
 * one constant does more for "alive" than any shading term in the project.
 */
export function localPhase(phase, phi) {
  return fract(phase - phi * DEFORM.WAVE_LAG);
}

/**
 * The contraction scalar `k` at (φ, θ-baked-gain). Positive during the stroke,
 * slightly negative during the elastic overshoot. `lappetGain` is the baked
 * per-lappet gain jitter from §3.5 — geometry/bell.js bakes it per vertex and
 * exposes `imperfection.lappetGain(theta)` so the tentacle roots evaluate the
 * identical number at an arbitrary azimuth.
 */
export function contraction(phase, phi, lappetGain = 1, amplitude = DEFORM.AMPLITUDE) {
  const p = pulse(localPhase(phase, phi));
  return p * lappetGain * amplitude
       * smoothstep(DEFORM.ACTIVATION_EDGE0, DEFORM.ACTIVATION_EDGE1, phi);
}

/** §4.2's lazy asymmetry: a slow twist about the bell axis, φ-dependent. */
export function twistAngle(twistTime, phi) {
  return DEFORM.TWIST_AMPLITUDE
       * Math.sin(twistTime * DEFORM.TWIST_RATE + phi * DEFORM.TWIST_PHI_SCALE);
}

/* --- The deformation ---------------------------------------------------- */

/**
 * §4.2's `deform()`, in JavaScript. `rest` is a rest-pose point in the bell's
 * own frame, in metres — for the mesh that is the `aRest` attribute, for a
 * tentacle root it is `bellMarginPoint()` from geometry/bell.js. Writes
 * (x, y, z) into `out` (length ≥ 3) and returns it. `rest` and `out` may alias.
 *
 * `params` carries the frame's animation state:
 *   phase       accumulated swim cycles (sim/swim.js)
 *   lappetGain  baked per-lappet contraction gain, §3.5 item 3 × item 4
 *   amplitude   stroke amplitude; leave at DEFORM.AMPLITUDE
 *   twistTime   seconds, for the lazy twist only
 *   radius      bell radius in metres; the curl and dome terms scale with it
 */
export function deformBell(out, rest, phi, params) {
  const {
    phase = 0,
    lappetGain = 1,
    amplitude = DEFORM.AMPLITUDE,
    twistTime = 0,
    radius = BELL_RADIUS
  } = params;

  const k = contraction(phase, phi, lappetGain, amplitude);

  const squeeze = 1 - DEFORM.RADIAL_SQUEEZE * k;
  const x = rest[0] * squeeze;
  const z = rest[2] * squeeze;
  let y = rest[1]
        - DEFORM.MARGIN_CURL * k * radius * smoothstep(DEFORM.CURL_EDGE0, DEFORM.CURL_EDGE1, phi);
  y += DEFORM.APEX_DOME * k * radius * (1 - phi);

  const a = twistAngle(twistTime, phi);
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = c * x - s * z;
  out[1] = y;
  out[2] = s * x + c * z;
  return out;
}

/**
 * The deformed position AND the analytic surface normal, from the same three
 * evaluations of `deformBell()` the vertex shader makes (§2.5). Pass the two
 * rest-space neighbour offsets — for the mesh they are the baked `aNextT` and
 * `aNextS` attributes; for a tentacle root, geometry/bell.js computes them.
 *
 * The cross product is `cross(alongTheta, alongRow)`, in that order, because
 * geometry/bell.js winds the whole closed shell as one sheet running
 * exumbrella-apex → margin → across the rim → subumbrella-apex. Under that
 * ordering the cross product points AWAY FROM THE TISSUE everywhere — outward
 * on the exumbrella, into the cavity on the subumbrella — with no per-shell
 * sign flip and, crucially, no sign discontinuity on the rim band, which is
 * where a flip would show as a glowing seam.
 *
 * Writes the position into `outPos` and the unit normal into `outNormal`.
 */
export function deformBellFrame(outPos, outNormal, rest, phi, nextTheta, nextRow, dPhiRow, params) {
  deformBell(outPos, rest, phi, params);

  _neighbour[0] = rest[0] + nextTheta[0];
  _neighbour[1] = rest[1] + nextTheta[1];
  _neighbour[2] = rest[2] + nextTheta[2];
  deformBell(_pT, _neighbour, phi, params);

  _neighbour[0] = rest[0] + nextRow[0];
  _neighbour[1] = rest[1] + nextRow[1];
  _neighbour[2] = rest[2] + nextRow[2];
  deformBell(_pS, _neighbour, phi + dPhiRow, params);

  const tx = _pT[0] - outPos[0], ty = _pT[1] - outPos[1], tz = _pT[2] - outPos[2];
  const sx = _pS[0] - outPos[0], sy = _pS[1] - outPos[1], sz = _pS[2] - outPos[2];
  let nx = ty * sz - tz * sy;
  let ny = tz * sx - tx * sz;
  let nz = tx * sy - ty * sx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) {
    // Only reachable at the two axis poles, where the θ neighbour collapses.
    // geometry/bell.js bakes a borrowed tangent there precisely so this branch
    // does not fire, but a caller supplying its own offsets might hit it, and
    // a NaN normal silently blanks a whole draw.
    outNormal[0] = 0; outNormal[1] = 1; outNormal[2] = 0;
    return outNormal;
  }
  outNormal[0] = nx / len; outNormal[1] = ny / len; outNormal[2] = nz / len;
  return outNormal;
}

const _neighbour = [0, 0, 0];
const _pT = [0, 0, 0];
const _pS = [0, 0, 0];

/* --- The GLSL twin ------------------------------------------------------ */

/**
 * The other half of this file. `js/shaders/bell.js` must INCLUDE this string
 * rather than write its own `deform()`; that is what makes the CPU and the GPU
 * provably the same function. Every constant below is interpolated from the
 * `DEFORM` object above, so the two cannot be edited apart.
 *
 * Needs nothing from common.js or profile.js and defines no uniforms, so it
 * can be included in any program that touches the bell — the bell shader, the
 * thickness pass and the sun-view shadow re-render all deform identically,
 * which is why the self-shadow lands on the animal that is actually there.
 *
 * Naming is prefixed `bell*` so that including it alongside anything else in
 * the project cannot collide.
 */
/**
 * GLSL ES 3.00 has no implicit int→float promotion, so `smoothstep(0.12, 1, x)`
 * is a compile error while `smoothstep(0.12, 1.0, x)` is not — and JavaScript
 * stringifies the number 1 as "1". Every constant interpolated into the shader
 * below goes through this, so a constant that happens to be integral cannot
 * break the build on the one day someone retunes it to a whole number.
 */
function glslFloat(v) {
  const s = String(v);
  return /[.eE]/.test(s) ? s : s + '.0';
}

export const DEFORM_GLSL = `
// ---- sim/deform.js: the shared bell deformation (spec 4.1, 4.2) ----
#define BELL_PULSE_C           ${glslFloat(DEFORM.CONTRACTION_FRACTION)}
#define BELL_PULSE_EASE        ${glslFloat(DEFORM.CONTRACTION_EASE)}
#define BELL_RECOIL_DECAY      ${glslFloat(DEFORM.RECOIL_DECAY)}
#define BELL_RECOIL_RING       ${glslFloat(DEFORM.RECOIL_RING)}
#define BELL_WAVE_LAG          ${glslFloat(DEFORM.WAVE_LAG)}
#define BELL_ACTIVATION_EDGE0  ${glslFloat(DEFORM.ACTIVATION_EDGE0)}
#define BELL_ACTIVATION_EDGE1  ${glslFloat(DEFORM.ACTIVATION_EDGE1)}
#define BELL_RADIAL_SQUEEZE    ${glslFloat(DEFORM.RADIAL_SQUEEZE)}
#define BELL_MARGIN_CURL       ${glslFloat(DEFORM.MARGIN_CURL)}
#define BELL_CURL_EDGE0        ${glslFloat(DEFORM.CURL_EDGE0)}
#define BELL_CURL_EDGE1        ${glslFloat(DEFORM.CURL_EDGE1)}
#define BELL_APEX_DOME         ${glslFloat(DEFORM.APEX_DOME)}
#define BELL_TWIST_AMPLITUDE   ${glslFloat(DEFORM.TWIST_AMPLITUDE)}
#define BELL_TWIST_RATE        ${glslFloat(DEFORM.TWIST_RATE)}
#define BELL_TWIST_PHI_SCALE   ${glslFloat(DEFORM.TWIST_PHI_SCALE)}
#define BELL_STROKE_AMPLITUDE  ${glslFloat(DEFORM.AMPLITUDE)}

// Fast muscular contraction, slow passive elastic recoil. The recoil term is
// deliberately unclamped: it dips to -0.081, so the bell flares past its rest
// radius before settling, which is what sells "soft" instead of "shape key".
float bellPulse(float x){
  if (x < BELL_PULSE_C){
    // pow(0, y) is defined for y > 0 and pow(x, y) is UNDEFINED for x < 0 in ES
    // 3.00, so the branch is taken explicitly rather than trusted to a driver.
    // The JS half guards the same way, for the same reason.
    if (x <= 0.0) return 0.0;
    float u = x / BELL_PULSE_C;
    float s = u*u*(3.0 - 2.0*u);
    return pow(s, BELL_PULSE_EASE);
  }
  float u = (x - BELL_PULSE_C) / (1.0 - BELL_PULSE_C);
  return exp(-BELL_RECOIL_DECAY * u) * cos(BELL_RECOIL_RING * u);
}

// The kinematic wave: the margin runs BELL_WAVE_LAG of a cycle behind the
// crown, so the contraction travels instead of happening all at once.
float bellLocalPhase(float phase, float phi){
  return fract(phase - phi * BELL_WAVE_LAG);
}

// uPhase is an accumulated CYCLE COUNT, not uTime*uFreq -- the period wanders,
// jitters and occasionally doubles, and multiplying a changed frequency by
// absolute time would teleport the phase. sim/swim.js integrates it.
float bellContraction(float phase, float phi, float lappetGain, float amp){
  return bellPulse(bellLocalPhase(phase, phi)) * lappetGain * amp
       * smoothstep(BELL_ACTIVATION_EDGE0, BELL_ACTIVATION_EDGE1, phi);
}

vec3 bellTwistY(vec3 p, float a){
  float c = cos(a), s = sin(a);
  return vec3(c*p.x - s*p.z, p.y, s*p.x + c*p.z);
}

// rest is the aRest attribute: metres, in the bell's own frame, with the baked
// imperfection of 3.5 already in it. radius is the bell radius in metres.
vec3 bellDeform(vec3 rest, float phi, float phase, float lappetGain,
                float amp, float twistTime, float radius){
  float k = bellContraction(phase, phi, lappetGain, amp);
  vec3 o;
  o.xz = rest.xz * (1.0 - BELL_RADIAL_SQUEEZE * k);
  o.y  = rest.y - BELL_MARGIN_CURL * k * radius
                * smoothstep(BELL_CURL_EDGE0, BELL_CURL_EDGE1, phi);
  o.y += BELL_APEX_DOME * k * radius * (1.0 - phi);
  return bellTwistY(o, BELL_TWIST_AMPLITUDE
                     * sin(twistTime * BELL_TWIST_RATE + phi * BELL_TWIST_PHI_SCALE));
}
`;

/* --- Agreement probe ---------------------------------------------------- */

/**
 * A fixed, deliberately boring grid of inputs. Ten rows, chosen to hit every
 * branch and every term: both sides of the contraction/recoil split, the
 * activation smoothstep's dead zone at the apex, the curl smoothstep's dead
 * zone below φ = 0.55, the negative-k overshoot near the cycle wrap, and a
 * lappet gain either side of 1.
 */
export const DEFORM_PROBE_INPUTS = Object.freeze([
  Object.freeze({ phi: 0.00, theta: 0.00, phase: 0.00, lappetGain: 1.00, twistTime: 0.0 }),
  Object.freeze({ phi: 0.12, theta: 0.70, phase: 0.13, lappetGain: 1.00, twistTime: 3.0 }),
  Object.freeze({ phi: 0.34, theta: 1.90, phase: 0.13, lappetGain: 0.94, twistTime: 3.0 }),
  Object.freeze({ phi: 0.55, theta: 2.60, phase: 0.26, lappetGain: 1.06, twistTime: 7.5 }),
  Object.freeze({ phi: 0.70, theta: 3.40, phase: 0.40, lappetGain: 1.00, twistTime: 7.5 }),
  Object.freeze({ phi: 0.88, theta: 4.10, phase: 0.62, lappetGain: 0.97, twistTime: 12.0 }),
  Object.freeze({ phi: 1.00, theta: 5.00, phase: 0.62, lappetGain: 1.03, twistTime: 12.0 }),
  Object.freeze({ phi: 1.00, theta: 5.90, phase: 0.95, lappetGain: 1.00, twistTime: 19.0 }),
  Object.freeze({ phi: 0.80, theta: 0.35, phase: 0.99, lappetGain: 1.00, twistTime: 19.0 }),
  Object.freeze({ phi: 0.46, theta: 2.20, phase: 1.73, lappetGain: 1.00, twistTime: 25.0 })
]);

/**
 * Evaluates `DEFORM_PROBE_INPUTS` and returns one row per input:
 * `{ phi, theta, phase, lappetGain, twistTime, rest, pulse, k, deformed }`.
 * The rest point is a plain unit-radius ring point scaled by `radius`, so the
 * probe exercises this file only and does not drag the profile curve, the mesh
 * builder or the baked imperfection into the comparison.
 *
 * To check the GLSL still matches: feed the same rows to `bellDeform()` from a
 * `?dev=1` scratch program, read them back, and difference. Anything above
 * ~1e-6 relative means the two halves of this file have been edited apart —
 * which, since both read `DEFORM`, can only happen by editing the arithmetic
 * itself rather than a constant.
 */
export function deformProbe(radius = BELL_RADIUS) {
  const out = [];
  const rest = [0, 0, 0];
  const deformed = [0, 0, 0];
  for (const row of DEFORM_PROBE_INPUTS) {
    const r = radius * (1 - 0.4 * row.phi);
    rest[0] = r * Math.cos(row.theta);
    rest[1] = radius * (0.34 - 0.34 * row.phi);
    rest[2] = r * Math.sin(row.theta);
    deformBell(deformed, rest, row.phi, {
      phase: row.phase,
      lappetGain: row.lappetGain,
      amplitude: DEFORM.AMPLITUDE,
      twistTime: row.twistTime,
      radius
    });
    out.push({
      phi: row.phi,
      theta: row.theta,
      phase: row.phase,
      lappetGain: row.lappetGain,
      twistTime: row.twistTime,
      rest: [rest[0], rest[1], rest[2]],
      pulse: pulse(localPhase(row.phase, row.phi)),
      k: contraction(row.phase, row.phi, row.lappetGain),
      deformed: [deformed[0], deformed[1], deformed[2]]
    });
  }
  return out;
}

/**
 * §4.6's reduced-motion pose: the swim cycle frozen at φ = 0.62 of a cycle —
 * mid-relaxation, arms streaming, which the spec calls the prettiest pose.
 * Exported as a named constant so main.js does not have to carry the number
 * and so the reduced-motion path and the normal path deform through exactly
 * the same code with a constant `phase`.
 */
export const REDUCED_MOTION_PHASE = 0.62;

/**
 * §4.4's retarded time, the stateless fallback for secondary motion. `depth`
 * is how far a point hangs below its attachment, in metres; the lag is 0.55 s
 * per metre. Lives here rather than in sim/verlet.js because geometry/strands.js
 * uses it for the oral-arm frill phase on EVERY path, not just the fallback —
 * §3.3's frill undulates independently of the arm's gross motion, and a
 * solver buys nothing across the width of a ribbon.
 */
export const RETARDED_TIME_LAG = 0.55;

export function retardedTime(time, depth) {
  return time - Math.max(0, depth) * RETARDED_TIME_LAG;
}

/**
 * φ is normalised arc length and every term above assumes it lies in [0,1].
 * A strand-root solver that overshoots the margin, or a debug slider, can hand
 * in 1.02 — and the two smoothsteps would then saturate in opposite directions
 * and pull the point somewhere the mesh is not. One guard, used by callers that
 * compute φ rather than read it from a vertex attribute.
 */
export function clampPhi(phi) {
  return clamp(phi, 0, 1);
}
