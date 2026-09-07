/* ============================================================
   render/frame.js — the eight-pass graph, spec §1.
   ------------------------------------------------------------
   Everything that touches a framebuffer in this project happens
   here, in the order below and with the state below. main.js
   owns the clock, the lifecycle and the simulation; this file
   owns the GPU.

   THE PASS TABLE, §1, verbatim.

   | # | Pass                                     | Target    | Res  | Depth        | Cull  | Blend            |
   |---|------------------------------------------|-----------|------|--------------|-------|------------------|
   | 0 | cookie — 3-layer ridged noise gobo        | COOKIE    | 256² | off          | –     | off              |
   | 1 | shafts — 16-step march + 4-frame history  | RAYS_A↔B  | RS/2 | off          | –     | off              |
   | 2 | sea — column + shafts + far/mid snow      | SEA       | RS   | write on for | –     | premultiplied    |
   |   |       + behind strands                   |           |      | snow/strands |       | ONE, 1-SRC_ALPHA |
   | 3 | bellfront — bell front faces, view-Z out  | ZFRONT    | RS/2 | test+write   | BACK  | off              |
   | 4 | thickness — all jelly, signed additive    | THICK     | RS/2 | off          | none  | ONE, ONE         |
   | 5 | interior — subumbrella + gonads +         | SEA       | RS   | test on,     | FRONT | SRC_ALPHA,       |
   |   |       manubrium + oral arms              |           |      | write off    | /BACK | 1-SRC_ALPHA      |
   | 6 | main — SEA→FINAL draw, exumbrella,        | FINAL     | RS   | off          | BACK  | premultiplied    |
   |   |       front strands, near snow           |           |      |              |       |                  |
   | 7 | post — bright, bloom, composite           | default   | nat. | –            | –     | off              |

   TWO THINGS §1 AND §2.6 CALL OUT EXPLICITLY, AND THIS FILE
   OBEYS BOTH.

   First: SEA -> FINAL IS A FULLSCREEN-TRIANGLE DRAW, NOT A BLIT.
   `blitFramebuffer` into a multisampled draw framebuffer is
   INVALID_OPERATION, and FINAL may be multisampled. It is also
   the wrong operation regardless: SEA is rendered through the
   guard-banded frustum and is a different size to FINAL, so the
   copy is a resample, and the shader that does it is one texture
   fetch. The ONLY blit in this project is the MS -> single-sample
   resolve at the end of pass 6, which is the legal direction.

   Second: MSAA IS A PROBE-GATED BONUS AND NEVER LOAD-BEARING.
   Everything soft in the frame — the strands, the snow, the
   shafts — is analytically antialiased and does not depend on it.
   When `caps.maxSamplesRGBA16F` is under 4 the multisampled
   FINAL is simply never allocated and the composite's 9-tap FXAA
   runs instead. Nothing else in the graph changes.

   WHY NOTHING DEPTH-TESTS AGAINST THE BELL. The exumbrella is
   drawn last and composites everything behind it THROUGH itself:
   its shader emits `emitted + Tr * refract(SEA)`. The
   subumbrella, the gonads and the far tentacles are therefore not
   merely occluded by the bell, they are tinted, dimmed and
   optically distorted by it — strictly more correct than depth
   sorting and cheaper than an eight-pass depth peel. Depth exists
   in this graph for exactly two purposes: so a mote of marine
   snow that has drifted in front of the animal occludes the
   interior organs in pass 5, and so pass 3 keeps the NEAREST bell
   front face rather than the last one rasterised.

   WHERE THE FRUSTUMS ARE. SEA carries §2.5's 8 % guard band, so
   that the exumbrella's refraction taps still find data near the
   frame edge. Everything that SEA's compositing shader has to
   line up against is therefore rendered through the SAME
   overscanned projection: RAYS, ZFRONT and THICK. FINAL is the
   framing frustum. Pass 6 converts between them with one divide,
   because widening the vertical FOV by (1 + overscan) in tan
   scales NDC by exactly that factor and nothing else. At tier 3
   and below the overscan is zero and every one of those divides
   is the identity.

   PROGRAM COUNT AND WHY THEY ARE ALL BUILT AT BOOT. The §7
   ladder moves `SHAFT_STEPS`, which is a compile-time define, so
   a tier change would otherwise mean a link — tens of
   milliseconds of hitch at exactly the moment the machine is
   already struggling, which is how a quality ladder becomes
   visible. All three shaft variants are built during the 1.2 s
   boot fade instead, behind KHR_parallel_shader_compile where it
   exists.

   THE PROGRAM TABLE IS DATA, AND THAT IS DELIBERATE.
   `describePrograms()` returns every program this file builds,
   with its exact sources, defines, includes, attribute bindings
   and the list of uniforms the passes below set on it.
   `tests/check.mjs` imports that table rather than restating it,
   so a program added here is checked here, and a uniform renamed
   in a shader fails a static check instead of silently becoming a
   no-op in a browser three days later.
   ============================================================ */

import {
  createProgram,
  createBuffer,
  createVertexArray,
  createTexture2D,
  createFullscreenTriangle,
  createStateCache,
  resolveMultisample,
  FULLSCREEN_TRIANGLE_VS,
  GLObjectRegistry
} from '../gl.js';
import { assembleProgramSources, downwelling } from '../shaders/common.js';
import { NOISE_GLSL } from '../noise.js';
import { createTargets, TARGET_CONSTANTS } from './targets.js';

import { COOKIE_FS, COOKIE_WORLD_SCALE, cookieDrift } from '../shaders/cookie.js';
import { SHAFTS_FS, SHAFTS_INCLUDES, shaftHistoryWeight } from '../shaders/shafts.js';
import { SEA_FS, SEA_INCLUDES, SEA_INLINE_INCLUDES } from '../shaders/sea.js';
import { THICKNESS_VS, THICKNESS_FS, ZFRONT_FS } from '../shaders/thickness.js';
import { BELL_VS, BELL_FS, JELLY_GLSL_INCLUDES } from '../shaders/bell.js';
import {
  STRAND_VS,
  STRAND_FS,
  STRAND_GLSL_INCLUDES,
  STRAND_ATTRIBUTE_LOCATIONS
} from '../shaders/strands.js';
import {
  SNOW_VS,
  SNOW_FS,
  SNOW_INCLUDES,
  SNOW_ATTRIBUTE_LOCATIONS,
  SNOW_QUAD_CORNERS,
  SNOW_SPRITE,
  SNOW_SPRITE_SIZE,
  SNOW_FOCAL_LENGTH,
  SNOW_APERTURE,
  SNOW_FOCUS_DISTANCE,
  SNOW_SENSOR_WIDTH,
  SNOW_MIN_PIXELS,
  SNOW_ALBEDO
} from '../shaders/snow.js';
import {
  BRIGHT_PASS_FS,
  KAWASE_DOWN_FS,
  KAWASE_UP_FS,
  EXPOSURE_FS,
  COMPOSITE_FS,
  POST_CONSTANTS
} from '../shaders/post.js';

