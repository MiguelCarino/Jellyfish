/* ============================================================
   geometry/bell.js — the animal's body, built once at load.
   ------------------------------------------------------------
   §3.1's closed two-shell bell at two LODs, §3.2's gonad tubes
   and manubrium, and §3.5's baked imperfection. Everything here
   is generated from parameters and nothing is loaded, which is
   also what makes a WebGL context loss recoverable: rebuild from
   the same seed and the same animal comes back.

   THE MESH IS ONE SHEET, NOT TWO SHELLS PLUS A LID.
   §3.1 describes an outer exumbrella, an inner subumbrella and a
   rim band stitching them. Built literally as three pieces, the
   rim is where the seam shows: two index buffers meeting at a
   shared edge whose normals are computed from opposite
   parameterisations, which is exactly the "glowing band on the
   rim" the definition of done tests for. So the whole closed
   surface is generated as a SINGLE grid whose rows walk the
   closed profile once —

       exumbrella apex (phi 0) -> margin (phi 1)
       -> around the rim band -> subumbrella margin (phi 1)
       -> subumbrella apex (phi 0)

   — with the azimuthal seam column duplicated at theta = 0 and
   theta = 2*PI at exactly coincident positions. One grid, one
   winding, one index buffer, no seam to leak through. The
   consequence worth knowing: because the row direction reverses
   in phi on the return leg, `cross(alongTheta, alongRow)` points
   AWAY FROM THE TISSUE at every vertex, on both shells and across
   the rim, with no per-shell sign flip. sim/deform.js's
   `deformBellFrame` and the bell vertex shader both rely on that.

   WALL THICKNESS SURVIVES THE SCULPTING. The lappets, the
   rhopalia notches, the torn lappet and the baked value noise are
   all applied to the PROFILE, in (r, y), before the two shells
   are separated by -N*w(phi). Both shells therefore receive the
   identical displacement and |exumbrella - subumbrella| is still
   exactly w(phi) everywhere. If the sculpting were applied to the
   two shells independently the wall would thin and thicken with
   theta, and pass 4's optical depth would ripple around the bell
   at 16 cycles.

   WHY THE VERTEX FORMAT CARRIES NEIGHBOURS. §2.5 computes the
   normal analytically from three evaluations of `deform()`, which
   needs the rest positions of the two parameter-space neighbours.
   Those cannot be recomputed in the shader, because the baked
   imperfection of §3.5 is not a closed form — it is value noise
   plus a torn wedge chosen from a seeded stream. So each vertex
   ships the two neighbour OFFSETS (aNextS, aNextT). Offsets, not
   absolute positions, because they are three orders of magnitude
   smaller than the positions and keep their precision in fp32.
   ============================================================ */

import { TAU, smoothstep, angleDelta, Rng } from '../math.js';
import { valueNoise3 } from '../noise.js';
import { createBuffer, createVertexArray } from '../gl.js';
import {
  BELL_RADIUS,
  TESSELLATION,
  LAPPET_COUNT,
  wOverR,
  wallThickness,
  marginBlend,
  lappetRadiusScale,
  rhopaliaOffset,
  phiToKnotParam,
  profilePointAtKnotParam,
  profileDerivativeAtKnotParam
} from './profile.js';

/* --- Vertex format ------------------------------------------------------ */

/**
 * Fixed attribute locations. Bound before link on every program that draws
 * jelly geometry (bell, thickness, sun-view shadow, interior), so all four can
 * share one VAO and switching LOD is a single `bindVertexArray`.
 *
 *   aRest    vec3  rest position, metres, in the bell's own frame, with the
 *                  baked imperfection of §3.5 already applied
 *   aUV      vec2  (phi, theta) — phi is normalised arc length, theta radians
 *   aParam2  vec4  (lappetGain, density, shellTag, thickScale)
 *   aNextS   vec4  (offset to the next ROW's rest position, delta phi)
 *   aNextT   vec4  (offset to the next COLUMN's rest position, delta theta)
 */
export const BELL_ATTRIBUTE_LOCATIONS = Object.freeze({
  aRest: 0, aUV: 1, aParam2: 2, aNextS: 3, aNextT: 4
});

export const BELL_VERTEX_FLOATS = 17;
export const BELL_VERTEX_BYTES = BELL_VERTEX_FLOATS * 4;

/**
 * `aParam2.z`, the shell tag. Not a normal sign — the winding already gets the
 * normal right (see the file header) — but a tag the fragment shader uses to
 * know what it is drawing: the rim band is where §3.1's shader-side fringe
 * modulation applies, and the interior tags let the interior pass shade gonad
 * tissue differently from the bell wall without a second program.
 */
export const SHELL_TAG = Object.freeze({
  EXUMBRELLA: 1, RIM: 0, SUBUMBRELLA: -1, GONAD: 2, MANUBRIUM: 3
});

/**
 * The scalar the analytic-thickness fallback multiplies: §2.5 writes
 * `tau = 2·uWall·vThickScale·density/ndv`, so `uWall` is a single uniform and
 * `vThickScale` carries the phi dependence. Set `uWall` to this value — the
 * wall at the apex, 8.32 mm — and `aParam2.w` does the rest. Splitting it this
 * way rather than shipping metres per vertex keeps the attribute O(1) so an
 * fp16 varying could carry it if the fallback path ever needs one.
 */
export const BELL_WALL_REFERENCE = wallThickness(0);

/* --- density(phi, theta) ------------------------------------------------ */

/**
 * §2.4 verbatim. Real mesoglea is 96 % water and nearly clear: a constant
 * sigma_s gives an invisible animal and cranking it gives wax. What a
 * photograph shows is structure, so the density that pass 4 accumulates is a
 * pattern — coronal muscle, sixteen radial canals, a dense margin, four gonad
 * horseshoes. That is the difference between "translucent object" and "tissue".
 *
 * Baked per vertex into `aParam2.y` for the mesh; the GLSL twin below exists
 * for the analytic fallback (§2.5), which evaluates it per fragment because it
 * has no thickness buffer to read.
 */
export function density(phi, theta) {
  const bulk = 1.0;
  const muscle = 3.2 * smoothstep(0.45, 0.95, phi);
  const canal = 2.0 * Math.pow(Math.abs(Math.cos(8.0 * theta)), 24.0)
                    * smoothstep(0.25, 0.90, phi);
  const rim = 3.6 * smoothstep(0.88, 1.00, phi);
  const gonad = 2.4 * smoothstep(0.55, 0.20, Math.abs(Math.cos(2.0 * theta)))
                    * smoothstep(0.58, 0.34, phi) * smoothstep(0.16, 0.30, phi);
  return bulk + muscle + canal + rim + gonad;
}

