/* ============================================================
   render/targets.js — every buffer in the §1 table.
   ------------------------------------------------------------
   One owner for allocation, format selection and reallocation.
   frame.js reads the fields on the object this returns and never
   creates a target of its own, so there is exactly one place to
   look when a buffer turns out to be the wrong size or format.

   THE §1 TABLE, and what each row becomes here:

     COOKIE     256 x 256, 5 levels, R8          caustic gobo
     RAYS_A/B   scene/2, ping-pong               shafts + 4-frame history
     SEA        scene x (1 + overscan) + depth   the water column
     ZFRONT     scene/thickDivisor               nearest bell front face, view Z
     THICK      scene/thickDivisor               signed optical + geometric depth
     FINAL      scene (+ optional 4x MS)         the composited scene
     BLOOM[0-4] scene/2 ... scene/32, two chains dual-filter Kawase
     EXPO_A/B   1 x 1                            luminance EMA ping-pong
     SHADOW     256 x 256                        light-space optical depth (§2.5)

   `scene` is `css size * renderScale`. RS therefore plays the
   role devicePixelRatio would in a naive renderer, which is the
   whole point of §7's absolute pixel budget: a 4K display gets
   the same amount of work as a 1080p one and a gentler upscale,
   rather than four times the work.

   FORMAT SELECTION IS DRIVEN BY THE PROBE, NOT BY GUESSWORK.
   Without EXT_color_buffer_float (or its half-float sibling)
   there is no float colour attachment at all, and the §7 mobile
   path applies: SEA and FINAL become RGBA8 carrying a fixed 1/8
   pre-exposure that the post chain undoes on read, and ZFRONT
   and THICK are NOT ALLOCATED — the analytic slab path of §2.5
   runs in their place. That is a real fallback that produces a
   good image, not a degraded version of a pass that cannot run,
   and it is why nothing here silently substitutes a format and
   hopes.

   ZFRONT FOLLOWS THICK'S DIVISOR, one considered deviation from
   the table. §1 fixes ZFRONT at RS/2 while THICK drops to RS/3
   at tier 3. The two are read as a matched pair — thickness.js
   fetches ZFRONT at its own fragment coordinate to subtract a
   local front depth — so a resolution mismatch puts the
   reference a texel away from the layer being accumulated, which
   is precisely the rim banding the relative encoding exists to
   remove. They are allocated at the same size, which at tiers 1
   and 2 is exactly what the table says and at tier 3 is also
   cheaper.

   ALL FIVE BLOOM LEVELS ARE ALWAYS ALLOCATED even though the
   ladder uses between two and five of them. Levels 3 and 4 are
   scene/16 and scene/32 — together well under a tenth of a
   megabyte — and allocating them unconditionally means a tier
   change never has to reallocate anything, which is worth far
   more than the memory.

   REALLOCATION IS DEBOUNCED TWICE OVER. §10 requires that a
   ten-second drag-resize allocates at most three times, and §7
   asks for a 250 ms debounce so a window drag does not allocate
   sixty sets of FP16 targets. A quiet-period debounce alone
   would leave a continuous drag rendering at a stale size for
   the entire drag, so there is also a maximum staleness: after
   4 s of a still-changing size we reallocate anyway. Ten seconds
   of continuous dragging therefore costs three allocations —
   two forced, one when the drag stops — which is exactly the
   budget, and a normal short resize costs one.
   ============================================================ */

import {
  createTexture2D,
  createRenderbuffer,
  createFramebuffer,
  GLObjectRegistry
} from '../gl.js';

export const TARGET_CONSTANTS = Object.freeze({
  /** Quiet period before a size change is acted on, §7. */
  DEBOUNCE_MS: 250,
  /** Maximum time a still-changing size may render stale before we reallocate
      anyway. Chosen so a 10 s continuous drag costs three allocations. */
  MAX_STALE_MS: 4000,
  COOKIE_SIZE: 256,
  /** causticAt() clamps its mip to 4.0, so level 4 has to exist: 256, 128, 64,
      32, 16. The §1 table's "4 mips" is four mips ON TOP of the base. */
  COOKIE_LEVELS: 5,
  /** §2.5's self-shadow map: the thickness program re-rendered from the sun. */
  SHADOW_SIZE: 256,
  BLOOM_LEVELS: 5,
  /** The pre-exposure RGBA8 SEA/FINAL carry on write. Three stops of headroom
      above 1.0; the post chain's dither covers the quantisation. */
  RGBA8_PRE_EXPOSURE: 1 / 8,
  /** The 1x1 EXPO target stores ev * 0.5 + 0.5, so it works in R16F and in
      RGBA8 alike. This is the value that means "no exposure change". */
  EXPO_NEUTRAL: 0.5
});