import { BELL_ATTRIBUTE_LOCATIONS } from '../geometry/bell.js';
import { SNOW_STRIDE } from '../sim/snow.js';
import { mat4, mat3, Vec3 } from '../math.js';

/** The shaft-step variants the ladder can select. All three link at boot. */
export const SHAFT_STEP_VARIANTS = Object.freeze([16, 12, 8]);

/**
 * How far a sun-space orthographic box has to reach to hold the whole animal:
 * a 26 cm bell with half-metre tentacles streaming off it, plus slack for the
 * contraction stroke. It is deliberately generous — the map is 256², so a
 * slightly loose fit costs sharpness in a term that is already a five-tap blur.
 */
const SHADOW_HALF_EXTENT = 0.95;
const SHADOW_DISTANCE = 2.2;

/** 1 / the shadow map's side. targets.js allocates it at TARGET_CONSTANTS.SHADOW_SIZE. */
const SHADOW_TEXEL = 1 / TARGET_CONSTANTS.SHADOW_SIZE;

/**
 * The SEA -> FINAL base layer, and the reason this file contains one inline
 * shader. It is a draw rather than a blit for the reasons in the header, and a
 * separate tiny program rather than a branch inside the bell shader, because
 * the bell covers a few per cent of the frame and the base layer covers all of
 * it.
 */
const SEA_COPY_FS = `
in  vec2 vUV;
out vec4 fragColor;

uniform sampler2D uSea;
uniform float uSeaOverscan;   // 1 + guard band; 1.0 when the band is off

void main(){
  // FINAL's frustum is narrower than SEA's by exactly the guard band, and the
  // overscan is a uniform scale of NDC, so recovering SEA's uv is one divide.
  vec2 uv = ((vUV * 2.0 - 1.0) / uSeaOverscan) * 0.5 + 0.5;
  fragColor = vec4(texture(uSea, uv).rgb, 1.0);
}
`;

const FULLSCREEN_ATTRIBUTES = Object.freeze({ aPos: 0 });

/*
 * The subset of the bell vertex format the measuring passes actually read. It
 * is the SAME VertexArray the shading passes bind — the locations are taken
 * from geometry/bell.js so they cannot drift — but THICKNESS_VS has no use for
 * the two parameter-space neighbour offsets, because it needs a position and
 * not a normal. Binding a name the vertex source never declares would be legal
 * and would also be a lie about the format, which is the kind of lie that ends
 * up drawing the whole animal at the origin.
 */
const THICKNESS_ATTRIBUTES = Object.freeze({
  aRest: BELL_ATTRIBUTE_LOCATIONS.aRest,
  aUV: BELL_ATTRIBUTE_LOCATIONS.aUV,
  aParam2: BELL_ATTRIBUTE_LOCATIONS.aParam2
});

/**
 * The five caustic uniforms cookie.js declares, and the two of them that a
 * shader which only needs the medium (the strands: they are lit by the sun and
 * the veil, never by the gobo) still has to be given. Split so that a program
 * is never handed a texture it does not sample.
 */
const MEDIUM_UNIFORMS = ['uSunDir', 'uWorldOrigin'];
const CAUSTIC_UNIFORMS = ['uCookie', 'uCookieScale', 'uCookieDrift', ...MEDIUM_UNIFORMS];
const LIGHTING_UNIFORMS = [
  'uSunCol', 'uShadowTau', 'uLightViewProj', 'uShadowTexel', 'uShadowStrength'
];
const DEFORM_UNIFORMS = ['uPhase', 'uAmp', 'uTwistTime', 'uBellRadius'];

/**
 * Every program the renderer builds, as data: the exact arguments
 * `assembleProgramSources` is given, the attribute bindings `createProgram` is
 * given, and the uniform names the passes below set on it.
 *
 * `config` is the capability branch, not the quality tier — the tier moves
 * uniforms and draw ranges, never a program:
 *   floatPath       EXT_color_buffer_float (or half_float) is present
 *   manualBilinear  OES_texture_float_linear is absent, so THICK is filtered
 *                   by hand rather than sampled unfiltered
 *   msaaSamples     a multisampled FINAL was allocated, so FXAA is compiled out
 */