/**
 * The GLSL twin of `density`, named `bellDensity` so that including it can
 * never collide with a `density()` written elsewhere. Self-contained.
 */
export const BELL_DENSITY_GLSL = `
// ---- geometry/bell.js: tissue density, spec 2.4 ----
// Density is a PATTERN, not a constant: coronal muscle, 16 radial canals, a
// dense margin and four gonad horseshoes, so the anatomy shows THROUGH the
// bell as denser, brighter structure that sums correctly where an arm folds
// underneath. A baked per-vertex thickness map cannot do that.
//
// The two gonad smoothsteps run DOWNWARD (edge0 > edge1). GLSL ES calls that
// undefined, though every shipping implementation evaluates the same
// clamp((x-e0)/(e1-e0)) and gets it right, and it is how the spec writes it. If
// a driver is ever found that returns something else here, the four horseshoes
// will vanish or invert and the fix is to rewrite each as
//   1.0 - smoothstep(e1, e0, x)
// The JS twin above already behaves this way, so
// the CPU bake and the GPU fallback agree today.
float bellDensity(float phi, float theta){
  float bulk   = 1.0;
  float muscle = 3.2 * smoothstep(0.45, 0.95, phi);
  float canal  = 2.0 * pow(abs(cos(8.0*theta)), 24.0)
                     * smoothstep(0.25, 0.90, phi);
  float rim    = 3.6 * smoothstep(0.88, 1.00, phi);
  float gonad  = 2.4 * smoothstep(0.55, 0.20, abs(cos(2.0*theta)))
                     * smoothstep(0.58, 0.34, phi) * smoothstep(0.16, 0.30, phi);
  return bulk + muscle + canal + rim + gonad;
}
`;

/* --- §3.5 baked imperfection -------------------------------------------- */

/** §3.5 item 1: 1.4 cycles across the bell, amplitude 2.5 % of R. */
const NOISE_CYCLES_PER_BELL = 1.4;
const NOISE_AMPLITUDE = 0.025;
/** §3.5 item 2: one torn lappet, up to 12 % shorter, inside a 25° wedge. */
const TEAR_WEDGE = 25 * Math.PI / 180;
const TEAR_DEPTH = 0.12;
/** §3.5 item 3: per-lappet contraction gain jitter, ±6 %. */
const LAPPET_GAIN_JITTER = 0.06;
/** §3.5 item 4: one side of the coronal muscle contracts 8 % harder. */
const CORONAL_ASYMMETRY = 0.08;
/** §3.5 item 5: gonad horseshoes differ by ±12 % area and ±4°. */
const GONAD_AREA_JITTER = 0.12;
const GONAD_ROTATION_JITTER = 4 * Math.PI / 180;

/**
 * The baked anatomical imperfection of §3.5, as a set of closed-form functions
 * over a seeded set of random constants.
 *
 * It is a set of FUNCTIONS rather than a table of per-vertex numbers for one
 * reason: the tentacle roots need the same asymmetry at azimuths that fall
 * between vertices. If the mesh builder baked jitter straight into the VBO and
 * the root solver invented its own, the forty tentacles would attach to a
 * slightly different animal than the one being drawn, and would drift in and
 * out of the margin over the pulse. So the mesh calls these functions to bake,
 * and geometry/strands.js calls the identical functions to attach.
 *
 * Nothing here takes a time argument. That is the whole point of §3.5: the
 * asymmetry has to read as ANATOMY, and anatomy does not wobble.
 */
export function createBakedImperfection(seed = 0x9E3779B1) {
  const rng = new Rng(seed);

  // Per-lappet contraction gain. Sampled at the lappet CENTRES (the maxima of
  // cos(16*theta), i.e. theta = 2*PI*k/16) and interpolated between them with a
  // smoothstep, which is C1 at the sample points — a linear blend would leave a
  // slope discontinuity every 22.5° that the analytic normal would find.
  const lappetGains = new Float64Array(LAPPET_COUNT);
  for (let i = 0; i < LAPPET_COUNT; i++) {
    lappetGains[i] = 1 + LAPPET_GAIN_JITTER * rng.range(-1, 1);
  }

  // §3.5 item 4. One azimuth contracts harder and the opposite one less, which
  // makes the thrust vector sit permanently off the bell axis — the animal
  // yaws slowly and never repeats, without a single line of steering logic.
  const asymmetryAzimuth = rng.range(0, TAU);

  // §3.5 item 2. One torn lappet, at a random azimuth.
  const tearAzimuth = rng.range(0, TAU);

  // §3.5 item 1. Offsetting the noise lattice per seed keeps two differently
  // seeded animals from sharing the same lumps.
  const noiseOffsetX = rng.range(0, 64);
  const noiseOffsetY = rng.range(0, 64);
  const noiseOffsetZ = rng.range(0, 64);

  // §3.5 item 5. Four horseshoes, none of them the same shape.
  const gonads = [];
  for (let g = 0; g < 4; g++) {
    const area = 1 + GONAD_AREA_JITTER * rng.range(-1, 1);
    gonads.push(Object.freeze({
      index: g,
      // 45° + 90°k, per §3.2.
      azimuth: (Math.PI / 4) + g * (Math.PI / 2) + GONAD_ROTATION_JITTER * rng.range(-1, 1),
      areaScale: area,
      // Area scales as span × radial extent, so each gets the square root.
      extentScale: Math.sqrt(area)
    }));
  }

  return {
    seed: rng.seed,

    /**
     * §3.5 items 3 and 4 combined — the number `deform()` multiplies its
     * contraction by. Continuous and periodic in theta, mean ≈ 1.
     */
    lappetGain(theta) {
      const cell = theta / (TAU / LAPPET_COUNT);
      const i = Math.floor(cell);
      const f = cell - i;
      const a = lappetGains[((i % LAPPET_COUNT) + LAPPET_COUNT) % LAPPET_COUNT];
      const b = lappetGains[(((i + 1) % LAPPET_COUNT) + LAPPET_COUNT) % LAPPET_COUNT];
      const t = f * f * (3 - 2 * f);
      const perLappet = a + (b - a) * t;
      // Half the stated 8 % either side of the axis, so the DIFFERENCE between
      // the two sides is 8 % as §3.5 specifies.
      const coronal = 1 + 0.5 * CORONAL_ASYMMETRY * Math.cos(theta - asymmetryAzimuth);
      return perLappet * coronal;
    },

    /**
     * §3.5 item 2, as a multiplier on the profile radius. The tear is a bite
     * out of the rim: up to 12 % shorter at the centre of a 25° wedge, faded
     * out by the same `marginBlend` the lappets use so it cannot reach up the
     * dome, and smoothstepped across the wedge so the two edges of the bite
     * are not creases.
     */
    tearScale(phi, theta) {
      const d = Math.abs(angleDelta(tearAzimuth, theta));
      if (d >= TEAR_WEDGE * 0.5) return 1;
      const w = 1 - smoothstep(0, TEAR_WEDGE * 0.5, d);
      return 1 - TEAR_DEPTH * w * marginBlend(phi);
    },

    /**
     * §3.5 item 1, as a displacement along the profile normal in units of R.
     * Sampled from the UNSCULPTED revolved profile point so that the two
     * shells, the rim band and the strand-root solver all get the identical
     * number at a given (phi, theta) — which is what keeps the wall thickness
     * exactly w(phi) after the displacement.
     */
    radialNoise(profileR, profileY, theta) {
      const k = NOISE_CYCLES_PER_BELL * 0.5;
      const n = valueNoise3(
        profileR * Math.cos(theta) * k + noiseOffsetX,
        profileY * k + noiseOffsetY,
        profileR * Math.sin(theta) * k + noiseOffsetZ
      );
      return (n - 0.5) * 2 * NOISE_AMPLITUDE;
    },

    /** §3.5 item 5. Four frozen descriptors, consumed by the gonad builder. */
    gonads: Object.freeze(gonads),

    /** Rebuild identically after a context loss. */
    reset() {
      rng.reset();
      return this;
    }
  };
}

