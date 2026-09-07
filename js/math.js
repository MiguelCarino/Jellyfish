/* ============================================================
   math.js — vec3 / mat4 / quat / scalars / deterministic PRNG.
   ------------------------------------------------------------
   The foundation module. It has no imports and never will: every
   other file in the renderer depends on it, so a dependency here
   would become a dependency everywhere.

   Two vector APIs ship side by side, deliberately, because the
   project has two very different call sites:

     * `Vec3` — a small class whose arithmetic methods return NEW
       vectors and never mutate the receiver. This is what the
       swim integrator, the camera rig and the body pose use, and
       it is why the spec's own `vel = vel.addScaled(axis, k)`
       idiom in §4.3 reads correctly. Only `set()`, `copyFrom()`,
       `setScalar()` and `zero()` mutate, and they say so.

     * `vec3` / `mat4` / `mat3` / `quat` — free functions over
       plain length-3/16/9/4 arrays with an explicit `out` first
       argument, allocating nothing. The verlet solver runs 40
       chains × 14 nodes × 120 Hz; it cannot afford one object per
       node per substep, so it uses flat Float32Arrays and these.

   Matrices are COLUMN-MAJOR, m[column*4 + row], which is what
   `gl.uniformMatrix4fv(loc, false, m)` expects. Never transpose
   on upload — WebGL2 rejects a true `transpose` argument anyway.

   Coordinate handedness is right-handed with +Y up and the camera
   looking down its own −Z, matching `perspective()`/`lookAt()`
   below. The sea surface is the plane y = 0 and the animal swims
   at y ≈ −14, so every `worldY` passed to `downwelling()` and
   `inscatter()` in the shaders is NEGATIVE. Getting that sign
   backwards produces a black frame, which is the single easiest
   mistake to make in this project.

   Randomness: there is no `Math.random` anywhere in the render
   path. Every stochastic quantity — the baked anatomical
   imperfection, the strand length lognormal, the Poisson beat
   irregularity, the snow placement — comes from a seeded `Rng`
   so that two runs of the same build produce the same animal.
   `hash11` is a float32-faithful port of the GLSL function of
   the same name in shaders/common.js so a value computed on the
   CPU and the same value computed on the GPU agree.
   ============================================================ */

/* --- Scalars --------------------------------------------------------- */

export const EPSILON = 1e-6;
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

export function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

