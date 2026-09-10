/* ============================================================
   camera.js — the rig, and the anti-flare geometry.
   ------------------------------------------------------------
   Spec §4.5. A 38° lens on a very slow Lissajous drift, damped
   into place, looking loosely at the animal through a slowly
   wandering error vector so the jellyfish drifts around the
   frame instead of being pinned to the centre. Pinning is the
   instant tell of a tech demo.

   THREE FRAMINGS, ONE RIG. The above is the SUBJECT rig, and it
   is still exactly what it was: an orbit anchored to the animal
   at 1.3–2.2 m through a 38° lens. Beside it there is a STATION
   framing, in which the eye is anchored in WORLD space 3.10 m
   out, the lens is 28°, and the aim holds still through a 0.55 m
   dead band while the animal crosses a bounded volume in front
   of it. And beside that a CLOSE framing: the same
   subject-anchored orbit pulled in to 1.35 ± 0.15 m on a 30°
   lens, held 6–14° BELOW the animal and on the far side of it
   from the sun, so the shot permanently looks up through a
   backlit bell.

   The three are computed every frame and blended by a WEIGHT
   SIMPLEX, `_w = {free, tank, close}`, whose members ease toward
   one-hot on the same MODE_TAU exponential the old scalar
   `_modeMix` rode and whose sum is conserved analytically —
   Σw' = Σw + k(1 − Σw) = 1 — so there is no renormalisation and
   no division anywhere in the ease. A simplex rather than a
   second scalar beside the first, because two independently
   eased scalars can put the rig at a pose on no edge of the
   simplex, whose elevation nobody derived, and because a simplex
   re-targets mid-ease correctly BY CONSTRUCTION — which is the
   case the third key invites, pressing "3" four frames into a
   1 → 2 ease whose "from" pose is not one of the three framings.
   sim/director.js drives the tank weight through `setStation()`;
   main.js switches with `setMode()`. `get modeMix()` is still
   `_w.tank` and still means exactly what it always did.

   The blend is on the DESIRED eye and the look centre, before
   the springs — never on the matrices — so there is no cut, no
   teleport and nothing to invalidate. Free and close are the
   SAME orbit at a different radius, elevation, azimuth and drop,
   so what is blended between those two is the four SCALARS and
   the sphere is evaluated once: blending two eye POSITIONS would
   cut a chord through the sphere and swing the camera sideways
   through the snow strata for the whole of a 3 s ease, which is
   the one direction `_reseedOrbitAzimuth` exists to avoid. At
   `_w.free === 1` the subject rig is the shipped page bit for
   bit: the blend short-circuits to the free eye with no
   arithmetic at all, the station clamps are identities, and
   `fovY` is FOV_Y exactly.

   THE ELEVATION CLAMP IS STRUCTURAL, NOT COSMETIC. The judge
   panel's worst finding against the winning proposal was a
   designed-in periodic flare: a forward-scattering blaze every
   time the camera swung behind the animal with the sun beyond
   it. §4.5's fix is geometric rather than a magic number. The
   sun sits near vertical at 72°, and the camera is forbidden
   from ever looking higher than 25° above horizontal, so the
   alignment that produces the blaze is not merely rare — it is
   unreachable. The rim still lights, because the sun is above
   and the animal is below it, and that is a stable top-down
   condition rather than a periodic event.

   The clamp is enforced twice, deliberately:

     1. At construction, as a real assertion on the CONSTANTS.
        The orbit's lowest elevation plus the largest angle the
        look-at error and the handheld noise can add must still
        come in under 25°. If someone retunes the drift into a
        flare-capable configuration, the page refuses to build
        rather than shipping a flare that only appears at 3am.

     2. Every frame, on the final forward vector, with a counter.
        Because of (1) this never fires on the shipped constants,
        which is the point: a clamp that fires is a camera that
        visibly sticks, and a stuck camera is worse than a flare.

   Station framing carries its own version of (1): a second
   constructor clause computed the same way, worst case 19.194°
   against the same 25° limit, with 5.8° of headroom where the
   subject rig has 2.3°. Close framing carries a third, worst
   case 20.484°, with 4.5° of headroom.

   AND A THIRD LAYER, WHICH MAKES (2) UNREACHABLE. `_capPitch`
   runs between the handheld tremor and `_clampElevation` and
   compresses the last 5° below whichever cap is in force with a
   tanh, so the forward vector ASYMPTOTES to its cap and can
   never arrive at it — at every framing and at every point of
   the weight simplex, because a convex combination of caps each
   strictly inside MAX_LOOK_ELEVATION is itself strictly inside
   it. That argument makes no reference to how many framings
   there are, which is why adding a third one cost the anti-flare
   guarantee nothing. `_clampElevation` is therefore a tripwire
   that cannot fire rather than a backstop that merely does not:
   `elevationClampCount` is structurally 0, which is what
   `?dev=1`'s `strictElevation` throw wants to be true. The one
   cost is borne by the subject rig, whose rare 22.7° peaks come
   back as 20 + 5·tanh(2.7/5) = 22.47° — a change of at most
   0.25° at the extreme, and a strengthening of the guarantee.
   It is recorded in README's departure section.

   RATES. Everything here is slow on purpose. The radius breathes
   over 127 s, the elevation over 83 s, the azimuth over 59 s —
   mutually near-irrational, so the path does not repeat within
   any plausible viewing session. The longest excursion is given
   the longest period so that no axis moves faster than a few
   centimetres a second. The handheld tremor is at 0.25 Hz and
   0.0015 rad, deliberately NOT the 0.9 Hz a losing proposal
   asked for: that band reads as "something is shaking" and is
   fatiguing over an hour.
   ============================================================ */

import {
  Vec3, Spring3, Rng, ouStep,
  TAU, DEG_TO_RAD, RAD_TO_DEG, clamp, lerp,
  mat4
} from './math.js';
import { MEDIUM } from './shaders/common.js';

