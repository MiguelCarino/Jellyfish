/* ============================================================
   shaders/post.js — spec §6, the whole composite, in order.
   ------------------------------------------------------------
   Five fragment programs, all of them fullscreen-triangle
   passes that pair with FULLSCREEN_TRIANGLE_VS from gl.js
   (which declares `layout(location = 0) in vec2 aPos;` and
   supplies `out vec2 vUV;`). None of them declares a vertex
   stage of its own, and none of them is ever fetched — they are
   template strings so the page renders identically from file://
   and from Pages.

     BRIGHT_PASS_FS   FINAL (RS)     -> BLOOM[0].down (RS/2)
     KAWASE_DOWN_FS   BLOOM[i-1]     -> BLOOM[i].down
     KAWASE_UP_FS     BLOOM[i+1]     -> BLOOM[i].up
     EXPOSURE_FS      BLOOM[N-1]     -> EXPO 1x1 (log2 EV, encoded)
     COMPOSITE_FS     FINAL + bloom  -> the default framebuffer

   The order inside COMPOSITE_FS is fixed by §6 and every step of
   it was argued over by the judge panel. The four decisions that
   are load-bearing, and must not be quietly undone:

   1. SENSOR NOISE IS INJECTED PRE-TONEMAP, in linear HDR.
      Underwater photography is high-ISO; what a viewer reads as
      "a camera was here" is shot noise, which scales with the
      square root of the signal and is therefore loudest in the
      shadows. Grain added after the transfer curve is uniform
      across the tonal range and always reads as a Photoshop
      filter. The amplitudes below assume gaussIGN() has unit
      variance, which noise.js guarantees.

   2. AGX, NOT ACES AND NOT REINHARD-JODIE. ACES' RRT skews
      saturated blue toward cyan and clips it neon, which is
      fatal in a frame that has no other hue to hide behind.
      Reinhard-Jodie preserves hue including at the highlight,
      but an overexposed bell in a real photograph goes pale and
      then near-white. AgX desaturates on rolloff, which is the
      behaviour of film and of every sensor. The polynomial here
      is the §6 listing verbatim; its output is already
      display-encoded, so it goes straight to the default
      framebuffer with no further transfer curve.

   3. THE BLUE LOCK IS A GUARD RAIL, NOT A GRADE. Both proposed
      blue grades were rejected: a fixed ramp destroys the hue
      drift with distance that reads as depth, and a mix toward a
      blue constant undoes AgX's desaturation on the highlight.
      blueGuard() is a clamp that forbids chroma from leaving the
      blue-cyan wedge and is a NO-OP on a correct frame. It
      exists so that no shader bug can ever ship a green
      jellyfish. Do not turn it back into a lerp.

   4. THE VIGNETTE FALLS TO THE FAR-FIELD VEIL COLOUR, NEVER TO
      BLACK. There is no black underwater — inscatter() puts a
      floor under every pixel in the scene, and §10 tests that no
      pixel is pure black over a 60-frame sample. #04070E is that
      floor, and it is the same number css/jellyfish.css carries
      as --sea-veil.

   Two further properties exist for the quality ladder's sake
   (§7 requires every tier change to be invisible):

   * The bloom composite weight is divided by the live level
     count. Each level of a dual-filter chain is mean-preserving,
     so five levels carry 2.5x the energy of two; without the
     division, dropping to bloom 2 at tier 3 would be a visible
     brightness step rather than a change of halo width.
   * The veiling-glare term reads the smallest allocated mip.
     Because the down filter is normalised, every level has the
     same mean, so the flat veil contribution does not move when
     the ladder changes the level count.

   The tuning rule from §6 applies to every constant in
   POST_CONSTANTS: if you can name the effect while looking at
   the image, it is too strong.
   ============================================================ */

