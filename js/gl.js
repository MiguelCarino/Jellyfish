/* ============================================================
   gl.js — the only file in the project that names a WebGL enum.
   ------------------------------------------------------------
   Everything above this file — the eight-pass frame graph, the
   target allocator, the quality ladder, every shader binding —
   talks in strings and small descriptor objects: 'RGBA16F',
   'premultiplied', 'back', 'triangles'. Nothing outside gl.js
   ever writes `gl.ONE_MINUS_SRC_ALPHA`. That is not a style
   preference. A renderer with eight passes and four blend
   configurations leaks state between passes the moment two files
   are both allowed to set it, and the resulting bug looks like a
   shading error rather than a state error, so it costs a day.
   One state cache, one owner, one place to look.

   What lives here:
     * context creation with the exact attributes the spec fixes
     * the capability probe the boot sequence branches on
     * program compile/link with an annotated error dump that
       prints the offending source lines, numbered, in context
     * uniform introspection and type-correct setters, so a caller
       never has to remember that a sampler needs uniform1i
     * texture / renderbuffer / framebuffer / buffer / VAO helpers
     * the fullscreen triangle used by SEA -> FINAL and by post
     * a cached state setter for blend, depth, cull and viewport
     * an EXT_disjoint_timer_query_webgl2 wrapper for the ladder
     * a resource registry so context loss tears down completely

   Context-loss discipline: every object returned from here has a
   `dispose()` that is safe to call on a lost context and safe to
   call twice. `GLObjectRegistry` holds them in creation order and
   disposes in reverse, which matters because a framebuffer must
   go before the textures it references or some drivers log.
   ============================================================ */

/* --- Context ---------------------------------------------------------- */

/**
 * Spec §1, exactly. Each attribute is load-bearing:
 *   antialias:false            — MSAA on the default framebuffer would apply
 *                                to the composite blit only, where there is
 *                                nothing left to antialias; FINAL is where
 *                                MSAA goes, if the probe allows it at all.
 *   alpha:false                — an opaque canvas lets the compositor skip a
 *                                blend for every pixel of a full-screen page.
 *   depth:false, stencil:false — the default framebuffer never depth-tests;
 *                                depth lives on SEA's own attachment.
 *   preserveDrawingBuffer:false— preserving it forces a copy per frame.
 *   powerPreference:'default'  — forcing the discrete GPU on a page left open
 *                                for fifteen hours is a thermal and battery
 *                                bug, and the fans are a relaxation constraint.
 */
export const CONTEXT_ATTRIBUTES = Object.freeze({
  antialias: false,
  alpha: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'default',
  desynchronized: false,
  failIfMajorPerformanceCaveat: false
});

/**
 * Returns a WebGL2RenderingContext, or null when the browser has no WebGL2 at
 * all — in which case the caller shows the poster frame and stops. Never
 * throws: a missing context is an expected outcome, not an error.
 */
export function createContext(canvas, overrides = null) {
  const attrs = overrides ? Object.assign({}, CONTEXT_ATTRIBUTES, overrides) : CONTEXT_ATTRIBUTES;
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', attrs);
  } catch (e) {
    gl = null;
  }
  return gl || null;
}

/**
 * Wires the two context-loss events and returns an unwire function.
 * `preventDefault()` on the loss event is mandatory — without it the browser
 * will never fire `webglcontextrestored`, and macOS resets the GPU on sleep,
 * which this page will do every night.
 */
export function addContextLossHandlers(canvas, { onLost, onRestored } = {}) {
  const lost = (e) => {
    e.preventDefault();
    if (onLost) onLost(e);
  };
  const restored = (e) => {
    if (onRestored) onRestored(e);
  };
  canvas.addEventListener('webglcontextlost', lost, false);
  canvas.addEventListener('webglcontextrestored', restored, false);
  return function unwire() {
    canvas.removeEventListener('webglcontextlost', lost, false);
    canvas.removeEventListener('webglcontextrestored', restored, false);
  };
}

/* --- Capability probe -------------------------------------------------- */

/**
 * Runs the boot probe from spec §7 and returns a plain, JSON-loggable object.
 * Extensions are requested here and only here; `getExtension` must be called
 * before a float target is allocated or Safari will reject the allocation, and
 * calling it repeatedly is a needless per-frame cost.
 */
export function probeCapabilities(gl) {
  const colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
  const colorBufferHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float');
  const floatLinear = !!gl.getExtension('OES_texture_float_linear');
  const timerQuery = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
  const loseContext = gl.getExtension('WEBGL_lose_context');
  const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');
  const debugRenderer = gl.getExtension('WEBGL_debug_renderer_info');

  // Can we render to a 16-bit float colour attachment at all? Either extension
  // grants it in WebGL2; without both, the RGBA8 + analytic-thickness path runs.
  const floatTargets = colorBufferFloat || colorBufferHalfFloat;

  // MSAA is a probe-gated bonus, never load-bearing. Safari raises INVALID_ENUM
  // here for a format it cannot renderbuffer, so the query is guarded rather
  // than trusted.
  let maxSamplesRGBA16F = 0;
  if (floatTargets) {
    try {
      const s = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES);
      if (s && s.length) maxSamplesRGBA16F = s[0] | 0;
    } catch (e) {
      maxSamplesRGBA16F = 0;
    }
  }
  let maxSamplesRGBA8 = 0;
  try {
    const s = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES);
    if (s && s.length) maxSamplesRGBA8 = s[0] | 0;
  } catch (e) {
    maxSamplesRGBA8 = 0;
  }

  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
  const platform = (typeof navigator !== 'undefined' && navigator.platform) ? navigator.platform : '';
  const maxTouch = (typeof navigator !== 'undefined' && navigator.maxTouchPoints) ? navigator.maxTouchPoints : 0;
  // iPadOS reports itself as a Mac; the touch-point count is the only reliable tell.
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && maxTouch > 1);
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  const isFirefox = /firefox|fxios/i.test(ua);

  return {
    colorBufferFloat,
    colorBufferHalfFloat,
    floatTargets,
    /** LINEAR filtering of 32-bit float textures. 16F is linear-filterable in core WebGL2. */
    floatLinear,
    halfFloatLinear: true,
    timerQuery: timerQuery || null,
    parallelCompile: parallelCompile || null,
    loseContext: loseContext || null,
    anisotropic: anisotropic || null,
    maxAnisotropy: anisotropic
      ? gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
      : 1,
    maxSamplesRGBA16F,
    maxSamplesRGBA8,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS),
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxVertexTextureUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    maxVaryingComponents: gl.getParameter(gl.MAX_VARYING_COMPONENTS),
    vendor: debugRenderer ? gl.getParameter(debugRenderer.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: debugRenderer ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    platform: { isIOS, isSafari, isFirefox },
    /** Tile-based deferred GPUs hate large FP16 targets more than they hate fragment work. */
    dprCap: isIOS ? 1.5 : 2
  };
}