export const CAMERA_CONSTANTS = Object.freeze({
  /** A lens, not a game camera. Vertical FOV. */
  FOV_Y: 38 * DEG_TO_RAD,
  NEAR_PLANE: 0.05,
  /** The medium saturates to its far-field value near 28 m; 60 m is generous. */
  FAR_PLANE: 60.0,

  /** THE anti-flare constant. Nothing may look higher than this. */
  MAX_LOOK_ELEVATION: 25 * DEG_TO_RAD,
  /** §4.5: sun near-vertical, with a six-minute azimuth drift. */
  SUN_ELEVATION: 72 * DEG_TO_RAD,
  SUN_AZIMUTH_PERIOD: 360.0,

  /* --- Lissajous drift, §4.5's 59 / 83 / 127 s --------------------- */
  /*
   * §4.5 asks for 1.9-3.2 m. Measured against the shipped 38 degree lens, a
   * 26 cm animal at 2.55 m is 15 % of the frame HEIGHT -- a thumbnail with
   * nothing to watch in it, and the page is nothing but this animal. 1.3-2.2 m
   * puts the bell at 18-30 % and the streaming fringe at roughly half the
   * frame, which is the composition of the reference footage this is built
   * against. The deviation is deliberate and the elevation assertion below
   * still holds at the tighter radius.
   */
  ORBIT_RADIUS_MEAN: 1.75,
  ORBIT_RADIUS_SWING: 0.45,
  ORBIT_RADIUS_PERIOD: 127.0,
  ORBIT_ELEVATION_MEAN: 6 * DEG_TO_RAD,
  ORBIT_ELEVATION_SWING: 18 * DEG_TO_RAD,
  ORBIT_ELEVATION_PERIOD: 83.0,
  ORBIT_AZIMUTH_SWING: 0.12,
  ORBIT_AZIMUTH_PERIOD: 59.0,

  /* --- Damping ------------------------------------------------------ */
  /** The drift is already smooth; this spring adds the inertia of a real rig. */
  POSITION_TAU: 1.8,
  /** §4.5: "a very loose spring". */
  LOOK_TAU: 5.0,

  /*
   * How far below the animal's centre the rig aims, in metres — one bell
   * radius, and it has to be re-derived if geometry/profile.js's BELL_RADIUS
   * ever moves. `swim.position` is the bell's centre, but the animal's visible
   * mass is not: the forty tentacles and four oral arms put its lowest lit node
   * 0.20 m below that centre in the mean and 0.47 m at worst, so aiming at the
   * centre hangs the fringe out of the bottom of the frame — measured, off the
   * bottom edge in 3.6 % of frames — and leaves the top half of it empty water.
   * 0.13 is the smallest drop that takes that clipping to zero.
   */
  FRAMING_DROP: 0.13,

  /* --- The wandering look-at error ---------------------------------- */
  /* Scaled with the orbit radius above, so the drift subtends the same angle
     it always did: 0.11 / 1.75 is 0.14 / 2.55. LOOK_ERROR_MAX is what the
     anti-flare assertion trades against the tighter radius. */
  LOOK_ERROR_SIGMA: 0.11,
  LOOK_ERROR_TAU: 25.0,
  LOOK_ERROR_MAX: 0.24,

  /* --- Handheld ----------------------------------------------------- */
  HANDHELD_AMPLITUDE: 0.0015,
  HANDHELD_FREQUENCY: 0.25,
  BOB_AMPLITUDE: 0.012,
  BOB_PERIOD: 5.0,
  ROLL_AMPLITUDE: 0.5 * DEG_TO_RAD,
  ROLL_PERIOD_A: 37.0,
  ROLL_PERIOD_B: 23.7,

  /** §2.5: the SEA target is rendered with a guard band so edge refraction taps land. */
  OVERSCAN: 0.08,

  /* --- Station framing ---------------------------------------------- */
  /*
   * The second way of watching. Everything above describes the subject rig:
   * a camera that orbits the animal and therefore always has it in the middle
   * distance. Station framing anchors the camera in WORLD space instead and
   * lets the animal cross a bounded volume in front of it. The framings are
   * blended by the weight simplex rather than cut between, so nothing here can
   * produce a jump.
   */

  /*
   * A longer lens is station framing's visual identity: it compresses the
   * volume and reads as looking INTO water rather than swimming alongside an
   * animal. At the 3.10 m median a 0.26 m bell is 16.8 % of frame height,
   * 38.6 % at the 1.35 m closest approach and 9.7 % at the far wall, which
   * brackets the composition FOV_Y's own note argues for. The subject rig
   * keeps the shipped 38°.
   */
  TANK_FOV_Y: 28 * DEG_TO_RAD,

  /*
   * How far the station stands off the world origin. Fixed rather than another
   * carrier: one fewer number to defend, and it makes the standoff assertion
   * exact. Two constraints set it. It must exceed the animal's hard bound plus
   * STATION_STANDOFF (2.05 + 0.65 = 2.70, so there is 0.40 m of margin), and
   * together with that bound it fixes the 1.35–5.15 m subject-distance range.
   *
   * THAT RANGE IS THE POINT, NOT A SIDE EFFECT. Every shader ends in
   * `waterApply(c, dist, y)`, an exp(−SIG_T_W·dist) transmittance with
   * SIG_T_W = (0.560, 0.230, 0.170) 1/m (js/shaders/common.js). Across
   * 1.35 → 5.15 m the animal's RED transmittance falls to 0.20 while its BLUE
   * only falls to 0.53: the jelly warms as it comes to the glass and goes to a
   * pale blue ghost as it swims off, with the in-scatter filling in behind it.
   * That is the strongest "the water is real" cue in the mode and it costs no
   * code at all. Any future change to STATION_RADIUS, to the animal's bound or
   * to the lens keep-out must be argued against the resulting red-vs-blue
   * ratio, not against framing alone. At the 0.086 m/s cruise the red term
   * moves 0.560 × 0.086 = 4.8 %/s, against §10's 12 %/s regional budget, and
   * it is aperiodic because the traverse is a bounded random walk.
   */
  STATION_RADIUS: 3.10,
  /*
   * The geometric guarantee that the animal can never get behind the lens.
   * 0.65 m clears the bell's 0.13 m radius plus its streaming fringe with room
   * to spare and is far outside NEAR_PLANE = 0.05. sim/director.js asserts
   * STATION_RADIUS ≥ TANK_HARD_RADIUS + STATION_STANDOFF at construction.
   */
  STATION_STANDOFF: 0.65,

  /*
   * Eye height above the animal's band: 0.34–0.86 m. Height is the second
   * largest lighting driver in the design, because `uCamY` is derived as
   * camPos.y + worldOrigin.y (js/render/frame.js) and sea.js's whole analytic
   * water column regrades with it — over 0.52 m the veil's red moves 1.24×.
   * Peak vertical speed is 0.26·τ/1310 = 1.25 mm/s, i.e. 0.052 %/s of red,
   * four orders under §10's 12 %/s budget. 1310 s is well outside §10's
   * forbidden 20–300 s band and is not commensurate with any other carrier.
   */
  STATION_HEIGHT_MEAN: 0.60,
  STATION_HEIGHT_SWING: 0.26,
  STATION_HEIGHT_PERIOD: 1310.0,
  /*
   * One lap of the rim in 24 minutes: 2π·3.10/1440 = 1.35 cm/s tangential, six
   * times slower than the animal's 0.086 m/s cruise. At any instant the
   * station looks static; over ten minutes it has completely re-composed the
   * shot. Being six times slower is exactly what makes the ANIMAL read as the
   * thing that moves.
   */
  STATION_BEARING_PERIOD: 1440.0,
  /*
   * The shipped Lissajous character survives as a shake ON the anchor rather
   * than as an orbit around the subject, reusing the existing 127 / 83 / 59 s
   * periods and this run's own phases so the texture of the motion is
   * identical. Peak 0.055·τ/59 = 5.9 mm/s. Total station-mode camera speed
   * (shake + height + bearing + bob) ≤ 0.035 m/s = 0.58 mm/frame at 60 Hz,
   * 69× under shafts.js's SHAFT_HISTORY_REJECT_METRES = 0.04, so the 0.90
   * shaft history blend is never rejected in this mode.
   */
  STATION_SHAKE: 0.055,

  /*
   * The look point is pushed out along its own ray to at least this distance.
   * Pushing along the ray changes `distanceToTarget` and NOTHING about
   * direction — `mat4.lookAt` is fed `eye.addScaled(forward, distanceToTarget)`
   * below — so it is free. Chosen just above ORBIT_RADIUS_MEAN = 1.75 so the
   * station look-error scale is always ≥ 1, and it is the leg length the
   * station elevation assertion is computed against.
   */
  STATION_MIN_AIM_DISTANCE: 1.85,
  /*
   * About 10° at the 3.10 m median. While the animal works the middle of the
   * volume the camera is perfectly still and the animal crosses the frame; the
   * head yields only near the extremes. This single number is what makes the
   * mode read as a tank rather than as a Steadicam.
   */
  STATION_AIM_DEADBAND: 0.55,
  /*
   * The fraction of the excess beyond the dead band that the aim follows. At
   * 0.70 an animal out at 1.85 m leaves a 0.94 m residual chord, roughly 15° at
   * a 3.6 m subject distance, inside the 23.9° half-frame width of a 28° lens
   * at 16:9 — so it grazes the edge on the widest passes and occasionally slips
   * out, which is the intended aquarium reading and is bounded by the soak's
   * off-frame gate.
   */
  STATION_AIM_GAIN: 0.70,
  /*
   * Hard cap on how far the aim point may leave the tank centre, which bounds
   * the composition when the animal is out in the overdrive band. It does NOT
   * appear in the station elevation derivation below, which is why it is the
   * first lever if the off-frame statistic ever needs tuning.
   */
  STATION_AIM_MAX_OFFSET: 1.25,
  /*
   * Absolute scene-y ceiling on the aim BEFORE FRAMING_DROP, i.e. in station
   * framing the aim can never sit above 0.70 − 0.13 = 0.57 m. It is one of the
   * two terms the station elevation assertion is built on, so it is at full
   * strength wherever that assertion is claimed — at a tank weight of 1 — and
   * is eased in with that weight on the way there. It cannot simply be applied
   * unblended: the ceiling is sized against the STATION's geometry, and the
   * animal's own depth band is wider than it, so a ceiling left on through a
   * transition toward free view aims the orbit rig a metre or more below the
   * animal it is supposed to be orbiting.
   */
  STATION_AIM_MAX_HEIGHT: 0.70,
  /*
   * A 25 % safety factor on the look-error term in the station assertion,
   * covering spring transients where the post-error subject distance dips
   * below the previous frame's `distanceToTarget`. It costs 1.9° of the 7.7° of
   * headroom the assertion would otherwise report; the shipped worst case is
   * still 19.194° against 25°.
   */
  STATION_ERROR_MARGIN: 1.25,

  /*
   * The soft pitch cap. In station framing the forward vector asymptotes to
   * 20°, comfortably above the 19.194° steady-state worst case (so it engages
   * only on transients and compresses by under a degree) and comfortably below
   * MAX_LOOK_ELEVATION. In the subject rig the cap is MAX_LOOK_ELEVATION
   * itself, and in close framing it is CLOSE_PITCH_CAP; `_capPitch` is fed the
   * convex combination of the three, weighted by the simplex.
   */
  STATION_PITCH_CAP: 20 * DEG_TO_RAD,
  /*
   * Where the tanh compression begins, measured DOWN from whichever cap is in
   * force. Wide enough that the compression is smooth and C¹ at the join
   * (tanh'(0) = 1), narrow enough that ordinary framing is untouched.
   */
  PITCH_SOFT_BAND: 5 * DEG_TO_RAD,

  /*
   * Time constant of the mode blend: 95 % in 9 s. Two constraints. It must be
   * slow enough that the 10° FOV change and the up-to-4 m dolly are not a
   * nameable camera move, and that the whole-frame change is spread well under
   * §10's 1 s regional budget. It must be fast enough to still feel like a
   * response to a keypress. The eye-speed bound is independent of it: a
   * critically damped second-order spring stepping to Δ peaks at
   * 0.368·Δ/POSITION_TAU and this exponential ease is strictly gentler than a
   * step, so the worst 4.0 m switch peaks at 0.818 m/s = 13.6 mm/frame at
   * 60 Hz and 27 mm at the 30 Hz clamp, both under shafts.js's 0.04 m history
   * rejection threshold.
   */
  MODE_TAU: 3.0,

  /*
   * The sun rakes between 66° and 78°. At 14 m that slides the caustic gobo's
   * surface projection by 14·(cot 66° − cot 78°) = 3.25 m = 0.54 tiles, and it
   * leans the shafts by 6°. The brightness effect is under 0.5 % of the frame:
   * `causticAt()` is normalised to mean 1 by cookie.js's module-load gain
   * measurement, so the caustic contributes none of it, and the shaft phase
   * term hg(dot(rd, −uSunDir), 0.62) moves 2.7 % on a term that is itself only
   * about 1.4× the veil. 6° is the largest swing that still leaves 41° of
   * clearance on the sun-behind-the-animal alignment §4.5 exists to forbid.
   */
  SUN_ELEVATION_SWING: 6 * DEG_TO_RAD,
  /*
   * 29 minutes. Far outside §10's forbidden 20–300 s band, and not
   * commensurate with the 360 s azimuth drift or with any other carrier.
   */
  SUN_ELEVATION_PERIOD: 1730.0,
  /*
   * The floor the constructor asserts on
   * SUN_ELEVATION − SUN_ELEVATION_SWING − MAX_LOOK_ELEVATION, whose shipped
   * value is 72 − 6 − 25 = 41°. It exists so that anyone who later widens the
   * elevation swing or raises the look clamp is stopped at boot rather than
   * shipping §4.5's flare.
   */
  SUN_CLEARANCE_MIN: 30 * DEG_TO_RAD,

  /* --- Close framing --------------------------------------------- */
  /*
   * The third way of watching, and the one the whole "crystal" reading of the
   * animal depends on. It is the SUBJECT rig again — anchored to the animal,
   * not to the world — pulled in to 1.35 m, tilted below the animal and stood
   * on the far side of it from the sun. Two already-shipped mechanisms do all
   * the work and neither costs a line of shader.
   *
   * The water is the bigger of the two and it is free. Every shader ends in
   * `waterApply(c, dist, y)`, an exp(−SIG_T_W·dist) transmittance with
   * SIG_T_W = (0.560, 0.230, 0.170) 1/m (js/shaders/common.js). At the station's
   * 3.10 m median the animal's own light reaches the eye at (0.176, 0.490,
   * 0.590) of what left it, r/b = 0.298, with 41 % of its blue already replaced
   * by flat structureless in-scatter. At 1.35 m that is (0.470, 0.733, 0.795),
   * r/b = 0.591, and 20 %. Everything that reads as glass — the τ ramp down the
   * margin, the canals, the gonad horseshoes, the refracted background — is a
   * CONTRAST, and the veil is what destroys contrast.
   *
   * The stance is the other. `uSunDir` is the direction light travels and the
   * sun sits at 72° ± 6°, so standing β below the animal and δ off the
   * dead-anti-sun bearing gives dot(−L, V) = cos72·cosβ·cosδ + sin72·sinβ. At
   * β = 10°, δ = 22° that is 0.4473, which against a side-lit reference fires
   * four already-shipped Henyey–Greenstein lobes at once: the bell's single
   * scattering ×2.29, the tentacle and oral-arm curtain ×2.04, the shaft field
   * BEHIND the animal ×2.16, and the near bokeh between lens and animal ×1.84.
   *
   * What it deliberately does NOT do is brighten the rim, and that is provable
   * rather than hoped: the multiple-scattering pedestal carries
   * wrapDiffuse(N, L, 0.65) and depends on N·L, never on V, so no camera
   * placement anywhere can walk §5.5's #B9D9EE margin toward AgX's clip
   * ceiling. Backlighting raises the interior and leaves the margin alone.
   *
   * NO NEW RNG DRAW IS MADE ANYWHERE FOR THIS BLOCK, and that is the trap the
   * next person will fall into. The radius carrier reuses `_phaseRadius`, the
   * elevation carrier `_phaseElevation` and ORBIT_ELEVATION_PERIOD, the azimuth
   * swing `_phaseAzimuth` with ORBIT_AZIMUTH_SWING and ORBIT_AZIMUTH_PERIOD.
   * Drawing even one fresh phase would shift every stream position after it and
   * free view would stop being bit-identical to the shipped page.
   */

  /*
   * WIDER than the station's 28°, not narrower, and the reason is the near
   * snow. `uCocScale` is FOV-independent (js/render/frame.js) while a mote's
   * geometric size scales as 1/tan(halfFov) (js/shaders/snow.js), so narrowing
   * the lens GROWS every foreground mote while leaving its circle of confusion
   * fixed in pixels — the opposite of what a real long lens does — and
   * cover = min(1, dGeo²/dDraw²) saturates into opaque 96 px hard-edged discs
   * painted over the animal with depthTest off. Measured for a 6 mm floc at
   * 0.4 m at 1080p tier 1: coverage 0.575 at 28°/focus 3.10 m (shipped tank),
   * 0.496 at 30°/focus 1.35 m, 0.792 at 24°, and a fully opaque 1.000 at 18°.
   * The close rig's foreground is LESS obtrusive than the one that ships.
   * 30° also keeps §5.3's three-or-four shaft columns across frame — a 24° lens
   * compresses the field to under two caustic cells — and lands the cos⁴
   * vignette corner at about 0.60, between free view's 0.449 and tank's 0.631.
   * A 0.26 m bell subtends 35.9 % of frame height here against tank's 16.8 %.
   */
  CLOSE_FOV_Y: 30 * DEG_TO_RAD,
  /*
   * 1.20–1.50 m of orbit radius. The floor is set by SNOW_FOCUS_MIN = 1.0 m
   * (js/shaders/snow.js, clamped in js/render/frame.js): inside 1.0 m the plane
   * of focus sits BEHIND the subject in the one framing where near-snow bokeh
   * matters most. That is not sufficient on its own, because the orbit is
   * centred on rigCentre = centre + velocity·2·POSITION_TAU, a 0.086 × 3.6 =
   * 0.31 m lead at the cruise, so eye-to-ANIMAL distance is not the orbit
   * radius — hence CLOSE_MIN_EYE_DISTANCE below, which makes the guarantee
   * structural instead of arithmetical.
   */
  CLOSE_RADIUS_MEAN: 1.35,
  CLOSE_RADIUS_SWING: 0.15,
  /*
   * DELIBERATELY EQUAL TO STATION_HEIGHT_PERIOD, and an `agree` assertion in
   * tests/check.mjs pins the identity so the reuse is checked rather than
   * coincidental. The radius carrier is the only thing in this framing that
   * modulates the animal's screen coverage, and screen coverage is what feeds
   * the auto-exposure highlight meter; the free rig's own 127 s radius carrier
   * would put an FFT peak squarely inside §10's forbidden 20–300 s band if that
   * meter ever came off its +0.25 EV rail. Reusing 1310 introduces no SEVENTH
   * carrier, so sim/director.js's PERIODS manifest and the gate's hard-coded
   * carriers array stay complete as they are.
   */
  CLOSE_RADIUS_PERIOD: 1310.0,
  /*
   * A floor on eye-to-ANIMAL distance, applied by `_applyCloseStandoff` by
   * sliding the desired eye out along its own ray — so the DIRECTION, and
   * therefore the elevation the anti-flare clause below bounds, is untouched.
   * It is the same monotone, direction-preserving trick `_applyStationAimClamps`
   * already uses on the aim, and it is eased on the close weight so that
   * lerp(d, X, 0) is d and the whole function is an exact identity outside close
   * framing. 150 mm above SNOW_FOCUS_MIN by construction; the position spring
   * can still dip a few centimetres below a clamped desired, so the gate's
   * `framing` section asserts the MEASURED minimum ≥ 1.05 m rather than trusting
   * the constant.
   */
  CLOSE_MIN_EYE_DISTANCE: 1.15,
  /*
   * The eye sits 6–14° BELOW the animal, always below and never above, so the
   * shot is permanently looking UP into the subumbrella at the backlit radial
   * canals and the four gonad horseshoes. Set by the anti-flare budget rather
   * than by taste — see the third constructor clause, where 14.000 + 6.398 +
   * 0.086 = 20.484° against the 25° limit, i.e. 4.516° of headroom, between the
   * subject rig's 2.275° and the station's 5.805°. It is also what buys the
   * phase gain: dot(−L, V) runs 0.384 to 0.508 across the swing at δ = 22°,
   * which is hg(·, 0.72) ×1.97 to ×2.68 against a side-lit stance.
   */
  CLOSE_ELEVATION_MEAN: -10 * DEG_TO_RAD,
  CLOSE_ELEVATION_SWING: 4 * DEG_TO_RAD,
  /*
   * How far off dead-anti-sun the eye stands. Dead-on (δ = 0) buys only 5.5 %
   * more hg — 0.04688 → 0.04946 at β = 10° — and flattens the bell into a disc.
   * 22° is a three-quarter backlight: one flank of the dome carries the
   * multiple-scattering lobe, which depends on N·L rather than V and is
   * therefore unaffected by the staging, while the other reads as pure
   * transmission, and the brightest shaft column sits off-centre in the frame
   * rather than directly behind the animal's own axis.
   */
  CLOSE_BACK_OFFSET: 22 * DEG_TO_RAD,
  /*
   * Exponential decay of `_closeBearingBias`, the offset planted at mode entry
   * so the switch into close framing is a radial dolly rather than a lateral
   * sweep through the snow strata — the same argument `_reseedOrbitAzimuth`
   * makes for the azimuth. 95 % settled in 450 s, so the shot ARRIVES and then,
   * over five to eight minutes, finds its light. Peak extra rotation is
   * π/150 = 1.20°/s, i.e. 28.3 mm/s of tangential eye speed at 1.35 m, 40×
   * under shafts.js's SHAFT_HISTORY_REJECT_METRES = 0.04 per frame. It is a
   * one-shot aperiodic transient fired once per mode entry, NOT a carrier, so
   * it needs no entry in the periods manifest.
   */
  CLOSE_BEARING_TAU: 150.0,
  /*
   * Subtends atan(0.10/1.35) = 4.236°, i.e. 28 % of the 15° half-frame, against
   * FRAMING_DROP's 4.248°/19° = 22 % at 1.75 m. Deliberately a little more,
   * because the animal now fills three quarters of the frame and its fringe is
   * MEANT to leave the bottom of it: the bell sits high, the coronal ring runs
   * through the upper third, and the tentacle curtain streams down and out.
   * Being a constant downward offset it can only tilt the rig DOWN, so like
   * FRAMING_DROP it cannot cost elevation budget.
   */
  CLOSE_FRAMING_DROP: 0.10,
  /*
   * Multiplies distanceToTarget / ORBIT_RADIUS_MEAN, so the wander's SUBTENDED
   * angle is the constant asin(0.24 · 0.65 / 1.75) = 5.114° at every radius —
   * 34.1 % of the 15° half-frame, against free view's 7.874°/19° = 41.4 %.
   * Tighter because the animal is three times larger in frame, so §4.5's "the
   * jellyfish drifts around the frame instead of being pinned" is preserved and
   * tightened rather than abandoned. This is the FIRST place in the file where
   * the look error scales DOWN; the station term keeps its Math.max(1, …) floor
   * byte-identical, which is why the gate's named inequality about the station
   * scaling up and never down is untouched. Worst simultaneous vertical
   * excursion: 4.236 (drop) + 1.87 (bell apex above centre) + 6.398 (wander
   * with the 1.25 transient margin) = 12.5° against a 15° half-frame.
   */
  CLOSE_LOOK_ERROR_SCALE: 0.65,
  /*
   * Puts PITCH_SOFT_BAND's knee at 17°, so the tanh engages only above 17° and
   * compresses the 20.484° worst case to 20.003° — a 0.48° squeeze, LESS than
   * the 0.78° the station already eats routinely (19.194° → 18.416°). Strictly
   * inside MAX_LOOK_ELEVATION, so `_capPitch`'s asymptote keeps
   * `elevationClampCount === 0` structural at every point of the simplex.
   */
  CLOSE_PITCH_CAP: 22 * DEG_TO_RAD
});