/**
 * Every tunable in the post chain, in one block, as §6 requires. These are the
 * single source of truth: the GLSL below is generated from them, so there is no
 * second copy to drift. A `?dev=1` panel that wants live knobs should drive the
 * handful of uniforms instead of editing these.
 */
export const POST_CONSTANTS = Object.freeze({
  /* Bloom. The knee sits ABOVE anything the F0 = 4e-4 sheen on the bell can
     produce, so bloom serves only the shaft cores and the tau-driven rim. This
     is one of the four independent fixes for the periodic backlight flare. */
  BLOOM_THRESHOLD: 1.15,
  BLOOM_KNEE: 0.6,
  BLOOM_WEIGHT: 0.055,
  BLOOM_MAX_LEVELS: 5,

  /* Veiling glare off the smallest mip, added flat. Real underwater footage
     always has it and its absence is what made the winner read as clean CG. */
  VEIL_WEIGHT: 0.035,

  /* Lateral chromatic aberration, applied as the composite's three-tap read.
     Sub-pixel at centre, roughly 1.3 px in the corners of a 16:9 1080p frame. */
  CA_K_R: 0.0011,
  CA_K_B: -0.0009,

  /* Sensor shot + read noise, pre-tonemap, in linear HDR. */
  NOISE_SHOT: 0.010,
  NOISE_READ: 0.0016,
  NOISE_CHROMA: 0.0030,

  /* Auto-exposure. Clamped far tighter than a game's eye adaptation: a periodic
     brightness pump in peripheral vision at 3am is the classic ambient killer. */
  EXPOSURE_TAU: 3.0,
  EXPOSURE_EV_CLAMP: 0.25,
  EXPOSURE_EV_RATE: 0.08,
  EXPOSURE_DEADZONE_EV: 0.05,
  EXPOSURE_KEY: 0.020,
  /* The 1x1 EXPO target stores ev * 0.5 + 0.5 so the same shader works whether
     it was allocated R16F or, on the no-float path, RGBA8. */
  EXPOSURE_ENCODE_SCALE: 0.5,
  EXPOSURE_ENCODE_BIAS: 0.5,

  /* Vignette. `natural` is the honest cos^4 of the real field angle; the
     mechanical term is the lens barrel on top of it. */
  VIGNETTE_MECHANICAL: 0.30,
  VIGNETTE_MECH_START: 0.55,
  VIGNETTE_MECH_END: 1.00,
  /** #04070E, the §5.5 far-field veil. Display-referred, because the vignette
      is applied after AgX. Never black. */
  VIGNETTE_VEIL: Object.freeze([4 / 255, 7 / 255, 14 / 255]),
  VIGNETTE_VEIL_HEX: '#04070E',

  /* FXAA 9-tap, used only when MSAA was not probed in. */
  FXAA_EDGE_THRESHOLD: 0.125,
  FXAA_EDGE_THRESHOLD_MIN: 0.0312,
  FXAA_SPAN_MAX: 8.0,
  FXAA_REDUCE_MUL: 1.0 / 8.0,
  FXAA_REDUCE_MIN: 1.0 / 128.0,

  /* Triangular-PDF dither, +-1 LSB of an 8-bit panel. Non-negotiable: a
     near-black blue ramp on 8 bits bands catastrophically and this page is
     stared at for hours on a dark second monitor. */
  DITHER_LSB: 1.0 / 255.0,

  /** Pre-exposure applied on write to an RGBA8 SEA/FINAL, undone on read here.
      1/8 buys three stops of headroom above 1.0; the dither covers the loss. */
  HDR_PRE_EXPOSURE: 1.0 / 8.0
});

/**
 * The `#define` names COMPOSITE_FS understands. Everything else about the chain
 * is a uniform, so the ladder can move it without a recompile — only the
 * MSAA-vs-FXAA choice is fixed for the life of the context.
 */
export const POST_DEFINES = Object.freeze({
  /** Enable the 9-tap FXAA. Omit when FINAL was allocated multisampled. */
  POST_FXAA: 'POST_FXAA'
});

