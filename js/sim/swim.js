/* ============================================================
   swim.js — the pulse, its irregularity, and the propulsion.
   ------------------------------------------------------------
   Spec §4.1 and §4.3. This module is the animal's clock and its
   engine, and it owns four things that between them decide
   whether the page reads as alive or as a looping asset:

     1. The ASYMMETRIC pulse waveform. Contraction is fast and
        muscular (26 % of the cycle); relaxation is slow, passive
        elastic recoil. A symmetric sine reads as a beating toy.
        The recoil term is deliberately UNCLAMPED, so it dips to
        about −0.081 and the bell flares ~8 % wider than rest
        before settling. That overshoot is the visible signature
        of an under-damped elastic body. Do not clamp it.

     2. Period wander. A 96 s carrier at ±14 %, an
        Ornstein-Uhlenbeck jitter of ±6 % drawn once per beat,
        and a Poisson process (λ = 1/28 s) that skips a beat
        60 % of the time and fires a double 40 % of the time.
        OU rather than a random walk because a random walk drifts
        over an eight-hour soak and OU provably cannot.

     3. INTEGRATED thrust. Nothing here is keyframed. Thrust
        exists only while the bell is contracting, quadratic drag
        eats it, and the animal surges and coasts. Quadratic drag
        gives the long flattening glide that reads as water;
        linear drag reads as an elevator.

     4. Floating origin. The animal is held near p ≈ 0 and the
        accumulated world offset is handed to the sea instead, so
        an eight-hour session never puts a metre-scale coordinate
        anywhere near float precision trouble and the animal can
        never swim off the world.

   ONE WIRING NOTE THAT MATTERS. §4.2's vertex shader reads the
   cycle as `fract(uTime * uFreq - phi * 0.20)`. The period here
   wanders, so feeding the global clock into `uTime` would make
   the phase jump every time the period changed. Feed
   `swim.deformTime` and `swim.frequency` instead: the frequency
   is held constant for the duration of a beat and `deformTime`
   is defined as `phase / frequency`, so the product is exactly
   the accumulated phase. Better still, if the shader can be
   given a `uPhase` uniform, hand it `swim.phase` directly.
   ============================================================ */

import {
  Vec3, Spring3, Rng, ouStep,
  TAU, DEG_TO_RAD, clamp, fract,
  mat4, quat
} from '../math.js';
import { MEDIUM } from '../shaders/common.js';
import { pulse, pulseVelocity } from './deform.js';

/**
 * Scene y = 0 is the animal's working depth, not the sea surface. Every
 * `worldY` handed to `downwelling()` / `inscatter()` must be this plus the
 * scene-space height, and is therefore always strongly negative. The camera
 * uses the same origin; they must not disagree, so both read it from
 * `MEDIUM.CAMERA_DEPTH_Y` rather than from a local literal.
 */
export const SCENE_DEPTH_ORIGIN = MEDIUM.CAMERA_DEPTH_Y;

