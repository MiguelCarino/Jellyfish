/* ============================================================
   verlet.js — the strand solver, and its analytic understudy.
   ------------------------------------------------------------
   Spec §4.4. Two complete paths ship here, and both are real.

   PRIMARY — position Verlet at a fixed 120 Hz, with distance
   constraints, bend constraints and a pinned root. It is the
   primary path for one reason: the shed vortex ring (§4.4,
   flow.js) is a FORCE, and only a force integrator can be
   caught and flicked by one. That recoil during the glide is
   the difference between an alive animal and a bundle of
   noodles, so the solver earns its cost.

   FALLBACK — retarded-time sway. Unconditionally stable,
   stateless, frame-rate independent, evaluable at any point
   without a history. It is what runs at tier 4 and under
   `prefers-reduced-motion`, and per §4.4 it is a shipping path,
   not dead code. Its cost is exactly the thing the primary path
   buys: it cannot respond to a shed ring. Accepted there.

   Both systems expose the SAME surface — `chainCount`,
   `nodeCount`, `positions`, `setRoot()`, `step()` — so the
   vertex packer in geometry/strands.js can be handed either one
   and does not need to know which is running.

   WHY 120 Hz FIXED, AND WHY THE ACCUMULATOR IS CLAMPED. Verlet
   with a variable step is not merely inaccurate, it changes the
   effective stiffness of every constraint from frame to frame,
   which reads as the tentacles going slack whenever the frame
   rate dips. A fixed step keeps the material constant. The
   accumulator is clamped to four substeps so that a tab which
   has been asleep for nine hours cannot hand the solver a
   nine-hour catch-up and detonate it.

   WHY THE FLOW IS SAMPLED ONCE PER FRAME, NOT PER SUBSTEP. The
   current has metre-scale features and the fastest thing in it,
   a fresh vortex ring, translates at about 0.1 m/s — 1.6 mm in
   a frame. Re-sampling it two to four times inside one frame
   would triple the cost of the solver to move the answer by a
   fraction of a millimetre.
   ============================================================ */

import { vec3, clamp, lerp, Rng } from '../math.js';

export const VERLET_CONSTANTS = Object.freeze({
  SUBSTEP_HZ: 120,
  SUBSTEP_DT: 1 / 120,
  /** Four substeps is 33 ms of catch-up: enough for a hitch, not enough to explode. */
  MAX_SUBSTEPS: 4,
  CONSTRAINT_ITERATIONS: 4,

  /**
   * §4.4: "Without bend stiffness a tentacle is wet string; with too much it is
   * wire. This ramp is the tuning knob that matters most." Root value applies at
   * the attachment, tip value at the free end, linearly in normalised arc length.
   */
  BEND_STIFFNESS_ROOT: 0.55,
  BEND_STIFFNESS_TIP: 0.04,

  /** Near-neutrally buoyant, so gravity is a small fraction of g. */
  GRAVITY: 0.15,

  /**
   * Drag against the relative flow, quadratic and scaled by cross-section.
   *
   * The strictly physical value is enormous. For a cylinder of radius r,
   * a_drag = rho_w·Cd·v²/(rho_tissue·pi·r), which at r = 0.9 mm and Cd ≈ 1.5 is
   * about 530 — six thousand times §4.4's gravity of 0.15 m/s². At that ratio a
   * towed filament sits within 16° of the tow direction, and since this animal
   * must swim near-horizontally to hold its depth, every tentacle lies flat.
   *
   * The ratio is what is being tuned, not the drag alone: §4.4's 0.15 m/s² is
   * itself a lumped stand-in for buoyant weight AND the mesoglea's own bending
   * rigidity, and it is the one of the two the spec fixes. 28 is the value at
   * which a filament towed at the animal's mean glide speed hangs about 30°
   * off vertical, which is what reference footage of a gliding Aurelia shows.
   * Measured over four minutes of the real rig it gives a median 19° with 5 %
   * of strands sweeping past horizontal during a stroke.
   */
  DRAG_COEFFICIENT: 28.0,
  /**
   * The radius the drag coefficient is quoted at. Drag acceleration on a
   * filament goes as 1/r, NOT as r: the drag force scales with the projected
   * area (2rL) while the mass scales with the volume (πr²L), so a thicker
   * strand is LESS pushed around by the water, not more. Getting that ratio
   * upside down lays the thick oral arms out horizontally while leaving the
   * thin tentacles hanging, which is precisely backwards.
   */
  REFERENCE_RADIUS: 0.0009,

  /** Residual damping. The drag term does the real work; this is hygiene. */
  LINEAR_DAMPING: 0.06,
  /** Hard projection limit. Normal operation never reaches it. */
  MAX_STRETCH: 1.35,

  /* --- Retarded-time fallback, §4.4 ---------------------------------- */
  /** Seconds of lag per metre below the attachment point. */
  RETARDED_LAG: 0.55,
  RETARDED_WAVENUMBER: 6.0,
  RETARDED_OMEGA: 1.7,
  /** Lateral amplitude as a fraction of the strand's own length. */
  RETARDED_AMPLITUDE: 0.30,
  /** §4.6 runs the same path at this fraction of the amplitude. */
  REDUCED_MOTION_AMPLITUDE: 0.15,

  /**
   * Defaults matching geometry/strands.js, which is the authority: 12 verlet
   * guide chains of 14 nodes (the other 28 strands are interpolated between
   * them, §3.4), a median tentacle of 1.6 R = 0.208 m, and a 0.9 mm half-width.
   */
  DEFAULT_CHAIN_COUNT: 12,
  DEFAULT_NODE_COUNT: 14,
  DEFAULT_LENGTH: 0.208,
  DEFAULT_RADIUS: 0.0009
});