/* Emit a JS number as a GLSL float literal. toFixed always leaves a decimal
   point, which is what keeps `1` from being parsed as an int in a float
   expression — a class of ES 3.00 compile error that is tedious to read. */
function f(x, digits = 7) {
  return Number(x).toFixed(digits);
}

const K = POST_CONSTANTS;

/* --- Pass 7a: bright pass, FINAL (RS) -> BLOOM[0].down (RS/2) ---------- */

/**
 * Quarter-area bright pass with a soft knee. The four taps are a box
 * downsample; the Karis weighting is not decoration — a single fireflying
 * texel at the shaft core would otherwise pump the whole bloom halo on and off
 * between frames, and a flicker is the one thing an ambient page cannot have.
 */
export const BRIGHT_PASS_FS = `
in  vec2 vUV;
out vec4 fragColor;

uniform sampler2D uScene;      // FINAL
uniform vec2  uHalfTexel;      // 0.5 / textureSize(uScene, 0)
uniform float uHdrDecode;      // 8.0 on the RGBA8 path, 1.0 otherwise
uniform float uHdrEncode;      // 1.0 / uHdrDecode; keeps the chain in range

#define BLOOM_THRESHOLD ${f(K.BLOOM_THRESHOLD)}
#define BLOOM_KNEE      ${f(K.BLOOM_KNEE)}

vec3 fetchScene(vec2 uv){
  return max(texture(uScene, uv).rgb, vec3(0.0)) * uHdrDecode;
}

// Karis: weight each tap by 1/(1+luma) before averaging, so one very bright
// texel cannot dominate. Applied on the DOWNSAMPLE only, which is where the
// temporal instability actually lives.
float fireflyWeight(vec3 c){
  return 1.0 / (1.0 + max(c.r, max(c.g, c.b)));
}

void main(){
  vec2 h = uHalfTexel;
  vec3 a = fetchScene(vUV + vec2(-h.x, -h.y));
  vec3 b = fetchScene(vUV + vec2( h.x, -h.y));
  vec3 c = fetchScene(vUV + vec2(-h.x,  h.y));
  vec3 d = fetchScene(vUV + vec2( h.x,  h.y));

  float wa = fireflyWeight(a);
  float wb = fireflyWeight(b);
  float wc = fireflyWeight(c);
  float wd = fireflyWeight(d);
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-5);

  // Soft knee around BLOOM_THRESHOLD, half-width BLOOM_KNEE. Below the knee the
  // contribution is exactly zero, so the bell's sheen cannot leak into the halo.
  float br   = max(col.r, max(col.g, col.b));
  float soft = clamp(br - BLOOM_THRESHOLD + BLOOM_KNEE, 0.0, 2.0 * BLOOM_KNEE);
  soft = soft * soft / (4.0 * BLOOM_KNEE + 1e-5);
  float contribution = max(soft, br - BLOOM_THRESHOLD) / max(br, 1e-5);

  fragColor = vec4(col * contribution * uHdrEncode, 1.0);
}
`;

/* --- Pass 7b: dual-filter Kawase downsample ---------------------------- */

/**
 * Bjorge's dual filter, downsample half. One centre tap at weight 4 plus four
 * diagonals at weight 1, normalised by 8 — so the filter is mean-preserving,
 * which is what lets the ladder change the level count without changing
 * brightness.
 */
export const KAWASE_DOWN_FS = `
in  vec2 vUV;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2 uHalfTexel;       // 0.5 / textureSize(uSrc, 0)

void main(){
  vec2 h = uHalfTexel;
  vec4 sum = texture(uSrc, vUV) * 4.0;
  sum += texture(uSrc, vUV + vec2(-h.x, -h.y));
  sum += texture(uSrc, vUV + vec2( h.x,  h.y));
  sum += texture(uSrc, vUV + vec2( h.x, -h.y));
  sum += texture(uSrc, vUV + vec2(-h.x,  h.y));
  fragColor = sum * 0.125;
}
`;