export function saturate(x) {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** GLSL spells it `mix`; both names exist so ported shader code reads unchanged. */
export function mix(a, b, t) {
  return a + (b - a) * t;
}

export function inverseLerp(a, b, v) {
  return a === b ? 0 : (v - a) / (b - a);
}

/** GLSL `smoothstep`: clamped Hermite, not the unclamped cubic. */
export function smoothstep(edge0, edge1, x) {
  const t = saturate(edge0 === edge1 ? (x < edge0 ? 0 : 1) : (x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Quintic variant with zero second derivative at both ends; used by the value noise. */
export function smootherstep(edge0, edge1, x) {
  const t = saturate(edge0 === edge1 ? (x < edge0 ? 0 : 1) : (x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function step(edge, x) {
  return x < edge ? 0 : 1;
}

/** GLSL `fract`: always in [0,1), including for negative input. */
export function fract(x) {
  return x - Math.floor(x);
}

/** GLSL `mod`: takes the sign of y, unlike JavaScript's `%`. */
export function mod(x, y) {
  return x - y * Math.floor(x / y);
}

export function sign(x) {
  return x > 0 ? 1 : (x < 0 ? -1 : 0);
}

export function degToRad(d) {
  return d * DEG_TO_RAD;
}

export function radToDeg(r) {
  return r * RAD_TO_DEG;
}

/** Wrap an angle into (−π, π]. */
export function wrapAngle(a) {
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

/** Shortest signed angular difference from `a` to `b`, in (−π, π]. */
export function angleDelta(a, b) {
  return wrapAngle(b - a);
}

/**
 * Frame-rate independent exponential approach. `tau` is the time constant in
 * seconds: after `tau` the remaining error is 1/e of what it was. Using
 * `current += (target - current) * k` with a constant k instead makes the
 * camera's damping depend on frame rate, which is exactly the sort of thing
 * that makes a tier change visible.
 */
export function damp(current, target, tau, dt) {
  if (!(tau > 0)) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** As `damp`, but takes the short way round the circle. */
export function dampAngle(current, target, tau, dt) {
  return wrapAngle(damp(0, angleDelta(current, target), tau, dt) + current);
}

/**
 * One step of a critically damped spring, discretised implicitly so it is
 * unconditionally stable — a large `dt` after a tab wake-up cannot make it
 * explode, it just lands on the target. `omega` is the natural frequency in
 * rad/s; for the spec's time constants use `omega = 1/tau` (τ = 4 s for the
 * bell axis, τ = 5 s for the look-at).
 *
 * Returns a two-element array [position, velocity]; `Spring1`/`Spring3` wrap
 * this for callers that would rather hold state in an object.
 */
export function springStep(x, v, target, omega, dt) {
  const f = 1 + 2 * omega * dt + omega * omega * dt * dt;
  const vNext = (v + dt * omega * omega * (target - x)) / f;
  return [x + dt * vNext, vNext];
}

/** Scalar critically damped spring with retained velocity. */
export class Spring1 {
  constructor(value = 0, velocity = 0) {
    this.value = value;
    this.velocity = velocity;
  }
  /** `tau` in seconds; step returns the new value for convenience. */
  step(target, tau, dt) {
    const omega = tau > 0 ? 1 / tau : 1e6;
    const r = springStep(this.value, this.velocity, target, omega, dt);
    this.value = r[0];
    this.velocity = r[1];
    return this.value;
  }
  reset(value, velocity = 0) {
    this.value = value;
    this.velocity = velocity;
    return this;
  }
}

/** Vec3 critically damped spring; the camera look-at and bell axis both use it. */
export class Spring3 {
  constructor(value = new Vec3(), velocity = new Vec3()) {
    this.value = value.clone();
    this.velocity = velocity.clone();
  }
  /** `target` is a Vec3; `tau` in seconds. Returns the new value (a live reference). */
  step(target, tau, dt) {
    const omega = tau > 0 ? 1 / tau : 1e6;
    const rx = springStep(this.value.x, this.velocity.x, target.x, omega, dt);
    const ry = springStep(this.value.y, this.velocity.y, target.y, omega, dt);
    const rz = springStep(this.value.z, this.velocity.z, target.z, omega, dt);
    this.value.set(rx[0], ry[0], rz[0]);
    this.velocity.set(rx[1], ry[1], rz[1]);
    return this.value;
  }
  reset(value, velocity = new Vec3()) {
    this.value.copyFrom(value);
    this.velocity.copyFrom(velocity);
    return this;
  }
}

/* --- Vec3, the allocating object API --------------------------------- */

/**
 * Every arithmetic method returns a NEW Vec3. The four mutators are
 * `set`, `copyFrom`, `setScalar` and `zero`, and they return `this`.
 * That split is what lets `pos = pos.addScaled(vel, dt)` be read literally
 * without wondering whether `vel` survived the call.
 */
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static from(o) {
    if (o instanceof Vec3) return new Vec3(o.x, o.y, o.z);
    if (Array.isArray(o) || ArrayBuffer.isView(o)) return new Vec3(o[0], o[1], o[2]);
    return new Vec3(o.x || 0, o.y || 0, o.z || 0);
  }
  static fromArray(a, offset = 0) {
    return new Vec3(a[offset], a[offset + 1], a[offset + 2]);
  }
  static splat(s) { return new Vec3(s, s, s); }
  static get ZERO() { return new Vec3(0, 0, 0); }
  static get UP() { return new Vec3(0, 1, 0); }
  static get DOWN() { return new Vec3(0, -1, 0); }
  static get RIGHT() { return new Vec3(1, 0, 0); }
  static get FORWARD() { return new Vec3(0, 0, -1); }

  /* Mutators. */
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
  copyFrom(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  zero() { this.x = 0; this.y = 0; this.z = 0; return this; }

  /* Non-mutating arithmetic. */
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
  mul(v) { return new Vec3(this.x * v.x, this.y * v.y, this.z * v.z); }
  scale(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
  addScaled(v, s) { return new Vec3(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
  negate() { return new Vec3(-this.x, -this.y, -this.z); }
  cross(v) {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x
    );
  }
  lerp(v, t) {
    return new Vec3(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t);
  }
  min(v) { return new Vec3(Math.min(this.x, v.x), Math.min(this.y, v.y), Math.min(this.z, v.z)); }
  max(v) { return new Vec3(Math.max(this.x, v.x), Math.max(this.y, v.y), Math.max(this.z, v.z)); }
  abs() { return new Vec3(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z)); }
  withY(y) { return new Vec3(this.x, y, this.z); }

  /** Zero-length input returns (0,0,0) rather than NaN — a NaN vertex kills a whole draw. */
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z);
    if (l < EPSILON) return new Vec3(0, 0, 0);
    return new Vec3(this.x / l, this.y / l, this.z / l);
  }
  /** Zero-length input returns `fallback`, for axes that must never be degenerate. */
  normalizeOr(fallback) {
    const l = Math.hypot(this.x, this.y, this.z);
    if (l < EPSILON) return Vec3.from(fallback);
    return new Vec3(this.x / l, this.y / l, this.z / l);
  }
  clampLength(maxLen) {
    const l = Math.hypot(this.x, this.y, this.z);
    if (l <= maxLen || l < EPSILON) return this.clone();
    return this.scale(maxLen / l);
  }
  /** Component of `this` along the unit vector `n`. */
  projectOnto(n) { return n.scale(this.dot(n)); }
  /** Component of `this` perpendicular to the unit vector `n`. */
  rejectFrom(n) { return this.sub(n.scale(this.dot(n))); }
  reflect(n) { return this.sub(n.scale(2 * this.dot(n))); }
  /** Any unit vector perpendicular to `this`; stable for every input direction. */
  perpendicular() {
    const a = Math.abs(this.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
    return this.cross(a).normalizeOr(new Vec3(0, 0, 1));
  }

  /* Scalar reductions. */
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  len() { return Math.hypot(this.x, this.y, this.z); }
  lenSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  distanceSqTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }
  maxComponent() { return Math.max(this.x, this.y, this.z); }
  minComponent() { return Math.min(this.x, this.y, this.z); }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z); }
  equalsApprox(v, eps = 1e-5) {
    return Math.abs(this.x - v.x) < eps && Math.abs(this.y - v.y) < eps && Math.abs(this.z - v.z) < eps;
  }

  /* Interop. */
  toArray(out = [], offset = 0) {
    out[offset] = this.x; out[offset + 1] = this.y; out[offset + 2] = this.z;
    return out;
  }
  toString() { return `Vec3(${this.x}, ${this.y}, ${this.z})`; }
}

/* --- vec3, the allocation-free array API ----------------------------- */

/**
 * Free functions over plain length-3 arrays (`Array`, `Float32Array`,
 * `Float64Array` — anything indexable). Every function takes its destination
 * first and returns it, so calls chain and nothing allocates. Aliasing `out`
 * with an input is safe everywhere here.
 */
export const vec3 = {
  create() { return new Float32Array(3); },
  clone(a) { return new Float32Array([a[0], a[1], a[2]]); },
  set(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; },
  copy(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; },
  zero(out) { out[0] = 0; out[1] = 0; out[2] = 0; return out; },

  add(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; },
  sub(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; },
  mul(out, a, b) { out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2]; return out; },
  scale(out, a, s) { out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out; },
  addScaled(out, a, b, s) {
    out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s; return out;
  },
  negate(out, a) { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; return out; },
  lerp(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  },
  min(out, a, b) {
    out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]); out[2] = Math.min(a[2], b[2]); return out;
  },
  max(out, a, b) {
    out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]); out[2] = Math.max(a[2], b[2]); return out;
  },
  cross(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
  },
  dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
  length(a) { return Math.hypot(a[0], a[1], a[2]); },
  lengthSq(a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; },
  distance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); },
  distanceSq(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  },
  /** Degenerate input yields (0,0,0), never NaN. */
  normalize(out, a) {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l < EPSILON) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    out[0] = a[0] / l; out[1] = a[1] / l; out[2] = a[2] / l;
    return out;
  },
  clampLength(out, a, maxLen) {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l <= maxLen || l < EPSILON) return vec3.copy(out, a);
    return vec3.scale(out, a, maxLen / l);
  },

  /** Full 4×4 transform of a point, including the perspective divide. */
  transformMat4(out, a, m) {
    const x = a[0], y = a[1], z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w === 0) w = 1;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
  },
  /** Rotates/scales by the upper 3×3 only — for normals and directions. */
  transformDirMat4(out, a, m) {
    const x = a[0], y = a[1], z = a[2];
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
    return out;
  },
  transformMat3(out, a, m) {
    const x = a[0], y = a[1], z = a[2];
    out[0] = m[0] * x + m[3] * y + m[6] * z;
    out[1] = m[1] * x + m[4] * y + m[7] * z;
    out[2] = m[2] * x + m[5] * y + m[8] * z;
    return out;
  },
  transformQuat(out, a, q) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const x = a[0], y = a[1], z = a[2];
    // t = 2 * cross(q.xyz, v); out = v + qw * t + cross(q.xyz, t)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + qy * tz - qz * ty;
    out[1] = y + qw * ty + qz * tx - qx * tz;
    out[2] = z + qw * tz + qx * ty - qy * tx;
    return out;
  },

  /* Strided access, for the flat node arrays the verlet solver keeps. */
  getAt(out, arr, index) {
    const i = index * 3;
    out[0] = arr[i]; out[1] = arr[i + 1]; out[2] = arr[i + 2];
    return out;
  },
  setAt(arr, index, a) {
    const i = index * 3;
    arr[i] = a[0]; arr[i + 1] = a[1]; arr[i + 2] = a[2];
    return arr;
  },
  fromVec3(out, v) { out[0] = v.x; out[1] = v.y; out[2] = v.z; return out; },
  toVec3(a) { return new Vec3(a[0], a[1], a[2]); }
};

