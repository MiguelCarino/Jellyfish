/* ============================================================
   director.js — the tank, the station, and the slow schedule.
   ------------------------------------------------------------
   Pure CPU. There is no GL object, no DOM node, no uniform name
   and no line of GLSL in this file, and there must never be one:
   everything it decides reaches the frame through values the
   renderer was already setting every frame anyway — `uSunDir`,
   `uCamY`, `uSunCol` by way of the animal's own depth, and the
   caustic clock. That is why a mode this ambitious costs zero
   programs, zero relinks and zero new uniforms.

   It owns three things.

   1. THE TANK. The animal is kept inside a soft 1.85 m cylinder
      about the WORLD origin. This is a STEERING BOUND and never
      a position clamp. Cruise is 0.086 m/s against a quadratic
      drag of 7.5 with a thrust power of 0.10 (§4.3), so a
      positional force would either do nothing at all or read as
      a shove; steering the bell axis is the only lever the
      physics respects. The bias is written into `swim.steerBias`
      already multiplied by `contractionRate`, so the correction
      arrives as discrete power-stroke nudges — the idiom §3.5's
      muscle asymmetry already ships on that exact line — and is
      then low-passed by the τ = 4 s axis spring. Nothing here
      can produce a snap, and nothing here touches
      `swim.position`: the tank is expressed entirely in
      `swim.worldPosition` / `swim.worldOffset`.

      The bound is on in BOTH framings. One simulation, two
      cameras. Mode-dependent physics would make the soak's
      measurements mode-dependent and would let a switch back to
      the station find the animal thirty metres away.

   2. THE STATION. A world-fixed observation point 3.10 m out
      that crawls one lap of the rim every 1440 s. The animal
      appears to traverse a volume because the CAMERA STOPS
      FOLLOWING IT, not because the leash was raised:
      ORIGIN_REBASE_RADIUS is still 0.5 m and `_rebaseOrigin()`
      is untouched (§4.3). The station is held in WORLD
      coordinates here and converted to scene space in
      `compose()` against the current `swim.worldOffset`, so it
      is rebase-exact by construction — which is exactly why the
      director must NOT be added to main.js's rebase broadcast
      list. Adding it would apply `originShift` twice and the
      station would drift out of the world at the rebase rate.

   3. THE SCHEDULE. Six slow drivers that keep the light and the
      water moving over minutes rather than seconds. Two rules
      shape all of them, and both are load-bearing.

      EVERY CARRIER IS LONGER THAN 300 s. §10's acceptance check
      forbids any FFT peak in frame-mean luminance at a period
      between 20 s and 300 s, so no carrier in `PERIODS` may
      enter that band.

      AND CARRIERS ARE COMBINED ADDITIVELY, NEVER MULTIPLIED.
      A sum of sinusoids has energy only at its own frequencies,
      but a PRODUCT has energy at the sum and difference
      frequencies too — multiplying the 511 s and 743 s depth
      carriers would place a component at
      1/(1/511 + 1/743) = 302.7 s, three seconds outside the
      forbidden band and inside it the moment either period is
      retuned. Every combination below is a `+`. If a future
      driver needs to be gated by another, gate it on a
      smoothstep of a POSITION, not on a second carrier.

   ONE CORRECTION TO RECORD, BECAUSE IT IS COUNTER-INTUITIVE AND
   SOMEONE WILL TRY TO "FIX" IT. A station three metres from the
   scene origin does not need a larger flow grid. The marine snow
   advects on `flow.sampleAmbient` (js/sim/snow.js), which is the
   RAW ANALYTIC sampler (js/sim/flow.js) and is valid at any
   coordinate — not the tabulated `_gridAt`. The grid exists only
   for the strands and the frame velocity, both
   of which live on an animal that never leaves scene ±0.5 m, so
   FLOW_CONSTANTS.GRID_HALF_EXTENT and GRID_RESOLUTION must NOT
   be enlarged to chase the camera. Enlarging them would coarsen
   the cell the tentacles actually feel and cost a slice of curl
   noise per frame, in exchange for nothing.

   Randomness is the seeded `Rng` from math.js, as everywhere
   else. `Math.random` is banned across js/ and the policy gate
   greps for it.
   ============================================================ */

import { Vec3, Rng, TAU, clamp, smoothstep, ouStep } from '../math.js';
import { CAMERA_CONSTANTS } from '../camera.js';