const WORLD_UP = Object.freeze([0, 1, 0]);

/**
 * The three framings, and the order the weight simplex iterates them in. It is
 * a frozen array rather than three named lines so that the ease below is one
 * loop whose sum is conserved for any number of framings — the invariant the
 * whole blend rests on is Σw = 1, not a count of three.
 */
const MODE_KEYS = Object.freeze(['free', 'tank', 'close']);

/**
 * Wrap an angle into (−π, π]. The close bearing is locked to the sun's azimuth,
 * which laps every SUN_AZIMUTH_PERIOD = 360 s, so a difference of two bearings
 * has to be taken the short way round or a blend between free and close azimuths
 * would occasionally take the camera the long way — up to 2π of orbit in one
 * ease, which is the one move MODE_TAU's eye-speed bound does not cover.
 */
function wrapPi(a) {
  const t = (a + Math.PI) % TAU;
  return (t < 0 ? t + TAU : t) - Math.PI;
}

/**
 * The largest upward tilt the look-at error and the handheld noise can add to
 * the forward vector, at the tightest orbit radius. This is the term that makes
 * the constructor's assertion meaningful rather than decorative.
 */
function worstCaseExtraElevation() {
  const K = CAMERA_CONSTANTS;
  const minRadius = K.ORBIT_RADIUS_MEAN - K.ORBIT_RADIUS_SWING;
  const errorAngle = Math.asin(clamp(K.LOOK_ERROR_MAX / minRadius, -1, 1));
  return errorAngle + K.HANDHELD_AMPLITUDE;
}

