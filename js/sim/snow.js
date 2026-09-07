/* ============================================================
   snow.js — marine snow, in three strata, plus the bokeh disc.
   ------------------------------------------------------------
   Spec §5.4. Three depth strata, Poisson-clustered rather than
   uniform, sinking slowly, jittering, and advected by the same
   u(x,t) the tentacles feel — so a passing vortex ring visibly
   disturbs the particulate around the animal instead of the
   snow and the strands living in two unrelated worlds.

     far   12–25 m   900 motes   heavily fogged, texture on the veil
     mid    4–12 m   420 motes   the parallax reference
     near  0.4–2.5 m  60 motes   pre-blurred bokeh; these sell the shot

   Far and mid draw in pass 2, near in pass 6, so the animal is
   genuinely sandwiched in the particulate rather than pasted
   over it. Far is the ONLY stratum the performance ladder may
   cut (§7): near is the strongest "this is a camera in water"
   cue in the frame and is never reduced.

   THE BOKEH DISC IS WHY THERE IS NO DOF PASS. §5.4 and §6 make
   the near stratum's sprite texture BE the defocus: a
   pre-generated 64² disc with a soft edge and a faint outer
   ring. An 88-pixel circle of confusion that would be ruinous to
   gather is one textured quad, and the depth-of-field pass is
   deleted from the renderer outright.

   COST DISCIPLINE. 1 380 motes cannot each evaluate curl noise
   every frame — that is eighteen fbm calls apiece. Each mote's
   ambient velocity is instead refreshed on a round robin about
   once a second, which is fast against a current whose features
   are metres across, and its Brownian jitter is stepped on the
   same visit (the Ornstein-Uhlenbeck step is exact at any
   interval, so a one-second step is not an approximation). Only
   the analytic jet and ring terms — the ones with centimetre
   structure — are evaluated every frame, and only for the motes
   actually near the animal.

   RESPAWNING WITHOUT POPPING. Motes are held in a spherical band
   around the camera and faded to zero at both edges of that
   band, so a mote is always invisible by the time it leaves.
   Re-entry is placed exactly on the opposite edge, where the
   fade is likewise zero. A respawned mote also lands near
   another live mote most of the time, which is what keeps the
   clustering alive over an eight-hour session instead of
   annealing into a uniform field.
   ============================================================ */

import { vec3, Rng, ouStep, clamp, smoothstep, TAU } from '../math.js';

/** Floats per mote in the packed instance array. Two vec4 attributes. */
export const SNOW_STRIDE = 8;

/**
 * Layout of one mote in `stratum.data`:
 *   0,1,2  position, scene metres
 *   3      world radius, metres (the shader turns this and z into a CoC)
 *   4      brightness, 0..1
 *   5      fade, 0..1 — band edges and respawn are already folded in
 *   6      twinkle phase, radians
 *   7      tumble angle, radians
 */
export const SNOW_FIELDS = Object.freeze({
  POSITION: 0, RADIUS: 3, BRIGHTNESS: 4, FADE: 5, PHASE: 6, TUMBLE: 7
});