/* --- Enum translation tables ------------------------------------------ */

/**
 * Every texture and renderbuffer format the project uses, keyed by the short
 * name that appears in the buffer table of spec §1. `renderable` records
 * whether the format can be a colour attachment without an extension; the
 * float ones additionally require the probe's `floatTargets`.
 */
export const TEXTURE_FORMATS = Object.freeze({
  R8: { internal: 'R8', format: 'RED', type: 'UNSIGNED_BYTE', channels: 1, filterable: true, float: false },
  RG8: { internal: 'RG8', format: 'RG', type: 'UNSIGNED_BYTE', channels: 2, filterable: true, float: false },
  RGB8: { internal: 'RGB8', format: 'RGB', type: 'UNSIGNED_BYTE', channels: 3, filterable: true, float: false },
  RGBA8: { internal: 'RGBA8', format: 'RGBA', type: 'UNSIGNED_BYTE', channels: 4, filterable: true, float: false },
  R16F: { internal: 'R16F', format: 'RED', type: 'HALF_FLOAT', channels: 1, filterable: true, float: true, half: true },
  RG16F: { internal: 'RG16F', format: 'RG', type: 'HALF_FLOAT', channels: 2, filterable: true, float: true, half: true },
  RGB16F: { internal: 'RGB16F', format: 'RGB', type: 'HALF_FLOAT', channels: 3, filterable: true, float: true, half: true },
  RGBA16F: { internal: 'RGBA16F', format: 'RGBA', type: 'HALF_FLOAT', channels: 4, filterable: true, float: true, half: true },
  R32F: { internal: 'R32F', format: 'RED', type: 'FLOAT', channels: 1, filterable: false, float: true, half: false },
  RGBA32F: { internal: 'RGBA32F', format: 'RGBA', type: 'FLOAT', channels: 4, filterable: false, float: true, half: false },
  R11F_G11F_B10F: { internal: 'R11F_G11F_B10F', format: 'RGB', type: 'HALF_FLOAT', channels: 3, filterable: true, float: true, half: true },
  DEPTH16: { internal: 'DEPTH_COMPONENT16', format: 'DEPTH_COMPONENT', type: 'UNSIGNED_SHORT', channels: 1, filterable: false, depth: true },
  DEPTH24: { internal: 'DEPTH_COMPONENT24', format: 'DEPTH_COMPONENT', type: 'UNSIGNED_INT', channels: 1, filterable: false, depth: true },
  DEPTH32F: { internal: 'DEPTH_COMPONENT32F', format: 'DEPTH_COMPONENT', type: 'FLOAT', channels: 1, filterable: false, depth: true },
  DEPTH24_STENCIL8: { internal: 'DEPTH24_STENCIL8', format: 'DEPTH_STENCIL', type: 'UNSIGNED_INT_24_8', channels: 1, filterable: false, depth: true, stencil: true }
});

const FILTER_ENUMS = {
  nearest: 'NEAREST',
  linear: 'LINEAR',
  'nearest-mipmap-nearest': 'NEAREST_MIPMAP_NEAREST',
  'linear-mipmap-nearest': 'LINEAR_MIPMAP_NEAREST',
  'nearest-mipmap-linear': 'NEAREST_MIPMAP_LINEAR',
  'linear-mipmap-linear': 'LINEAR_MIPMAP_LINEAR'
};

const WRAP_ENUMS = {
  clamp: 'CLAMP_TO_EDGE',
  repeat: 'REPEAT',
  mirror: 'MIRRORED_REPEAT'
};

const PRIMITIVE_ENUMS = {
  points: 'POINTS',
  lines: 'LINES',
  'line-strip': 'LINE_STRIP',
  'line-loop': 'LINE_LOOP',
  triangles: 'TRIANGLES',
  'triangle-strip': 'TRIANGLE_STRIP',
  'triangle-fan': 'TRIANGLE_FAN'
};

const ATTRIB_TYPE_ENUMS = {
  float: { enum: 'FLOAT', bytes: 4, integer: false },
  half: { enum: 'HALF_FLOAT', bytes: 2, integer: false },
  byte: { enum: 'BYTE', bytes: 1, integer: true },
  ubyte: { enum: 'UNSIGNED_BYTE', bytes: 1, integer: true },
  short: { enum: 'SHORT', bytes: 2, integer: true },
  ushort: { enum: 'UNSIGNED_SHORT', bytes: 2, integer: true },
  int: { enum: 'INT', bytes: 4, integer: true },
  uint: { enum: 'UNSIGNED_INT', bytes: 4, integer: true }
};

const INDEX_TYPE_ENUMS = {
  ubyte: { enum: 'UNSIGNED_BYTE', bytes: 1 },
  ushort: { enum: 'UNSIGNED_SHORT', bytes: 2 },
  uint: { enum: 'UNSIGNED_INT', bytes: 4 }
};

const USAGE_ENUMS = {
  static: 'STATIC_DRAW',
  dynamic: 'DYNAMIC_DRAW',
  stream: 'STREAM_DRAW'
};

const DEPTH_FUNC_ENUMS = {
  never: 'NEVER',
  less: 'LESS',
  equal: 'EQUAL',
  lequal: 'LEQUAL',
  greater: 'GREATER',
  notequal: 'NOTEQUAL',
  gequal: 'GEQUAL',
  always: 'ALWAYS'
};

/**
 * The four blend configurations the frame graph actually uses, named after
 * their job rather than their factors. `srcRGB, dstRGB, srcA, dstA`.
 *
 *   none          — pass 0, 1, 3, 7
 *   premultiplied — passes 2 and 6; the strand and snow shaders already emit
 *                   `vec4(colour * a, a)`, so this is the correct operator
 *   alpha         — pass 5, the interior geometry, which emits straight alpha
 *   add           — pass 4, the signed thickness accumulator, ONE/ONE, and
 *                   the only pass that must NOT clamp, which is why it needs
 *                   a float target
 */