export const DIRECTOR_CONSTANTS = Object.freeze({
  /* --- The tank ------------------------------------------------------ */
  /*
   * Where the wall steering begins. 0.85 m inside TANK_RADIUS, which at the
   * 0.086 m/s cruise is about ten seconds of travel — enough for the τ = 4 s
   * axis spring to complete a bank before the animal reaches the wall, so the
   * correction never reads as a snap.
   */
  TANK_SOFT_RADIUS: 1.00,
  /*
   * Full urgency. A 3.7 m disc is roughly 43 s corner to corner at cruise, so
   * over any two minutes at the station the animal makes several full
   * traverses. It is sized against CAMERA_CONSTANTS.STATION_RADIUS so that the
   * subject distance ranges 1.35–5.15 m, which is what produces the
   * path-length colour cue described beside STATION_RADIUS, without the far
   * end reading as nothing to watch.
   */
  TANK_RADIUS: 1.85,
  /*
   * The overdrive band, and the geometric bound the ordering assertions are
   * written against. 0.20 m past TANK_RADIUS, well inside a single turn arc,
   * so the overdrive is a backstop that is rarely reached rather than a second
   * wall the animal bounces off.
   */
  TANK_HARD_RADIUS: 2.05,
  /*
   * How far ahead the wall is read, in seconds of the animal's own velocity.
   * THIS IS THE TERM THAT MAKES THE TANK HOLD, and it was the one thing the
   * first cut of this design left out, so the reason is worth writing down at
   * length.
   *
   * Turning is not gain-limited here, it is TIME-limited, and by two things
   * that no amount of heading bias can shorten. The bell axis is a τ = 4 s
   * spring toward its target (js/sim/swim.js), so the thrust direction reaches
   * a commanded reversal about four seconds after the heading does; and the
   * velocity that is already there decays only through the quadratic drag, on
   * a timescale of 1/(DRAG · cruise) = 1/(7.5 × 0.086) = 1.55 s. A full
   * reversal therefore costs something like eight to ten seconds however hard
   * it is commanded, which at cruise is 0.7–0.9 m of travel in the wrong
   * direction. A wall that reads only the CURRENT radius is a proportional
   * controller against a plant with an eight-second lag, and it overshoots by
   * exactly that lag: measured, the animal ran 1.4 m past TANK_RADIUS and out
   * to 3.24 m, straight through the station's standoff.
   *
   * So the urgency is evaluated at `max(r, |p + v·TANK_LEAD_SECONDS|)` — the
   * radius the animal will have if it holds its course for eight seconds,
   * floored by the radius it has now. That is the derivative term the plant
   * needs, and eight seconds is chosen to match the lag it is compensating
   * rather than by taste. Two properties fall out of it that a plain radial
   * wall does not have: an animal already curving inward or running the rim
   * tangentially is left alone at any radius, so the correction appears only
   * when it is actually needed; and the `max` floor means this can never be
   * WEAKER than the radius-only wall, only earlier. Measured over four hours
   * on six seeds the animal now peaks at 1.83–2.25 m against the 2.45 m
   * standoff line, with a mean radius of 1.2 m — it still crosses the volume,
   * it simply no longer leaves it.
   *
   * The lead vector breathes with the beat, because `swim.velocity` swings
   * from 0.046 to 0.115 m/s across a pulse. That is 0.37–0.92 m of lead at the
   * 1.3 s beat period, and it is harmless: the whole bias is gated on
   * `contractionRate` and is then low-passed by the same τ = 4 s axis spring,
   * which attenuates a 1.3 s ripple to nothing.
   */
  TANK_LEAD_SECONDS: 8.0,
  /*
   * Radians per second of heading bias per unit of contraction rate at full
   * urgency. With a mean contractionRate near 0.45 this commands about
   * 0.45 × 0.45 = 0.20 rad/s against the animal's own
   * AXIS_HEADING_RATE_SIGMA = 0.055 — nearly four times its natural
   * random-walk rate, and only inside the outer annulus. Because the wall is
   * read eight seconds ahead the correction starts early and this gain is
   * spent on shaping a bank rather than on rescuing an escape: the commanded
   * turn is roughly 0.20 rad/s sustained, so a 180° reversal is a fifteen
   * second arc, the same size as the ones the animal already makes unprompted.
   * Raising it further buys very little — past about 0.7 the τ = 4 s axis
   * spring, not the command, is what the turn is waiting for.
   */
  TANK_STEER_GAIN: 0.45,
  /*
   * Removes the unstable equilibrium at Δheading = π, where sin Δ = 0 would
   * otherwise hand the steering zero authority at exactly the moment the
   * animal is pointed straight at the wall. The term is continuous, zero at
   * Δ = 0, and its sign is drawn once from the seeded rng exactly as
   * `swim._asymmetry` is, so an animal always turns the same way out of a
   * head-on approach.
   *
   * It is sized so that head-on is not the weak case: at Δ = π the tie-break
   * contributes 2 × 0.45 = 0.90, i.e. 90 % of the authority the broadside case
   * gets from sin Δ = 1. Containment is decided almost entirely on head-on
   * approaches, so handing that case a tenth of the available authority — as
   * a 0.18 tie-break does — spends the whole gain in the one geometry where it
   * cannot be spent.
   */
  TANK_TIE_BREAK: 0.45,
  /*
   * Extra urgency added across the hard band, so the total gain there is
   * 1.6 × TANK_STEER_GAIN. Enough to guarantee the turn, small enough that the
   * overdrive does not read as a bounce.
   */
  TANK_HARD_OVERDRIVE: 0.6,

  /* --- The lens keep-out --------------------------------------------- */
  /*
   * The animal steers away from the station inside this band. 1.35 m is chosen
   * above SNOW_FOCUS_MIN = 1.0 (js/shaders/snow.js) so the near-snow bokeh
   * refocus term never clips at the moment it would be most visible, and above
   * the subject rig's own 1.30 m minimum so frame.js's `nearIsExumbrella`
   * shell swap is never exercised harder than it already is today. Closest
   * approach is therefore a guarantee about the compositing, not only about
   * the framing.
   */
  STATION_KEEPOUT_HARD: 1.35,
  STATION_KEEPOUT_SOFT: 2.00,
  /*
   * Below the wall's TANK_STEER_GAIN = 0.45 in absolute terms, and deliberately
   * so. Per metre of band the two very nearly match — 0.34 / 0.65 = 0.52
   * against 0.45 / 0.85 = 0.53 — and the keep-out needs no more than that,
   * because here the wall is a CO-OPERATING term rather than a competing one.
   * The station stands at STATION_RADIUS = 3.10 m while the animal is bounded
   * at TANK_HARD_RADIUS = 2.05 m, so the animal is always between the origin
   * and the station, and the wall's "back toward the middle" command is also a
   * command away from the station everywhere `keep` is non-zero. Sweeping the
   * whole reachable disc, the wall's component toward the station is at worst
   * −0.174 and is negative wherever `keep` exceeds 1e-4: the larger gain next
   * door is an ally, not a rival.
   *
   * It is also why this term carries no overdrive band the way the wall does.
   * The closest approach is geometric rather than gain-dependent — 3.10 − 2.05
   * = 1.05 m of horizontal clearance, asserted against STATION_STANDOFF in the
   * constructor — and `keep` is already saturated at 1.0 well outside that, so
   * an overdrive would add urgency to a term that is already at full strength.
   * (Note that `keep` is computed on HORIZONTAL distance, not 3-D, and that
   * STATION_KEEPOUT_HARD is where the term saturates rather than a floor the
   * animal is held at.) An animal avoiding an object in the tank is the most
   * natural steering there is; nothing about it reads as a rule being
   * enforced, and a gain above the wall's would.
   */
  STATION_KEEPOUT_GAIN: 0.34,

  /* --- The depth schedule -------------------------------------------- */
  /*
   * The two depth carriers, in metres of scene-space setpoint. Both periods
   * are prime and far outside §10's forbidden 20–300 s band, and they are
   * summed rather than multiplied: their product would fold a component to
   * 1/(1/511 + 1/743) = 302.7 s, three seconds outside the band.
   *
   * Depth is the whole lighting design in one line. KD = (0.420, 0.075, 0.032)
   * 1/m and the animal's key light is `downwelling(_sunCol, swim.worldY)`, so
   * over the realised depth range the red changes by 2.65×, the green by 1.19×
   * and the blue by 1.08× — a chroma excursion far more than a luminance one,
   * derived from the medium rather than graded.
   */
  DEPTH_A_AMPLITUDE: 0.22,
  DEPTH_A_PERIOD: 511.0,
  DEPTH_B_AMPLITUDE: 0.14,
  DEPTH_B_PERIOD: 743.0,
  /*
   * The broadband component, and the one doing most of the work. An
   * Ornstein–Uhlenbeck process has red-noise energy at every frequency and no
   * spectral peak at all, which is what guarantees the frame-mean luminance
   * trace has two broad shoulders rather than two spikes. Its typical rate,
   * σ·√(2/τ) = 0.10·√(2/180) = 0.0105 m/s, is larger than both carriers
   * combined.
   */
  DEPTH_OU_SIGMA: 0.10,
  DEPTH_OU_TAU: 180.0,
  DEPTH_OU_MAX: 0.20,
  /*
   * Hard clamp on the summed SETPOINT — which is not the same thing as a bound
   * on the animal, and the difference is worth stating precisely because it was
   * got wrong once. This clamp says where the animal is ASKED to be. Where it
   * actually goes is set by `swim._advanceAxis`'s depth term, and until that
   * term was given a wall outside DEPTH_SOFT_BAND it could not hold a band at
   * all: measured over eight hours at the shipped seed, `position.y` had σ =
   * 0.71 m and spanned −2.40 … +2.19 m. The σ was being quoted as if it were
   * the range. With the wall the realised span is −1.11 … +1.16 m, i.e. a depth
   * of −15.16…−12.84 m, still inside the (−18, −10) band tests/check.mjs
   * asserts with nearly three metres of margin either side, and now bounded by
   * something rather than merely observed.
   *
   * THE AUTHORITY CHECK, WHICH IS THE NUMBER THAT MAKES THIS WORK. The
   * animal's own maximum vertical speed is
   * cruise · sin(DEPTH_KEEP_LIMIT) = 0.086 · sin 22° = 0.0322 m/s. The
   * schedule's peak rate is
   * 0.22·τ/511 + 0.14·τ/743 + 0.10·√(2/180)
   *   = 0.002705 + 0.001184 + 0.010541 = 0.01443 m/s, which is 45 % of that.
   * At 45 % the animal TRACKS its setpoint and the KD swing actually arrives;
   * much above 60 % it lags, the excursion never materialises, and the whole
   * schedule becomes an expensive way to do nothing. tests/check.mjs asserts
   * the ratio so an amplitude cannot be raised past it by accident.
   */
  DEPTH_TARGET_MAX: 0.55,

  /* --- The caustic clock rate ---------------------------------------- */
  /*
   * The rate multiplier on the caustic clock, ranging [0.72, 1.00]: NEVER
   * faster than shipped, so js/shaders/cookie.js's measured rate budget for
   * COOKIE_SHARPNESS = 2.5 and its "COOKIE_LAYER_DRIFT must not be raised"
   * requirement are respected by construction rather than by care, and
   * tests/check.mjs asserts the ceiling. The minimum of 0.72 keeps the clock
   * strictly forward-running, because it is a rate on a held clock and a
   * negative one would run the surface backwards.
   *
   * Because `causticTime` feeds both `uCookieTime` and
   * `cookieDrift(_drift, causticTime)`, this one multiplier changes the
   * surface's internal animation AND its bulk advection coherently — the chop
   * calms and picks up again over about eleven minutes, which three separate
   * drivers could not do without disagreeing with each other.
   */
  CAUSTIC_RATE_MEAN: 0.86,
  CAUSTIC_RATE_SWING: 0.14,
  CAUSTIC_RATE_PERIOD: 640.0,

  /* --- Reduced motion ------------------------------------------------ */
  /*
   * §4.6 stops the camera drift outright but asks that grain, dither and
   * exposure stay alive so the image still breathes. The optical schedule is
   * on that side of the line, so it runs at 15 % rather than stopping: the sun
   * still drifts and the caustics still flow, over hours instead of minutes.
   * The value matches COOKIE_TIME_SCALE_REDUCED exactly and tests/check.mjs
   * asserts the two cannot drift apart. It is applied as a RATE on a held
   * clock, never as a rescaling of absolute time, so throwing the OS switch on
   * an hour-old page slows the schedule where it stands instead of teleporting
   * it.
   */
  REDUCED_LIGHT_RATE: 0.15,

  /*
   * The policy-checkable manifest of every carrier in the design: the four
   * director periods above plus the camera's STATION_HEIGHT_PERIOD,
   * STATION_BEARING_PERIOD and SUN_ELEVATION_PERIOD. tests/check.mjs asserts
   * every entry exceeds 300 s and that the list is exactly that set, so a new
   * carrier cannot be added without either appearing here or failing the gate.
   * It is the cheapest possible guard on §10's FFT clause, and the only one
   * this repository can run without a GPU.
   */
  PERIODS: Object.freeze([511.0, 640.0, 743.0, 1310.0, 1440.0, 1730.0])
});