export const SNOW_CONSTANTS = Object.freeze({
  /*
   * §5.4's counts are per SHELL, and _generateStratum seeds directions with
   * rng.unitVec3() over the whole sphere -- but a 38 degree lens at 1.7:1 sees
   * 0.72 sr, which is 5.7 % of 4*pi. The shipped table therefore put about 52
   * far motes, 24 mid and THREE near ones on screen, and the stratum §5.4 calls
   * the strongest "this is a camera in water" cue in the frame was three discs.
   * The counts below are the same table divided by that solid-angle fraction
   * for the two strata the ladder never touches; `far` is left alone, because
   * each far mote is a fraction of a per cent of contrast by the flux law and
   * §7's ladder rows (900/450/200/0) are keyed to that number.
   */
  STRATA: Object.freeze({
    far: Object.freeze({ count: 900, near: 12.0, far: 25.0, radius: [0.0004, 0.0018], brightness: [0.30, 0.80] }),
    mid: Object.freeze({ count: 6000, near: 4.0, far: 12.0, radius: [0.0005, 0.0025], brightness: [0.40, 0.95] }),
    near: Object.freeze({ count: 4000, near: 0.4, far: 2.5, radius: [0.0012, 0.0060], brightness: [0.45, 1.00] })
  }),

  /** §5.4: 0.9 cm/s sink. */
  SINK_SPEED: 0.009,
  /** Brownian jitter as a mean-reverting velocity, so it cannot random-walk away. */
  BROWNIAN_SIGMA: 0.004,
  BROWNIAN_TAU: 2.0,
  /** How often each mote's ambient current is re-evaluated, in seconds. */
  AMBIENT_REFRESH: 1.1,

  /** Fraction of a band's thickness spent fading in and out at each edge. */
  BAND_FADE: 0.12,
  /** Fraction of respawns placed beside an existing mote, preserving clustering. */
  CLUSTER_RESPAWN_FRACTION: 0.65,
  /** Angular spread of a respawn placed beside a neighbour, radians. */
  CLUSTER_RESPAWN_SIGMA: 0.10,

  /** Generation: motes per cluster seed, and the uniformly scattered remainder. */
  CLUSTER_SIZE: 22,
  CLUSTER_BACKGROUND: 0.30,
  CLUSTER_ANGULAR_SIGMA: 0.13,
  CLUSTER_RADIAL_SIGMA: 0.10,

  /**
   * Radius around the aperture within which the jet and ring terms are worth
   * evaluating per mote. Must match FLOW_CONSTANTS.DISTURBANCE_RADIUS; it is
   * duplicated rather than imported so that snow.js does not depend on flow.js
   * merely to read one number, and is asserted equal by the caller if it cares.
   */
  DISTURBANCE_RADIUS: 1.6,

  /** §5.4: one large piece of detritus tumbles through frame roughly this often. */
  DETRITUS_RATE: 1 / 90,
  DETRITUS_RADIUS: [0.020, 0.050],
  DETRITUS_SPAWN_DISTANCE: [5.5, 8.5],
  DETRITUS_BAND: [3.0, 11.0],
  DETRITUS_MAX_AGE: 150,

  /** Pre-generated bokeh sprite, §5.4/§6. */
  BOKEH_SIZE: 64,
  /** Where the disc's edge falls, as a fraction of the sprite's half-width. */
  BOKEH_EDGE: 0.88,
  BOKEH_SOFTNESS: 0.13,
  /** A real defocused highlight is very slightly edge-brightened. Keep it faint. */
  BOKEH_RING_GAIN: 0.24,
  BOKEH_RING_WIDTH: 0.055
});

const _vel = vec3.create();
const _dist = vec3.create();

/* Memoised so a context-loss rebuild does not regenerate the sprite. */
const _bokehCache = new Map();

/**
 * The near stratum's sprite: a soft-edged disc with a faint outer ring, as one
 * channel of 8-bit coverage. Upload as R8, LINEAR, CLAMP_TO_EDGE.
 *
 * This texture IS the depth of field. Nothing gathers, nothing blurs; the
 * defocus is baked into the shape of the sprite and scaled by the real circle
 * of confusion the snow vertex shader computes.
 */
export function generateBokehDisc(size = SNOW_CONSTANTS.BOKEH_SIZE) {
  const key = size | 0;
  const cached = _bokehCache.get(key);
  if (cached) return cached;

  const K = SNOW_CONSTANTS;
  const out = new Uint8Array(key * key);
  const half = (key - 1) * 0.5;
  for (let y = 0; y < key; y++) {
    for (let x = 0; x < key; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const r = Math.hypot(dx, dy);
      const disc = 1 - smoothstep(K.BOKEH_EDGE, K.BOKEH_EDGE + K.BOKEH_SOFTNESS, r);
      const d = (r - K.BOKEH_EDGE) / K.BOKEH_RING_WIDTH;
      const ring = K.BOKEH_RING_GAIN * Math.exp(-d * d) * disc;
      out[y * key + x] = Math.round(clamp(disc * 0.86 + ring, 0, 1) * 255);
    }
  }
  _bokehCache.set(key, out);
  return out;
}

/** Uniform-in-volume radius inside a spherical shell. */
function shellRadius(rng, rMin, rMax) {
  const a = rMin * rMin * rMin;
  const b = rMax * rMax * rMax;
  return Math.cbrt(a + rng.float() * (b - a));
}

/** One stratum's storage. Positions live inside `data`, so `data` uploads directly. */
class Stratum {
  constructor(name, spec, extraSlots, seed) {
    this.name = name;
    this.spec = spec;
    this.count = spec.count + extraSlots;
    this.activeCount = this.count;
    this.data = new Float32Array(this.count * SNOW_STRIDE);
    this.ambient = new Float32Array(this.count * 3);
    this.brownian = new Float32Array(this.count * 3);
    /* Its own stream: adding a far mote must not shift the near ones. */
    this.rng = new Rng(seed);
    this.cursor = 0;
    this.bandFade = (spec.far - spec.near) * SNOW_CONSTANTS.BAND_FADE;
  }
}