/* --- Pass 7c: dual-filter Kawase upsample ------------------------------ */

/**
 * The upsample half: eight taps on a rotated tent, normalised by 12, added to
 * this level's own down-chain result. Two chains exist precisely so this can be
 * a plain read-and-add rather than a blend against the destination — a blend
 * would make the pass's correctness depend on the caller remembering to set it.
 */
export const KAWASE_UP_FS = `
in  vec2 vUV;
out vec4 fragColor;

uniform sampler2D uSrc;        // the smaller level, already upsampled once
uniform sampler2D uBase;       // this level's down-chain result
uniform vec2 uHalfTexel;       // 0.5 / textureSize(uSrc, 0)

void main(){
  vec2 h = uHalfTexel;
  vec4 sum = texture(uSrc, vUV + vec2(-h.x * 2.0, 0.0));
  sum += texture(uSrc, vUV + vec2(-h.x,  h.y)) * 2.0;
  sum += texture(uSrc, vUV + vec2( 0.0,  h.y * 2.0));
  sum += texture(uSrc, vUV + vec2( h.x,  h.y)) * 2.0;
  sum += texture(uSrc, vUV + vec2( h.x * 2.0, 0.0));
  sum += texture(uSrc, vUV + vec2( h.x, -h.y)) * 2.0;
  sum += texture(uSrc, vUV + vec2( 0.0, -h.y * 2.0));
  sum += texture(uSrc, vUV + vec2(-h.x, -h.y)) * 2.0;
  fragColor = sum / 12.0 + texture(uBase, vUV);
}
`;

/* --- Pass 7d: auto-exposure, 1x1 ping-pong ----------------------------- */

/**
 * §6 step 1. An 8x8 grid of taps over the smallest bloom mip, exponentially
 * smoothed into a 1x1 target. There is no readPixels anywhere in this project;
 * one readback would stall the pipeline and cost more than the entire post
 * chain, and it would do so every frame for the rest of the session.
 *
 * The meter is a HIGHLIGHT meter by construction — it is fed by the bright
 * pass, so it measures energy above 1.15 and not scene average. That is what
 * §6 specifies, and it is workable only because the result is clamped to
 * +-0.25 EV and rate-limited to 0.08 EV/s: the worst a mis-set key can do is
 * park the exposure on a rail, which is a fixed offset and not a pump. The
 * dead zone kills the last of the micro-motion. If a soak test ever shows a
 * visible pump as a shaft crosses the frame, the correct fix is to lower
 * EXPOSURE_EV_CLAMP toward 0.10 — not to widen the meter, which would trade a
 * small pump for a large one.
 *
 * The stored value is ev * 0.5 + 0.5, so the target may be R16F or, on the
 * no-float path, RGBA8, and this shader does not need to know which.
 */
