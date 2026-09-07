/* ============================================================
   shaders/common.js — spec §2.0 verbatim, plus the assembler.
   ------------------------------------------------------------
   Two things live here and nothing else.

   COMMON_GLSL is the shared prelude of spec §2.0, reproduced
   exactly as the spec fixes it. It is prepended to every program
   in the project, which is what guarantees that the water column,
   the shafts, the bell, the strands and the snow cannot disagree
   about the medium they are all sitting in. `waterApply()` in
   particular ends every shader; it is the single reason the
   animal reads as being IN the water rather than composited on
   top of it. Do not edit these constants to taste. Every blue on
   screen is derived from them by absorption — there is no blue
   anywhere in the render path — so changing one of them regrades
   the entire frame, and §5.5's hex anchors stop being reachable.

   assembleShader() is the other half: it builds the exact string
   handed to the driver. GLSL ships as ES-module template strings
   and is concatenated at program-build time, never fetched, so
   the page runs identically from file:// and from Pages. That is
   a hard constraint in §1 and it is why this function exists
   rather than a loader.

   Assembly order is fixed and matters:
     1. #version 300 es      — must be the very first characters
                               of the string. Not a leading blank
                               line, not a leading comment. Safari
                               rejects the shader outright if the
                               directive is not at offset zero.
     2. default precision    — a fragment shader in ES 3.00 has NO
                               default float precision and must
                               declare one. sampler2D defaults to
                               LOWP in the fragment language, which
                               on a mobile GPU can quantise a read
                               from an RGBA16F target down to
                               something visibly banded, so it is
                               raised to highp explicitly.
     3. #define block        — so the common prelude and the stage
                               source can both branch on them.
     4. COMMON_GLSL          — §2.0.
     5. includes             — NOISE_GLSL, PROFILE_GLSL, and so on,
                               in the order given. They may use
                               anything from §2.0 and must not
                               redefine it.
     6. the stage source.

   The assembled string is what gl.js's annotated error dump
   prints and numbers, so a reported line number always refers to
   something you can look at.
   ============================================================ */

export const GLSL_VERSION_DIRECTIVE = '#version 300 es';

/* --- Spec §2.0, verbatim ---------------------------------------------- */

export const COMMON_GLSL = `#define PI 3.14159265
#define TAU 6.28318531

// --- The medium. Two coefficient sets, deliberately. -----------------
// Beam attenuation (for transmittance over a path). Jerlov IB->II.
const vec3 SIG_T_W = vec3(0.560, 0.230, 0.170);   // 1/m
// Scattering only (for in-scatter). Blue-leaning: lambda^-4 lean + particulate.
const vec3 SIG_S_W = vec3(0.045, 0.055, 0.075);   // 1/m
// Diffuse downwelling attenuation with DEPTH. NOT the same number.
const vec3 KD      = vec3(0.420, 0.075, 0.032);   // 1/m
// Mesoglea. Reduced (similarity theory) at use site.
const vec3 SIG_A_G = vec3(2.60, 0.55, 0.16);      // 1/m
// Raised from (14.0, 16.5, 19.0): with g = 0.72 those reduce to under 5.3 /m,
// so even a centimetre and a half of dome scattered a tenth of the light that
// reached it and the animal came out fainter than the water column §5.5 says
// it should sit three to four times above. Mesoglea is mostly sea water and
// its scattering is genuinely low, but not that low -- a moon jelly is legible
// from metres away in a photograph, and these are the numbers that make the
// render agree with the palette anchors the spec verifies against.
const vec3 SIG_S_G = vec3(22.0, 26.0, 30.0);      // 1/m
const float G_GEL  = 0.72;                        // was 0.86 -- see §4.5

// Scene-referred, essentially white. NEVER tinted blue.
const vec3 SUN_E0  = vec3(1.00, 1.02, 1.05) * 22.0;

// Downwelling radiance at depth. worldY <= 0, surface at y = 0.
vec3 downwelling(float y){ return SUN_E0 * exp(KD * y); }

// Ambient in-scatter: single-scattering albedo x downwelling x phase. The last
// factor is a RADIANCE normalisation, not a taste knob: downwelling() is an
// irradiance, and what a horizontal view ray sees is the fraction of it that
// scatters into one steradian around 90 degrees off the vertical, which is
// hg(0.0, G_GEL's water analogue 0.62) = 0.030. It was a flat 0.75 -- twenty
// five times too much -- and that single number is what made the frame one
// featureless field: the shafts, the marine snow and the animal are all lit
// from downwelling() directly and were sitting five per cent above a veil that
// should have been five stops below them.
vec3 inscatter(float y){ return (SIG_S_W / SIG_T_W) * downwelling(y) * 0.030; }

// THE SHARED SNIPPET. Ends every shader in the project. This one function is
// why the animal sits IN the water instead of on top of it.
vec3 waterApply(vec3 c, float dist, float y){
  vec3 T = exp(-SIG_T_W * dist);
  return c * T + inscatter(y) * (1.0 - T);
}

float hg(float c, float g){
  float g2 = g*g;
  return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5));
}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056,0.00583715)))); }
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; return fract(p*(p+p)); }
`;