/**
 * Picks every format from the capability probe. Called once at boot and again
 * after a context restore, because a restored context may not have the same
 * extensions the lost one did.
 */
export function selectTargetFormats(caps) {
  const floatPath = !!(caps && caps.floatTargets);
  return Object.freeze({
    floatPath,
    /** SEA, FINAL, RAYS, BLOOM. */
    hdr: floatPath ? 'RGBA16F' : 'RGBA8',
    /** ZFRONT, SHADOW, EXPO. */
    scalar: floatPath ? 'R16F' : 'RGBA8',
    /** THICK: R is the optical depth, G the geometric one. */
    dual: floatPath ? 'RG16F' : 'RGBA8',
    /** SEA's depth attachment, sampled by the bilateral shaft upsample. */
    depth: 'DEPTH24',
    /** COOKIE. */
    cookie: 'R8',
    /** Multiply on write, divide on read. 1.0 on the float path. */
    preExposure: floatPath ? 1 : TARGET_CONSTANTS.RGBA8_PRE_EXPOSURE,
    hdrDecode: floatPath ? 1 : 1 / TARGET_CONSTANTS.RGBA8_PRE_EXPOSURE
  });
}

/** Whole pixels, never zero, so a one-pixel window cannot produce a 0-size
    texStorage2D — which is an INVALID_VALUE, not a blank frame. */
function divide(n, divisor) {
  return Math.max(1, Math.ceil(n / divisor));
}

function sizeOf(css, renderScale) {
  return Math.max(1, Math.round(css * renderScale));
}

/**
 * Allocates and owns every render target.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} options
 * @param {object} options.caps    the gl.js capability probe
 * @param {object|null} options.state  the gl.js state cache. When present the
 *        manager primes EXPO and RAYS itself after each allocation; when absent
 *        it sets `needsPrime` and the caller must clear them and call
 *        markPrimed(). targets.js names no WebGL enum either way — clearing
 *        goes through the state cache, which is the one file allowed to.
 * @param {function|null} options.onAllocate  (targets) after each allocation
 */