export const EXPOSURE_FS = `
in  vec2 vUV;
out vec4 fragColor;

uniform sampler2D uMeter;      // smallest allocated bloom mip (down chain)
uniform sampler2D uPrev;       // the other half of the 1x1 ping-pong
uniform float uDt;             // seconds since the previous exposure step
uniform float uExposureKey;    // reference meter level of a correct frame
uniform float uHdrDecode;

#define EV_CLAMP     ${f(K.EXPOSURE_EV_CLAMP)}
#define EV_RATE      ${f(K.EXPOSURE_EV_RATE)}
#define EV_DEADZONE  ${f(K.EXPOSURE_DEADZONE_EV)}
#define EXPO_TAU     ${f(K.EXPOSURE_TAU)}
#define EXPO_SCALE   ${f(K.EXPOSURE_ENCODE_SCALE)}
#define EXPO_BIAS    ${f(K.EXPOSURE_ENCODE_BIAS)}

void main(){
  vec3 sum = vec3(0.0);
  for (int y = 0; y < 8; y++){
    for (int x = 0; x < 8; x++){
      vec2 uv = (vec2(float(x), float(y)) + 0.5) * 0.125;
      sum += max(texture(uMeter, uv).rgb, vec3(0.0));
    }
  }
  float meter = dot(sum * (uHdrDecode / 64.0), vec3(0.2126, 0.7152, 0.0722));

  float prev  = (texelFetch(uPrev, ivec2(0), 0).r - EXPO_BIAS) / EXPO_SCALE;
  float want  = clamp(log2(uExposureKey / max(meter, 1e-5)), -EV_CLAMP, EV_CLAMP);

  // Dead zone: below this the exposure does not chase at all. Auto-exposure
  // that is always very slightly moving is worse than one that is still.
  float error = want - prev;
  float live  = step(EV_DEADZONE, abs(error));

  // dt is floored at zero before it is used as a clamp bound: a negative dt
  // would invert the rate limit's min and max, and clamp() with min > max is
  // undefined rather than merely wrong.
  float dt   = max(uDt, 0.0);
  float k    = 1.0 - exp(-dt / EXPO_TAU);
  float next = prev + error * k * live;
  next = prev + clamp(next - prev, -EV_RATE * dt, EV_RATE * dt);
  next = clamp(next, -EV_CLAMP, EV_CLAMP);

  fragColor = vec4(next * EXPO_SCALE + EXPO_BIAS, 0.0, 0.0, 1.0);
}
`;

/* --- Pass 7e: the composite -------------------------------------------- */

/**
 * §6 in order: exposure, chromatic aberration, bloom, veiling glare, sensor
 * noise, AgX, blue guard rail, vignette, FXAA, dither. Requires NOISE_GLSL in
 * `includes` for gaussIGN(); `ign()` comes from COMMON_GLSL.
 *
 * One honest deviation from the numbered order. §6 lists FXAA at step 9, after
 * the tonemap, but the composite is a single draw straight to the default
 * framebuffer, so there is no tonemapped texture to gather from. FXAA is
 * therefore evaluated on the scene tap, before the transfer curve. Everything
 * that follows it — the bloom add, the flat veil, the tonemap, the guard rail
 * and the vignette — is either spatially smooth at the scale of a one-pixel
 * edge or a per-pixel monotone function, so the resolved edge survives all of
 * them. The alternative, a second full-res pass, costs more than the entire
 * chain it would be antialiasing.
 */