/**
 * §4.4's retarded time, and §3.3's oral-arm frill phase, are the same clock:
 * a disturbance at the bell takes 0.55 s to travel one metre down the strand.
 * Exported so the frill in the vertex shader and the sway here cannot disagree.
 */
export function retardedTime(time, depthBelowRoot) {
  return time - depthBelowRoot * VERLET_CONSTANTS.RETARDED_LAG;
}

/* Expands a scalar, array or typed array into a per-chain Float32Array. */
function expandPerChain(value, count, fallback) {
  const out = new Float32Array(count);
  if (typeof value === 'number') {
    out.fill(value);
  } else if (value && value.length >= count) {
    for (let i = 0; i < count; i++) out[i] = value[i];
  } else {
    out.fill(fallback);
  }
  return out;
}

/**
 * Total chain length from whichever of the two forms the caller has.
 * geometry/strands.js publishes `guideSegmentLengths` and `armSegmentLengths`
 * — one segment, not the whole chain — so accepting that form directly removes
 * an off-by-one that would otherwise be re-derived at every call site.
 */
function resolveLengths(lengths, segmentLengths, chainCount, nodeCount, fallback) {
  if (segmentLengths != null) {
    const seg = expandPerChain(segmentLengths, chainCount, fallback / (nodeCount - 1));
    for (let i = 0; i < chainCount; i++) seg[i] *= (nodeCount - 1);
    return seg;
  }
  return expandPerChain(lengths, chainCount, fallback);
}

/**
 * A stable orthonormal pair perpendicular to `d`. The reference axis is chosen
 * by which component of `d` is smallest, which is continuous everywhere a
 * strand can actually point and never degenerates.
 */
function perpendicularBasis(d, outA, outB) {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  let rx = 0, ry = 0, rz = 0;
  if (ax <= ay && ax <= az) rx = 1;
  else if (ay <= az) ry = 1;
  else rz = 1;
  vec3.cross(outA, d, [rx, ry, rz]);
  vec3.normalize(outA, outA);
  vec3.cross(outB, d, outA);
  vec3.normalize(outB, outB);
}

const _tmpA = vec3.create();
const _hangDir = vec3.create();
const _basisA = vec3.create();
const _basisB = vec3.create();

/**
 * The Verlet chain system. Flat Float32Arrays throughout: 40 chains × 14 nodes
 * × 120 Hz is 67 000 node-updates a second, which cannot afford one object per
 * node per substep.
 *
 * Node `j` of chain `i` lives at index `(i * nodeCount + j) * 3` in
 * `positions`. Node 0 of every chain is the pinned root.
 */