/* --- Profile evaluation with the sculpting and the imperfection applied -- */

const _p2 = [0, 0];
const _d2 = [0, 0];

/**
 * The sculpted profile at (phi, theta), in units of R:
 * `out = [r, y, normalR, normalY]`.
 *
 * Order matters and is fixed here. Lappets and rhopalia scale and inset the
 * radius, the tear shortens it, and only then does the baked value noise push
 * the whole thing along the surface normal. The noise is displaced along N
 * rather than radially because a radial displacement changes the ANGLE between
 * the two shells' separation vector and the surface, and w(phi) would stop
 * being the wall thickness.
 */
function sculptedProfile(out, phi, theta, imp) {
  const u = phiToKnotParam(phi);
  profilePointAtKnotParam(_p2, u);
  profileDerivativeAtKnotParam(_d2, u);
  const l = Math.hypot(_d2[0], _d2[1]) || 1;
  const nR = -_d2[1] / l;
  const nY = _d2[0] / l;

  const baseR = _p2[0];
  const baseY = _p2[1];

  const blend = marginBlend(phi);
  let r = baseR * (1 + (lappetRadiusScale(theta) - 1) * blend);
  r += rhopaliaOffset(theta) * blend;
  r *= imp.tearScale(phi, theta);

  const h = imp.radialNoise(baseR, baseY, theta);
  out[0] = r + nR * h;
  out[1] = baseY + nY * h;
  out[2] = nR;
  out[3] = nY;
  return out;
}

const _pf = [0, 0, 0, 0];

/**
 * The row table: the closed profile walked once. Each entry says which leg of
 * the sheet it is on, at what phi, and — for the rim rows — how far around the
 * rim. Built per LOD and reused by the mesh builder and by anything that wants
 * to know how many rows there are.
 */
function buildRowTable(rings, rimRows) {
  const rows = [];
  for (let j = 0; j <= rings; j++) {
    rows.push({ leg: 0, phi: j / rings, b: 0, tag: SHELL_TAG.EXUMBRELLA });
  }
  for (let k = 1; k <= rimRows; k++) {
    rows.push({ leg: 1, phi: 1, b: k / (rimRows + 1), tag: SHELL_TAG.RIM });
  }
  for (let j = rings; j >= 0; j--) {
    rows.push({ leg: 2, phi: j / rings, b: 1, tag: SHELL_TAG.SUBUMBRELLA });
  }
  return rows;
}

/** How far the rim band bulges outward past the margin, in units of w(1). */
const RIM_BULGE = 0.5;

/**
 * A point on the sheet, in METRES, in the bell's own frame.
 *
 * The rim rows interpolate from the exumbrella margin to the subumbrella
 * margin and bulge outward along the profile tangent by half a wall thickness
 * — 0.39 mm — so the rim is rounded rather than a knife edge. That rounding is
 * not cosmetic: at the silhouette the view ray runs nearly along the surface,
 * and a knife edge makes tau jump discontinuously between adjacent pixels,
 * which is precisely the flickering rim the precision fix in §2.4 is about.
 */
function sheetPoint(out, row, theta, imp, radius) {
  sculptedProfile(_pf, row.phi, theta, imp);
  const r = _pf[0], y = _pf[1], nR = _pf[2], nY = _pf[3];
  const w = wOverR(row.phi);

  let rr, yy;
  if (row.leg === 0) {
    rr = r; yy = y;
  } else if (row.leg === 2) {
    rr = r - nR * w; yy = y - nY * w;
  } else {
    const b = row.b;
    // Tangent in the direction of increasing phi is the normal turned -90°.
    const tR = nY, tY = -nR;
    const bulge = RIM_BULGE * w * Math.sin(Math.PI * b);
    rr = r - b * nR * w + tR * bulge;
    yy = y - b * nY * w + tY * bulge;
  }

  out[0] = rr * radius * Math.cos(theta);
  out[1] = yy * radius;
  out[2] = rr * radius * Math.sin(theta);
  return out;
}

/* --- Mesh assembly ------------------------------------------------------ */

/**
 * A minimal growable-into-preallocated mesh sink. Written out rather than
 * pulled from a helper module because the whole thing is twenty lines and the
 * alternative is a file that exists only to hold `push`.
 */
function createMeshSink(maxVertices, maxTriangles) {
  return {
    vertices: new Float32Array(maxVertices * BELL_VERTEX_FLOATS),
    indices: maxVertices > 65535
      ? new Uint32Array(maxTriangles * 3)
      : new Uint16Array(maxTriangles * 3),
    vertexCount: 0,
    indexCount: 0,
    pushVertex(px, py, pz, phi, theta, gain, dens, tag, thick,
               sx, sy, sz, dPhi, tx, ty, tz, dTheta) {
      const o = this.vertexCount * BELL_VERTEX_FLOATS;
      const v = this.vertices;
      v[o] = px; v[o + 1] = py; v[o + 2] = pz;
      v[o + 3] = phi; v[o + 4] = theta;
      v[o + 5] = gain; v[o + 6] = dens; v[o + 7] = tag; v[o + 8] = thick;
      v[o + 9] = sx; v[o + 10] = sy; v[o + 11] = sz; v[o + 12] = dPhi;
      v[o + 13] = tx; v[o + 14] = ty; v[o + 15] = tz; v[o + 16] = dTheta;
      return this.vertexCount++;
    },
    pushTriangle(a, b, c) {
      const o = this.indexCount;
      this.indices[o] = a; this.indices[o + 1] = b; this.indices[o + 2] = c;
      this.indexCount += 3;
    }
  };
}