const BLEND_MODES = {
  none: null,
  premultiplied: ['ONE', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'],
  alpha: ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'],
  add: ['ONE', 'ONE', 'ONE', 'ONE'],
  additive: ['SRC_ALPHA', 'ONE', 'ONE', 'ONE']
};

const CULL_MODES = { none: null, back: 'BACK', front: 'FRONT', both: 'FRONT_AND_BACK' };

function enumOf(gl, table, key, what) {
  const name = table[key];
  if (name === undefined) {
    throw new Error(`gl.js: unknown ${what} '${key}'. Valid: ${Object.keys(table).join(', ')}`);
  }
  return name === null ? null : gl[name];
}

/** Full mip chain length for a 2-D texture of the given size. */
export function mipLevelCount(width, height) {
  return 1 + Math.floor(Math.log2(Math.max(1, Math.max(width, height))));
}

/* --- Resource registry ------------------------------------------------- */

/**
 * Holds every GL object in creation order and disposes them in reverse.
 * Reverse order matters: a framebuffer referencing a deleted texture is not an
 * error, but several drivers log about it every frame during a rebuild, and a
 * console full of driver warnings hides the one message that mattered.
 */
export class GLObjectRegistry {
  constructor(label = 'gl') {
    this.label = label;
    this.items = [];
    this.disposed = false;
  }
  /** Registers and returns its argument, so it wraps a factory call inline. */
  add(resource) {
    if (resource && typeof resource.dispose === 'function') this.items.push(resource);
    return resource;
  }
  /** Drops one resource from the registry without disposing it. */
  release(resource) {
    const i = this.items.indexOf(resource);
    if (i >= 0) this.items.splice(i, 1);
    return resource;
  }
  disposeAll() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i].dispose();
      } catch (e) {
        // A lost context can make any delete throw. Losing the rest of the
        // teardown to one such throw is strictly worse than swallowing it.
        if (typeof console !== 'undefined') console.warn(`gl.js: dispose failed in ${this.label}`, e);
      }
    }
    this.items.length = 0;
    this.disposed = true;
  }
}

/* --- Shader compilation and the annotated error dump ------------------- */

/**
 * Numbers every line of `source` and marks the lines the driver complained
 * about, with six lines of context either side. The whole point is that a
 * WebGL info log says "ERROR: 0:212: syntax error" about a string that was
 * assembled from four template literals and never existed as a file, so
 * without this you are counting newlines by hand.
 */