export class Camera {
  /**
   * `depthOrigin` must match swim.js's SCENE_DEPTH_ORIGIN — scene y = 0 is the
   * animal's working depth, not the sea surface, and both read it from
   * `MEDIUM.CAMERA_DEPTH_Y` so they cannot drift apart.
   */
  constructor({
    seed = 'aurelia-camera',
    aspect = 16 / 9,
    depthOrigin = MEDIUM.CAMERA_DEPTH_Y,
    reducedMotion = false,
    strictElevation = false
  } = {}) {
    const K = CAMERA_CONSTANTS;

    /*
     * The assertion §4.5 asks for, made against the constants rather than
     * against a frame. The orbit's lowest elevation is how far BELOW the target
     * the camera can sit, which is how far UP it then has to look.
     */
    const lowest = -(K.ORBIT_ELEVATION_MEAN - K.ORBIT_ELEVATION_SWING);
    const worst = lowest + worstCaseExtraElevation();
    if (worst > K.MAX_LOOK_ELEVATION) {
      throw new Error(
        'camera.js: the drift constants allow a look elevation of ' +
        (worst * RAD_TO_DEG).toFixed(2) + '°, above the ' +
        (K.MAX_LOOK_ELEVATION * RAD_TO_DEG).toFixed(0) +
        '° anti-flare limit in §4.5. Lower ORBIT_ELEVATION_SWING or LOOK_ERROR_MAX.'
      );
    }

    /*
     * The same assertion again, for station framing, which has a completely
     * different geometry: the eye is above the animal rather than orbiting
     * through its elevation band, so the worst upward look is set by how far
     * the aim can RISE toward a station sitting at its lowest.
     *
     *   stationRise = (STATION_AIM_MAX_HEIGHT − FRAMING_DROP)
     *               − (STATION_HEIGHT_MEAN − STATION_HEIGHT_SWING
     *                  − STATION_SHAKE − BOB_AMPLITUDE)
     *               = (0.70 − 0.13) − (0.60 − 0.26 − 0.055 − 0.012)
     *               = 0.57 − 0.273 = 0.297 m
     *   stationLeg  = sqrt(STATION_MIN_AIM_DISTANCE² − stationRise²)
     *               = sqrt(1.85² − 0.297²) = sqrt(3.334291) = 1.826004 m
     *   riseAngle   = atan2(0.297, 1.826004) = 0.161237 rad =  9.238°
     *   errAngle    = asin(LOOK_ERROR_MAX · STATION_ERROR_MARGIN
     *                      / ORBIT_RADIUS_MEAN)
     *               = asin(0.24 · 1.25 / 1.75) = 0.172276 rad =  9.871°
     *   handheld    = HANDHELD_AMPLITUDE      = 0.001500 rad =  0.086°
     *   worst       = 0.335013 rad = 19.194°  ≤ 25°, i.e. 5.81° of headroom.
     *
     * The aim's height ceiling and the minimum aim distance are the two terms
     * this is built on, and `_applyStationAimClamps` applies both at full
     * strength at a TANK WEIGHT of 1, which is the pose this derivation
     * describes — and only at the tank weight, so close framing, whose eye is
     * 1.35 m out, never inherits this rig's 1.85 m aim-distance floor.
     * On the way there they are eased with that weight rather than switched on:
     * the bound mid-transition is held by `_capPitch`, which is a structural
     * asymptote at every blend and needs no closed form, and the earlier
     * arrangement — hard clamps for the whole of both transitions — aimed free
     * view under the STATION's height ceiling for the twenty seconds an ease
     * takes, which is a framing failure and not a safety margin.
     */
    const stationRise = (K.STATION_AIM_MAX_HEIGHT - K.FRAMING_DROP) -
      (K.STATION_HEIGHT_MEAN - K.STATION_HEIGHT_SWING - K.STATION_SHAKE - K.BOB_AMPLITUDE);
    const stationLeg = Math.sqrt(Math.max(
      1e-6,
      K.STATION_MIN_AIM_DISTANCE * K.STATION_MIN_AIM_DISTANCE - stationRise * stationRise
    ));
    const stationWorst = Math.atan2(stationRise, stationLeg) +
      Math.asin(clamp(K.LOOK_ERROR_MAX * K.STATION_ERROR_MARGIN / K.ORBIT_RADIUS_MEAN, -1, 1)) +
      K.HANDHELD_AMPLITUDE;
    if (stationWorst > K.MAX_LOOK_ELEVATION) {
      throw new Error(
        'camera.js: the station constants allow a look elevation of ' +
        (stationWorst * RAD_TO_DEG).toFixed(2) + '°, above the ' +
        (K.MAX_LOOK_ELEVATION * RAD_TO_DEG).toFixed(0) +
        '° anti-flare limit in §4.5. Lower STATION_AIM_MAX_HEIGHT or raise ' +
        'STATION_HEIGHT_MEAN or STATION_MIN_AIM_DISTANCE.'
      );
    }

    /*
     * And a third time, for close framing, whose geometry is a third one again:
     * the eye is deliberately held BELOW the animal at every phase of its
     * carrier, so the worst upward look is simply the lowest elevation the
     * carrier reaches plus what the wander and the tremor can add on top.
     *
     *   lowest   = CLOSE_ELEVATION_SWING − CLOSE_ELEVATION_MEAN
     *            = 4 − (−10)                                   = 14.000°
     *   errAngle = asin(LOOK_ERROR_MAX · STATION_ERROR_MARGIN
     *                   · CLOSE_LOOK_ERROR_SCALE / ORBIT_RADIUS_MEAN)
     *            = asin(0.24 · 1.25 · 0.65 / 1.75)
     *            = asin(0.1114286) = 0.111660 rad             =  6.398°
     *   handheld = HANDHELD_AMPLITUDE       = 0.001500 rad     =  0.086°
     *   worst    = 0.357506 rad = 20.484°  ≤ 25°, i.e. 4.516° of headroom.
     *
     * The error term takes the STATION's form rather than the subject rig's
     * because close framing scales its look error by subject distance the same
     * way the station does, so the angle it subtends is the constant
     * asin(0.24 · 1.25 · 0.65 / 1.75) AT EVERY RADIUS. That is what makes this
     * clause radius-independent, and it is why CLOSE_RADIUS_SWING appears
     * nowhere in it: pulling the orbit in does not widen the wander's angle,
     * because CLOSE_LOOK_ERROR_SCALE is proportional to the distance.
     * STATION_ERROR_MARGIN's 25 % covers the spring transients around it, as it
     * does above. 4.516° sits between the subject rig's 2.275° and the
     * station's 5.805°, so close framing is the second-safest of the three.
     */
    const closeLowest = K.CLOSE_ELEVATION_SWING - K.CLOSE_ELEVATION_MEAN;
    const closeWorst = closeLowest +
      Math.asin(clamp(
        K.LOOK_ERROR_MAX * K.STATION_ERROR_MARGIN * K.CLOSE_LOOK_ERROR_SCALE /
        K.ORBIT_RADIUS_MEAN, -1, 1
      )) +
      K.HANDHELD_AMPLITUDE;
    if (closeWorst > K.MAX_LOOK_ELEVATION) {
      throw new Error(
        'camera.js: the close framing constants allow a look elevation of ' +
        (closeWorst * RAD_TO_DEG).toFixed(2) + '°, above the ' +
        (K.MAX_LOOK_ELEVATION * RAD_TO_DEG).toFixed(0) +
        '° anti-flare limit in §4.5. Lower CLOSE_ELEVATION_SWING, raise ' +
        'CLOSE_ELEVATION_MEAN, or lower CLOSE_LOOK_ERROR_SCALE.'
      );
    }

    /*
     * EVERY soft cap has to sit strictly inside the hard one, or `_capPitch`
     * would asymptote to the very value `_clampElevation` is watching for and
     * the structural argument above would quietly become an arithmetic one.
     * Checking each one separately rather than only the lowest is what makes
     * the guarantee survive a fourth framing: `_capPitch` is handed a convex
     * combination of these caps, and a convex combination is strictly inside
     * MAX_LOOK_ELEVATION exactly when every one of its terms is.
     *
     * The band has to be positive and narrower than each cap so that
     * `soft = cap − band` stays above the horizon and `band > 0` in the tanh.
     */
    for (const cap of [K.STATION_PITCH_CAP, K.CLOSE_PITCH_CAP]) {
      if (cap >= K.MAX_LOOK_ELEVATION) {
        throw new Error(
          'camera.js: a soft pitch cap is ' + (cap * RAD_TO_DEG).toFixed(2) +
          '°, which is not below the ' + (K.MAX_LOOK_ELEVATION * RAD_TO_DEG).toFixed(0) +
          '° anti-flare limit in §4.5. The soft cap must asymptote strictly inside the hard one.'
        );
      }
      if (!(K.PITCH_SOFT_BAND > 0) || K.PITCH_SOFT_BAND >= cap) {
        throw new Error(
          'camera.js: PITCH_SOFT_BAND is ' + (K.PITCH_SOFT_BAND * RAD_TO_DEG).toFixed(2) +
          '°, which must be greater than 0 and less than the soft pitch cap ' +
          (cap * RAD_TO_DEG).toFixed(2) + '° for the tanh compression to exist.'
        );
      }
    }

    /*
     * And the other end of the same guarantee. §4.5's flare needs the sun in
     * front of the lens; the clamp stops the lens from rising, and this stops
     * the sun from descending to meet it. 72 − 6 − 25 = 41° of clearance
     * against a floor of 30°.
     */
    const sunClearance = K.SUN_ELEVATION - K.SUN_ELEVATION_SWING - K.MAX_LOOK_ELEVATION;
    if (sunClearance < K.SUN_CLEARANCE_MIN) {
      throw new Error(
        'camera.js: the sun comes within ' + (sunClearance * RAD_TO_DEG).toFixed(2) +
        '° of the highest permitted look direction, below the ' +
        (K.SUN_CLEARANCE_MIN * RAD_TO_DEG).toFixed(0) +
        '° clearance §4.5 needs to keep the forward-scattering flare unreachable. ' +
        'Narrow SUN_ELEVATION_SWING or raise SUN_ELEVATION.'
      );
    }

    this.rng = new Rng(seed);
    this.reducedMotion = reducedMotion;
    this.strictElevation = strictElevation;
    this.depthOrigin = depthOrigin;

    this.time = 0;
    this._driftTime = this.rng.range(0, 1000);
    this.aspect = aspect;
    this.fovY = K.FOV_Y;
    this.overscan = K.OVERSCAN;

    /* Phases, so two runs with different seeds do not start on the same beat. */
    this._phaseRadius = this.rng.range(0, TAU);
    this._phaseElevation = this.rng.range(0, TAU);
    this._phaseAzimuth = this.rng.range(0, TAU);
    this._baseAzimuth = this.rng.range(0, TAU);
    this._sunAzimuth = this.rng.range(0, TAU);
    this._handheldPhase = [
      this.rng.range(0, TAU), this.rng.range(0, TAU),
      this.rng.range(0, TAU), this.rng.range(0, TAU)
    ];
    /*
     * Drawn HERE, immediately after the handheld block, and nowhere else. Every
     * draw above it keeps the value it has always had, so `_phaseRadius`,
     * `_phaseElevation`, `_phaseAzimuth`, `_baseAzimuth`, `_sunAzimuth` and the
     * four handheld phases are bit-identical to the shipped page for any given
     * seed. Only the `_lookError` OU stream below shifts by one draw, and that
     * stream is a wander with no identity to preserve.
     */
    this._phaseSunElevation = this.rng.range(0, TAU);

    /*
     * Which framing is wanted, and how far the blend has got toward it.
     * `mode` is the authoritative copy — main.js mirrors its own closure state
     * onto it — and `_w` is what every weighted sum below actually reads: three
     * eased weights that sum to exactly 1 and settle one-hot on the wanted
     * framing. The tank weight only ever moves toward 1 while a station has been
     * supplied, so a page that never constructs a director stays on the subject
     * rig for ever without needing a branch anywhere.
     */
    this.mode = 'tank';
    this._w = { free: 1, tank: 0, close: 0 };
    this._hasStation = false;
    this._station = new Vec3();
    this._stationAim = new Vec3();
    this._stationAimVelocity = new Vec3();
    /*
     * The offset planted into the close bearing at mode entry so the switch is a
     * radial dolly rather than a lateral sweep, decaying to zero on
     * CLOSE_BEARING_TAU. It is the only piece of state close framing owns, and
     * it is an angle rather than a point — which is why `translate()` does not
     * touch it and does not need to: the close rig holds nothing in world space.
     */
    this._closeBearingBias = 0;
    /*
     * The sun's own clock, written from the director's `lightTime` each frame
     * rather than taken from `_driftTime`. The two differ under reduced motion:
     * `_driftTime` stops dead, which froze the sun, while the optical schedule
     * keeps running at 15 %. §4.6 asks for grain, dither and exposure to stay
     * alive so the image still breathes; a sun that stops was at odds with it.
     */
    this.sunTime = 0;

    this.position = new Vec3(0, 0, K.ORBIT_RADIUS_MEAN);
    this.target = new Vec3(0, 0, 0);
    this.forward = new Vec3(0, 0, -1);
    this.up = new Vec3(0, 1, 0);
    this.right = new Vec3(1, 0, 0);
    this.sunDirection = new Vec3(0, 1, 0);
    this.distanceToTarget = K.ORBIT_RADIUS_MEAN;

    this.elevationDegrees = 0;
    this.maxElevationDegreesSeen = -90;
    this.elevationClampCount = 0;

    this._positionSpring = new Spring3(this.position);
    this._lookSpring = new Spring3(this.target);
    this._lookError = new Vec3(0, 0, 0);
    /*
     * The springs are snapped to their targets on the first step rather than
     * allowed to converge. Otherwise the page opens on a two-second swoop from
     * wherever the rig happened to be constructed into the drift path, which is
     * the largest single movement anyone would ever see on this page and the
     * first thing they would see.
     */
    this._primed = false;

    this.view = mat4.create();
    this.projection = mat4.create();
    this.viewProjection = mat4.create();
    this.inverseViewProjection = mat4.create();
    this.overscanProjection = mat4.create();
    this.overscanViewProjection = mat4.create();
    /*
     * SEA and RAYS are both rendered through the guard-banded frustum, and both
     * of their shaders reconstruct a world ray by unprojecting. They therefore
     * need the inverse of the OVERSCANNED view-projection, not of the framing
     * one — handing them `inverseViewProjection` would rebuild rays for the
     * narrow frustum and slide the shafts against the water by the full 8 %.
     */
    this.inverseOverscanViewProjection = mat4.create();

    this._updateProjection();
    this.step(0, new Vec3(0, 0, 0));
  }

  /** Depth in the shader's coordinates: negative, roughly −14. */
  get worldY() {
    return this.depthOrigin + this.position.y;
  }

  /**
   * The TANK weight, and nothing else. 0 is "no station framing in the blend at
   * all" and 1 is "station framing exactly", which is precisely what this
   * accessor meant when the blend was a single scalar — so the gate's three
   * exact-equality assertions and the `?dev=1` readout keep their meaning
   * unchanged across the move to a simplex. It is deliberately NOT 1 − free:
   * that would report 1 in close framing, where no station is involved at all.
   */
  get modeMix() {
    return this._w.tank;
  }