/**
 * Fills the two neighbour-offset attributes for a rows × cols grid of
 * positions, in place, into a caller-supplied scratch layout.
 *
 * The two poles need special handling: at r = 0 every column collapses onto
 * the same point, the theta neighbour offset is the zero vector, and the
 * analytic normal in the shader would be `normalize(cross(0, x))` — a NaN,
 * which silently blanks the entire draw. So a pole row BORROWS the theta
 * offset of the ring next to it. The borrowed vector has the right direction
 * and a sane magnitude, and the resulting normal at the apex comes out as the
 * first ring's normal, which at the pole is (0, 1, 0) to within a degree.
 */
function gridNeighbours(positions, rows, cols, rowPhi, out) {
  const { nextS, nextT, dPhi } = out;
  for (let j = 0; j < rows; j++) {
    const jn = j < rows - 1 ? j + 1 : j - 1;
    const sgn = j < rows - 1 ? 1 : -1;
    dPhi[j] = (rowPhi[jn] - rowPhi[j]) * sgn;
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 3;
      const on = (jn * cols + i) * 3;
      nextS[o] = (positions[on] - positions[o]) * sgn;
      nextS[o + 1] = (positions[on + 1] - positions[o + 1]) * sgn;
      nextS[o + 2] = (positions[on + 2] - positions[o + 2]) * sgn;
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const ic = i < cols - 1 ? i + 1 : 1;
      const ib = i < cols - 1 ? i : 0;
      const o = (j * cols + i) * 3;
      const oa = (j * cols + ib) * 3;
      const ob = (j * cols + ic) * 3;
      nextT[o] = positions[ob] - positions[oa];
      nextT[o + 1] = positions[ob + 1] - positions[oa + 1];
      nextT[o + 2] = positions[ob + 2] - positions[oa + 2];
    }
  }
  // Second pass for the degenerate pole rows, now that every row has an offset
  // to borrow from.
  for (let j = 0; j < rows; j++) {
    const o0 = j * cols * 3;
    const mag = Math.hypot(nextT[o0], nextT[o0 + 1], nextT[o0 + 2]);
    if (mag > 1e-9) continue;
    const donor = j === 0 ? 1 : j - 1;
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 3;
      const od = (donor * cols + i) * 3;
      nextT[o] = nextT[od];
      nextT[o + 1] = nextT[od + 1];
      nextT[o + 2] = nextT[od + 2];
    }
  }
}

/**
 * Builds one LOD of the closed bell. Returns CPU arrays plus the index ranges
 * the pass graph needs; `createBellGeometry` uploads them.
 *
 * Ranges, in the order they sit in the index buffer:
 *   exumbrella      pass 6 draws this plus `rim`
 *   rim             the stitched margin band
 *   subumbrella     pass 5 draws this, culling FRONT
 *   all             passes 3 and 4 draw the whole closed shell
 *
 * `exumbrellaWithRim` is the contiguous union of the first two, so pass 6 is
 * one draw call rather than two.
 */
export function buildBellMesh(options = {}) {
  const {
    azimuth = TESSELLATION.LOD0.azimuth,
    rings = TESSELLATION.LOD0.rings,
    rimRows = 2,
    radius = BELL_RADIUS,
    imperfection = createBakedImperfection()
  } = options;

  const rows = buildRowTable(rings, rimRows);
  const rowCount = rows.length;
  const cols = azimuth + 1;
  const dTheta = TAU / azimuth;

  // Positions first, so the neighbour offsets are exact differences of the
  // same numbers that ship in aRest rather than a re-evaluation that could
  // round differently.
  const positions = new Float64Array(rowCount * cols * 3);
  const scratch = [0, 0, 0];
  for (let j = 0; j < rowCount; j++) {
    for (let i = 0; i < cols; i++) {
      // The seam column is not evaluated at theta = 2*PI; it is COPIED from
      // column 0. Every function involved is 2*PI-periodic, so the values would
      // agree analytically, but `cos(TAU)` is not bit-identical to `cos(0)` and
      // a sub-ulp gap in a watertight shell is still a gap.
      if (i === azimuth) {
        const src = (j * cols) * 3;
        const dst = (j * cols + i) * 3;
        positions[dst] = positions[src];
        positions[dst + 1] = positions[src + 1];
        positions[dst + 2] = positions[src + 2];
        continue;
      }
      sheetPoint(scratch, rows[j], i * dTheta, imperfection, radius);
      const o = (j * cols + i) * 3;
      positions[o] = scratch[0];
      positions[o + 1] = scratch[1];
      positions[o + 2] = scratch[2];
    }
  }

  const rowPhi = new Float64Array(rowCount);
  for (let j = 0; j < rowCount; j++) rowPhi[j] = rows[j].phi;
  const neighbours = {
    nextS: new Float64Array(rowCount * cols * 3),
    nextT: new Float64Array(rowCount * cols * 3),
    dPhi: new Float64Array(rowCount)
  };
  gridNeighbours(positions, rowCount, cols, rowPhi, neighbours);

  const maxTriangles = (rowCount - 1) * (cols - 1) * 2;
  const sink = createMeshSink(rowCount * cols, maxTriangles);
  const wallRef = wallThickness(0, radius);

  for (let j = 0; j < rowCount; j++) {
    const row = rows[j];
    const thick = wallThickness(row.phi, radius) / wallRef;
    for (let i = 0; i < cols; i++) {
      const theta = i * dTheta;
      const o = (j * cols + i) * 3;
      sink.pushVertex(
        positions[o], positions[o + 1], positions[o + 2],
        row.phi, theta,
        imperfection.lappetGain(theta), density(row.phi, theta), row.tag, thick,
        neighbours.nextS[o], neighbours.nextS[o + 1], neighbours.nextS[o + 2],
        neighbours.dPhi[j],
        neighbours.nextT[o], neighbours.nextT[o + 1], neighbours.nextT[o + 2],
        dTheta
      );
    }
  }

  const isPole = (j) => {
    const o = (j * cols) * 3;
    return Math.hypot(positions[o], positions[o + 2]) < 1e-7;
  };

  // Three consecutive stitches over slices of the same grid keep the three
  // ranges contiguous without generating the vertices three times.
  const exuRange = stitchSlice(sink, 0, cols, 0, rings, isPole);
  const rimRange = stitchSlice(sink, 0, cols, rings, rings + rimRows + 1, isPole);
  const subRange = stitchSlice(sink, 0, cols, rings + rimRows + 1, rowCount - 1, isPole);

  return {
    vertices: sink.vertices.subarray(0, sink.vertexCount * BELL_VERTEX_FLOATS),
    indices: sink.indices.subarray(0, sink.indexCount),
    indexType: sink.indices instanceof Uint32Array ? 'uint' : 'ushort',
    vertexCount: sink.vertexCount,
    triangleCount: sink.indexCount / 3,
    azimuth, rings, rimRows, radius,
    rowCount, cols, dTheta,
    ranges: {
      exumbrella: exuRange,
      rim: rimRange,
      subumbrella: subRange,
      exumbrellaWithRim: { offset: exuRange.offset, count: exuRange.count + rimRange.count },
      all: { offset: 0, count: sink.indexCount }
    }
  };
}