export function annotateShaderSource(source, infoLog, name) {
  const lines = source.split('\n');
  const bad = new Set();
  // Driver logs are "ERROR: <string>:<line>: message" on ANGLE, Safari and
  // Firefox alike; grab every "d:d" pair and take the second number.
  const re = /\b\d+\s*:\s*(\d+)\b/g;
  let m;
  while ((m = re.exec(infoLog)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= lines.length) bad.add(n);
  }

  const width = String(lines.length).length;
  const pad = (n) => String(n).padStart(width, ' ');
  const out = [];
  out.push(`--- ${name} ---`);
  out.push(infoLog.trim());
  out.push('');

  if (bad.size === 0) {
    // No parseable line number: dump the head of the source rather than nothing.
    const limit = Math.min(lines.length, 200);
    for (let i = 0; i < limit; i++) out.push(`   ${pad(i + 1)} | ${lines[i]}`);
    if (limit < lines.length) out.push(`   ... ${lines.length - limit} more lines`);
    return out.join('\n');
  }

  const wanted = new Set();
  for (const n of bad) {
    for (let i = n - 6; i <= n + 6; i++) if (i >= 1 && i <= lines.length) wanted.add(i);
  }
  const sorted = Array.from(wanted).sort((a, b) => a - b);
  let prev = 0;
  for (const n of sorted) {
    if (prev && n !== prev + 1) out.push('   ' + '.'.repeat(width) + ' |');
    out.push(`${bad.has(n) ? '>> ' : '   '}${pad(n)} | ${lines[n - 1]}`);
    prev = n;
  }
  return out.join('\n');
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

const UNIFORM_SETTERS = {};
function buildUniformSetters(gl) {
  if (UNIFORM_SETTERS[gl.FLOAT] !== undefined) return UNIFORM_SETTERS;
  const asArray = (v) => (typeof v === 'number' ? [v] : v);
  UNIFORM_SETTERS[gl.FLOAT] = (g, l, v) => (typeof v === 'number' ? g.uniform1f(l, v) : g.uniform1fv(l, v));
  UNIFORM_SETTERS[gl.FLOAT_VEC2] = (g, l, v) => g.uniform2fv(l, asArray(v));
  UNIFORM_SETTERS[gl.FLOAT_VEC3] = (g, l, v) => g.uniform3fv(l, asArray(v));
  UNIFORM_SETTERS[gl.FLOAT_VEC4] = (g, l, v) => g.uniform4fv(l, asArray(v));
  UNIFORM_SETTERS[gl.INT] = (g, l, v) => (typeof v === 'number' ? g.uniform1i(l, v | 0) : g.uniform1iv(l, v));
  UNIFORM_SETTERS[gl.INT_VEC2] = (g, l, v) => g.uniform2iv(l, asArray(v));
  UNIFORM_SETTERS[gl.INT_VEC3] = (g, l, v) => g.uniform3iv(l, asArray(v));
  UNIFORM_SETTERS[gl.INT_VEC4] = (g, l, v) => g.uniform4iv(l, asArray(v));
  UNIFORM_SETTERS[gl.UNSIGNED_INT] = (g, l, v) => (typeof v === 'number' ? g.uniform1ui(l, v >>> 0) : g.uniform1uiv(l, v));
  UNIFORM_SETTERS[gl.UNSIGNED_INT_VEC2] = (g, l, v) => g.uniform2uiv(l, asArray(v));
  UNIFORM_SETTERS[gl.UNSIGNED_INT_VEC3] = (g, l, v) => g.uniform3uiv(l, asArray(v));
  UNIFORM_SETTERS[gl.UNSIGNED_INT_VEC4] = (g, l, v) => g.uniform4uiv(l, asArray(v));
  UNIFORM_SETTERS[gl.BOOL] = (g, l, v) => g.uniform1i(l, v ? 1 : 0);
  UNIFORM_SETTERS[gl.BOOL_VEC2] = (g, l, v) => g.uniform2iv(l, asArray(v));
  UNIFORM_SETTERS[gl.BOOL_VEC3] = (g, l, v) => g.uniform3iv(l, asArray(v));
  UNIFORM_SETTERS[gl.BOOL_VEC4] = (g, l, v) => g.uniform4iv(l, asArray(v));
  UNIFORM_SETTERS[gl.FLOAT_MAT2] = (g, l, v) => g.uniformMatrix2fv(l, false, v);
  UNIFORM_SETTERS[gl.FLOAT_MAT3] = (g, l, v) => g.uniformMatrix3fv(l, false, v);
  UNIFORM_SETTERS[gl.FLOAT_MAT4] = (g, l, v) => g.uniformMatrix4fv(l, false, v);
  // Samplers take a texture UNIT index, never a texture object. Program.texture()
  // is the sanctioned way to set one; this exists for the rare manual case.
  const asInt = (g, l, v) => g.uniform1i(l, v | 0);
  for (const t of ['SAMPLER_2D', 'SAMPLER_3D', 'SAMPLER_CUBE', 'SAMPLER_2D_SHADOW',
    'SAMPLER_2D_ARRAY', 'SAMPLER_2D_ARRAY_SHADOW', 'SAMPLER_CUBE_SHADOW',
    'INT_SAMPLER_2D', 'INT_SAMPLER_3D', 'INT_SAMPLER_CUBE', 'INT_SAMPLER_2D_ARRAY',
    'UNSIGNED_INT_SAMPLER_2D', 'UNSIGNED_INT_SAMPLER_3D', 'UNSIGNED_INT_SAMPLER_CUBE',
    'UNSIGNED_INT_SAMPLER_2D_ARRAY']) {
    if (gl[t] !== undefined) UNIFORM_SETTERS[gl[t]] = asInt;
  }
  return UNIFORM_SETTERS;
}

/**
 * A linked program plus its introspected uniforms and attributes.
 *
 * `set(name, value)` dispatches on the uniform's DECLARED type, taken from
 * `getActiveUniform`, rather than guessing from the JavaScript value. That is
 * the difference between `uniform1f` and `uniform1i` for an `int` uniform whose
 * value happens to be `16`, which silently produces zero on some drivers and
 * garbage on others.
 *
 * Setting a name the program does not have is a no-op, not an error: the GLSL
 * compiler removes unused uniforms aggressively, and a shared uniform block
 * that mostly applies is normal. The names are collected in `missing` so a
 * genuine typo is still findable.
 */
class Program {
  constructor(gl, program, name) {
    this.gl = gl;
    this.program = program;
    this.name = name;
    this.uniforms = new Map();
    this.attributes = new Map();
    this.missing = new Set();
    this._setters = buildUniformSetters(gl);
    this._nextUnit = 0;
    this._disposed = false;
    this._introspect();
  }

  _introspect() {
    const gl = this.gl;
    const nu = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) {
      const info = gl.getActiveUniform(this.program, i);
      if (!info) continue;
      const loc = gl.getUniformLocation(this.program, info.name);
      if (!loc) continue;
      const entry = { location: loc, type: info.type, size: info.size, name: info.name };
      this.uniforms.set(info.name, entry);
      // Array uniforms come back as "uFoo[0]"; register the bare name too so
      // callers can write set('uFoo', array) without knowing that.
      if (info.name.endsWith('[0]')) this.uniforms.set(info.name.slice(0, -3), entry);
    }
    const na = gl.getProgramParameter(this.program, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) {
      const info = gl.getActiveAttrib(this.program, i);
      if (!info) continue;
      this.attributes.set(info.name, gl.getAttribLocation(this.program, info.name));
    }
  }

  use() {
    this.gl.useProgram(this.program);
    this._nextUnit = 0;
    return this;
  }

  has(name) { return this.uniforms.has(name); }
  location(name) {
    const u = this.uniforms.get(name);
    return u ? u.location : null;
  }
  attribute(name) {
    const a = this.attributes.get(name);
    return a === undefined ? -1 : a;
  }

  /** Sets one uniform by name. Unknown names are recorded and ignored. */
  set(name, value) {
    const u = this.uniforms.get(name);
    if (!u) { this.missing.add(name); return this; }
    const setter = this._setters[u.type];
    if (!setter) throw new Error(`gl.js: no setter for uniform '${name}' of type 0x${u.type.toString(16)} in ${this.name}`);
    setter(this.gl, u.location, value);
    return this;
  }

  /** Sets many uniforms from a plain object; order is irrelevant. */
  setAll(values) {
    for (const k in values) if (Object.prototype.hasOwnProperty.call(values, k)) this.set(k, values[k]);
    return this;
  }

  /**
   * Binds `texture` to a unit and points the sampler `name` at it. Pass `unit`
   * to pin a slot; omit it and units are handed out sequentially from zero,
   * reset by every `use()`. Accepts a Texture wrapper or a raw WebGLTexture.
   */
  texture(name, texture, unit) {
    const gl = this.gl;
    const u = unit === undefined ? this._nextUnit++ : unit;
    if (unit !== undefined && unit >= this._nextUnit) this._nextUnit = unit + 1;
    const handle = texture && texture.texture !== undefined ? texture.texture : texture;
    const target = texture && texture.target !== undefined ? texture.target : gl.TEXTURE_2D;
    gl.activeTexture(gl.TEXTURE0 + u);
    gl.bindTexture(target, handle);
    this.set(name, u);
    return u;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (!this.gl.isContextLost()) this.gl.deleteProgram(this.program);
    this.uniforms.clear();
    this.attributes.clear();
  }
}

/**
 * Compiles and links a program, throwing an Error whose message is the
 * annotated dump. `vertex` and `fragment` must already be complete sources —
 * assembly (version directive, precision, defines, common.js) is the job of
 * `assembleShader` in shaders/common.js, so that the string thrown here is
 * exactly the string the driver saw and its line numbers line up.
 *
 * `attributeLocations` binds attribute names to fixed indices before linking,
 * which lets several programs share one VAO — the bell's front-depth, thickness
 * and shading programs all read the same vertex buffers.
 *
 * With KHR_parallel_shader_compile present the caller may pass `async: true`
 * and poll `program.ready()`; boot uses that behind the 1.2 s fade so a slow
 * compile never shows a spinner.
 */