/**
 * The tank, the station and the schedule. Construct one; call `step(dt, swim)`
 * once per frame BEFORE the animal steps, and `compose(swim, mode)` once per
 * frame AFTER it, then hand `stationScene` / `aimTarget` / `aimVelocity` to
 * `camera.setStation()`. Everything is deterministic from the seed.
 *
 * The split into two calls is not decoration. `step()` writes the animal's
 * commands and must run before `swim.step(dt)` consumes them; `compose()`
 * converts world coordinates to scene coordinates and must run after the
 * animal's possible rebase, against the `worldOffset` that came out of it.
 */
export class Director {
  /**
   * `seed` names the schedule's phases and the tie-break sign. `reducedMotion`
   * holds the station clock and slows the optical one, per §4.6.
   */
  constructor({ seed = 'aurelia-director', reducedMotion = false } = {}) {
    const D = DIRECTOR_CONSTANTS;
    const K = CAMERA_CONSTANTS;

    this.rng = new Rng(seed);
    this.reducedMotion = reducedMotion;

    /*
     * Two clocks, deliberately. The optical one keeps running under reduced
     * motion at REDUCED_LIGHT_RATE; the station one stops dead, because §4.6
     * says camera drift stops and the station's height and bearing are camera
     * drift. Both are integrated rather than derived from a global time, so a
     * rate change is a change of rate and never a jump.
     */
    this.lightTime = 0;
    this.stationTime = 0;

    /*
     * Everything below is rewritten by `step()` before anything reads it; the
     * values here are the schedule's rest values, so a director that is
     * constructed and never stepped is still a valid, static, correct scene.
     */
    this.causticRate = D.CAUSTIC_RATE_MEAN;
    this.sunElevation = K.SUN_ELEVATION;
    this.depthTarget = 0;
    this.animalRadius = 0;

    /*
     * The station is held in WORLD coordinates as a plain array — it is
     * written every step and read twice, and a Vec3 here would buy nothing but
     * an allocation. `compose()` is what converts it to the scene space the
     * camera actually lives in.
     */
    this.stationWorld = [0, 0, 0];
    this.stationScene = new Vec3();
    this.aimTarget = new Vec3();
    this.aimVelocity = new Vec3();

    /*
     * Four carrier phases, the station's starting bearing and the tie-break
     * sign, drawn in this order. `reset()` re-draws them in the same order
     * from the same restarted stream, so a context restore comes back with the
     * identical schedule rather than merely a similar one.
     */
    this._phaseDepthA = this.rng.range(0, TAU);
    this._phaseDepthB = this.rng.range(0, TAU);
    this._phaseCaustic = this.rng.range(0, TAU);
    this._phaseStationHeight = this.rng.range(0, TAU);
    this._stationBearing0 = this.rng.range(0, TAU);
    this._turnSign = this.rng.sign();
    this._depthOu = 0;

    /*
     * The one assertion that stops the animal ever getting behind the lens.
     * The station stands STATION_RADIUS from the world origin and the animal
     * is bounded at TANK_HARD_RADIUS, so their closest possible approach is
     * the difference; STATION_STANDOFF is the floor that difference has to
     * clear. Shipped: 3.10 − 2.05 = 1.05 m against a floor of 0.65, i.e.
     * 0.40 m of margin. It is asserted here as well as in tests/check.mjs
     * because it is an ordering between constants owned by two different
     * files, and the failure mode — a bell clipping through the near plane —
     * produces no error at all, only a wrong image.
     */
    const standoff = K.STATION_RADIUS - D.TANK_HARD_RADIUS;
    if (standoff < K.STATION_STANDOFF) {
      throw new Error(
        'director.js: a station at ' + K.STATION_RADIUS.toFixed(2) +
        ' m and an animal bounded at ' + D.TANK_HARD_RADIUS.toFixed(2) +
        ' m leave only ' + standoff.toFixed(2) + ' m of standoff, below the ' +
        K.STATION_STANDOFF.toFixed(2) +
        ' m needed to keep the animal in front of the lens. ' +
        'Raise STATION_RADIUS or lower TANK_HARD_RADIUS.'
      );
    }
  }