/**
 * The whole particulate field. Construct once, `step()` once per frame, upload
 * `far.data`, `mid.data` and `near.data` as instance buffers.
 */
export class SnowField {
  constructor({ seed = 'aurelia-snow', cameraPosition = null } = {}) {
    this.rng = new Rng(seed);
    this.time = 0;

    const cam = cameraPosition
      ? [cameraPosition.x || 0, cameraPosition.y || 0, cameraPosition.z || 0]
      : [0, 0, 0];
    this._camera = cam;

    const S = SNOW_CONSTANTS.STRATA;
    /*
     * The mid stratum carries one extra slot for the drifting detritus (§5.4).
     * It lives there rather than in its own draw call so the renderer never has
     * to special-case a single instance; when it is inactive its fade is zero.
     */
    this.far = new Stratum('far', S.far, 0, seed + ':far');
    this.mid = new Stratum('mid', S.mid, 1, seed + ':mid');
    this.near = new Stratum('near', S.near, 0, seed + ':near');
    this.strata = [this.far, this.mid, this.near];
    this.detritusIndex = S.mid.count;

    this.detritus = {
      active: false,
      age: 0,
      spinX: 0, spinY: 0,
      driftX: 0, driftY: 0, driftZ: 0
    };
    this._detritusTimer = this.rng.exponential(SNOW_CONSTANTS.DETRITUS_RATE);

    this.generate();
  }

  /** Rebuild every mote from the seed. Boot, and after a context restore. */
  generate() {
    this.rng.reset();
    for (const st of this.strata) { st.rng.reset(); this._generateStratum(st); }
    this.detritus.active = false;
    this.detritus.age = 0;
    this._detritusTimer = this.rng.exponential(SNOW_CONSTANTS.DETRITUS_RATE);
    this._writeDetritus();
    return this;
  }

  /** Alias of `generate()`, for symmetry with the other sim modules. */
  reset() {
    this.time = 0;
    return this.generate();
  }

  /**
   * §7: far is the only stratum the ladder is allowed to cut. Motes were
   * shuffled at generation precisely so that any prefix is a fair spatial
   * sample — cutting the tail must thin the field, never delete a region of it.
   */
  setFarCount(n) {
    this.far.activeCount = clamp(n | 0, 0, this.far.count);
    return this;
  }

  /** Floating-origin rebase (§4.3): every mote is a scene-space position. */
  translate(dx, dy, dz) {
    for (const st of this.strata) {
      const d = st.data;
      for (let b = 0; b < d.length; b += SNOW_STRIDE) {
        d[b] += dx; d[b + 1] += dy; d[b + 2] += dz;
      }
    }
    return this;
  }

  /**
   * One frame. `cameraPosition` is a Vec3 or any {x,y,z}; the strata are bands
   * around it. `flow` is a FlowField, or null for still water.
   */
  step(dt, cameraPosition, flow = null) {
    const h = clamp(dt, 0, 0.5);
    this.time += h;
    if (cameraPosition) {
      this._camera[0] = cameraPosition.x;
      this._camera[1] = cameraPosition.y;
      this._camera[2] = cameraPosition.z;
    }
    if (h <= 0) return this;

    for (const st of this.strata) this._stepStratum(st, h, flow);
    this._stepDetritus(h, flow);
    return this;
  }

  /* --- Generation ------------------------------------------------------- */

