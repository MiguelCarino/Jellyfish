/* ============================================================
   main.js — boot, the clock, and the lifecycle.
   ------------------------------------------------------------
   This file owns everything that is not a pixel: the capability
   probe, the fade-up, the fixed-step accumulator, the rAF loop,
   the ResizeObserver, visibility gating, context loss and
   restore, prefers-reduced-motion, the no-WebGL2 poster frame
   and destroy(). render/frame.js owns the GPU; the sim modules
   own the animal. Nothing here touches a WebGL enum and nothing
   here touches a framebuffer.

   THE ORDER OF A FRAME IS NOT NEGOTIABLE, and it is the one
   thing in this file worth reading twice:

     swim.step(dt)                     the pulse, the thrust, the pose
     rebase                            floating origin: shift EVERYTHING
     flow.step(dt, swim)               the jet and the shed rings
     strands.updateRoots(pose)         the margin the tentacles hang from
     guides.step / arms.step(dt, flow) the verlet substeps
     camera.step(dt, swim.position, swim.velocity)  the loose look-at
     snow.step(dt, camera.position)    advected by the same flow

   `updateRoots` BEFORE the substeps because the margin moves
   about three centimetres on a stroke and a root that lags by one
   frame shows as the fringe swimming inside the animal. The
   camera AFTER the body because it springs towards where the
   animal now is. The snow last because it is advected by the flow
   the contraction just changed and sorted against the camera that
   just moved.

   WHY THE CLOCK IS NOT JUST `dt`. §4.1's period wanders, jitters
   on an Ornstein-Uhlenbeck process and occasionally skips or
   doubles a beat, so `uTime * uFreq` teleports the phase the
   moment the frequency changes. sim/swim.js integrates the phase
   instead and this file hands `swim.phase` to the shaders as
   `uPhase`; the only thing still measured in seconds is the lazy
   twist, which has no such structure.

   A HIDDEN TAB BURNS NOTHING. `document.hidden` cancels the
   pending frame outright — not a slower loop, no work at all —
   and §10 asks for thirty minutes of that followed by a resume at
   the correct pose. Two things make that safe. The wall-clock dt
   on the resume frame is clamped to MAX_FRAME_DT, so the
   integrator never sees the nine-hour step that would fling the
   animal out of the world; and the shaft history, which is a
   feedback buffer, is invalidated, so the first visible frame is
   marched fresh rather than blended against a half-hour-old
   image. The pose itself is preserved exactly because nothing was
   stepped while the tab slept: the animal is where it was, not
   where it would have been.
   ============================================================ */

import {
  createContext,
  probeCapabilities,
  addContextLossHandlers,
  createGpuTimer
} from './gl.js';
import { createFrameGraph } from './render/frame.js';
import { COOKIE_TIME_SCALE_REDUCED } from './shaders/cookie.js';
import { createQualityController } from './render/quality.js';
import { Camera } from './camera.js';
import { Swim, SCENE_DEPTH_ORIGIN } from './sim/swim.js';
import { FlowField } from './sim/flow.js';
import { ChainSystem, RetardedChainSystem, VERLET_CONSTANTS } from './sim/verlet.js';
import { SnowField } from './sim/snow.js';
import { DEFORM } from './sim/deform.js';
import { createBakedImperfection, createBellGeometry } from './geometry/bell.js';
import {
  createStrandSystem,
  GUIDE_COUNT,
  TENTACLE_NODES,
  TENTACLE_HALF_WIDTH,
  ARM_COUNT,
  ARM_NODES
} from './geometry/strands.js';
import { BELL_RADIUS } from './geometry/profile.js';

/* --- Constants ---------------------------------------------------------- */

/**
 * §7's resume clamp. A tab that has been hidden for nine hours produces a
 * `dt` of nine hours on its first rAF, and every integrator downstream would
 * take one enormous step. A thirtieth of a second is the largest step the
 * verlet chains and the swim thrust are tuned for.
 */
const MAX_FRAME_DT = 1 / 30;

/**
 * The oral arms are thicker than a tentacle and hang from a wider root, so they
 * get their own radius and a stiffer bend ramp. Measured over five minutes,
 * 2.5 mm puts the arms at a median 13° from vertical against the tentacles'
 * 21°, which is the relationship a photograph shows.
 */