  /**
   * The whole simplex, as a fresh object each call so nothing outside can write
   * a weight in behind the ease's back and break the Σw = 1 invariant every
   * blend below relies on.
   */
  get modeWeights() {
    const w = this._w;
    return { free: w.free, tank: w.tank, close: w.close };
  }

  /**
   * The station anchor in scene space, or null when no director has supplied
   * one. Read by the `?dev=1` panel and by the suite; never written from
   * outside — `setStation()` is the door.
   */
  get station() {
    return this._hasStation ? this._station : null;
  }

  /**
   * Choose a framing. `animalScene` is the animal's scene-space position, used
   * only when entering one of the two SUBJECT-anchored rigs: it re-seeds the
   * orbit's base azimuth so the orbit picks up at the bearing the camera already
   * has about the animal, which turns the switch into a radial dolly instead of
   * a lateral sweep. A dolly is the least disruptive direction through the snow
   * field — motes stream past rather than sweeping across strata. Close framing
   * needs the same trick applied to its own sun-locked bearing, which is what
   * `_reseedCloseBearing` is; both fire, so leaving close for free is a dolly
   * too rather than only arriving in it being one.
   *
   * The whitelist is explicit and anything unrecognised still lands on tank, so
   * a stray `?mode=` value or a future fourth key cannot silently select a
   * framing this class has no constants for.
   *
   * `immediate` is for boot and for a context restore only. On a keypress the
   * weights ease over MODE_TAU and `_primed` is deliberately NOT cleared: there
   * is no discontinuity to prime away, and clearing it would throw away a valid
   * accumulation for nothing.
   */
  setMode(mode, animalScene = null, immediate = false) {
    const K = CAMERA_CONSTANTS;
    const next = (mode === 'free' || mode === 'close') ? mode : 'tank';
    if (next !== 'tank' && animalScene) this._reseedOrbitAzimuth(animalScene);
    if (next === 'close' && animalScene) this._reseedCloseBearing(animalScene);
    this.mode = next;
    if (immediate) {
      this._w.free = 0;
      this._w.tank = 0;
      this._w.close = 0;
      this._w[next] = 1;
      /*
       * Boot straight into `?mode=close` opens on the FINISHED shot rather than
       * on one that spends the first five minutes rotating into its light: with
       * no bias the bearing is already the derived anti-sun one.
       */
      if (next === 'close') this._closeBearingBias = 0;
      const w = this._w;
      this.fovY = w.free * K.FOV_Y + w.tank * K.TANK_FOV_Y + w.close * K.CLOSE_FOV_Y;
      this._updateProjection();
      this._primed = false;
    }
    return this;
  }

  /**
   * The station, supplied fresh every frame by sim/director.js in scene space:
   * where the eye is anchored, where it should be aiming, and how fast that aim
   * point is moving (so the same 2·LOOK_TAU lead the subject rig uses applies
   * here too). Passing a null eye clears the station, which eases the tank
   * weight back toward the subject rig on the next step.
   */
  setStation(eyeScene, aimScene, aimVelocityScene) {
    if (!eyeScene) {
      this._hasStation = false;
      return this;
    }
    this._station.copyFrom(eyeScene);
    if (aimScene) this._stationAim.copyFrom(aimScene);
    if (aimVelocityScene) this._stationAimVelocity.copyFrom(aimVelocityScene);
    this._hasStation = true;
    return this;
  }

  setAspect(aspect) {
    if (!(aspect > 0) || aspect === this.aspect) return this;
    this.aspect = aspect;
    this._updateProjection();
    return this;
  }

  /** §2.5's guard band. Pass 0 at tier ≥ 3, where overscan is dropped. */
  setOverscan(fraction) {
    this.overscan = Math.max(0, fraction);
    this._updateProjection();
    return this;
  }

  setReducedMotion(on) {
    this.reducedMotion = !!on;
    return this;
  }

  /** Floating-origin rebase (§4.3): the rig lives in scene space like everything else. */
  translate(dx, dy, dz) {
    const d = new Vec3(dx, dy, dz);
    this.position = this.position.add(d);
    this.target = this.target.add(d);
    this._positionSpring.value.set(
      this._positionSpring.value.x + dx,
      this._positionSpring.value.y + dy,
      this._positionSpring.value.z + dz
    );
    this._lookSpring.value.set(
      this._lookSpring.value.x + dx,
      this._lookSpring.value.y + dy,
      this._lookSpring.value.z + dz
    );
    /*
     * Belt and braces. `setStation()` overwrites both of these every frame from
     * the director's world coordinates, so in steady state this is redundant —
     * but the rebase happens inside `simulate()` and the next `compose()` has
     * not run yet, so for one frame these are the only copies of the station in
     * scene space. Anything that reads them in that window must see the shifted
     * value, or the invariant "the station is world-fixed" has a one-frame hole.
     * The aim VELOCITY is a velocity, not a point, so it is deliberately not
     * shifted.
     */
    this._station.set(this._station.x + dx, this._station.y + dy, this._station.z + dz);
    this._stationAim.set(
      this._stationAim.x + dx,
      this._stationAim.y + dy,
      this._stationAim.z + dz
    );
    return this;
  }

  /** Re-seed and re-pose, for a context restore. */
  reset(targetPosition = new Vec3(0, 0, 0)) {
    this.rng.reset();
    this.time = 0;
    /*
     * `_driftTime` is draw #1 in the constructor and it is draw #1 here, which
     * is the whole reason this single line is enough: every phase below it in
     * the constructor is still holding the value that stream position gave it,
     * so re-drawing any ONE of them would hand it a different number and the
     * restored camera would no longer be the camera that booted. That matters
     * for `_phaseSunElevation` in particular — it is the eleventh draw up
     * there, so re-drawing it here would give it the SECOND value in the
     * stream, i.e. `_phaseRadius`'s, and the sun's elevation carrier would come
     * back locked to the orbit radius carrier's phase. A reset comes back
     * identical rather than merely similar; the only thing it is allowed to
     * forget is the `_lookError` wander, which is zeroed just below and has no
     * identity to preserve.
     */
    this._driftTime = this.rng.range(0, 1000);
    this._lookError.zero();
    this.elevationClampCount = 0;
    this.maxElevationDegreesSeen = -90;
    /*
     * The station is a per-frame gift from the director, and a restore has not
     * had one yet — so drop back to the subject rig and let `setStation()` plus
     * `setMode()` re-establish the framing. Leaving the weights where they were
     * would blend toward a station that is a whole rebase out of date. The
     * bearing bias goes with them: it was planted against a camera position that
     * a restore has just discarded, so keeping it would aim the close rig at a
     * bearing nothing in the scene has any more.
     */
    this._w.free = 1;
    this._w.tank = 0;
    this._w.close = 0;
    this._closeBearingBias = 0;
    this._hasStation = false;
    /* `_primed` makes the next step snap both springs onto the drift path. */
    this._primed = false;
    this.step(0, targetPosition);
    return this;
  }