  /**
   * A Thomas process: cluster seeds scattered uniformly over the shell, most
   * motes drawn around a seed, the rest uniform. Uniform snow reads as a
   * particle system; real particulate arrives in drifts.
   */
  _generateStratum(st) {
    const K = SNOW_CONSTANTS;
    const rng = st.rng;
    const live = st.spec.count;
    const clusterCount = Math.max(4, Math.round(live / K.CLUSTER_SIZE));

    const seedDir = new Float32Array(clusterCount * 3);
    const seedRadius = new Float32Array(clusterCount);
    for (let c = 0; c < clusterCount; c++) {
      const d = rng.unitVec3();
      seedDir[c * 3] = d.x; seedDir[c * 3 + 1] = d.y; seedDir[c * 3 + 2] = d.z;
      seedRadius[c] = shellRadius(rng, st.spec.near, st.spec.far);
    }

    /*
     * Membership is assigned and then shuffled, so that taking the first N
     * motes (which is what setFarCount does) takes a fair sample of clusters
     * rather than whole clusters in generation order.
     */
    const membership = new Array(live);
    for (let i = 0; i < live; i++) {
      membership[i] = rng.float() < K.CLUSTER_BACKGROUND ? -1 : rng.int(clusterCount);
    }
    rng.shuffle(membership);

    for (let i = 0; i < live; i++) {
      const c = membership[i];
      let dx, dy, dz, r;
      if (c < 0) {
        const d = rng.unitVec3();
        dx = d.x; dy = d.y; dz = d.z;
        r = shellRadius(rng, st.spec.near, st.spec.far);
      } else {
        const s = c * 3;
        dx = seedDir[s] + rng.normal(0, K.CLUSTER_ANGULAR_SIGMA);
        dy = seedDir[s + 1] + rng.normal(0, K.CLUSTER_ANGULAR_SIGMA);
        dz = seedDir[s + 2] + rng.normal(0, K.CLUSTER_ANGULAR_SIGMA);
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l; dy /= l; dz /= l;
        const spread = (st.spec.far - st.spec.near) * K.CLUSTER_RADIAL_SIGMA;
        r = clamp(seedRadius[c] + rng.normal(0, spread), st.spec.near, st.spec.far);
      }

      const b = i * SNOW_STRIDE;
      st.data[b] = this._camera[0] + dx * r;
      st.data[b + 1] = this._camera[1] + dy * r;
      st.data[b + 2] = this._camera[2] + dz * r;
      st.data[b + 3] = rng.range(st.spec.radius[0], st.spec.radius[1]);
      st.data[b + 4] = rng.range(st.spec.brightness[0], st.spec.brightness[1]);
      st.data[b + 5] = 1;
      st.data[b + 6] = rng.range(0, TAU);
      st.data[b + 7] = rng.range(0, TAU);

      const a = i * 3;
      st.ambient[a] = 0; st.ambient[a + 1] = 0; st.ambient[a + 2] = 0;
      st.brownian[a] = 0; st.brownian[a + 1] = 0; st.brownian[a + 2] = 0;
    }

    /* Any extra slots (the detritus) start inert. */
    for (let i = live; i < st.count; i++) {
      const b = i * SNOW_STRIDE;
      st.data[b] = this._camera[0];
      st.data[b + 1] = this._camera[1];
      st.data[b + 2] = this._camera[2];
      st.data[b + 3] = 0;
      st.data[b + 4] = 0;
      st.data[b + 5] = 0;
      st.data[b + 6] = 0;
      st.data[b + 7] = 0;
    }

    st.cursor = 0;
    this._refadeStratum(st);
  }

  /* --- Per-frame update ------------------------------------------------- */

