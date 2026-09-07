/* ============================================================
   noise.js — value noise, fbm, ridged, curl, IGN, blue noise.
   ------------------------------------------------------------
   One source of truth for every stochastic field in the project.
   The JS implementation and the GLSL text below it are written
   as a matched pair: the same hash constants, the same octave
   lacunarity and offsets, the same interpolant. That is not
   tidiness, it is a correctness requirement — the CPU evaluates
   `curlNoise3` to advect the tentacles and the marine snow while
   the GPU evaluates the same field for the haze and the gobo. If
   the two drifted, a mote would visibly slide through a current
   the water is not showing.

   The shared numeric constants live once, in `NOISE_CONSTANTS`,
   and are emitted into the GLSL as `#define`s. There is no second
   copy of any of them to fall out of step.

   Hash functions are Dave Hoskins' bounded-magnitude family. The
   classic `fract(sin(dot(...)) * 43758.5453)` is deliberately NOT
   used: `sin` of a large argument is implementation-defined
   across GPUs, so the CPU and GPU results would not merely differ
   in the last bit, they would differ visibly and differently on
   every driver. Hoskins' hashes keep every intermediate below
   about 100, which is exactly representable in binary32, so the
   JS port (rounded with `Math.fround` at every step) agrees with
   a highp GPU to within the GPU's own rounding.

   IMPORTANT — `NOISE_GLSL` assumes `common.js` has already been
   concatenated ahead of it. It relies on `PI`, `TAU`, `ign()` and
   `hash11()` from there and deliberately does not redefine them;
   redefining a function in the same translation unit is a compile
   error, which is how you would find out.
   ============================================================ */

import { fract } from './math.js';

/* --- Shared constants, emitted into the GLSL as #defines -------------- */

export const NOISE_CONSTANTS = {
  /** Frequency multiplier between fbm octaves. Not exactly 2, so octaves do not phase-lock into a grid. */
  FBM_LACUNARITY: 2.02,
  /** Amplitude multiplier between fbm octaves. */
  FBM_GAIN: 0.5,
  /** Per-octave translation, to decorrelate octaves that would otherwise share lattice lines. */
  FBM_OFFSET_X: 17.3,
  FBM_OFFSET_Y: 9.1,
  FBM_OFFSET_Z: 23.7,
  /** Central-difference step for the curl operator, in the same units as the sampled position. */
  CURL_EPSILON: 0.15,
  /**
   * Normalisation so `curlNoise3` has an RMS magnitude of about 1 and callers
   * can treat the spec's `0.6 * curlNoise(...)` as 0.6 m/s RMS. Measured over
   * a large deterministic sample of the field; see the note in the report.
   */
  CURL_GAIN: 1.30963,
  /** Octave count used inside the curl potential. The spec asks for 3. */
  CURL_OCTAVES: 3
};

/* --- Float32-faithful hashing ----------------------------------------- */

const fr = Math.fround;
const K_1031 = fr(0.1031);
const K_1030 = fr(0.1030);
const K_0973 = fr(0.0973);
const K_33_33 = fr(33.33);
const K_31_32 = fr(31.32);

function fract32(x) { return fr(x - Math.floor(x)); }

/**
 * Hoskins hash12. GLSL twin operates on `vec3(p.xyx)`, so the third lane
 * repeats the x input; the port keeps that structure literally rather than
 * simplifying it, because simplifying it would silently change the result.
 */
export function hash12(x, y) {
  let a = fract32(fr(x * K_1031));
  let b = fract32(fr(y * K_1031));
  let c = fract32(fr(x * K_1031));
  const d = fr(fr(fr(a * fr(b + K_33_33)) + fr(b * fr(c + K_33_33))) + fr(c * fr(a + K_33_33)));
  a = fr(a + d); b = fr(b + d); c = fr(c + d);
  return fract32(fr(fr(a + b) * c));
}

/** Hoskins hash13: three floats in, one uniform float in [0,1) out. */
export function hash13(x, y, z) {
  let a = fract32(fr(x * K_1031));
  let b = fract32(fr(y * K_1031));
  let c = fract32(fr(z * K_1031));
  const d = fr(fr(fr(a * fr(c + K_31_32)) + fr(b * fr(b + K_31_32))) + fr(c * fr(a + K_31_32)));
  a = fr(a + d); b = fr(b + d); c = fr(c + d);
  return fract32(fr(fr(a + b) * c));
}