export function createProgram(gl, options) {
  const {
    name = 'program',
    vertex,
    fragment,
    attributeLocations = null,
    caps = null,
    async: wantAsync = false
  } = options;

  if (typeof vertex !== 'string' || typeof fragment !== 'string') {
    throw new Error(`gl.js: createProgram('${name}') needs vertex and fragment source strings`);
  }

  const vs = compileShader(gl, gl.VERTEX_SHADER, vertex);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  if (attributeLocations) {
    for (const attrName in attributeLocations) {
      if (Object.prototype.hasOwnProperty.call(attributeLocations, attrName)) {
        gl.bindAttribLocation(prog, attributeLocations[attrName] | 0, attrName);
      }
    }
  }
  gl.linkProgram(prog);

  const parallel = caps && caps.parallelCompile;
  const finish = () => {
    // Only ask for compile status once, and only on failure, because querying
    // it synchronises with the compiler and defeats parallel compilation.
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const parts = [`gl.js: program '${name}' failed to link.`];
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        parts.push(annotateShaderSource(vertex, gl.getShaderInfoLog(vs) || '', `${name}.vert`));
      }
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        parts.push(annotateShaderSource(fragment, gl.getShaderInfoLog(fs) || '', `${name}.frag`));
      }
      const linkLog = gl.getProgramInfoLog(prog) || '';
      if (linkLog.trim()) parts.push(`--- ${name} link log ---\n${linkLog.trim()}`);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(prog);
      const message = parts.join('\n\n');
      if (typeof console !== 'undefined') console.error(message);
      throw new Error(message);
    }
    // The shader objects are no longer needed once the program is linked; the
    // driver keeps them alive internally until then.
    gl.detachShader(prog, vs);
    gl.detachShader(prog, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return new Program(gl, prog, name);
  };

  if (wantAsync && parallel) {
    // Deferred: the caller polls `pending.ready()` and then calls `pending.resolve()`.
    return {
      pending: true,
      name,
      ready() {
        return gl.getProgramParameter(prog, parallel.COMPLETION_STATUS_KHR) === true;
      },
      resolve: finish,
      dispose() {
        if (gl.isContextLost()) return;
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteProgram(prog);
      }
    };
  }
  return finish();
}

/* --- Buffers ----------------------------------------------------------- */

/**
 * A vertex or index buffer. `update(data, byteOffset)` maps onto
 * `bufferSubData`, which is what the strand packer uses for its ~34 KB of
 * per-frame vertices; `resize` reallocates and is not something a frame should
 * ever do.
 */
export function createBuffer(gl, options = {}) {
  const {
    target = 'array',
    data = null,
    size = 0,
    usage = 'static',
    name = 'buffer'
  } = options;

  const targetEnum = target === 'index' || target === 'element'
    ? gl.ELEMENT_ARRAY_BUFFER
    : gl.ARRAY_BUFFER;
  const usageEnum = enumOf(gl, USAGE_ENUMS, usage, 'buffer usage');

  /*
   * THE ELEMENT ARRAY BINDING IS VAO STATE, and this is the whole reason this
   * helper exists rather than two lines at each call site. `bindBuffer(
   * ELEMENT_ARRAY_BUFFER, …)` while a vertex array is current writes into THAT
   * vertex array — so a per-frame index upload (the strand packer does one every
   * frame) performed while some unrelated VAO happened to be bound would leave
   * that VAO pointing at the wrong index buffer, or at null, and its next
   * drawElements would quietly draw nothing. The fix is to have no vertex array
   * bound while an index buffer is uploaded. ARRAY_BUFFER is not VAO state and
   * needs none of this, but doing it unconditionally would cost a redundant
   * bindVertexArray on the hot path, so it is gated on the target.
   */
  const detachVertexArray = targetEnum === gl.ELEMENT_ARRAY_BUFFER
    ? () => { gl.bindVertexArray(null); }
    : () => {};

  const handle = gl.createBuffer();
  gl.bindBuffer(targetEnum, handle);
  if (data) gl.bufferData(targetEnum, data, usageEnum);
  else gl.bufferData(targetEnum, size, usageEnum);
  gl.bindBuffer(targetEnum, null);

  let disposed = false;
  return {
    name,
    buffer: handle,
    target: targetEnum,
    usage: usageEnum,
    byteLength: data ? data.byteLength : size,
    /**
     * The raw binding, and the ONLY thing that should call it on an index
     * buffer is `createVertexArray`, which binds it deliberately in order to
     * capture it into the VAO it is building. See `detachVertexArray` below for
     * why everything else goes through update()/resize().
     */
    bind() { gl.bindBuffer(targetEnum, handle); },
    /** Partial upload. `byteOffset` is in bytes; `data` is a typed array view. */
    update(newData, byteOffset = 0) {
      detachVertexArray();
      gl.bindBuffer(targetEnum, handle);
      gl.bufferSubData(targetEnum, byteOffset, newData);
      gl.bindBuffer(targetEnum, null);
    },
    /** Full reallocation. Invalidates any VAO stride assumptions — rebuild those too. */
    resize(newData, newUsage) {
      detachVertexArray();
      gl.bindBuffer(targetEnum, handle);
      gl.bufferData(targetEnum, newData, newUsage ? enumOf(gl, USAGE_ENUMS, newUsage, 'buffer usage') : usageEnum);
      gl.bindBuffer(targetEnum, null);
      this.byteLength = typeof newData === 'number' ? newData : newData.byteLength;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!gl.isContextLost()) gl.deleteBuffer(handle);
    }
  };
}

/* --- Vertex arrays ----------------------------------------------------- */

/**
 * Builds a VAO from a descriptor. Attribute locations are explicit integers,
 * not names looked up per program, because the bell's three programs share one
 * VAO and a name lookup would only agree by accident.
 *
 * `integer: true` routes through `vertexAttribIPointer`, which is required for
 * an `in uint`/`in int` attribute — using the float pointer for one silently
 * feeds the shader converted floats.
 */
export function createVertexArray(gl, options = {}) {
  const { attributes = [], indices = null, name = 'vao' } = options;

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  for (const a of attributes) {
    const info = ATTRIB_TYPE_ENUMS[a.type || 'float'];
    if (!info) throw new Error(`gl.js: unknown attribute type '${a.type}' in ${name}`);
    const loc = a.location | 0;
    a.buffer.bind();
    gl.enableVertexAttribArray(loc);
    if (a.integer || (info.integer && !a.normalized)) {
      gl.vertexAttribIPointer(loc, a.size, gl[info.enum], a.stride || 0, a.offset || 0);
    } else {
      gl.vertexAttribPointer(loc, a.size, gl[info.enum], !!a.normalized, a.stride || 0, a.offset || 0);
    }
    if (a.divisor) gl.vertexAttribDivisor(loc, a.divisor | 0);
  }

  let indexInfo = null;
  if (indices) {
    indexInfo = INDEX_TYPE_ENUMS[indices.type || 'ushort'];
    if (!indexInfo) throw new Error(`gl.js: unknown index type '${indices.type}' in ${name}`);
    indices.buffer.bind();
  }

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  // The element buffer binding belongs to the VAO, so it must NOT be unbound
  // while the VAO is still current; unbinding it here, after bindVertexArray(null),
  // is safe and keeps the global state clean.
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

  let disposed = false;
  return {
    name,
    vao,
    indexed: !!indices,
    indexType: indexInfo ? gl[indexInfo.enum] : 0,
    indexBytes: indexInfo ? indexInfo.bytes : 0,
    bind() { gl.bindVertexArray(vao); },
    unbind() { gl.bindVertexArray(null); },
    /** `offset` counts elements (vertices or indices), not bytes. */
    draw(mode, count, offset = 0) {
      const m = enumOf(gl, PRIMITIVE_ENUMS, mode, 'primitive mode');
      gl.bindVertexArray(vao);
      if (indexInfo) gl.drawElements(m, count, gl[indexInfo.enum], offset * indexInfo.bytes);
      else gl.drawArrays(m, offset, count);
    },
    drawInstanced(mode, count, instances, offset = 0) {
      const m = enumOf(gl, PRIMITIVE_ENUMS, mode, 'primitive mode');
      gl.bindVertexArray(vao);
      if (indexInfo) gl.drawElementsInstanced(m, count, gl[indexInfo.enum], offset * indexInfo.bytes, instances);
      else gl.drawArraysInstanced(m, offset, count, instances);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!gl.isContextLost()) gl.deleteVertexArray(vao);
    }
  };
}