export const SWIM_CONSTANTS = Object.freeze({
  /* --- §4.1, the waveform ------------------------------------------- */
  /** Fraction of the cycle spent contracting. The spec's `C`. */
  CONTRACTION_FRACTION: 0.26,
  /** Relaxation decay and ringing rates, from the spec's `exp(-2.4u)*cos(2.6u)`. */
  RECOIL_DECAY: 2.4,
  RECOIL_RING: 2.6,
  /** Exponent applied to the smoothstep contraction ramp. */
  CONTRACTION_EXPONENT: 0.8,

  /* --- §4.1, the irregularity --------------------------------------- */
  BASE_PERIOD: 2.20,
  PERIOD_WANDER: 0.14,
  PERIOD_WANDER_CARRIER: 96.0,
  /** OU jitter drawn once per beat: stationary sigma and reversion time in BEATS. */
  PERIOD_JITTER_SIGMA: 0.06,
  PERIOD_JITTER_TAU_BEATS: 3.0,
  /** Poisson irregularity: rate in events per second. */
  EVENT_RATE: 1 / 28,
  SKIP_PROBABILITY: 0.60,
  SKIP_HOLD_MIN: 0.5,
  SKIP_HOLD_MAX: 1.0,
  DOUBLE_PERIOD_SCALE: 0.58,
  DOUBLE_CYCLES: 2,
  /** Sanity rails on the period, so no combination of wander can produce a spasm. */
  PERIOD_MIN: 0.75,
  PERIOD_MAX: 6.0,

  /* --- §4.2 --------------------------------------------------------- */
  /** Cycles of lag between the crown and the margin. The travelling wave. */
  KINEMATIC_WAVE_LAG: 0.20,

  /* --- §4.3, propulsion --------------------------------------------- */
  /** K1: impulse per unit of bell contraction, in (m/s) per unit mass. */
  THRUST_POWER: 0.10,
  /** K2 and its efficiency: passive energy recapture during the recoil. */
  THRUST_RECAPTURE: 0.10,
  RECAPTURE_EFFICIENCY: 0.30,
  MASS: 1.0,
  /** Quadratic drag. Tuned so a 0.13 m/s surge decays to ~0.04 m/s over one glide. */
  DRAG: 7.5,
  /** Faintly negatively buoyant, per §4.3. */
  BUOYANCY: 0.012,

  /* --- §4.3, the bell axis ------------------------------------------ */
  AXIS_TAU: 4.0,
  /** Mean tilt of the bell axis away from straight up. */
  AXIS_TILT_MEAN: 78 * DEG_TO_RAD,
  AXIS_TILT_SIGMA: 12 * DEG_TO_RAD,
  AXIS_TILT_TAU: 22.0,
  /** Heading is a random walk in RATE, so turns are smooth rather than jittery. */
  AXIS_HEADING_RATE_SIGMA: 0.055,
  AXIS_HEADING_RATE_TAU: 30.0,
  /** Station keeping: extra tilt per metre of depth error, and its authority limit. */
  DEPTH_KEEP_GAIN: 9 * DEG_TO_RAD,
  DEPTH_KEEP_LIMIT: 22 * DEG_TO_RAD,
  /*
   * The depth analogue of the director's radial tank wall, and it exists
   * because the two constants above are a station-keeping BIAS and were being
   * read as a bound. They are not one, for two compounding reasons.
   *
   * DEPTH_KEEP_GAIN is 9°/m against an AXIS_TILT_SIGMA of 12°, so for the first
   * metre of error the correction is smaller than the animal's own tilt noise
   * and is simply lost in it. Worse, AXIS_TILT_MEAN is 78° — the bell already
   * points twelve degrees ABOVE horizontal at rest — so the full ±22° of
   * DEPTH_KEEP_LIMIT only reaches a tilt of 100°, and on a −1σ tilt excursion
   * it reaches 88° and the animal is still climbing at full down-correction.
   * The term cannot guarantee a descent at all, which is why the realised depth
   * was a slow random walk with a soft centre rather than a band: measured over
   * eight hours at the shipped seed, `position.y` spanned −2.40 … +2.19 m with
   * σ = 0.71 m, four times the ±0.55 m DEPTH_TARGET_MAX the setpoint itself is
   * clamped to. In station framing that walked the animal off the top of frame
   * for 7074 consecutive frames — 117.9 s of empty water.
   *
   * The fix keeps the shipped term exactly as it is and adds a second one
   * outside a soft band, the way the tank wall sits outside TANK_SOFT_RADIUS.
   * DEPTH_SOFT_BAND is measured on the ERROR, not on absolute depth, so the
   * whole ±0.55 m lighting schedule is free to move the setpoint wherever it
   * likes and the wall never notices as long as the animal tracks it — which it
   * does, at 45 % of its own authority. Inside 0.25 m of the setpoint the
   * animal is on exactly the shipped bias and swims as freely as it always did.
   * Outside it, DEPTH_WALL_GAIN acts on the EXCESS only, so the term is
   * continuous and zero at the edge, and it reaches its full DEPTH_WALL_LIMIT
   * by 0.65 m of error (0.25 + 60/150).
   *
   * DEPTH_WALL_LIMIT is 60° rather than another 22° precisely because of the
   * arithmetic above: the correction has to beat the tilt it is added to, not
   * merely exist. 54° (a 2σ low tilt) + 22° + 60° = 136°, i.e. 46° of genuine
   * down-pitch in the worst noise the axis OU produces. It is a SEPARATE budget
   * from DEPTH_KEEP_LIMIT, clamped separately below, so the shipped ±22° figure
   * still describes the shipped term and every assertion written against
   * `cruise · sin 22° = 0.0322 m/s` still describes what it was written about.
   *
   * Nothing about the animal's look changes, and that is measured rather than
   * hoped for: the command goes through the τ = 4 s AXIS_TAU spring, so what
   * reaches the bell is heavily smoothed. Over eight hours the realised
   * bell-axis tilt histogram matches the shipped one to within half a percent
   * in every ten-degree bin, and the extreme moves from 111.7° to 119.5°. What
   * does change is the depth: `position.y` now spans −1.11 … +1.16 m, the
   * animal is outside the station's frame cone on 0.09 % of frames instead of
   * 4.42 %, and the longest continuous excursion falls from 117.9 s to 12.1 s —
   * inside §7's eighteen-second bound with a third of it in hand, holding
   * across every dt from 1/60 to the 1/30 clamp.
   */
  DEPTH_SOFT_BAND: 0.25,
  DEPTH_WALL_GAIN: 150 * DEG_TO_RAD,
  DEPTH_WALL_LIMIT: 60 * DEG_TO_RAD,
  /** §3.5 item 4: one side contracts this much harder, so the animal slowly yaws. */
  MUSCLE_ASYMMETRY: 0.08,
  MUSCLE_YAW_GAIN: 0.55,
  /** Sideways kick to the axis spring on the power stroke: it tips after a hard beat. */
  PULSE_TIP_GAIN: 0.20,
  /** Slow rotation about the animal's own axis, so the gonad pattern turns. */
  SPIN_RATE_SIGMA: 0.035,
  SPIN_RATE_TAU: 40.0,

  /* --- §4.3, floating origin ---------------------------------------- */
  /**
   * Horizontal leash. Checked every frame, so the correction applied on any one
   * frame is only the millimetre the animal travelled past it — small enough
   * that a consumer which forgets to apply `originShift` degrades into a slow
   * drift rather than a visible jump.
   */
  ORIGIN_REBASE_RADIUS: 0.5,

  /* --- §4.5, bioluminescence ---------------------------------------- */
  BIOLUMINESCENCE_OFFSET: 0.35,
  BIOLUMINESCENCE_INTENSITY: 0.05,

  /* --- §4.6 --------------------------------------------------------- */
  /** Mid-relaxation, arms streaming. The prettiest pose to freeze on. */
  REDUCED_MOTION_PHASE: 0.62,

  /** Largest step the integrator will take in one go, whatever the caller passes. */
  MAX_STEP: 0.1
});