const ARM_RADIUS = 0.0025;
const ARM_STIFFNESS = 1.4;

/** §4.6: the snow keeps drifting under reduced motion, at a fifth of its speed. */
const REDUCED_SNOW_RATE = 0.20;

/**
 * §4.6 keeps each identity and drops the loop, so every one of these clocks is
 * integrated at a REDUCED RATE rather than having absolute time rescaled at the
 * point of use. On a page that has been open for an hour the difference is the
 * whole point: rescaling t would jump the caustics by fifty minutes the instant
 * the operating system's switch is thrown, which is the opposite of calm.
 */
const REDUCED_CAUSTIC_RATE = COOKIE_TIME_SCALE_REDUCED;

/** The one class hook css/jellyfish.css defines. It fades the canvas up over 1.2 s. */
const READY_CLASS = 'ready';

/* --- The poster frame --------------------------------------------------- */

/**
 * §7 probe step 1, and §10's "no WebGL2 at all: the poster frame renders, the
 * page does not error". One still image and one line of text, on the page's own
 * ground, with no retry button and no diagnostic: a browser without WebGL2 will
 * not grow it while the visitor is looking at the page.
 *
 * It is styled inline rather than from the stylesheet because it is the only
 * DOM this renderer ever creates and a class in a 55-line stylesheet that
 * exists for one failure path is a class nobody will recognise later. It sits
 * at z-index 2 so it is above #sea::before, the 28 px navbar seam strip.
 */
function showPoster(host, message) {
  const poster = document.createElement('div');
  poster.setAttribute('role', 'img');
  poster.setAttribute('aria-label', 'Jellyfish');
  poster.style.cssText = [
    'position:absolute', 'inset:0', 'z-index:2',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:1.25rem',
    'background:var(--bg,#050505)', 'color:var(--text-sec,#a3a3a3)',
    'font:14px var(--sans,system-ui,sans-serif)', 'text-align:center',
    'padding:2rem'
  ].join(';');

  const logo = document.createElement('img');
  logo.src = 'logo.svg';
  logo.alt = '';
  logo.width = 96;
  logo.height = 96;
  logo.style.cssText = 'width:96px;height:96px;opacity:0.85';

  const line = document.createElement('p');
  line.textContent = message;
  line.style.cssText = 'margin:0;max-width:32ch;line-height:1.6';

  poster.append(logo, line);
  host.appendChild(poster);
  return poster;
}

/* --- The renderer ------------------------------------------------------- */

/**
 * Boots the page against an existing host element and canvas. Returns a handle
 * with `destroy()`, per the fleet's widget contract, or a handle whose
 * `destroy()` merely removes the poster when WebGL2 is unavailable.
 */