  /**
   * The schedule's sun elevation in degrees, for the `?dev=1` readout.
   *
   * The camera applies this same carrier itself, from `sunTime`, with its own
   * per-run phase draw — so this agrees with the rendered sun in rest, swing
   * and period but not in phase. Nothing in the render path reads it; it
   * exists so the panel can show that the carrier is alive and inside its
   * 66–78° band.
   */
  get sunElevationDegrees() {
    return this.sunElevation * 180 / Math.PI;
  }

  setReducedMotion(on) {
    this.reducedMotion = !!on;
    return this;
  }

  /**
   * Plant the station at the bearing the camera already has about the tank
   * centre. This is what makes key 1 a dolly rather than a sweep: with the
   * lateral component removed the blend into station framing is almost purely
   * radial, and a radial move is the least disruptive direction through the
   * snow field — motes stream past rather than sweeping across strata.
   *
   * `cameraPositionScene` is scene space and the station is world space, so
   * the animal's current `worldOffset` is what converts between them.
   */
  enterTank(cameraPositionScene, swim) {
    const cx = cameraPositionScene.x + swim.worldOffset.x;
    const cz = cameraPositionScene.z + swim.worldOffset.z;
    this._stationBearing0 = Math.atan2(cz, cx) -
      TAU * this.stationTime / CAMERA_CONSTANTS.STATION_BEARING_PERIOD;
    return this;
  }