const C = SWIM_CONSTANTS.CONTRACTION_FRACTION;

/**
 * §4.1's waveform, and its analytic derivative.
 *
 * NEITHER IS DEFINED HERE. `js/sim/deform.js` owns both, because the vertex
 * shader that moves the margin is generated from the same constants, and two
 * copies of a waveform written from the same paragraph of the spec drift the
 * first time either is retuned. The symptom would be the thrust peaking at a
 * different instant from the contraction that is supposed to produce it —
 * an animal fighting its own muscle, and nothing in the frame that looks like
 * an error.
 *
 * `SWIM_CONSTANTS`'s CONTRACTION_FRACTION, RECOIL_DECAY, RECOIL_RING and
 * CONTRACTION_EXPONENT are kept above as the record of what this file expects,
 * and tests/check.mjs asserts they still match `DEFORM`'s.
 *
 * The waveform accepts `x` past 1: the relaxation branch is a decaying ringing
 * term that is perfectly well defined beyond the end of a cycle, and letting it
 * continue is how a skipped beat becomes a longer relaxation rather than a
 * frozen frame. The recoil is NOT clamped at zero — it dips to about −0.081
 * near x = 0.94, the bell flaring ~8 % past rest before settling, which is the
 * single detail that sells "soft body" over "shape key".
 *
 * §4.3 writes the thrust drive as a finite difference, `(p - pPrev) / dt`. That
 * is fine inside a cycle and wrong at the wrap: `pulse` steps from −0.078 back
 * to 0 at the cycle boundary, and a finite difference across that step injects
 * a large phantom impulse into the integrator once per beat. The analytic
 * derivative has no such spike, is frame-rate independent, and is the
 * derivative of the spec's own function rather than a different waveform.
 */