export const COMPOSITE_FS = `
in  vec2 vUV;
out vec4 fragColor;

uniform sampler2D uScene;      // FINAL, HDR linear
uniform sampler2D uBloom;      // BLOOM[0] of the up chain
uniform sampler2D uVeil;       // smallest allocated mip of the down chain
uniform sampler2D uExposure;   // 1x1, encoded EV
uniform vec2  uSceneTexel;     // 1.0 / textureSize(uScene, 0)
uniform float uAspect;         // output width / height
uniform float uTanHalfFov;     // tan(0.5 * vertical FOV) -- the real lens, §4.5
uniform float uFrame;
uniform float uHdrDecode;
uniform float uBloomLevels;    // live level count; the ladder moves this

#define BLOOM_WEIGHT   ${f(K.BLOOM_WEIGHT)}
#define VEIL_WEIGHT    ${f(K.VEIL_WEIGHT)}
#define CA_K_R         ${f(K.CA_K_R)}
#define CA_K_B         ${f(K.CA_K_B)}
#define NOISE_SHOT     ${f(K.NOISE_SHOT)}
#define NOISE_READ     ${f(K.NOISE_READ)}
#define NOISE_CHROMA   ${f(K.NOISE_CHROMA)}
#define VIGNETTE_MECH  ${f(K.VIGNETTE_MECHANICAL)}
#define VIGNETTE_A     ${f(K.VIGNETTE_MECH_START)}
#define VIGNETTE_B     ${f(K.VIGNETTE_MECH_END)}
#define DITHER_LSB     ${f(K.DITHER_LSB, 9)}
#define EXPO_SCALE     ${f(K.EXPOSURE_ENCODE_SCALE)}
#define EXPO_BIAS      ${f(K.EXPOSURE_ENCODE_BIAS)}
#define FXAA_EDGE      ${f(K.FXAA_EDGE_THRESHOLD)}
#define FXAA_EDGE_MIN  ${f(K.FXAA_EDGE_THRESHOLD_MIN)}
#define FXAA_SPAN_MAX  ${f(K.FXAA_SPAN_MAX)}
#define FXAA_REDUCE_MUL ${f(K.FXAA_REDUCE_MUL)}
#define FXAA_REDUCE_MIN ${f(K.FXAA_REDUCE_MIN)}

// #04070E. The far-field veil the vignette falls to. There is no black
// underwater; inscatter() puts a floor under every pixel of the scene and this
// keeps the vignette from undoing it in the corners.
const vec3 VEIL_COLOR = vec3(${f(K.VIGNETTE_VEIL[0])}, ${f(K.VIGNETTE_VEIL[1])}, ${f(K.VIGNETTE_VEIL[2])});

// §6 step 2. Lateral chromatic aberration as the composite's three-tap read of
// FINAL. The radius is aspect-corrected because lateral CA is a function of
// field angle: without it an ultrawide window would get the same corner fringe
// as a square one. Green is undisplaced, which matters below.
vec3 sceneAt(vec2 uv){
  vec2 d  = uv - 0.5;
  vec2 da = d * vec2(uAspect, 1.0);
  float r2 = dot(da, da);
  vec2 uvR = 0.5 + d * (1.0 + CA_K_R * r2);
  vec2 uvB = 0.5 + d * (1.0 + CA_K_B * r2);
  vec3 c;
  c.r = texture(uScene, uvR).r;
  c.g = texture(uScene, uv ).g;
  c.b = texture(uScene, uvB).b;
  return max(c, vec3(0.0)) * uHdrDecode;
}

#ifdef POST_FXAA
// Green is 72 % of luminance and is the one channel the CA read leaves in
// place, so it is both the cheapest and the most honest edge signal available
// here. The sqrt stands in for the display transfer curve: FXAA's thresholds
// are calibrated in perceptual space, and running them on raw linear HDR would
// miss every edge in the shadows, which in this frame is most of them.
float lumaProxy(vec2 uv){
  return sqrt(max(texture(uScene, uv).g, 0.0) * uHdrDecode);
}
#endif

vec3 resolveScene(vec2 uv){
#ifdef POST_FXAA
  vec2 t = uSceneTexel;
  float lNW = lumaProxy(uv + vec2(-t.x, -t.y));
  float lNE = lumaProxy(uv + vec2( t.x, -t.y));
  float lSW = lumaProxy(uv + vec2(-t.x,  t.y));
  float lSE = lumaProxy(uv + vec2( t.x,  t.y));
  float lM  = lumaProxy(uv);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec3 centre = sceneAt(uv);
  if (lMax - lMin < max(FXAA_EDGE_MIN, lMax * FXAA_EDGE)) return centre;

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * FXAA_REDUCE_MUL, FXAA_REDUCE_MIN);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-FXAA_SPAN_MAX), vec2(FXAA_SPAN_MAX)) * t;

  vec3 inner = 0.5 * (sceneAt(uv + dir * (1.0 / 3.0 - 0.5)) +
                      sceneAt(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 outer = inner * 0.5 + 0.25 * (sceneAt(uv - dir * 0.5) + sceneAt(uv + dir * 0.5));
  float lOuter = sqrt(max(outer.g, 0.0));
  return (lOuter < lMin || lOuter > lMax) ? inner : outer;
#else
  return sceneAt(uv);
#endif
}

// §6 step 6. AgX, verbatim from the spec. The output is already
// display-encoded, so nothing after this applies a further transfer curve.
const mat3 AGX_IN = mat3(0.842479, 0.0784336, 0.0792237,
                         0.0423282, 0.878468,  0.0791661,
                         0.0423756, 0.0784336, 0.879142);
vec3 agx(vec3 c){
  c = AGX_IN * c;
  c = clamp((log2(c + 1e-10) + 12.47393) / 16.5, 0.0, 1.0);
  vec3 x = c, x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
       - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// §6 step 7. A guard rail, not a grade: blue must lead green must lead red in
// chroma, and the clamp only ever pushes a channel DOWN to satisfy that. On a
// correct frame nothing is clamped and this function returns its argument. It
// preserves the hue drift with distance -- cyan-leaning near field, deeper blue
// far field -- that a percentage grade would flatten into one blue.
vec3 blueGuard(vec3 c){
  float y   = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3  chr = c - y;
  chr.r = min(chr.r, chr.g - 0.004);
  chr.g = min(chr.g, chr.b - 0.002);
  return max(y + chr, vec3(0.0));
}

void main(){
  float ev       = (texelFetch(uExposure, ivec2(0), 0).r - EXPO_BIAS) / EXPO_SCALE;
  float exposure = exp2(ev);

  vec3 c = resolveScene(vUV);

  // §6 steps 3 and 4. The bloom weight is divided by the live level count so a
  // ladder move from five levels to two changes the width of the halo and not
  // its energy; the veil is a mean-preserving mip, so it needs no such term.
  vec3 bloom = max(texture(uBloom, vUV).rgb, vec3(0.0)) * uHdrDecode;
  vec3 veil  = max(texture(uVeil,  vUV).rgb, vec3(0.0)) * uHdrDecode;
  c += bloom * (BLOOM_WEIGHT / max(uBloomLevels, 1.0));
  c += veil  * VEIL_WEIGHT;

  c *= exposure;

  // §6 step 5. Shot noise scales with sqrt(signal) and read noise is a floor,
  // so the grain is loudest in the shadows -- which is where a real high-ISO
  // underwater frame keeps it. gaussIGN wants PIXEL coordinates, not UVs.
  float n1 = gaussIGN(gl_FragCoord.xy, uFrame);
  c += n1 * (sqrt(max(c.g, 0.0)) * NOISE_SHOT + NOISE_READ);
  c.rb += gaussIGN(gl_FragCoord.xy * 0.25, uFrame + 7.0) * NOISE_CHROMA;

  c = agx(max(c, vec3(0.0)));
  c = blueGuard(c);

  // §6 step 8. cos^4 of the true field angle, plus a mechanical term, falling
  // to the veil colour rather than to black.
  vec2 ndc   = vUV * 2.0 - 1.0;
  vec2 tanXY = vec2(ndc.x * uAspect, ndc.y) * uTanHalfFov;
  float cosT = inversesqrt(1.0 + dot(tanXY, tanXY));
  float natural = cosT * cosT * cosT * cosT;
  float rNorm = length(ndc * vec2(uAspect, 1.0)) / sqrt(uAspect * uAspect + 1.0);
  float vig = natural * (1.0 - VIGNETTE_MECH * smoothstep(VIGNETTE_A, VIGNETTE_B, rNorm));
  c = mix(VEIL_COLOR, c, clamp(vig, 0.0, 1.0));

  // §6 step 10. Triangular-PDF dither, the last thing before quantisation.
  // (noise.js measured the two IGN taps as mildly anti-correlated, r = -0.19,
  // which narrows the PDF a little without breaking it. If a 4K screenshot ever
  // shows residual banding, swapping the lanes on the second tap the way
  // gaussIGN does is the whole fix.)
  c += (ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + 17.0) - 1.0) * DITHER_LSB;

  fragColor = vec4(max(c, vec3(0.0)), 1.0);
}
`;