export function createJellyfish(options = {}) {
  const {
    host = document.getElementById('sea'),
    canvas = document.getElementById('gl'),
    seed = 'aurelia',
    forcedTier = null,
    dev = false
  } = options;

  if (!host || !canvas) return { destroy() {} };

  /* ---- capability probe, §7 step 1 ---------------------------------- */

  const gl = createContext(canvas);
  if (!gl) {
    const poster = showPoster(host,
      'This page needs WebGL2, which this browser does not have.');
    return {
      gl: null,
      destroy() { poster.remove(); }
    };
  }

  /*
   * Re-probed on every context rebuild rather than captured once: the extension
   * objects a probe returns belong to the context that returned them, and a
   * restored context is a different context. The numbers inside them survive,
   * so nothing would visibly break — which is exactly why it is worth being
   * explicit about instead of relying on.
   */
  let caps = probeCapabilities(gl);

  /*
   * §7 probe step 3. MSAA is requested only when the driver actually reports
   * four samples on RGBA16F; everything soft in the frame is analytically
   * antialiased, so when it is not available the composite's FXAA runs and
   * nothing else in the graph changes. render/frame.js applies the same test
   * again and publishes the answer both it and targets.js use.
   */
  let msaaSamples = (caps.maxSamplesRGBA16F | 0) >= 4 ? 4 : 0;

  /* ---- the animal, which survives a context loss --------------------- */

  /*
   * §3.5's baked imperfection is generated once from a seeded stream and held
   * here rather than inside the geometry, because a context restore rebuilds
   * every buffer and the animal has to come back as the SAME animal — the same
   * torn lappet, the same lopsided gonads, the same asymmetric muscle. Handing
   * the rebuilt mesh this object rather than a seed is what guarantees it.
   */
  const imperfection = createBakedImperfection();

  const swim = new Swim({ seed: `${seed}-swim` });
  const flow = new FlowField();
  const camera = new Camera({
    seed: `${seed}-camera`,
    aspect: 16 / 9,
    depthOrigin: SCENE_DEPTH_ORIGIN,
    strictElevation: dev
  });
  const snow = new SnowField({ seed: `${seed}-snow`, cameraPosition: camera.position });

  /* Built with the GPU below, because they need the strand descriptors. */
  let bell = null;
  let strands = null;
  let guides = null;
  let arms = null;
  let retardedArms = null;

  /* ---- GPU state, which does not ------------------------------------- */

  let graph = null;
  let timer = null;
  let quality = null;

  /* ---- the clock ----------------------------------------------------- */

  let running = false;
  let rafId = 0;
  let lastMs = 0;
  let simTime = 0;
  let causticTime = 0;
  let twistTime = 0;
  let frameIndex = 0;
  let pendingDt = 0;
  let faded = false;
  let contextLost = false;
  let destroyed = false;
  let reportedMissing = false;

  let cssWidth = 0;
  let cssHeight = 0;

  /* Scratch for the per-strand sort, which wants plain indexables. */
  const sortCamera = new Float32Array(3);
  const sortForward = new Float32Array(3);
  const sortCentre = new Float32Array(3);

  /*
   * geometry/strands.js reads the bell axis by numeric index, the same way it
   * reads every other flat vector it is handed, so the Vec3 has to be unpacked
   * before it crosses that boundary.
   */
  const sortAxis = new Float32Array(3);

  /* §4.6, live: the media query can change while the page is open. */
  const motionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  let reducedMotion = !!(motionQuery && motionQuery.matches);

  const view = {
    camera, swim, snow, bell: null, strands: null,
    settings: null,
    dt: 0, time: 0, causticTime: 0, frame: 0,
    phase: 0, amplitude: DEFORM.AMPLITUDE, twistTime: 0,
    depthOrigin: SCENE_DEPTH_ORIGIN,
    outputWidth: 1, outputHeight: 1
  };

  /* --- Building and tearing down the GPU side -------------------------- */

  function buildGpu() {
    graph = createFrameGraph(gl, { caps, msaaSamples });
    timer = createGpuTimer(gl, caps);

    bell = createBellGeometry(gl, { imperfection, radius: BELL_RADIUS });
    strands = createStrandSystem(gl, {
      seed: `${seed}-strands`, radius: BELL_RADIUS, imperfection
    });

    /*
     * The two solvers, sized from the descriptors geometry/strands.js just
     * published. Twelve guide chains carry §3.4's verlet; the other twenty-eight
     * tentacles are barycentric between them, which is why the tentacle count is
     * fixed at forty in every tier and the solver cost is not.
     *
     * Built once and kept. None of the three holds a GL object — they are the
     * CPU-side sim state this file's context-loss handler promises survives a
     * restore, and where every tentacle node sits is the largest part of it.
     * Rebuilding them would re-lay the whole fringe straight down from the
     * roots and let it settle over about a second, which is the visible artefact
     * §10 forbids on a page that gets its GPU reset every time the Mac sleeps.
     * The segment lengths come from the same seeded strand table on every build,
     * so the solvers stay correctly sized for the geometry beside them.
     */
    const firstBuild = !guides;
    if (firstBuild) {
      guides = new ChainSystem({
        chainCount: GUIDE_COUNT,
        nodeCount: TENTACLE_NODES,
        segmentLengths: strands.guideSegmentLengths,
        radii: TENTACLE_HALF_WIDTH,
        seed: `${seed}-guides`
      });
      arms = new ChainSystem({
        chainCount: ARM_COUNT,
        nodeCount: ARM_NODES,
        segmentLengths: strands.armSegmentLengths,
        radii: ARM_RADIUS,
        stiffnessScale: ARM_STIFFNESS,
        seed: `${seed}-arms`
      });

      /*
       * §4.4's fallback, for tier 4 and for prefers-reduced-motion: retarded-time
       * sway is unconditionally stable, stateless and frame-rate independent, and
       * it cannot respond to a shed vortex ring, which is exactly the trade those
       * two cases accept. Built alongside the solver rather than instead of it so
       * a tier change is a branch and not an allocation.
       */
      retardedArms = new RetardedChainSystem({
        chainCount: ARM_COUNT,
        nodeCount: ARM_NODES,
        segmentLengths: strands.armSegmentLengths,
        amplitudeScale: VERLET_CONSTANTS.REDUCED_MOTION_AMPLITUDE,
        seed: `${seed}-arms-retarded`
      });
    }

    view.bell = bell;
    view.strands = strands;

    quality = createQualityController({
      caps,
      timer,
      cssWidth: cssWidth || host.clientWidth || 1,
      cssHeight: cssHeight || host.clientHeight || 1,
      forceTier: forcedTier
    });
    view.settings = quality.settings;

    // Lay the chains out from the rest pose before the first substep, so the
    // opening frame is an animal and not forty triangles fanning out of the
    // origin. On a rebuild the nodes are already mid-stroke where the sim left
    // them, and only need re-pinning to the roots of the regenerated bell.
    if (firstBuild) primeChains(); else syncRoots();
  }

  function destroyGpu() {
    if (strands) strands.dispose();
    if (bell) bell.dispose();
    if (graph) graph.dispose();
    if (timer) timer.dispose();
    strands = bell = graph = timer = null;
    view.bell = null;
    view.strands = null;
  }

  /** Re-pins every chain to the roots of the current relaxed bell. */
  function syncRoots() {
    strands.updateRoots({
      phase: swim.phase,
      amplitude: DEFORM.AMPLITUDE,
      twistTime,
      bodyMatrix: swim.modelMatrix
    });
    applyRoots();
  }

  /** Roots from the relaxed bell, chains hanging straight down from them. */
  function primeChains() {
    syncRoots();
    guides.reset();
    arms.reset();
    retardedArms.reset();
  }

  function applyRoots() {
    for (let i = 0; i < GUIDE_COUNT; i++) {
      const o = i * 3;
      guides.setRoot(i, strands.guideRoots[o], strands.guideRoots[o + 1], strands.guideRoots[o + 2]);
      guides.setHang(i,
        strands.guideRootDirections[o],
        strands.guideRootDirections[o + 1],
        strands.guideRootDirections[o + 2]);
    }
    for (let i = 0; i < ARM_COUNT; i++) {
      const o = i * 3;
      const x = strands.armRoots[o], y = strands.armRoots[o + 1], z = strands.armRoots[o + 2];
      const dx = strands.armRootDirections[o];
      const dy = strands.armRootDirections[o + 1];
      const dz = strands.armRootDirections[o + 2];
      arms.setRoot(i, x, y, z);
      arms.setHang(i, dx, dy, dz);
      retardedArms.setRoot(i, x, y, z);
      retardedArms.setHang(i, dx, dy, dz);
    }
  }

  /* --- The simulation step --------------------------------------------- */

  function simulate(dt) {
    simTime += dt;
    // The two clocks §4.6 slows. They are held rather than scaled, so toggling
    // reduce-motion pauses them where they are instead of jumping them.
    causticTime += dt * (reducedMotion ? REDUCED_CAUSTIC_RATE : 1);
    twistTime += reducedMotion ? 0 : dt;

    swim.step(dt);

    /*
     * §4.3's floating origin. When the animal has wandered half a metre from the
     * render origin, swim.js walks the whole world back under it and publishes
     * the delta. EVERY other position in scene space has to move with it or the
     * camera, the tentacles, the vortex rings and the marine snow all jump a
     * millimetre in the opposite direction on the same frame. This is the only
     * place that list exists, so anything added to the sim belongs in it.
     */
    if (swim.rebasedThisStep) {
      const d = swim.originShift;
      camera.translate(d.x, d.y, d.z);
      guides.translate(d.x, d.y, d.z);
      arms.translate(d.x, d.y, d.z);
      retardedArms.translate(d.x, d.y, d.z);
      flow.translate(d.x, d.y, d.z);
      snow.translate(d.x, d.y, d.z);
    }

    flow.setWorldOffset(swim.worldOffset.x, swim.worldOffset.y, swim.worldOffset.z);
    flow.step(dt, swim);

    // The roots come from the same deformBell() the vertex shader calls, so the
    // fringe cannot detach from the margin on a contraction stroke.
    strands.updateRoots({
      phase: swim.phase,
      amplitude: DEFORM.AMPLITUDE,
      twistTime,
      bodyMatrix: swim.modelMatrix
    });
    applyRoots();

    const retarded = reducedMotion || !!(quality.settings.retardedStrands);
    const swayScale = reducedMotion ? VERLET_CONSTANTS.REDUCED_MOTION_AMPLITUDE : 1;
    swim.bellAxis.toArray(sortAxis);

    if (retarded) {
      strands.packTentaclesAnalytic(simTime, sortAxis, swayScale);
      retardedArms.amplitudeScale = swayScale;
      retardedArms.step(dt);
      strands.packArms(retardedArms.positions, simTime);
    } else {
      guides.step(dt, flow);
      arms.step(dt, flow);
      strands.packTentacles(guides.positions, sortAxis);
      strands.packArms(arms.positions, simTime);
    }

    camera.step(dt, swim.position, swim.velocity);
    snow.step(reducedMotion ? dt * REDUCED_SNOW_RATE : dt, camera.position, flow);

    /*
     * §2.6's per-strand sort, on the CPU: forty chain centroids against the view
     * axis, split into the group behind the bell centre and the group in front.
     * The behind group draws into SEA and is composited THROUGH the animal by
     * the exumbrella; the front group draws into FINAL. Per-strand granularity
     * is invisible on an object with no silhouette, and it costs microseconds.
     */
    camera.position.toArray(sortCamera);
    camera.forward.toArray(sortForward);
    swim.position.toArray(sortCentre);
    strands.sortTentacles(sortCamera, sortForward, sortCentre);
    strands.sortArms(sortCamera, sortForward);
    strands.upload();
  }

  /* --- Sizing ----------------------------------------------------------- */

  /*
   * §7: the backing store is the CSS rect times the render scale, and the CSS
   * size is set by the stylesheet. The composite therefore draws one output
   * pixel per backing-store pixel and the browser's own filter does the single
   * remaining resample down to the CSS box — which is a downscale whenever the
   * pixel budget allows RS above 1, i.e. mild supersampling, and never the
   * bilinear upscale of a canvas left at CSS size.
   *
   * The backing store follows the TARGETS rather than the eased render scale
   * directly, so that a 0.75 s renderScale ease and a window drag both resize
   * the drawing buffer exactly as often as targets.js reallocates: at most
   * three times over a ten-second drag, per §10.
   */
  function syncBackingStore() {
    const t = graph.targets;
    if (!t.ready || !t.width || !t.height) return;
    if (canvas.width !== t.width || canvas.height !== t.height) {
      canvas.width = t.width;
      canvas.height = t.height;
      // Resizing the drawing buffer does not reset the GL viewport, but it does
      // reallocate the default framebuffer underneath a state cache that has no
      // way of knowing. Dropping the cache costs a handful of redundant state
      // calls on the one frame a resize lands, and buys never having to reason
      // about whether it was stale.
      graph.state.invalidate();
      graph.invalidateHistory();
    }
    view.outputWidth = canvas.width;
    view.outputHeight = canvas.height;
  }

  function measure() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    // The zero-size bail of §7's lifecycle rules: #sea is 0-height for one frame
    // before the navbar lands, and a collapsed host must not tear the targets
    // down and reallocate them a frame later.
    if (!w || !h) return false;
    if (w === cssWidth && h === cssHeight) return true;
    cssWidth = w;
    cssHeight = h;
    camera.setAspect(w / h);
    if (quality) quality.resize(w, h);
    if (graph) graph.invalidateHistory();
    return true;
  }

  /* --- The frame -------------------------------------------------------- */

  function frame(nowMs) {
    rafId = 0;
    if (!running || contextLost) return;

    const rawDt = lastMs ? (nowMs - lastMs) / 1000 : 1 / 60;
    lastMs = nowMs;
    // Clamped here rather than in each integrator: §10 hides the tab for thirty
    // minutes and this is the number that keeps the resume from exploding.
    const dt = Math.min(Math.max(rawDt, 0), MAX_FRAME_DT);

    schedule();

    if (!measure()) return;

    // §7's floor behaviour: below tier 4 we do not keep degrading, we clamp to
    // 30 Hz and hold. `dt` still accumulates across the skipped frames, so the
    // animal moves at the same speed either way.
    pendingDt += dt;
    if (!quality.shouldRender(dt)) return;
    const stepDt = pendingDt;
    pendingDt = 0;

    // Programs link asynchronously behind the fade where the extension exists.
    // Until every one of them is resolved there is nothing to draw, and drawing
    // half a graph would be worse than drawing none.
    if (!graph.pollPrograms()) return;

    // Both of these have to be in place BEFORE the step that consumes them. The
    // camera's guard band has to match the one SEA is about to be allocated
    // with, or the exumbrella's refraction tap reads the wrong part of the
    // water for a frame — at exactly the moment §7 requires the ladder to be
    // invisible. And §7 allows the ladder to cut the far snow and nothing else,
    // because near snow is the strongest "this is a camera in water" cue in the
    // frame and mid snow is the parallax reference against the animal.
    camera.setOverscan(quality.settings.overscan);
    snow.setFarCount(quality.settings.farSnow);

    simulate(stepDt);

    graph.configure({
      cssWidth,
      cssHeight,
      renderScale: quality.settings.renderScale,
      overscan: quality.settings.overscan,
      thickDivisor: quality.settings.thickDivisor,
      rays: quality.settings.raysBuffer,
      // From the graph, not from the probe: it is the graph that decided
      // whether the composite compiled FXAA in, and the two answers have to be
      // the same answer.
      msaa: graph.msaaSamples
    });
    graph.update(nowMs);
    syncBackingStore();
    if (!graph.targets.ready) return;

    view.dt = stepDt;
    view.time = simTime;
    view.causticTime = causticTime;
    /*
     * Wrapped, because `view.frame` reaches the shaders only as `uFrame` and
     * every consumer folds it into an interleaved-gradient-noise argument. The
     * frame term dominates that dot product, so an unbounded counter grows the
     * fp32 ulp there until it swallows the per-pixel step: measured over a
     * 64x64 tile, the shaft jitter falls from 4096 distinct values to 16 across
     * an eight-hour session, and the pre-tonemap sensor grain drifts to sigma
     * 1.34 against the unit variance §6's noise amplitudes are calibrated for.
     * 8192 frames is a 2.3-minute cycle — far too long to read as a repeat in
     * per-pixel grain, and short enough that both stay at full resolution.
     * `frameIndex` itself stays unwrapped for the dev overlay.
     */
    view.frame = frameIndex % 8192;
    // Under reduce-motion sim/swim.js parks the phase at §4.6's frozen pose
    // itself, so this is the same expression in both modes and there is no
    // second copy of the constant to drift.
    view.phase = swim.phase;
    view.amplitude = DEFORM.AMPLITUDE;
    view.twistTime = twistTime;

    quality.frameBegin();
    graph.render(view);
    quality.frameEnd();
    /*
     * `dt`, not `stepDt`. They are the same number except when §7's 30 Hz clamp
     * is engaged, and there the difference decides whether the clamp is ever
     * released: `stepDt` then carries the deliberately skipped rAF as well, so
     * on Safari and Firefox — where there is no timer query and the controller
     * counts frames over 20 ms — every rendered frame would look dropped, the
     * up-counter would never advance, and the page would hold 30 Hz for the rest
     * of the session however idle the machine became. What the controller is
     * being asked is "how long did the machine take", and the machine took one
     * rAF interval. The cost is that its own clocks (the renderScale ease, the
     * five-minute latch window) run at half speed while clamped, which lengthens
     * a 0.75 s cross-fade to 1.5 s and is not something anyone can see.
     */
    quality.update(dt);

    frameIndex++;

    if (!faded) {
      // Added only after a frame has actually been presented. Adding it earlier
      // shows 1.2 s of cleared black, which is the loading screen §7 refuses.
      faded = true;
      canvas.classList.add(READY_CLASS);
    }

    if (dev) devFrame();
  }

  function schedule() {
    if (!running || rafId || contextLost) return;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /* --- Lifecycle wiring -------------------------------------------------- */

  /*
   * §7: observe #sea, not window.resize — the navbar's own insertion changes the
   * host's height without a window event, and a sidebar or a devtools split
   * would do the same. One rAF token coalesces a burst of callbacks; the actual
   * reallocation is debounced inside targets.js.
   */
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { schedule(); })
    : null;
  if (observer) observer.observe(host);

  /*
   * §7: a hidden tab does NO GPU work. Not a reduced frame rate — none. The
   * frame time is reset on resume so the first visible frame is a normal one,
   * the shaft history is dropped because it is a feedback buffer holding a
   * half-hour-old image, and the verlet accumulator is dropped so the solver
   * does not try to catch up on the time it was asleep.
   */
  function onVisibility() {
    if (document.hidden) {
      running = false;
      stop();
      return;
    }
    if (destroyed || contextLost) return;
    running = true;
    lastMs = 0;
    pendingDt = 0;
    if (guides) guides.accumulator = 0;
    if (arms) arms.accumulator = 0;
    if (graph) graph.invalidateHistory();
    schedule();
  }
  document.addEventListener('visibilitychange', onVisibility);

  /*
   * §7: macOS resets the GPU on sleep and this page will be asleep. preventDefault
   * on the loss event is mandatory — without it `webglcontextrestored` never
   * fires at all. Everything the restore needs is a parameter: the geometry is
   * generated, the imperfection object is held above and reused, and the sim
   * state (where the animal is, how fast it is going, where every tentacle node
   * sits) is CPU-side and untouched. So the animal comes back mid-stroke rather
   * than restarting.
   */
  const unwireContext = addContextLossHandlers(canvas, {
    onLost() {
      contextLost = true;
      stop();
      destroyGpu();
    },
    onRestored() {
      if (destroyed) return;
      contextLost = false;
      // A restored context is a DIFFERENT context, and the extension objects
      // the boot probe captured belonged to the old one. gl.js's probe is
      // documented as "call once"; once per context is what that means.
      caps = probeCapabilities(gl);
      msaaSamples = (caps.maxSamplesRGBA16F | 0) >= 4 ? 4 : 0;
      try {
        buildGpu();
      } catch (err) {
        console.error('jellyfish: could not rebuild after a context restore', err);
        return;
      }
      // No forceUpdate here: the targets manager allocates its FIRST generation
      // immediately, without the 250 ms debounce, and this is a brand new one.
      graph.invalidateHistory();
      lastMs = 0;
      pendingDt = 0;
      faded = false;
      canvas.classList.remove(READY_CLASS);
      running = !document.hidden;
      schedule();
    }
  });

  /*
   * §4.6, and it is live rather than read once: the operating system's reduce-
   * motion switch can be thrown while the page is open, and the whole point of
   * the setting is that the person who threw it sees the effect now.
   */
  function onMotionChange() {
    reducedMotion = !!(motionQuery && motionQuery.matches);
    swim.setReducedMotion(reducedMotion);
    camera.setReducedMotion(reducedMotion);
  }
  if (motionQuery) {
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onMotionChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
    }
  }

  /* --- The ?dev=1 panel --------------------------------------------------- */

  /*
   * §9: there is no UI. This exists only to dial the bell profile against
   * reference footage and to run §10's forced 1 -> 4 -> 1 tier check, and it is
   * never created without the query flag. z-index 3 puts it above the navbar
   * seam strip and above the poster frame.
   */
  let devPanel = null;
  function devFrame() {
    if (!devPanel) {
      devPanel = document.createElement('pre');
      devPanel.style.cssText = [
        'position:absolute', 'left:8px', 'bottom:8px', 'z-index:3', 'margin:0',
        'padding:6px 9px', 'pointer-events:none',
        'font:11px/1.5 var(--mono,ui-monospace,monospace)',
        'color:var(--text-sec,#a3a3a3)', 'background:rgba(5,5,5,0.72)',
        'border:1px solid var(--border,#262626)'
      ].join(';');
      host.appendChild(devPanel);
    }
    if (!reportedMissing) {
      reportedMissing = true;
      const missing = graph.missingUniforms();
      if (Object.keys(missing).length) {
        // Not necessarily an error: the compiler strips unused uniforms hard.
        // A name that is simply misspelled shows up here and nowhere else.
        console.info('jellyfish: uniforms set but not present in the linked program', missing);
      }
    }
    if ((frameIndex & 15) !== 0) return;
    const s = quality.settings;
    const t = graph.targets;
    devPanel.textContent = [
      `tier ${s.tier}${quality.latched ? ' (latched)' : ''}  ${quality.mode}`,
      `RS ${s.renderScale.toFixed(3)}  ${t.width}x${t.height}  sea ${t.seaWidth}x${t.seaHeight}`,
      `shafts ${s.shaftSteps}  bloom ${s.bloomLevels}  farSnow ${s.farSnow}  ${s.bellLOD}`,
      `thick ${s.analyticThickness ? 'analytic' : 'RS/' + s.thickDivisor}  ${graph.floatPath ? 'fp16' : 'rgba8'}`,
      `phase ${swim.phase.toFixed(3)}  period ${swim.period.toFixed(2)}s  beat ${swim.beatIndex}`,
      `cam ${camera.elevationDegrees.toFixed(1)}deg (max ${camera.maxElevationDegreesSeen.toFixed(1)}, clamps ${camera.elevationClampCount})`,
      `mem ${(t.memoryEstimateBytes() / 1048576).toFixed(1)} MB  frame ${frameIndex}`
    ].join('\n');
  }

  /* --- Boot -------------------------------------------------------------- */

  measure();
  try {
    buildGpu();
  } catch (err) {
    console.error('jellyfish: the renderer could not start', err);
    const poster = showPoster(host, 'The renderer could not start on this device.');
    unwireContext();
    if (observer) observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    return { gl, destroy() { poster.remove(); } };
  }

  onMotionChange();
  running = !document.hidden;
  schedule();

  /* --- destroy() ---------------------------------------------------------- */

  /**
   * The fleet's teardown contract (Stocks/js/widgets.js:627): cancel the pending
   * frame, disconnect the observer, unwire every listener, delete every GL
   * object, drop the context and empty the host. After this the module holds no
   * timer, no listener and no GPU memory.
   */
  return {
    gl,
    get quality() { return quality; },
    get graph() { return graph; },
    // Rebuilt by a context restore, so a getter rather than a captured
    // reference; the solved nodes on it are what the strand checks read.
    get strands() { return strands; },
    swim,
    camera,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      running = false;
      stop();
      if (observer) observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (motionQuery) {
        if (typeof motionQuery.removeEventListener === 'function') {
          motionQuery.removeEventListener('change', onMotionChange);
        } else if (typeof motionQuery.removeListener === 'function') {
          motionQuery.removeListener(onMotionChange);
        }
      }
      unwireContext();
      destroyGpu();
      if (devPanel) devPanel.remove();
      canvas.classList.remove(READY_CLASS);
      // WEBGL_lose_context is the only way to hand the driver its memory back
      // promptly; without it the context lingers until the GC gets round to it,
      // which on a page that has just been torn down is exactly the wrong time.
      const lose = caps.loseContext;
      if (lose && !gl.isContextLost()) lose.loseContext();
    }
  };
}

/* --- Auto-start --------------------------------------------------------- */

/*
 * index.html loads this as a module, so it runs after parsing and #sea and the
 * canvas both exist. `?dev=1` opens the tuning panel and makes the camera's
 * elevation assertion throw rather than clamp; `?tier=N` pins the quality tier,
 * which is how §10's "forced 1 -> 4 -> 1 produces no brightness step and no
 * popping element" is actually checked.
 */
const params = new URLSearchParams(location.search);
const forcedTierParam = Number.parseInt(params.get('tier') || '', 10);

export const jellyfish = createJellyfish({
  dev: params.get('dev') === '1',
  forcedTier: Number.isFinite(forcedTierParam) ? forcedTierParam : null
});