export class ChainSystem {
  /**
   * `lengths` and `radii` may each be a number or a per-chain array; the
   * per-strand decorrelation in §3.4 is geometry/strands.js's business, and it
   * passes the resulting arrays in here. Pass `segmentLengths` INSTEAD of
   * `lengths` to give the per-segment figure that strands.js already publishes;
   * it takes precedence and is multiplied up internally.
   */
  constructor({
    chainCount = VERLET_CONSTANTS.DEFAULT_CHAIN_COUNT,
    nodeCount = VERLET_CONSTANTS.DEFAULT_NODE_COUNT,
    lengths = VERLET_CONSTANTS.DEFAULT_LENGTH,
    segmentLengths = null,
    radii = VERLET_CONSTANTS.DEFAULT_RADIUS,
    stiffnessScale = 1.0,
    seed = 'aurelia-strands'
  } = {}) {
    this.chainCount = chainCount | 0;
    this.nodeCount = Math.max(2, nodeCount | 0);
    this.mode = 'verlet';
    this.rng = new Rng(seed);

    const n = this.chainCount * this.nodeCount;
    this.positions = new Float32Array(n * 3);
    this.previous = new Float32Array(n * 3);

    this.lengths = resolveLengths(lengths, segmentLengths, this.chainCount,
                                  this.nodeCount, VERLET_CONSTANTS.DEFAULT_LENGTH);
    this.radii = expandPerChain(radii, this.chainCount, VERLET_CONSTANTS.DEFAULT_RADIUS);
    this.stiffnessScale = expandPerChain(stiffnessScale, this.chainCount, 1.0);

    /** Segment rest length. Index `(i*M + j)` is the segment from node j−1 to j. */
    this.restLength = new Float32Array(n);
    /** Bend stiffness at node j, ramped root → tip. */
    this.bendStiffness = new Float32Array(n);
    /** Drag scale: cross-section relative to REFERENCE_RADIUS. */
    this.dragScale = new Float32Array(n);

    this.roots = new Float32Array(this.chainCount * 3);
    this._rootsPrev = new Float32Array(this.chainCount * 3);
    this._rootsSub = new Float32Array(this.chainCount * 3);
    this._hang = new Float32Array(this.chainCount * 3);
    this._flowCache = new Float32Array(n * 3);

    this.accumulator = 0;
    this.substepsLastFrame = 0;

    this._buildParameters();
    this.reset();
  }

  _buildParameters() {
    const M = this.nodeCount;
    const K = VERLET_CONSTANTS;
    for (let i = 0; i < this.chainCount; i++) {
      const seg = this.lengths[i] / (M - 1);
      const scale = this.stiffnessScale[i];
      for (let j = 0; j < M; j++) {
        const n = i * M + j;
        this.restLength[n] = j === 0 ? 0 : seg;
        const s = j / (M - 1);
        this.bendStiffness[n] = clamp(
          lerp(K.BEND_STIFFNESS_ROOT, K.BEND_STIFFNESS_TIP, s) * scale, 0, 1
        );
        /* Strands taper, so the thinner tip follows the flow harder than the root. */
        const r = Math.max(this.radii[i] * lerp(1.0, 0.45, s), 1e-6);
        this.dragScale[n] = K.REFERENCE_RADIUS / r;
      }
      this._hang[i * 3] = 0;
      this._hang[i * 3 + 1] = -1;
      this._hang[i * 3 + 2] = 0;
    }
  }

  /** The pinned attachment point for chain `i`, in scene metres. Set every frame. */
  setRoot(i, x, y, z) {
    const b = i * 3;
    this.roots[b] = x;
    this.roots[b + 1] = y;
    this.roots[b + 2] = z;
    return this;
  }

  /**
   * The direction chain `i` hangs when at rest. Only the retarded path treats
   * this as authoritative; the Verlet path uses it when laying a chain out from
   * scratch. Need not be normalised.
   */
  setHang(i, x, y, z) {
    const b = i * 3;
    const l = Math.hypot(x, y, z);
    if (l < 1e-9) return this;
    this._hang[b] = x / l;
    this._hang[b + 1] = y / l;
    this._hang[b + 2] = z / l;
    return this;
  }