export function createTargets(gl, options = {}) {
  const { caps = null, state = null, onAllocate = null } = options;
  const C = TARGET_CONSTANTS;
  const formats = selectTargetFormats(caps);

  // Two registries. `permanent` holds the size-independent targets — the cookie
  // gobo, the shadow map, the 1x1 exposure pair — which survive every resize.
  // `sized` is swept and rebuilt whole on each reallocation; disposing in
  // reverse creation order is what GLObjectRegistry is for.
  const permanent = new GLObjectRegistry('targets/permanent');
  let sized = new GLObjectRegistry('targets/sized');

  // Every timestamp here comes from update()'s `now`, never from the wall clock
  // directly. One clock means the debounce is deterministic and testable, and it
  // means a caller that drives the renderer from its own timeline (a soak
  // harness, a capture script) gets the same behaviour as a live page.
  let desired = null;      // the configuration we have been asked for
  let applied = null;      // the configuration currently allocated
  let appliedSig = null;
  let seenSig = null;      // the signature as of the last update() observation
  let dirtySinceMs = 0;    // when `desired` first differed from what is allocated
  let lastChangeMs = 0;    // when update() last saw the signature change
  let disposed = false;

  const targets = {
    formats,
    floatPath: formats.floatPath,
    /** Multiply HDR colour by this on write to SEA/FINAL; 1.0 on the float path. */
    preExposure: formats.preExposure,
    /** Divide by it on read. This is post.js's `uHdrDecode`. */
    hdrDecode: formats.hdrDecode,

    /** Scene resolution: css size * renderScale. FINAL and the bell passes. */
    width: 0,
    height: 0,
    /** SEA, which carries the guard-band overscan at tiers 1 and 2. */
    seaWidth: 0,
    seaHeight: 0,
    /** ZFRONT and THICK. */
    thickWidth: 0,
    thickHeight: 0,
    /** RAYS and BLOOM[0]. */
    halfWidth: 0,
    halfHeight: 0,

    cookie: null,
    cookieTarget: null,
    shadow: null,
    shadowTarget: null,
    /** { index, textures[2], targets[2], read, write, swap() } or null at tier 4. */
    rays: null,
    sea: null,
    seaDepth: null,
    seaTarget: null,
    zfront: null,
    zfrontDepth: null,
    zfrontTarget: null,
    thick: null,
    thickTarget: null,
    /** The texture the post chain samples. On the MSAA path this is the resolve
        destination and geometry is drawn into `finalMSTarget` instead. */
    final: null,
    finalTarget: null,
    finalMS: null,
    finalMSTarget: null,
    /** Five entries of { down, downTarget, up, upTarget }. The top level has no
        `up`: nothing upsamples into it. */
    bloom: [],
    /** { index, textures[2], targets[2], read, write, swap() }. */
    expo: null,

    /** How many times the sized targets have been allocated. §10 counts this. */
    allocationCount: 0,
    /** True when EXPO and RAYS hold garbage and must be cleared before use. */
    needsPrime: false,
    /** True once anything at all has been allocated. */
    get ready() { return applied !== null; }
  };

  function signature(desc) {
    return [
      desc.width, desc.height, desc.seaWidth, desc.seaHeight,
      desc.thickWidth, desc.thickHeight, desc.msaa, desc.rays ? 1 : 0,
      desc.thickDivisor
    ].join(':');
  }

  /**
   * Records the configuration the renderer wants. Cheap and idempotent — call
   * it every frame with the live quality settings if that is convenient.
   * Nothing is allocated here; update() decides when.
   */
  function configure(desc = {}) {
    const {
      cssWidth = 0,
      cssHeight = 0,
      renderScale = 1,
      overscan = 0,
      thickDivisor = 2,
      rays = true,
      msaa = 0
    } = desc;

    // The zero-size bail of §7's lifecycle rules. A hidden or collapsed host
    // element reports 0 and must not tear the targets down.
    if (!cssWidth || !cssHeight) return targets;

    const width = sizeOf(cssWidth, renderScale);
    const height = sizeOf(cssHeight, renderScale);
    const useThick = formats.floatPath && thickDivisor > 0;
    const divisor = useThick ? thickDivisor : 2;

    // MSAA is a probe-gated bonus, never load-bearing, and it only exists on the
    // float path because the whole point of it is a multisampled RGBA16F FINAL.
    const maxSamples = (caps && formats.floatPath) ? (caps.maxSamplesRGBA16F | 0) : 0;
    const samples = (msaa >= 4 && maxSamples >= 4) ? Math.min(msaa, maxSamples) : 0;

    const next = {
      width,
      height,
      seaWidth: Math.max(1, Math.round(width * (1 + overscan))),
      seaHeight: Math.max(1, Math.round(height * (1 + overscan))),
      thickWidth: divide(width, divisor),
      thickHeight: divide(height, divisor),
      thickDivisor: useThick ? thickDivisor : 0,
      rays: !!rays && formats.floatPath,
      msaa: samples,
      overscan
    };

    desired = next;
    return targets;
  }

  function allocate(desc) {
    const previous = sized;
    const registry = new GLObjectRegistry('targets/sized');
    const built = {};

    const tex = (spec) => registry.add(createTexture2D(gl, Object.assign({ caps }, spec)));
    const fbo = (spec) => registry.add(createFramebuffer(gl, spec));

    try {
      // SEA: the water column, with the depth attachment the bilateral shaft
      // upsample reads. Depth textures are not linear-filterable, so NEAREST.
      built.sea = tex({
        name: 'SEA', width: desc.seaWidth, height: desc.seaHeight, format: formats.hdr
      });
      built.seaDepth = tex({
        name: 'SEA.depth', width: desc.seaWidth, height: desc.seaHeight,
        format: formats.depth, min: 'nearest', mag: 'nearest'
      });
      built.seaTarget = fbo({ name: 'SEA', color: [built.sea], depth: built.seaDepth });

      // FINAL, plus the optional multisampled surface geometry is drawn into.
      // The only blitFramebuffer in the project resolves that into `final`; the
      // other direction is INVALID_OPERATION, which is why SEA -> FINAL is a
      // fullscreen draw and not a blit.
      built.final = tex({
        name: 'FINAL', width: desc.width, height: desc.height, format: formats.hdr
      });
      built.finalTarget = fbo({ name: 'FINAL', color: [built.final] });
      if (desc.msaa >= 4) {
        built.finalMS = registry.add(createRenderbuffer(gl, {
          name: 'FINAL.ms', width: desc.width, height: desc.height,
          format: formats.hdr, samples: desc.msaa
        }));
        built.finalMSTarget = fbo({ name: 'FINAL.ms', color: [built.finalMS] });
      } else {
        built.finalMS = null;
        built.finalMSTarget = null;
      }

      // RAYS: half-res shaft march with a four-frame history, ping-ponged.
      if (desc.rays) {
        const halfW = divide(desc.width, 2);
        const halfH = divide(desc.height, 2);
        const rayTextures = [
          tex({ name: 'RAYS_A', width: halfW, height: halfH, format: formats.hdr }),
          tex({ name: 'RAYS_B', width: halfW, height: halfH, format: formats.hdr })
        ];
        built.rays = {
          index: 0,
          textures: rayTextures,
          targets: [
            fbo({ name: 'RAYS_A', color: [rayTextures[0]] }),
            fbo({ name: 'RAYS_B', color: [rayTextures[1]] })
          ],
          get read() { return this.textures[this.index ^ 1]; },
          get write() { return this.targets[this.index]; },
          swap() { this.index ^= 1; }
        };
      } else {
        built.rays = null;
      }

      // ZFRONT and THICK, allocated as a matched pair or not at all. Without
      // them the analytic slab path of §2.5 runs, which is a complete image.
      if (desc.thickDivisor > 0) {
        built.zfront = tex({
          name: 'ZFRONT', width: desc.thickWidth, height: desc.thickHeight,
          format: formats.scalar
        });
        // §1's pass 3 is "test + write": it wants the NEAREST bell front face,
        // not the last one rasterised. Without a depth attachment a depth test
        // silently always passes and the write is discarded, so the prepass
        // would hand the thickness pass whichever front face happened to be
        // drawn last. The subtraction stays mathematically valid either way —
        // the reference cancels inside every front/back pair — but the whole
        // point of §2.4's relative encoding is to keep every term O(1 cm), and
        // a reference taken from the far side of the bell doubles them. Nothing
        // samples this, so it is a renderbuffer rather than a texture.
        built.zfrontDepth = registry.add(createRenderbuffer(gl, {
          name: 'ZFRONT.depth',
          width: desc.thickWidth,
          height: desc.thickHeight,
          format: formats.depth
        }));
        built.zfrontTarget = fbo({
          name: 'ZFRONT', color: [built.zfront], depth: built.zfrontDepth
        });
        built.thick = tex({
          name: 'THICK', width: desc.thickWidth, height: desc.thickHeight,
          format: formats.dual
        });
        built.thickTarget = fbo({ name: 'THICK', color: [built.thick] });
      } else {
        built.zfront = null;
        built.zfrontDepth = null;
        built.zfrontTarget = null;
        built.thick = null;
        built.thickTarget = null;
      }

      // BLOOM: two chains, all five levels, always. The down chain is what the
      // bright pass and the Kawase downsample write; the up chain accumulates
      // back toward level 0. Level 4 never receives an upsample, so it has no
      // `up` texture — the composite reads it directly as the veiling glare.
      built.bloom = [];
      for (let i = 0; i < C.BLOOM_LEVELS; i++) {
        const w = divide(desc.width, 1 << (i + 1));
        const h = divide(desc.height, 1 << (i + 1));
        const down = tex({ name: `BLOOM${i}.down`, width: w, height: h, format: formats.hdr });
        const level = {
          width: w,
          height: h,
          down,
          downTarget: fbo({ name: `BLOOM${i}.down`, color: [down] }),
          up: null,
          upTarget: null
        };
        if (i < C.BLOOM_LEVELS - 1) {
          level.up = tex({ name: `BLOOM${i}.up`, width: w, height: h, format: formats.hdr });
          level.upTarget = fbo({ name: `BLOOM${i}.up`, color: [level.up] });
        }
        built.bloom.push(level);
      }
    } catch (error) {
      registry.disposeAll();
      throw error;
    }

    // Only now that everything succeeded do we drop the previous generation.
    // Allocating first and freeing second costs one frame of doubled memory and
    // buys an allocation failure that leaves the renderer still running.
    previous.disposeAll();
    sized = registry;
    appliedSig = signature(desc);

    targets.width = desc.width;
    targets.height = desc.height;
    targets.seaWidth = desc.seaWidth;
    targets.seaHeight = desc.seaHeight;
    targets.thickWidth = desc.thickWidth;
    targets.thickHeight = desc.thickHeight;
    targets.halfWidth = divide(desc.width, 2);
    targets.halfHeight = divide(desc.height, 2);
    targets.sea = built.sea;
    targets.seaDepth = built.seaDepth;
    targets.seaTarget = built.seaTarget;
    targets.final = built.final;
    targets.finalTarget = built.finalTarget;
    targets.finalMS = built.finalMS;
    targets.finalMSTarget = built.finalMSTarget;
    targets.rays = built.rays;
    targets.zfront = built.zfront;
    targets.zfrontDepth = built.zfrontDepth;
    targets.zfrontTarget = built.zfrontTarget;
    targets.thick = built.thick;
    targets.thickTarget = built.thickTarget;
    targets.bloom = built.bloom;
    targets.allocationCount++;

    applied = desc;
    dirtySinceMs = 0;
    prime();
    if (typeof onAllocate === 'function') onAllocate(targets);
    return targets;
  }

  /**
   * The permanent targets: the cookie gobo, the light-space shadow map and the
   * 1x1 exposure pair. None of them depends on the window size, so a resize
   * must not disturb them — in particular the exposure EMA keeps its value
   * across a resize, which is the difference between a resize that is invisible
   * and one that flashes.
   */
  function allocatePermanent() {
    const cookie = permanent.add(createTexture2D(gl, {
      caps,
      name: 'COOKIE',
      width: C.COOKIE_SIZE,
      height: C.COOKIE_SIZE,
      format: formats.cookie,
      levels: C.COOKIE_LEVELS,
      // The gobo is projected onto an unbounded surface plane, so it must tile;
      // the mip chain is the physical part — multiple scattering diffuses the
      // shafts with depth and causticAt() reads a deeper mip further down.
      min: 'linear-mipmap-linear',
      mag: 'linear',
      wrapS: 'repeat',
      wrapT: 'repeat'
    }));
    targets.cookie = cookie;
    targets.cookieTarget = permanent.add(createFramebuffer(gl, {
      name: 'COOKIE', color: [cookie]
    }));

    const shadow = permanent.add(createTexture2D(gl, {
      caps,
      name: 'SHADOW',
      width: C.SHADOW_SIZE,
      height: C.SHADOW_SIZE,
      format: formats.scalar
    }));
    targets.shadow = shadow;
    targets.shadowTarget = permanent.add(createFramebuffer(gl, {
      name: 'SHADOW', color: [shadow]
    }));

    const expoTextures = [0, 1].map((i) => permanent.add(createTexture2D(gl, {
      caps,
      name: `EXPO_${i ? 'B' : 'A'}`,
      width: 1,
      height: 1,
      format: formats.scalar,
      min: 'nearest',
      mag: 'nearest'
    })));
    targets.expo = {
      index: 0,
      textures: expoTextures,
      targets: expoTextures.map((t, i) => permanent.add(createFramebuffer(gl, {
        name: `EXPO_${i ? 'B' : 'A'}`, color: [t]
      }))),
      get read() { return this.textures[this.index ^ 1]; },
      get write() { return this.targets[this.index]; },
      swap() { this.index ^= 1; }
    };
  }

  /**
   * Clears the buffers whose contents are read before they are written: both
   * halves of the exposure ping-pong (to the neutral 0 EV encoding) and both
   * halves of RAYS (to zero, so the first frame's history blend has nothing to
   * blend against rather than garbage). Without a state cache this is left to
   * the caller through `needsPrime`.
   */
  function prime() {
    if (!state) {
      targets.needsPrime = true;
      return;
    }
    const neutral = C.EXPO_NEUTRAL;
    for (const fb of targets.expo.targets) {
      state.bindTarget(fb);
      state.clear({ color: [neutral, 0, 0, 1] });
    }
    if (targets.rays) {
      for (const fb of targets.rays.targets) {
        state.bindTarget(fb);
        state.clear({ color: [0, 0, 0, 0] });
      }
    }
    targets.needsPrime = false;
  }

  /**
   * Applies a pending configuration if the debounce says it is time. Call once
   * per frame. `nowMs` defaults to performance.now(); passing it explicitly is
   * what makes the debounce testable.
   */
  function update(nowMs) {
    if (disposed || !desired) return targets;
    const now = Number.isFinite(nowMs)
      ? nowMs
      : ((typeof performance !== 'undefined') ? performance.now() : Date.now());

    const sig = signature(desired);
    if (sig !== seenSig) {
      seenSig = sig;
      lastChangeMs = now;
    }

    // A size that has wandered back to what is already allocated is not dirty at
    // all, so a drag that returns to its starting width costs nothing.
    if (appliedSig === sig) {
      dirtySinceMs = 0;
      return targets;
    }
    if (!dirtySinceMs) dirtySinceMs = now;

    // The first allocation is never debounced: there is nothing to render into
    // until it happens, and the boot fade is already covering it.
    if (!applied) return allocate(desired);

    const quiet = now - lastChangeMs >= C.DEBOUNCE_MS;
    const stale = now - dirtySinceMs >= C.MAX_STALE_MS;
    if (quiet || stale) return allocate(desired);
    return targets;
  }

  /** Rough VRAM footprint of everything allocated, for the ?dev=1 panel. */
  function memoryEstimateBytes() {
    let total = 0;
    const bytesPerPixel = (format) => {
      switch (format) {
        case 'RGBA16F': return 8;
        case 'RGBA8': return 4;
        case 'RG16F': return 4;
        case 'R16F': return 2;
        case 'R8': return 1;
        case 'DEPTH24': return 4;
        default: return 4;
      }
    };
    const count = (w, h, format, levels = 1) => {
      let px = 0;
      for (let i = 0; i < levels; i++) px += Math.max(1, w >> i) * Math.max(1, h >> i);
      total += px * bytesPerPixel(format);
    };
    if (targets.cookie) count(C.COOKIE_SIZE, C.COOKIE_SIZE, formats.cookie, C.COOKIE_LEVELS);
    if (targets.shadow) count(C.SHADOW_SIZE, C.SHADOW_SIZE, formats.scalar);
    if (applied) {
      count(targets.seaWidth, targets.seaHeight, formats.hdr);
      count(targets.seaWidth, targets.seaHeight, formats.depth);
      count(targets.width, targets.height, formats.hdr);
      // A multisampled renderbuffer costs one full surface per sample.
      if (targets.finalMS) total += targets.width * targets.height *
        bytesPerPixel(formats.hdr) * (applied.msaa || 1);
      if (targets.rays) {
        count(targets.halfWidth, targets.halfHeight, formats.hdr);
        count(targets.halfWidth, targets.halfHeight, formats.hdr);
      }
      if (targets.thick) {
        count(targets.thickWidth, targets.thickHeight, formats.scalar);
        count(targets.thickWidth, targets.thickHeight, formats.depth);
        count(targets.thickWidth, targets.thickHeight, formats.dual);
      }
      for (const level of targets.bloom) {
        count(level.width, level.height, formats.hdr);
        if (level.up) count(level.width, level.height, formats.hdr);
      }
    }
    return total;
  }

  function describe() {
    return {
      formats,
      allocationCount: targets.allocationCount,
      needsPrime: targets.needsPrime,
      scene: [targets.width, targets.height],
      sea: [targets.seaWidth, targets.seaHeight],
      thick: targets.thick ? [targets.thickWidth, targets.thickHeight] : null,
      rays: targets.rays ? [targets.halfWidth, targets.halfHeight] : null,
      msaa: applied ? applied.msaa : 0,
      bloomLevels: targets.bloom.length,
      megabytes: memoryEstimateBytes() / (1024 * 1024)
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    sized.disposeAll();
    permanent.disposeAll();
    applied = null;
    desired = null;
    appliedSig = null;
    seenSig = null;
    dirtySinceMs = 0;
    targets.sea = targets.seaDepth = targets.seaTarget = null;
    targets.final = targets.finalTarget = targets.finalMS = targets.finalMSTarget = null;
    targets.rays = null;
    targets.zfront = targets.zfrontTarget = null;
    targets.thick = targets.thickTarget = null;
    targets.cookie = targets.cookieTarget = null;
    targets.shadow = targets.shadowTarget = null;
    targets.expo = null;
    targets.bloom = [];
  }

  allocatePermanent();
  prime();

  targets.configure = configure;
  targets.update = update;
  /** Allocate a pending configuration immediately, ignoring the debounce.
      Used after a context restore, where waiting 250 ms buys nothing. */
  targets.forceUpdate = function forceUpdate() {
    if (disposed || !desired) return targets;
    if (appliedSig === signature(desired)) return targets;
    return allocate(desired);
  };
  targets.prime = prime;
  /** Call after clearing EXPO and RAYS yourself, when no state cache was given. */
  targets.markPrimed = function markPrimed() { targets.needsPrime = false; return targets; };
  targets.memoryEstimateBytes = memoryEstimateBytes;
  targets.describe = describe;
  targets.dispose = dispose;

  return targets;
}
