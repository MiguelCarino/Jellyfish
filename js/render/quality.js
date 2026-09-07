/* ============================================================
   render/quality.js — spec §7, the performance ladder.
   ------------------------------------------------------------
   Target is 8 ms of GPU time, not 16. A page that is left open
   for fifteen hours must not run the fans; fan noise is a
   relaxation constraint, so the ladder aims at half the frame
   budget and spends the rest on silence.

   THE CONTROLLER MUST BE INVISIBLE. §10 requires that forcing
   tier 1 -> 4 -> 1 while watching produces no brightness step
   and no popping element. Two things make that achievable and
   both of them are structural rather than a matter of care:

     * The shaft march uses Hillaire closed-form segment
       integration, so 16 -> 8 steps changes sharpness and not
       brightness.
     * fbm and the bloom filters are amplitude-normalised, so
       cutting octaves or bloom levels changes detail and not
       brightness.

   The ladder is therefore allowed to touch only these knobs:
   shaft steps, bloom levels, far-snow count, bell LOD, THICK
   divisor, guard-band overscan, cookie cadence and render
   scale. It is NEVER allowed to touch the tentacle count, which
   is fixed at 40 in every tier forever. Half the tentacles
   vanishing is not a graceful degrade, it is an event. Near and
   mid snow, the pulse, the caustic amplitude, the dither and the
   vignette are likewise off limits.

   MEASUREMENT is asymmetric by browser. Chrome exposes
   EXT_disjoint_timer_query_webgl2 and gives real GPU
   milliseconds. Safari and Firefox do not, so there the
   controller counts dropped frames instead: it cannot see a
   3 ms frame differ from a 12 ms one behind vsync, only whether
   frames are being missed, so it reacts correctly but more
   slowly and its thresholds are tuned for that.

   HYSTERESIS is deliberately asymmetric — quick to protect the
   frame rate, slow to spend it again — and after three
   transitions in five minutes the TIER latches for the session.
   A controller that keeps hunting is more distracting than the
   quality it is hunting for. The latch pins the tier and nothing
   else: the 30 Hz clamp below still engages and still releases,
   because falling 1 -> 2 -> 3 -> 4 under sustained load is
   already three transitions, so latching the whole controller
   there would put the frame-rate floor out of reach on exactly
   the machines it exists for.

   BELOW TIER 4 WE DO NOT KEEP DEGRADING. We clamp to 30 Hz and
   hold. A rock-steady 30 fps on a scene whose fastest motion is
   a 2.2 s bell pulse is calmer and more convincing than a
   jittery 44, and it halves the GPU load in one step.
   ============================================================ */

import { clamp, smoothstep, lerp } from '../math.js';

/**
 * The §7 tier table, verbatim, plus the derived flags each row implies. Tier 1
 * is the best; the numbers only go up as quality goes down, which reads
 * backwards until you think of it as a rung count.
 *
 *   budgetPx        absolute scene pixel budget, decoupled from display size
 *   shaftSteps      march steps; brightness-invariant by construction
 *   raysBuffer      false at tier 4 -- shafts are computed inline in the sea
 *                   pass and RAYS_A/B are never allocated
 *   bloomLevels     dual-filter chain depth (the composite divides its weight
 *                   by this, so the change is width and not energy)
 *   farSnow         the ONLY snow stratum the ladder may cut
 *   bellLOD         a key into profile.js's TESSELLATION; switching is a
 *                   bindVertexArray, never a rebuild
 *   thickDivisor    scene-size divisor for ZFRONT/THICK; 0 means the analytic
 *                   slab path runs and neither buffer is allocated
 *   overscan        SEA guard band for the refraction taps near the frame edge
 *   cookieInterval  frames between caustic gobo regenerations
 *   retardedStrands the stateless retarded-time sway instead of verlet
 */