  /**
   * Advance both clocks, evaluate the six drivers, place the station, and hand
   * the animal its two commands. Call this once per frame BEFORE `swim.step()`.
   *
   * It reads last frame's `contractionRate` and world position, which is 16 ms
   * of staleness against a 1.3 s beat and a 4 s axis spring. That is
   * deliberate and must not be "fixed" into a two-pass ordering: the frame
   * order main.js documents at the top of the file is load-bearing.
   */
  step(dt, swim) {
    const D = DIRECTOR_CONSTANTS;
    const K = CAMERA_CONSTANTS;
    /*
     * The same 0.25 s ceiling camera.js clamps to, and for the same reason: a
     * backgrounded tab comes back with one enormous dt, and neither the light
     * nor the station should jump a minute on the frame it returns.
     */
    const h = clamp(dt, 0, 0.25);

    this.lightTime += h * (this.reducedMotion ? D.REDUCED_LIGHT_RATE : 1);
    this.stationTime += this.reducedMotion ? 0 : h;

    /*
     * L6, the caustic clock rate, and L5, the sun's elevation. Both are pure
     * functions of `lightTime`, so they are exact at any h including 0 — which
     * is what lets main.js call `step(0, swim)` at boot to prime the pose
     * without advancing anything.
     */
    this.causticRate = D.CAUSTIC_RATE_MEAN + D.CAUSTIC_RATE_SWING *
      Math.sin(TAU * this.lightTime / D.CAUSTIC_RATE_PERIOD + this._phaseCaustic);
    this.sunElevation = K.SUN_ELEVATION + K.SUN_ELEVATION_SWING *
      Math.sin(TAU * this.lightTime / K.SUN_ELEVATION_PERIOD);

    /*
     * L1 and L2, the depth carriers, summed with L3's broadband term. The
     * three are ADDED — see the file header for why a product is forbidden.
     */
    const depthA = D.DEPTH_A_AMPLITUDE *
      Math.sin(TAU * this.lightTime / D.DEPTH_A_PERIOD + this._phaseDepthA);
    const depthB = D.DEPTH_B_AMPLITUDE *
      Math.sin(TAU * this.lightTime / D.DEPTH_B_PERIOD + this._phaseDepthB);

    /*
     * L3. Guarded on h > 0 because `ouStep` consumes an rng draw: at boot and
     * on the priming step main.js makes with dt = 0, an unguarded call would
     * advance the stream without advancing time, and the schedule would depend
     * on how many zero-length steps the page happened to take.
     */
    if (h > 0) {
      this._depthOu = clamp(
        ouStep(this._depthOu, 0, D.DEPTH_OU_TAU, D.DEPTH_OU_SIGMA, h, this.rng),
        -D.DEPTH_OU_MAX, D.DEPTH_OU_MAX
      );
    }
    this.depthTarget = clamp(depthA + depthB + this._depthOu,
      -D.DEPTH_TARGET_MAX, D.DEPTH_TARGET_MAX);

    /*
     * F1 and L4: the station's bearing crawls one lap in STATION_BEARING_PERIOD
     * from wherever `enterTank` planted it, and its height rides a much slower
     * carrier of its own. Both are on `stationTime`, so both freeze outright
     * under reduced motion.
     */
    const bearing = this._stationBearing0 +
      TAU * this.stationTime / K.STATION_BEARING_PERIOD;
    const height = K.STATION_HEIGHT_MEAN + K.STATION_HEIGHT_SWING *
      Math.sin(TAU * this.stationTime / K.STATION_HEIGHT_PERIOD + this._phaseStationHeight);
    this.stationWorld[0] = K.STATION_RADIUS * Math.cos(bearing);
    this.stationWorld[1] = height;
    this.stationWorld[2] = K.STATION_RADIUS * Math.sin(bearing);

    /*
     * The animal's world position, read componentwise. Never `swim.worldPosition`
     * — that getter allocates a Vec3, and this runs every frame.
     */
    const wx = swim.position.x + swim.worldOffset.x;
    const wz = swim.position.z + swim.worldOffset.z;
    this.animalRadius = Math.hypot(wx, wz);

    /*
     * The radius the wall is actually read at: where the animal will be in
     * TANK_LEAD_SECONDS if it holds its course, floored by where it is now.
     * The reasoning is written out beside TANK_LEAD_SECONDS — briefly, the
     * animal needs eight to ten seconds to reverse and a wall that reads only
     * the current radius overshoots by exactly that lag. The `max` is what
     * makes this strictly stronger than a radius-only wall rather than merely
     * different: an animal already heading home keeps its urgency, and an
     * animal heading out gets it early.
     */
    const leadRadius = Math.hypot(
      wx + swim.velocity.x * D.TANK_LEAD_SECONDS,
      wz + swim.velocity.z * D.TANK_LEAD_SECONDS
    );
    const wallRadius = Math.max(this.animalRadius, leadRadius);

    let bias = 0;

    /*
     * The wall. Urgency ramps from TANK_SOFT_RADIUS to TANK_RADIUS and then
     * gains TANK_HARD_OVERDRIVE more across the hard band, and the target
     * heading is simply "back toward the middle", atan2(−wz, −wx) — the target
     * is taken from where the animal IS, never from where it is predicted to
     * be, so only the urgency leads and the aim itself cannot be thrown off by
     * a beat's worth of velocity. Both edges ascend, because `smoothstep`
     * saturates at both ends and reversed edges would misbehave rather than
     * invert.
     */
    const urgency = smoothstep(D.TANK_SOFT_RADIUS, D.TANK_RADIUS, wallRadius) +
      D.TANK_HARD_OVERDRIVE *
      smoothstep(D.TANK_RADIUS, D.TANK_HARD_RADIUS, wallRadius);
    if (urgency > 1e-4) {
      bias += D.TANK_STEER_GAIN * this._turnTerm(Math.atan2(-wz, -wx), swim.heading) * urgency;
    }

    /*
     * The lens keep-out, written as `1 −` an ascending smoothstep for the same
     * saturation reason: it is full strength at STATION_KEEPOUT_HARD and gone
     * by STATION_KEEPOUT_SOFT. The target heading points directly AWAY from
     * the station, atan2(lz, lx) on the station-to-animal vector.
     */
    const lx = wx - this.stationWorld[0];
    const lz = wz - this.stationWorld[2];
    const lensD = Math.hypot(lx, lz);
    const keep = 1 - smoothstep(D.STATION_KEEPOUT_HARD, D.STATION_KEEPOUT_SOFT, lensD);
    if (keep > 1e-4) {
      bias += D.STATION_KEEPOUT_GAIN * this._turnTerm(Math.atan2(lz, lx), swim.heading) * keep;
    }

    /*
     * Gated on the contraction rate here rather than in swim.js, so the bias
     * arrives as discrete power-stroke nudges exactly as the muscle asymmetry
     * does. Both commands are written unconditionally: under reduced motion
     * `swim.step()` returns before `_advanceAxis` and both become inert with no
     * branch needed on either side.
     */
    swim.steerBias = bias * swim.contractionRate;
    swim.depthTarget = this.depthTarget;

    return this;
  }