/* --- Textures ---------------------------------------------------------- */

/**
 * Allocates an immutable 2-D texture with `texStorage2D`. Immutable storage is
 * deliberate: it is validated once at allocation instead of per level, it makes
 * an incomplete mip chain impossible, and it avoids a family of Safari bugs
 * around re-specifying a level of a texture that is already attached to a
 * framebuffer. The cost is that resizing means creating a new texture, which is
 * what targets.js does anyway on its debounced resize.
 *
 * `format` is a key of TEXTURE_FORMATS. `data`, when given, is uploaded to
 * level 0; a Float32Array into a *16F texture is accepted and uploaded as FLOAT,
 * which the driver converts.
 */
export function createTexture2D(gl, options = {}) {
  const {
    width,
    height,
    format = 'RGBA8',
    levels = 1,
    min = 'linear',
    mag = 'linear',
    wrapS = 'clamp',
    wrapT = 'clamp',
    data = null,
    anisotropy = 0,
    caps = null,
    name = 'texture'
  } = options;

  const spec = TEXTURE_FORMATS[format];
  if (!spec) throw new Error(`gl.js: unknown texture format '${format}' for ${name}`);
  if (!(width > 0 && height > 0)) throw new Error(`gl.js: texture '${name}' needs a non-zero size (got ${width}×${height})`);

  // A 32-bit float texture cannot be LINEAR-filtered without the extension, and
  // asking for it anyway makes the texture incomplete and samples pure black —
  // a failure mode that looks like a shading bug. Downgrade loudly instead.
  let minFilter = min, magFilter = mag;
  if (spec.float && !spec.half && caps && !caps.floatLinear) {
    if (minFilter.indexOf('linear') === 0) minFilter = 'nearest';
    if (magFilter.indexOf('linear') === 0) magFilter = 'nearest';
  }

  const handle = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl[spec.internal], width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, enumOf(gl, FILTER_ENUMS, minFilter, 'min filter'));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, enumOf(gl, FILTER_ENUMS, magFilter, 'mag filter'));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, enumOf(gl, WRAP_ENUMS, wrapS, 'wrap mode'));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, enumOf(gl, WRAP_ENUMS, wrapT, 'wrap mode'));
  if (anisotropy > 1 && caps && caps.anisotropic) {
    gl.texParameterf(gl.TEXTURE_2D, caps.anisotropic.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(anisotropy, caps.maxAnisotropy));
  }

  const uploadType = (uploadData) => {
    if (spec.half && uploadData instanceof Float32Array) return gl.FLOAT;
    return gl[spec.type];
  };

  if (data) {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl[spec.format], uploadType(data), data);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);

  let disposed = false;
  return {
    name,
    texture: handle,
    target: gl.TEXTURE_2D,
    width,
    height,
    format,
    spec,
    levels,
    bind(unit = 0) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, handle);
      return unit;
    },
    upload(newData, level = 0, x = 0, y = 0, w = width, h = height) {
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, level, x, y, w, h, gl[spec.format], uploadType(newData), newData);
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
    setFilter(newMin, newMag) {
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, enumOf(gl, FILTER_ENUMS, newMin, 'min filter'));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, enumOf(gl, FILTER_ENUMS, newMag, 'mag filter'));
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
    setWrap(s, t) {
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, enumOf(gl, WRAP_ENUMS, s, 'wrap mode'));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, enumOf(gl, WRAP_ENUMS, t, 'wrap mode'));
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
    generateMipmap() {
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!gl.isContextLost()) gl.deleteTexture(handle);
    }
  };
}

/**
 * A renderbuffer, optionally multisampled. The only multisampled surface in the
 * project is the optional MSAA copy of FINAL, and it exists solely so the legal
 * MS -> single-sample `blitFramebuffer` direction can be used. Blitting INTO a
 * multisampled draw framebuffer is INVALID_OPERATION and appears nowhere.
 */
export function createRenderbuffer(gl, options = {}) {
  const { width, height, format = 'RGBA8', samples = 0, name = 'renderbuffer' } = options;
  const spec = TEXTURE_FORMATS[format];
  if (!spec) throw new Error(`gl.js: unknown renderbuffer format '${format}' for ${name}`);

  const handle = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, handle);
  if (samples > 0) {
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl[spec.internal], width, height);
  } else {
    gl.renderbufferStorage(gl.RENDERBUFFER, gl[spec.internal], width, height);
  }
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);

  let disposed = false;
  return {
    name,
    renderbuffer: handle,
    isRenderbuffer: true,
    width,
    height,
    format,
    samples,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!gl.isContextLost()) gl.deleteRenderbuffer(handle);
    }
  };
}

const FRAMEBUFFER_STATUS_NAMES = {
  36053: 'FRAMEBUFFER_COMPLETE',
  36054: 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT',
  36055: 'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT',
  36057: 'FRAMEBUFFER_INCOMPLETE_DIMENSIONS',
  36061: 'FRAMEBUFFER_UNSUPPORTED',
  36182: 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE'
};

/**
 * Builds a framebuffer from textures and/or renderbuffers. `color` is an array;
 * with more than one entry `drawBuffers` is configured at bind time so a pass
 * writing to two attachments does not have to remember to.
 *
 * INCOMPLETE_ATTACHMENT on a float target almost always means the probe said no
 * to `floatTargets` and the caller allocated RGBA16F anyway, so the thrown
 * message says so.
 */