  _stepStratum(st, dt, flow) {
    const K = SNOW_CONSTANTS;
    const live = st.spec.count;
    if (live === 0) return;

    /* Round-robin refresh of the expensive terms. */
    if (flow) {
      const wanted = Math.min(live, Math.ceil(live * dt / K.AMBIENT_REFRESH));
      for (let k = 0; k < wanted; k++) {
        const i = st.cursor % live;
        st.cursor = (st.cursor + 1) % live;
        const b = i * SNOW_STRIDE, a = i * 3;
        flow.sampleAmbient(_vel, st.data[b], st.data[b + 1], st.data[b + 2]);
        st.ambient[a] = _vel[0];
        st.ambient[a + 1] = _vel[1];
        st.ambient[a + 2] = _vel[2];
        st.brownian[a] = ouStep(st.brownian[a], 0, K.BROWNIAN_TAU, K.BROWNIAN_SIGMA, K.AMBIENT_REFRESH, st.rng);
        st.brownian[a + 1] = ouStep(st.brownian[a + 1], 0, K.BROWNIAN_TAU, K.BROWNIAN_SIGMA, K.AMBIENT_REFRESH, st.rng);
        st.brownian[a + 2] = ouStep(st.brownian[a + 2], 0, K.BROWNIAN_TAU, K.BROWNIAN_SIGMA, K.AMBIENT_REFRESH, st.rng);
      }
    }

    const d = st.data;
    const camX = this._camera[0], camY = this._camera[1], camZ = this._camera[2];
    const rMin = st.spec.near, rMax = st.spec.far, w = st.bandFade;

    const useDisturbance = !!flow;
    const drSq = K.DISTURBANCE_RADIUS * K.DISTURBANCE_RADIUS;
    const frameX = flow ? flow.frameVelocity[0] : 0;
    const frameY = flow ? flow.frameVelocity[1] : 0;
    const frameZ = flow ? flow.frameVelocity[2] : 0;
    const shearGain = flow ? flow.shearGain : 1;

    for (let i = 0; i < live; i++) {
      const b = i * SNOW_STRIDE, a = i * 3;
      /*
       * The cached ambient is the RAW current. The frame velocity is subtracted
       * and the spectral gain applied HERE rather than at cache time, because
       * the cache is up to a second old and the frame velocity is not. Without
       * the subtraction the whole snow field streaks across the frame at the
       * bulk current speed while the animal, which the camera follows, stands
       * still — see flow.js's header for both terms.
       */
      let vx = (st.ambient[a] - frameX) * shearGain + st.brownian[a];
      let vy = (st.ambient[a + 1] - frameY) * shearGain + st.brownian[a + 1] - K.SINK_SPEED;
      let vz = (st.ambient[a + 2] - frameZ) * shearGain + st.brownian[a + 2];

      /*
       * The jet and the rings are only worth evaluating near the animal, which
       * is where they have any magnitude at all. This test skips well over 90 %
       * of the motes every frame and is what makes per-frame disturbance
       * affordable for 1 380 particles.
       */
      if (useDisturbance) {
        const ax = d[b] - flow.aperture[0];
        const ay = d[b + 1] - flow.aperture[1];
        const az = d[b + 2] - flow.aperture[2];
        if (ax * ax + ay * ay + az * az < drSq) {
          flow.sampleDisturbance(_dist, d[b], d[b + 1], d[b + 2]);
          vx += _dist[0]; vy += _dist[1]; vz += _dist[2];
        }
      }

      d[b] += vx * dt;
      d[b + 1] += vy * dt;
      d[b + 2] += vz * dt;

      const ex = d[b] - camX, ey = d[b + 1] - camY, ez = d[b + 2] - camZ;
      const r = Math.hypot(ex, ey, ez);
      if (r < rMin || r > rMax) {
        this._respawn(st, i, r < rMin ? rMax : rMin);
        continue;
      }
      d[b + 5] = smoothstep(rMin, rMin + w, r) * (1 - smoothstep(rMax - w, rMax, r));
    }
  }

  /**
   * Places mote `i` back on the given edge of the band, where the band fade is
   * already zero, so a respawn can never be seen. Most respawns land beside a
   * live neighbour, which keeps the drifts and gaps of the original Poisson
   * clustering alive instead of letting the field anneal uniform over hours.
   */
  _respawn(st, i, edgeRadius) {
    const K = SNOW_CONSTANTS;
    const rng = st.rng;
    const live = st.spec.count;
    const b = i * SNOW_STRIDE;

    let dx, dy, dz;
    if (live > 1 && rng.float() < K.CLUSTER_RESPAWN_FRACTION) {
      let j = rng.int(live);
      if (j === i) j = (j + 1) % live;
      const nb = j * SNOW_STRIDE;
      dx = st.data[nb] - this._camera[0];
      dy = st.data[nb + 1] - this._camera[1];
      dz = st.data[nb + 2] - this._camera[2];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-6) { const u = rng.unitVec3(); dx = u.x; dy = u.y; dz = u.z; }
      else { dx /= l; dy /= l; dz /= l; }
      dx += rng.normal(0, K.CLUSTER_RESPAWN_SIGMA);
      dy += rng.normal(0, K.CLUSTER_RESPAWN_SIGMA);
      dz += rng.normal(0, K.CLUSTER_RESPAWN_SIGMA);
    } else {
      const u = rng.unitVec3();
      dx = u.x; dy = u.y; dz = u.z;
    }
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;

    /* Nudge just inside the edge so the fade evaluates to (almost) exactly zero. */
    const inward = edgeRadius === st.spec.near ? 1 : -1;
    const r = edgeRadius + inward * 1e-3;

    st.data[b] = this._camera[0] + dx * r;
    st.data[b + 1] = this._camera[1] + dy * r;
    st.data[b + 2] = this._camera[2] + dz * r;
    st.data[b + 3] = rng.range(st.spec.radius[0], st.spec.radius[1]);
    st.data[b + 4] = rng.range(st.spec.brightness[0], st.spec.brightness[1]);
    st.data[b + 5] = 0;
    st.data[b + 6] = rng.range(0, TAU);

