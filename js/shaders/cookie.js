/* ============================================================
   shaders/cookie.js — the caustic gobo, spec §2.1 (pass 0).
   ------------------------------------------------------------
   One 256x256 R8 texture with a short mip chain, redrawn every
   frame (every other frame from tier 3). It exists as a texture
   rather than as an inline function for one reason: the shaft
   march samples it sixteen times per pixel, and the bell and the
   snow sample it again. §2.1 is emphatic that there must be only
   ONE caustic field in the project — the shafts in open water,
   the ripple crawling over the bell and the twinkle on a mote of
   marine snow are the same phenomenon and must be the same
   number, because a separate godray system is a system that can
   disagree with the animal's lighting.

   This file therefore ships two things: COOKIE_FS, which draws
   the gobo, and CAUSTIC_GLSL, which reads it. Every program that
   wants caustic light includes CAUSTIC_GLSL and calls
   causticAt(); nobody samples uCookie directly.

   ---- Three decisions that are not in the spec's listing ----

   1. THE PATTERN TILES EXACTLY. causticAt() projects a world
      point up the sun ray onto the surface plane, so its uv is
      unbounded and the texture is sampled with REPEAT. The §2.1
      listing is a sum of sines of arbitrary frequency, which does
      not close on the tile: it would lay a hard seam line across
      the water every few metres, and a straight bright edge that
      never moves is exactly the kind of thing the §10 subjective
      gate throws the build out for. The fix costs nothing: the
      wave vector of every sine is rounded to a whole number of
      cycles across the tile, so each term is periodic in u and v
      by construction and the tile is seamless under any drift.
      The largest frequency shift this introduces is under 20 %,
      on a pattern whose absolute frequencies are arbitrary.

   2. THE GOBO IS NORMALISED TO MEAN 1, NOT PEAK 1. The R8
      texture stores the raw pow(c, 2.5) field in [0, 1], whose
      area mean is about 0.16; causticAt() multiplies the fetch by
      COOKIE_GAIN = 1 / mean. This matters physically and
      radiometrically. The sea surface redistributes the sunlight
      that crosses it, it does not throw 84 % of it away, so a
      field that only ever darkens SUN_E0 would leave the shafts
      dimmer than the ambient veil they are supposed to stand out
      from. With the gain, causticAt() averages to 1, peaks near
      4, and — because a box-filtered mip chain preserves the mean
      — converges to exactly 1 at the coarse mips. That is the
      correct behaviour for the depth blur in point 3: light gets
      diffuse with depth, it does not get dim with depth.

   3. THE MEAN IS MEASURED AT LOAD, NOT GUESSED. COOKIE_MEAN is
      computed here by evaluating the JS twin of the shader on a
      low-discrepancy point set, and emitted into the GLSL as a
      #define. It costs a couple of milliseconds inside the 1.2 s
      boot fade and it means the gain can never drift away from
      the pattern if a constant is ever retuned.

   ---- Conventions this file fixes for everyone else ----

   uSunDir is the direction the SUNLIGHT TRAVELS: it points DOWN,
   uSunDir.y < 0, and at the spec's 72 degree elevation it is
   about (·, -0.951, ·). This is forced by §2.2's phase term
   hg(dot(rd, -uSunDir), 0.62), which has to peak when the view
   ray looks up towards the sun. Getting this backwards puts the
   godrays on the sea floor.

   uWorldOrigin is the true world-space position of the renderer's
   origin. §4.3 keeps the animal near p = 0 and scrolls the sea
   past it, so a shader's own coordinates are not world
   coordinates; adding uWorldOrigin recovers them. Every depth fed
   to downwelling(), inscatter() or waterApply() must be a TRUE
   depth — negative, around -14 — so seaDepth() is provided here
   and every caustic-lit shader should use it. Left unset the
   uniform is zero, which simply means render space is world
   space, so nothing breaks if the floating origin is not wired.
   ============================================================ */

/* --- Pattern geometry -------------------------------------------------- */

/** Side of the gobo texture, in texels. Spec §1's buffer table. */
export const COOKIE_SIZE = 256;

/**
 * Levels in the mip chain, base included. §2.1 clamps the depth-driven mip to
 * 4.0, so level 4 has to exist or the fetch silently saturates one level early
 * and the deep water stops getting softer. 256 -> 16 texels at level 4.
 */
export const COOKIE_MIP_LEVELS = 5;

/** The `mip` clamp ceiling in causticAt(). Must equal COOKIE_MIP_LEVELS - 1. */
export const COOKIE_MIP_MAX = 4.0;

