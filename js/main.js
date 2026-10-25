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

     director.step(dt, swim)           the tank, the station, the schedule
     swim.step(dt)                     the pulse, the thrust, the pose
     rebase                            floating origin: shift EVERYTHING
     flow.step(dt, swim)               the jet and the shed rings
     strands.updateRoots(pose)         the margin the tentacles hang from
     guides.step / arms.step(dt, flow) the verlet substeps
     director.compose(swim, mode)      the station, in scene space, this frame
     camera.step(dt, swim.position, swim.velocity)  the loose look-at
     snow.step(dt, camera.position)    advected by the same flow

   The director FIRST because the two commands it writes onto the
   animal — a heading-rate bias and a depth setpoint — are read
   inside `swim.step()` on the very next line, and `compose()`
   AFTER the rebase because it converts world coordinates to scene
   coordinates using the `worldOffset` this frame ended with.

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
import { RAD_TO_DEG, smoothstep } from './math.js';
import { createFrameGraph } from './render/frame.js';
import { COOKIE_TIME_SCALE_REDUCED } from './shaders/cookie.js';
import { createQualityController } from './render/quality.js';
import { Camera } from './camera.js';
import { Swim, SCENE_DEPTH_ORIGIN } from './sim/swim.js';
import { Director } from './sim/director.js';
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

/* --- §9's one piece of visible chrome, and it is visible for 8.7 s ------- */

/*
 * See SPEC §9 amendment 2. Three affordances that nobody can find are not
 * restraint, they are a defect, and this is the smallest thing that repairs it:
 * thirty characters, about 0.23 % of a 1920x1080 frame, once per page load,
 * removed from the document at 8.7 s and never shown again — not on a context
 * restore, not on a timer, not on a second look. It is styled inline rather than
 * from css/jellyfish.css for exactly the reason showPoster() gives below: a rule
 * in a fifty-line stylesheet that exists for one transient is a rule nobody will
 * recognise later, and SPEC's "~55 lines; there is no UI to style" stays true of
 * that file. Its clock is the render loop's own `dt` — never setTimeout, never
 * el.animate(), never a CSS transition — so a hidden tab pauses it instead of
 * running it out into an empty room.
 */

/**
 * Three words that name what each framing IS rather than what the key does,
 * plus the pause key. "alongside" is js/camera.js's own word for the subject
 * rig. In English it is ASCII plus U+00B7 separators, inside IBM Plex Sans's
 * LATIN subset; other languages come from i18n.js through window.t and may pull
 * another subset, which is the fleet's normal cost of a translated line.
 */
const HINT_TEXT = '1 tank · 2 alongside · 3 close · P pause';

/** i18n.js's window.t when it is there; the harness shims have none, so English. */
const tr = (s) => (typeof window !== 'undefined' && typeof window.t === 'function') ? window.t(s) : s;

/*
 * No box, no border, no ground, no gold and no click target: a box reads as
 * chrome against a frame dithered to ±1 LSB. `--text-sec` is the register both
 * of the other non-canvas elements on this page already use, and it is
 * deliberately NOT `--accent` — css/jellyfish.css's header says the navbar gold
 * is the only non-blue thing on screen, and tests/shot.mjs measures
 * redToBlueRatio over every pixel below y = 61. `--sea-veil` gets its first
 * consumer in the repo as the shadow colour, which is the same colour the
 * vignette mixes toward. Bottom-centre 26 px up is the darkest, calmest region
 * of the frame, clear of #sea::before's 28 px navbar seam and, being centred,
 * clear of the ?dev=1 panel's bottom-left corner. z-index 2 is above that seam
 * strip (1) and below the dev panel (3); it shares 2 with the poster frame and
 * can never coexist with it, because this element is created inside frame() and
 * both poster paths return before any frame runs.
 */
const HINT_STYLE = [
  'position:absolute', 'left:0', 'right:0', 'bottom:26px', 'z-index:2',
  'margin:0', 'padding:0 1rem', 'pointer-events:none',
  'text-align:center', 'white-space:nowrap',
  'font:12px/1.6 var(--sans,system-ui,-apple-system,"Segoe UI",sans-serif)',
  'letter-spacing:0.10em',
  'color:var(--text-sec,#a3a3a3)',
  'text-shadow:0 1px 4px var(--sea-veil,#04070E)',
  'opacity:0'
].join(';');