/**
 * Stitches rows `[fromRow, toRow)` of an already-generated rows x cols grid,
 * skipping the zero-area triangles a degenerate pole row produces. Emitting a
 * slice rather than the whole grid is what lets the bell put the exumbrella,
 * the rim and the subumbrella in three contiguous runs of ONE index buffer, so
 * the pass graph selects between them with an offset instead of a rebind.
 *
 * The winding is `(a, b, c)` = (this row/col, next col, next row) and
 * `(b, d, c)`; both have the geometric normal `cross(alongCol, alongRow)`,
 * which is the same order the analytic normal in the vertex shader uses. Get
 * those two out of step and the animal renders inside out only from behind.
 */
function stitchSlice(sink, base, cols, fromRow, toRow, isPoleRow) {
  const first = sink.indexCount;
  for (let j = fromRow; j < toRow; j++) {
    const r0 = base + j * cols;
    const r1 = base + (j + 1) * cols;
    const poleTop = isPoleRow(j);
    const poleBottom = isPoleRow(j + 1);
    for (let i = 0; i < cols - 1; i++) {
      const a = r0 + i, b = r0 + i + 1, c = r1 + i, d = r1 + i + 1;
      if (!poleTop) sink.pushTriangle(a, b, c);
      if (!poleBottom) sink.pushTriangle(b, d, c);
    }
  }
  return { offset: first, count: sink.indexCount - first };
}

/* --- §3.2 gonads and manubrium ------------------------------------------ */

/** §3.2: four horseshoe tube segments, 24 × 8, at phi in [0.30, 0.55]. */
export const GONAD_SEGMENTS = 24;
export const GONAD_SIDES = 8;
export const GONAD_PHI_INNER = 0.30;
export const GONAD_PHI_OUTER = 0.55;
/** §3.2: each spans 70° of azimuth. */
export const GONAD_HALF_SPAN = 35 * Math.PI / 180;
/** Tube radius, in units of R: a 7.8 mm tube on a 26 cm animal. */
export const GONAD_TUBE_RADIUS = 0.030;
/** How far the tube sits off the subumbrella, in tube radii. */
const GONAD_STANDOFF = 0.85;
/** Gonad tissue is denser than the bell wall it hangs under. */
const GONAD_DENSITY = 4.5;

/** §3.2: a 4-lobed stub at the subumbrella centre, 12 × 8. */
export const MANUBRIUM_ROWS = 12;
export const MANUBRIUM_SIDES = 8;
/** In units of R. */
export const MANUBRIUM_LENGTH = 0.32;
export const MANUBRIUM_RADIUS = 0.13;
const MANUBRIUM_LOBES = 4;
const MANUBRIUM_LOBE_DEPTH = 0.28;
/**
 * The manubrium hangs from the apex, where §4.2's activation smoothstep is
 * still zero, so it rides the apex-dome term as a rigid body instead of
 * shearing. Giving every one of its vertices the same phi is what makes that
 * true; a phi ramp down the stub would stretch it on every stroke.
 */
const MANUBRIUM_PHI = 0.06;
const MANUBRIUM_DENSITY = 3.5;

const _ra = [0, 0, 0];
const _rb = [0, 0, 0];
const _rc = [0, 0, 0];
const _ta = [0, 0, 0];
const _tb = [0, 0, 0];

/**
 * Appends a closed tube to a mesh sink from a centreline sampler.
 *
 * `sample(t, out)` writes the centreline point into `out.c`, a reference "up"
 * vector into `out.up`, and sets `out.radius`, `out.phi` and `out.theta`. The
 * radius must go to zero at t = 0 and t = 1: that is what closes the tube, and
 * a tube that is not closed breaks the signed accumulation of pass 4 in the
 * most visible way possible — it glows.
 *
 * The ring angle runs NEGATIVE. With `B = cross(T, up)` and a ring point at
 * `C + radius*(cos a * B + sin a * up)`, the triple (B, up, T) is left-handed,
 * so `cross(alongRing, alongCentreline)` points INTO the tube for increasing a.
 * Negating a flips it, which puts tubes on the same winding convention as the
 * bell sheet and lets one program shade both.
 */