/**
 * The same constants as JavaScript numbers, for the handful of places the CPU
 * has to agree with the shader: the auto-exposure key, the §5.5 palette
 * verification harness, and the poster frame's ground colour. They are a
 * TRANSCRIPTION of COMMON_GLSL above, so if one is ever edited the other must
 * be edited in the same commit. Nothing in the render path reads these — the
 * GPU reads the GLSL — which is why a copy is acceptable here and nowhere else.
 */
export const MEDIUM = Object.freeze({
  /** Beam attenuation, 1/m. Transmittance over a path. Jerlov IB->II. */
  SIG_T_W: Object.freeze([0.560, 0.230, 0.170]),
  /** Scattering only, 1/m. In-scatter and the veil floor. */
  SIG_S_W: Object.freeze([0.045, 0.055, 0.075]),
  /** Diffuse downwelling attenuation with depth, 1/m. NOT the beam coefficient. */
  KD: Object.freeze([0.420, 0.075, 0.032]),
  /** Mesoglea absorption, 1/m. */
  SIG_A_G: Object.freeze([2.60, 0.55, 0.16]),
  /** Mesoglea scattering, 1/m. Reduce by (1 - G_GEL) at the use site. */
  SIG_S_G: Object.freeze([22.0, 26.0, 30.0]),
  /** Mesoglea phase asymmetry. Lowered from 0.86 to kill the periodic backlight flare. */
  G_GEL: 0.72,
  /** Scene-referred sun irradiance. Essentially white, never tinted blue. */
  SUN_E0: Object.freeze([1.00 * 22.0, 1.02 * 22.0, 1.05 * 22.0]),
  /** Camera depth in metres. Negative: the surface is y = 0 and down is −y. */
  CAMERA_DEPTH_Y: -14.0
});

/** JS twin of `downwelling(y)`. `y` is NEGATIVE below the surface. Writes into `out`. */
export function downwelling(out, y) {
  const e = MEDIUM.SUN_E0, k = MEDIUM.KD;
  out[0] = e[0] * Math.exp(k[0] * y);
  out[1] = e[1] * Math.exp(k[1] * y);
  out[2] = e[2] * Math.exp(k[2] * y);
  return out;
}

/** JS twin of `inscatter(y)`. `y` is NEGATIVE below the surface. Writes into `out`. */
export function inscatter(out, y) {
  const s = MEDIUM.SIG_S_W, t = MEDIUM.SIG_T_W;
  downwelling(out, y);
  out[0] *= (s[0] / t[0]) * 0.030;
  out[1] *= (s[1] / t[1]) * 0.030;
  out[2] *= (s[2] / t[2]) * 0.030;
  return out;
}

/* --- Assembly ---------------------------------------------------------- */

const VERSION_RE = /^\s*#version[^\n]*\n?/;