/** Mip levels gained per metre of depth. §2.1: `clamp(-p.y * 0.11, 0.0, 4.0)`. */
export const COOKIE_MIP_PER_METRE = 0.11;

/** Number of ridged octaves per layer. Spec §2.1's `for (int i = 0; i < 3; i++)`. */
export const COOKIE_OCTAVES = 3;

/** Per-octave amplitude falloff, spec §2.1's `a *= 0.58`. */
export const COOKIE_OCTAVE_GAIN = 0.58;

/** Spec §2.1's ridge normaliser: `1.0 - k / 1.85`. */
export const COOKIE_RIDGE_NORM = 1.85;

/**
 * Spec §2.1's softening exponent. 2.5, NEVER 6.0. Sharp filaments crawling over
 * the subject are agitating rather than calming, and §10 attaches a measured
 * rate budget to this number. It is not a taste parameter.
 */
export const COOKIE_SHARPNESS = 2.5;

/** Spec §2.1's internal animation rate: `sin(q.y*1.6 + t*0.42)`. */
export const COOKIE_TIME_RATE = 0.42;

/**
 * The rotation between octaves, spec §2.1's `mat2(0.80,-0.60,0.60,0.80)`.
 * Stored row-major as [m00, m01, m10, m11]: a GLSL mat2 constructor takes
 * COLUMNS, so that literal is the matrix whose rows are (0.80, 0.60) and
 * (-0.60, 0.80) — a rotation, determinant exactly 1.
 */
const COOKIE_ROTATION = [0.80, 0.60, -0.60, 0.80];

/** Per-octave inter-octave zoom, spec §2.1's `* 1.7`. */
const COOKIE_OCTAVE_ZOOM = 1.7;

/** Per-octave frequency stretch, spec §2.1's `(1.0 + 0.9*float(i))`. */
const COOKIE_OCTAVE_STRETCH = 0.9;

/** Per-octave domain offset, spec §2.1's `+ float(i)*17.3`. */
const COOKIE_OCTAVE_OFFSET = 17.3;

/** Frequency of the outer sine, spec §2.1's `q.x*1.9`. */
const COOKIE_FREQ_X = 1.9;

/** Frequency of the inner sine, spec §2.1's `q.y*1.6`. */
const COOKIE_FREQ_Y = 1.6;

/**
 * Domain width of one tile, in the `p` units of §2.1's ridged(). Chosen as
 * 3 * TAU / 1.9 so that the base octave lands on exactly three whole cycles per
 * tile and the frequency rounding of point 1 above is a no-op for the term that
 * carries most of the pattern's energy. It also sets the finest octave at about
 * six texels per cycle at 256², which is comfortably above the Nyquist limit of
 * the level-0 image — and level 0 is only reached above 9 m depth, which the
 * camera at 14 m never sees.
 */
const COOKIE_DOMAIN = (3.0 * 2.0 * Math.PI) / COOKIE_FREQ_X;

/**
 * The two counter-drifting layers of §2.1, at scale 1.0x and 1.7x. Two wave
 * trains at different scales moving in different directions is what stops the
 * field settling into a standing beat, which a single layer does within a
 * minute and which the eye finds immediately.
 */
const COOKIE_LAYER_SCALES = [1.0, 1.7];

/** Weights of the two layers in the composite. They sum to 1. */
const COOKIE_LAYER_WEIGHTS = [0.62, 0.38];

/**
 * Layer drift velocities in tile units per second. Their SPEEDS are §2.1's
 * `0.025` and `-0.016` u/s exactly; the directions are 110 degrees apart so the
 * two trains shear across one another instead of sliding along one axis.
 *
 * These are the already-halved rates of §5.3's calm budget. They are a shipping
 * requirement with a test attached in §10 and must not be raised.
 */
export const COOKIE_LAYER_DRIFT = Object.freeze([
  Object.freeze([0.025 * 0.9578262852, 0.025 * 0.2873478855]),
  Object.freeze([-0.016 * 0.5144957554, 0.016 * 0.8574929257])
]);

/* --- Sampling-side defaults ------------------------------------------- */

/**
 * `uCookieScale`, in tiles per metre: one tile of gobo covers 6 m of sea
 * surface. That puts the base caustic cell at about 2 m and the finest visible
 * structure at about 15 cm, which is the scale that gives §5.3's "three or four
 * columns, a suggestion of light" across a 38 degree frame and still leaves a
 * readable ripple crawling over a 26 cm bell.
 */
export const COOKIE_WORLD_SCALE = 1.0 / 6.0;