/**
 * Hoskins hash33: three floats in, three decorrelated floats in [0,1) out.
 * Writes into `out` (a length-3 array) and returns it, so the snow placer can
 * hash a million candidate positions without allocating.
 */
export function hash33(out, x, y, z) {
  let a = fract32(fr(x * K_1031));
  let b = fract32(fr(y * K_1030));
  let c = fract32(fr(z * K_0973));
  const d = fr(fr(fr(a * fr(b + K_33_33)) + fr(b * fr(a + K_33_33))) + fr(c * fr(c + K_33_33)));
  a = fr(a + d); b = fr(b + d); c = fr(c + d);
  out[0] = fract32(fr(fr(a + b) * c));
  out[1] = fract32(fr(fr(a + a) * b));
  out[2] = fract32(fr(fr(b + a) * a));
  return out;
}

/* --- Value noise ------------------------------------------------------ */

/** Quintic fade, matching the GLSL `f*f*f*(f*(f*6-15)+10)`. */
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** 2-D value noise on the unit lattice. Range [0, 1]. */
export function valueNoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fade(fx), uy = fade(fy);
  const n00 = hash12(ix, iy);
  const n10 = hash12(ix + 1, iy);
  const n01 = hash12(ix, iy + 1);
  const n11 = hash12(ix + 1, iy + 1);
  const a = n00 + (n10 - n00) * ux;
  const b = n01 + (n11 - n01) * ux;
  return a + (b - a) * uy;
}