/* --- mat4 ------------------------------------------------------------- */

/**
 * Column-major 4×4, `m[col*4 + row]`, upload with `transpose = false`.
 * `perspective` and `lookAt` are right-handed with the clip-space depth
 * range [−1, 1] that WebGL uses by default.
 */
export const mat4 = {
  create() {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
  },
  identity(out) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },
  copy(out, a) { for (let i = 0; i < 16; i++) out[i] = a[i]; return out; },
  clone(a) { return new Float32Array(a); },

  /** out = a · b, applying b first then a. Safe to alias out with a or b. */
  multiply(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return out;
  },

  /** `fovy` is the VERTICAL field of view in radians. The spec's 38° lens is the vertical one. */
  perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy * 0.5);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[11] = -1;
    out[12] = 0; out[13] = 0; out[15] = 0;
    if (far !== null && far !== Infinity) {
      const nf = 1 / (near - far);
      out[10] = (far + near) * nf;
      out[14] = 2 * far * near * nf;
    } else {
      out[10] = -1;
      out[14] = -2 * near;
    }
    return out;
  },

  ortho(out, left, right, bottom, top, near, far) {
    const lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
    out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
    out[12] = (left + right) * lr; out[13] = (top + bottom) * bt; out[14] = (far + near) * nf; out[15] = 1;
    return out;
  },

  /**
   * View matrix: world → eye, eye at the origin looking down −Z.
   * `eye`, `center`, `up` are length-3 arrays or Vec3-shaped objects; both
   * are accepted because the camera keeps Vec3s and the shadow pass keeps arrays.
   */
  lookAt(out, eye, center, up) {
    const ex = _c0(eye), ey = _c1(eye), ez = _c2(eye);
    const cx = _c0(center), cy = _c1(center), cz = _c2(center);
    const ux = _c0(up), uy = _c1(up), uz = _c2(up);

    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let len = Math.hypot(zx, zy, zz);
    if (len < EPSILON) return mat4.identity(out);
    zx /= len; zy /= len; zz /= len;

    let xx = uy * zz - uz * zy;
    let xy = uz * zx - ux * zz;
    let xz = ux * zy - uy * zx;
    len = Math.hypot(xx, xy, xz);
    if (len < EPSILON) {
      // `up` is parallel to the view direction; pick any stable orthogonal axis
      // rather than emitting NaNs, which would blank the frame.
      xx = Math.abs(zy) < 0.9 ? (zz) : 1;
      xy = 0;
      xz = Math.abs(zy) < 0.9 ? (-zx) : 0;
      len = Math.hypot(xx, xy, xz) || 1;
    }
    xx /= len; xy /= len; xz /= len;

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * ex + xy * ey + xz * ez);
    out[13] = -(yx * ex + yy * ey + yz * ez);
    out[14] = -(zx * ex + zy * ey + zz * ez);
    out[15] = 1;
    return out;
  },

  /** The inverse of `lookAt`: a world matrix placing an object at `eye` facing `target`. */
  targetTo(out, eye, target, up) {
    const ex = _c0(eye), ey = _c1(eye), ez = _c2(eye);
    let zx = ex - _c0(target), zy = ey - _c1(target), zz = ez - _c2(target);
    let len = Math.hypot(zx, zy, zz);
    if (len < EPSILON) { zx = 0; zy = 0; zz = 1; len = 1; }
    zx /= len; zy /= len; zz /= len;
    const ux = _c0(up), uy = _c1(up), uz = _c2(up);
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    out[0] = xx; out[1] = xy; out[2] = xz; out[3] = 0;
    out[4] = zy * xz - zz * xy; out[5] = zz * xx - zx * xz; out[6] = zx * xy - zy * xx; out[7] = 0;
    out[8] = zx; out[9] = zy; out[10] = zz; out[11] = 0;
    out[12] = ex; out[13] = ey; out[14] = ez; out[15] = 1;
    return out;
  },

  /** Returns `out`, or null if `a` is singular. Callers should treat null as "skip the draw". */
  invert(out, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1.0 / det;

    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },

  transpose(out, a) {
    if (out === a) {
      let t;
      t = a[1]; out[1] = a[4]; out[4] = t;
      t = a[2]; out[2] = a[8]; out[8] = t;
      t = a[3]; out[3] = a[12]; out[12] = t;
      t = a[6]; out[6] = a[9]; out[9] = t;
      t = a[7]; out[7] = a[13]; out[13] = t;
      t = a[11]; out[11] = a[14]; out[14] = t;
      return out;
    }
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r * 4 + c];
    return out;
  },

  fromTranslation(out, v) {
    mat4.identity(out);
    out[12] = _c0(v); out[13] = _c1(v); out[14] = _c2(v);
    return out;
  },
  fromScaling(out, v) {
    mat4.identity(out);
    out[0] = _c0(v); out[5] = _c1(v); out[10] = _c2(v);
    return out;
  },
  fromAxisAngle(out, axis, rad) {
    let x = _c0(axis), y = _c1(axis), z = _c2(axis);
    const len = Math.hypot(x, y, z);
    if (len < EPSILON) return mat4.identity(out);
    x /= len; y /= len; z /= len;
    const s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
    out[0] = x * x * t + c; out[1] = y * x * t + z * s; out[2] = z * x * t - y * s; out[3] = 0;
    out[4] = x * y * t - z * s; out[5] = y * y * t + c; out[6] = z * y * t + x * s; out[7] = 0;
    out[8] = x * z * t + y * s; out[9] = y * z * t - x * s; out[10] = z * z * t + c; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },
  fromQuat(out, q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, yx = y * x2, yy = y * y2;
    const zx = z * x2, zy = z * y2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = 1 - yy - zz; out[1] = yx + wz; out[2] = zx - wy; out[3] = 0;
    out[4] = yx - wz; out[5] = 1 - xx - zz; out[6] = zy + wx; out[7] = 0;
    out[8] = zx + wy; out[9] = zy - wx; out[10] = 1 - xx - yy; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },
  /** Compose in the usual order: scale, then rotate, then translate. */
  fromRotationTranslationScale(out, q, t, s) {
    mat4.fromQuat(out, q);
    const sx = _c0(s), sy = _c1(s), sz = _c2(s);
    out[0] *= sx; out[1] *= sx; out[2] *= sx;
    out[4] *= sy; out[5] *= sy; out[6] *= sy;
    out[8] *= sz; out[9] *= sz; out[10] *= sz;
    out[12] = _c0(t); out[13] = _c1(t); out[14] = _c2(t);
    return out;
  },
  translate(out, a, v) {
    const x = _c0(v), y = _c1(v), z = _c2(v);
    if (out !== a) mat4.copy(out, a);
    out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
    out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
    out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
    out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
    return out;
  },
  scale(out, a, v) {
    const x = _c0(v), y = _c1(v), z = _c2(v);
    for (let i = 0; i < 4; i++) out[i] = a[i] * x;
    for (let i = 4; i < 8; i++) out[i] = a[i] * y;
    for (let i = 8; i < 12; i++) out[i] = a[i] * z;
    for (let i = 12; i < 16; i++) out[i] = a[i];
    return out;
  },
  rotate(out, a, rad, axis) {
    const r = mat4.fromAxisAngle(_tmpMat4, axis, rad);
    return mat4.multiply(out, a, r);
  },
  getTranslation(out, m) { out[0] = m[12]; out[1] = m[13]; out[2] = m[14]; return out; },

  /**
   * Transpose of the inverse of the upper-left 3×3, written into a mat3.
   * Needed whenever a model matrix carries non-uniform scale; the bell's
   * per-lappet contraction gain does exactly that. Returns null if singular.
   */
  normalMatrix(out3, m) {
    return mat3.normalFromMat4(out3, m);
  }
};