/**
 * `uCookieDrift` velocity in tiles per second — the bulk advection of the
 * surface wave train, on top of the two layers' internal drift. Slow (under
 * 3 cm/s of pattern motion) and deliberately not commensurate with either layer
 * speed, so the composite never returns to a pose it has held before.
 */
export const COOKIE_DRIFT_RATE = Object.freeze([0.0045, -0.0028]);

/** Time-rate multiplier for `prefers-reduced-motion`. §4.6: caustics at 15 %. */
export const COOKIE_TIME_SCALE_REDUCED = 0.15;

/**
 * Writes `uCookieDrift` for a given clock time into `out` (a length-2
 * indexable) and returns it. Allocation-free so it can be called every frame.
 */
export function cookieDrift(out, time) {
  out[0] = COOKIE_DRIFT_RATE[0] * time;
  out[1] = COOKIE_DRIFT_RATE[1] * time;
  return out;
}

/* --- Frequency table --------------------------------------------------- */

/**
 * One entry per (layer, octave): the two wave vectors and their phases, in the
 * tile's own uv space. Every component of every wave vector is TAU times a whole
 * number, which is what makes the emitted GLSL tile exactly.
 */
function buildWaveTable() {
  const TAU = 2.0 * Math.PI;
  const [m00, m01, m10, m11] = COOKIE_ROTATION;
  const layers = [];

  for (let layer = 0; layer < COOKIE_LAYER_SCALES.length; layer++) {
    const domain = COOKIE_DOMAIN * COOKIE_LAYER_SCALES[layer];
    // T accumulates (1.7 * ROT)^i, applied to p before the per-octave stretch.
    let t00 = 1, t01 = 0, t10 = 0, t11 = 1;
    const octaves = [];

    for (let i = 0; i < COOKIE_OCTAVES; i++) {
      const stretch = 1.0 + COOKIE_OCTAVE_STRETCH * i;
      // Row 0 of the octave transform drives the outer sine, row 1 the inner.
      const rawX = [COOKIE_FREQ_X * stretch * t00, COOKIE_FREQ_X * stretch * t01];
      const rawY = [COOKIE_FREQ_Y * stretch * t10, COOKIE_FREQ_Y * stretch * t11];

      // Round to whole cycles across the tile. A term that rounds to (0, 0)
      // would be a constant and would waste an octave, so the dominant
      // component is nudged to one full cycle instead.
      const quantise = (k) => {
        const cycles = [
          Math.round((k[0] * domain) / TAU),
          Math.round((k[1] * domain) / TAU)
        ];
        if (cycles[0] === 0 && cycles[1] === 0) {
          const dominant = Math.abs(k[0]) >= Math.abs(k[1]) ? 0 : 1;
          cycles[dominant] = k[dominant] >= 0 ? 1 : -1;
        }
        return [TAU * cycles[0], TAU * cycles[1]];
      };

      octaves.push({
        amplitude: Math.pow(COOKIE_OCTAVE_GAIN, i),
        waveX: quantise(rawX),
        waveY: quantise(rawY),
        phaseX: COOKIE_FREQ_X * COOKIE_OCTAVE_OFFSET * i,
        phaseY: COOKIE_FREQ_Y * COOKIE_OCTAVE_OFFSET * i
      });

      // p = mat2(...) * p * 1.7, for the next octave.
      const n00 = COOKIE_OCTAVE_ZOOM * (m00 * t00 + m01 * t10);
      const n01 = COOKIE_OCTAVE_ZOOM * (m00 * t01 + m01 * t11);
      const n10 = COOKIE_OCTAVE_ZOOM * (m10 * t00 + m11 * t10);
      const n11 = COOKIE_OCTAVE_ZOOM * (m10 * t01 + m11 * t11);
      t00 = n00; t01 = n01; t10 = n10; t11 = n11;
    }
    layers.push(octaves);
  }
  return layers;
}

const WAVE_TABLE = buildWaveTable();

/**
 * One ridged layer of the gobo, in the tile's uv space. This is the JS twin of
 * the emitted `cookieLayerN` functions and is what COOKIE_MEAN is measured from,
 * so the two must stay in step: both are generated from WAVE_TABLE.
 */
function cookieLayer(layer, u, v, time) {
  const octaves = WAVE_TABLE[layer];
  let k = 0.0;
  for (let i = 0; i < octaves.length; i++) {
    const o = octaves[i];
    const inner = Math.sin(o.waveY[0] * u + o.waveY[1] * v + o.phaseY + time * COOKIE_TIME_RATE);
    k += o.amplitude * Math.abs(Math.sin(o.waveX[0] * u + o.waveX[1] * v + o.phaseX + inner));
  }
  return Math.pow(Math.max(1.0 - k / COOKIE_RIDGE_NORM, 0.0), COOKIE_SHARPNESS);
}