  /** Lay every chain out straight from its current root along its hang direction. */
  reset() {
    for (let i = 0; i < this.chainCount; i++) this.resetChain(i);
    this.accumulator = 0;
    this._rootsPrev.set(this.roots);
    return this;
  }

  /** Lay one chain out straight. Used at boot, after a context loss, and on a NaN. */
  resetChain(i) {
    const M = this.nodeCount;
    const rb = i * 3;
    const seg = this.lengths[i] / (M - 1);
    for (let j = 0; j < M; j++) {
      const b = (i * M + j) * 3;
      const d = seg * j;
      this.positions[b] = this.roots[rb] + this._hang[rb] * d;
      this.positions[b + 1] = this.roots[rb + 1] + this._hang[rb + 1] * d;
      this.positions[b + 2] = this.roots[rb + 2] + this._hang[rb + 2] * d;
      this.previous[b] = this.positions[b];
      this.previous[b + 1] = this.positions[b + 1];
      this.previous[b + 2] = this.positions[b + 2];
    }
    return this;
  }

  /**
   * Move every node, including the stored history, by a constant offset. This
   * is the floating-origin rebase (§4.3): the animal is pulled back toward the
   * origin and everything in scene space must come with it, or the strands
   * would be left behind by the millimetre the animal was moved.
   */
  translate(dx, dy, dz) {
    const p = this.positions, q = this.previous;
    for (let b = 0; b < p.length; b += 3) {
      p[b] += dx; p[b + 1] += dy; p[b + 2] += dz;
      q[b] += dx; q[b + 1] += dy; q[b + 2] += dz;
    }
    for (let b = 0; b < this.roots.length; b += 3) {
      this.roots[b] += dx; this.roots[b + 1] += dy; this.roots[b + 2] += dz;
      this._rootsPrev[b] += dx; this._rootsPrev[b + 1] += dy; this._rootsPrev[b + 2] += dz;
    }
    return this;
  }

  /**
   * Advance by `dt` seconds. `flow` is anything with
   * `sampleVelocity(out, x, y, z)`; pass null for still water.
   */
  step(dt, flow = null) {
    const H = VERLET_CONSTANTS.SUBSTEP_DT;
    this.accumulator += clamp(dt, 0, 1);
    const maxAcc = VERLET_CONSTANTS.MAX_SUBSTEPS * H;
    if (this.accumulator > maxAcc) this.accumulator = maxAcc;

    const steps = Math.floor(this.accumulator / H);
    this.substepsLastFrame = steps;
    if (steps <= 0) return this;
    this.accumulator -= steps * H;

    this._sampleFlow(flow);
    for (let s = 0; s < steps; s++) {
      this._substep(H, (s + 1) / steps);
    }
    this._rootsPrev.set(this.roots);
    return this;
  }

  /** One flow lookup per node per frame. See the file header for why not per substep. */
  _sampleFlow(flow) {
    const cache = this._flowCache;
    if (!flow) { cache.fill(0); return; }
    const p = this.positions;
    const M = this.nodeCount;
    for (let i = 0; i < this.chainCount; i++) {
      for (let j = 1; j < M; j++) {
        const b = (i * M + j) * 3;
        flow.sampleVelocity(_tmpA, p[b], p[b + 1], p[b + 2]);
        cache[b] = _tmpA[0];
        cache[b + 1] = _tmpA[1];
        cache[b + 2] = _tmpA[2];
      }
    }
  }