const _tmpMat4 = new Float32Array(16);

/* Accept both `Vec3` objects and indexable arrays wherever a point is taken. */
function _c0(v) { return v.x !== undefined ? v.x : v[0]; }
function _c1(v) { return v.y !== undefined ? v.y : v[1]; }
function _c2(v) { return v.z !== undefined ? v.z : v[2]; }

/* --- mat3 ------------------------------------------------------------- */

/** Column-major 3×3, `m[col*3 + row]`; upload with `gl.uniformMatrix3fv`. */
export const mat3 = {
  create() {
    const m = new Float32Array(9);
    m[0] = 1; m[4] = 1; m[8] = 1;
    return m;
  },
  identity(out) {
    out[0] = 1; out[1] = 0; out[2] = 0;
    out[3] = 0; out[4] = 1; out[5] = 0;
    out[6] = 0; out[7] = 0; out[8] = 1;
    return out;
  },
  copy(out, a) { for (let i = 0; i < 9; i++) out[i] = a[i]; return out; },
  fromMat4(out, m) {
    out[0] = m[0]; out[1] = m[1]; out[2] = m[2];
    out[3] = m[4]; out[4] = m[5]; out[5] = m[6];
    out[6] = m[8]; out[7] = m[9]; out[8] = m[10];
    return out;
  },
  multiply(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];
    for (let i = 0; i < 3; i++) {
      const b0 = b[i * 3], b1 = b[i * 3 + 1], b2 = b[i * 3 + 2];
      out[i * 3] = b0 * a00 + b1 * a10 + b2 * a20;
      out[i * 3 + 1] = b0 * a01 + b1 * a11 + b2 * a21;
      out[i * 3 + 2] = b0 * a02 + b1 * a12 + b2 * a22;
    }
    return out;
  },
  transpose(out, a) {
    if (out === a) {
      let t;
      t = a[1]; out[1] = a[3]; out[3] = t;
      t = a[2]; out[2] = a[6]; out[6] = t;
      t = a[5]; out[5] = a[7]; out[7] = t;
      return out;
    }
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 3 + r] = a[r * 3 + c];
    return out;
  },
  invert(out, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (!det) return null;
    det = 1.0 / det;
    out[0] = b01 * det;
    out[1] = (-a22 * a01 + a02 * a21) * det;
    out[2] = (a12 * a01 - a02 * a11) * det;
    out[3] = b11 * det;
    out[4] = (a22 * a00 - a02 * a20) * det;
    out[5] = (-a12 * a00 + a02 * a10) * det;
    out[6] = b21 * det;
    out[7] = (-a21 * a00 + a01 * a20) * det;
    out[8] = (a11 * a00 - a01 * a10) * det;
    return out;
  },
  /** transpose(inverse(upper 3×3 of m)). Returns null if m's linear part is singular. */
  normalFromMat4(out, m) {
    if (!mat3.fromMat4(out, m)) return null;
    if (!mat3.invert(out, out)) return null;
    return mat3.transpose(out, out);
  }
};

