/* ============================================================
   geometry/strands.js — oral arms and tentacles.
   ------------------------------------------------------------
   §3.3 and §3.4: the topology, the static index templates, the
   per-frame vertex packer, and §2.6's per-strand depth sort.
   This file owns the shape of the strands and where they attach;
   sim/verlet.js owns how they move, and js/shaders/strands.js
   owns how they are lit.

   TENTACLES ARE SCATTERERS, NOT SURFACES (§2.6). A 1 mm
   translucent thread genuinely is a low-density scatterer with a
   soft cross-section, so a strand is a two-vertex-wide camera-
   facing strip with a supergaussian falloff across it and no
   silhouette at all. That deletes the entire class of thin-
   geometry aliasing, and it is why nothing here computes a
   normal, a tangent frame for shading, or a hard edge.

   THE COUNT IS FORTY. §7: "tentacle count is fixed at 40 in every
   quality tier, forever." Half the tentacles vanishing on a tier
   change is not a graceful degrade, it is an event, and this page
   is meant to be watched for hours. `TENTACLE_COUNT` is exported
   as a constant, not as a tier knob, and the quality ladder has
   no business reading it.

   THE ROOTS COME FROM THE BELL, NOT FROM A GUESS. Every root is
   `bellRimPoint()` from geometry/bell.js — the same sculpted
   profile, lappets, rhopalia and baked imperfection the mesh was
   built from — pushed through `deformBell()` from sim/deform.js,
   the same function the vertex shader runs. The margin moves
   3 cm on every stroke; a root computed any other way detaches
   visibly, and only while the animal is moving, which is the
   worst kind of bug to chase.

   PER-STRAND SORT, NOT A PER-FRAGMENT SPLIT (§2.6 contradiction
   4). Forty chains sort in microseconds; the per-fragment
   alternative needs a full-resolution bell depth buffer and then
   cuts a SOFT object at a hard boundary, which is the wrong
   operation. The granularity error is invisible on something with
   no silhouette, and a strand crossing the rim gets fogged rather
   than clipped. The sort writes a reordered INDEX buffer, so the
   two groups stay two draw calls rather than forty.
   ============================================================ */

import { TAU, lerp, clamp, Rng, quat, vec3 } from '../math.js';
import { createBuffer, createVertexArray } from '../gl.js';
import { BELL_RADIUS } from './profile.js';
import {
  bellRimPoint,
  manubriumAttachment,
  MANUBRIUM_ATTACH_PHI,
  createBakedImperfection
} from './bell.js';
import { DEFORM, deformBell, retardedTime } from '../sim/deform.js';

/* --- Counts and dimensions ---------------------------------------------- */

/**
 * §3.4, and §7's "fixed at 40 in every quality tier, forever". Not a knob.
 */
export const TENTACLE_COUNT = 40;
export const TENTACLE_NODES = 14;
/** §3.4: 12 verlet-solved guides, 28 barycentric between them. */
export const GUIDE_COUNT = 12;

/** §3.3: four ribbons, 20 nodes, a 5-point ruffled cross-section. */
export const ARM_COUNT = 4;
export const ARM_NODES = 20;
export const ARM_CROSS_POINTS = 5;

/** §3.4: world half-width 0.9 mm, with a screen-space minimum in the shader. */
export const TENTACLE_HALF_WIDTH = 0.0009;
/** §2.6: the screen-space floor, in pixels, with compensating alpha. */
export const STRAND_MIN_WIDTH_PX = 1.4;

/**
 * Tentacle length, in units of R. An Aurelia's marginal tentacles are a short
 * fringe at rest and stream to several times that behind a swimming animal;
 * 1.6 R is the length that reads as trailing without turning the silhouette
 * into a mop. §3.4's log-normal spread and the long/short outliers are applied
 * on top of this median.
 */
export const TENTACLE_LENGTH = 1.6;
export const TENTACLE_LENGTH_SIGMA = 0.35;
/** §3.4: "Three noticeably long, two broken short." */
const LONG_STRAND_COUNT = 3;
const LONG_STRAND_SCALE = 1.9;
const SHORT_STRAND_COUNT = 2;
const SHORT_STRAND_SCALE = 0.35;

/** §3.3: arm width 0.9 R at the root falling to 0.15 R at the tip. */
export const ARM_WIDTH_ROOT = 0.9;
export const ARM_WIDTH_TIP = 0.15;
/** §3.3: the frill, `w += 0.012 R · sin(9s + 2.4·t_ret + hash(arm))`. */
export const ARM_FRILL_AMPLITUDE = 0.012;
export const ARM_FRILL_FREQUENCY = 9.0;
export const ARM_FRILL_RETARDED_RATE = 2.4;
/**
 * §3.3's out-of-plane ruffle, in units of R, and the phase advance across the
 * ribbon's width. Not in the spec's width formula — see `packArms` for why five
 * collinear points would be indistinguishable from two.
 */
export const ARM_RUFFLE_DEPTH = 0.030;
export const ARM_RUFFLE_ACROSS = 2.2;

/** Oral arms are §2.6's "vDensity ~3× higher". */
export const ARM_DENSITY = 3.0;
/** Arm length in units of R. */
export const ARM_LENGTH = 2.0;

/**
 * How far out from straight-down the strands flare at the root. Purely a rest
 * pose: the solver takes over immediately, but a chain initialised straight
 * down through the subumbrella would spend its first second climbing out of
 * the animal.
 */
const ROOT_FLARE = 0.22;

/**
 * §4.4's retarded-time sway, used by `packTentaclesAnalytic`. Amplitude is a
 * fraction of the strand's own length so a long tentacle sways wide and a torn
 * short one barely moves, which is what the spec's `A(s)` is for.
 */
const SWAY_AMPLITUDE = 0.22;
const SWAY_SPATIAL_FREQUENCY = 6.0;
const SWAY_TEMPORAL_RATE = 1.7;

/* --- Vertex format ------------------------------------------------------ */