export function describePrograms(config = {}) {
  const {
    floatPath = true,
    manualBilinear = false,
    msaaSamples = 0
  } = config;

  /*
   * The RGBA8 fallback writes every scene target pre-exposed by 1/8 and post.js
   * undoes it on read, because a UNORM target otherwise clips at 1.0 and the
   * shaft cores and the bell rim are the two things in the frame that live
   * above it. On the float path both gains are exactly 1 and the defines are
   * absent entirely, so the shipped shader is byte-identical to the one that
   * was reasoned about.
   */
  const preExposure = floatPath ? 1 : TARGET_CONSTANTS.RGBA8_PRE_EXPOSURE;
  const hdrDecode = 1 / preExposure;
  const gainDefines = floatPath
    ? {}
    : { OUT_GAIN: preExposure.toFixed(6), SEA_GAIN: hdrDecode.toFixed(1) };

  const jelly = JELLY_GLSL_INCLUDES;

  /* The thickness tap only exists in the variant that samples THICK. */
  const thickUniforms = ['uThick', 'uThickSize'];

  const analyticDefines = Object.assign({
    ANALYTIC_THICKNESS: true,
    THICK_MANUAL_BILINEAR: false
  }, gainDefines);

  const samplingDefines = Object.assign({
    ANALYTIC_THICKNESS: false,
    THICK_MANUAL_BILINEAR: manualBilinear
  }, gainDefines);

  const entries = [];
  const add = (name, spec, uniforms) => {
    entries.push({ name, spec, uniforms: Object.freeze(uniforms.slice()) });
  };

  add('cookie', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: COOKIE_FS,
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, ['uCookieTime']);

  /* One per shaft-step count, so a tier change is a pointer swap. */
  for (const steps of SHAFT_STEP_VARIANTS) {
    add(`shafts.${steps}`, {
      vertex: FULLSCREEN_TRIANGLE_VS,
      fragment: SHAFTS_FS,
      defines: { SHAFT_STEPS: steps },
      includes: SHAFTS_INCLUDES,
      attributeLocations: FULLSCREEN_ATTRIBUTES
    }, [...CAUSTIC_UNIFORMS, 'uHistory', 'uInvViewProj', 'uCamPos', 'uHistoryWeight', 'uFrame']);
  }

  add('sea', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: SEA_FS,
    defines: gainDefines,
    includes: SEA_INCLUDES,
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, ['uInvViewProj', 'uCamPos', 'uCamY', 'uShafts', 'uShaftRes']);

  /* Tier 4 and the RGBA8 path: RAYS is never allocated and the march is
     inlined at eight steps. Energy-conserving integration means that is a
     change in sharpness, not brightness, so the transition stays invisible. */
  add('sea.inline', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: SEA_FS,
    defines: Object.assign({ SEA_INLINE_SHAFTS: true, SHAFT_STEPS: 8 }, gainDefines),
    includes: SEA_INLINE_INCLUDES,
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, [...CAUSTIC_UNIFORMS, 'uInvViewProj', 'uCamPos', 'uCamY', 'uFrame']);

  add('sea.copy', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: SEA_COPY_FS,
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, ['uSea', 'uSeaOverscan']);

  /*
   * Passes 3, 4 and the sun-side shadow render share one vertex stage and one
   * VAO with both shading programs, which is the precondition for §2.4's
   * front-depth subtraction being valid: the surface measured has to be the
   * surface shaded, to the float.
   */
  if (floatPath) {
    add('zfront', {
      vertex: THICKNESS_VS,
      fragment: ZFRONT_FS,
      includes: jelly,
      attributeLocations: THICKNESS_ATTRIBUTES
    }, [...DEFORM_UNIFORMS, 'uViewProj', 'uModel', 'uCameraPos']);

    add('thick', {
      vertex: THICKNESS_VS,
      fragment: THICKNESS_FS,
      includes: jelly,
      attributeLocations: THICKNESS_ATTRIBUTES
    }, [...DEFORM_UNIFORMS, 'uViewProj', 'uModel', 'uCameraPos', 'uZFront', 'uInvRes']);

    add('shadow', {
      vertex: THICKNESS_VS,
      fragment: THICKNESS_FS,
      defines: { SHADOW_PASS: true },
      includes: jelly,
      attributeLocations: THICKNESS_ATTRIBUTES
    }, [...DEFORM_UNIFORMS, 'uViewProj', 'uModel', 'uCameraPos', 'uRefZ']);
  }

  const bellBase = [
    ...CAUSTIC_UNIFORMS, ...LIGHTING_UNIFORMS, ...DEFORM_UNIFORMS,
    'uWall', 'uViewProj', 'uModel', 'uNormalMatrix', 'uCameraPos', 'uInvRes',
    'uSeaOverscan'
  ];

  const addBellPair = (suffix, defines, uniforms) => {
    add(`bell.exumbrella${suffix}`, {
      vertex: BELL_VS,
      fragment: BELL_FS,
      defines,
      includes: jelly,
      attributeLocations: BELL_ATTRIBUTE_LOCATIONS
    }, [...uniforms, 'uSea']);

    add(`bell.subumbrella${suffix}`, {
      vertex: BELL_VS,
      fragment: BELL_FS,
      defines: Object.assign({ SUBUMBRELLA: true }, defines),
      includes: jelly,
      attributeLocations: BELL_ATTRIBUTE_LOCATIONS
    }, uniforms);
  };

  /*
   * §2.5's analytic slab is the variant every path can always reach, so it is
   * linked unconditionally. The capability decides whether THICK *can* exist;
   * the tier decides whether it does, and those are not the same question. Tier
   * 4 runs `thickDivisor: 0` on a float-capable GPU, so passes 3-4 are skipped
   * and `uThick` is never bound — while a shader compiled to sample it would
   * still read whatever unit setCaustic last touched and take the caustic gobo
   * for the animal's optical depth. So render() picks the variant matching the
   * pass it actually ran, and linking both here keeps this file's rule that a
   * tier change is a pointer swap and never a compile.
   */
  addBellPair('.analytic', analyticDefines, bellBase);

  if (floatPath) {
    addBellPair('', samplingDefines, [...bellBase, ...thickUniforms]);
  }

  add('strand', {
    vertex: STRAND_VS,
    fragment: STRAND_FS,
    defines: gainDefines,
    includes: STRAND_GLSL_INCLUDES,
    attributeLocations: STRAND_ATTRIBUTE_LOCATIONS
  }, [...MEDIUM_UNIFORMS, ...LIGHTING_UNIFORMS, 'uViewProj', 'uCameraPos', 'uPixelScale']);

  add('snow', {
    vertex: SNOW_VS,
    fragment: SNOW_FS,
    defines: gainDefines,
    includes: SNOW_INCLUDES,
    attributeLocations: SNOW_ATTRIBUTE_LOCATIONS
  }, [...CAUSTIC_UNIFORMS, 'uViewProj', 'uCamPos', 'uInvRes', 'uPixelScale',
    'uCocScale', 'uF', 'uN', 'uFocus', 'uSnowMinPx', 'uSnowAlbedo', 'uSnowSprite']);

  add('post.bright', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: BRIGHT_PASS_FS,
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, ['uScene', 'uHalfTexel', 'uHdrDecode', 'uHdrEncode']);

  add('post.down', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: KAWASE_DOWN_FS,
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, ['uSrc', 'uHalfTexel']);

  add('post.up', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: KAWASE_UP_FS,
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, ['uSrc', 'uBase', 'uHalfTexel']);

  add('post.exposure', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: EXPOSURE_FS,
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, ['uMeter', 'uPrev', 'uDt', 'uExposureKey', 'uHdrDecode']);

  /* FXAA is compiled in unless FINAL is multisampled; see the header. */
  const compositeUniforms = [
    'uScene', 'uBloom', 'uVeil', 'uExposure', 'uAspect', 'uTanHalfFov',
    'uFrame', 'uHdrDecode', 'uBloomLevels'
  ];
  if (msaaSamples < 4) compositeUniforms.push('uSceneTexel');
  add('post.composite', {
    vertex: FULLSCREEN_TRIANGLE_VS,
    fragment: COMPOSITE_FS,
    defines: { POST_FXAA: msaaSamples < 4 },
    fragmentIncludes: [NOISE_GLSL],
    attributeLocations: FULLSCREEN_ATTRIBUTES
  }, compositeUniforms);

  return entries;
}

/** Scratch, so the frame loop allocates nothing. */
const _lightView = mat4.create();
const _lightProj = mat4.create();
const _lightViewProj = mat4.create();
const _normalMatrix = mat3.create();
const _sunCol = [0, 0, 0];
const _sunDir = [0, 0, 0];
const _drift = [0, 0];
const _lightEye = new Vec3();
const _bodyCentre = new Vec3();
const _camPos = [0, 0, 0];
const _worldOrigin = [0, 0, 0];
const _lightEyeArray = [0, 0, 0];
const _invThick = [0, 0];
const _invSea = [0, 0];
const _invFinal = [0, 0];
const _shaftRes = [0, 0];
const _shadowTexel = [SHADOW_TEXEL, SHADOW_TEXEL];
const _halfTexel = [0, 0];
const _texel = [0, 0];

/**
 * Builds every GL resource the renderer needs and returns the frame graph.
 *
 * `gl` must be live; on a context loss the whole object is disposed and a new
 * one is built, which is why nothing outside this file holds a WebGL handle.
 */
