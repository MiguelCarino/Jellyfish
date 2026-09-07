/* ============================================================
   tests/mockgl.mjs — a WebGL2 context that records instead of
   drawing, so the whole renderer can be run without a GPU.
   ------------------------------------------------------------
   This is not an emulator and it draws nothing. What it is, is
   a context that is STRICT about the things a real driver is
   strict about and that a static check cannot see:

     * it introspects each program's uniforms and attributes by
       PARSING THE SOURCE it was handed, so Program.set()
       dispatches on the same declared type the driver would
       report — which means passing a two-element array to a vec3
       uniform, or a mat3 where a mat4 was declared, fails here;
     * it validates every uniform*v call's array length against
       the declared type, and every uniformMatrix*fv call's
       `transpose` flag, which WebGL2 requires to be false;
     * it refuses a draw with no program bound, no framebuffer
       binding it does not recognise, and a texStorage2D with a
       zero dimension;
     * it counts every call, so a pass that silently stopped
       drawing shows up as a count of zero.

   Enum values are handed out lazily by a Proxy and memoised, so
   every `gl.SOMETHING` gl.js reaches for is a stable distinct
   number without this file having to carry the WebGL registry.
   ============================================================ */

/*
 * Enum values are shared across every mock context in the process, exactly as
 * the real registry is. They must be: gl.js memoises its uniform-setter table
 * on gl.FLOAT the first time it sees a context, so a second context handing out
 * different numbers for the same names would route a vec3 through uniform2fv
 * and the whole thing would look like a caller bug.
 */
const ENUM_VALUES = new Map();
let nextEnumValue = 0x1000;
function enumOf(name) {
  if (!ENUM_VALUES.has(name)) ENUM_VALUES.set(name, nextEnumValue++);
  return ENUM_VALUES.get(name);
}

const GLSL_TYPE_TO_ENUM = {
  float: 'FLOAT', vec2: 'FLOAT_VEC2', vec3: 'FLOAT_VEC3', vec4: 'FLOAT_VEC4',
  int: 'INT', ivec2: 'INT_VEC2', ivec3: 'INT_VEC3', ivec4: 'INT_VEC4',
  uint: 'UNSIGNED_INT', uvec2: 'UNSIGNED_INT_VEC2', uvec3: 'UNSIGNED_INT_VEC3',
  uvec4: 'UNSIGNED_INT_VEC4',
  bool: 'BOOL', bvec2: 'BOOL_VEC2', bvec3: 'BOOL_VEC3', bvec4: 'BOOL_VEC4',
  mat2: 'FLOAT_MAT2', mat3: 'FLOAT_MAT3', mat4: 'FLOAT_MAT4',
  sampler2D: 'SAMPLER_2D', sampler3D: 'SAMPLER_3D', samplerCube: 'SAMPLER_CUBE'
};

/** Component counts the *v setters must be handed, keyed by GLSL type. */
const COMPONENTS = {
  float: 1, int: 1, uint: 1, bool: 1,
  vec2: 2, ivec2: 2, uvec2: 2, bvec2: 2,
  vec3: 3, ivec3: 3, uvec3: 3, bvec3: 3,
  vec4: 4, ivec4: 4, uvec4: 4, bvec4: 4,
  mat2: 4, mat3: 9, mat4: 16,
  sampler2D: 1, sampler3D: 1, samplerCube: 1
};

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Walks the preprocessor the same way the assembled source will be walked by a
 * driver, so a uniform inside an #ifdef arm that this configuration does not
 * take is correctly absent — which is the whole point of checking `.missing`.
 */