export { pulse };
export const pulseDerivative = pulseVelocity;

const _axisTarget = new Vec3();
const _lateral = new Vec3();
const _spinQuat = quat.create();
const _tiltQuat = quat.create();
const _yAxis = [0, 1, 0];

/**
 * The animal's clock, engine and pose. Construct one; call `step(dt)` once per
 * rendered frame; read the public fields. Everything is deterministic from the
 * seed, so two runs of the same build produce the same animal.
 */
export class Swim {
  /**
   * `seed` names the animal. `reducedMotion` freezes the cycle at §4.6's pose.
   */
  constructor({ seed = 'aurelia-swim', reducedMotion = false } = {}) {
    this.rng = new Rng(seed);
    this.reducedMotion = reducedMotion;

    /* Clock. */
    this.time = 0;
    this.phase = 0;
    this.phaseRate = 0;
    this.period = SWIM_CONSTANTS.BASE_PERIOD;
    this.frequency = 1 / SWIM_CONSTANTS.BASE_PERIOD;
    this.beatIndex = 0;

    /* Waveform. */
    this.pulseValue = 0;
    this.dPulse = 0;
    this.contractionRate = 0;
    this.lastContractionPeak = 0;

    /* Per-step event flags, all false except on the step they describe. */
    this.beatStarted = false;
    this.contractionEnded = false;
    this.beatSkipped = false;
    this.beatDoubled = false;

    /* Body state. */
    this.position = new Vec3(0, 0, 0);
    this.velocity = new Vec3(0, 0, 0);
    this.speed = 0;
    this.bellAxis = new Vec3(0, 1, 0);
    this.spin = 0;
    this.orientation = quat.create();
    this.modelMatrix = mat4.create();

    /* Floating origin. `worldPosition === position + worldOffset`, invariantly. */
    this.originShift = new Vec3(0, 0, 0);
    this.worldOffset = new Vec3(0, 0, 0);
    this.rebasedThisStep = false;

    /*
     * Written by `sim/director.js` each step: a heading-rate bias in rad/s
     * added to the yaw integration below, and the depth setpoint in metres
     * that the station-keeping term steers toward. Both are zero on a page
     * with no director, and zero here reproduces the shipped behaviour
     * exactly — the yaw term vanishes and the setpoint is scene y = 0, which
     * is the literal this module used to hold.
     */
    this.steerBias = 0;
    this.depthTarget = 0;

    this._axisSpring = new Spring3(new Vec3(0, 1, 0));
    this._tilt = SWIM_CONSTANTS.AXIS_TILT_MEAN;
    this._heading = this.rng.range(0, TAU);
    this._headingRate = 0;
    this._spinRate = 0;
    this._periodJitter = 0;
    this._eventTimer = this.rng.exponential(SWIM_CONSTANTS.EVENT_RATE);
    this._skipPending = false;
    this._doubleCyclesLeft = 0;
    this._contractionSeconds = C * SWIM_CONSTANTS.BASE_PERIOD;
    this._relaxSeconds = (1 - C) * SWIM_CONSTANTS.BASE_PERIOD;
    this._asymmetry = this.rng.sign() * SWIM_CONSTANTS.MUSCLE_ASYMMETRY;

    this._beginBeat(true);
    if (this.reducedMotion) this._freeze();
    this._updatePose();
  }