  /**
   * One frame. `targetPosition` is the animal, in scene space — normally
   * `swim.position`, and `targetVelocity` its `swim.velocity`.
   */
  step(dt, targetPosition, targetVelocity = null) {
    const K = CAMERA_CONSTANTS;
    const h = clamp(dt, 0, 0.25);
    this.time += h;
    if (!this.reducedMotion) this._driftTime += h;

    /*
     * The mode blend, eased on the REAL h rather than on `_driftTime`, so a
     * keypress still does something under prefers-reduced-motion — the framing
     * is a way of watching, not a motion, and §4.6 stops the camera drifting
     * rather than stopping the viewer choosing.
     *
     * Every weight is pulled toward its one-hot target on the same exponential
     * the old scalar rode, which is what makes a mid-ease re-target correct by
     * construction: pressing "3" four frames into a 1 → 2 ease simply changes
     * which corner all three weights are heading for, from a pose that is on no
     * edge of the simplex and needs no special case. THE SUM IS CONSERVED
     * ANALYTICALLY — Σw' = Σw + k(1 − Σw), which is 1 whenever Σw was — so there
     * is no renormalisation and no division here, and hence no path by which a
     * NaN could reach a uniform through the blend.
     *
     * The snap to an exact one-hot within 1e-3 is what makes `modeMix === 0`
     * and `=== 1` reachable at all, and hence what makes the subject rig
     * bit-identical to the shipped page rather than merely indistinguishable
     * from it.
     */
    const target = (this.mode === 'tank' && !this._hasStation) ? 'free' : this.mode;
    const w = this._w;
    if (h > 0 && w[target] !== 1) {
      const k = 1 - Math.exp(-h / K.MODE_TAU);
      for (let i = 0; i < MODE_KEYS.length; i++) {
        const m = MODE_KEYS[i];
        w[m] += ((m === target ? 1 : 0) - w[m]) * k;
      }
      if (1 - w[target] < 1e-3) {
        for (let i = 0; i < MODE_KEYS.length; i++) w[MODE_KEYS[i]] = 0;
        w[target] = 1;
      }
    }

    /*
     * The entry bias on the close bearing decays here on the same real `h`, for
     * the same reason: it is a framing transient, not a drift. Zeroing it below
     * 1e-4 rad (0.006°) retires the term completely rather than leaving a
     * denormal-sized rotation in the azimuth for the rest of the session.
     */
    if (h > 0 && this._closeBearingBias !== 0) {
      this._closeBearingBias *= Math.exp(-h / K.CLOSE_BEARING_TAU);
      if (Math.abs(this._closeBearingBias) < 1e-4) this._closeBearingBias = 0;
    }

    /*
     * The lens is eased, never cut. It has to be re-projected here rather than
     * left to main.js's per-frame `setOverscan()`, because that call runs BEFORE
     * `simulate()` and would leave the projection one frame behind the fovY it
     * was built from. The guard means the shipped path — weights that never
     * move — does no work at all. The weighted sum is EXACT at every one-hot,
     * since 1·x + 0 + 0 is x: tighter than the two-term lerp it replaces, not
     * looser.
     */
    const fov = w.free * K.FOV_Y + w.tank * K.TANK_FOV_Y + w.close * K.CLOSE_FOV_Y;
    if (fov !== this.fovY) {
      this.fovY = fov;
      this._updateProjection();
    }

    const centre = targetPosition
      ? Vec3.from(targetPosition)
      : this.target.clone();

    /*
     * A spring following a moving subject sits a steady distance BEHIND it, and
     * this subject moves: the animal surges at 0.086 m/s in the mean, so the
     * look spring trailed it by most of a metre and the rig by a third of one,
     * which walked the animal steadily toward the frame edge and left the rig
     * further back than the orbit radius it was asked for. Leading each spring
     * by the subject's velocity cancels exactly that term and nothing else --
     * it is what an operator panning with a subject does.
     *
     * The SIZE of the lead is set by the integrator rather than by taste.
     * `springStep` is critically damped and SECOND-order, and a second-order
     * spring following a ramp settles TWO time constants behind it, so the
     * lead is 2*tau. At one tau half the lag survived: 0.41 m on the look
     * spring over 400 s, which is 16.8 degrees of angular offset inside a 19
     * degree half-frame, with the bell crossing the bottom edge on the tightest
     * orbits. At 2*tau the residual is 0.12 m and 5.5 degrees, which leaves the
     * wandering look error below as the only thing moving the animal around the
     * frame. The lead is filtered by the very spring it feeds, so the swim
     * cycle's own surge and coast comes through as under two centimetres of
     * drift.
     *
     * FRAMING_DROP then aims the look spring a bell radius low, which puts the
     * bell in the upper third with the fringe through the middle instead of the
     * bell in the middle with the fringe off the bottom. Being a constant
     * offset it adds no motion, and it can only tilt the rig DOWN: the highest
     * look elevation seen over 400 s falls from 14.4 degrees to 9.1, further
     * under the 25 degree anti-flare limit the constructor asserts.
     */
    const velocity = targetVelocity ? Vec3.from(targetVelocity) : null;
    const rigCentre = velocity ? centre.addScaled(velocity, 2 * K.POSITION_TAU) : centre;
    const aim = velocity ? centre.addScaled(velocity, 2 * K.LOOK_TAU) : centre;

    /*
     * The sun is advanced BEFORE the eye is computed, and close framing's whole
     * staging depends on that order: `_closeFrame()` reads `this.sunDirection`
     * to stand on the far side of the animal from the sun, so moving this call
     * below the blend would silently aim the close rig with last frame's sun.
     * One frame of SUN_AZIMUTH_PERIOD is 0.3° of bearing, which is invisible —
     * which is exactly why the mistake would never be caught by looking.
     */
    this._advanceSun();

    const freeFrame = this._orbitFrame();
    const freeEye = this._orbitEye(rigCentre, freeFrame.radius,
                                   freeFrame.elevation, freeFrame.azimuth);
    const freeLook = new Vec3(aim.x, aim.y - K.FRAMING_DROP, aim.z);

    /*
     * The blend, and the only place the three framings meet. It is on the
     * DESIRED eye and the look CENTRE — the springs' inputs — so every framing
     * is filtered by the same POSITION_TAU and LOOK_TAU the shipped rig has
     * always used, and the transition inherits their smoothness for free.
     * Blending the matrices instead would interpolate two different rotations
     * and produce a move nothing here could bound.
     *
     * FREE AND CLOSE ARE THE SAME ORBIT, so what is blended between those two is
     * the four SCALARS the orbit is built from — radius, elevation, azimuth and
     * drop — and the sphere is evaluated exactly once, from the blended scalars.
     * Blending the two eye POSITIONS would cut a chord through the sphere and
     * swing the camera sideways through the snow strata for the whole of a 3 s
     * ease, which is the one direction of travel `_reseedOrbitAzimuth` exists to
     * avoid; blending the scalars keeps the move a dolly along the ray the
     * camera is already on. The azimuth difference is taken through `wrapPi` so
     * the ease goes the short way round a bearing that is locked to a sun which
     * laps every six minutes. Station framing is a genuinely different rig with
     * no shared parameterisation, so it is blended as a point, exactly as it
     * always was, against the combined orbit weight.
     *
     * THE FIRST BRANCH IS THE SHIPPED ZERO-ARITHMETIC ALIASING and it must stay
     * that. Do not "simplify" it into the general expression on the grounds that
     * it is algebraically the same at weight zero: floating-point associativity
     * is not algebra, and tests/check.mjs's framing section asserts that a
     * station-fed free view is BIT-identical to a station-less one over 3600
     * frames — `worst === 0`, not `worst < eps`. It also covers `immediate`
     * having set a tank weight of 1 on a page with no station: `stationW` is 0
     * there, so the branch yields `freeEye`, exactly as it does today.
     *
     * The station clamps are then applied to the blended point, EASED on the
     * TANK weight specifically rather than on 1 − free. Both are monotone-safe
     * at full strength — capping the aim's height can only lower `forward.y`,
     * and pushing the aim out along its own ray changes `distanceToTarget` and
     * nothing about direction — so the station's 19.194° bound still holds at a
     * tank weight of 1, which is where the assertion is computed. At a close
     * weight of 1 the tank weight is 0 and both terms are exact identities, so
     * the close rig never inherits the station's 0.57 m aim ceiling or its
     * 1.85 m aim-distance floor — a floor which, pushed onto a 1.35 m rig, would
     * shove the look point straight through the animal and out the far side.
     *
     * Easing them rather than gating them removes the last discontinuity in the
     * transition. Gating the clamps on a mix above zero stepped the look
     * spring's INPUT by up to 1.40 m in a single frame at both ends of an ease —
     * 14x the largest change an ordinary eased frame produces — while every
     * other term that differs between the framings (the eye, the look centre,
     * `fovY`, the `_capPitch` cap, the look-error scale) was already continuous.
     * The springs absorbed the step, so it was never a visible cut.
     *
     * More importantly, it stops free view being aimed by the STATION's
     * geometry. The height ceiling is sized against where the station stands,
     * and the animal's own depth band is wider than it, so a hard ceiling stays
     * live through an ease toward free view — `desired` has already become the
     * orbit eye anchored on the animal while the aim is still pinned at scene
     * y = 0.57, a metre or more below it, for the whole ~21 s the ease takes.
     * The one thing free view promises is that the eye orbits the animal, and
     * that arrangement gave it up for twenty seconds at a time. Measured over
     * 40 switch cycles against the depth behaviour of the day — before
     * swim.js's depth term was given a wall, when `position.y` ran to ±2.4 m —
     * the animal was outside the frame cone on 6.9 % of ease frames, 19.5° off
     * at worst, for up to 1243 consecutive frames (20.7 s); eased, 3.3 %, 11.1°
     * and 832. With the depth wall in place the animal is bounded to about
     * ±1.16 m and neither arrangement loses it, so this is now a correctness
     * property rather than a visible one — which is exactly why the `framing`
     * section asserts the identity at a tank weight of 0 instead of chasing the
     * symptom.
     *
     * The call sits outside the branch above because at a tank weight of 0 it is
     * an exact identity — `lerp(y, ceiling, 0)` is `y` and `lerp(d, minD, 0)` is
     * `d`, so the min and the push are both no-ops — which keeps a station-less
     * page and a settled free view bit-identical to the shipped rig.
     */
    const orbW = w.free + w.close;
    const stationW = this._hasStation ? w.tank : 0;
    let desired;
    let lookCentre;
    if (stationW === 0 && w.close === 0) {
      desired = freeEye;
      lookCentre = freeLook;
    } else if (orbW === 0) {
      desired = this._stationEye();
      lookCentre = this._stationLookCentre();
    } else {
      let radius, elevation, azimuth, drop;
      if (w.close === 0) {
        radius = freeFrame.radius;
        elevation = freeFrame.elevation;
        azimuth = freeFrame.azimuth;
        drop = freeFrame.drop;
      } else if (w.free === 0) {
        const cf = this._closeFrame();
        radius = cf.radius;
        elevation = cf.elevation;
        azimuth = cf.azimuth;
        drop = cf.drop;
      } else {
        const cf = this._closeFrame();
        /* Renormalised onto the free–close edge of the simplex, which is the
           only edge the two share a parameterisation along. */
        const k = w.close / orbW;
        radius    = freeFrame.radius    + k * (cf.radius    - freeFrame.radius);
        elevation = freeFrame.elevation + k * (cf.elevation - freeFrame.elevation);
        azimuth   = freeFrame.azimuth   + k * wrapPi(cf.azimuth - freeFrame.azimuth);
        drop      = freeFrame.drop      + k * (cf.drop      - freeFrame.drop);
      }
      let orbEye = this._orbitEye(rigCentre, radius, elevation, azimuth);
      orbEye = this._applyCloseStandoff(orbEye, centre, w.close);
      const orbLook = new Vec3(aim.x, aim.y - drop, aim.z);
      if (stationW > 0) {
        const se = this._stationEye();
        const sl = this._stationLookCentre();
        desired = new Vec3(orbEye.x * orbW + se.x * stationW,
                           orbEye.y * orbW + se.y * stationW,
                           orbEye.z * orbW + se.z * stationW);
        lookCentre = new Vec3(orbLook.x * orbW + sl.x * stationW,
                              orbLook.y * orbW + sl.y * stationW,
                              orbLook.z * orbW + sl.z * stationW);
      } else {
        desired = orbEye;
        lookCentre = orbLook;
      }
    }
    if (this._hasStation) {
      lookCentre = this._applyStationAimClamps(lookCentre, desired, w.tank);
    }

    const lookTarget = this._lookTarget(lookCentre, h);

    if (!this._primed) {
      this._positionSpring.reset(desired);
      this._lookSpring.reset(lookTarget);
      this._primed = true;
    }
    const eye = this._positionSpring.step(desired, K.POSITION_TAU, h).clone();
    const look = this._lookSpring.step(lookTarget, K.LOOK_TAU, h).clone();

    /* The breathing bob is a shake on the rig, not a move of the rig's target. */
    if (!this.reducedMotion) {
      eye.y += K.BOB_AMPLITUDE * Math.sin(TAU * this._driftTime / K.BOB_PERIOD);
    }

    this.position = eye;
    this.target = look;
    this.distanceToTarget = Math.max(look.distanceTo(eye), 1e-3);

    let forward = look.sub(eye).normalizeOr(new Vec3(0, 0, -1));
    forward = this._applyHandheld(forward);
    /*
     * The soft cap, between the tremor and the tripwire, on a cap that is itself
     * the convex combination of the three framings' limits. THIS ONE LINE IS THE
     * WHOLE MID-TRANSITION ANTI-FLARE ARGUMENT, and it generalises for free:
     * `_capPitch` asymptotes to whatever cap it is handed, at any cap, with no
     * closed form; a convex combination of caps each strictly inside
     * MAX_LOOK_ELEVATION (which the constructor's loop asserts, cap by cap) is
     * itself strictly inside MAX_LOOK_ELEVATION; therefore
     * `elevationClampCount === 0` stays STRUCTURAL for any number of framings.
     *
     * Do not attempt a closed-form bound over the blend instead. The elevation
     * of a blended forward vector is not the blend of the two elevations, which
     * is precisely why the earlier arrangement of hard clamps had to be
     * abandoned; the asymptote is what replaces the closed form, not what
     * supplements it.
     *
     * Applying it AFTER the handheld matters: the tremor is the last thing that
     * can add elevation, so capping before it would leave HANDHELD_AMPLITUDE of
     * the guarantee outside the asymptote.
     */
    forward = this._capPitch(forward,
      w.free * K.MAX_LOOK_ELEVATION + w.tank * K.STATION_PITCH_CAP + w.close * K.CLOSE_PITCH_CAP);
    forward = this._clampElevation(forward);

    this.forward = forward;
    this.right = forward.cross(Vec3.from(WORLD_UP)).normalizeOr(new Vec3(1, 0, 0));
    const trueUp = this.right.cross(forward).normalizeOr(new Vec3(0, 1, 0));
    this.up = this._applyRoll(trueUp, this.right);

    this.elevationDegrees = Math.asin(clamp(forward.y, -1, 1)) * RAD_TO_DEG;
    if (this.elevationDegrees > this.maxElevationDegreesSeen) {
      this.maxElevationDegreesSeen = this.elevationDegrees;
    }

    mat4.lookAt(this.view, eye, eye.addScaled(forward, this.distanceToTarget), this.up);
    mat4.multiply(this.viewProjection, this.projection, this.view);
    mat4.multiply(this.overscanViewProjection, this.overscanProjection, this.view);
    if (!mat4.invert(this.inverseViewProjection, this.viewProjection)) {
      mat4.identity(this.inverseViewProjection);
    }
    if (!mat4.invert(this.inverseOverscanViewProjection, this.overscanViewProjection)) {
      mat4.identity(this.inverseOverscanViewProjection);
    }
    return this;
  }

  /* --- Internals -------------------------------------------------------- */

  /**
   * The Lissajous, reported as the four scalars the orbit is built from rather
   * than as a point, so that free and close framing can be blended ALONG the
   * orbit instead of across the chord between two points on it. Note which
   * period drives which axis: the radius has the largest excursion (1.3 m) so it
   * gets the longest period (127 s), which caps its peak speed at about 3 cm/s.
   * Assigning it the 59 s axis instead would triple that and put a visible sway
   * in the framing.
   *
   * The three expressions are character for character what `_orbitPosition`
   * evaluated before the split, which is what keeps `freeEye` bit-identical.
   */
  _orbitFrame() {
    const K = CAMERA_CONSTANTS;
    const t = this._driftTime;
    return {
      radius: K.ORBIT_RADIUS_MEAN + K.ORBIT_RADIUS_SWING *
        Math.sin(TAU * t / K.ORBIT_RADIUS_PERIOD + this._phaseRadius),
      elevation: K.ORBIT_ELEVATION_MEAN + K.ORBIT_ELEVATION_SWING *
        Math.sin(TAU * t / K.ORBIT_ELEVATION_PERIOD + this._phaseElevation),
      azimuth: this._baseAzimuth + K.ORBIT_AZIMUTH_SWING *
        Math.sin(TAU * t / K.ORBIT_AZIMUTH_PERIOD + this._phaseAzimuth),
      drop: K.FRAMING_DROP
    };
  }