/**
 * The complete gobo value at tile coordinate (u, v) and time `t`, in [0, 1] —
 * exactly what the R8 texture stores, before COOKIE_GAIN is applied on read.
 * Exported so the value the CPU believes in can be checked against a readback
 * of the real texture, and so the far-field snow twinkle could be predicted on
 * the CPU if that is ever wanted.
 */
export function sampleCookieGobo(u, v, t) {
  let sum = 0.0;
  for (let layer = 0; layer < WAVE_TABLE.length; layer++) {
    const d = COOKIE_LAYER_DRIFT[layer];
    sum += COOKIE_LAYER_WEIGHTS[layer] * cookieLayer(layer, u + d[0] * t, v + d[1] * t, t);
  }
  return sum;
}

/**
 * Measures the area mean and the peak of the gobo. The sample points are an R2
 * (plastic-number) lattice rather than a grid, because the pattern has tens of
 * cycles across the tile and a regular grid of comparable size aliases against
 * it badly enough to bias the mean by several per cent. Three time slices guard
 * against an unlucky phase; the field is stationary, so three is plenty.
 */
function measureCookieField() {
  const SAMPLES = 4096;
  const PLASTIC = 1.32471795724474602596;
  const a1 = 1.0 / PLASTIC;
  const a2 = 1.0 / (PLASTIC * PLASTIC);
  const times = [0.0, 7.3, 19.7];

  let sum = 0.0;
  let peak = 0.0;
  for (let s = 0; s < SAMPLES; s++) {
    const u = (0.5 + a1 * s) % 1.0;
    const v = (0.5 + a2 * s) % 1.0;
    for (let ti = 0; ti < times.length; ti++) {
      const c = sampleCookieGobo(u, v, times[ti]);
      sum += c;
      if (c > peak) peak = c;
    }
  }
  return { mean: sum / (SAMPLES * times.length), peak };
}

const COOKIE_FIELD = measureCookieField();

/** Measured area mean of the stored [0, 1] gobo. See decision 3 in the header. */
export const COOKIE_MEAN = COOKIE_FIELD.mean;

/** Measured peak of the stored gobo. Diagnostic only; nothing multiplies by it. */
export const COOKIE_PEAK = COOKIE_FIELD.peak;

/**
 * What causticAt() multiplies the texture fetch by, so that the caustic field
 * averages to unity and a coarse mip converges to "full, diffuse sunlight"
 * rather than to "darkness". causticAt() therefore returns roughly 1 in open
 * water and roughly COOKIE_PEAK * COOKIE_GAIN inside a filament.
 */
export const COOKIE_GAIN = 1.0 / COOKIE_MEAN;

/* --- GLSL emission ----------------------------------------------------- */

/** GLSL float literal: always carries a decimal point, so `1` never becomes an int. */
function f(x, digits = 6) {
  if (!Number.isFinite(x)) throw new Error(`cookie.js: refusing to emit non-finite GLSL constant ${x}`);
  return x.toFixed(digits);
}

function emitLayer(layer) {
  const octaves = WAVE_TABLE[layer];
  const lines = [`float cookieLayer${layer}(vec2 uv, float t){`, `  float k = 0.0;`];
  for (let i = 0; i < octaves.length; i++) {
    const o = octaves[i];
    lines.push(
      `  k += ${f(o.amplitude)} * abs(sin(dot(vec2(${f(o.waveX[0])}, ${f(o.waveX[1])}), uv) + ${f(o.phaseX)}`
    );
    lines.push(
      `           + sin(dot(vec2(${f(o.waveY[0])}, ${f(o.waveY[1])}), uv) + ${f(o.phaseY)} + t * COOKIE_TIME_RATE)));`
    );
  }
  lines.push(`  return pow(max(1.0 - k / COOKIE_RIDGE_NORM, 0.0), COOKIE_SHARPNESS);`);
  lines.push(`}`);
  return lines.join('\n');
}

/**
 * The gobo generator. Pair it with FULLSCREEN_TRIANGLE_VS from gl.js and draw
 * three vertices into the 256² R8 COOKIE target, then call generateMipmap() on
 * it. Blend off, depth off, cull off.
 *
 * `uCookieTime` is the caustic clock in seconds. Under `prefers-reduced-motion`
 * it should advance at COOKIE_TIME_SCALE_REDUCED of real time (§4.6); it must
 * never run backwards, and it must be the same clock the shafts see, or the
 * ripple on the bell and the shaft it belongs to will drift apart.
 */