/** Exactly the canvas fade in css/jellyfish.css, so the hint arrives as part of
    the descent rather than as a notification arriving on top of it. */
const HINT_RISE = 1.2;
/** Long enough to read thirty characters twice, short enough not to become
    furniture. */
const HINT_HOLD = 5.0;
/** Twice the house rate: it leaves, it is not dismissed. 1.2 + 5.0 + 2.5 = 8.7 s
    of total life from the first PRESENTED frame, which is 3.3 s clear of
    tests/shot.mjs's default 12000 ms capture — so the project's photometric
    evidence is never taken with it in frame. */
const HINT_FALL = 2.5;
/** On #a3a3a3 over near-black: legible, and far below the 0.55 bright-pass knee
    foot in linear terms, so it cannot bloom and cannot move the auto-exposure
    highlight meter. §10's rate budget binds only on regions larger than 5 % of
    the frame and this one is twenty-three times under that, so the ramps above
    are aesthetics rather than compliance; appearing once per page load, §10's
    FFT sees an impulse and not a carrier. */
const HINT_PEAK = 0.60;

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
    dev = false,
    mode: initialMode = 'tank',
    /*
     * Whether to show the transient controls hint at all. It defaults OFF at
     * this boundary rather than on: the auto-start block below decides for the
     * page (fine pointer, no explicit `?mode=`, no `?hint=0`), and an embedder
     * — or the suite, which boots this function directly dozens of times — gets
     * a page with nothing added to it unless it asks.
     */
    hint: showHint = false
  } = options;

  if (!host || !canvas) return { destroy() {} };

  /* ---- capability probe, §7 step 1 ---------------------------------- */

  const gl = createContext(canvas);
  if (!gl) {
    const poster = showPoster(host,
      tr('This page needs WebGL2, which this browser does not have.'));
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

  /*
   * Which of the three framings the page is watching from: 'tank' is a fixed
   * world-anchored station, 'free' is the shipped subject rig alongside the
   * animal, and 'close' is a subject-anchored orbit 1.35 m out, below the animal
   * and on the far side of it from the sun. It lives in this
   * closure and NEVER at module scope, because `export const jellyfish =
   * createJellyfish(...)` at the foot of this file re-executes on every one of
   * the suite's cache-busted re-imports; a module-level `let` would leak the
   * previous boot's framing into the next one and make a failure depend on the
   * order the sections happened to run in. `camera.mode` is the authoritative
   * mirror of this value, and the keyboard handler writes both through
   * `setMode()` below so the two can never disagree.
   */
  let mode = (initialMode === 'free' || initialMode === 'close') ? initialMode : 'tank';

  const swim = new Swim({ seed: `${seed}-swim` });
  const flow = new FlowField();
  const camera = new Camera({
    seed: `${seed}-camera`,
    aspect: 16 / 9,
    depthOrigin: SCENE_DEPTH_ORIGIN,
    strictElevation: dev
  });

  /*
   * The director is pure CPU — a bounded swim volume, a world-fixed camera
   * station and six schedules longer than three hundred seconds — so like the
   * animal it survives a context loss untouched and is built here rather than
   * in buildGpu(). It comes after the camera because `enterTank()` reads where
   * the camera already is.
   *
   * The seven statements that follow are the boot pose, and their order is the
   * reason the SnowField is no longer constructed next to the camera. A zero
   * step primes the director's clocks and the schedule without consuming an rng
   * draw; `compose()` turns the station's world coordinates into scene space;
   * `setMode(..., true)` snaps the framing weights and the FOV to the terminal
   * value for this mode and clears the camera's `_primed` flag; and the zero
   * camera step
   * then places the eye exactly on the framing rather than letting it swoop in.
   * Only THEN is the snow scattered, because its three strata are bands built
   * around wherever the camera is at that instant — build them first and a
   * three-metre boot dolly empties the near stratum on frame one, behind the
   * 1.2 s fade where nobody can see it happen but everybody sees the result.
   */
  const director = new Director({ seed: `${seed}-director` });
  director.enterTank(camera.position, swim);
  director.step(0, swim);
  director.compose(swim, mode);
  camera.sunTime = director.lightTime;
  camera.setStation(director.stationScene, director.aimTarget, director.aimVelocity);
  camera.setMode(mode, swim.position, true);
  camera.step(0, swim.position, swim.velocity);

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
  /* The visitor's own pause (P, Space or the navbar button). It holds the
     loop exactly the way a hidden tab does, and a tab coming back does not
     undo it. */
  let paused = false;
  let rafId = 0;
  let lastMs = 0;
  let simTime = 0;
  let causticTime = 0;
  let twistTime = 0;
  let frameIndex = 0;
  let pendingDt = 0;
  let faded = false;
  /*
   * The hint's whole lifecycle, in three boot-scope variables and no timer.
   * `hintAge` is integrated from `stepDt`, the render loop's own accumulated
   * real time since the previous PRESENTED frame — the same quantity simulate()
   * is driven by, and not the per-rAF `dt`, because §7's 30 Hz floor drops every
   * other rAF and a hint clocked on `dt` would live 17.4 s instead of 8.7 s on
   * exactly the weak machines that floor exists for. `pendingDt` only
   * accumulates while frame() runs, so a hidden tab still freezes it. The
   * distinction that matters is between `faded` and `hintShown`: a context
   * restore clears `faded` and replays the 1.2 s water fade every time the
   * machine wakes up, and `hintShown` deliberately survives that, so an
   * eight-hour session on a Mac that resets its GPU on every sleep still shows
   * this line exactly once.
   */
  let hintEl = null;
  let hintAge = 0;
  let hintShown = false;
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
    /*
     * Exactly −14.0, for the life of the page, and it must stay that way. It is
     * the most tempting lever in this file — render/frame.js pushes it into
     * `uWorldOrigin.y`, which regrades the water column, the veil, the caustic
     * mip blur and the shaft source all at once — and it is wrong twice over.
     * `uSunCol` is derived from `swim.worldY` (js/sim/swim.js:280), which reads
     * the module constant SCENE_DEPTH_ORIGIN and would NOT follow, so moving
     * this would silently desync the animal's key light from the water it is
     * sitting in. And a world origin that moves is a global mean-luminance
     * CARRIER, which is exactly the FFT peak §10 forbids by name. sim/director.js
     * varies the light by moving the ANIMAL through the column instead, on
     * carriers no shorter than 511 s.
     */
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

    /*
     * The director before the animal, because the two commands it writes onto
     * `swim` — a heading-rate bias in rad/s and a depth setpoint in metres — are
     * consumed by `swim.step()` immediately below. It reads LAST frame's
     * contraction rate and world position: sixteen milliseconds of staleness
     * against a 1.3 s beat and a τ = 4 s axis spring, which is two orders below
     * anything either of them can express. Do NOT "fix" that into a two-pass
     * ordering; the frame order at the top of this file is load-bearing.
     */
    director.step(dt, swim);

    // The two clocks §4.6 slows. They are held rather than scaled, so toggling
    // reduce-motion pauses them where they are instead of jumping them. The
    // caustic clock carries a third factor as well, the director's [0.72, 1.00]
    // rate: because `causticTime` feeds both `uCookieTime` and cookieDrift(),
    // one multiplier calms the surface's internal animation and its bulk
    // advection together, over a 640 s carrier that never runs faster than
    // shipped — so shaders/cookie.js's measured rate budget is respected by
    // construction rather than by care.
    causticTime += dt * (reducedMotion ? REDUCED_CAUSTIC_RATE : 1) * director.causticRate;
    twistTime += reducedMotion ? 0 : dt;

    swim.step(dt);

    /*
     * §4.3's floating origin. When the animal has wandered half a metre from the
     * render origin, swim.js walks the whole world back under it and publishes
     * the delta. EVERY other position in scene space has to move with it or the
     * camera, the tentacles, the vortex rings and the marine snow all jump a
     * millimetre in the opposite direction on the same frame. This is the only
     * place that list exists, so anything added to the sim belongs in it.
     *
     * With one deliberate exception: the DIRECTOR is not in the list and must
     * not be added to it. It holds the camera station in WORLD coordinates and
     * converts to scene space inside `compose()`, using the `worldOffset` of
     * the frame it is called on — so it is rebase-exact by construction, and
     * translating it here as well would apply the same shift twice.
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

    /*
     * The station, recomputed in scene space against the worldOffset this frame
     * ended with, and the sun's own clock — both handed over before the camera
     * springs toward them. `camera.step()` blends the station against the
     * two subject-anchored rigs by its own eased weight simplex, so these three
     * lines run in all three framings and in every transition between them; a
     * page whose camera is on either subject rig simply ignores what it is
     * given, because its station weight is zero.
     */
    director.compose(swim, mode);
    camera.sunTime = director.lightTime;
    camera.setStation(director.stationScene, director.aimTarget, director.aimVelocity);
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
      // The hint mounts here for the same reason and on the same frame, so it
      // rises WITH the water rather than hanging over the black. `hintShown`
      // rather than `faded` is what gates it, because this block runs again
      // after every context restore and the hint is a once-per-load event.
      if (showHint && !hintShown) {
        hintShown = true;
        hintEl = document.createElement('p');
        hintEl.setAttribute('aria-hidden', 'true');
        // i18n.js re-translates it if the language arrives after this frame.
        hintEl.setAttribute('data-i18n', '');
        hintEl.setAttribute('data-i18n-key', HINT_TEXT);
        hintEl.style.cssText = HINT_STYLE;
        hintEl.textContent = tr(HINT_TEXT);
        host.appendChild(hintEl);
        hintAge = 0;
      }
    }

    if (hintEl) hintFrame(stepDt);
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
    if (destroyed || contextLost || paused) return;
    running = true;
    lastMs = 0;
    pendingDt = 0;
    if (guides) guides.accumulator = 0;
    if (arms) arms.accumulator = 0;
    if (graph) graph.invalidateHistory();
    schedule();
  }
  document.addEventListener('visibilitychange', onVisibility);

  /* Pausing stops the loop like a hidden tab; resuming takes the same path a
     tab coming back takes, so the first frame after it is a normal one. */
  function setPaused(next) {
    paused = !!next;
    if (paused) { running = false; stop(); return; }
    onVisibility();
  }

  /*
   * §9's three framing keys. Key "1" is station framing, key "2" is the subject
   * rig alongside the animal, key "3" is the close orbit. Nothing is drawn for
   * them and nothing is drawn by them: no badge, no toast, no title change, no
   * cursor change, and the only readout anywhere is the two lines devFrame()
   * adds inside the `?dev=1` panel.
   *
   * ONE element is added to the document, and only one, and only for the first
   * 8.7 s of a session: the transient controls hint above, which SPEC §9's
   * second amendment licenses and bounds. The original clause was right about
   * chrome and wrong about discovery — two undiscoverable keys was a defensible
   * austerity, three is a defect — so the hint names all three, is removed from
   * the document at 8.7 s, and never returns. From then on the document is once
   * again `<main id="sea"><canvas id="gl"></canvas></main>` and nothing else.
   */
  function setMode(next) {
    const m = (next === 'free' || next === 'close') ? next : 'tank';
    if (m === mode) return;                  // holding a key re-plants nothing
    mode = m;
    // Plant the station at the bearing the camera already has about the tank
    // centre, so the blend removes the lateral component entirely and the move
    // is a radial dolly rather than a sweep — motes stream past the lens
    // instead of scything across the snow strata.
    // Only tank: the other two framings are anchored to the animal and plant
    // nothing in the world at all, so the tank, the station standoff and the
    // director's lens keep-out never notice that either of them exists.
    if (m === 'tank') director.enterTank(camera.position, swim);
    // Never `immediate`: the weights ease over MODE_TAU and there is no
    // discontinuity anywhere, so nothing here creates or destroys a GL object,
    // reallocates a target or invalidates the shaft history. It touches neither
    // `graph` nor any GL object at all, which is what makes it safe to call at
    // any moment — while the context is lost, while the programs are still
    // linking, and from inside any of frame()'s five early returns.
    camera.setMode(m, swim.position, false);
  }

  /*
   * On `document`, never on `window`. Both harness shims install a `window`
   * that carries `matchMedia` and nothing else, so a single boot-scope
   * `window.addEventListener` would TypeError and take down every syntax, run
   * and soak check at once; `document.addEventListener` exists in both.
   *
   * The handler reads `event.key` defensively because a dispatched stub may
   * carry only a type, and it never calls preventDefault: "1", "2" and "3" are
   * not browser-reserved and collide with nothing in the fleet chrome — the
   * navbar's clock takes Enter and Space, and nothing else on the page is
   * focusable. The hint is `pointer-events: none` with no `tabindex` and no
   * handler of its own, so that stays literally true now that it exists. A
   * repeat, a modifier, or a focused text field means the keystroke was meant
   * for something else.
   *
   * This is also the hint's dismissal, and it is the ONLY listener the hint
   * has: adding a second one for it would cost the page a listener it does not
   * need and the suite an assertion it currently makes.
   */
  function onKeyDown(event) {
    const key = event && event.key;
    if (key !== '1' && key !== '2' && key !== '3') return;
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target;
    if (t && (t.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    // Fast-forward to the head of the fall rather than removing it outright, so
    // the line leaves on its own 2.5 s ramp: a hint that vanishes on the
    // keystroke is a dismissal, and a dismissal is chrome. It runs BEFORE
    // setMode() so that pressing "1" while already in tank framing — which
    // setMode() correctly treats as a no-op — still acknowledges the keystroke.
    if (hintEl) hintAge = Math.max(hintAge, (reducedMotion ? 0 : HINT_RISE) + HINT_HOLD);
    setMode(key === '1' ? 'tank' : key === '2' ? 'free' : 'close');
  }
  document.addEventListener('keydown', onKeyDown);

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
      // `hintShown` is deliberately NOT reset here, and this is the one line of
      // the hint's lifecycle worth reading twice. This path runs every time the
      // machine sleeps and the driver hands the page a new context, and it
      // legitimately replays the 1.2 s water fade each time; replaying the hint
      // with it would make a page meant to be left open all day flash the same
      // three words at whoever walks back to it, which is an itch, and a
      // recurring bright event is exactly the carrier §10's FFT rule forbids.
      // Once per page load means once per page load.
      running = !document.hidden && !paused;
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
    // The director answers it in two halves: the station and its shake stop
    // outright, because §4.6 calls camera drift stopped; the optical schedule
    // keeps running at 15 %, because §4.6 also wants grain, dither and exposure
    // alive so the image still breathes.
    director.setReducedMotion(reducedMotion);
  }
  if (motionQuery) {
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onMotionChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
    }
  }

  /* --- The controls hint -------------------------------------------------- */

  /**
   * One step of the hint, called from frame() with `stepDt` — the accumulated
   * real time since the previous presented frame, which is what simulate() and
   * every other integrator on this page are driven by, and which stays true to
   * the wall clock when §7's 30 Hz floor is dropping alternate rAFs. There is no
   * timer and no CSS transition anywhere in it, which is the point: a tab that
   * loses focus stops calling frame(), so the hint stops rather than running its
   * whole life out into a room nobody is in and being gone when the visitor
   * comes back.
   *
   * `reducedMotion` is read live, every frame, rather than captured when the
   * element was created. §4.6 keeps each identity and drops the loop, so under
   * the OS switch both ramps collapse to zero: the line appears at full opacity
   * with the first frame, holds its 5.0 s, and is removed with no transition.
   * Reading it here rather than latching it means throwing that switch mid-dwell
   * takes effect on the very next frame, with no extra state and no listener of
   * its own — the same argument onMotionChange() makes for everything else.
   *
   * The element is REMOVED FROM THE DOCUMENT at the end rather than left at
   * opacity 0, because §9's claim is about what the document contains and not
   * about what happens to be visible.
   */
  function hintFrame(h) {
    hintAge += h;
    const rise = reducedMotion ? 0 : HINT_RISE;
    const fall = reducedMotion ? 0 : HINT_FALL;
    if (hintAge >= rise + HINT_HOLD + fall) {
      hintEl.remove();
      hintEl = null;
      return;
    }
    let a = 1;
    if (rise > 0 && hintAge < rise) a = smoothstep(0, rise, hintAge);
    const fallStart = rise + HINT_HOLD;
    if (fall > 0 && hintAge > fallStart) {
      a *= 1 - smoothstep(fallStart, fallStart + fall, hintAge);
    }
    // Three decimals is a thousandth of a stop on a 0.60 peak; writing the full
    // fp64 expansion into the attribute every frame would churn the style string
    // for a difference no display can show.
    hintEl.style.opacity = (a * HINT_PEAK).toFixed(3);
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
    // The whole simplex, not `modeMix`: with three framings a single scalar
    // cannot say where the rig actually is mid-ease, and the case worth watching
    // in this panel is precisely the one that is on no edge of it.
    const w = camera.modeWeights;
    devPanel.textContent = [
      `tier ${s.tier}${quality.latched ? ' (latched)' : ''}  ${quality.mode}`,
      `RS ${s.renderScale.toFixed(3)}  ${t.width}x${t.height}  sea ${t.seaWidth}x${t.seaHeight}`,
      `shafts ${s.shaftSteps}  bloom ${s.bloomLevels}  farSnow ${s.farSnow}  ${s.bellLOD}`,
      `thick ${s.analyticThickness ? 'analytic' : 'RS/' + s.thickDivisor}  ${graph.floatPath ? 'fp16' : 'rgba8'}`,
      `phase ${swim.phase.toFixed(3)}  period ${swim.period.toFixed(2)}s  beat ${swim.beatIndex}`,
      `cam ${camera.elevationDegrees.toFixed(1)}deg (max ${camera.maxElevationDegreesSeen.toFixed(1)}, clamps ${camera.elevationClampCount})`,
      `mode ${camera.mode} w ${w.free.toFixed(2)}/${w.tank.toFixed(2)}/${w.close.toFixed(2)}  tank r ${director.animalRadius.toFixed(2)}m  d ${camera.distanceToTarget.toFixed(2)}m  fov ${(camera.fovY * RAD_TO_DEG).toFixed(1)}`,
      `light y${swim.worldY.toFixed(2)}  target ${swim.depthTarget.toFixed(2)}  sun ${director.sunElevationDegrees.toFixed(1)}deg  caustic x${director.causticRate.toFixed(2)}`,
      `mem ${(t.memoryEstimateBytes() / 1048576).toFixed(1)} MB  frame ${frameIndex}`
    ].join('\n');
  }

  /* --- Boot -------------------------------------------------------------- */

  measure();
  try {
    buildGpu();
  } catch (err) {
    console.error('jellyfish: the renderer could not start', err);
    const poster = showPoster(host, tr('The renderer could not start on this device.'));
    unwireContext();
    if (observer) observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('keydown', onKeyDown);
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
    director,
    // The framing, readable and writable without a key event: `?mode=` is the
    // boot override and this is the programmatic equivalent, which is how the
    // suite drives a mode and how an embedder would.
    get mode() { return mode; },
    setMode,
    get paused() { return paused; },
    setPaused,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      running = false;
      stop();
      if (observer) observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKeyDown);
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
      // Torn down inside its own 8.7 s is the one case where the hint outlives
      // the renderer, and "the module holds no timer, no listener and no GPU
      // memory" has to mean it holds no DOM either.
      if (hintEl) { hintEl.remove(); hintEl = null; }
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
 * popping element" is actually checked; `?mode=tank`, `?mode=free` or
 * `?mode=close` boots straight into a framing, which is the same choice keys
 * "1", "2" and "3" make and the only way to make it without a key event.
 * Anything other than `free` or `close` is tank, because tank is the default
 * and an unrecognised value should land on the intended page rather than on one
 * of the other two.
 */