export function createFramebuffer(gl, options = {}) {
  const { color = [], depth = null, name = 'framebuffer' } = options;

  const handle = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, handle);

  const drawBuffers = [];
  for (let i = 0; i < color.length; i++) {
    const a = color[i];
    const point = gl.COLOR_ATTACHMENT0 + i;
    if (a.isRenderbuffer) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, point, gl.RENDERBUFFER, a.renderbuffer);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, point, gl.TEXTURE_2D, a.texture, 0);
    drawBuffers.push(point);
  }
  if (depth) {
    const point = depth.spec && depth.spec.stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
    if (depth.isRenderbuffer) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, point, gl.RENDERBUFFER, depth.renderbuffer);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, point, gl.TEXTURE_2D, depth.texture, 0);
  }
  if (drawBuffers.length > 1) gl.drawBuffers(drawBuffers);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(handle);
    const label = FRAMEBUFFER_STATUS_NAMES[status] || ('0x' + status.toString(16));
    throw new Error(
      `gl.js: framebuffer '${name}' is incomplete (${label}). ` +
      `A float colour attachment here means EXT_color_buffer_float / ` +
      `EXT_color_buffer_half_float was not available — take the RGBA8 path.`
    );
  }

  const first = color[0] || depth;
  let disposed = false;
  return {
    name,
    framebuffer: handle,
    width: first ? first.width : 0,
    height: first ? first.height : 0,
    color,
    depth,
    drawBuffers,
    /** Bind for drawing. Use the state cache's `bindTarget` in pass code instead. */
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, handle);
      if (drawBuffers.length > 1) gl.drawBuffers(drawBuffers);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!gl.isContextLost()) gl.deleteFramebuffer(handle);
    }
  };
}

/**
 * The ONE legal blit in this renderer: multisample source resolved down to a
 * single-sample destination. Blitting into a multisampled draw framebuffer is
 * INVALID_OPERATION, which is why SEA -> FINAL is a fullscreen-triangle draw
 * and not a blit.
 */
export function resolveMultisample(gl, src, dst, filter = 'nearest') {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst ? dst.framebuffer : null);
  const w = src.width, h = src.height;
  const dw = dst ? dst.width : w, dh = dst ? dst.height : h;
  gl.blitFramebuffer(
    0, 0, w, h,
    0, 0, dw, dh,
    gl.COLOR_BUFFER_BIT,
    filter === 'linear' ? gl.LINEAR : gl.NEAREST
  );
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

/* --- Fullscreen triangle ------------------------------------------------ */

/**
 * One oversized triangle rather than two triangles, so there is no diagonal
 * seam where the two halves meet and no pixel is shaded twice along it.
 *
 * It ships with a real vertex buffer instead of the attribute-less
 * `gl_VertexID` trick: several drivers, Safari's among them, are unhappy
 * drawing with no enabled attribute arrays, and three vertices cost nothing.
 */