  /** Accumulated phase mapped back to a time, for a `uTime * uFreq` shader. See the header. */
  get deformTime() {
    return this.frequency > 0 ? this.phase / this.frequency : 0;
  }

  /**
   * §4.5's bioluminescent travelling pulse: the same cycle, offset 0.35 of a
   * turn from the mechanical one, so the light does not merely trace the
   * contraction. Multiply by `BIOLUMINESCENCE_INTENSITY` at the use site.
   */
  get bioluminescencePhase() {
    return fract(this.phase - SWIM_CONSTANTS.BIOLUMINESCENCE_OFFSET);
  }

  /** Depth in the shader's coordinates: negative, roughly −14. */
  get worldY() {
    return SCENE_DEPTH_ORIGIN + this.position.y;
  }

  /** The animal's true unbounded position, for anything that needs continuity. */
  get worldPosition() {
    return this.position.add(this.worldOffset);
  }

  /** The integrated swim heading, for a steering term that has to aim at it. */
  get heading() {
    return this._heading;
  }

  /**
   * Rebuild from the seed. Called after a context restore so the animal comes
   * back identical rather than merely similar.
   */
  reset() {
    this.rng.reset();
    this.time = 0;
    this.phase = 0;
    this.beatIndex = 0;
    this.pulseValue = 0;
    this.dPulse = 0;
    this.contractionRate = 0;
    this.lastContractionPeak = 0;
    this.position.zero();
    this.velocity.zero();
    this.speed = 0;
    this.spin = 0;
    this.originShift.zero();
    this.worldOffset.zero();
    this.rebasedThisStep = false;
    /*
     * Mirrored here as well as in the constructor: a context restore rebuilds
     * the animal from the seed but the director keeps running, and leaving a
     * stale bias behind would have the restored animal steering on last
     * frame's command. Zero is the no-director state, which is safe either way.
     */
    this.steerBias = 0;
    this.depthTarget = 0;
    this._axisSpring.reset(new Vec3(0, 1, 0));
    this._tilt = SWIM_CONSTANTS.AXIS_TILT_MEAN;
    this._heading = this.rng.range(0, TAU);
    this._headingRate = 0;
    this._spinRate = 0;
    this._periodJitter = 0;
    this._eventTimer = this.rng.exponential(SWIM_CONSTANTS.EVENT_RATE);
    this._skipPending = false;
    this._doubleCyclesLeft = 0;
    this._asymmetry = this.rng.sign() * SWIM_CONSTANTS.MUSCLE_ASYMMETRY;
    this._beginBeat(true);
    if (this.reducedMotion) this._freeze();
    this._updatePose();
    return this;
  }

  /** Switching mode at runtime, for a live `prefers-reduced-motion` change. */
  setReducedMotion(on) {
    this.reducedMotion = !!on;
    if (this.reducedMotion) this._freeze();
    return this;
  }

  /**
   * One frame. `dt` in seconds; the caller should already have clamped it after
   * a tab wake, but it is clamped again here because a nine-hour `dt` reaching
   * the integrator is not a recoverable condition.
   */
  step(dt) {
    const h = clamp(dt, 0, SWIM_CONSTANTS.MAX_STEP);
    this.beatStarted = false;
    this.contractionEnded = false;
    this.beatSkipped = false;
    this.beatDoubled = false;
    this.rebasedThisStep = false;
    this.originShift.zero();
    this.time += h;

    if (this.reducedMotion) {
      this._updatePose();
      return this;
    }
    if (h <= 0) return this;

    this._advanceIrregularity(h);
    this._advancePhase(h);

    this.pulseValue = pulse(this.phase);
    this.dPulse = pulseDerivative(this.phase) * this.phaseRate;
    this.contractionRate = Math.max(0, this.dPulse);
    if (this.contractionRate > this.lastContractionPeak) {
      this.lastContractionPeak = this.contractionRate;
    }

    this._integrateThrust(h);
    this._advanceAxis(h);
    this._rebaseOrigin();
    this._updatePose();
    return this;
  }