  /**
   * The same four scalars for close framing.
   *
   * The bearing is LOCKED TO THE SUN: `this.sunDirection` points toward the sun,
   * so adding π puts the eye on the far side of the animal from it, and
   * CLOSE_BACK_OFFSET then steps 22° off dead-anti-sun. It reads a
   * `sunDirection` that `_advanceSun()` has already refreshed this frame — see
   * the comment at that call site in `step()`, because if the call ever moves
   * below the blend this rig silently uses last frame's sun.
   *
   * SUN_AZIMUTH_PERIOD is 360 s, so a bearing locked to it orbits the animal
   * once every six minutes. That is faced and accepted rather than hidden. It
   * introduces NO NEW CARRIER — it rides the sun's own already-shipped 360 s
   * one, which is outside §10's forbidden 20–300 s band by 60 s. In the camera's
   * own frame the sun is then fixed, so the shaft lean, the caustic key on the
   * bell and the entire lighting stance are frozen: the calmest lighting the
   * page can have, and permanently the GOOD light. Latching the bearing at entry
   * instead puts the sun on the wrong side within three minutes and destroys the
   * mechanism outright. And the rate is one the page already produces: tangential
   * eye speed is 1.35·2π/360 = 23.6 mm/s, within 6 % of the 22.4 mm/s the shipped
   * free rig already reaches at its peak azimuthal rate, i.e. 0.39 mm per frame
   * at 60 Hz, 100× under shafts.js's SHAFT_HISTORY_REJECT_METRES = 0.04. What it
   * sweeps through is landmark-free: sim/snow.js's three strata are bands around
   * the CAMERA and travel with the rig, the water column is isotropic, and the
   * shaft field is statistically isotropic with nothing in it to track.
   *
   * The radius carrier reuses `_phaseRadius`, the elevation carrier
   * `_phaseElevation` with ORBIT_ELEVATION_PERIOD, and the azimuth swing
   * `_phaseAzimuth` with the free rig's own swing and period. No fresh rng draw
   * is made here or anywhere else in close framing.
   */
  _closeFrame() {
    const K = CAMERA_CONSTANTS;
    const t = this._driftTime;
    const sunAz = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    return {
      radius: K.CLOSE_RADIUS_MEAN + K.CLOSE_RADIUS_SWING *
        Math.sin(TAU * t / K.CLOSE_RADIUS_PERIOD + this._phaseRadius),
      elevation: K.CLOSE_ELEVATION_MEAN + K.CLOSE_ELEVATION_SWING *
        Math.sin(TAU * t / K.ORBIT_ELEVATION_PERIOD + this._phaseElevation),
      azimuth: sunAz + Math.PI + K.CLOSE_BACK_OFFSET + this._closeBearingBias +
        K.ORBIT_AZIMUTH_SWING *
        Math.sin(TAU * t / K.ORBIT_AZIMUTH_PERIOD + this._phaseAzimuth),
      drop: K.CLOSE_FRAMING_DROP
    };
  }

  /**
   * The sphere evaluation — the three lines `_orbitPosition` ended with, now
   * shared by both orbit framings and by the blended frame between them.
   */
  _orbitEye(centre, radius, elevation, azimuth) {
    const ce = Math.cos(elevation), se = Math.sin(elevation);
    return new Vec3(
      centre.x + ce * Math.cos(azimuth) * radius,
      centre.y + se * radius,
      centre.z + ce * Math.sin(azimuth) * radius
    );
  }

  /**
   * Plant `_closeBearingBias` so that, at the current `_driftTime`, the
   * commanded close bearing EQUALS the bearing the camera already has about the
   * animal — which makes entering close framing a radial dolly rather than a
   * lateral sweep through the snow strata, exactly the argument
   * `_reseedOrbitAzimuth` makes for the subject rig's azimuth. The bias then
   * decays on CLOSE_BEARING_TAU, so the shot arrives and afterwards, over five
   * to eight minutes, finds its light.
   *
   * The sun this reads is at most one frame stale — 0.3° of azimuth at
   * SUN_AZIMUTH_PERIOD = 360 s — and the bias it lands in decays away regardless,
   * so no ordering guarantee is needed here beyond the one `step()` already has.
   */
  _reseedCloseBearing(animalScene) {
    const bearing = Math.atan2(
      this.position.z - animalScene.z,
      this.position.x - animalScene.x
    );
    /* Zeroed first so `_closeFrame()` reports the UNBIASED bearing to measure
       against; the next line is what the bias actually becomes. */
    this._closeBearingBias = 0;
    const target = this._closeFrame().azimuth;
    this._closeBearingBias = wrapPi(bearing - target);
    return this;
  }

  /**
   * A floor on eye-to-ANIMAL distance, applied by sliding the desired eye out
   * along its own ray from the animal, so the DIRECTION — and therefore the
   * elevation the close constructor clause bounds — is untouched. It is the same
   * monotone, direction-preserving trick `_applyStationAimClamps` uses on the
   * aim, and for the same reason: a clamp that changes direction would invalidate
   * the derivation, and one that changes only distance cannot.
   *
   * The floor exists because the orbit is centred on `rigCentre`, the animal led
   * by velocity·2·POSITION_TAU — a 0.31 m lead at the 0.086 m/s cruise — so the
   * eye-to-animal distance is NOT the orbit radius and the constants floor of
   * 1.20 m is not by itself enough to keep the animal outside SNOW_FOCUS_MIN's
   * 1.0 m near-focus clamp. A prototype of an equivalent rig measured 1.139 m
   * over two simulated hours at three step rates.
   *
   * Eased on the close weight, so `lerp(d, X, 0)` is `d` and the whole function
   * is an exact identity outside close framing — which is what lets the blend
   * above call it unconditionally on the orbit eye.
   */
  _applyCloseStandoff(eye, centre, closeW) {
    const K = CAMERA_CONSTANTS;
    const dx = eye.x - centre.x;
    const dy = eye.y - centre.y;
    const dz = eye.z - centre.z;
    const d = Math.hypot(dx, dy, dz);
    const minD = lerp(d, K.CLOSE_MIN_EYE_DISTANCE, closeW);
    /* `d < 1e-6` is the degenerate case where the eye has collapsed onto the
       animal and there is no ray to slide along; leave it to the springs, which
       are already moving it, rather than inventing a direction. */
    if (d >= minD || d < 1e-6) return eye;
    const k = minD / d;
    return new Vec3(centre.x + dx * k, centre.y + dy * k, centre.z + dz * k);
  }

  /**
   * The look-at target is the animal plus a slowly wandering offset, which is
   * what keeps the jellyfish drifting around the frame. Ornstein-Uhlenbeck
   * rather than a walk, and hard-clamped in length, because the clamp on the
   * error is one of the two terms the constructor's assertion depends on.
   */
  _lookTarget(centre, dt) {
    const K = CAMERA_CONSTANTS;

    /*
     * The error is a fixed 0.24 m of DISTANCE, which is the right unit for an
     * orbit that holds the subject at 1.3–2.2 m and the wrong one for a station
     * that watches it between 1.35 m and 5.15 m: unscaled, the same wander
     * subtends 10° on a close pass and 2.7° at the far wall, so its whole
     * purpose — §4.5's "the jellyfish drifts around the frame instead of being
     * pinned" — inverts across the mode's own range, and the near end eats the
     * elevation budget the constructor just spent.
     *
     * Scaling it by the subject distance makes the SUBTENDED angle the constant
     * instead. Because STATION_MIN_AIM_DISTANCE (1.85) is above
     * ORBIT_RADIUS_MEAN (1.75), the station scale is always dRef/1.75 and the
     * angle is a fixed asin(0.24/1.75) = 7.874°; STATION_ERROR_MARGIN is what
     * covers the spring transients around it.
     *
     * CLOSE FRAMING IS THE FIRST PLACE IN THIS FILE WHERE THE ERROR SCALES DOWN.
     * Unscaled, 0.24 m at 1.35 m subtends 10.24° inside a 15° half-frame; with
     * CLOSE_LOOK_ERROR_SCALE the subtended angle is the constant
     * asin(0.24 · 0.65 / 1.75) = 5.114°, i.e. 34.1 % of the half-frame against
     * free view's 41.4 %. Tighter, because the animal now fills three quarters
     * of the frame rather than a third — §4.5's drift is preserved and
     * tightened, not abandoned. The station term deliberately keeps its
     * `Math.max(1, …)` floor byte-identical, so the gate's named inequality
     * about the station error scaling up and never down still describes it: the
     * close term is a separate, unfloored product.
     *
     * At a free weight of 1 the scale is exactly 1 (1·1 + 0 + 0), and
     * `addScaled(err, 1)` is bit-identical to the `add(err)` this used to be.
     */
    const dRef = Math.max(this.distanceToTarget, K.STATION_MIN_AIM_DISTANCE);
    const stationScale = Math.max(1, dRef / K.ORBIT_RADIUS_MEAN);
    const closeScale = K.CLOSE_LOOK_ERROR_SCALE *
      (this.distanceToTarget / K.ORBIT_RADIUS_MEAN);
    const w = this._w;
    const scale = w.free * 1 + w.tank * stationScale + w.close * closeScale;

    if (this.reducedMotion || dt <= 0) return centre.addScaled(this._lookError, scale);

    this._lookError.set(
      ouStep(this._lookError.x, 0, K.LOOK_ERROR_TAU, K.LOOK_ERROR_SIGMA, dt, this.rng),
      ouStep(this._lookError.y, 0, K.LOOK_ERROR_TAU, K.LOOK_ERROR_SIGMA, dt, this.rng),
      ouStep(this._lookError.z, 0, K.LOOK_ERROR_TAU, K.LOOK_ERROR_SIGMA, dt, this.rng)
    );
    const clamped = this._lookError.clampLength(K.LOOK_ERROR_MAX);
    this._lookError.copyFrom(clamped);
    return centre.addScaled(this._lookError, scale);
  }

  /**
   * Re-seed the orbit's base azimuth so that, at the current `_driftTime`, the
   * orbit's azimuth EQUALS the bearing the camera already has about the animal.
   * Called when entering the subject rig, and it is the whole reason a mode
   * switch is a dolly rather than a sweep: with the lateral component removed
   * the move is almost purely radial, which is the least disruptive direction
   * through the marine snow — motes stream past instead of crossing strata.
   */
  _reseedOrbitAzimuth(animalScene) {
    const K = CAMERA_CONSTANTS;
    const bearing = Math.atan2(
      this.position.z - animalScene.z,
      this.position.x - animalScene.x
    );
    const swingNow = K.ORBIT_AZIMUTH_SWING *
      Math.sin(TAU * this._driftTime / K.ORBIT_AZIMUTH_PERIOD + this._phaseAzimuth);
    this._baseAzimuth = bearing - swingNow;
    return this;
  }

  /**
   * The station eye: the director's world-fixed anchor plus a small shake, on
   * the SAME 127 / 83 / 59 s periods and the same per-run phases as the orbit
   * above, so the shipped Lissajous character survives as a texture on a fixed
   * point rather than as an orbit around the subject. Driven by `_driftTime`,
   * so §4.6 freezes it along with every other camera drift.
   */
  _stationEye() {
    const K = CAMERA_CONSTANTS;
    const t = this._driftTime;
    return new Vec3(
      this._station.x + K.STATION_SHAKE *
        Math.sin(TAU * t / K.ORBIT_RADIUS_PERIOD + this._phaseRadius),
      this._station.y + K.STATION_SHAKE *
        Math.sin(TAU * t / K.ORBIT_ELEVATION_PERIOD + this._phaseElevation),
      this._station.z + K.STATION_SHAKE *
        Math.sin(TAU * t / K.ORBIT_AZIMUTH_PERIOD + this._phaseAzimuth)
    );
  }