/** 3-D value noise on the unit lattice. Range [0, 1]. */
export function valueNoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fade(fx), uy = fade(fy), uz = fade(fz);

  const n000 = hash13(ix, iy, iz);
  const n100 = hash13(ix + 1, iy, iz);
  const n010 = hash13(ix, iy + 1, iz);
  const n110 = hash13(ix + 1, iy + 1, iz);
  const n001 = hash13(ix, iy, iz + 1);
  const n101 = hash13(ix + 1, iy, iz + 1);
  const n011 = hash13(ix, iy + 1, iz + 1);
  const n111 = hash13(ix + 1, iy + 1, iz + 1);

  const x00 = n000 + (n100 - n000) * ux;
  const x10 = n010 + (n110 - n010) * ux;
  const x01 = n001 + (n101 - n001) * ux;
  const x11 = n011 + (n111 - n011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/* --- Fractal sums ----------------------------------------------------- */

const L = NOISE_CONSTANTS.FBM_LACUNARITY;
const G = NOISE_CONSTANTS.FBM_GAIN;
const OX = NOISE_CONSTANTS.FBM_OFFSET_X;
const OY = NOISE_CONSTANTS.FBM_OFFSET_Y;
const OZ = NOISE_CONSTANTS.FBM_OFFSET_Z;

/**
 * 2-D fractal Brownian motion. Normalised by the sum of amplitudes, so the
 * range is [0, 1] regardless of octave count — which is what makes the quality
 * ladder's octave reductions invisible instead of a brightness step.
 */
export function fbm2(x, y, octaves = 4) {
  let a = 1, sum = 0, norm = 0;
  let px = x, py = y;
  for (let i = 0; i < octaves; i++) {
    sum += a * valueNoise2(px, py);
    norm += a;
    a *= G;
    const nx = px * L + OX, ny = py * L + OY;
    px = nx; py = ny;
  }
  return norm > 0 ? sum / norm : 0;
}

/** 3-D fractal Brownian motion, range [0, 1], amplitude-normalised. */
export function fbm3(x, y, z, octaves = 4) {
  let a = 1, sum = 0, norm = 0;
  let px = x, py = y, pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += a * valueNoise3(px, py, pz);
    norm += a;
    a *= G;
    const nx = px * L + OX, ny = py * L + OY, nz = pz * L + OZ;
    px = nx; py = ny; pz = nz;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal, range [0, 1]. Each octave is folded about its midpoint
 * and squared, which turns the smooth blobs into filaments — the structure the
 * caustic gobo is built from. The gobo shader in shaders/cookie.js has its own
 * cheaper three-layer variant fixed by the spec; this one is the general form
 * used for CPU-side fields and for any shader that wants a matching pattern.
 */
export function ridged2(x, y, octaves = 3) {
  let a = 1, sum = 0, norm = 0;
  let px = x, py = y;
  for (let i = 0; i < octaves; i++) {
    let v = 1 - Math.abs(valueNoise2(px, py) * 2 - 1);
    v *= v;
    sum += a * v;
    norm += a;
    a *= G;
    const nx = px * L + OX, ny = py * L + OY;
    px = nx; py = ny;
  }
  return norm > 0 ? sum / norm : 0;
}

/** 3-D ridged multifractal, range [0, 1]. */
export function ridged3(x, y, z, octaves = 3) {
  let a = 1, sum = 0, norm = 0;
  let px = x, py = y, pz = z;
  for (let i = 0; i < octaves; i++) {
    let v = 1 - Math.abs(valueNoise3(px, py, pz) * 2 - 1);
    v *= v;
    sum += a * v;
    norm += a;
    a *= G;
    const nx = px * L + OX, ny = py * L + OY, nz = pz * L + OZ;
    px = nx; py = ny; pz = nz;
  }
  return norm > 0 ? sum / norm : 0;
}

/* --- Curl noise ------------------------------------------------------- */

/**
 * Vector potential for the curl field: three decorrelated fbm lobes, centred
 * on zero. Time enters as a translation along Z with a different offset per
 * component, so the field evolves without any component being a delayed copy
 * of another.
 */
function potential(out, x, y, z, t) {
  const oct = NOISE_CONSTANTS.CURL_OCTAVES;
  out[0] = fbm3(x, y, z + t, oct) - 0.5;
  out[1] = fbm3(x + 41.7, y + 17.3, z + t + 5.1, oct) - 0.5;
  out[2] = fbm3(x + 9.2, y + 63.1, z + t + 11.7, oct) - 0.5;
  return out;
}

const _pa = [0, 0, 0], _pb = [0, 0, 0], _pc = [0, 0, 0];
const _pd = [0, 0, 0], _pe = [0, 0, 0], _pf = [0, 0, 0];

/**
 * Curl of the vector potential above: a divergence-free field, which is why it
 * looks like water and a plain vector fbm does not. A divergent field piles
 * particles up in sinks; snow that clumps into a corner over an eight-hour soak
 * is the exact failure this avoids.
 *
 * Writes into `out` (length-3) and returns it. `x, y, z` are the already-scaled
 * sample position and `t` the already-scaled time — the spec's ambient current
 * is `0.6 * curlNoise3(out, p.x*0.35, p.y*0.35, p.z*0.35, t*0.07)`.
 */
export function curlNoise3(out, x, y, z, t) {
  const e = NOISE_CONSTANTS.CURL_EPSILON;
  potential(_pa, x + e, y, z, t);
  potential(_pb, x - e, y, z, t);
  potential(_pc, x, y + e, z, t);
  potential(_pd, x, y - e, z, t);
  potential(_pe, x, y, z + e, t);
  potential(_pf, x, y, z - e, t);

  const inv = NOISE_CONSTANTS.CURL_GAIN / (2 * e);
  out[0] = ((_pc[2] - _pd[2]) - (_pe[1] - _pf[1])) * inv;
  out[1] = ((_pe[0] - _pf[0]) - (_pa[2] - _pb[2])) * inv;
  out[2] = ((_pa[1] - _pb[1]) - (_pc[0] - _pd[0])) * inv;
  return out;
}

/* --- Interleaved gradient noise --------------------------------------- */

/**
 * Jorge Jimenez's interleaved gradient noise, in the exact form common.js
 * declares for GLSL. Argument is a PIXEL coordinate, not a normalised UV — the
 * constants are tuned for the 1-pixel lattice and it degenerates on [0,1] input.
 */
export function ign(x, y) {
  return fract(52.9829189 * fract(x * 0.06711056 + y * 0.00583715));
}

/**
 * Unit-variance Gaussian from two IGN samples via Box–Muller. The post chain
 * injects this pre-tonemap as sensor shot and read noise (spec §6 step 5); a
 * uniform deviate there would read as television static rather than as a
 * high-ISO sensor.
 *
 * `x, y` are pixel coordinates, `frame` the frame counter, so the pattern
 * decorrelates temporally without repeating on a short cycle.
 *
 * The second tap SWAPS the two coordinates before offsetting them, and that is
 * load-bearing rather than decorative. IGN is a low-discrepancy sequence, not
 * an iid uniform: sampling it at `p` and at `p + k` for a scalar k leaves the
 * two taps correlated (measured at −0.19 for k = 17), and feeding a correlated
 * `u2` into `cos(TAU·u2)` collapses the result to mean 0.295, sigma 0.852,
 * hard-bounded to [−0.93, 1.68] — a grain with a DC offset that lifts every
 * shadow in the frame and has no tail at all. Swapping the lanes first breaks
 * the shared projection: correlation falls to −0.0008 and the output measures
 * mean 0.000, sigma 1.000, with tails past ±4.5, which is what the amplitudes
 * in §6 assume.
 */
export function gaussIGN(x, y, frame) {
  const px = x + frame * 5.588238, py = y + frame * 3.141592;
  const u1 = Math.max(ign(px, py), 1e-6);
  const u2 = ign(py + 11.13, px + 71.77);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(6.28318531 * u2);
}

/* --- Blue-noise tile --------------------------------------------------- */

const _blueNoiseCache = new Map();

/**
 * Deterministic blue-noise tile by void-and-cluster (Ulichney 1993), returned
 * as a `Uint8Array` of `size*size` ranks scaled to 0..255 with a flat
 * histogram. Blue noise is used where a jitter must be spatially decorrelated
 * but temporally stable — the shaft march's per-pixel offset, the snow's
 * stratified placement — because white noise there produces the crawling
 * static the calm brief forbids.
 *
 * The domain is toroidal, so the energy field's total is the same at every
 * pixel; that identity is why phases II and III of the classic algorithm
 * collapse into the single "insert at the largest void" rule used below.
 *
 * Cost is roughly O(N²) in the tile area: about 3 ms at 32², about 40 ms at
 * 64². Generate it during the boot fade, not inside a frame. Results are
 * memoised per (size, seed).
 */
export function generateBlueNoiseTile(size = 64, seed = 0x51F0B3) {
  const key = size + ':' + seed;
  const cached = _blueNoiseCache.get(key);
  if (cached) return cached;

  const n = size * size;
  const radius = Math.max(1, Math.min(6, (size >> 1) - 1));
  const sigma = 1.5;

  // Precomputed wrapped Gaussian kernel, flattened to a (2r+1)² block.
  const kw = radius * 2 + 1;
  const kernel = new Float64Array(kw * kw);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      kernel[(dy + radius) * kw + (dx + radius)] =
        Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  }

  const energy = new Float64Array(n);
  const binary = new Uint8Array(n);

  function splat(index, s) {
    const cy = (index / size) | 0;
    const cx = index - cy * size;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = (cy + dy + size) % size;
      const rowK = (dy + radius) * kw;
      const rowE = y * size;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = (cx + dx + size) % size;
        energy[rowE + x] += s * kernel[rowK + (dx + radius)];
      }
    }
  }

  function tightestCluster() {
    let best = -1, bestE = -Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] === 1 && energy[i] > bestE) { bestE = energy[i]; best = i; }
    }
    return best;
  }

  function largestVoid() {
    let best = -1, bestE = Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] === 0 && energy[i] < bestE) { bestE = energy[i]; best = i; }
    }
    return best;
  }

  // A local mulberry32 rather than an Rng import, so noise.js keeps a single
  // dependency (math.js scalars) and the tile is reproducible in isolation.
  let rs = seed >>> 0;
  const rand = () => {
    rs = (rs + 0x6D2B79F5) >>> 0;
    let t = rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const initialOnes = Math.max(1, Math.round(n * 0.1));
  let placed = 0;
  while (placed < initialOnes) {
    const i = Math.floor(rand() * n) % n;
    if (binary[i]) continue;
    binary[i] = 1;
    splat(i, 1);
    placed++;
  }

  // Phase 0: relax the seed pattern until moving the tightest cluster into the
  // largest void is a no-op, i.e. the pattern is a local energy minimum.
  for (let guard = 0; guard < n * 4; guard++) {
    const c = tightestCluster();
    binary[c] = 0; splat(c, -1);
    const v = largestVoid();
    binary[v] = 1; splat(v, 1);
    if (v === c) break;
  }

  const rank = new Int32Array(n).fill(-1);
  const prototypeBinary = binary.slice();
  const prototypeEnergy = energy.slice();

  // Phase I: peel the seed pattern apart, most-clustered point first, giving it
  // the highest ranks below `initialOnes`.
  for (let r = initialOnes - 1; r >= 0; r--) {
    const c = tightestCluster();
    if (c < 0) break;
    binary[c] = 0; splat(c, -1);
    rank[c] = r;
  }

  // Phases II and III: restore the seed pattern and fill outward, each new
  // point landing in the current largest void.
  binary.set(prototypeBinary);
  energy.set(prototypeEnergy);
  for (let r = initialOnes; r < n; r++) {
    const v = largestVoid();
    if (v < 0) break;
    binary[v] = 1; splat(v, 1);
    rank[v] = r;
  }

  const out = new Uint8Array(n);
  const scale = 256 / n;
  for (let i = 0; i < n; i++) {
    const r = rank[i] < 0 ? 0 : rank[i];
    out[i] = Math.min(255, (r * scale) | 0);
  }
  _blueNoiseCache.set(key, out);
  return out;
}