/**
 * One vertex format for arms and tentacles, so §2.6's single fragment shader
 * really is single.
 *
 *   aPos      vec3  the SPINE position — both edge vertices of a node share it
 *   aTangent  vec3  unit tangent along the strand at that node
 *   aParam2   vec4  (across, halfWidth, density, ruffle)
 *
 * The vertex shader, not this file, does the widening: it needs the projection
 * to enforce §2.6's 1.4-pixel screen-space minimum and to compute the
 * compensating alpha, and it needs the eye vector to make the strip
 * camera-facing. Offsetting on the CPU would freeze the ribbon into whatever
 * orientation it had when it was packed.
 *
 * `across` runs −1 … +1 across the ribbon; `ruffle` is an out-of-plane
 * displacement in metres, zero for tentacles (see the oral-arm note below).
 */
export const STRAND_ATTRIBUTE_LOCATIONS = Object.freeze({
  aPos: 0, aTangent: 1, aParam2: 2
});
export const STRAND_VERTEX_FLOATS = 10;
export const STRAND_VERTEX_BYTES = STRAND_VERTEX_FLOATS * 4;

/* --- Strand table ------------------------------------------------------- */

/**
 * Builds the frozen per-strand parameters: azimuth, which two guides a strand
 * interpolates between, and §3.4's hash decorrelation of length, phase and
 * thickness.
 *
 * The guides are a SUBSET of the forty azimuths rather than an independent ring
 * of twelve. If the guides sat at their own evenly spaced angles, every guide
 * would fall between two rendered strands and no rendered strand would ever be
 * exactly a solved chain — so the whole bundle would be interpolated, and the
 * interpolation would smooth away precisely the sharp flick that §4.4's shed
 * vortex ring is supposed to produce. Twelve of the forty ARE the solved
 * chains; the other twenty-eight are blended.
 */
function buildStrandTable(rng) {
  const guideStrandIndex = new Int32Array(GUIDE_COUNT);
  for (let g = 0; g < GUIDE_COUNT; g++) {
    guideStrandIndex[g] = Math.round(g * TENTACLE_COUNT / GUIDE_COUNT) % TENTACLE_COUNT;
  }
  const isGuideIndex = new Uint8Array(TENTACLE_COUNT);
  for (let g = 0; g < GUIDE_COUNT; g++) isGuideIndex[guideStrandIndex[g]] = 1;

  const strands = [];
  for (let s = 0; s < TENTACLE_COUNT; s++) {
    // A little azimuthal jitter so the fringe is not a comb. Kept under a third
    // of the spacing, because two tentacles sharing an azimuth read as one.
    const jitter = (rng.float() - 0.5) * (TAU / TENTACLE_COUNT) * 0.35;
    strands.push({
      index: s,
      theta: s * (TAU / TENTACLE_COUNT) + jitter,
      guideA: 0, guideB: 0, blend: 0,
      isGuide: isGuideIndex[s] === 1,
      guideIndex: -1,
      // §3.4 decorrelates LENGTH on the interpolated strands only (see below);
      // thickness, density and sway phase decorrelate on all forty, because
      // none of the three touches the solver.
      lengthScale: 1,
      thicknessScale: rng.range(0.72, 1.34),
      densityScale: rng.range(0.85, 1.20),
      // Only the analytic fallback path reads this, but it is decided here so
      // the fallback and the solver agree about which strand is which.
      swayPhase: rng.range(0, TAU),
      length: 0,
      segmentLength: 0
    });
  }

  for (let g = 0; g < GUIDE_COUNT; g++) strands[guideStrandIndex[g]].guideIndex = g;

  // Assign each strand the two guides that bracket it, by index rather than by
  // angle: the azimuthal jitter is small enough that index order and angular
  // order never disagree, and index bracketing cannot pick a guide on the far
  // side of the seam.
  for (let g = 0; g < GUIDE_COUNT; g++) {
    const a = guideStrandIndex[g];
    const bRaw = guideStrandIndex[(g + 1) % GUIDE_COUNT];
    const b = bRaw > a ? bRaw : bRaw + TENTACLE_COUNT;
    for (let k = a; k < b; k++) {
      const s = strands[k % TENTACLE_COUNT];
      s.guideA = g;
      s.guideB = (g + 1) % GUIDE_COUNT;
      s.blend = (k - a) / (b - a);
    }
  }

  // §3.4 gives the length spread to the TWENTY-EIGHT INTERPOLATED strands, and
  // that is worth honouring literally rather than spreading it over all forty.
  // A guide chain is solved at its own segment length, so its node offsets are
  // already scaled by whatever length it was given; an interpolated strand that
  // then applied its own scale on top would square the effect, and the strands
  // either side of a 1.9x outlier guide would come out nearly four times too
  // long. With every guide at the median length the scale factor applies
  // exactly once, to offsets that all mean the same thing.
  const spread = [];
  for (const s of strands) if (!s.isGuide) spread.push(s.index);
  rng.shuffle(spread);
  for (const i of spread) {
    // Clamped because a log-normal tail times the 1.9x outlier can reach 4.5x,
    // which on a 26 cm animal is a metre of whip — a different species, not a
    // long tentacle. The clamp bounds the fringe without touching the
    // distribution anywhere inside it.
    strands[i].lengthScale = clamp(rng.logNormal(1, TENTACLE_LENGTH_SIGMA), 0.45, 1.55);
  }
  for (let i = 0; i < LONG_STRAND_COUNT; i++) {
    strands[spread[i]].lengthScale *= LONG_STRAND_SCALE;
  }
  for (let i = 0; i < SHORT_STRAND_COUNT; i++) {
    strands[spread[LONG_STRAND_COUNT + i]].lengthScale *= SHORT_STRAND_SCALE;
  }

  for (const s of strands) {
    // Final bound, after the outliers: 0.30 to 2.30 of the median, i.e. 6 cm to
    // 48 cm on a 26 cm animal. "Noticeably long" and "broken short" are both
    // inside that; a metre of tentacle is not.
    s.lengthScale = clamp(s.lengthScale, 0.30, 2.30);
    s.length = TENTACLE_LENGTH * BELL_RADIUS * s.lengthScale;
    s.segmentLength = s.length / (TENTACLE_NODES - 1);
  }

  return { strands, guideStrandIndex };
}