function appendTube(sink, rows, sides, sample, meta) {
  const base = sink.vertexCount;
  const cols = sides + 1;
  const positions = new Float64Array(rows * cols * 3);
  const rowPhi = new Float64Array(rows);
  const rowTheta = new Float64Array(rows);
  const out = { c: [0, 0, 0], up: [0, 0, 0], radius: 0, phi: 0, theta: 0 };
  const h = 0.5 / (rows - 1);

  for (let j = 0; j < rows; j++) {
    const t = j / (rows - 1);
    sample(t, out);
    rowPhi[j] = out.phi;
    rowTheta[j] = out.theta;
    const cx = out.c[0], cy = out.c[1], cz = out.c[2];
    // Snap a vanishing radius to exactly zero. `sin(PI)` is 1.2e-16 rather than
    // 0 in binary floating point, and raised to the taper exponent that becomes
    // a ring of eight points a hundredth of a micrometre apart — visually a
    // closed end, topologically an eight-edge HOLE, and a hole is exactly what
    // makes the signed accumulation of pass 4 glow.
    const radius = out.radius < 1e-7 ? 0 : out.radius;
    let ux = out.up[0], uy = out.up[1], uz = out.up[2];

    // Central-difference tangent, one-sided at the ends.
    sample(Math.max(0, t - h), out);
    _ta[0] = out.c[0]; _ta[1] = out.c[1]; _ta[2] = out.c[2];
    sample(Math.min(1, t + h), out);
    _tb[0] = out.c[0]; _tb[1] = out.c[1]; _tb[2] = out.c[2];
    let tx = _tb[0] - _ta[0], ty = _tb[1] - _ta[1], tz = _tb[2] - _ta[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;

    // Gram-Schmidt the reference up against the tangent so the frame is exactly
    // orthonormal; the winding argument above assumes T . up == 0.
    const dot = tx * ux + ty * uy + tz * uz;
    ux -= tx * dot; uy -= ty * dot; uz -= tz * dot;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-9) {
      // Degenerate only if the centreline runs along the reference up. Any
      // perpendicular will do; the ring is a circle either way.
      ux = ty; uy = -tx; uz = 0;
      ul = Math.hypot(ux, uy, uz) || 1;
    }
    ux /= ul; uy /= ul; uz /= ul;
    const bx = ty * uz - tz * uy;
    const by = tz * ux - tx * uz;
    const bz = tx * uy - ty * ux;

    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 3;
      if (i === sides) {
        const src = (j * cols) * 3;
        positions[o] = positions[src];
        positions[o + 1] = positions[src + 1];
        positions[o + 2] = positions[src + 2];
        continue;
      }
      if (radius === 0) {
        positions[o] = cx; positions[o + 1] = cy; positions[o + 2] = cz;
        continue;
      }
      const a = -(i / sides) * TAU;
      const ca = Math.cos(a) * radius, sa = Math.sin(a) * radius;
      positions[o] = cx + bx * ca + ux * sa;
      positions[o + 1] = cy + by * ca + uy * sa;
      positions[o + 2] = cz + bz * ca + uz * sa;
    }
  }

  const neighbours = {
    nextS: new Float64Array(rows * cols * 3),
    nextT: new Float64Array(rows * cols * 3),
    dPhi: new Float64Array(rows)
  };
  gridNeighbours(positions, rows, cols, rowPhi, neighbours);

  const dThetaRing = TAU / sides;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 3;
      sink.pushVertex(
        positions[o], positions[o + 1], positions[o + 2],
        rowPhi[j], rowTheta[j],
        meta.lappetGain(rowTheta[j]), meta.density, meta.tag, meta.thickScale,
        neighbours.nextS[o], neighbours.nextS[o + 1], neighbours.nextS[o + 2],
        neighbours.dPhi[j],
        neighbours.nextT[o], neighbours.nextT[o + 1], neighbours.nextT[o + 2],
        dThetaRing
      );
    }
  }

  const isPole = (j) => {
    const o = (j * cols) * 3;
    const o1 = (j * cols + 1) * 3;
    return Math.hypot(positions[o1] - positions[o],
                      positions[o1 + 1] - positions[o + 1],
                      positions[o1 + 2] - positions[o + 2]) < 1e-9;
  };
  return stitchSlice(sink, base, cols, 0, rows - 1, isPole);
}

/**
 * §3.2's four gonad horseshoes and the manubrium, as one mesh with named index
 * ranges. They share the bell's vertex format and attribute locations, so
 * pass 4 adds them to the optical depth with the same program the bell uses and
 * pass 5 draws them with the interior program.
 *
 * The horseshoe opens toward the centre of the animal: the crest of the U sits
 * at phi = 0.55, out toward the margin, and its two ends run back in to
 * phi = 0.30. That is the way round an Aurelia's gonads actually sit, and it is
 * the single most recognisable thing about the species — which is why §3.2
 * gives the interior pass its own slot in an eight-pass budget.
 */
export function buildInteriorMesh(options = {}) {
  const {
    radius = BELL_RADIUS,
    imperfection = createBakedImperfection()
  } = options;

  const gonadRows = GONAD_SEGMENTS + 1;
  const gonadCols = GONAD_SIDES + 1;
  const manuRows = MANUBRIUM_ROWS + 1;
  const manuCols = MANUBRIUM_SIDES + 1;
  const maxVertices = 4 * gonadRows * gonadCols + manuRows * manuCols;
  const maxTriangles = 4 * (gonadRows - 1) * (gonadCols - 1) * 2
                     + (manuRows - 1) * (manuCols - 1) * 2;
  const sink = createMeshSink(maxVertices, maxTriangles);

  const tubeRadius = GONAD_TUBE_RADIUS * radius;
  const wallRef = wallThickness(0, radius);
  const gonadThick = tubeRadius / wallRef;

  const gonadFirst = sink.indexCount;
  for (const g of imperfection.gonads) {
    appendTube(sink, gonadRows, GONAD_SIDES, (t, out) => {
      const a = 2 * t - 1;
      const theta = g.azimuth + a * GONAD_HALF_SPAN * g.extentScale;
      const phi = GONAD_PHI_OUTER - (GONAD_PHI_OUTER - GONAD_PHI_INNER) * g.extentScale * a * a;
      sculptedProfile(_pf, phi, theta, imperfection);
      const w = wOverR(phi);
      const nR = _pf[2], nY = _pf[3];
      // Subumbrella surface point, then stood off along the cavity-facing
      // normal so the tube bulges into the cavity rather than through the wall.
      const rr = _pf[0] - nR * w;
      const yy = _pf[1] - nY * w;
      const ct = Math.cos(theta), st = Math.sin(theta);
      const nx = -nR * ct, ny = -nY, nz = -nR * st;
      const standoff = tubeRadius * GONAD_STANDOFF;
      out.c[0] = rr * radius * ct + nx * standoff;
      out.c[1] = yy * radius + ny * standoff;
      out.c[2] = rr * radius * st + nz * standoff;
      out.up[0] = nx; out.up[1] = ny; out.up[2] = nz;
      // sin(pi*t)^0.35 is fat for most of its length and rounds off hard at the
      // two ends, which both closes the tube and stops the ends reading as cut
      // pipe. The exponent is the difference between a sausage and a lozenge.
      out.radius = tubeRadius * Math.pow(Math.sin(Math.PI * t), 0.35);
      out.phi = phi;
      out.theta = theta;
    }, {
      lappetGain: imperfection.lappetGain,
      density: GONAD_DENSITY,
      tag: SHELL_TAG.GONAD,
      thickScale: gonadThick
    });
  }
  const gonadRange = { offset: gonadFirst, count: sink.indexCount - gonadFirst };

  // The manubrium hangs from the subumbrella apex, which sits one wall
  // thickness below the exumbrella apex.
  const apexY = (0.34 - wOverR(0)) * radius;
  const manuRadius = MANUBRIUM_RADIUS * radius;
  const manuLength = MANUBRIUM_LENGTH * radius;
  const manuFirst = sink.indexCount;
  appendTube(sink, manuRows, MANUBRIUM_SIDES, (t, out) => {
    out.c[0] = 0;
    out.c[1] = apexY - manuLength * t;
    out.c[2] = 0;
    out.up[0] = 0; out.up[1] = 0; out.up[2] = 1;
    // Closed at both ends, fattest just below the root, and four-lobed in the
    // middle where the lobes are actually visible.
    const taper = Math.pow(Math.sin(Math.PI * t), 0.55);
    out.radius = manuRadius * taper;
    out.phi = MANUBRIUM_PHI;
    out.theta = 0;
  }, {
    lappetGain: () => 1,
    density: MANUBRIUM_DENSITY,
    tag: SHELL_TAG.MANUBRIUM,
    thickScale: manuRadius / wallRef
  });
  const manuRange = { offset: manuFirst, count: sink.indexCount - manuFirst };

  // The four lobes are applied after the tube is built, as a radial scale about
  // the manubrium axis, so that `appendTube`'s frame construction never has to
  // deal with a non-circular cross-section. The neighbour offsets are rebuilt
  // from the lobed positions immediately below.
  applyManubriumLobes(sink, manuRows, manuCols);

  return {
    vertices: sink.vertices.subarray(0, sink.vertexCount * BELL_VERTEX_FLOATS),
    indices: sink.indices.subarray(0, sink.indexCount),
    indexType: sink.indices instanceof Uint32Array ? 'uint' : 'ushort',
    vertexCount: sink.vertexCount,
    triangleCount: sink.indexCount / 3,
    radius,
    ranges: {
      gonads: gonadRange,
      manubrium: manuRange,
      all: { offset: 0, count: sink.indexCount }
    }
  };
}