/**
 * Removes a leading `#version` directive from a stage source. Several of the
 * listings in the spec include one (thickness.js does), and a second `#version`
 * anywhere but the first line is a compile error, so it is stripped rather than
 * left to surprise someone.
 */
export function stripVersionDirective(source) {
  return source.replace(VERSION_RE, '');
}

/**
 * Turns `{ SHAFT_STEPS: 16, SUBUMBRELLA: true, ANALYTIC_THICKNESS: false }`
 * into `#define` lines. A `true` value defines the name with no replacement,
 * which is what `#ifdef SUBUMBRELLA` wants; a `false`, `null` or `undefined`
 * value omits the define entirely, so a caller can pass a flag object straight
 * through without filtering it first.
 */
export function definesToGLSL(defines) {
  if (!defines) return '';
  const out = [];
  for (const key in defines) {
    if (!Object.prototype.hasOwnProperty.call(defines, key)) continue;
    const v = defines[key];
    if (v === false || v === null || v === undefined) continue;
    if (v === true) out.push(`#define ${key}`);
    else out.push(`#define ${key} ${v}`);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/**
 * Builds one complete shader source string.
 *
 *   stage      'vertex' | 'fragment'  (required)
 *   source     the stage-specific GLSL (required)
 *   defines    object, as described on definesToGLSL
 *   includes   array of extra GLSL chunks, inserted after COMMON_GLSL in order
 *   common     set false only for a shader that must not see §2.0; nothing in
 *              the shipped renderer does
 *   precision  'highp' | 'mediump'; highp everywhere, because the thickness
 *              pass's relative encoding and the HDR targets both depend on it
 */
export function assembleShader(options) {
  const {
    stage,
    source,
    defines = null,
    includes = [],
    common = true,
    precision = 'highp'
  } = options;

  if (stage !== 'vertex' && stage !== 'fragment') {
    throw new Error(`common.js: assembleShader needs stage 'vertex' or 'fragment', got '${stage}'`);
  }
  if (typeof source !== 'string') {
    throw new Error(`common.js: assembleShader needs a source string for the ${stage} stage`);
  }

  const parts = [GLSL_VERSION_DIRECTIVE, ''];

  parts.push(`precision ${precision} float;`);
  parts.push(`precision ${precision} int;`);
  // sampler2D defaults to lowp in BOTH ES 3.00 languages, not just the fragment
  // one. Reading an RGBA16F target through a lowp sampler is legal and quantises
  // visibly on tile-based GPUs, which is exactly the class of bug that only
  // shows up on someone else's phone. It has to be emitted here rather than in
  // a stage source because the includes are concatenated ahead of that source,
  // and a precision statement binds only the declarations that FOLLOW it.
  parts.push(`precision ${precision} sampler2D;`);
  parts.push('');

  const defineBlock = definesToGLSL(defines);
  if (defineBlock) parts.push(defineBlock);

  if (common) parts.push(COMMON_GLSL);
  for (const chunk of includes) if (chunk) parts.push(chunk);
  parts.push(stripVersionDirective(source));

  return parts.join('\n');
}

/**
 * Convenience wrapper for the usual case: one program, two stages, the same
 * defines and includes on both. Returns `{ vertex, fragment }` ready to hand to
 * `createProgram` in gl.js, which does no assembly of its own — so the string
 * the driver rejects is the string whose line numbers get printed.
 */
export function assembleProgramSources(options) {
  const {
    vertex,
    fragment,
    defines = null,
    includes = [],
    vertexIncludes = null,
    fragmentIncludes = null,
    common = true,
    precision = 'highp'
  } = options;

  return {
    vertex: assembleShader({
      stage: 'vertex',
      source: vertex,
      defines,
      includes: vertexIncludes || includes,
      common,
      precision
    }),
    fragment: assembleShader({
      stage: 'fragment',
      source: fragment,
      defines,
      includes: fragmentIncludes || includes,
      common,
      precision
    })
  };
}