  _substep(h, rootT) {
    const K = VERLET_CONSTANTS;
    const M = this.nodeCount;
    const p = this.positions, q = this.previous, cache = this._flowCache;
    const damping = 1 - K.LINEAR_DAMPING * h;
    const invH = 1 / h;

    for (let i = 0; i < this.chainCount; i++) {
      const rb = i * 3;
      /*
       * The root is interpolated across the substeps of the frame rather than
       * teleported to its final position on the first one. The bell margin can
       * move several centimetres in a frame during a contraction; a teleported
       * root would inject that as an impulse and the strands would snap.
       */
      const rx = lerp(this._rootsPrev[rb], this.roots[rb], rootT);
      const ry = lerp(this._rootsPrev[rb + 1], this.roots[rb + 1], rootT);
      const rz = lerp(this._rootsPrev[rb + 2], this.roots[rb + 2], rootT);
      const r0 = (i * M) * 3;
      q[r0] = p[r0]; q[r0 + 1] = p[r0 + 1]; q[r0 + 2] = p[r0 + 2];
      p[r0] = rx; p[r0 + 1] = ry; p[r0 + 2] = rz;
      this._rootsSub[rb] = rx;
      this._rootsSub[rb + 1] = ry;
      this._rootsSub[rb + 2] = rz;

      for (let j = 1; j < M; j++) {
        const n = i * M + j;
        const b = n * 3;
        const px = p[b], py = p[b + 1], pz = p[b + 2];
        const vx = (px - q[b]) * invH;
        const vy = (py - q[b + 1]) * invH;
        const vz = (pz - q[b + 2]) * invH;

        const relx = cache[b] - vx;
        const rely = cache[b + 1] - vy;
        const relz = cache[b + 2] - vz;
        const relLen = Math.hypot(relx, rely, relz);

        /*
         * Quadratic drag, written as a rate rather than as a force, and capped
         * at 1/h. The cap is what makes it unconditionally stable: the most the
         * drag may do in one substep is bring the node exactly to the flow
         * velocity, never past it into an oscillation.
         */
        let k = K.DRAG_COEFFICIENT * this.dragScale[n] * relLen;
        if (k > invH) k = invH;

        const ax = relx * k;
        const ay = rely * k - K.GRAVITY;
        const az = relz * k;

        const nx = px + (px - q[b]) * damping + ax * h * h;
        const ny = py + (py - q[b + 1]) * damping + ay * h * h;
        const nz = pz + (pz - q[b + 2]) * damping + az * h * h;

        q[b] = px; q[b + 1] = py; q[b + 2] = pz;
        p[b] = nx; p[b + 1] = ny; p[b + 2] = nz;
      }
    }

    for (let it = 0; it < K.CONSTRAINT_ITERATIONS; it++) {
      this._solveDistance();
      this._solveBend();
      this._pinRoots();
    }
    this._projectStretch();
    this._guardFinite();
  }

  /** Gauss-Seidel distance constraints. Equal weights; the root is re-pinned after. */
  _solveDistance() {
    const p = this.positions;
    const M = this.nodeCount;
    for (let i = 0; i < this.chainCount; i++) {
      for (let j = 1; j < M; j++) {
        const n = i * M + j;
        const a = (n - 1) * 3, b = n * 3;
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-9) continue;
        const diff = (len - this.restLength[n]) / len * 0.5;
        const cx = dx * diff, cy = dy * diff, cz = dz * diff;
        p[a] += cx; p[a + 1] += cy; p[a + 2] += cz;
        p[b] -= cx; p[b + 1] -= cy; p[b + 2] -= cz;
      }
    }
  }

  /**
   * Bend constraint with a rest angle of zero: the interior node is pulled
   * toward the midpoint of its neighbours. The correction is split −¼ / +½ / −¼
   * so it sums to zero and adds no net momentum, which is what keeps a stiff
   * root from slowly launching the whole strand.
   */
  _solveBend() {
    const p = this.positions;
    const M = this.nodeCount;
    if (M < 3) return;
    for (let i = 0; i < this.chainCount; i++) {
      for (let j = 1; j < M - 1; j++) {
        const n = i * M + j;
        const a = (n - 1) * 3, b = n * 3, c = (n + 1) * 3;
        const k = this.bendStiffness[n];
        if (k <= 0) continue;
        const mx = (p[a] + p[c]) * 0.5 - p[b];
        const my = (p[a + 1] + p[c + 1]) * 0.5 - p[b + 1];
        const mz = (p[a + 2] + p[c + 2]) * 0.5 - p[b + 2];
        const hx = mx * k * 0.25, hy = my * k * 0.25, hz = mz * k * 0.25;
        p[a] -= hx; p[a + 1] -= hy; p[a + 2] -= hz;
        p[c] -= hx; p[c + 1] -= hy; p[c + 2] -= hz;
        p[b] += hx * 2; p[b + 1] += hy * 2; p[b + 2] += hz * 2;
      }
    }
  }

  _pinRoots() {
    const p = this.positions;
    const M = this.nodeCount;
    for (let i = 0; i < this.chainCount; i++) {
      const b = (i * M) * 3, rb = i * 3;
      p[b] = this._rootsSub[rb];
      p[b + 1] = this._rootsSub[rb + 1];
      p[b + 2] = this._rootsSub[rb + 2];
    }
  }

  /**
   * A hard walk from the root clamping every segment to MAX_STRETCH. Four
   * Gauss-Seidel iterations leave a little residual stretch, which is fine and
   * is what makes the strand feel elastic; this only catches the pathological
   * case, and a strand stretched 35 % has already stopped looking like tissue.
   */
  _projectStretch() {
    const p = this.positions;
    const M = this.nodeCount;
    const maxK = VERLET_CONSTANTS.MAX_STRETCH;
    for (let i = 0; i < this.chainCount; i++) {
      for (let j = 1; j < M; j++) {
        const n = i * M + j;
        const a = (n - 1) * 3, b = n * 3;
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const len = Math.hypot(dx, dy, dz);
        const maxLen = this.restLength[n] * maxK;
        if (len <= maxLen || len < 1e-9) continue;
        const s = maxLen / len;
        p[b] = p[a] + dx * s;
        p[b + 1] = p[a + 1] + dy * s;
        p[b + 2] = p[a + 2] + dz * s;
      }
    }
  }

  /**
   * A single non-finite node poisons its whole chain within a frame and the
   * strand disappears. Rebuilding that one chain costs microseconds and is
   * invisible; leaving it costs the strand for the rest of the session.
   */
  _guardFinite() {
    const p = this.positions;
    const M = this.nodeCount;
    for (let i = 0; i < this.chainCount; i++) {
      let bad = false;
      for (let j = 1; j < M && !bad; j++) {
        const b = (i * M + j) * 3;
        if (!Number.isFinite(p[b]) || !Number.isFinite(p[b + 1]) || !Number.isFinite(p[b + 2])) bad = true;
      }
      if (bad) this.resetChain(i);
    }
  }
}