/* --- quat ------------------------------------------------------------- */

/** Length-4 arrays laid out [x, y, z, w]; `w` last, matching GLSL's `vec4` convention. */
export const quat = {
  create() { return new Float32Array([0, 0, 0, 1]); },
  identity(out) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; },
  copy(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out; },
  setAxisAngle(out, axis, rad) {
    let x = _c0(axis), y = _c1(axis), z = _c2(axis);
    const len = Math.hypot(x, y, z);
    if (len < EPSILON) return quat.identity(out);
    x /= len; y /= len; z /= len;
    const h = rad * 0.5, s = Math.sin(h);
    out[0] = x * s; out[1] = y * s; out[2] = z * s; out[3] = Math.cos(h);
    return out;
  },
  /** out = a · b: apply b first, then a. */
  multiply(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  },
  normalize(out, a) {
    const l = Math.hypot(a[0], a[1], a[2], a[3]);
    if (l < EPSILON) return quat.identity(out);
    out[0] = a[0] / l; out[1] = a[1] / l; out[2] = a[2] / l; out[3] = a[3] / l;
    return out;
  },
  conjugate(out, a) { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3]; return out; },
  /** Inverse of a unit quaternion is its conjugate; this handles the non-unit case too. */
  invert(out, a) {
    const d = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
    if (d < EPSILON) return quat.identity(out);
    const i = 1 / d;
    out[0] = -a[0] * i; out[1] = -a[1] * i; out[2] = -a[2] * i; out[3] = a[3] * i;
    return out;
  },
  dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; },
  length(a) { return Math.hypot(a[0], a[1], a[2], a[3]); },

  /** Shortest-arc slerp, falling back to nlerp when the endpoints are nearly parallel. */
  slerp(out, a, b, t) {
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cosom = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let s0, s1;
    if (1 - cosom > 1e-6) {
      const omega = Math.acos(cosom), sinom = Math.sin(omega);
      s0 = Math.sin((1 - t) * omega) / sinom;
      s1 = Math.sin(t * omega) / sinom;
    } else {
      s0 = 1 - t;
      s1 = t;
    }
    out[0] = s0 * a[0] + s1 * bx;
    out[1] = s0 * a[1] + s1 * by;
    out[2] = s0 * a[2] + s1 * bz;
    out[3] = s0 * a[3] + s1 * bw;
    return out;
  },

  rotateVec3(out3, q, v) { return vec3.transformQuat(out3, v, q); },

  /**
   * Shortest rotation taking unit vector `from` onto unit vector `to`.
   * This is how the body pose aligns the bell axis with the propulsion
   * direction without ever building Euler angles.
   */
  rotationTo(out, from, to) {
    const fx = _c0(from), fy = _c1(from), fz = _c2(from);
    const tx = _c0(to), ty = _c1(to), tz = _c2(to);
    const d = fx * tx + fy * ty + fz * tz;
    if (d > 0.999999) return quat.identity(out);
    if (d < -0.999999) {
      // Antiparallel: any perpendicular axis gives a valid 180° rotation.
      let ax = -fy, ay = fx, az = 0;
      if (Math.hypot(ax, ay, az) < 1e-6) { ax = 0; ay = -fz; az = fy; }
      return quat.setAxisAngle(out, [ax, ay, az], Math.PI);
    }
    out[0] = fy * tz - fz * ty;
    out[1] = fz * tx - fx * tz;
    out[2] = fx * ty - fy * tx;
    out[3] = 1 + d;
    return quat.normalize(out, out);
  },

  /** Intrinsic X-then-Y-then-Z Euler angles in radians. */
  fromEuler(out, x, y, z) {
    const hx = x * 0.5, hy = y * 0.5, hz = z * 0.5;
    const sx = Math.sin(hx), cx = Math.cos(hx);
    const sy = Math.sin(hy), cy = Math.cos(hy);
    const sz = Math.sin(hz), cz = Math.cos(hz);
    out[0] = sx * cy * cz - cx * sy * sz;
    out[1] = cx * sy * cz + sx * cy * sz;
    out[2] = cx * cy * sz - sx * sy * cz;
    out[3] = cx * cy * cz + sx * sy * sz;
    return out;
  }
};