export const QUALITY_TIERS = Object.freeze([
  Object.freeze({
    tier: 1,
    budgetPx: 2.60e6,
    shaftSteps: 16,
    raysBuffer: true,
    bloomLevels: 5,
    farSnow: 900,
    bellLOD: 'LOD0',
    thickDivisor: 2,
    overscan: 0.08,
    cookieInterval: 1,
    retardedStrands: false,
    note: '1080p -> RS 1.12, mild supersampling'
  }),
  Object.freeze({
    tier: 2,
    budgetPx: 1.80e6,
    shaftSteps: 12,
    raysBuffer: true,
    bloomLevels: 4,
    farSnow: 450,
    bellLOD: 'LOD0',
    thickDivisor: 2,
    overscan: 0.08,
    cookieInterval: 1,
    retardedStrands: false,
    note: ''
  }),
  Object.freeze({
    tier: 3,
    budgetPx: 1.15e6,
    shaftSteps: 8,
    raysBuffer: true,
    bloomLevels: 3,
    farSnow: 200,
    bellLOD: 'LOD1',
    thickDivisor: 3,
    overscan: 0.0,
    cookieInterval: 2,
    retardedStrands: false,
    note: 'cookie every other frame'
  }),
  Object.freeze({
    tier: 4,
    budgetPx: 0.75e6,
    shaftSteps: 8,
    raysBuffer: false,
    bloomLevels: 2,
    farSnow: 0,
    bellLOD: 'LOD1',
    thickDivisor: 0,
    overscan: 0.0,
    cookieInterval: 2,
    retardedStrands: true,
    note: 'shafts inline, analytic thickness, retarded-time strands'
  })
]);

/** Everything the ladder is forbidden to touch, kept here so it is legible. */
export const QUALITY_INVARIANTS = Object.freeze({
  /** 40 strands in every tier, forever. This is what makes the ladder invisible. */
  tentacleCount: 40,
  nearSnow: 60,
  midSnow: 420
});

export const QUALITY_CONSTANTS = Object.freeze({
  /** Rolling window. A median, never a mean: one GC spike must not downgrade. */
  MEDIAN_WINDOW: 45,
  /** GPU-timer mode, spec §7. */
  DOWN_MS: 17.5,
  UP_MS: 10.5,
  DOWN_FRAMES: 30,
  UP_FRAMES: 240,
  /** Dropped-frame mode. A vsynced frame time cannot tell 3 ms from 12 ms, so
      the up condition is "nothing was missed for a long time" rather than a
      threshold, and both counters are lengthened to compensate. */
  DROPPED_FRAME_MS: 20.0,
  DROPPED_RATE_DOWN: 0.20,
  DROPPED_WINDOW: 90,
  DROPPED_UP_FRAMES: 300,
  /** Ignore measurements for this long after a transition: the workload just
      changed and the window is still full of the old one. */
  SETTLE_SECONDS: 0.75,
  /** renderScale eases rather than steps; targets.js quantises and debounces it
      into at most a few reallocations over the ease. */
  RENDER_SCALE_EASE_SECONDS: 0.75,
  /** Below this a scene render is mush, however tight the pixel budget. */
  RENDER_SCALE_MIN: 0.25,
  /** Transition latch, §7. */
  LATCH_TRANSITIONS: 3,
  LATCH_WINDOW_SECONDS: 300,
  /** The 30 Hz cadence clamp at the floor, instead of degrading further. */
  HALF_RATE_HZ: 30,
  /** Slack so a 30 Hz gate does not skip a frame it should have rendered when
      rAF arrives a hair early. */
  HALF_RATE_EPSILON: 0.002
});

/**
 * The §7 render-scale formula. `cssW`/`cssH` are CSS pixels; the backing store
 * of every scene buffer is `css * RS`, so RS plays the role devicePixelRatio
 * would in a naive renderer — which is the entire point of an absolute pixel
 * budget. A 4K display does not get four times the work, it gets the same work
 * and a gentler upscale.
 */