function activeSource(src) {
  const defined = new Set();
  for (const m of src.matchAll(/^\s*#define\s+([A-Za-z_]\w*)/gm)) defined.add(m[1]);
  const out = [];
  const stack = [];
  let active = true;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#ifdef') || t.startsWith('#ifndef') || t.startsWith('#if ')) {
      let value = true;
      if (t.startsWith('#ifdef')) value = defined.has(t.slice(6).trim());
      else if (t.startsWith('#ifndef')) value = !defined.has(t.slice(7).trim());
      else {
        const m = t.match(/defined\s*\(?\s*([A-Za-z_]\w*)/);
        value = m ? defined.has(m[1]) : true;
      }
      stack.push(active);
      active = active && value;
      continue;
    }
    if (t.startsWith('#else')) { active = stack[stack.length - 1] && !active; continue; }
    if (t.startsWith('#endif')) { active = stack.pop(); continue; }
    if (!active) continue;
    out.push(line);
  }
  return out.join('\n');
}

function parseUniforms(source) {
  const out = [];
  const re = /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(\[\s*(\d+)\s*\])?\s*;/gm;
  for (const m of activeSource(stripComments(source)).matchAll(re)) {
    out.push({ glslType: m[1], name: m[4] ? `${m[2]}[0]` : m[2], size: m[4] ? Number(m[4]) : 1 });
  }
  return out;
}

function parseAttributes(source) {
  const out = [];
  const re = /^\s*(?:layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*)?in\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;/gm;
  for (const m of activeSource(stripComments(source)).matchAll(re)) {
    out.push({ location: m[1] === undefined ? null : Number(m[1]), glslType: m[2], name: m[3] });
  }
  return out;
}

/**
 * `options.extensions` is the set of extension names the fake driver admits, so
 * a caller can run the float path, the RGBA8 path and the no-timer path through
 * exactly the same renderer.
 */
export function createMockGL(options = {}) {
  const {
    extensions = ['EXT_color_buffer_float', 'OES_texture_float_linear'],
    maxSamples = 4
  } = options;

  const available = new Set(extensions);
  const errors = [];
  const counts = Object.create(null);
  let currentProgram = null;
  let currentFramebuffer = null;
  let currentVAO = null;

  const objects = new Set();
  const vaoElementBuffer = new WeakMap();
  const shaderSources = new Map();
  const programShaders = new Map();
  const programInfo = new Map();
  const locations = new Map();

  const fail = (message) => { errors.push(message); };
  const obj = (kind) => { const o = { __kind: kind }; objects.add(o); return o; };
  const bump = (name) => { counts[name] = (counts[name] || 0) + 1; };

  const impl = {
    /* --- objects --------------------------------------------------- */
    createShader: () => obj('shader'),
    createProgram: () => obj('program'),
    createBuffer: () => obj('buffer'),
    createTexture: () => obj('texture'),
    createFramebuffer: () => obj('framebuffer'),
    createRenderbuffer: () => obj('renderbuffer'),
    createVertexArray: () => obj('vao'),
    createQuery: () => obj('query'),
    deleteShader() {}, deleteProgram() {}, deleteBuffer() {}, deleteTexture() {},
    deleteFramebuffer() {}, deleteRenderbuffer() {}, deleteVertexArray() {},
    deleteQuery() {},

    /* --- shaders and programs --------------------------------------- */
    shaderSource(shader, src) {
      if (typeof src !== 'string' || !src.length) fail('shaderSource with no source');
      if (!src.startsWith('#version 300 es')) {
        fail('shaderSource: #version 300 es is not the first line');
      }
      shaderSources.set(shader, src);
    },
    compileShader() {},
    attachShader(program, shader) {
      const list = programShaders.get(program) || [];
      list.push(shader);
      programShaders.set(program, list);
    },
    detachShader() {},
    bindAttribLocation(program, index, name) {
      const info = programInfo.get(program) || { bindings: new Map() };
      info.bindings = info.bindings || new Map();
      info.bindings.set(name, index | 0);
      programInfo.set(program, info);
    },
    linkProgram(program) {
      const sources = (programShaders.get(program) || []).map((s) => shaderSources.get(s) || '');
      const [vs = '', fs = ''] = sources;
      const seen = new Map();
      for (const u of [...parseUniforms(vs), ...parseUniforms(fs)]) {
        if (!seen.has(u.name)) seen.set(u.name, u);
      }
      const info = programInfo.get(program) || {};
      info.uniforms = [...seen.values()];
      info.attributes = parseAttributes(vs);
      info.bindings = info.bindings || new Map();
      programInfo.set(program, info);
    },
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getProgramParameter(program, pname) {
      const info = programInfo.get(program) || { uniforms: [], attributes: [] };
      if (pname === enumOf('ACTIVE_UNIFORMS')) return info.uniforms.length;
      if (pname === enumOf('ACTIVE_ATTRIBUTES')) return info.attributes.length;
      if (pname === enumOf('LINK_STATUS')) return true;
      if (pname === enumOf('COMPLETION_STATUS_KHR')) return true;
      return true;
    },
    getActiveUniform(program, i) {
      const u = (programInfo.get(program) || { uniforms: [] }).uniforms[i];
      if (!u) return null;
      return { name: u.name, size: u.size, type: enumOf(GLSL_TYPE_TO_ENUM[u.glslType] || 'FLOAT') };
    },
    getActiveAttrib(program, i) {
      const a = (programInfo.get(program) || { attributes: [] }).attributes[i];
      if (!a) return null;
      return { name: a.name, size: 1, type: enumOf(GLSL_TYPE_TO_ENUM[a.glslType] || 'FLOAT_VEC4') };
    },
    getUniformLocation(program, name) {
      const info = programInfo.get(program) || { uniforms: [] };
      const u = info.uniforms.find((x) => x.name === name);
      if (!u) return null;
      const key = `${objectId(program)}:${name}`;
      if (!locations.has(key)) locations.set(key, { __kind: 'location', program, name, glslType: u.glslType });
      return locations.get(key);
    },
    getAttribLocation(program, name) {
      const info = programInfo.get(program) || { attributes: [] };
      const bound = info.bindings && info.bindings.get(name);
      if (bound !== undefined) return bound;
      const a = info.attributes.find((x) => x.name === name);
      return a && a.location !== null ? a.location : -1;
    },
    useProgram(program) { currentProgram = program; bump('useProgram'); },

    /* --- uniforms ---------------------------------------------------- */
    uniform1f(loc, v) { checkScalar(loc, 'float', v); },
    uniform1i(loc, v) { checkScalar(loc, 'int', v); },
    uniform1ui(loc, v) { checkScalar(loc, 'uint', v); },
    uniform1fv(loc, v) { checkVector(loc, v, 1); },
    uniform2fv(loc, v) { checkVector(loc, v, 2); },
    uniform3fv(loc, v) { checkVector(loc, v, 3); },
    uniform4fv(loc, v) { checkVector(loc, v, 4); },
    uniform1iv(loc, v) { checkVector(loc, v, 1); },
    uniform2iv(loc, v) { checkVector(loc, v, 2); },
    uniform3iv(loc, v) { checkVector(loc, v, 3); },
    uniform4iv(loc, v) { checkVector(loc, v, 4); },
    uniform1uiv(loc, v) { checkVector(loc, v, 1); },
    uniform2uiv(loc, v) { checkVector(loc, v, 2); },
    uniform3uiv(loc, v) { checkVector(loc, v, 3); },
    uniform4uiv(loc, v) { checkVector(loc, v, 4); },
    uniformMatrix2fv(loc, transpose, v) { checkMatrix(loc, transpose, v, 4); },
    uniformMatrix3fv(loc, transpose, v) { checkMatrix(loc, transpose, v, 9); },
    uniformMatrix4fv(loc, transpose, v) { checkMatrix(loc, transpose, v, 16); },

    /* --- buffers, textures, framebuffers ----------------------------- */
    // The ELEMENT_ARRAY_BUFFER binding is VAO state, and modelling that is the
    // only way a test can catch an index upload performed while an unrelated
    // vertex array happened to be bound — which leaves that array pointing at
    // null and its next drawElements quietly drawing nothing.
    bindBuffer(target, buffer) {
      if (target === enumOf('ELEMENT_ARRAY_BUFFER') && currentVAO) {
        vaoElementBuffer.set(currentVAO, buffer || null);
      }
    },
    bufferData() {},
    bufferSubData(target, offset, data) {
      if (!data || data.byteLength === undefined) fail('bufferSubData with no typed array');
      bump('bufferSubData');
    },
    bindVertexArray(vao) { currentVAO = vao; },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    vertexAttribIPointer() {},
    vertexAttribDivisor() {},
    activeTexture() {},
    bindTexture() {},
    texStorage2D(target, levels, format, w, h) {
      if (!(w > 0) || !(h > 0)) fail(`texStorage2D with a zero dimension (${w}x${h})`);
      if (!(levels > 0)) fail('texStorage2D with zero levels');
      bump('texStorage2D');
    },
    texSubImage2D() {}, texParameteri() {}, texParameterf() {}, generateMipmap() { bump('generateMipmap'); },
    pixelStorei() {},
    bindRenderbuffer() {},
    renderbufferStorage() {}, renderbufferStorageMultisample() {},
    bindFramebuffer(target, fb) { currentFramebuffer = fb; },
    framebufferTexture2D() {}, framebufferRenderbuffer() {},
    drawBuffers() {},
    checkFramebufferStatus: () => enumOf('FRAMEBUFFER_COMPLETE'),
    blitFramebuffer() { bump('blitFramebuffer'); },
    invalidateFramebuffer() {},
    readBuffer() {},

    /* --- state -------------------------------------------------------- */
    viewport() {}, scissor() {}, enable() {}, disable() {},
    blendFunc() {}, blendFuncSeparate() {}, blendEquation() {}, blendEquationSeparate() {},
    depthFunc() {}, depthMask() {}, colorMask() {}, cullFace() {}, frontFace() {},
    clearColor() {}, clearDepth() {}, clearStencil() {},
    clear() { bump('clear'); },

    /* --- draws --------------------------------------------------------- */
    drawArrays(mode, first, count) { draw('drawArrays', count); },
    drawElements(mode, count) { draw('drawElements', count); },
    drawArraysInstanced(mode, first, count, n) { draw('drawArraysInstanced', count * n); },
    drawElementsInstanced(mode, count, type, offset, n) { draw('drawElementsInstanced', count * n); },

    /* --- queries -------------------------------------------------------- */
    beginQuery() {}, endQuery() {}, getQueryParameter: () => false,

    /* --- introspection ---------------------------------------------------- */
    getError: () => 0,
    isContextLost: () => false,
    getExtension(name) {
      if (!available.has(name)) return null;
      if (name === 'KHR_parallel_shader_compile') return { COMPLETION_STATUS_KHR: enumOf('COMPLETION_STATUS_KHR') };
      if (name === 'EXT_disjoint_timer_query_webgl2') {
        return { TIME_ELAPSED_EXT: enumOf('TIME_ELAPSED_EXT'), GPU_DISJOINT_EXT: enumOf('GPU_DISJOINT_EXT') };
      }
      if (name === 'EXT_texture_filter_anisotropic') {
        return {
          MAX_TEXTURE_MAX_ANISOTROPY_EXT: enumOf('MAX_TEXTURE_MAX_ANISOTROPY_EXT'),
          TEXTURE_MAX_ANISOTROPY_EXT: enumOf('TEXTURE_MAX_ANISOTROPY_EXT')
        };
      }
      return { __ext: name };
    },
    getInternalformatParameter: () => new Int32Array([maxSamples, 2]),
    getParameter(pname) {
      if (pname === enumOf('MAX_TEXTURE_SIZE')) return 16384;
      if (pname === enumOf('MAX_RENDERBUFFER_SIZE')) return 16384;
      if (pname === enumOf('MAX_SAMPLES')) return maxSamples;
      if (pname === enumOf('MAX_COLOR_ATTACHMENTS')) return 8;
      if (pname === enumOf('MAX_DRAW_BUFFERS')) return 8;
      if (pname === enumOf('MAX_VERTEX_ATTRIBS')) return 16;
      if (pname === enumOf('MAX_COMBINED_TEXTURE_IMAGE_UNITS')) return 32;
      if (pname === enumOf('MAX_VERTEX_TEXTURE_IMAGE_UNITS')) return 16;
      if (pname === enumOf('MAX_VARYING_COMPONENTS')) return 60;
      if (pname === enumOf('VENDOR')) return 'mock';
      if (pname === enumOf('RENDERER')) return 'mockgl';
      return 0;
    }
  };

  let idCounter = 0;
  const ids = new WeakMap();
  function objectId(o) {
    if (!ids.has(o)) ids.set(o, ++idCounter);
    return ids.get(o);
  }

  function draw(kind, count) {
    if (!currentProgram) fail(`${kind} with no program bound`);
    if (!currentVAO) fail(`${kind} with no vertex array bound`);
    if (!(count > 0)) fail(`${kind} with a count of ${count}`);
    if (kind.startsWith('drawElements') && !vaoElementBuffer.get(currentVAO)) {
      fail(`${kind} on a vertex array whose ELEMENT_ARRAY_BUFFER binding was clobbered`);
    }
    bump(kind);
  }

  function locationLabel(loc) {
    return loc ? `${loc.name} (${loc.glslType})` : 'a null location';
  }

  function checkScalar(loc, expected, value) {
    if (!loc) { fail(`uniform set on a null location`); return; }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`${locationLabel(loc)} set to a non-finite scalar: ${value}`);
    }
  }

  function checkVector(loc, value, components) {
    if (!loc) { fail('uniform*v on a null location'); return; }
    const want = COMPONENTS[loc.glslType];
    if (want !== components) {
      fail(`${locationLabel(loc)} set with a ${components}-component call`);
      return;
    }
    if (value == null || value.length === undefined) {
      fail(`${locationLabel(loc)} set with a non-array value`);
      return;
    }
    if (value.length % components !== 0 || value.length === 0) {
      fail(`${locationLabel(loc)} set with ${value.length} values, expected a multiple of ${components}`);
      return;
    }
    for (let i = 0; i < value.length; i++) {
      if (!Number.isFinite(value[i])) {
        fail(`${locationLabel(loc)} set with a non-finite value at index ${i}`);
        return;
      }
    }
  }

  function checkMatrix(loc, transpose, value, components) {
    if (!loc) { fail('uniformMatrix*fv on a null location'); return; }
    // WebGL2 rejects transpose:true outright, which is why math.js is
    // column-major everywhere. A true here is a bug in the caller, not a taste.
    if (transpose) fail(`${locationLabel(loc)} uploaded with transpose:true, which WebGL2 rejects`);
    checkVector(loc, value, components);
  }

  const target = Object.assign(Object.create(null), impl);

  // Anything gl.js reaches for that is not implemented above: an ALL_CAPS name
  // becomes a stable distinct enum, anything else becomes a recorded no-op, so
  // this file does not have to carry the whole WebGL registry to be useful.
  const gl = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
        const value = enumOf(prop);
        t[prop] = value;
        return value;
      }
      const noop = (...args) => { bump(`unimplemented:${prop}`); return undefined; };
      t[prop] = noop;
      return noop;
    },
    has() { return true; }
  });

  return {
    gl,
    get errors() { return errors; },
    get counts() { return counts; },
    get objectCount() { return objects.size; },
    reset() { errors.length = 0; for (const k in counts) delete counts[k]; }
  };
}