/**
 * The retarded-time system, §4.4's fallback. Stateless in the sense that
 * matters: every node position is a closed-form function of time, so it cannot
 * accumulate error, cannot explode at any step size, and resumes correctly
 * after a tab has been asleep for nine hours with no catch-up whatsoever.
 *
 * The lag is measured from the ATTACHMENT POINT, not from the sea surface. The
 * spec writes `tRet = uTime - (-p.y) * 0.55` and glosses it as "0.55 s of lag
 * per unit below the bell"; at a fixed 14 m depth the absolute term is a
 * constant phase offset and only the gradient below the bell produces the
 * travelling wave the line is there for.
 */
export class RetardedChainSystem {
  constructor({
    chainCount = VERLET_CONSTANTS.DEFAULT_CHAIN_COUNT,
    nodeCount = VERLET_CONSTANTS.DEFAULT_NODE_COUNT,
    lengths = VERLET_CONSTANTS.DEFAULT_LENGTH,
    segmentLengths = null,
    phases = null,
    amplitudeScale = 1.0,
    seed = 'aurelia-strands-retarded'
  } = {}) {
    this.chainCount = chainCount | 0;
    this.nodeCount = Math.max(2, nodeCount | 0);
    this.mode = 'retarded';
    this.rng = new Rng(seed);
    this.time = 0;
    this.amplitudeScale = amplitudeScale;

    const n = this.chainCount * this.nodeCount;
    this.positions = new Float32Array(n * 3);
    this.lengths = resolveLengths(lengths, segmentLengths, this.chainCount,
                                  this.nodeCount, VERLET_CONSTANTS.DEFAULT_LENGTH);

    this.phases = new Float32Array(this.chainCount);
    if (phases && phases.length >= this.chainCount) {
      for (let i = 0; i < this.chainCount; i++) this.phases[i] = phases[i];
    } else {
      for (let i = 0; i < this.chainCount; i++) this.phases[i] = this.rng.range(0, Math.PI * 2);
    }

    this.roots = new Float32Array(this.chainCount * 3);
    this._hang = new Float32Array(this.chainCount * 3);
    for (let i = 0; i < this.chainCount; i++) this._hang[i * 3 + 1] = -1;

    this.evaluate();
  }