    const a = i * 3;
    st.brownian[a] = 0; st.brownian[a + 1] = 0; st.brownian[a + 2] = 0;
  }

  /** Recomputes every fade from scratch, after a generate or a camera jump. */
  _refadeStratum(st) {
    const d = st.data;
    const rMin = st.spec.near, rMax = st.spec.far, w = st.bandFade;
    for (let i = 0; i < st.spec.count; i++) {
      const b = i * SNOW_STRIDE;
      const r = Math.hypot(
        d[b] - this._camera[0],
        d[b + 1] - this._camera[1],
        d[b + 2] - this._camera[2]
      );
      d[b + 5] = smoothstep(rMin, rMin + w, r) * (1 - smoothstep(rMax - w, rMax, r));
    }
  }

  /* --- The one large piece of detritus, §5.4 ---------------------------- */

  _stepDetritus(dt, flow) {
    const K = SNOW_CONSTANTS;
    const det = this.detritus;

    if (!det.active) {
      this._detritusTimer -= dt;
      if (this._detritusTimer <= 0) {
        this._spawnDetritus();
        this._detritusTimer = this.rng.exponential(K.DETRITUS_RATE);
      }
      this._writeDetritus();
      return;
    }

    const b = this.detritusIndex * SNOW_STRIDE;
    const d = this.mid.data;
    det.age += dt;

    let vx = det.driftX, vy = det.driftY, vz = det.driftZ;
    if (flow) {
      flow.sampleAmbient(_vel, d[b], d[b + 1], d[b + 2]);
      vx += (_vel[0] - flow.frameVelocity[0]) * flow.shearGain;
      vy += (_vel[1] - flow.frameVelocity[1]) * flow.shearGain;
      vz += (_vel[2] - flow.frameVelocity[2]) * flow.shearGain;
      const ax = d[b] - flow.aperture[0];
      const ay = d[b + 1] - flow.aperture[1];
      const az = d[b + 2] - flow.aperture[2];
      const detRadius = K.DISTURBANCE_RADIUS * 1.25;
      if (ax * ax + ay * ay + az * az < detRadius * detRadius) {
        flow.sampleDisturbance(_dist, d[b], d[b + 1], d[b + 2]);
        vx += _dist[0]; vy += _dist[1]; vz += _dist[2];
      }
    }
    /* Heavier than a mote, so it falls noticeably faster. */
    vy -= K.SINK_SPEED * 3.0;

    d[b] += vx * dt;
    d[b + 1] += vy * dt;
    d[b + 2] += vz * dt;
    d[b + 6] += det.spinX * dt;
    d[b + 7] += det.spinY * dt;

    const r = Math.hypot(
      d[b] - this._camera[0],
      d[b + 1] - this._camera[1],
      d[b + 2] - this._camera[2]
    );
    const lo = K.DETRITUS_BAND[0], hi = K.DETRITUS_BAND[1];
    const w = (hi - lo) * 0.18;
    d[b + 5] = smoothstep(lo, lo + w, r) * (1 - smoothstep(hi - w, hi, r));

    if (r < lo || r > hi || det.age > K.DETRITUS_MAX_AGE) {
      det.active = false;
      d[b + 5] = 0;
    }
  }

  _spawnDetritus() {
    const K = SNOW_CONSTANTS;
    const rng = this.rng;
    const det = this.detritus;
    const dir = rng.unitVec3();
    const r = rng.range(K.DETRITUS_SPAWN_DISTANCE[0], K.DETRITUS_SPAWN_DISTANCE[1]);
    const b = this.detritusIndex * SNOW_STRIDE;
    const d = this.mid.data;

    d[b] = this._camera[0] + dir.x * r;
    d[b + 1] = this._camera[1] + dir.y * r;
    d[b + 2] = this._camera[2] + dir.z * r;
    d[b + 3] = rng.range(K.DETRITUS_RADIUS[0], K.DETRITUS_RADIUS[1]);
    d[b + 4] = rng.range(0.40, 0.70);
    d[b + 5] = 0;
    d[b + 6] = rng.range(0, TAU);
    d[b + 7] = rng.range(0, TAU);

    /* A slow lateral drift so it crosses the frame rather than merely sinking. */
    const lateral = rng.unitVec3();
    det.driftX = lateral.x * 0.010;
    det.driftY = lateral.y * 0.004;
    det.driftZ = lateral.z * 0.010;
    det.spinX = rng.range(-0.35, 0.35);
    det.spinY = rng.range(-0.20, 0.20);
    det.age = 0;
    det.active = true;
  }

  _writeDetritus() {
    if (this.detritus.active) return;
    const b = this.detritusIndex * SNOW_STRIDE;
    this.mid.data[b + 5] = 0;
  }
}