export function createFrameGraph(gl, options = {}) {
  const { caps = null, msaaSamples = 0, asyncCompile = true } = options;

  const registry = new GLObjectRegistry('frame');
  const state = createStateCache(gl);
  const targets = createTargets(gl, { caps, state });
  const fullscreen = registry.add(createFullscreenTriangle(gl));

  const floatPath = targets.floatPath;
  const hdrDecode = targets.hdrDecode;

  /*
   * §7 step 4: without OES_texture_float_linear a 32F texture cannot be
   * filtered, so the thickness read falls back to a hand-written bilinear.
   * 16F is filterable in core ES 3.0, so on the float path this never fires —
   * it is here for the driver that reports the extension missing anyway.
   */
  const manualBilinear = !!(caps && caps.floatLinear === false && caps.halfFloatLinear === false);

  /*
   * MSAA has to be decided ONCE, here, because two things depend on it and they
   * must not disagree: targets.js allocates the multisampled FINAL, and the
   * composite compiles FXAA in or out. A configuration where the composite
   * believes MSAA is resolving the edges and targets.js never allocated the
   * multisampled surface has no antialiasing at all — which is precisely what
   * happens if one of them consults `caps` and the other does not. The
   * condition below is the same one targets.js applies, and `graph.msaaSamples`
   * is what the caller must hand back to `configure()`.
   */
  const effectiveMsaa =
    (floatPath && msaaSamples >= 4 && caps && (caps.maxSamplesRGBA16F | 0) >= 4)
      ? msaaSamples
      : 0;

  const config = { floatPath, manualBilinear, msaaSamples: effectiveMsaa };

  /* --- Programs --------------------------------------------------------- */

  /*
   * Every linkProgram call is issued before ANY link status is queried, which
   * is the whole of KHR_parallel_shader_compile: asking a program whether it
   * linked synchronises with the compiler and serialises the rest. So the loop
   * below issues nineteen links and collects the handles, and `pollPrograms()`
   * resolves them as the driver finishes. main.js polls behind the 1.2 s fade
   * from #050505 — which reads as descending into water rather than as loading,
   * and is why there is no spinner anywhere on this page.
   *
   * Without the extension `createProgram` resolves synchronously and the
   * pending list is empty on the first poll, so the two paths differ only in
   * how long the first frame takes to arrive.
   */
  const programs = {};
  const pending = [];

  for (const entry of describePrograms(config)) {
    const src = assembleProgramSources(entry.spec);
    const built = createProgram(gl, {
      name: entry.name,
      vertex: src.vertex,
      fragment: src.fragment,
      attributeLocations: entry.spec.attributeLocations || null,
      caps,
      async: asyncCompile
    });
    if (built.pending) pending.push({ name: entry.name, handle: built });
    else programs[entry.name] = registry.add(built);
  }

  /* The ladder selects one of these by step count; all three link at boot. */
  let shaftPrograms = [];

  /**
   * Resolves whatever the driver has finished. Returns true once every program
   * is linked and `render()` may be called. A program that failed to link
   * throws here, with gl.js's annotated source dump as the message.
   */
  function pollPrograms() {
    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i];
      if (!item.handle.ready()) continue;
      programs[item.name] = registry.add(item.handle.resolve());
      pending.splice(i, 1);
    }
    if (pending.length === 0 && shaftPrograms.length === 0) {
      shaftPrograms = SHAFT_STEP_VARIANTS.map((n) => programs[`shafts.${n}`]);
    }
    return pending.length === 0;
  }

  pollPrograms();

  function shaftProgramFor(steps) {
    const i = SHAFT_STEP_VARIANTS.indexOf(steps);
    return shaftPrograms[i < 0 ? 0 : i];
  }

  /* --- The bokeh sprite -------------------------------------------------- */

  /*
   * §5.4: this texture IS the depth of field. Nothing gathers and nothing
   * blurs; an 88 px circle of confusion that would be ruinous to convolve is
   * one textured quad. NEAREST would show the disc's own texel grid at that
   * size, so it is LINEAR and clamped.
   */
  const snowSprite = registry.add(createTexture2D(gl, {
    name: 'snow.bokeh',
    width: SNOW_SPRITE_SIZE,
    height: SNOW_SPRITE_SIZE,
    format: 'R8',
    min: 'linear',
    mag: 'linear',
    wrapS: 'clamp',
    wrapT: 'clamp',
    data: SNOW_SPRITE,
    caps
  }));

  /* --- Snow instancing --------------------------------------------------- */

  /*
   * One static corner buffer shared by all three strata, plus one streaming
   * instance buffer each. `stratum.data` is uploaded verbatim: its 8-float
   * stride happens to place (radius, brightness, fade) contiguously at offset
   * 12, which is exactly the (radius, albedoScale, fade) the vertex stage wants,
   * so there is no repack anywhere in the per-frame path.
   */
  const cornerBuffer = registry.add(createBuffer(gl, {
    name: 'snow.corners', target: 'array', data: SNOW_QUAD_CORNERS, usage: 'static'
  }));

  const snowBatches = new Map();

  function snowBatchFor(stratum) {
    let batch = snowBatches.get(stratum);
    if (batch) return batch;
    const buffer = registry.add(createBuffer(gl, {
      name: `snow.${stratum.name}`,
      target: 'array',
      data: stratum.data,
      usage: 'stream'
    }));
    const stride = SNOW_STRIDE * 4;
    const vertexArray = registry.add(createVertexArray(gl, {
      name: `snow.${stratum.name}`,
      attributes: [
        { buffer: cornerBuffer, location: SNOW_ATTRIBUTE_LOCATIONS.aCorner, size: 2 },
        { buffer, location: SNOW_ATTRIBUTE_LOCATIONS.aSnowPos, size: 3, stride, offset: 0, divisor: 1 },
        { buffer, location: SNOW_ATTRIBUTE_LOCATIONS.aSnowParam, size: 3, stride, offset: 12, divisor: 1 }
      ]
    }));
    batch = { buffer, vertexArray };
    snowBatches.set(stratum, batch);
    return batch;
  }

  function drawSnow(stratum) {
    const count = Math.min(stratum.activeCount, stratum.count);
    if (count <= 0) return;
    const batch = snowBatchFor(stratum);
    batch.buffer.update(stratum.data);
    batch.vertexArray.drawInstanced('triangle-strip', 4, count);
  }

  /* --- Per-frame shared uniform blocks ----------------------------------- */

  /*
   * The medium's two uniforms: which way the sunlight travels, and where the
   * render origin actually is in the world. §4.3's floating origin keeps the
   * animal near p = 0 and scrolls the sea past it, so a shader's own y is NOT
   * the depth the medium has to be asked about, and every shader that calls
   * downwelling(), inscatter() or waterApply() needs both of these.
   */
  function setMedium(program, view) {
    program.set('uSunDir', view.sunDir);
    program.set('uWorldOrigin', view.worldOrigin);
    return program;
  }

  /*
   * The gobo on top. This is the whole of §5.3: the shafts in open water, the
   * ripple crawling over the bell and the twinkle on a snow mote are the SAME
   * texture fetch and cannot disagree. Only the programs that actually call
   * causticAt() are given it, so the auto texture-unit counter is never spent
   * on a sampler nobody reads.
   */
  function setCaustic(program, view) {
    program.texture('uCookie', targets.cookie);
    program.set('uCookieScale', COOKIE_WORLD_SCALE);
    program.set('uCookieDrift', view.cookieDrift);
    return setMedium(program, view);
  }

  /* Mesoglea lighting: the sun already carried down to the animal's depth, and
     the light-space optical-depth map. */
  function setJellyLighting(program, view) {
    program.set('uSunCol', view.sunCol);
    program.texture('uShadowTau', targets.shadow);
    program.set('uLightViewProj', view.lightViewProj);
    program.set('uShadowTexel', _shadowTexel);
    program.set('uShadowStrength', view.shadowStrength);
    return program;
  }

  /* The deformation state, identical for every program that moves the bell. */
  function setDeform(program, view) {
    program.set('uPhase', view.phase);
    program.set('uAmp', view.amplitude);
    program.set('uTwistTime', view.twistTime);
    program.set('uBellRadius', view.bellRadius);
    return program;
  }

  /** Every piece of jelly geometry, in the order pass 4 wants it. */
  function drawJelly(bell, lod) {
    lod.draw('all');
    bell.interior.draw('all');
  }

  function setSnowUniforms(program, viewProj, widthPx, heightPx, tanHalf, overscanFactor) {
    program.set('uViewProj', viewProj);
    program.set('uCamPos', _camPos);
    _texel[0] = 1 / widthPx;
    _texel[1] = 1 / heightPx;
    program.set('uInvRes', _texel);
    // Pixels per (metre per metre of view distance): the projection's own scale.
    program.set('uPixelScale', 0.5 * heightPx / tanHalf);
    // Sensor metres to pixels. Divided by the overscan because a guard-banded
    // pass spans `widthPx` pixels across a WIDER equivalent sensor than 36 mm,
    // and without this the mid snow — which §7 forbids the ladder from touching
    // — would change disc size and, through `cover`, brightness across the
    // tier 2/3 boundary where the guard band appears.
    program.set('uCocScale', widthPx / (SNOW_SENSOR_WIDTH * overscanFactor));
    program.set('uF', SNOW_FOCAL_LENGTH);
    program.set('uN', SNOW_APERTURE);
    program.set('uFocus', SNOW_FOCUS_DISTANCE);
    program.set('uSnowMinPx', SNOW_MIN_PIXELS);
    program.set('uSnowAlbedo', SNOW_ALBEDO);
    program.texture('uSnowSprite', snowSprite);
    return program;
  }

  /* --- The frame --------------------------------------------------------- */

  let historyValid = false;
  const lastCameraPosition = new Vec3();
  let cookieAge = 1e9;

  const frameView = {
    sunDir: _sunDir,
    sunCol: _sunCol,
    worldOrigin: _worldOrigin,
    cookieDrift: _drift,
    lightViewProj: _lightViewProj,
    shadowStrength: 0,
    phase: 0,
    amplitude: 0,
    twistTime: 0,
    bellRadius: 0
  };

  /**
   * Renders one frame.
   *
   * `view` is assembled by main.js and is pure data — no GL, no closures:
   *   camera, swim, snow, strands, bell     the live simulation objects
   *   settings                              the quality controller's live table
   *   dt, time, frame                       seconds, seconds, integer
   *   causticTime                           §2.1's gobo clock, §4.6-rate-scaled
   *   phase, amplitude, twistTime           the deformation state
   *   depthOrigin                           §5.1's −14 m working depth
   *   outputWidth, outputHeight             the default framebuffer, in pixels
   */
  function render(view) {
    if (!targets.ready || pending.length > 0) return;

    const settings = view.settings;
    const camera = view.camera;
    const swim = view.swim;
    const bell = view.bell;
    const lod = bell.lod(settings.bellLOD === 'LOD1' ? 1 : 0);

    /* ---- per-frame derived values ------------------------------------- */

    // uSunDir points DOWN, along the direction the light TRAVELS. camera.js
    // publishes the direction TOWARDS the sun, so this is where the sign is
    // turned round — once, for the whole frame. Getting it backwards puts the
    // godrays on the sea floor.
    _sunDir[0] = -camera.sunDirection.x;
    _sunDir[1] = -camera.sunDirection.y;
    _sunDir[2] = -camera.sunDirection.z;

    _worldOrigin[0] = swim.worldOffset.x;
    _worldOrigin[1] = view.depthOrigin + swim.worldOffset.y;
    _worldOrigin[2] = swim.worldOffset.z;

    _camPos[0] = camera.position.x;
    _camPos[1] = camera.position.y;
    _camPos[2] = camera.position.z;

    // sea.js's uCamY must equal uCamPos.y + uWorldOrigin.y exactly, or the
    // analytic water column is evaluated at a different depth from the one the
    // bell and the snow inside it are lit at. Deriving it here rather than
    // reading camera.worldY makes that an identity rather than a convention.
    const camY = _camPos[1] + _worldOrigin[1];

    // The key light is scene-referred white already attenuated to the animal's
    // depth. There is not one blue constant in the render path; every blue on
    // screen is what survived per-channel absorption.
    downwelling(_sunCol, swim.worldY);

    // The gobo's own clock, integrated by main.js so that §4.6's 15 % speed is a
    // RATE and not a rescaling of absolute time — the latter would teleport the
    // caustics the moment the operating system's reduce-motion switch is thrown
    // on a page that has been open for an hour.
    cookieDrift(_drift, view.causticTime);

    _bodyCentre.copyFrom(swim.position);

    // The sun-space frame for the shadow render. An orthographic box is right
    // here: the sun is 14 m of water away and its rays are parallel for any
    // purpose an animal 40 cm across can tell.
    _lightEye.set(
      _bodyCentre.x - _sunDir[0] * SHADOW_DISTANCE,
      _bodyCentre.y - _sunDir[1] * SHADOW_DISTANCE,
      _bodyCentre.z - _sunDir[2] * SHADOW_DISTANCE
    );
    mat4.lookAt(_lightView, _lightEye, _bodyCentre, [0, 0, 1]);
    mat4.ortho(_lightProj,
      -SHADOW_HALF_EXTENT, SHADOW_HALF_EXTENT,
      -SHADOW_HALF_EXTENT, SHADOW_HALF_EXTENT,
      0.05, SHADOW_DISTANCE * 2);
    mat4.multiply(_lightViewProj, _lightProj, _lightView);

    // The shadow map is a signed additive accumulation into an R16F target, so
    // it exists on the float path only — a UNORM target cannot subtract, and a
    // half-accumulated column is worse than none. It does NOT depend on THICK:
    // the sun-side render references a scalar distance rather than a texture,
    // so tier 4 keeps its dark subumbrellar cavity even though it has dropped
    // the camera-side thickness pass.
    const useShadow = floatPath;
    frameView.shadowStrength = useShadow ? 1 : 0;
    frameView.phase = view.phase;
    frameView.amplitude = view.amplitude;
    frameView.twistTime = view.twistTime;
    frameView.bellRadius = bell.radius;

    const overscan = 1 + (settings.overscan || 0);
    const seaViewProj = camera.overscanViewProjection;
    const seaInvViewProj = camera.inverseOverscanViewProjection;
    const tanHalfFov = Math.tan(camera.fovY * 0.5);
    const seaPixelScale = 0.5 * targets.seaHeight / (tanHalfFov * overscan);
    const finalPixelScale = 0.5 * targets.height / tanHalfFov;

    _invSea[0] = 1 / targets.seaWidth;
    _invSea[1] = 1 / targets.seaHeight;
    _invFinal[0] = 1 / targets.width;
    _invFinal[1] = 1 / targets.height;

    /* ---- pass 0: the caustic gobo ------------------------------------- */

    // Regenerated every frame at tiers 1 and 2, every other frame from tier 3.
    // It is a texture rather than a function because the shaft march samples it
    // sixteen times per pixel and the bell and the snow sample it again.
    cookieAge += 1;
    if (cookieAge >= (settings.cookieInterval || 1)) {
      cookieAge = 0;
      state.bindTarget(targets.cookieTarget);
      state.apply({ blend: 'none', depthTest: false, depthWrite: false, cull: 'none' });
      programs.cookie.use();
      programs.cookie.set('uCookieTime', view.causticTime);
      fullscreen.draw();
      targets.cookie.generateMipmap();
    }

    /* ---- pass 1: the shafts ------------------------------------------- */

    const useRaysBuffer = !!(settings.raysBuffer && targets.rays);
    if (useRaysBuffer) {
      const moved = camera.position.distanceTo(lastCameraPosition);
      const program = shaftProgramFor(settings.shaftSteps);

      state.bindTarget(targets.rays.write);
      state.apply({ blend: 'none', depthTest: false, depthWrite: false, cull: 'none' });
      program.use();
      setCaustic(program, frameView);
      program.texture('uHistory', targets.rays.read);
      program.set('uInvViewProj', seaInvViewProj);
      program.set('uCamPos', _camPos);
      program.set('uHistoryWeight', shaftHistoryWeight(moved, historyValid));
      program.set('uFrame', view.frame);
      fullscreen.draw();
      targets.rays.swap();
      historyValid = true;
    } else {
      historyValid = false;
    }
    lastCameraPosition.copyFrom(camera.position);

    /* ---- pass 2: the water column, far/mid snow, behind strands -------- */

    state.bindTarget(targets.seaTarget);
    state.apply({ blend: 'none', depthTest: false, depthWrite: true, cull: 'none' });
    // The colour clear is belt and braces: the fullscreen draw below writes
    // every texel with alpha 1. The DEPTH clear is not — pass 5 tests against
    // it, and State.clear forces depthMask on first so a previous pass cannot
    // silently swallow it.
    state.clear({ color: [0, 0, 0, 1], depth: 1 });

    {
      const program = useRaysBuffer ? programs.sea : programs['sea.inline'];
      program.use();
      if (useRaysBuffer) {
        program.texture('uShafts', targets.rays.read);
        _shaftRes[0] = targets.halfWidth;
        _shaftRes[1] = targets.halfHeight;
        program.set('uShaftRes', _shaftRes);
      } else {
        setCaustic(program, frameView);
        program.set('uFrame', view.frame);
      }
      program.set('uInvViewProj', seaInvViewProj);
      program.set('uCamPos', _camPos);
      program.set('uCamY', camY);
      state.apply({ blend: 'none', depthTest: false, depthWrite: false, cull: 'none' });
      fullscreen.draw();
    }

    // Far and mid snow, into SEA, so the animal is genuinely sandwiched in the
    // particulate rather than pasted over it. Depth writes are on here and
    // nowhere else in pass 2: this is the only geometry in the frame that pass
    // 5 has any business being occluded by.
    {
      const program = programs.snow;
      program.use();
      setCaustic(program, frameView);
      setSnowUniforms(program, seaViewProj,
        targets.seaWidth, targets.seaHeight, tanHalfFov * overscan, overscan);
      state.apply({
        blend: 'premultiplied', depthTest: true, depthWrite: true,
        depthFunc: 'less', cull: 'none'
      });
      drawSnow(view.snow.far);
      drawSnow(view.snow.mid);
    }

    // The behind group: strands whose chain centroid is further from the eye
    // than the bell's own centre. They are composited THROUGH the bell by the
    // exumbrella in pass 6 — tinted, dimmed and refracted by the animal they
    // are behind, which no depth sort can reproduce.
    {
      const program = programs.strand;
      program.use();
      setMedium(program, frameView);
      setJellyLighting(program, frameView);
      program.set('uViewProj', seaViewProj);
      program.set('uCameraPos', _camPos);
      program.set('uPixelScale', seaPixelScale);
      state.apply({
        blend: 'premultiplied', depthTest: true, depthWrite: false,
        depthFunc: 'less', cull: 'none'
      });
      view.strands.drawBehind();
    }

    /* ---- passes 3 and 4: the optical-depth accumulator ------------------ */

    // Skipped entirely on the analytic path (§2.5). That is a real fallback
    // producing a complete image, not a degraded version of a pass that cannot
    // run: UNORM blending clamps, so front faces could not subtract.
    const useThickness = !settings.analyticThickness && !!targets.thickTarget;

    // Pass 3's clear value, and the shadow render's reference distance. The
    // clear is the distance to the body centre rather than a large sentinel: a
    // back-facing fragment at a silhouette pixel where no front face landed
    // then still produces an O(1 cm) term, instead of one at a magnitude where
    // an fp16 ulp is eight metres.
    const refZ = camera.position.distanceTo(_bodyCentre);

    if (useThickness) {
      _invThick[0] = 1 / targets.thickWidth;
      _invThick[1] = 1 / targets.thickHeight;

      state.bindTarget(targets.zfrontTarget);
      state.apply({
        blend: 'none', depthTest: true, depthWrite: true,
        depthFunc: 'less', cull: 'back'
      });
      state.clear({ color: [refZ, refZ, refZ, 1], depth: 1 });
      {
        const program = programs.zfront;
        program.use();
        setDeform(program, frameView);
        program.set('uViewProj', seaViewProj);
        program.set('uModel', swim.modelMatrix);
        program.set('uCameraPos', _camPos);
        drawJelly(bell, lod);
      }

      // Pass 4. Culling disabled, depth off, ONE/ONE, cleared to zero. Back
      // faces add and front faces subtract, so the sum over every layer a ray
      // crosses is the optical path INSIDE the animal — any number of layers,
      // any concavity, one pass, no depth peeling.
      state.bindTarget(targets.thickTarget);
      state.apply({ blend: 'add', depthTest: false, depthWrite: false, cull: 'none' });
      state.clear({ color: [0, 0, 0, 0] });
      {
        const program = programs.thick;
        program.use();
        setDeform(program, frameView);
        program.set('uViewProj', seaViewProj);
        program.set('uModel', swim.modelMatrix);
        program.set('uCameraPos', _camPos);
        program.texture('uZFront', targets.zfront);
        program.set('uInvRes', _invThick);
        drawJelly(bell, lod);
      }
    }

    // The self-shadow: the same program from the sun's view, into a 256²
    // light-space optical depth, every frame. It costs about 0.03 ms and a
    // one-second cache would visibly lag a 2.2 s pulse.
    if (useShadow) {
      state.bindTarget(targets.shadowTarget);
      state.apply({ blend: 'add', depthTest: false, depthWrite: false, cull: 'none' });
      state.clear({ color: [0, 0, 0, 0] });
      const program = programs.shadow;
      program.use();
      setDeform(program, frameView);
      program.set('uViewProj', _lightViewProj);
      program.set('uModel', swim.modelMatrix);
      _lightEye.toArray(_lightEyeArray);
      program.set('uCameraPos', _lightEyeArray);
      program.set('uRefZ', _lightEye.distanceTo(_bodyCentre));
      drawJelly(bell, lod);
    }

    /* ---- pass 5: the interior ------------------------------------------ */

    // mat3.normalFromMat4 returns null on a singular matrix rather than filling
    // the output with NaN, and a NaN normal matrix silently blanks a whole draw.
    if (!mat3.normalFromMat4(_normalMatrix, swim.modelMatrix)) {
      mat3.identity(_normalMatrix);
    }

    state.bindTarget(targets.seaTarget);
    {
      const program = programs[useThickness ? 'bell.subumbrella' : 'bell.subumbrella.analytic'];
      program.use();
      setCaustic(program, frameView);
      setJellyLighting(program, frameView);
      setDeform(program, frameView);
      // From the geometry instance rather than from the module constant: the
      // mesh divides its per-vertex thickScale by wallThickness(0, ITS radius),
      // so this is the one number that has to come from the same place.
      program.set('uWall', bell.wallReference);
      program.set('uViewProj', seaViewProj);
      program.set('uModel', swim.modelMatrix);
      program.set('uNormalMatrix', _normalMatrix);
      program.set('uCameraPos', _camPos);
      program.set('uInvRes', _invSea);
      // Pass 5 rasterises in SEA's own frustum, which is the frustum THICK was
      // rendered in, so no guard-band conversion is needed here.
      program.set('uSeaOverscan', 1.0);
      if (useThickness) {
        program.texture('uThick', targets.thick);
        program.set('uThickSize', [targets.thickWidth, targets.thickHeight]);
      }

      // The inner shell is seen from inside the cavity, so its outward-facing
      // triangles point away from the camera: cull FRONT.
      state.apply({
        blend: 'alpha', depthTest: true, depthWrite: false,
        depthFunc: 'less', cull: 'front'
      });
      lod.draw('subumbrella');

      // The gonad tubes and the manubrium are closed tubes seen from outside.
      state.apply({
        blend: 'alpha', depthTest: true, depthWrite: false,
        depthFunc: 'less', cull: 'back'
      });
      bell.interior.draw('all');
    }

    // The oral arms, in pass 5 with the strand program: the same vertex format
    // and the same fragment shader as the tentacles, at three times the density.
    {
      const program = programs.strand;
      program.use();
      setMedium(program, frameView);
      setJellyLighting(program, frameView);
      program.set('uViewProj', seaViewProj);
      program.set('uCameraPos', _camPos);
      program.set('uPixelScale', seaPixelScale);
      state.apply({
        blend: 'premultiplied', depthTest: true, depthWrite: false,
        depthFunc: 'less', cull: 'none'
      });
      view.strands.drawArms();
    }

    /* ---- pass 6: FINAL -------------------------------------------------- */

    const finalTarget = targets.finalMSTarget || targets.finalTarget;

    state.bindTarget(finalTarget);
    state.apply({ blend: 'none', depthTest: false, depthWrite: false, cull: 'none' });

    // SEA -> FINAL is a DRAW, never a blit. See the header: blitting into a
    // multisampled draw framebuffer is INVALID_OPERATION, and the two buffers
    // are different sizes and different frustums in any case.
    {
      const program = programs['sea.copy'];
      program.use();
      program.texture('uSea', targets.sea);
      program.set('uSeaOverscan', overscan);
      fullscreen.draw();
    }

    // The exumbrella. It composites everything behind it THROUGH itself, which
    // is why nothing in this frame depth-tests against the bell.
    {
      const program = programs[useThickness ? 'bell.exumbrella' : 'bell.exumbrella.analytic'];
      program.use();
      setCaustic(program, frameView);
      setJellyLighting(program, frameView);
      setDeform(program, frameView);
      // From the geometry instance rather than from the module constant: the
      // mesh divides its per-vertex thickScale by wallThickness(0, ITS radius),
      // so this is the one number that has to come from the same place.
      program.set('uWall', bell.wallReference);
      program.set('uViewProj', camera.viewProjection);
      program.set('uModel', swim.modelMatrix);
      program.set('uNormalMatrix', _normalMatrix);
      program.set('uCameraPos', _camPos);
      program.set('uInvRes', _invFinal);
      program.set('uSeaOverscan', overscan);
      program.texture('uSea', targets.sea);
      if (useThickness) {
        program.texture('uThick', targets.thick);
        program.set('uThickSize', [targets.thickWidth, targets.thickHeight]);
      }
      state.apply({ blend: 'premultiplied', depthTest: false, depthWrite: false, cull: 'back' });
      lod.draw('exumbrellaWithRim');
    }

    // The front strands, then the near snow: the two things that must sit in
    // front of the animal rather than be refracted through it.
    {
      const program = programs.strand;
      program.use();
      setMedium(program, frameView);
      setJellyLighting(program, frameView);
      program.set('uViewProj', camera.viewProjection);
      program.set('uCameraPos', _camPos);
      program.set('uPixelScale', finalPixelScale);
      state.apply({ blend: 'premultiplied', depthTest: false, depthWrite: false, cull: 'none' });
      view.strands.drawFront();
    }

    {
      const program = programs.snow;
      program.use();
      setCaustic(program, frameView);
      // Pass 6 rasterises in the narrow framing frustum, so no guard band.
      setSnowUniforms(program, camera.viewProjection,
        targets.width, targets.height, tanHalfFov, 1.0);
      state.apply({ blend: 'premultiplied', depthTest: false, depthWrite: false, cull: 'none' });
      drawSnow(view.snow.near);
    }

    // The one legal blit in the project: multisample -> single sample.
    if (targets.finalMSTarget) {
      resolveMultisample(gl, targets.finalMSTarget, targets.finalTarget, 'nearest');
    }

    /* ---- pass 7: post --------------------------------------------------- */

    post(view);
  }

  /* --- Pass 7 ------------------------------------------------------------ */

  /**
   * Bright pass, dual-filter Kawase down and up, the 1×1 exposure EMA, and the
   * composite straight to the default framebuffer.
   *
   * Two properties the §7 ladder depends on and which must not be removed: the
   * composite divides the bloom weight by the live level count, because each
   * dual-filter level is mean-preserving and five levels therefore carry two
   * and a half times the energy of two; and the flat veil term reads the
   * SMALLEST mip, whose mean is level-count invariant. Between them, changing
   * the level count changes the width of the halo and nothing else.
   */
  function post(view) {
    const settings = view.settings;
    const bloom = targets.bloom;
    const levels = Math.max(2, Math.min(bloom.length, settings.bloomLevels | 0));

    const postState = { blend: 'none', depthTest: false, depthWrite: false, cull: 'none' };

    // 1. bright pass: FINAL -> bloom[0].down
    state.bindTarget(bloom[0].downTarget);
    state.apply(postState);
    _halfTexel[0] = 0.5 * _invFinal[0];
    _halfTexel[1] = 0.5 * _invFinal[1];
    programs['post.bright'].use();
    programs['post.bright'].texture('uScene', targets.final);
    programs['post.bright'].set('uHalfTexel', _halfTexel);
    programs['post.bright'].set('uHdrDecode', hdrDecode);
    programs['post.bright'].set('uHdrEncode', 1 / hdrDecode);
    fullscreen.draw();

    // 2. downsample chain
    for (let i = 1; i < levels; i++) {
      const src = bloom[i - 1];
      state.bindTarget(bloom[i].downTarget);
      state.apply(postState);
      _halfTexel[0] = 0.5 / src.width;
      _halfTexel[1] = 0.5 / src.height;
      programs['post.down'].use();
      programs['post.down'].texture('uSrc', src.down);
      programs['post.down'].set('uHalfTexel', _halfTexel);
      fullscreen.draw();
    }

    // 3. upsample chain, read-and-add rather than an additive blend
    for (let i = levels - 2; i >= 0; i--) {
      const smallerLevel = bloom[i + 1];
      const smaller = (i === levels - 2) ? bloom[levels - 1].down : smallerLevel.up;
      state.bindTarget(bloom[i].upTarget);
      state.apply(postState);
      _halfTexel[0] = 0.5 / smallerLevel.width;
      _halfTexel[1] = 0.5 / smallerLevel.height;
      programs['post.up'].use();
      programs['post.up'].texture('uSrc', smaller);
      programs['post.up'].texture('uBase', bloom[i].down);
      programs['post.up'].set('uHalfTexel', _halfTexel);
      fullscreen.draw();
    }

    // 4. auto-exposure. A 1x1 ping-pong EMA off the smallest bloom mip; there is
    //    no readPixels anywhere in this project, and there must never be one.
    state.bindTarget(targets.expo.write);
    state.apply(postState);
    programs['post.exposure'].use();
    programs['post.exposure'].texture('uMeter', bloom[levels - 1].down);
    programs['post.exposure'].texture('uPrev', targets.expo.read);
    programs['post.exposure'].set('uDt', view.dt);
    programs['post.exposure'].set('uExposureKey', POST_CONSTANTS.EXPOSURE_KEY);
    programs['post.exposure'].set('uHdrDecode', hdrDecode);
    fullscreen.draw();
    targets.expo.swap();

    // 5. the composite, to the default framebuffer at native size
    const composite = programs['post.composite'];
    state.bindTarget(null, view.outputWidth, view.outputHeight);
    state.apply(postState);
    composite.use();
    composite.texture('uScene', targets.final);
    composite.texture('uBloom', bloom[0].up);
    composite.texture('uVeil', bloom[levels - 1].down);
    composite.texture('uExposure', targets.expo.read);
    composite.set('uSceneTexel', _invFinal);
    composite.set('uAspect', view.outputWidth / Math.max(1, view.outputHeight));
    composite.set('uTanHalfFov', Math.tan(view.camera.fovY * 0.5));
    composite.set('uFrame', view.frame);
    composite.set('uHdrDecode', hdrDecode);
    composite.set('uBloomLevels', levels);
    fullscreen.draw();
  }

  /* --- Lifecycle --------------------------------------------------------- */

  return {
    targets,
    state,
    programs,
    config,
    get floatPath() { return floatPath; },
    /** The sample count targets.configure() must be given. See effectiveMsaa. */
    get msaaSamples() { return effectiveMsaa; },

    /**
     * True once every program has linked. Until then `render()` is a no-op, so
     * a caller that forgets to poll gets a black page rather than a GL error.
     */
    get programsReady() { return pending.length === 0; },
    pollPrograms,

    /**
     * Records the size and quality intent. `targets.update()` decides when to
     * actually allocate, so this is safe to call every frame.
     */
    configure(desc) {
      targets.configure(desc);
      return this;
    },

    /** Once per frame, before render(). The only clock consumer in the graph. */
    update(nowMs) {
      targets.update(nowMs);
      if (targets.needsPrime) targets.prime();
      return this;
    },

    /** Forces a pending allocation immediately; used after a context restore. */
    forceUpdate() {
      targets.forceUpdate();
      return this;
    },

    /**
     * The shaft history is a feedback buffer, so anything that invalidates the
     * previous frame — a resize, a tab wake, a context restore — has to say so
     * or a stale image ghosts for ten frames.
     */
    invalidateHistory() {
      historyValid = false;
      cookieAge = 1e9;
      return this;
    },

    /**
     * Every uniform name a pass tried to set that its program does not have.
     * The GLSL compiler removes unused uniforms aggressively, so a few entries
     * here are normal — the caustic sampler on a program that only needs the
     * medium, for instance. A name that is misspelled shows up here too, which
     * is why ?dev=1 prints it after the first frame.
     */
    missingUniforms() {
      const out = {};
      for (const name in programs) {
        const missing = [...programs[name].missing];
        if (missing.length) out[name] = missing;
      }
      return out;
    },

    render,

    dispose() {
      snowBatches.clear();
      for (const item of pending) item.handle.dispose();
      pending.length = 0;
      registry.disposeAll();
      targets.dispose();
    }
  };
}