export const FULLSCREEN_TRIANGLE_VS = `
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main(){
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export function createFullscreenTriangle(gl) {
  const buffer = createBuffer(gl, {
    name: 'fullscreen-triangle',
    data: new Float32Array([-1, -1, 3, -1, -1, 3]),
    usage: 'static'
  });
  const vao = createVertexArray(gl, {
    name: 'fullscreen-triangle',
    attributes: [{ buffer, location: 0, size: 2, type: 'float' }]
  });
  let disposed = false;
  return {
    /** Attribute location 0 is `aPos`; bind the same location in any program that uses this. */
    attributeLocations: { aPos: 0 },
    draw() { vao.draw('triangles', 3); },
    dispose() {
      if (disposed) return;
      disposed = true;
      vao.dispose();
      buffer.dispose();
    }
  };
}

/* --- State cache -------------------------------------------------------- */

const DEFAULT_STATE = Object.freeze({
  blend: 'none',
  depthTest: false,
  depthWrite: false,
  depthFunc: 'less',
  cull: 'none',
  colorMask: [true, true, true, true],
  scissor: null
});

/**
 * The single owner of blend, depth, cull, colour mask, scissor, viewport and
 * framebuffer binding. Every pass declares the state it wants as a plain object
 * and the cache issues only the GL calls that actually change something.
 *
 * `apply()` treats an omitted key as "reset to the default", not "leave alone".
 * That is deliberate and is the whole value of the thing: a pass that forgets to
 * mention depth writing gets depth writing off, every time, rather than
 * inheriting whatever the previous pass happened to leave behind.
 */
export function createStateCache(gl) {
  const current = {
    blend: null,
    depthTest: null,
    depthWrite: null,
    depthFunc: null,
    cull: null,
    colorMask: [null, null, null, null],
    scissor: null,
    viewport: [-1, -1, -1, -1],
    framebuffer: undefined
  };

  function applyBlend(mode) {
    if (current.blend === mode) return;
    const factors = BLEND_MODES[mode];
    if (factors === undefined) throw new Error(`gl.js: unknown blend mode '${mode}'`);
    if (!factors) {
      gl.disable(gl.BLEND);
    } else {
      if (!BLEND_MODES[current.blend]) gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl[factors[0]], gl[factors[1]], gl[factors[2]], gl[factors[3]]);
      gl.blendEquation(gl.FUNC_ADD);
    }
    current.blend = mode;
  }

  function applyDepth(test, write, func) {
    if (current.depthTest !== test) {
      if (test) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      current.depthTest = test;
    }
    if (current.depthWrite !== write) {
      gl.depthMask(!!write);
      current.depthWrite = write;
    }
    if (current.depthFunc !== func) {
      gl.depthFunc(enumOf(gl, DEPTH_FUNC_ENUMS, func, 'depth function'));
      current.depthFunc = func;
    }
  }

  function applyCull(mode) {
    if (current.cull === mode) return;
    const face = CULL_MODES[mode];
    if (face === undefined) throw new Error(`gl.js: unknown cull mode '${mode}'`);
    if (!face) {
      gl.disable(gl.CULL_FACE);
    } else {
      if (!CULL_MODES[current.cull]) gl.enable(gl.CULL_FACE);
      gl.cullFace(gl[face]);
    }
    current.cull = mode;
  }

  function applyColorMask(mask) {
    const c = current.colorMask;
    if (c[0] === mask[0] && c[1] === mask[1] && c[2] === mask[2] && c[3] === mask[3]) return;
    gl.colorMask(!!mask[0], !!mask[1], !!mask[2], !!mask[3]);
    c[0] = mask[0]; c[1] = mask[1]; c[2] = mask[2]; c[3] = mask[3];
  }

  function applyScissor(box) {
    const same = (box === null && current.scissor === null) ||
      (box && current.scissor &&
        box[0] === current.scissor[0] && box[1] === current.scissor[1] &&
        box[2] === current.scissor[2] && box[3] === current.scissor[3]);
    if (same) return;
    if (!box) {
      gl.disable(gl.SCISSOR_TEST);
      current.scissor = null;
    } else {
      if (!current.scissor) gl.enable(gl.SCISSOR_TEST);
      gl.scissor(box[0], box[1], box[2], box[3]);
      current.scissor = [box[0], box[1], box[2], box[3]];
    }
  }

  return {
    /** Applies a complete state description; omitted keys revert to the defaults. */
    apply(desc = {}) {
      const d = desc;
      applyBlend(d.blend === undefined ? DEFAULT_STATE.blend : d.blend);
      applyDepth(
        d.depthTest === undefined ? DEFAULT_STATE.depthTest : !!d.depthTest,
        d.depthWrite === undefined ? DEFAULT_STATE.depthWrite : !!d.depthWrite,
        d.depthFunc === undefined ? DEFAULT_STATE.depthFunc : d.depthFunc
      );
      applyCull(d.cull === undefined ? DEFAULT_STATE.cull : d.cull);
      applyColorMask(d.colorMask === undefined ? DEFAULT_STATE.colorMask : d.colorMask);
      applyScissor(d.scissor === undefined ? DEFAULT_STATE.scissor : d.scissor);
      return this;
    },

    /**
     * Binds a render target and sets the viewport to cover it. Pass `null` for
     * the default framebuffer, in which case `width`/`height` must be given —
     * the drawing-buffer size is the caller's business, not the cache's.
     */
    bindTarget(framebuffer, width, height) {
      const handle = framebuffer ? framebuffer.framebuffer : null;
      if (current.framebuffer !== handle) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, handle);
        if (framebuffer && framebuffer.drawBuffers.length > 1) gl.drawBuffers(framebuffer.drawBuffers);
        current.framebuffer = handle;
      }
      const w = width === undefined ? (framebuffer ? framebuffer.width : 0) : width;
      const h = height === undefined ? (framebuffer ? framebuffer.height : 0) : height;
      this.viewport(0, 0, w, h);
      return this;
    },

    viewport(x, y, w, h) {
      const v = current.viewport;
      if (v[0] === x && v[1] === y && v[2] === w && v[3] === h) return this;
      gl.viewport(x, y, w, h);
      v[0] = x; v[1] = y; v[2] = w; v[3] = h;
      return this;
    },

    /**
     * Clears the bound target. Clearing depth requires the depth mask to be
     * on — a `clear` that silently does nothing because the previous pass left
     * `depthMask(false)` is a classic hour-long bug, so it is forced here.
     */
    clear({ color = null, depth = null, stencil = null } = {}) {
      let mask = 0;
      if (color) {
        applyColorMask([true, true, true, true]);
        gl.clearColor(color[0], color[1], color[2], color.length > 3 ? color[3] : 1);
        mask |= gl.COLOR_BUFFER_BIT;
      }
      if (depth !== null) {
        if (!current.depthWrite) { gl.depthMask(true); current.depthWrite = true; }
        gl.clearDepth(depth);
        mask |= gl.DEPTH_BUFFER_BIT;
      }
      if (stencil !== null) {
        gl.clearStencil(stencil);
        mask |= gl.STENCIL_BUFFER_BIT;
      }
      if (mask) gl.clear(mask);
      return this;
    },

    /** Forgets the cached state. Call after a context restore, or after any raw GL poking. */
    invalidate() {
      current.blend = null;
      current.depthTest = null;
      current.depthWrite = null;
      current.depthFunc = null;
      current.cull = null;
      current.colorMask[0] = null;
      current.scissor = null;
      current.viewport[0] = -1;
      current.framebuffer = undefined;
      return this;
    },

    /** Read-only view of what the cache believes is set; for the ?dev=1 panel. */
    debugState() {
      return {
        blend: current.blend,
        depthTest: current.depthTest,
        depthWrite: current.depthWrite,
        depthFunc: current.depthFunc,
        cull: current.cull,
        viewport: current.viewport.slice()
      };
    }
  };
}

/* --- GPU timing --------------------------------------------------------- */

/**
 * Wraps EXT_disjoint_timer_query_webgl2 into something the quality ladder can
 * poll without stalling. Only one TIME_ELAPSED query may be active at a time,
 * so begin/end must pair; results arrive several frames later and are read
 * without ever blocking.
 *
 * `available` is false on Safari and Firefox, which do not expose the
 * extension. The ladder falls back to counting dropped frames there, which
 * reacts correctly but more slowly — spec §7 tunes for exactly that.
 */
export function createGpuTimer(gl, caps, { capacity = 6 } = {}) {
  const ext = caps ? caps.timerQuery : null;
  if (!ext) {
    return {
      available: false,
      begin() {},
      end() {},
      poll() { return null; },
      reset() {},
      dispose() {}
    };
  }

  const pending = [];
  let active = null;
  let disposed = false;

  return {
    available: true,
    begin() {
      if (disposed || active || pending.length >= capacity) return;
      active = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    },
    /** Returns the oldest completed measurement in milliseconds, or null. */
    poll() {
      if (!pending.length) return null;
      // A disjoint event means the GPU was interrupted and every outstanding
      // result is meaningless; throw them all away rather than feeding a lie
      // to the median filter.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        for (const q of pending) gl.deleteQuery(q);
        pending.length = 0;
        return null;
      }
      const q = pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return null;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      pending.shift();
      gl.deleteQuery(q);
      return ns / 1e6;
    },
    reset() {
      if (active) { gl.endQuery(ext.TIME_ELAPSED_EXT); gl.deleteQuery(active); active = null; }
      for (const q of pending) gl.deleteQuery(q);
      pending.length = 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (gl.isContextLost()) { pending.length = 0; active = null; return; }
      this.reset();
    }
  };
}

/* --- Diagnostics --------------------------------------------------------- */

const ERROR_NAMES = {
  1280: 'INVALID_ENUM',
  1281: 'INVALID_VALUE',
  1282: 'INVALID_OPERATION',
  1285: 'OUT_OF_MEMORY',
  1286: 'INVALID_FRAMEBUFFER_OPERATION',
  37442: 'CONTEXT_LOST_WEBGL'
};

/**
 * Development-only error check. `getError` forces a synchronisation with the
 * driver, so this must never appear in the steady-state frame path — call it
 * once after setup, or from behind the `?dev=1` flag.
 */
export function checkError(gl, label) {
  const e = gl.getError();
  if (e === gl.NO_ERROR) return null;
  const nameOfError = ERROR_NAMES[e] || ('0x' + e.toString(16));
  if (typeof console !== 'undefined') console.error(`gl.js: ${nameOfError} at ${label}`);
  return nameOfError;
}