  /**
   * The station's look centre, built exactly the way the subject rig's is: the
   * director's aim point led by 2·LOOK_TAU of its own velocity, because
   * `springStep` is second-order and settles two time constants behind a ramp,
   * then dropped by FRAMING_DROP so the bell sits in the upper third with the
   * fringe through the middle. The director has already applied the dead band
   * and the follow gain to that point, so the lead here is on the AIM's motion,
   * not on the animal's.
   */
  _stationLookCentre() {
    const K = CAMERA_CONSTANTS;
    const lead = 2 * K.LOOK_TAU;
    return new Vec3(
      this._stationAim.x + this._stationAimVelocity.x * lead,
      this._stationAim.y + this._stationAimVelocity.y * lead - K.FRAMING_DROP,
      this._stationAim.z + this._stationAimVelocity.z * lead
    );
  }

  /**
   * The two terms the station elevation assertion is built on, applied to the
   * blended look centre and eased on `m` — the TANK weight, which is the weight
   * station framing carries in the blend, never `1 − free`. That distinction is
   * the whole reason close framing is safe here: at a close weight of 1 the tank
   * weight is 0, both lerps return their first argument, and the function is an
   * exact identity.
   *
   *   1. A ceiling on the aim's height. Lowering an aim point can only lower
   *      `forward.y`, so it is monotone-safe at full strength.
   *   2. A floor on the aim's DISTANCE, applied by sliding the point out along
   *      its own ray from the eye. `mat4.lookAt` is fed
   *      `eye.addScaled(forward, distanceToTarget)` and therefore uses the
   *      direction only, so this changes `distanceToTarget` — which is what the
   *      look-error scale and the assertion's leg length both read — and
   *      nothing whatever about framing. It is free.
   *
   * Both are eased by walking the LIMIT rather than the result: the ceiling
   * runs from the aim's own height at m = 0 to STATION_AIM_MAX_HEIGHT −
   * FRAMING_DROP at m = 1, and the distance floor from the aim's own distance
   * to STATION_MIN_AIM_DISTANCE. That keeps each term monotone at every m — the
   * `min` can still only lower y, and the eased floor is never above the hard
   * one, so it can only push the aim further out — which is what lets the
   * 19.194° derivation, which is computed at m = 1, stand unchanged. At m = 0
   * both lerps return their first argument exactly, so the whole function is an
   * identity and a settled free view is bit-identical to the shipped rig.
   *
   * Easing rather than gating is deliberate and was measured. A hard switch at
   * the "tank weight above zero" boundary put a 1.40 m step into the look
   * spring's input on the frame it snapped, and — far worse — held free view's
   * aim under
   * a 0.57 m ceiling for the whole ~21 s of a tank→free ease while the eye had
   * already become the orbit eye, which — measured against the unbounded depth
   * behaviour of the day, before swim.js's depth term was given a wall — put
   * the animal off the top of frame for up to 1243 consecutive frames against
   * 832 eased, and 19.5° outside the cone against 11.1°. The depth wall has
   * since made that particular symptom unreachable, so what is left is the
   * structural claim: the station's ceiling belongs to the station, and free
   * view must not be aimed by it.
   */
  _applyStationAimClamps(lookCentre, eye, m) {
    const K = CAMERA_CONSTANTS;
    const ceiling = lerp(lookCentre.y, K.STATION_AIM_MAX_HEIGHT - K.FRAMING_DROP, m);
    const y = Math.min(lookCentre.y, ceiling);

    const dx = lookCentre.x - eye.x;
    const dy = y - eye.y;
    const dz = lookCentre.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    const minD = lerp(d, K.STATION_MIN_AIM_DISTANCE, m);
    if (d >= minD) return new Vec3(lookCentre.x, y, lookCentre.z);
    if (d < 1e-6) {
      /* The aim has collapsed onto the eye and has no ray of its own; keep the
         direction the rig is already pointing, exactly as `_clampElevation`
         keeps the last horizontal when handed a straight-up forward. */
      return eye.addScaled(this.forward, minD);
    }
    const k = minD / d;
    return new Vec3(eye.x + dx * k, eye.y + dy * k, eye.z + dz * k);
  }

  /**
   * The soft half of the anti-flare guarantee, and the reason
   * `_clampElevation` below is now a tripwire rather than a backstop.
   *
   * It works on sin(elevation) — which is just `forward.y` on a unit vector, so
   * there is no trigonometry per frame — and compresses the last
   * PITCH_SOFT_BAND below the cap through a tanh. Two properties do all the
   * work. tanh'(0) = 1, so the join at the soft edge is C¹ and nothing about
   * ordinary framing changes as the vector crosses it. And tanh is bounded by
   * 1, so the result ASYMPTOTES to sin(cap) and can never reach it, at any cap
   * — and therefore at every point of the weight simplex, since the cap it is
   * handed there is a convex combination of caps that are each strictly inside
   * MAX_LOOK_ELEVATION. `elevationClampCount` is structurally 0 rather than
   * merely observed to be, which is exactly the claim `?dev=1`'s
   * `strictElevation` throw is asserting.
   */
  _capPitch(forward, capRad) {
    const K = CAMERA_CONSTANTS;
    const soft = capRad - K.PITCH_SOFT_BAND;
    const sMax = Math.sin(capRad);
    const sSoft = Math.sin(soft);
    if (forward.y <= sSoft) return forward;

    /* Positive by the constructor's 0 < PITCH_SOFT_BAND < STATION_PITCH_CAP clause. */
    const band = sMax - sSoft;
    const y = sSoft + band * Math.tanh((forward.y - sSoft) / band);
    const horizontal = Math.hypot(forward.x, forward.z);
    const wanted = Math.sqrt(Math.max(0, 1 - y * y));
    if (horizontal < 1e-6) {
      const fallback = new Vec3(this.forward.x, 0, this.forward.z).normalizeOr(new Vec3(0, 0, -1));
      return new Vec3(fallback.x * wanted, y, fallback.z * wanted);
    }
    const k = wanted / horizontal;
    return new Vec3(forward.x * k, y, forward.z * k);
  }

  /**
   * Four components near 0.25 Hz at mutually irrational ratios, so the tremor
   * never settles into a recognisable beat. The rotation is applied as a linear
   * nudge to the forward vector rather than as a pair of true rotations: at
   * 0.0015 rad the difference is below a thousandth of a pixel, and the linear
   * form cannot introduce a gimbal case.
   */
  _applyHandheld(forward) {
    if (this.reducedMotion) return forward;
    const K = CAMERA_CONSTANTS;
    const t = this._driftTime;
    const p = this._handheldPhase;
    const f = K.HANDHELD_FREQUENCY;

    const yaw = K.HANDHELD_AMPLITUDE * (
      0.7 * Math.sin(TAU * f * t + p[0]) +
      0.5 * Math.sin(TAU * f * 0.764 * t + p[1])
    ) / 1.2;
    const pitch = K.HANDHELD_AMPLITUDE * (
      0.7 * Math.sin(TAU * f * 0.932 * t + p[2]) +
      0.5 * Math.sin(TAU * f * 1.108 * t + p[3])
    ) / 1.2;

    const right = forward.cross(Vec3.from(WORLD_UP)).normalizeOr(new Vec3(1, 0, 0));
    const up = right.cross(forward).normalizeOr(new Vec3(0, 1, 0));
    return forward.addScaled(right, yaw).addScaled(up, pitch).normalizeOr(forward);
  }

  /**
   * The runtime half of the anti-flare guarantee. On the shipped constants this
   * cannot fire — the constructor proved it — so any non-zero
   * `elevationClampCount` means the drift was retuned and the assertion should
   * be re-derived rather than the clamp relied upon.
   */
  _clampElevation(forward) {
    const K = CAMERA_CONSTANTS;
    const maxY = Math.sin(K.MAX_LOOK_ELEVATION);
    if (forward.y <= maxY) return forward;

    this.elevationClampCount++;
    if (this.strictElevation) {
      throw new Error(
        'camera.js: look elevation reached ' +
        (Math.asin(clamp(forward.y, -1, 1)) * RAD_TO_DEG).toFixed(2) +
        '°, above the §4.5 limit of ' + (K.MAX_LOOK_ELEVATION * RAD_TO_DEG).toFixed(0) + '°.'
      );
    }

    const horizontal = Math.hypot(forward.x, forward.z);
    const wanted = Math.sqrt(Math.max(0, 1 - maxY * maxY));
    if (horizontal < 1e-6) {
      /* Straight up: there is no horizontal direction to preserve, so keep the last one. */
      const fallback = new Vec3(this.forward.x, 0, this.forward.z).normalizeOr(new Vec3(0, 0, -1));
      return new Vec3(fallback.x * wanted, maxY, fallback.z * wanted);
    }
    const k = wanted / horizontal;
    return new Vec3(forward.x * k, maxY, forward.z * k);
  }

  /** ±0.5° of roll on two slow, mutually irrational carriers. */
  _applyRoll(trueUp, right) {
    if (this.reducedMotion) return trueUp;
    const K = CAMERA_CONSTANTS;
    const t = this._driftTime;
    const roll = K.ROLL_AMPLITUDE * (
      0.6 * Math.sin(TAU * t / K.ROLL_PERIOD_A) +
      0.4 * Math.sin(TAU * t / K.ROLL_PERIOD_B + 1.2)
    );
    return trueUp.scale(Math.cos(roll)).addScaled(right, Math.sin(roll)).normalizeOr(trueUp);
  }

  /**
   * §4.5's sun: 72° elevation with a six-minute azimuth drift, and now a ±6°
   * elevation carrier over 1730 s on top of it. Points FROM the scene TOWARD
   * the sun, with a positive y — which is the convention `causticAt()` needs,
   * since it divides by `uSunDir.y` to project a world point up onto the
   * surface plane.
   *
   * Both terms run on `sunTime`, the director's optical clock, rather than on
   * `_driftTime`. The elevation swing is nearly mean-preserving in brightness —
   * `causticAt()` is normalised to mean 1, so what it actually does is slide the
   * gobo's surface projection by 14·(cot 66° − cot 78°) = 3.25 m and lean the
   * shafts — and the constructor asserts it leaves SUN_CLEARANCE_MIN of margin
   * over the highest look the clamp permits, so it cannot walk into §4.5's
   * flare.
   */
  _advanceSun() {
    const K = CAMERA_CONSTANTS;
    const t = this.sunTime;
    const az = this._sunAzimuth + TAU * t / K.SUN_AZIMUTH_PERIOD;
    const elevation = K.SUN_ELEVATION + K.SUN_ELEVATION_SWING *
      Math.sin(TAU * t / K.SUN_ELEVATION_PERIOD + this._phaseSunElevation);
    const ce = Math.cos(elevation), se = Math.sin(elevation);
    this.sunDirection.set(ce * Math.cos(az), se, ce * Math.sin(az));
  }

  /**
   * Two projections: the framing one, and one widened by the guard band. The
   * overscan widens the vertical FOV and keeps the aspect, so it grows the
   * frustum uniformly rather than stretching it.
   */
  _updateProjection() {
    const K = CAMERA_CONSTANTS;
    mat4.perspective(this.projection, this.fovY, this.aspect, K.NEAR_PLANE, K.FAR_PLANE);
    const wide = 2 * Math.atan(Math.tan(this.fovY * 0.5) * (1 + this.overscan));
    mat4.perspective(this.overscanProjection, wide, this.aspect, K.NEAR_PLANE, K.FAR_PLANE);
  }
}