/**
 * Turns the manubrium's circular cross-section into §3.2's four lobes, and
 * repairs the neighbour offsets afterwards. Applied as a post-pass because the
 * lobing is a radial scale about a straight axis and can be written in six
 * lines here, against a frame-aware version inside `appendTube` that would
 * complicate the one helper both tube meshes share.
 *
 * The lobe depth fades with `sin(pi*t)` so the two closed ends stay circular:
 * a lobed pole is a pinch, and a pinch on a closed surface is a place the
 * analytic normal cannot resolve.
 */
function applyManubriumLobes(sink, rows, cols) {
  const v = sink.vertices;
  // The manubrium's vertices are the last rows*cols the sink emitted.
  const base = sink.vertexCount - rows * cols;
  for (let j = 0; j < rows; j++) {
    const t = j / (rows - 1);
    const fade = Math.sin(Math.PI * t);
    for (let i = 0; i < cols; i++) {
      const o = (base + j * cols + i) * BELL_VERTEX_FLOATS;
      const x = v[o], z = v[o + 2];
      const r = Math.hypot(x, z);
      if (r < 1e-9) continue;
      const a = Math.atan2(z, x);
      const scale = 1 + MANUBRIUM_LOBE_DEPTH * Math.cos(MANUBRIUM_LOBES * a) * fade;
      v[o] = x * scale;
      v[o + 2] = z * scale;
      // theta is the vertex's true azimuth once it is off the axis, which is
      // what the lappet gain and the density pattern both want.
      v[o + 4] = a < 0 ? a + TAU : a;
    }
  }
  // Neighbour offsets are differences of positions that have just moved.
  for (let j = 0; j < rows; j++) {
    const jn = j < rows - 1 ? j + 1 : j - 1;
    const sgn = j < rows - 1 ? 1 : -1;
    for (let i = 0; i < cols; i++) {
      const o = (base + j * cols + i) * BELL_VERTEX_FLOATS;
      const on = (base + jn * cols + i) * BELL_VERTEX_FLOATS;
      v[o + 9] = (v[on] - v[o]) * sgn;
      v[o + 10] = (v[on + 1] - v[o + 1]) * sgn;
      v[o + 11] = (v[on + 2] - v[o + 2]) * sgn;
      const ic = i < cols - 1 ? i + 1 : 1;
      const ib = i < cols - 1 ? i : 0;
      const oa = (base + j * cols + ib) * BELL_VERTEX_FLOATS;
      const ob = (base + j * cols + ic) * BELL_VERTEX_FLOATS;
      v[o + 13] = v[ob] - v[oa];
      v[o + 14] = v[ob + 1] - v[oa + 1];
      v[o + 15] = v[ob + 2] - v[oa + 2];
    }
  }
  // The two poles again: a zero theta offset there is a NaN normal.
  for (let j = 0; j < rows; j += rows - 1) {
    const o0 = (base + j * cols) * BELL_VERTEX_FLOATS;
    if (Math.hypot(v[o0 + 13], v[o0 + 14], v[o0 + 15]) > 1e-9) continue;
    const donor = j === 0 ? 1 : rows - 2;
    for (let i = 0; i < cols; i++) {
      const o = (base + j * cols + i) * BELL_VERTEX_FLOATS;
      const od = (base + donor * cols + i) * BELL_VERTEX_FLOATS;
      v[o + 13] = v[od + 13]; v[o + 14] = v[od + 14]; v[o + 15] = v[od + 15];
    }
  }
}

/* --- Attachment points for geometry/strands.js -------------------------- */

/**
 * A rest-pose point on the rim band at azimuth `theta`, in metres, in the
 * bell's own frame. `b` runs 0 (exumbrella lip) to 1 (subumbrella lip); the
 * marginal tentacles of an Aurelia emerge from just inside the subumbrellar
 * side of the rim, which is `MARGIN_ATTACH_B`.
 *
 * This is the function that makes §4.2's promise good: it evaluates exactly the
 * same sculpted profile, the same lappets, the same rhopalia notches, the same
 * torn wedge and the same baked noise that the mesh vertices were built from,
 * so a tentacle root and the margin it hangs off are the same point to the last
 * bit before either is deformed.
 */
export const MARGIN_ATTACH_B = 0.65;

export function bellRimPoint(out, theta, imp, b = MARGIN_ATTACH_B, radius = BELL_RADIUS) {
  return sheetPoint(out, { leg: 1, phi: 1, b, tag: SHELL_TAG.RIM }, theta, imp, radius);
}

/**
 * The rest-pose surface point on either shell, with the imperfection applied.
 * `shell` is +1 for the exumbrella and −1 for the subumbrella, matching
 * profile.js's SHELL_EXUMBRELLA / SHELL_SUBUMBRELLA.
 */