/** Wrapped fetch from a tile produced by `generateBlueNoiseTile`, returning [0,1). */
export function blueNoiseSample(tile, size, x, y) {
  const ix = ((x | 0) % size + size) % size;
  const iy = ((y | 0) % size + size) % size;
  return tile[iy * size + ix] / 256;
}

/**
 * Golden-ratio temporal animation of a blue-noise value. Adding 0.618… per
 * frame and taking the fraction keeps every subsequence low-discrepancy, so a
 * four-frame accumulation converges quickly and, crucially for this page, does
 * not beat against any other periodicity in the scene.
 */
export function blueNoiseAnimated(tile, size, x, y, frame) {
  return fract(blueNoiseSample(tile, size, x, y) + frame * 0.6180339887498949);
}

/* --- GLSL, generated from the same constants -------------------------- */

const NC = NOISE_CONSTANTS;

/**
 * GLSL twin of everything above. Concatenate AFTER `COMMON_GLSL` — it uses
 * `TAU` and `ign()` from there and must not redefine them.
 *
 * Note that `fbm`/`ridged` take a runtime `octaves` argument but loop to a
 * compile-time bound with an early break. WebGL2 permits dynamic loop bounds,
 * but several mobile drivers still unroll badly or refuse to compile them, and
 * a shader that fails to link on one phone is not worth the two saved lines.
 */