/**
 * §3.3's four oral arms. They hang from the manubrium lobes, not from the
 * margin, which is what visually separates them from the tentacle fringe.
 */
function buildArmTable(rng) {
  const arms = [];
  for (let a = 0; a < ARM_COUNT; a++) {
    const length = ARM_LENGTH * BELL_RADIUS * rng.range(0.88, 1.12);
    arms.push({
      index: a,
      // The frill phase decorrelator §3.3 calls `hash(arm)`.
      frillPhase: rng.range(0, TAU),
      swayPhase: rng.range(0, TAU),
      length,
      segmentLength: length / (ARM_NODES - 1)
    });
  }
  return arms;
}

/* --- Index templates ---------------------------------------------------- */

/**
 * The index pattern for one ribbon of `rows` nodes and `cols` cross-section
 * points, relative to the ribbon's first vertex. Built once; the per-frame sort
 * copies these blocks into a new order rather than re-deriving them.
 *
 * Winding is irrelevant here — strands never cull and never depth-write — so
 * the pattern is chosen to keep the two triangles of a quad adjacent in memory.
 */
function buildRibbonTemplate(rows, cols) {
  const out = new Uint16Array((rows - 1) * (cols - 1) * 6);
  let o = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      out[o++] = a; out[o++] = b; out[o++] = d;
      out[o++] = b; out[o++] = e; out[o++] = d;
    }
  }
  return out;
}

/* --- Scratch ------------------------------------------------------------ */

const _p = [0, 0, 0];
const _q = [0, 0, 0];
const _rest = [0, 0, 0];
const _hang = [0, 0, 0];
const _radial = [0, 0, 0];
const _swayA = [0, 0, 0];
const _swayB = [0, 0, 0];
const _tan = [0, 0, 0];
const _rotA = quat.create();
const _rotB = quat.create();
const _axis = [0, 1, 0];
/** Reused across every root evaluation; see `updateRoots`. */
const _deformParams = {
  phase: 0, lappetGain: 1, amplitude: DEFORM.AMPLITUDE, twistTime: 0, radius: BELL_RADIUS
};

/** Rest-pose scratch for the initial arm pose; sized for the fixed arm count. */
const _armRest = new Float32Array(ARM_COUNT * ARM_NODES * 3);