export function computeRenderScale(budgetPx, cssW, cssH, dprCap = 2) {
  const area = Math.max(1, cssW * cssH);
  const ideal = Math.sqrt(budgetPx / area);
  return clamp(ideal, QUALITY_CONSTANTS.RENDER_SCALE_MIN, dprCap);
}

/**
 * The tier a device should boot at, before any measurement exists. iOS starts
 * at 3 and settles within about two seconds; a device with no float colour
 * targets at all can only run the four-pass analytic path, which is tier 4.
 */
export function initialTierFor(caps) {
  if (!caps) return 1;
  if (!caps.floatTargets) return 4;
  if (caps.platform && caps.platform.isIOS) return 3;
  return 1;
}

/* A small fixed-capacity ring with a median. 45 entries, so a full sort per
   evaluation is a few hundred operations — cheaper than maintaining an ordered
   structure and far easier to be sure of. */
function createWindow(capacity) {
  const values = new Float64Array(capacity);
  const scratch = new Float64Array(capacity);
  let count = 0;
  let head = 0;
  return {
    get count() { return count; },
    get full() { return count >= capacity; },
    push(v) {
      values[head] = v;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
    },
    clear() { count = 0; head = 0; },
    median() {
      if (count === 0) return 0;
      for (let i = 0; i < count; i++) scratch[i] = values[i];
      const view = scratch.subarray(0, count);
      view.sort();
      const mid = count >> 1;
      return (count & 1) ? view[mid] : 0.5 * (view[mid - 1] + view[mid]);
    },
    /** Fraction of the window strictly above `threshold`. */
    rateAbove(threshold) {
      if (count === 0) return 0;
      let n = 0;
      for (let i = 0; i < count; i++) if (values[i] > threshold) n++;
      return n / count;
    }
  };
}

/**
 * Builds the quality controller.
 *
 * @param {object} options
 * @param {object} options.caps        the gl.js capability probe
 * @param {object|null} options.timer  a gl.js GPU timer, or null for the
 *                                     dropped-frame fallback
 * @param {number} options.cssWidth
 * @param {number} options.cssHeight
 * @param {number|null} options.startTier  overrides initialTierFor()
 * @param {number|null} options.forceTier  pins the tier and disables the
 *                                         controller entirely (?tier=N, and the
 *                                         §10 forced 1->4->1 check)
 * @param {function|null} options.onTierChange  (newTier, oldTier, settings)
 */