  /* --- Irregularity ---------------------------------------------------- */

  /**
   * §4.1's Poisson process. Events are drawn ahead of time and applied to the
   * NEXT beat boundary, so a skip never truncates a contraction that is already
   * under way — a half-finished power stroke reads as a glitch, not a decision.
   */
  _advanceIrregularity(dt) {
    this._eventTimer -= dt;
    let guard = 0;
    while (this._eventTimer <= 0 && guard++ < 8) {
      if (this.rng.float() < SWIM_CONSTANTS.SKIP_PROBABILITY) {
        this._skipPending = true;
      } else {
        this._doubleCyclesLeft = SWIM_CONSTANTS.DOUBLE_CYCLES;
      }
      this._eventTimer += this.rng.exponential(SWIM_CONSTANTS.EVENT_RATE);
    }
  }

  /**
   * A skipped beat is implemented as a stretched relaxation rather than as a
   * frozen phase, for two reasons. Physically it is what a medusa does — the
   * bell simply stays open longer. Mechanically it keeps `phase` inside [0, 1),
   * which is what §4.2's `fract()` needs; a phase parked above 1 would wrap
   * back into the contraction branch and fire a beat the sim did not intend.
   */
  _beginBeat(initial = false) {
    const carrier = 1 + SWIM_CONSTANTS.PERIOD_WANDER *
      Math.sin(TAU * this.time / SWIM_CONSTANTS.PERIOD_WANDER_CARRIER);

    this._periodJitter = ouStep(
      this._periodJitter, 0,
      SWIM_CONSTANTS.PERIOD_JITTER_TAU_BEATS,
      SWIM_CONSTANTS.PERIOD_JITTER_SIGMA,
      1, this.rng
    );

    let period = SWIM_CONSTANTS.BASE_PERIOD * carrier * (1 + this._periodJitter);
    if (this._doubleCyclesLeft > 0) {
      period *= SWIM_CONSTANTS.DOUBLE_PERIOD_SCALE;
      this._doubleCyclesLeft--;
      this.beatDoubled = true;
    }
    period = clamp(period, SWIM_CONSTANTS.PERIOD_MIN, SWIM_CONSTANTS.PERIOD_MAX);

    let hold = 0;
    if (this._skipPending) {
      hold = this.rng.range(SWIM_CONSTANTS.SKIP_HOLD_MIN, SWIM_CONSTANTS.SKIP_HOLD_MAX);
      this._skipPending = false;
      this.beatSkipped = true;
    }

    this._contractionSeconds = C * period;
    this._relaxSeconds = (1 - C) * period + hold;
    this.period = this._contractionSeconds + this._relaxSeconds;
    /* Held constant for the whole beat: `deformTime` depends on it being so. */
    this.frequency = 1 / this.period;
    this.lastContractionPeak = 0;
    if (!initial) {
      this.beatIndex++;
      this.beatStarted = true;
    }
  }