function normalizeInto(out, x, y, z, fallbackX, fallbackY, fallbackZ) {
  const l = Math.hypot(x, y, z);
  // Negated so a NaN length takes the fallback too: every comparison against
  // NaN is false, so `l < 1e-12` would wave a non-finite axis straight through
  // and poison every node downstream of it.
  if (!(l >= 1e-12)) { out[0] = fallbackX; out[1] = fallbackY; out[2] = fallbackZ; return out; }
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/* --- The strand system -------------------------------------------------- */

/**
 * Everything the renderer and the solver need for the strands. Pass a GL
 * context to get buffers and VAOs; pass `null` to get the CPU side only, which
 * is how the packer and the sort are cheapest to check.
 *
 * Options:
 *   gl            WebGL2 context or null
 *   seed          strand-table seed; give it its own so adding a snow mote
 *                 cannot shift the tentacle lengths
 *   radius        bell radius, metres
 *   imperfection  the object from geometry/bell.js, so the roots land on the
 *                 same sculpted margin the mesh was built from
 */
export function createStrandSystem(gl = null, options = {}) {
  const {
    seed = 0x5C1A7E,
    radius = BELL_RADIUS,
    imperfection = createBakedImperfection()
  } = options;

  const rng = new Rng(seed);
  const { strands, guideStrandIndex } = buildStrandTable(rng);
  const arms = buildArmTable(rng);

  const tentacleVertexCount = TENTACLE_COUNT * TENTACLE_NODES * 2;
  const armVertexCount = ARM_COUNT * ARM_NODES * ARM_CROSS_POINTS;
  const tentacleTemplate = buildRibbonTemplate(TENTACLE_NODES, 2);
  const armTemplate = buildRibbonTemplate(ARM_NODES, ARM_CROSS_POINTS);

  const system = {
    seed: rng.seed,
    radius,
    imperfection,
    strands,
    arms,
    guideStrandIndex,

    /** Per-guide state the verlet solver consumes. World space. */
    guideRoots: new Float32Array(GUIDE_COUNT * 3),
    guideRootDirections: new Float32Array(GUIDE_COUNT * 3),
    guideSegmentLengths: new Float32Array(GUIDE_COUNT),
    /** Every strand's root, including the interpolated ones. World space. */
    strandRoots: new Float32Array(TENTACLE_COUNT * 3),
    strandRootDirections: new Float32Array(TENTACLE_COUNT * 3),
    /** Per-arm state the verlet solver consumes. World space. */
    armRoots: new Float32Array(ARM_COUNT * 3),
    armRootDirections: new Float32Array(ARM_COUNT * 3),
    armSegmentLengths: new Float32Array(ARM_COUNT),

    /** Node positions, world space, filled by the packer for the sort. */
    tentacleNodes: new Float32Array(TENTACLE_COUNT * TENTACLE_NODES * 3),
    tentacleCentroids: new Float32Array(TENTACLE_COUNT * 3),
    armCentroids: new Float32Array(ARM_COUNT * 3),

    tentacleVertices: new Float32Array(tentacleVertexCount * STRAND_VERTEX_FLOATS),
    tentacleIndices: new Uint16Array(tentacleTemplate.length * TENTACLE_COUNT),
    armVertices: new Float32Array(armVertexCount * STRAND_VERTEX_FLOATS),
    armIndices: new Uint16Array(armTemplate.length * ARM_COUNT),

    /** Filled by `sortTentacles` / `sortArms`; hand straight to `draw`. */
    ranges: {
      behind: { offset: 0, count: 0 },
      front: { offset: 0, count: 0 },
      arms: { offset: 0, count: armTemplate.length * ARM_COUNT }
    }
  };

  // Sort scratch, allocated once. A per-frame allocation of forty small objects
  // is exactly the kind of thing that turns into a GC spike, and a GC spike on
  // this page is a dropped frame that the quality ladder then misreads as the
  // GPU struggling.
  const sortDepths = new Float64Array(TENTACLE_COUNT);
  const sortBehind = new Int32Array(TENTACLE_COUNT);
  const sortFront = new Int32Array(TENTACLE_COUNT);
  const armDepths = new Float64Array(ARM_COUNT);
  const armOrder = new Int32Array(ARM_COUNT);
  const guideOffsets = new Float64Array(GUIDE_COUNT * TENTACLE_NODES * 3);

  /* ---- roots -------------------------------------------------------- */

  /**
   * Recomputes every root from the deformed bell margin. Call once per frame,
   * BEFORE the verlet substeps: the solver pins node 0 to `guideRoots`, and a
   * root that lags the bell by one frame shows as the fringe swimming a
   * millimetre inside the animal on every contraction.
   *
   * `pose` is `{ phase, lappetGain?, amplitude, twistTime, bodyMatrix }`. The
   * lappet gain is not passed in: it is looked up per strand from the same
   * baked imperfection the mesh used, because it varies with azimuth and the
   * whole point of §3.5 item 3 is that the sixteen lobes do not move in unison.
   */
  system.updateRoots = function updateRoots(pose = {}) {
    const {
      phase = 0,
      amplitude = undefined,
      twistTime = 0,
      bodyMatrix = null
    } = pose;

    // One reusable params object rather than forty-four per frame. Small, but
    // this runs every frame for the life of the page and the file argues
    // elsewhere that a GC spike here is read by the quality ladder as the GPU
    // struggling.
    _deformParams.phase = phase;
    _deformParams.twistTime = twistTime;
    _deformParams.radius = radius;
    _deformParams.amplitude = amplitude === undefined ? DEFORM.AMPLITUDE : amplitude;

    for (let s = 0; s < TENTACLE_COUNT; s++) {
      const strand = strands[s];
      const theta = strand.theta;
      bellRimPoint(_rest, theta, imperfection, undefined, radius);

      _deformParams.lappetGain = imperfection.lappetGain(theta);
      deformBell(_p, _rest, 1, _deformParams);

      // Flare direction, still in the bell's own frame: mostly straight down
      // the bell axis, tilted outwards by ROOT_FLARE so the fringe starts
      // outside the subumbrellar cavity rather than inside it.
      normalizeInto(_radial, _p[0], 0, _p[2], 1, 0, 0);
      normalizeInto(_hang,
        _radial[0] * ROOT_FLARE, -1, _radial[2] * ROOT_FLARE, 0, -1, 0);

      if (bodyMatrix) {
        vec3.transformMat4(_p, _p, bodyMatrix);
        vec3.transformDirMat4(_hang, _hang, bodyMatrix);
        normalizeInto(_hang, _hang[0], _hang[1], _hang[2], 0, -1, 0);
      }

      const o = s * 3;
      system.strandRoots[o] = _p[0];
      system.strandRoots[o + 1] = _p[1];
      system.strandRoots[o + 2] = _p[2];
      system.strandRootDirections[o] = _hang[0];
      system.strandRootDirections[o + 1] = _hang[1];
      system.strandRootDirections[o + 2] = _hang[2];

      if (strand.isGuide) {
        const g = strand.guideIndex * 3;
        system.guideRoots[g] = _p[0];
        system.guideRoots[g + 1] = _p[1];
        system.guideRoots[g + 2] = _p[2];
        system.guideRootDirections[g] = _hang[0];
        system.guideRootDirections[g + 1] = _hang[1];
        system.guideRootDirections[g + 2] = _hang[2];
        system.guideSegmentLengths[strand.guideIndex] = strand.segmentLength;
      }
    }

    for (let a = 0; a < ARM_COUNT; a++) {
      manubriumAttachment(_rest, a, radius);
      const theta = Math.atan2(_rest[2], _rest[0]);
      _deformParams.lappetGain = imperfection.lappetGain(theta < 0 ? theta + TAU : theta);
      deformBell(_p, _rest, MANUBRIUM_ATTACH_PHI, _deformParams);
      normalizeInto(_radial, _p[0], 0, _p[2], 1, 0, 0);
      normalizeInto(_hang, _radial[0] * 0.12, -1, _radial[2] * 0.12, 0, -1, 0);
      if (bodyMatrix) {
        vec3.transformMat4(_p, _p, bodyMatrix);
        vec3.transformDirMat4(_hang, _hang, bodyMatrix);
        normalizeInto(_hang, _hang[0], _hang[1], _hang[2], 0, -1, 0);
      }
      const o = a * 3;
      system.armRoots[o] = _p[0];
      system.armRoots[o + 1] = _p[1];
      system.armRoots[o + 2] = _p[2];
      system.armRootDirections[o] = _hang[0];
      system.armRootDirections[o + 1] = _hang[1];
      system.armRootDirections[o + 2] = _hang[2];
      system.armSegmentLengths[a] = arms[a].segmentLength;
    }
    return system;
  };

  /* ---- node synthesis ------------------------------------------------ */

  /**
   * Expands the twelve solved guide chains into forty strands.
   *
   * `guideNodes` is a flat world-space array of `GUIDE_COUNT × TENTACLE_NODES`
   * positions, which is the natural output of a verlet solver over flat typed
   * arrays.
   *
   * The interpolation is done on each guide's node OFFSETS FROM ITS OWN ROOT,
   * rotated about the bell axis into the target strand's azimuth, and only then
   * blended. Interpolating the world positions directly would draw a chord
   * between two guides 30° apart, and the twenty-eight blended strands would
   * sag towards the animal's axis — the fringe would look like a drawstring bag
   * being pulled shut.
   */
  function expandGuides(guideNodes, bellAxis) {
    normalizeInto(_axis, bellAxis[0], bellAxis[1], bellAxis[2], 0, 1, 0);
    for (let g = 0; g < GUIDE_COUNT; g++) {
      const r = g * 3;
      for (let n = 0; n < TENTACLE_NODES; n++) {
        const i = (g * TENTACLE_NODES + n) * 3;
        guideOffsets[i] = guideNodes[i] - system.guideRoots[r];
        guideOffsets[i + 1] = guideNodes[i + 1] - system.guideRoots[r + 1];
        guideOffsets[i + 2] = guideNodes[i + 2] - system.guideRoots[r + 2];
      }
    }

    for (let s = 0; s < TENTACLE_COUNT; s++) {
      const strand = strands[s];
      const ro = s * 3;
      const rx = system.strandRoots[ro], ry = system.strandRoots[ro + 1], rz = system.strandRoots[ro + 2];

      if (strand.isGuide) {
        const gb = strand.guideIndex * TENTACLE_NODES * 3;
        const nb = s * TENTACLE_NODES * 3;
        for (let n = 0; n < TENTACLE_NODES * 3; n++) {
          system.tentacleNodes[nb + n] = guideNodes[gb + n];
        }
        continue;
      }

      const thetaA = strands[guideStrandIndex[strand.guideA]].theta;
      const thetaB = strands[guideStrandIndex[strand.guideB]].theta;
      const dA = wrapSigned(strand.theta - thetaA);
      const dB = wrapSigned(strand.theta - thetaB);
      const aBase = strand.guideA * TENTACLE_NODES * 3;
      const bBase = strand.guideB * TENTACLE_NODES * 3;
      const nBase = s * TENTACLE_NODES * 3;
      const t = strand.blend;
      const k = strand.lengthScale;

      // Two rotations per strand, not per node: the azimuthal offsets are
      // constant down the chain.
      quat.setAxisAngle(_rotA, _axis, dA);
      quat.setAxisAngle(_rotB, _axis, dB);

      for (let n = 0; n < TENTACLE_NODES; n++) {
        const i = n * 3;
        _p[0] = guideOffsets[aBase + i];
        _p[1] = guideOffsets[aBase + i + 1];
        _p[2] = guideOffsets[aBase + i + 2];
        quat.rotateVec3(_p, _rotA, _p);

        _q[0] = guideOffsets[bBase + i];
        _q[1] = guideOffsets[bBase + i + 1];
        _q[2] = guideOffsets[bBase + i + 2];
        quat.rotateVec3(_q, _rotB, _q);

        system.tentacleNodes[nBase + i] = rx + lerp(_p[0], _q[0], t) * k;
        system.tentacleNodes[nBase + i + 1] = ry + lerp(_p[1], _q[1], t) * k;
        system.tentacleNodes[nBase + i + 2] = rz + lerp(_p[2], _q[2], t) * k;
      }
    }
  }

  /**
   * §4.4's fallback: retarded-time analytic sway, used at tier 4 and under
   * `prefers-reduced-motion`. Unconditionally stable, stateless, and correct at
   * any frame rate, at the cost of not being able to respond to a shed vortex
   * ring — which the spec accepts at those tiers.
   *
   * It runs on the CPU and writes the same node array the solver path fills, so
   * the vertex format, the packer, the sort and the shader are byte-identical
   * across every tier. §7 requires tier transitions to be invisible; a
   * different code path in the shader would be the one thing guaranteed to make
   * them visible.
   */
  system.synthesiseNodes = function synthesiseNodes(time, bellAxis, scale = 1) {
    normalizeInto(_axis, bellAxis[0], bellAxis[1], bellAxis[2], 0, 1, 0);
    for (let s = 0; s < TENTACLE_COUNT; s++) {
      const strand = strands[s];
      const ro = s * 3;
      const rx = system.strandRoots[ro], ry = system.strandRoots[ro + 1], rz = system.strandRoots[ro + 2];
      _hang[0] = system.strandRootDirections[ro];
      _hang[1] = system.strandRootDirections[ro + 1];
      _hang[2] = system.strandRootDirections[ro + 2];

      // Two sway axes perpendicular to the hang, so the strand wanders in the
      // plane instead of oscillating along a line.
      normalizeInto(_radial, rx, 0, rz, 1, 0, 0);
      const dot = _radial[0] * _hang[0] + _radial[1] * _hang[1] + _radial[2] * _hang[2];
      normalizeInto(_swayA,
        _radial[0] - _hang[0] * dot, _radial[1] - _hang[1] * dot, _radial[2] - _hang[2] * dot,
        1, 0, 0);
      normalizeInto(_swayB,
        _hang[1] * _swayA[2] - _hang[2] * _swayA[1],
        _hang[2] * _swayA[0] - _hang[0] * _swayA[2],
        _hang[0] * _swayA[1] - _hang[1] * _swayA[0],
        0, 0, 1);

      const nBase = s * TENTACLE_NODES * 3;
      const amp = SWAY_AMPLITUDE * strand.length * scale;
      for (let n = 0; n < TENTACLE_NODES; n++) {
        const u = n / (TENTACLE_NODES - 1);
        const depth = u * strand.length;
        const tRet = retardedTime(time, depth);
        // u*u weights the sway to the free end: the root is pinned, and a
        // uniform amplitude would visibly detach it.
        const w = amp * u * u;
        const a = Math.sin(SWAY_SPATIAL_FREQUENCY * u - tRet * SWAY_TEMPORAL_RATE + strand.swayPhase);
        const b = Math.sin(SWAY_SPATIAL_FREQUENCY * 0.63 * u - tRet * SWAY_TEMPORAL_RATE * 0.77
                           + strand.swayPhase * 1.7);
        const i = nBase + n * 3;
        system.tentacleNodes[i] = rx + _hang[0] * depth + _swayA[0] * a * w + _swayB[0] * b * w * 0.6;
        system.tentacleNodes[i + 1] = ry + _hang[1] * depth + _swayA[1] * a * w + _swayB[1] * b * w * 0.6;
        system.tentacleNodes[i + 2] = rz + _hang[2] * depth + _swayA[2] * a * w + _swayB[2] * b * w * 0.6;
      }
    }
    return system;
  };

  /* ---- packing ------------------------------------------------------- */

  /**
   * Writes the tentacle vertex buffer from `system.tentacleNodes` and records
   * each strand's centroid for the sort. Call `expandGuides` (via
   * `packTentacles`) or `synthesiseNodes` first.
   */
  function packTentacleVertices() {
    const V = system.tentacleVertices;
    for (let s = 0; s < TENTACLE_COUNT; s++) {
      const strand = strands[s];
      const nBase = s * TENTACLE_NODES * 3;
      let cx = 0, cy = 0, cz = 0;
      for (let n = 0; n < TENTACLE_NODES; n++) {
        const i = nBase + n * 3;
        const px = system.tentacleNodes[i];
        const py = system.tentacleNodes[i + 1];
        const pz = system.tentacleNodes[i + 2];
        cx += px; cy += py; cz += pz;

        const prev = nBase + Math.max(0, n - 1) * 3;
        const next = nBase + Math.min(TENTACLE_NODES - 1, n + 1) * 3;
        normalizeInto(_tan,
          system.tentacleNodes[next] - system.tentacleNodes[prev],
          system.tentacleNodes[next + 1] - system.tentacleNodes[prev + 1],
          system.tentacleNodes[next + 2] - system.tentacleNodes[prev + 2],
          0, -1, 0);

        const u = n / (TENTACLE_NODES - 1);
        const halfWidth = TENTACLE_HALF_WIDTH * strand.thicknessScale * lerp(1, 0.45, u);
        const dens = strand.densityScale;

        for (let side = 0; side < 2; side++) {
          const o = ((s * TENTACLE_NODES + n) * 2 + side) * STRAND_VERTEX_FLOATS;
          V[o] = px; V[o + 1] = py; V[o + 2] = pz;
          V[o + 3] = _tan[0]; V[o + 4] = _tan[1]; V[o + 5] = _tan[2];
          V[o + 6] = side === 0 ? -1 : 1;
          V[o + 7] = halfWidth;
          V[o + 8] = dens;
          V[o + 9] = 0;
        }
      }
      const co = s * 3;
      system.tentacleCentroids[co] = cx / TENTACLE_NODES;
      system.tentacleCentroids[co + 1] = cy / TENTACLE_NODES;
      system.tentacleCentroids[co + 2] = cz / TENTACLE_NODES;
    }
  }

  /**
   * The whole per-frame tentacle path: expand the guides, pack the vertices.
   * `bellAxis` is the animal's own up axis in world space (sim/swim.js), used
   * only to rotate guide offsets into a strand's azimuth.
   */
  system.packTentacles = function packTentacles(guideNodes, bellAxis) {
    expandGuides(guideNodes, bellAxis);
    packTentacleVertices();
    return system;
  };

  /** The fallback equivalent: synthesise the nodes analytically, then pack. */
  system.packTentaclesAnalytic = function packTentaclesAnalytic(time, bellAxis, scale = 1) {
    system.synthesiseNodes(time, bellAxis, scale);
    packTentacleVertices();
    return system;
  };

  /**
   * §3.3's oral arms. `armNodes` is `ARM_COUNT × ARM_NODES` world positions.
   *
   * The width term is §3.3 verbatim:
   *   `w += 0.012 R · sin(9s + 2.4·t_ret + hash(arm))`
   * and it undulates on retarded time, so the frill ripples down the curtain
   * independently of the arm's gross motion — which is the whole reason §4.4
   * keeps retarded time on the primary path as well as the fallback.
   *
   * The out-of-plane `ruffle` is this file's reading of "5-point ruffled
   * cross-section". Five COLLINEAR points would be indistinguishable from two,
   * so the three interior points are pushed off the ribbon plane by a wave
   * running across the width, scaled by |across| so the spine stays exactly on
   * the solved chain. A shader that ignores `aParam2.w` still gets a correct,
   * merely flat, ribbon.
   */
  system.packArms = function packArms(armNodes, time) {
    const V = system.armVertices;
    const R = radius;
    for (let a = 0; a < ARM_COUNT; a++) {
      const arm = arms[a];
      const nBase = a * ARM_NODES * 3;
      let cx = 0, cy = 0, cz = 0;
      const rootY = armNodes[nBase + 1];
      for (let n = 0; n < ARM_NODES; n++) {
        const i = nBase + n * 3;
        const px = armNodes[i], py = armNodes[i + 1], pz = armNodes[i + 2];
        cx += px; cy += py; cz += pz;

        const prev = nBase + Math.max(0, n - 1) * 3;
        const next = nBase + Math.min(ARM_NODES - 1, n + 1) * 3;
        normalizeInto(_tan,
          armNodes[next] - armNodes[prev],
          armNodes[next + 1] - armNodes[prev + 1],
          armNodes[next + 2] - armNodes[prev + 2],
          0, -1, 0);

        const s = n / (ARM_NODES - 1);
        const tRet = retardedTime(time, Math.max(0, rootY - py));
        const frillPhase = ARM_FRILL_FREQUENCY * s
                         + ARM_FRILL_RETARDED_RATE * tRet
                         + arm.frillPhase;
        const halfWidth = 0.5 * lerp(ARM_WIDTH_ROOT, ARM_WIDTH_TIP, s) * R
                        + ARM_FRILL_AMPLITUDE * R * Math.sin(frillPhase);

        for (let c = 0; c < ARM_CROSS_POINTS; c++) {
          const across = (c / (ARM_CROSS_POINTS - 1)) * 2 - 1;
          const ruffle = ARM_RUFFLE_DEPTH * R * Math.abs(across)
                       * Math.sin(frillPhase + across * ARM_RUFFLE_ACROSS)
                       * (1 - 0.55 * s);
          const o = ((a * ARM_NODES + n) * ARM_CROSS_POINTS + c) * STRAND_VERTEX_FLOATS;
          V[o] = px; V[o + 1] = py; V[o + 2] = pz;
          V[o + 3] = _tan[0]; V[o + 4] = _tan[1]; V[o + 5] = _tan[2];
          V[o + 6] = across;
          V[o + 7] = Math.max(halfWidth, 1e-4);
          V[o + 8] = ARM_DENSITY;
          V[o + 9] = ruffle;
        }
      }
      const co = a * 3;
      system.armCentroids[co] = cx / ARM_NODES;
      system.armCentroids[co + 1] = cy / ARM_NODES;
      system.armCentroids[co + 2] = cz / ARM_NODES;
    }
    return system;
  };

  /* ---- the sort ------------------------------------------------------ */

  /**
   * §2.6's per-strand depth sort and the behind/front split.
   *
   * A strand whose centroid is further from the eye than the bell's own centre
   * goes into the *behind* group, which draws into SEA in pass 2 and is
   * therefore composited THROUGH the bell by the exumbrella in pass 6 — tinted,
   * dimmed and refracted by the animal it is behind, which no depth sort can
   * reproduce. Everything else draws into FINAL in pass 6.
   *
   * Within each group the order is far to near, because the strands blend
   * premultiplied over each other.
   *
   * `cameraPosition` and `viewDirection` are world space; `viewDirection` must
   * be unit and must point away from the camera.
   */
  system.sortTentacles = function sortTentacles(cameraPosition, viewDirection, bellCenter) {
    const bellDepth =
      (bellCenter[0] - cameraPosition[0]) * viewDirection[0] +
      (bellCenter[1] - cameraPosition[1]) * viewDirection[1] +
      (bellCenter[2] - cameraPosition[2]) * viewDirection[2];

    let nBehind = 0, nFront = 0;
    for (let s = 0; s < TENTACLE_COUNT; s++) {
      const o = s * 3;
      const d =
        (system.tentacleCentroids[o] - cameraPosition[0]) * viewDirection[0] +
        (system.tentacleCentroids[o + 1] - cameraPosition[1]) * viewDirection[1] +
        (system.tentacleCentroids[o + 2] - cameraPosition[2]) * viewDirection[2];
      sortDepths[s] = d;
      if (d > bellDepth) sortBehind[nBehind++] = s; else sortFront[nFront++] = s;
    }

    insertionSortByDepth(sortBehind, nBehind, sortDepths);
    insertionSortByDepth(sortFront, nFront, sortDepths);

    const stride = tentacleTemplate.length;
    let o = 0;
    for (let i = 0; i < nBehind; i++) o = writeTemplate(system.tentacleIndices, o, tentacleTemplate, sortBehind[i] * TENTACLE_NODES * 2);
    system.ranges.behind.offset = 0;
    system.ranges.behind.count = nBehind * stride;
    system.ranges.front.offset = nBehind * stride;
    for (let i = 0; i < nFront; i++) o = writeTemplate(system.tentacleIndices, o, tentacleTemplate, sortFront[i] * TENTACLE_NODES * 2);
    system.ranges.front.count = nFront * stride;
    return system.ranges;
  };

  /**
   * The arms draw as one group in pass 5, but they still overlap each other, so
   * they are sorted far to near for the same reason.
   */
  system.sortArms = function sortArms(cameraPosition, viewDirection) {
    for (let a = 0; a < ARM_COUNT; a++) {
      const o = a * 3;
      armDepths[a] =
        (system.armCentroids[o] - cameraPosition[0]) * viewDirection[0] +
        (system.armCentroids[o + 1] - cameraPosition[1]) * viewDirection[1] +
        (system.armCentroids[o + 2] - cameraPosition[2]) * viewDirection[2];
      armOrder[a] = a;
    }
    insertionSortByDepth(armOrder, ARM_COUNT, armDepths);
    let o = 0;
    const perArm = ARM_NODES * ARM_CROSS_POINTS;
    for (let i = 0; i < ARM_COUNT; i++) {
      o = writeTemplate(system.armIndices, o, armTemplate, armOrder[i] * perArm);
    }
    system.ranges.arms.offset = 0;
    system.ranges.arms.count = o;
    return system.ranges.arms;
  };

  /* ---- GL ------------------------------------------------------------ */

  if (gl) {
    const tentacleVertexBuffer = createBuffer(gl, {
      target: 'array', data: system.tentacleVertices, usage: 'stream', name: 'strands.tentacle.vertices'
    });
    const tentacleIndexBuffer = createBuffer(gl, {
      target: 'index', data: system.tentacleIndices, usage: 'stream', name: 'strands.tentacle.indices'
    });
    const armVertexBuffer = createBuffer(gl, {
      target: 'array', data: system.armVertices, usage: 'stream', name: 'strands.arm.vertices'
    });
    const armIndexBuffer = createBuffer(gl, {
      target: 'index', data: system.armIndices, usage: 'stream', name: 'strands.arm.indices'
    });

    const attributesFor = (buffer) => [
      { buffer, location: STRAND_ATTRIBUTE_LOCATIONS.aPos, size: 3, stride: STRAND_VERTEX_BYTES, offset: 0 },
      { buffer, location: STRAND_ATTRIBUTE_LOCATIONS.aTangent, size: 3, stride: STRAND_VERTEX_BYTES, offset: 12 },
      { buffer, location: STRAND_ATTRIBUTE_LOCATIONS.aParam2, size: 4, stride: STRAND_VERTEX_BYTES, offset: 24 }
    ];

    const tentacleVertexArray = createVertexArray(gl, {
      name: 'strands.tentacles',
      attributes: attributesFor(tentacleVertexBuffer),
      indices: { buffer: tentacleIndexBuffer, type: 'ushort' }
    });
    const armVertexArray = createVertexArray(gl, {
      name: 'strands.arms',
      attributes: attributesFor(armVertexBuffer),
      indices: { buffer: armIndexBuffer, type: 'ushort' }
    });

    system.tentacleVertexArray = tentacleVertexArray;
    system.armVertexArray = armVertexArray;

    /**
     * One `bufferSubData` per array, after packing and sorting. Roughly 71 KB a
     * frame in total, which is the only per-frame upload in the project —
     * everything else is a static VBO built once at load.
     */
    system.upload = function upload() {
      tentacleVertexBuffer.update(system.tentacleVertices);
      tentacleIndexBuffer.update(system.tentacleIndices);
      armVertexBuffer.update(system.armVertices);
      armIndexBuffer.update(system.armIndices);
      return system;
    };

    system.drawBehind = function drawBehind() {
      const r = system.ranges.behind;
      if (r.count > 0) tentacleVertexArray.draw('triangles', r.count, r.offset);
    };
    system.drawFront = function drawFront() {
      const r = system.ranges.front;
      if (r.count > 0) tentacleVertexArray.draw('triangles', r.count, r.offset);
    };
    system.drawArms = function drawArms() {
      const r = system.ranges.arms;
      if (r.count > 0) armVertexArray.draw('triangles', r.count, r.offset);
    };

    system.dispose = function dispose() {
      tentacleVertexArray.dispose();
      armVertexArray.dispose();
      tentacleIndexBuffer.dispose();
      tentacleVertexBuffer.dispose();
      armIndexBuffer.dispose();
      armVertexBuffer.dispose();
    };
  } else {
    system.upload = () => system;
    system.drawBehind = () => {};
    system.drawFront = () => {};
    system.drawArms = () => {};
    system.dispose = () => {};
  }

  // A sensible state before the first frame: roots on the relaxed bell, chains
  // hanging straight, indices in strand order. Without this a renderer that
  // draws before its first simulation step uploads uninitialised zeros, which
  // is forty triangles fanning out of the world origin for one frame.
  system.updateRoots({ phase: 0, twistTime: 0 });
  system.packTentaclesAnalytic(0, [0, 1, 0], 1);
  for (let a = 0; a < ARM_COUNT; a++) {
    const o = a * 3;
    for (let n = 0; n < ARM_NODES; n++) {
      const i = (a * ARM_NODES + n) * 3;
      const d = (n / (ARM_NODES - 1)) * arms[a].length;
      _armRest[i] = system.armRoots[o] + system.armRootDirections[o] * d;
      _armRest[i + 1] = system.armRoots[o + 1] + system.armRootDirections[o + 1] * d;
      _armRest[i + 2] = system.armRoots[o + 2] + system.armRootDirections[o + 2] * d;
    }
  }
  system.packArms(_armRest, 0);
  system.sortTentacles([0, 0, 1], [0, 0, -1], [0, 0, 0]);
  system.sortArms([0, 0, 1], [0, 0, -1]);

  return system;
}

/** Shortest signed angle into (−π, π]. */
function wrapSigned(a) {
  const t = a - TAU * Math.floor((a + Math.PI) / TAU);
  return t === -Math.PI ? Math.PI : t;
}

/**
 * Descending insertion sort over an index array. Forty elements that are
 * already nearly in order every frame — insertion sort is both the fastest
 * thing here and the only one that allocates nothing.
 */
function insertionSortByDepth(order, count, depths) {
  for (let i = 1; i < count; i++) {
    const v = order[i];
    const d = depths[v];
    let j = i - 1;
    while (j >= 0 && depths[order[j]] < d) { order[j + 1] = order[j]; j--; }
    order[j + 1] = v;
  }
}

/** Copies one ribbon's index template into the frame's ordered index buffer. */
function writeTemplate(dst, offset, template, base) {
  for (let i = 0; i < template.length; i++) dst[offset + i] = template[i] + base;
  return offset + template.length;
}

/**
 * Half-widths, densities and the screen-space floor, collected for the shader
 * author in one place. §2.6's fragment does
 *
 *   float a = exp(-pow(abs(vAcross) * 1.45, 1.6));
 *   a *= min(1.0, vWorldWidthPx / 1.4);
 *
 * and `vWorldWidthPx` is `2 * aParam2.y` projected to pixels — which is why the
 * CPU ships a world half-width in metres and never a screen size.
 */
export const STRAND_SHADER_CONSTANTS = Object.freeze({
  SUPERGAUSSIAN_SCALE: 1.45,
  SUPERGAUSSIAN_EXPONENT: 1.6,
  MIN_WIDTH_PX: STRAND_MIN_WIDTH_PX
});

/**
 * The GLSL half of the constants above, so `js/shaders/strands.js` cannot drift
 * from what the packer assumed when it chose a half-width.
 */
export const STRAND_GLSL = `
// ---- geometry/strands.js: strand cross-section constants (spec 2.6, 3.4) ----
#define STRAND_SUPERGAUSSIAN_SCALE     ${STRAND_SHADER_CONSTANTS.SUPERGAUSSIAN_SCALE}
#define STRAND_SUPERGAUSSIAN_EXPONENT  ${STRAND_SHADER_CONSTANTS.SUPERGAUSSIAN_EXPONENT}
#define STRAND_MIN_WIDTH_PX            ${STRAND_SHADER_CONSTANTS.MIN_WIDTH_PX}

// A definite core with no hard edge and therefore no silhouette to alias.
// Exponent 1.6: a plain Gaussian reads as smoke, a hard edge aliases.
float strandCoverage(float across, float worldWidthPx){
  float r = abs(across);
  float a = exp(-pow(r * STRAND_SUPERGAUSSIAN_SCALE, STRAND_SUPERGAUSSIAN_EXPONENT));
  // Screen-space minimum width with compensating alpha: without this a 4K
  // render shimmers into static.
  return a * min(1.0, worldWidthPx / STRAND_MIN_WIDTH_PX);
}
`;