/* --- Deterministic hashing and pseudo-random numbers ------------------ */

const _f32 = Math.fround;
const _K1031 = _f32(0.1031);
const _K3333 = _f32(33.33);

function _fract32(x) { return _f32(x - Math.floor(x)); }

/**
 * Float32-faithful port of `hash11` in shaders/common.js:
 *
 *   float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; return fract(p*(p+p)); }
 *
 * Every intermediate is rounded to binary32 with `Math.fround` so that the CPU
 * and a highp GPU agree to within the GPU's own rounding of the same ops. This
 * matters because the same per-strand and per-lappet hashes are evaluated on
 * both sides: the vertex shader decorrelates a strand, and the verlet solver
 * must decorrelate the same strand identically or the root will not line up.
 */
export function hash11(p) {
  let q = _fract32(_f32(p * _K1031));
  q = _f32(q * _f32(q + _K3333));
  return _fract32(_f32(q * _f32(q + q)));
}

/** Two-argument variant built on `hash11`; deterministic, no GLSL twin required. */
export function hash21(x, y) {
  return hash11(_f32(x * 127.1 + y * 311.7));
}

/** Three-argument variant; used for baked per-lappet and per-gonad jitter. */
export function hash31(x, y, z) {
  return hash11(_f32(x * 127.1 + y * 311.7 + z * 74.7));
}