  setRoot(i, x, y, z) {
    const b = i * 3;
    this.roots[b] = x;
    this.roots[b + 1] = y;
    this.roots[b + 2] = z;
    return this;
  }

  setHang(i, x, y, z) {
    const b = i * 3;
    const l = Math.hypot(x, y, z);
    if (l < 1e-9) return this;
    this._hang[b] = x / l;
    this._hang[b + 1] = y / l;
    this._hang[b + 2] = z / l;
    return this;
  }

  /** No history to shift, but the roots live in scene space and must follow. */
  translate(dx, dy, dz) {
    for (let b = 0; b < this.roots.length; b += 3) {
      this.roots[b] += dx; this.roots[b + 1] += dy; this.roots[b + 2] += dz;
    }
    this.evaluate();
    return this;
  }

  /** Kept for surface compatibility with ChainSystem; there is nothing to reset. */
  reset() {
    this.evaluate();
    return this;
  }

  /** `flow` is accepted and ignored: this path cannot respond to a force. */
  step(dt, flow = null) {
    void flow;
    this.time += clamp(dt, 0, 1);
    this.evaluate();
    return this;
  }

  evaluate() {
    const K = VERLET_CONSTANTS;
    const M = this.nodeCount;
    const p = this.positions;

    for (let i = 0; i < this.chainCount; i++) {
      const rb = i * 3;
      _hangDir[0] = this._hang[rb];
      _hangDir[1] = this._hang[rb + 1];
      _hangDir[2] = this._hang[rb + 2];
      perpendicularBasis(_hangDir, _basisA, _basisB);

      const L = this.lengths[i];
      const phase = this.phases[i];
      const amp = K.RETARDED_AMPLITUDE * L * this.amplitudeScale;
      const seg = L / (M - 1);

      /* The raw curve first: hang plus two out-of-phase lateral waves. */
      for (let j = 0; j < M; j++) {
        const b = (i * M + j) * 3;
        const s = j / (M - 1);
        const arc = s * L;
        const tRet = retardedTime(this.time, arc);
        const env = s * s;
        const swayA = amp * Math.sin(K.RETARDED_WAVENUMBER * s - tRet * K.RETARDED_OMEGA + phase) * env;
        const swayB = amp * 0.62 * Math.sin(
          K.RETARDED_WAVENUMBER * 0.83 * s - tRet * K.RETARDED_OMEGA * 1.19 + phase * 1.7 + 2.1
        ) * env;
        p[b] = this.roots[rb] + _hangDir[0] * arc + _basisA[0] * swayA + _basisB[0] * swayB;
        p[b + 1] = this.roots[rb + 1] + _hangDir[1] * arc + _basisA[1] * swayA + _basisB[1] * swayB;
        p[b + 2] = this.roots[rb + 2] + _hangDir[2] * arc + _basisA[2] * swayA + _basisB[2] * swayB;
      }

      /*
       * Then walk the curve enforcing the segment length. Adding a lateral
       * displacement to a straight line lengthens it, so without this pass the
       * strand visibly stretches as the sway grows — the one artefact that
       * gives an analytic path away as analytic.
       */
      for (let j = 1; j < M; j++) {
        const a = (i * M + j - 1) * 3, b = (i * M + j) * 3;
        let dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-9) { dx = _hangDir[0]; dy = _hangDir[1]; dz = _hangDir[2]; }
        else { const inv = 1 / len; dx *= inv; dy *= inv; dz *= inv; }
        p[b] = p[a] + dx * seg;
        p[b + 1] = p[a + 1] + dy * seg;
        p[b + 2] = p[a + 2] + dz * seg;
      }
    }
  }
}

/**
 * Picks the solver. `mode` is 'verlet' (the primary path) or 'retarded' (tier 4
 * and `prefers-reduced-motion`). Both returned objects satisfy the same
 * contract, so the caller and the vertex packer need no branch.
 */
export function createChainSystem(options = {}) {
  const { mode = 'verlet', ...rest } = options;
  if (mode === 'retarded') {
    return new RetardedChainSystem(rest);
  }
  return new ChainSystem(rest);
}