export const COOKIE_FS = `
uniform float uCookieTime;

in  vec2 vUV;
out vec4 fragColor;

#define COOKIE_TIME_RATE ${f(COOKIE_TIME_RATE)}
#define COOKIE_RIDGE_NORM ${f(COOKIE_RIDGE_NORM)}
#define COOKIE_SHARPNESS ${f(COOKIE_SHARPNESS)}

// Every wave vector below is TAU times a whole number of cycles across the
// tile, so each term closes on itself in u and in v and the texture can be
// sampled with REPEAT without laying a seam across the water. See decision 1
// in this file's header for why that matters more than it sounds like it does.
${emitLayer(0)}

${emitLayer(1)}

void main(){
  // Two wave trains at different scales, drifting in different directions.
  // Their weighted sum keeps the field's mean fixed (which is what COOKIE_GAIN
  // is measured against) while removing any single dominant period from it.
  vec2 dA = vec2(${f(COOKIE_LAYER_DRIFT[0][0])}, ${f(COOKIE_LAYER_DRIFT[0][1])}) * uCookieTime;
  vec2 dB = vec2(${f(COOKIE_LAYER_DRIFT[1][0])}, ${f(COOKIE_LAYER_DRIFT[1][1])}) * uCookieTime;

  float c = ${f(COOKIE_LAYER_WEIGHTS[0])} * cookieLayer0(vUV + dA, uCookieTime)
          + ${f(COOKIE_LAYER_WEIGHTS[1])} * cookieLayer1(vUV + dB, uCookieTime);

  // Stored raw in [0, 1]; the mean-to-one normalisation happens on read, so the
  // mip chain averages the honest field and converges to the honest mean.
  fragColor = vec4(c, c, c, 1.0);
}
`;

/**
 * The read side — §2.1's causticAt(), plus the two world-space helpers every
 * caustic-lit shader needs. Include this (after COMMON_GLSL) in the shafts, the
 * bell, the strands and the snow. It is the ONLY place uCookie is sampled.
 *
 * The uniforms it declares, and who has to set them:
 *   uCookie       sampler2D  the 256² R8 gobo, LINEAR_MIPMAP_LINEAR, REPEAT
 *   uCookieScale  float      tiles per metre; COOKIE_WORLD_SCALE
 *   uCookieDrift  vec2       tiles; cookieDrift(out, time)
 *   uSunDir       vec3       unit, pointing DOWN along the light's travel
 *   uWorldOrigin  vec3       true world position of the render origin; may be
 *                            left at zero, which means render space is world
 *                            space
 *
 * A shader that includes this must NOT redeclare any of them.
 */
export const CAUSTIC_GLSL = `
// ---- cookie.js: the one caustic field, spec §2.1 / §5.3 -------------------
#define COOKIE_MIP_PER_METRE ${f(COOKIE_MIP_PER_METRE)}
#define COOKIE_MIP_MAX ${f(COOKIE_MIP_MAX)}
#define COOKIE_GAIN ${f(COOKIE_GAIN)}

uniform sampler2D uCookie;
uniform float uCookieScale;
uniform vec2  uCookieDrift;
uniform vec3  uSunDir;
uniform vec3  uWorldOrigin;

// §4.3's floating origin keeps the animal near p = 0 and scrolls the sea past
// it, so a shader's own coordinates are not world coordinates. Everything that
// asks the medium a question — downwelling, inscatter, waterApply, the caustic
// projection — needs the TRUE position, and in particular a true depth, which
// is negative below the surface.
vec3 seaWorld(vec3 p){ return p + uWorldOrigin; }
float seaDepth(vec3 p){ return p.y + uWorldOrigin.y; }

// Projects a point up the sun ray onto the surface plane and reads the gobo
// there. The mip term is physical rather than cosmetic: multiple scattering
// diffuses a shaft as it descends, so caustics are crisp just under the surface
// and soft at 14 m. Because the gobo is normalised to mean 1 and its mips are
// box filtered, blurring costs sharpness and never brightness — which is also
// what keeps the §7 ladder invisible.
//
// uSunDir.y is clamped away from zero only to keep a horizontal sun from
// producing a NaN frame; at the spec's 72 degree elevation it is about -0.951
// and the clamp is never reached.
float causticAt(vec3 p){
  vec3  w   = seaWorld(p);
  vec2  uv  = (w.xz - uSunDir.xz * (w.y / min(uSunDir.y, -0.01))) * uCookieScale + uCookieDrift;
  float mip = clamp(-w.y * COOKIE_MIP_PER_METRE, 0.0, COOKIE_MIP_MAX);
  return textureLod(uCookie, uv, mip).r * COOKIE_GAIN;
}
`;