/**
 * Mulberry32: 32 bits of state, passes the usual small-PRNG tests, and — the
 * reason it is here — is exactly reproducible across engines because every
 * operation is a 32-bit integer op. Returns a function producing [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes an arbitrary string into a 32-bit seed, so scenes can be named rather than numbered. */
export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * The seeded generator every module should use instead of `Math.random`.
 * Construct one per subsystem with its own seed so that adding a snow particle
 * cannot shift the tentacle lengths — decoupled streams keep the animal stable
 * while the rest of the scene is still being tuned.
 */
export class Rng {
  constructor(seed = 0x1F3D5B7) {
    this.seed = (typeof seed === 'string' ? seedFromString(seed) : seed) >>> 0;
    this._next = mulberry32(this.seed);
    this._spare = null;
  }
  /** Uniform in [0, 1). */
  float() { return this._next(); }
  /** Uniform in [lo, hi). */
  range(lo, hi) { return lo + (hi - lo) * this._next(); }
  /** Uniform integer in [0, n). */
  int(n) { return Math.floor(this._next() * n) % n; }
  /** True with probability p. */
  bool(p = 0.5) { return this._next() < p; }
  /** −1 or +1. */
  sign() { return this._next() < 0.5 ? -1 : 1; }
  /** Box–Muller normal deviate; the spare half is cached so pairs cost one transform. */
  normal(mean = 0, stdDev = 1) {
    if (this._spare !== null) {
      const s = this._spare;
      this._spare = null;
      return mean + stdDev * s;
    }
    let u = this._next();
    if (u < 1e-12) u = 1e-12;
    const v = this._next();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = TAU * v;
    this._spare = r * Math.sin(th);
    return mean + stdDev * r * Math.cos(th);
  }
  /**
   * Log-normal deviate with the given median and log-space sigma. The spec's
   * tentacle length distribution (§3.4, σ = 0.35) is specified this way because
   * a normal distribution on length would produce negative tentacles.
   */
  logNormal(median = 1, sigma = 0.35) {
    return median * Math.exp(this.normal(0, sigma));
  }
  /** Interval between events of a Poisson process of rate `lambda` (events/second). */
  exponential(lambda) {
    let u = this._next();
    if (u < 1e-12) u = 1e-12;
    return -Math.log(u) / lambda;
  }
  /** A uniformly distributed point on the unit sphere, as a Vec3. */
  unitVec3() {
    const z = this.range(-1, 1);
    const t = this.range(0, TAU);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return new Vec3(r * Math.cos(t), z, r * Math.sin(t));
  }
  /** A uniformly distributed point inside the unit sphere, as a Vec3. */
  insideUnitSphere() {
    return this.unitVec3().scale(Math.cbrt(this._next()));
  }
  pick(arr) { return arr[this.int(arr.length)]; }
  /** In-place Fisher–Yates. Returns the same array. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** Restart the stream; useful for regenerating geometry after a context loss. */
  reset(seed = this.seed) {
    this.seed = (typeof seed === 'string' ? seedFromString(seed) : seed) >>> 0;
    this._next = mulberry32(this.seed);
    this._spare = null;
    return this;
  }
}

/**
 * One step of an Ornstein–Uhlenbeck process — mean-reverting noise, which is
 * what the spec's ±6 %-per-beat period jitter (§4.1) is. A random walk would
 * drift away from the base period over an eight-hour soak; OU cannot.
 *
 * `x` current value, `mean` the value it reverts to, `tau` the reversion time
 * constant in seconds, `sigma` the stationary standard deviation, `dt` the
 * step in seconds, `rng` an `Rng`.
 */
export function ouStep(x, mean, tau, sigma, dt, rng) {
  const k = Math.exp(-dt / Math.max(tau, 1e-6));
  const noiseScale = sigma * Math.sqrt(Math.max(0, 1 - k * k));
  return mean + (x - mean) * k + noiseScale * rng.normal();
}