export const NOISE_GLSL = `
// ---- noise.js: generated constants, single source of truth with the JS ----
#define FBM_LACUNARITY ${NC.FBM_LACUNARITY.toFixed(4)}
#define FBM_GAIN       ${NC.FBM_GAIN.toFixed(4)}
#define FBM_OFFSET2    vec2(${NC.FBM_OFFSET_X.toFixed(4)}, ${NC.FBM_OFFSET_Y.toFixed(4)})
#define FBM_OFFSET3    vec3(${NC.FBM_OFFSET_X.toFixed(4)}, ${NC.FBM_OFFSET_Y.toFixed(4)}, ${NC.FBM_OFFSET_Z.toFixed(4)})
#define CURL_EPSILON   ${NC.CURL_EPSILON.toFixed(4)}
#define CURL_GAIN      ${NC.CURL_GAIN.toFixed(6)}
#define CURL_OCTAVES   ${NC.CURL_OCTAVES}
#define NOISE_MAX_OCTAVES 8

// Bounded-magnitude hashes (Hoskins). No sin(), because sin of a large
// argument is not portable between GPUs and would desynchronise the CPU field.
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p){
  vec3 p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float valueNoise2(vec2 p){
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
  float n00 = hash12(i + vec2(0.0, 0.0));
  float n10 = hash12(i + vec2(1.0, 0.0));
  float n01 = hash12(i + vec2(0.0, 1.0));
  float n11 = hash12(i + vec2(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

float valueNoise3(vec3 p){
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// Amplitude-normalised, so changing the octave count changes detail and never
// brightness. The perf ladder depends on that being true.
float fbm2(vec2 p, int octaves){
  float a = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < NOISE_MAX_OCTAVES; i++){
    if (i >= octaves) break;
    sum  += a * valueNoise2(p);
    norm += a;
    a    *= FBM_GAIN;
    p     = p * FBM_LACUNARITY + FBM_OFFSET2;
  }
  return sum / max(norm, 1e-5);
}

float fbm3(vec3 p, int octaves){
  float a = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < NOISE_MAX_OCTAVES; i++){
    if (i >= octaves) break;
    sum  += a * valueNoise3(p);
    norm += a;
    a    *= FBM_GAIN;
    p     = p * FBM_LACUNARITY + FBM_OFFSET3;
  }
  return sum / max(norm, 1e-5);
}

float ridged2(vec2 p, int octaves){
  float a = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < NOISE_MAX_OCTAVES; i++){
    if (i >= octaves) break;
    float v = 1.0 - abs(valueNoise2(p) * 2.0 - 1.0);
    sum  += a * v * v;
    norm += a;
    a    *= FBM_GAIN;
    p     = p * FBM_LACUNARITY + FBM_OFFSET2;
  }
  return sum / max(norm, 1e-5);
}

float ridged3(vec3 p, int octaves){
  float a = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < NOISE_MAX_OCTAVES; i++){
    if (i >= octaves) break;
    float v = 1.0 - abs(valueNoise3(p) * 2.0 - 1.0);
    sum  += a * v * v;
    norm += a;
    a    *= FBM_GAIN;
    p     = p * FBM_LACUNARITY + FBM_OFFSET3;
  }
  return sum / max(norm, 1e-5);
}

// Vector potential, centred on zero. Time translates along z with a different
// offset per component so no component is a delayed copy of another.
vec3 noisePotential(vec3 p, float t){
  return vec3(
    fbm3(p + vec3(0.0,  0.0,  t),        CURL_OCTAVES),
    fbm3(p + vec3(41.7, 17.3, t + 5.1),  CURL_OCTAVES),
    fbm3(p + vec3(9.2,  63.1, t + 11.7), CURL_OCTAVES)
  ) - 0.5;
}

// Divergence-free by construction: curl of a potential cannot have sinks, so
// advected particles never pile up. Expensive (18 fbm evaluations); the GPU
// path should sample it sparsely or per-vertex, never per-fragment per-step.
vec3 curlNoise3(vec3 p, float t){
  const float e = CURL_EPSILON;
  vec3 px1 = noisePotential(p + vec3(e, 0.0, 0.0), t);
  vec3 px0 = noisePotential(p - vec3(e, 0.0, 0.0), t);
  vec3 py1 = noisePotential(p + vec3(0.0, e, 0.0), t);
  vec3 py0 = noisePotential(p - vec3(0.0, e, 0.0), t);
  vec3 pz1 = noisePotential(p + vec3(0.0, 0.0, e), t);
  vec3 pz0 = noisePotential(p - vec3(0.0, 0.0, e), t);
  vec3 c = vec3(
    (py1.z - py0.z) - (pz1.y - pz0.y),
    (pz1.x - pz0.x) - (px1.z - px0.z),
    (px1.y - px0.y) - (py1.x - py0.x)
  );
  return c * (CURL_GAIN / (2.0 * e));
}

// Unit-variance Gaussian from two IGN samples. \`ign\` comes from common.js and
// wants PIXEL coordinates, not normalised UVs. Used pre-tonemap as sensor shot
// and read noise; a uniform deviate there reads as static, not as a sensor.
//
// The second tap uses p.yx, not p + k. IGN is low-discrepancy, not iid: two
// taps separated by a scalar stay correlated (-0.19 measured at k = 17), and a
// correlated u2 collapses this to mean 0.295 / sigma 0.852 bounded within
// [-0.93, 1.68] -- a DC lift on every shadow with no tail. Swapping the lanes
// first breaks the shared projection and restores mean 0 / sigma 1.
float gaussIGN(vec2 fragPx, float frame){
  vec2 p  = fragPx + vec2(frame * 5.588238, frame * 3.141592);
  float u1 = max(ign(p), 1e-6);
  float u2 = ign(p.yx + vec2(11.13, 71.77));
  return sqrt(-2.0 * log(u1)) * cos(TAU * u2);
}

// Blue-noise tile lookup. \`uBlueNoise\` is an R8 texture of side \`size\`, NEAREST
// filtered and REPEAT wrapped; texelFetch keeps it exact regardless of sampler
// state. The golden-ratio term animates it without introducing a short cycle.
float blueNoise(sampler2D tex, vec2 fragPx, float size){
  ivec2 t = ivec2(mod(fragPx, vec2(size)));
  return texelFetch(tex, t, 0).r;
}
float blueNoiseAnimated(sampler2D tex, vec2 fragPx, float size, float frame){
  return fract(blueNoise(tex, fragPx, size) + frame * 0.6180339887);
}
`;