const params = new URLSearchParams(location.search);
const forcedTierParam = Number.parseInt(params.get('tier') || '', 10);
const modeParam = params.get('mode');

/*
 * Whether this page shows the transient controls hint, decided once at boot.
 *
 * `?hint=1` forces it on whatever else is true, which is the door the suite uses
 * to observe its lifecycle; `?hint=0` forces it off, which is the door
 * tests/shot.mjs uses so the photometric baseline is taken with nothing in
 * frame. Otherwise it is shown only when the visitor might actually need it: an
 * explicit `?mode=` says they already know the keys exist, and a coarse pointer
 * says there is no keyboard to press them with — manifest.webmanifest ships this
 * page standalone, and naming three keys on a phone is simply untrue.
 *
 * `window.matchMedia` is probed rather than assumed, exactly the way the
 * reduce-motion query is above: both harness shims install a `window` that
 * carries very little, and a page that cannot answer the question shows no hint
 * rather than throwing on the way to the first frame.
 */
const hintParam = params.get('hint');
const pointerFine = typeof window.matchMedia === 'function' &&
  !!window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const showHint = hintParam === '1'
  ? true
  : (hintParam !== '0' && !params.get('mode') && pointerFine);

export const jellyfish = createJellyfish({
  dev: params.get('dev') === '1',
  forcedTier: Number.isFinite(forcedTierParam) ? forcedTierParam : null,
  mode: modeParam === 'free' ? 'free' : modeParam === 'close' ? 'close' : 'tank',
  hint: showHint
});