  /**
   * How hard to turn, in units of gain, to bring `heading` onto
   * `targetHeading`. Only sines and cosines of the difference are used, so the
   * unwrapped heading `swim.heading` accumulates needs no wrapping.
   *
   * The tie-break is what removes the unstable equilibrium at Δ = π, where
   * sin Δ = 0 would otherwise give zero authority at exactly the moment the
   * animal is pointed straight at the wall. It is continuous, zero at Δ = 0,
   * and its sign is drawn once from the seeded rng so an animal always turns
   * the same way out of a head-on approach.
   */
  _turnTerm(targetHeading, heading) {
    const d = targetHeading - heading;
    return Math.sin(d) + DIRECTOR_CONSTANTS.TANK_TIE_BREAK * (1 - Math.cos(d)) * this._turnSign;
  }

  /**
   * Convert the station and the aim into the scene space the camera lives in,
   * against the `worldOffset` this frame's rebase left behind. Call this once
   * per frame AFTER `swim.step()` and before `camera.setStation()`.
   *
   * `mode` is accepted and deliberately unused. The station aim is computed in
   * EVERY mode, because the camera's own `_modeMix` can be mid-transition and
   * a station that stopped updating during a blend would drag the aim behind
   * the animal for the nine seconds the ease takes.
   *
   * THE DEAD BAND IS THE WHOLE MODE. While the animal works the middle of the
   * volume the aim does not move at all and the animal crosses the frame;
   * only beyond STATION_AIM_DEADBAND does the head yield, at
   * STATION_AIM_GAIN of the excess. That single number is what makes this read
   * as a tank rather than as a Steadicam, and it is why the animal grazes the
   * edge of frame on the widest passes.
   */
  compose(swim, mode) {
    const K = CAMERA_CONSTANTS;

    const ox = swim.worldOffset.x, oy = swim.worldOffset.y, oz = swim.worldOffset.z;
    this.stationScene.set(
      this.stationWorld[0] - ox,
      this.stationWorld[1] - oy,
      this.stationWorld[2] - oz
    );

    const ax = swim.position.x + ox, ay = swim.position.y + oy, az = swim.position.z + oz;
    const len = Math.hypot(ax, az);

    /*
     * Under reduced motion the dead band is dropped and the follow goes to
     * full gain, so the frozen animal is centred rather than stranded off
     * frame. The camera's two aim clamps — the height ceiling and the minimum
     * aim distance, which are the terms its elevation assertion is built on —
     * are applied on the camera's side and still hold here.
     */
    let follow = 0;
    if (this.reducedMotion) follow = 1;
    else if (len > K.STATION_AIM_DEADBAND) {
      follow = (len - K.STATION_AIM_DEADBAND) * K.STATION_AIM_GAIN / len;
    }
    let px = ax * follow, pz = az * follow;
    if (!this.reducedMotion) {
      const plen = Math.hypot(px, pz);
      if (plen > K.STATION_AIM_MAX_OFFSET) {
        const k = K.STATION_AIM_MAX_OFFSET / plen;
        px *= k;
        pz *= k;
      }
    }

    /* Vertical follow is full gain: depth is the only vertical cue the mode
       has, and the camera clamps the height on its own side. */
    this.aimTarget.set(px - ox, ay - oy, pz - oz);

    /*
     * The aim's velocity, not the animal's, because the camera leads this
     * point by 2·LOOK_TAU: a lead on the raw animal speed would overshoot by
     * the reciprocal of the follow gain. Zero horizontally when the animal is
     * inside the dead band, which is the same statement as "the head is still".
     */
    const vf = this.reducedMotion ? 0 : follow;
    this.aimVelocity.set(swim.velocity.x * vf, swim.velocity.y, swim.velocity.z * vf);

    return this;
  }