  /**
   * Phase advances at two different rates — one through the contraction, one
   * through the relaxation — so that a stretched relaxation lengthens only the
   * part of the cycle it is supposed to. Boundaries are crossed exactly rather
   * than overshot, which matters at 30 Hz where one frame can be a fifth of a
   * contraction.
   */
  _advancePhase(dt) {
    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 8) {
      const contracting = this.phase < C - 1e-12;
      const rate = contracting
        ? C / this._contractionSeconds
        : (1 - C) / this._relaxSeconds;
      this.phaseRate = rate;

      const edge = contracting ? C : 1.0;
      const dtToEdge = Math.max(0, (edge - this.phase) / rate);
      if (dtToEdge <= remaining) {
        remaining -= dtToEdge;
        if (contracting) {
          this.phase = C;
          this.contractionEnded = true;
        } else {
          this.phase = 0;
          this._beginBeat();
        }
      } else {
        this.phase += rate * remaining;
        remaining = 0;
      }
    }
    /* Report the rate that applies at the phase we actually ended on. */
    this.phaseRate = this.phase < C
      ? C / this._contractionSeconds
      : (1 - C) / this._relaxSeconds;
  }

  /* --- Propulsion ------------------------------------------------------ */

  /**
   * §4.3, integrated. Thrust exists only while the bell is closing; the recoil
   * recovers 30 % of what it can. Drag is quadratic and is applied implicitly
   * (divide, do not subtract) so it is stable at any step size.
   */
  _integrateThrust(dt) {
    const K = SWIM_CONSTANTS;
    const dp = this.dPulse;
    const thrust = K.THRUST_POWER * Math.max(0, dp)
                 + K.THRUST_RECAPTURE * Math.max(0, -dp) * K.RECAPTURE_EFFICIENCY;

    let vel = this.velocity.addScaled(this.bellAxis, (thrust / K.MASS) * dt);
    vel = vel.scale(1 / (1 + K.DRAG * vel.len() * dt));
    vel = vel.withY(vel.y - K.BUOYANCY * dt);

    if (!vel.isFinite()) vel = new Vec3(0, 0, 0);
    this.velocity = vel;
    this.speed = vel.len();
    this.position = this.position.addScaled(vel, dt);
  }

  /* --- Pose ------------------------------------------------------------ */

  /**
   * The bell axis is a τ = 4 s spring toward a slowly wandering target, so it
   * banks into turns and lags after a hard pulse instead of snapping. Tilt is
   * an OU process about a mean near horizontal — that mean is chosen so the
   * vertical component of a beat's impulse very nearly cancels the buoyant
   * sink, and the station-keeping term below removes whatever is left.
   */
  _advanceAxis(dt) {
    const K = SWIM_CONSTANTS;

    this._tilt = ouStep(this._tilt, K.AXIS_TILT_MEAN, K.AXIS_TILT_TAU, K.AXIS_TILT_SIGMA, dt, this.rng);
    this._headingRate = ouStep(this._headingRate, 0, K.AXIS_HEADING_RATE_TAU, K.AXIS_HEADING_RATE_SIGMA, dt, this.rng);
    this._spinRate = ouStep(this._spinRate, 0, K.SPIN_RATE_TAU, K.SPIN_RATE_SIGMA, dt, this.rng);

    /*
     * §3.5's asymmetric coronal muscle, expressed where it actually shows: the
     * turn happens during the power stroke, not continuously, so the animal
     * yaws in discrete nudges the way a real medusa corrects course.
     *
     * `steerBias` joins the same sum. The director already gates its own term
     * on `contractionRate` before writing it here, so a commanded turn arrives
     * as the same discrete power-stroke nudges the asymmetry does rather than
     * as a continuous rudder, and it is then low-passed by the τ = 4 s axis
     * spring below — nothing that enters this line can read as a snap.
     */
    this._heading += (this._headingRate + this._asymmetry * K.MUSCLE_YAW_GAIN * this.contractionRate + this.steerBias) * dt;
    this.spin += this._spinRate * dt;

    /*
     * Station keeping. Depth is the one coordinate the floating origin cannot
     * rebase away — the palette is derived from it — so the animal is steered
     * back toward its band by leaning the bell axis rather than by any
     * artificial force. Positive `position.y` means it has risen, which asks
     * for more tilt (past horizontal, so thrust points down).
     *
     * The band itself is `depthTarget`, which a director may move: the
     * SETPOINT moves, never the gain, so the 22° `DEPTH_KEEP_LIMIT` authority
     * budget is not spent twice. That authority is finite and worth writing
     * down — the fastest this term can climb or sink is
     * `cruise · sin(DEPTH_KEEP_LIMIT) = 0.086 × 0.3746 = 0.0322 m/s`, so any
     * schedule driving `depthTarget` must stay well under that or the animal
     * simply lags its own setpoint and the excursion never materialises.
     *
     * Two terms with two budgets, and the split is the whole point. Inside
     * DEPTH_SOFT_BAND the gentle DEPTH_KEEP_GAIN is the only thing acting,
     * exactly as it always was, so the animal keeps wandering its band on its
     * own terms. Outside it the steeper DEPTH_WALL_GAIN comes in on the EXCESS
     * only — zero at the edge and rising from there, so the join is continuous
     * and there is no discontinuity anywhere the animal normally swims. They
     * are clamped SEPARATELY rather than summed and clamped once, so the
     * shipped ±22° station-keeping budget stays the shipped ±22° and the wall
     * gets the authority it needs on top of it. See the constant block above
     * for why the bias alone could not bound anything: 9°/m is smaller than the
     * animal's own 12° of tilt noise, and 22° of it is not even enough to point
     * a bell that rests 12° above horizontal downward on a bad tilt draw.
     */
    const depthErrorMetres = this.position.y - this.depthTarget;
    const depthExcess = Math.max(0, Math.abs(depthErrorMetres) - K.DEPTH_SOFT_BAND);
    const depthError =
      clamp(depthErrorMetres * K.DEPTH_KEEP_GAIN, -K.DEPTH_KEEP_LIMIT, K.DEPTH_KEEP_LIMIT) +
      clamp(
        Math.sign(depthErrorMetres) * depthExcess * K.DEPTH_WALL_GAIN,
        -K.DEPTH_WALL_LIMIT,
        K.DEPTH_WALL_LIMIT
      );
    const tilt = clamp(this._tilt + depthError, 0.05, Math.PI - 0.05);

    const st = Math.sin(tilt), ct = Math.cos(tilt);
    _axisTarget.set(st * Math.cos(this._heading), ct, st * Math.sin(this._heading));

    /* Perpendicular to the meridian; continuous in heading, unlike a generic basis. */
    _lateral.set(-Math.sin(this._heading), 0, Math.cos(this._heading));
    const tip = K.PULSE_TIP_GAIN * this._asymmetry * this.contractionRate * dt;
    this._axisSpring.velocity = this._axisSpring.velocity.addScaled(_lateral, tip);

    const axis = this._axisSpring.step(_axisTarget, K.AXIS_TAU, dt);
    this.bellAxis = axis.normalizeOr(Vec3.UP);
  }

  /**
   * Hold the animal on a short leash around the origin and hand the removed
   * displacement to whoever else lives in scene space. Checked every frame, so
   * `originShift` is a millimetre at most and applying it is a correction, not
   * a teleport.
   */
  _rebaseOrigin() {
    const R = SWIM_CONSTANTS.ORIGIN_REBASE_RADIUS;
    const d = Math.hypot(this.position.x, this.position.z);
    if (d <= R || d < 1e-9) return;

    const k = (d - R) / d;
    this.originShift.set(-this.position.x * k, 0, -this.position.z * k);
    this.position = this.position.add(this.originShift);
    this.worldOffset = this.worldOffset.sub(this.originShift);
    this.rebasedThisStep = true;
  }

  /**
   * The model matrix takes the bell's own +Y (its apex direction) to the bell
   * axis, then spins about it. Built from a quaternion rather than by
   * assembling a basis, because `rotationTo` handles the antiparallel case and
   * a hand-built basis flips when the axis crosses its reference vector.
   */
  _updatePose() {
    const a = [this.bellAxis.x, this.bellAxis.y, this.bellAxis.z];
    quat.rotationTo(_tiltQuat, _yAxis, a);
    quat.setAxisAngle(_spinQuat, a, this.spin);
    quat.multiply(this.orientation, _spinQuat, _tiltQuat);
    mat4.fromRotationTranslationScale(
      this.modelMatrix, this.orientation,
      [this.position.x, this.position.y, this.position.z],
      [1, 1, 1]
    );
  }

  /** §4.6: hold the prettiest pose and stop the engine. */
  _freeze() {
    this.phase = SWIM_CONSTANTS.REDUCED_MOTION_PHASE;
    this.phaseRate = 0;
    this.pulseValue = pulse(this.phase);
    this.dPulse = 0;
    this.contractionRate = 0;
    this.velocity.zero();
    this.speed = 0;
  }
}