export function bellShellPoint(out, phi, theta, shell, imp, radius = BELL_RADIUS) {
  return sheetPoint(out, {
    leg: shell < 0 ? 2 : 0, phi, b: shell < 0 ? 1 : 0,
    tag: shell < 0 ? SHELL_TAG.SUBUMBRELLA : SHELL_TAG.EXUMBRELLA
  }, theta, imp, radius);
}

/**
 * The two parameter-space neighbour offsets at an arbitrary (phi, theta) on the
 * rim, so that a caller outside the mesh — the strand-root solver — can use
 * `deformBellFrame` from sim/deform.js and get the same analytic normal the
 * vertex shader computes. Writes into `outNextT` and `outNextS` and returns the
 * phi step that goes with `outNextS`.
 */
export function bellRimNeighbours(outNextT, outNextS, theta, imp, radius = BELL_RADIUS) {
  const dTheta = 0.02;
  const db = 0.05;
  bellRimPoint(_ra, theta, imp, MARGIN_ATTACH_B, radius);
  bellRimPoint(_rb, theta + dTheta, imp, MARGIN_ATTACH_B, radius);
  outNextT[0] = _rb[0] - _ra[0];
  outNextT[1] = _rb[1] - _ra[1];
  outNextT[2] = _rb[2] - _ra[2];
  bellRimPoint(_rc, theta, imp, MARGIN_ATTACH_B + db, radius);
  outNextS[0] = _rc[0] - _ra[0];
  outNextS[1] = _rc[1] - _ra[1];
  outNextS[2] = _rc[2] - _ra[2];
  // Both rim samples sit at phi = 1, so the row step carries no phi change.
  return 0;
}

/**
 * The four points the oral arms hang from: §3.2's manubrium lobes, in the
 * bell's own frame, in metres. Returned at the fattest part of the stub rather
 * than at its tip, because an Aurelia's oral arms leave the manubrium from its
 * corners, not from a single point.
 */
export function manubriumAttachment(out, armIndex, radius = BELL_RADIUS) {
  const a = (armIndex / MANUBRIUM_LOBES) * TAU;
  const apexY = (0.34 - wOverR(0)) * radius;
  const t = 0.62;
  const r = MANUBRIUM_RADIUS * radius * Math.pow(Math.sin(Math.PI * t), 0.55)
          * (1 + MANUBRIUM_LOBE_DEPTH * Math.sin(Math.PI * t));
  out[0] = r * Math.cos(a);
  out[1] = apexY - MANUBRIUM_LENGTH * radius * t;
  out[2] = r * Math.sin(a);
  return out;
}

/** The phi the manubrium and therefore the oral-arm roots deform at. */
export const MANUBRIUM_ATTACH_PHI = MANUBRIUM_PHI;

/* --- GL resources ------------------------------------------------------- */

/**
 * Uploads one CPU mesh and wires a VAO with the shared attribute locations.
 * Kept separate from the builders so the meshes can be generated, measured and
 * unit-checked with no GL context at all — which is how the watertightness
 * check in the definition of done is cheapest to run.
 */
function uploadMesh(gl, mesh, name) {
  const vertexBuffer = createBuffer(gl, {
    target: 'array', data: mesh.vertices, usage: 'static', name: `${name}.vertices`
  });
  const indexBuffer = createBuffer(gl, {
    target: 'index', data: mesh.indices, usage: 'static', name: `${name}.indices`
  });
  const stride = BELL_VERTEX_BYTES;
  const vertexArray = createVertexArray(gl, {
    name,
    attributes: [
      { buffer: vertexBuffer, location: BELL_ATTRIBUTE_LOCATIONS.aRest, size: 3, stride, offset: 0 },
      { buffer: vertexBuffer, location: BELL_ATTRIBUTE_LOCATIONS.aUV, size: 2, stride, offset: 12 },
      { buffer: vertexBuffer, location: BELL_ATTRIBUTE_LOCATIONS.aParam2, size: 4, stride, offset: 20 },
      { buffer: vertexBuffer, location: BELL_ATTRIBUTE_LOCATIONS.aNextS, size: 4, stride, offset: 36 },
      { buffer: vertexBuffer, location: BELL_ATTRIBUTE_LOCATIONS.aNextT, size: 4, stride, offset: 52 }
    ],
    indices: { buffer: indexBuffer, type: mesh.indexType }
  });
  return {
    mesh,
    vertexArray,
    ranges: mesh.ranges,
    /** Draws one named range. `draw('exumbrellaWithRim')`. */
    draw(rangeName) {
      const r = mesh.ranges[rangeName];
      if (!r) return;
      vertexArray.draw('triangles', r.count, r.offset);
    },
    dispose() {
      vertexArray.dispose();
      indexBuffer.dispose();
      vertexBuffer.dispose();
    }
  };
}

/**
 * Everything the renderer needs: both bell LODs and the interior mesh, built
 * from one imperfection so the gonads sit under the bell they belong to.
 *
 * Both LODs are generated at load and switching between them is a
 * `bindVertexArray`, per §3.1 — a rebuild on a tier change would stall for tens
 * of milliseconds at exactly the moment the machine is already struggling,
 * which is how a quality ladder becomes visible.
 */
export function createBellGeometry(gl, options = {}) {
  const {
    seed = 0x9E3779B1,
    radius = BELL_RADIUS,
    imperfection = createBakedImperfection(seed),
    rimRows = 2
  } = options;

  const lod0Mesh = buildBellMesh({
    azimuth: TESSELLATION.LOD0.azimuth, rings: TESSELLATION.LOD0.rings,
    rimRows, radius, imperfection
  });
  const lod1Mesh = buildBellMesh({
    azimuth: TESSELLATION.LOD1.azimuth, rings: TESSELLATION.LOD1.rings,
    rimRows, radius, imperfection
  });
  const interiorMesh = buildInteriorMesh({ radius, imperfection });

  const lod0 = uploadMesh(gl, lod0Mesh, 'bell.lod0');
  const lod1 = uploadMesh(gl, lod1Mesh, 'bell.lod1');
  const interior = uploadMesh(gl, interiorMesh, 'bell.interior');

  return {
    imperfection,
    radius,
    wallReference: wallThickness(0, radius),
    lods: [lod0, lod1],
    lod0, lod1, interior,
    /** `lod(0)` / `lod(1)`; anything else clamps rather than throwing mid-frame. */
    lod(index) { return index <= 0 ? lod0 : lod1; },
    dispose() {
      interior.dispose();
      lod1.dispose();
      lod0.dispose();
    }
  };
}