  /**
   * Rebuild from the seed after a context restore, so the schedule comes back
   * identical rather than merely similar — the same idiom `Swim.reset()` uses,
   * with the draws in the constructor's order.
   *
   * The derived fields go back to the rest values a fresh construction leaves
   * behind rather than being recomputed at t = 0: main.js's restore path calls
   * `step()` before anything reads them, exactly as boot does, and a reset
   * whose state differs from a fresh construction is a bug waiting for a long
   * enough soak.
   */
  reset() {
    const D = DIRECTOR_CONSTANTS;
    const K = CAMERA_CONSTANTS;

    this.rng.reset();
    this.lightTime = 0;
    this.stationTime = 0;
    this._depthOu = 0;

    this._phaseDepthA = this.rng.range(0, TAU);
    this._phaseDepthB = this.rng.range(0, TAU);
    this._phaseCaustic = this.rng.range(0, TAU);
    this._phaseStationHeight = this.rng.range(0, TAU);
    this._stationBearing0 = this.rng.range(0, TAU);
    this._turnSign = this.rng.sign();

    this.causticRate = D.CAUSTIC_RATE_MEAN;
    this.sunElevation = K.SUN_ELEVATION;
    this.depthTarget = 0;
    this.animalRadius = 0;
    this.stationWorld[0] = 0;
    this.stationWorld[1] = 0;
    this.stationWorld[2] = 0;
    this.stationScene.zero();
    this.aimTarget.zero();
    this.aimVelocity.zero();

    return this;
  }
}