export function createQualityController(options = {}) {
  const {
    caps = null,
    timer = null,
    cssWidth = 1,
    cssHeight = 1,
    startTier = null,
    forceTier = null,
    onTierChange = null
  } = options;

  const C = QUALITY_CONSTANTS;
  const dprCap = caps && caps.dprCap ? caps.dprCap : 2;

  // No float colour targets means the analytic four-pass path is the only path
  // that exists, so the ladder has exactly one rung and nothing to climb.
  const floatPath = !caps || caps.floatTargets !== false;
  const bestTier = floatPath ? 1 : 4;
  const worstTier = 4;

  const gpuMode = !!(timer && timer.available);

  // Mutable, because setForcedTier() has to be able to hand control back to the
  // ladder; the destructured `forceTier` is only the initial pin.
  let forcedTier = (forceTier === null || forceTier === undefined) ? null : (forceTier | 0);

  let tier = clamp(
    forcedTier !== null ? forcedTier : (startTier !== null ? startTier : initialTierFor(caps)),
    bestTier, worstTier
  ) | 0;

  let cssW = cssWidth;
  let cssH = cssHeight;

  const samples = createWindow(C.MEDIAN_WINDOW);
  const frameTimes = createWindow(C.DROPPED_WINDOW);

  let downCount = 0;
  let upCount = 0;
  let settleTimer = 0;
  let latched = false;
  let halfRate = false;
  let transitions = [];
  let elapsed = 0;

  // renderScale eases over 0.75 s rather than stepping. targets.js rounds the
  // eased value to whole pixels and debounces its reallocation, so the ease
  // costs a small handful of allocations and reads as a soft focus pull rather
  // than a resolution snap.
  let renderScaleFrom = computeRenderScale(QUALITY_TIERS[tier - 1].budgetPx, cssW, cssH, dprCap);
  let renderScaleTo = renderScaleFrom;
  let renderScale = renderScaleFrom;
  let easeTime = C.RENDER_SCALE_EASE_SECONDS;

  // 30 Hz gate. Time-based rather than "every other rAF", because on a 120 Hz
  // display every other rAF is 60 fps and the clamp would do nothing.
  let sinceRender = Infinity;

  const settings = {
    tier,
    shaftSteps: 0,
    raysBuffer: true,
    bloomLevels: 5,
    farSnow: 0,
    bellLOD: 'LOD0',
    thickDivisor: 2,
    analyticThickness: false,
    overscan: 0,
    cookieInterval: 1,
    retardedStrands: false,
    renderScale: renderScale,
    renderScaleTarget: renderScaleTo,
    renderScaleSettling: false,
    tentacleCount: QUALITY_INVARIANTS.tentacleCount,
    nearSnow: QUALITY_INVARIANTS.nearSnow,
    midSnow: QUALITY_INVARIANTS.midSnow,
    halfRate: false
  };

  function writeSettings() {
    const row = QUALITY_TIERS[tier - 1];
    settings.tier = row.tier;
    settings.shaftSteps = row.shaftSteps;
    settings.raysBuffer = row.raysBuffer && floatPath;
    settings.bloomLevels = row.bloomLevels;
    settings.farSnow = row.farSnow;
    settings.bellLOD = row.bellLOD;
    // The analytic slab path is forced whenever THICK cannot exist, whether
    // that is the tier's choice or the device's.
    const analytic = row.thickDivisor === 0 || !floatPath;
    settings.analyticThickness = analytic;
    settings.thickDivisor = analytic ? 0 : row.thickDivisor;
    settings.overscan = row.overscan;
    settings.cookieInterval = row.cookieInterval;
    settings.retardedStrands = row.retardedStrands;
    settings.renderScale = renderScale;
    settings.renderScaleTarget = renderScaleTo;
    settings.renderScaleSettling = easeTime < C.RENDER_SCALE_EASE_SECONDS;
    settings.halfRate = halfRate;
    return settings;
  }

  function retargetRenderScale(snap) {
    const want = computeRenderScale(QUALITY_TIERS[tier - 1].budgetPx, cssW, cssH, dprCap);
    if (Math.abs(want - renderScaleTo) < 1e-4 && !snap) return;
    renderScaleTo = want;
    if (snap) {
      renderScaleFrom = want;
      renderScale = want;
      easeTime = C.RENDER_SCALE_EASE_SECONDS;
    } else {
      renderScaleFrom = renderScale;
      easeTime = 0;
    }
  }

  function noteTransition() {
    transitions.push(elapsed);
    const cutoff = elapsed - C.LATCH_WINDOW_SECONDS;
    transitions = transitions.filter((t) => t >= cutoff);
    if (transitions.length >= C.LATCH_TRANSITIONS) {
      // Latch to the worse of everything we have been recently: the machine has
      // shown it cannot hold the better rung, and hunting is worse than either.
      latched = true;
    }
  }

  function setTier(next, { silent = false } = {}) {
    const clamped = clamp(next | 0, bestTier, worstTier) | 0;
    if (clamped === tier) return false;
    const previous = tier;
    tier = clamped;
    downCount = 0;
    upCount = 0;
    // The measurement window is full of the previous workload; keeping it would
    // make the controller immediately re-evaluate on stale evidence. The timer's
    // own queue holds two or three frames of it as well, so that goes too.
    samples.clear();
    frameTimes.clear();
    if (timer && typeof timer.reset === 'function') timer.reset();
    settleTimer = C.SETTLE_SECONDS;
    retargetRenderScale(false);
    writeSettings();
    if (!silent) {
      noteTransition();
      if (typeof onTierChange === 'function') onTierChange(tier, previous, settings);
    }
    return true;
  }

  function evaluateGpu() {
    if (!samples.full) return;
    const median = samples.median();
    if (median > C.DOWN_MS) { downCount++; upCount = 0; }
    else if (median < C.UP_MS) { upCount++; downCount = 0; }
    else { downCount = 0; upCount = 0; }

    if (downCount >= C.DOWN_FRAMES) {
      downCount = 0;
      if (!latched && tier < worstTier) setTier(tier + 1);
      else if (!halfRate) { halfRate = true; noteTransition(); writeSettings(); }
    } else if (upCount >= C.UP_FRAMES) {
      upCount = 0;
      // Give the frame rate back before the pixels: 30 -> 60 Hz is the change a
      // viewer is most likely to appreciate and the least likely to notice.
      if (halfRate) { halfRate = false; writeSettings(); }
      else if (!latched && tier > bestTier) setTier(tier - 1);
    }
  }

  function evaluateDropped() {
    if (!frameTimes.full) return;
    const rate = frameTimes.rateAbove(C.DROPPED_FRAME_MS);
    if (rate > C.DROPPED_RATE_DOWN) {
      downCount++;
      upCount = 0;
    } else if (rate === 0) {
      upCount++;
      downCount = 0;
    } else {
      // Some misses but not many: hold. Neither counter advances, so a scene
      // that sits just under the threshold never oscillates.
      downCount = 0;
      upCount = 0;
    }

    if (downCount >= C.DOWN_FRAMES) {
      downCount = 0;
      frameTimes.clear();
      if (!latched && tier < worstTier) setTier(tier + 1);
      else if (!halfRate) { halfRate = true; noteTransition(); writeSettings(); }
    } else if (upCount >= C.DROPPED_UP_FRAMES) {
      upCount = 0;
      if (halfRate) { halfRate = false; writeSettings(); }
      else if (!latched && tier > bestTier) setTier(tier - 1);
    }
  }

  retargetRenderScale(true);
  writeSettings();

  const controller = {
    /** Live settings. The same object every frame — read it, do not keep a copy. */
    settings,
    get tier() { return tier; },
    get latched() { return latched; },
    get halfRate() { return halfRate; },
    get renderScale() { return renderScale; },
    /** 'gpu' when a timer query is available, 'dropped-frames' otherwise. */
    get mode() { return gpuMode ? 'gpu' : 'dropped-frames'; },
    get forcedTier() { return forcedTier; },

    /** Wrap the frame's GPU work so the timer query brackets exactly it. */
    frameBegin() { if (timer) timer.begin(); },
    frameEnd() { if (timer) timer.end(); },

    /**
     * The 30 Hz cadence clamp. main.js calls this once per rAF and skips the
     * whole frame when it returns false; `dt` still accumulates, so the sim is
     * unaffected by the cadence.
     */
    shouldRender(dt) {
      const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
      sinceRender = Number.isFinite(sinceRender) ? sinceRender + step : step;
      if (!halfRate) { sinceRender = 0; return true; }
      if (sinceRender + C.HALF_RATE_EPSILON >= 1 / C.HALF_RATE_HZ) {
        sinceRender = 0;
        return true;
      }
      return false;
    },

    /**
     * One controller step. Call once per rendered frame, after frameEnd().
     * `dt` is the wall-clock frame time in seconds.
     */
    update(dt) {
      const step = Number.isFinite(dt) ? clamp(dt, 0, 0.5) : 0;
      elapsed += step;

      // Ease the render scale whether or not the controller is running, so a
      // resize during a forced tier still lands smoothly.
      if (easeTime < C.RENDER_SCALE_EASE_SECONDS) {
        easeTime = Math.min(C.RENDER_SCALE_EASE_SECONDS, easeTime + step);
        const t = smoothstep(0, C.RENDER_SCALE_EASE_SECONDS, easeTime);
        renderScale = lerp(renderScaleFrom, renderScaleTo, t);
      }

      // Drain every result the driver has finished with, ALWAYS -- a timer query
      // lands two or three frames late, and leaving the backlog in place would
      // both halve the controller's sample rate and, worse, feed measurements of
      // the previous tier's workload into the window after a transition. During
      // the settle window the results are drained and thrown away.
      if (gpuMode) {
        const settling = settleTimer > 0;
        for (let i = 0; i < 8; i++) {
          const ms = timer.poll();
          if (ms === null || ms === undefined) break;
          if (!settling) samples.push(ms);
        }
      }

      // A PINNED tier stops the controller dead: ?tier=N is a debugging tool and
      // it would be useless if the ladder were still moving underneath it.
      // A LATCHED tier does not. The latch exists to stop the TIER hunting —
      // §7's "after 3 transitions in 5 minutes, latch to the lower tier for the
      // session" — and going 1 -> 2 -> 3 -> 4 under sustained load is already
      // three transitions, so any machine that genuinely cannot keep up latches
      // at tier 4 within about fifteen seconds. Stopping here would therefore
      // make §7's other floor rule, "below tier 4 we do not keep degrading, we
      // clamp to 30 Hz and hold", unreachable on precisely the machines it was
      // written for. So the evaluation continues; `latched` only forbids a tier
      // change, and the half-rate clamp and its release still run.
      if (forcedTier !== null) return writeSettings();

      if (settleTimer > 0) {
        settleTimer -= step;
        return writeSettings();
      }

      if (gpuMode) {
        evaluateGpu();
      } else {
        frameTimes.push(step * 1000);
        evaluateDropped();
      }

      return writeSettings();
    },

    /** CSS size changed. The render scale snaps here — a resize is already a
        reallocation, so easing it would only add allocations. */
    resize(nextCssWidth, nextCssHeight) {
      if (!nextCssWidth || !nextCssHeight) return writeSettings();
      if (nextCssWidth === cssW && nextCssHeight === cssH) return writeSettings();
      cssW = nextCssWidth;
      cssH = nextCssHeight;
      retargetRenderScale(true);
      return writeSettings();
    },

    /** Jump straight to a tier without counting it as a controller transition.
        This is how ?tier=N and the §10 forced 1->4->1 check work. */
    setTier(next) {
      setTier(next, { silent: true });
      renderScaleFrom = renderScale;
      easeTime = 0;
      return writeSettings();
    },

    /** Pin or unpin the tier. Passing null hands control back to the ladder. */
    setForcedTier(next) {
      forcedTier = (next === null || next === undefined) ? null : (next | 0);
      if (forcedTier !== null) controller.setTier(forcedTier);
      return writeSettings();
    },

    /** After a context restore the old measurements describe a dead GPU. */
    reset() {
      samples.clear();
      frameTimes.clear();
      downCount = 0;
      upCount = 0;
      settleTimer = C.SETTLE_SECONDS;
      sinceRender = Infinity;
      if (timer) timer.reset();
      return writeSettings();
    },

    /** For the ?dev=1 panel. Allocates, so do not call it every frame. */
    stats() {
      return {
        mode: controller.mode,
        tier,
        latched,
        halfRate,
        transitions: transitions.length,
        medianMs: gpuMode ? samples.median() : 0,
        droppedRate: gpuMode ? 0 : frameTimes.rateAbove(C.DROPPED_FRAME_MS),
        samples: gpuMode ? samples.count : frameTimes.count,
        downCount,
        upCount,
        renderScale,
        renderScaleTarget: renderScaleTo,
        cssWidth: cssW,
        cssHeight: cssH
      };
    }
  };

  return controller;
}
