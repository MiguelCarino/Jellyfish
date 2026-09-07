/* ============================================================
   tests/check.mjs — the static check, runnable without a browser.

       node tests/check.mjs            # everything
       node tests/check.mjs graph      # named sections only
       node tests/check.mjs glsl

   There is no GPU here and no npm, so this cannot prove the page
   renders. What it CAN prove is the whole class of failure that
   comes from five people writing modules against a written
   contract in parallel: an import that names an export nobody
   wrote, a uniform the JS sets under a name the GLSL never
   declares, a vertex output with no matching fragment input, a
   function called in a stage whose declaration lives in an
   include that stage was not given. Every one of those is a blank
   page in a browser and a one-line diff here.

   The GLSL section assembles each program EXACTLY as
   render/frame.js does — it imports frame.js's own program table
   rather than restating it — so a program that is added or has
   its defines changed is checked automatically, and a check that
   passes here is a check of the string the driver will actually
   see.

   Sections
     syntax  every .js parses as an ES module
     graph   every import resolves, every named import exists,
             no import cycle
     glsl    every assembled program is well-formed: #version at
             byte 0, precision declared, no duplicate definitions
             across concatenated includes, every call resolves,
             vertex outs match fragment ins
     wiring  every uniform/attribute name frame.js sets exists in
             the program it sets it on, and vice versa for the
             attributes the geometry binds
     agree   sim/deform.js's JS and its GLSL twin still describe
             the same surface (numeric, 10-point probe)
   ============================================================ */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const JS = join(ROOT, 'js');

let failures = 0;
let checks = 0;

function ok(name) {
  checks += 1;
  console.log(`PASS :: ${name}`);
}

function fail(name, detail) {
  checks += 1;
  failures += 1;
  console.log(`FAIL :: ${name}`);
  if (detail) {
    for (const line of String(detail).split('\n')) console.log(`         ${line}`);
  }
}

function assert(cond, name, detail) {
  if (cond) ok(name); else fail(name, detail);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const SOURCES = walk(JS).sort();

/* ============================================================
   Section: syntax
   ============================================================ */

/**
 * The smallest DOM that lets js/main.js boot. It is deliberately not a jsdom —
 * this is a zero-dependency repo — and it is deliberately enough to reach the
 * §10 checklist item "no WebGL2 at all: the poster frame renders, the page does
 * not error": `getContext` returns null, so main.js takes exactly the path a
 * browser without WebGL2 takes, and any throw on that path fails here.
 */
function installDomShim() {
  if (globalThis.document) return () => {};

  const makeElement = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      style: { cssText: '' },
      classList: { add() {}, remove() {}, contains() { return false; } },
      clientWidth: 1280,
      clientHeight: 720,
      textContent: '',
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) { el.children.push(child); return child; },
      append(...kids) { el.children.push(...kids); },
      remove() {},
      getContext() { return null; }
    };
    return el;
  };

  const host = makeElement('main');
  const canvas = makeElement('canvas');
  host.appendChild(canvas);

  globalThis.document = {
    hidden: false,
    getElementById(id) { return id === 'sea' ? host : (id === 'gl' ? canvas : null); },
    createElement: makeElement,
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.window = { matchMedia: undefined };
  globalThis.location = { search: '' };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};

  return () => {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.location;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  };
}

async function sectionSyntax() {
  console.log('\n-- syntax --');
  const removeDom = installDomShim();
  try {
    for (const file of SOURCES) {
      const rel = relative(ROOT, file);
      try {
        // Importing is a stronger check than parsing: it also runs the module's
        // top-level code, which is where profile.js integrates its arc length,
        // cookie.js measures the gobo's mean and main.js boots. A module that
        // throws at load is a blank page, and this is the cheapest place to
        // find out.
        await import(pathToFileURL(file).href);
        ok(`loads: ${rel}`);
      } catch (err) {
        fail(`loads: ${rel}`, err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
      }
    }
  } finally {
    removeDom();
  }
}

/* ============================================================
   Section: graph — imports resolve, named exports exist, no cycles
   ============================================================ */

const IMPORT_RE = /^\s*(?:import|export)\s+(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;

function parseImports(source) {
  const out = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const clause = (m[1] || '').trim();
    const spec = m[2];
    const names = [];
    const braced = clause.match(/\{([\s\S]*?)\}/);
    if (braced) {
      for (const piece of braced[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0].trim();
        if (name && name !== 'default' && name !== '*') names.push(name);
      }
    }
    out.push({ spec, names, star: /\*\s+as\s+/.test(clause) });
  }
  return out;
}

async function sectionGraph() {
  console.log('\n-- graph --');

  const edges = new Map();

  for (const file of SOURCES) {
    const rel = relative(ROOT, file);
    const source = readFileSync(file, 'utf8');
    const imports = parseImports(source);
    const deps = [];

    for (const { spec, names } of imports) {
      if (!spec.startsWith('.')) {
        fail(`import resolves: ${rel} -> ${spec}`, 'bare specifier: no npm, no CDN, no import map');
        continue;
      }
      const target = resolvePath(dirname(file), spec);
      let exists = true;
      try { statSync(target); } catch { exists = false; }
      if (!exists) {
        fail(`import resolves: ${rel} -> ${spec}`, `no file at ${relative(ROOT, target)}`);
        continue;
      }
      deps.push(target);

      let mod;
      try {
        mod = await import(pathToFileURL(target).href);
      } catch (err) {
        fail(`import loads: ${rel} -> ${spec}`, err && err.message);
        continue;
      }
      const missing = names.filter((n) => !(n in mod));
      if (missing.length) {
        fail(`named exports: ${rel} -> ${spec}`, `missing: ${missing.join(', ')}`);
      }
    }
    edges.set(file, deps);
  }
  ok('every import resolves to a file in this repo');

  // Cycles. ES modules tolerate many cycles, but a cycle through a module that
  // reads an imported binding at TOP LEVEL — which several of these do, to
  // build a frozen include array — is a TDZ crash at load, so they are worth
  // refusing outright rather than tolerating until one bites.
  const state = new Map();
  const cycles = [];
  function visit(node, stack) {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'open') {
      cycles.push(stack.slice(stack.indexOf(node)).concat(node).map((f) => relative(ROOT, f)));
      return;
    }
    state.set(node, 'open');
    stack.push(node);
    for (const dep of edges.get(node) || []) visit(dep, stack);
    stack.pop();
    state.set(node, 'done');
  }
  for (const file of SOURCES) visit(file, []);
  assert(cycles.length === 0, 'no import cycles',
    cycles.map((c) => c.join(' -> ')).join('\n'));
}

/* ============================================================
   Section: glsl — assemble every shipped program and check it
   ============================================================ */

// Identifiers the language provides. Anything called that is neither here nor
// declared in the assembled source is a link error on a real driver.
const GLSL_BUILTINS = new Set([
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh',
  'tanh', 'asinh', 'acosh', 'atanh', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt',
  'inversesqrt', 'abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil',
  'fract', 'mod', 'modf', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep',
  'isnan', 'isinf', 'floatBitsToInt', 'floatBitsToUint', 'intBitsToFloat',
  'uintBitsToFloat', 'packSnorm2x16', 'unpackSnorm2x16', 'packUnorm2x16',
  'unpackUnorm2x16', 'packHalf2x16', 'unpackHalf2x16', 'length', 'distance', 'dot',
  'cross', 'normalize', 'faceforward', 'reflect', 'refract', 'matrixCompMult',
  'outerProduct', 'transpose', 'determinant', 'inverse', 'lessThan',
  'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'equal', 'notEqual', 'any',
  'all', 'not', 'textureSize', 'texture', 'textureProj', 'textureLod',
  'textureOffset', 'texelFetch', 'texelFetchOffset', 'textureProjOffset',
  'textureLodOffset', 'textureProjLod', 'textureProjLodOffset', 'textureGrad',
  'textureGradOffset', 'textureProjGrad', 'textureProjGradOffset', 'dFdx', 'dFdy',
  'fwidth', 'main',
  // constructors and types
  'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4',
  'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3',
  'mat4x4', 'struct', 'return', 'if', 'for', 'while', 'switch', 'do'
]);

const FUNC_DEF_RE =
  /^[ \t]*(?:(?:highp|mediump|lowp)\s+)?(?:const\s+)?(void|float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|bvec2|bvec3|bvec4|mat2|mat3|mat4|mat2x2|mat2x3|mat2x4|mat3x2|mat3x3|mat3x4|mat4x2|mat4x3|mat4x4)\s+([A-Za-z_]\w*)\s*\(/gm;

const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;

/** Strips comments and the bodies of #if 0 style blocks are left alone. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Evaluates the subset of the preprocessor these shaders actually use:
 * #define of an object-like macro, #ifdef / #ifndef / #else / #endif, and
 * #if defined(X). That is enough to walk BOTH arms of every conditional the
 * project ships, which is the point — an #ifdef arm that only compiles on an
 * iPhone is exactly the arm nobody tests.
 */
function preprocess(src, defines) {
  const defined = new Set(Object.keys(defines));
  const lines = src.split('\n');
  const out = [];
  const stack = [];
  let active = true;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#ifdef') || t.startsWith('#ifndef') || t.startsWith('#if ')) {
      let value;
      if (t.startsWith('#ifdef')) value = defined.has(t.slice(6).trim());
      else if (t.startsWith('#ifndef')) value = !defined.has(t.slice(7).trim());
      else {
        const m = t.match(/defined\s*\(?\s*([A-Za-z_]\w*)/);
        value = m ? defined.has(m[1]) : true;
        if (/^#if\s+0\s*$/.test(t)) value = false;
        if (/^#if\s+1\s*$/.test(t)) value = true;
      }
      stack.push(active);
      active = active && value;
      out.push('');
      continue;
    }
    if (t.startsWith('#else')) {
      const parent = stack[stack.length - 1];
      active = parent && !active;
      out.push('');
      continue;
    }
    if (t.startsWith('#endif')) {
      active = stack.pop();
      out.push('');
      continue;
    }
    if (!active) { out.push(''); continue; }
    if (t.startsWith('#define')) {
      const m = t.match(/^#define\s+([A-Za-z_]\w*)/);
      if (m) defined.add(m[1]);
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), defined };
}

/** The defines that survive definesToGLSL: false / null / undefined are omitted. */
function activeDefines(defines) {
  const out = {};
  for (const [k, v] of Object.entries(defines || {})) {
    if (v === false || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Every macro #defined anywhere in the source, so a call to one is not "undeclared". */
function macroNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^\s*#define\s+([A-Za-z_]\w*)/gm)) names.add(m[1]);
  return names;
}

function declaredFunctions(src) {
  const names = new Set();
  FUNC_DEF_RE.lastIndex = 0;
  let m;
  while ((m = FUNC_DEF_RE.exec(src)) !== null) names.add(m[2]);
  // Struct declarations create a constructor of the same name.
  for (const s of src.matchAll(/\bstruct\s+([A-Za-z_]\w*)/g)) names.add(s[1]);
  return names;
}

function duplicateFunctions(src) {
  const seen = new Map();
  const dupes = [];
  // Only DEFINITIONS collide; a prototype followed by a body is legal. A
  // definition is a signature followed by '{' on the same logical statement.
  const re = new RegExp(FUNC_DEF_RE.source, 'gm');
  let m;
  while ((m = re.exec(src)) !== null) {
    const after = src.slice(m.index);
    const close = after.indexOf(')');
    if (close < 0) continue;
    const tail = after.slice(close + 1, close + 40).trim();
    if (!tail.startsWith('{')) continue;              // a prototype, not a body
    const key = m[2];
    const argsText = after.slice(after.indexOf('(') + 1, close);
    const arity = argsText.trim() === '' || argsText.trim() === 'void'
      ? 0 : argsText.split(',').length;
    const sig = `${key}/${arity}`;
    if (seen.has(sig)) dupes.push(sig); else seen.set(sig, true);
  }
  return dupes;
}

function declaredUniforms(src) {
  const out = new Map();
  for (const m of src.matchAll(
    /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/gm)) {
    out.set(m[2], m[1]);
  }
  return out;
}

function declaredIO(src, keyword) {
  const out = new Map();
  const re = new RegExp(
    `^\\s*(?:layout\\s*\\([^)]*\\)\\s*)?(?:flat\\s+)?${keyword}\\s+(?:(?:highp|mediump|lowp)\\s+)?([A-Za-z_]\\w*)\\s+([A-Za-z_]\\w*)\\s*;`, 'gm');
  for (const m of src.matchAll(re)) out.set(m[2], m[1]);
  return out;
}

function balanced(src) {
  let brace = 0, paren = 0;
  for (const ch of src) {
    if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    if (brace < 0 || paren < 0) return false;
  }
  return brace === 0 && paren === 0;
}

function checkStage(label, source, defines) {
  const first = source.split('\n', 1)[0];
  assert(first === '#version 300 es', `${label}: #version 300 es at byte 0`,
    `first line was: ${JSON.stringify(first.slice(0, 60))}`);
  assert(/^#version/.test(source), `${label}: nothing precedes #version`);

  assert(/precision\s+highp\s+float\s*;/.test(source), `${label}: highp float declared`);
  if (/sampler2D/.test(source)) {
    assert(/precision\s+highp\s+sampler2D\s*;/.test(source),
      `${label}: highp sampler2D declared`,
      'ES 3.00 defaults sampler2D to lowp in BOTH languages; an RGBA16F ' +
      'target read through it quantises visibly on tile GPUs');
    // A precision statement binds only what follows it, so asserting the
    // statement exists is not enough: it has to outrank every declaration.
    const qualifier = source.indexOf('precision highp sampler2D;');
    const declaration = source.indexOf('uniform sampler2D');
    assert(declaration < 0 || qualifier < declaration,
      `${label}: highp sampler2D precedes the first sampler declaration`,
      `qualifier at offset ${qualifier}, first declaration at ${declaration}`);
  }

  const clean = stripComments(source);
  assert(balanced(clean), `${label}: braces and parens balance`);
  assert(!/\$\{/.test(source), `${label}: no unexpanded template placeholder`);

  const dupes = duplicateFunctions(clean);
  assert(dupes.length === 0, `${label}: no duplicate function definitions`, dupes.join(', '));

  // Walk both arms of every conditional: a shader that only links on the RGBA8
  // path is a shader nobody runs until someone opens it on an old iPad.
  const { text } = preprocess(clean, defines);
  const decls = declaredFunctions(text);
  const macros = macroNames(clean);
  const structs = new Set([...text.matchAll(/\bstruct\s+([A-Za-z_]\w*)/g)].map((m) => m[1]));

  const unknown = new Set();
  for (const m of text.matchAll(CALL_RE)) {
    const name = m[1];
    if (GLSL_BUILTINS.has(name) || decls.has(name) || macros.has(name) || structs.has(name)) continue;
    // `foo (` where foo is a keyword-ish control word, or a declaration like
    // `vec3 name(`; the FUNC_DEF_RE pass already registered real definitions.
    if (/^(else|return|discard|const|in|out|inout|uniform|layout|precision|flat|smooth)$/.test(name)) continue;
    unknown.add(name);
  }
  assert(unknown.size === 0, `${label}: every call resolves to a declaration`,
    [...unknown].join(', '));

  return { source, clean, text, decls };
}

async function sectionGlsl() {
  console.log('\n-- glsl --');

  const { describePrograms } = await import(pathToFileURL(join(JS, 'render/frame.js')).href);
  const { assembleProgramSources } = await import(pathToFileURL(join(JS, 'shaders/common.js')).href);

  // Both capability branches. The RGBA8 / analytic-thickness path is a real
  // shipping configuration (§2.5), not a degraded one, and it is the one no
  // developer machine exercises by accident.
  const configurations = [
    { label: 'float', floatPath: true, manualBilinear: false, msaaSamples: 0 },
    { label: 'rgba8', floatPath: false, manualBilinear: true, msaaSamples: 0 },
    { label: 'msaa', floatPath: true, manualBilinear: false, msaaSamples: 4 }
  ];

  const seen = new Set();

  for (const config of configurations) {
    for (const entry of describePrograms(config)) {
      const key = `${entry.name}|${JSON.stringify(entry.spec.defines || {})}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let src;
      try {
        src = assembleProgramSources(entry.spec);
      } catch (err) {
        fail(`${config.label}/${entry.name}: assembles`, err && err.message);
        continue;
      }

      const defines = activeDefines(entry.spec.defines);

      const vs = checkStage(`${entry.name}.vs`, src.vertex, defines);
      const fs = checkStage(`${entry.name}.fs`, src.fragment, defines);

      // Vertex outputs and fragment inputs are two halves of one interface; a
      // mismatch links on some drivers and silently reads garbage on others.
      const outs = declaredIO(vs.text, 'out');
      const ins = declaredIO(fs.text, 'in');
      const missing = [];
      for (const [name, type] of ins) {
        if (name === 'gl_FragCoord') continue;
        if (!outs.has(name)) missing.push(`${name} (fs in, no vs out)`);
        else if (outs.get(name) !== type) {
          missing.push(`${name}: vs ${outs.get(name)} vs fs ${type}`);
        }
      }
      assert(missing.length === 0, `${entry.name}: vertex outs match fragment ins`,
        missing.join('\n'));

      // A uniform declared in both stages must agree in type, or the link fails.
      const uv = declaredUniforms(vs.text);
      const uf = declaredUniforms(fs.text);
      const clash = [];
      for (const [name, type] of uv) {
        if (uf.has(name) && uf.get(name) !== type) {
          clash.push(`${name}: vs ${type} vs fs ${uf.get(name)}`);
        }
      }
      assert(clash.length === 0, `${entry.name}: shared uniforms agree in type`, clash.join('\n'));

      entry.declaredUniforms = new Set([...uv.keys(), ...uf.keys()]);
      entry.declaredAttributes = new Set([...declaredIO(vs.text, 'in').keys()]);
    }
  }
}

/* ============================================================
   Section: wiring — the names frame.js uses against the names
   the GLSL declares
   ============================================================ */

async function sectionWiring() {
  console.log('\n-- wiring --');

  const frame = await import(pathToFileURL(join(JS, 'render/frame.js')).href);
  const { assembleProgramSources } = await import(pathToFileURL(join(JS, 'shaders/common.js')).href);

  // Both capability branches. `entry.uniforms` is frame.js's own list of what
  // its passes set on that program, published beside the sources rather than
  // restated here, so a renamed uniform fails on the next run instead of
  // becoming a silent no-op in a browser.
  const configs = [
    { label: 'float', floatPath: true, manualBilinear: false, msaaSamples: 0 },
    { label: 'rgba8', floatPath: false, manualBilinear: true, msaaSamples: 0 },
    { label: 'msaa', floatPath: true, manualBilinear: false, msaaSamples: 4 }
  ];

  for (const config of configs) {
    for (const entry of frame.describePrograms(config)) {
      const src = assembleProgramSources(entry.spec);
      const defines = activeDefines(entry.spec.defines);
      const vs = preprocess(stripComments(src.vertex), defines).text;
      const fs = preprocess(stripComments(src.fragment), defines).text;

      const uniforms = new Set([
        ...declaredUniforms(vs).keys(),
        ...declaredUniforms(fs).keys()
      ]);
      const missing = entry.uniforms.filter((u) => !uniforms.has(u));
      assert(missing.length === 0, `wiring: ${config.label}/${entry.name} uniforms declared`,
        `set by frame.js but not declared in the GLSL: ${missing.join(', ')}`);

      // The other direction: an attribute bound to a fixed location at link
      // time that the vertex source never declares is not an error, but it is
      // always a mistake — it means the VAO and the shader disagree about the
      // vertex format, which draws garbage rather than failing.
      const attributes = new Set(declaredIO(vs, 'in').keys());
      const locations = entry.spec.attributeLocations || {};
      const absent = Object.keys(locations).filter((a) => !attributes.has(a));
      assert(absent.length === 0, `wiring: ${config.label}/${entry.name} attributes declared`,
        `bound at link time but absent from the vertex source: ${absent.join(', ')}`);
    }
  }

  // The vertex formats the geometry builders fill, against the locations the
  // programs bind. A mismatch here is the classic "everything is drawn at the
  // origin" failure and nothing in the GLSL can catch it.
  const bell = await import(pathToFileURL(join(JS, 'geometry/bell.js')).href);
  const strands = await import(pathToFileURL(join(JS, 'geometry/strands.js')).href);
  const strandShader = await import(pathToFileURL(join(JS, 'shaders/strands.js')).href);
  const snowShader = await import(pathToFileURL(join(JS, 'shaders/snow.js')).href);
  const snowSim = await import(pathToFileURL(join(JS, 'sim/snow.js')).href);

  assert(JSON.stringify(strands.STRAND_ATTRIBUTE_LOCATIONS) ===
         JSON.stringify(strandShader.STRAND_ATTRIBUTE_LOCATIONS),
    'wiring: strand attribute locations agree between the packer and the shader',
    `${JSON.stringify(strands.STRAND_ATTRIBUTE_LOCATIONS)} vs ` +
    `${JSON.stringify(strandShader.STRAND_ATTRIBUTE_LOCATIONS)}`);

  assert(bell.BELL_VERTEX_FLOATS * 4 === bell.BELL_VERTEX_BYTES,
    'wiring: the bell vertex stride is its float count');

  // sim/snow.js packs 8 floats a mote and shaders/snow.js reads a vec3 at
  // offset 3: (radius, brightness, fade). The instance buffer is uploaded
  // verbatim, so those two layouts have to be the same layout.
  assert(snowSim.SNOW_STRIDE === 8 &&
         snowSim.SNOW_FIELDS.RADIUS === 3 &&
         snowSim.SNOW_FIELDS.BRIGHTNESS === 4 &&
         snowSim.SNOW_FIELDS.FADE === 5,
    'wiring: the snow instance layout matches aSnowParam',
    JSON.stringify(snowSim.SNOW_FIELDS));

  assert(snowShader.SNOW_SPRITE.length === snowShader.SNOW_SPRITE_SIZE ** 2,
    'wiring: the bokeh sprite is one R8 texel per pixel');
}

/* ============================================================
   Section: agree — the CPU deform and the GPU deform
   ============================================================ */

async function sectionAgree() {
  console.log('\n-- agree --');

  const deform = await import(pathToFileURL(join(JS, 'sim/deform.js')).href);
  const bell = await import(pathToFileURL(join(JS, 'shaders/bell.js')).href);

  // §4.2 is emphatic that the vertex shader and the tentacle roots share ONE
  // definition. The structural guarantee is that shaders/bell.js re-exports
  // sim/deform.js's string rather than writing its own; assert it, because the
  // failure mode of a second copy is a fringe that detaches from the margin on
  // the contraction stroke and nothing that looks like an error.
  assert(bell.DEFORM_GLSL === deform.DEFORM_GLSL,
    'agree: shaders/bell.js ships sim/deform.js\'s GLSL, not a second copy');

  // And that the GLSL carries the same constants the JS half evaluates.
  const glsl = deform.DEFORM_GLSL;
  const constants = {
    BELL_PULSE_C: deform.DEFORM.CONTRACTION_FRACTION,
    BELL_WAVE_LAG: deform.DEFORM.WAVE_LAG,
    BELL_RADIAL_SQUEEZE: deform.DEFORM.RADIAL_SQUEEZE,
    BELL_MARGIN_CURL: deform.DEFORM.MARGIN_CURL,
    BELL_APEX_DOME: deform.DEFORM.APEX_DOME,
    BELL_STROKE_AMPLITUDE: deform.DEFORM.AMPLITUDE
  };
  const wrong = [];
  for (const [macro, value] of Object.entries(constants)) {
    const m = glsl.match(new RegExp(`#define\\s+${macro}\\s+([-\\d.eE+]+)`));
    if (!m) { wrong.push(`${macro}: not defined in the GLSL`); continue; }
    if (Math.abs(Number(m[1]) - value) > 1e-9) {
      wrong.push(`${macro}: GLSL ${m[1]} vs JS ${value}`);
    }
  }
  assert(wrong.length === 0, 'agree: deform constants match across languages', wrong.join('\n'));

  // The probe grid, evaluated on the CPU. It cannot be evaluated on the GPU
  // from here, but it CAN be checked for the properties the shader relies on:
  // finite everywhere, the margin actually moving, and the apex held still by
  // the activation dead zone.
  const probe = deform.deformProbe();
  const bad = probe.filter((row) => !row.deformed.every(Number.isFinite));
  assert(bad.length === 0, 'agree: deform is finite over the probe grid');

  const apex = deform.contraction(0.2, 0.0, 1.0);
  assert(Math.abs(apex) < 1e-6, 'agree: the apex is inside the activation dead zone',
    `contraction(phase=0.2, phi=0) = ${apex}`);

  let maxMargin = 0;
  for (let i = 0; i < 64; i++) {
    maxMargin = Math.max(maxMargin, Math.abs(deform.contraction(i / 64, 1.0, 1.0)));
  }
  assert(maxMargin > 0.1, 'agree: the margin contracts', `peak |k| at phi=1 was ${maxMargin}`);

  // §4.1's waveform exists twice: sim/deform.js owns the vertex-shader-facing
  // copy and sim/swim.js owns the integrator's. They were written in parallel
  // and they agree today; two copies of a waveform can drift, and the symptom
  // would be the bell's thrust peaking at a different instant from its
  // contraction, which reads as an animal fighting its own muscle.
  const swim = await import(pathToFileURL(join(JS, 'sim/swim.js')).href);
  let worstPulse = 0;
  let worstSlope = 0;
  for (let i = 0; i < 20000; i++) {
    const x = i / 10000;              // covers [0, 2), i.e. past the wrap
    worstPulse = Math.max(worstPulse, Math.abs(deform.pulse(x) - swim.pulse(x)));
    worstSlope = Math.max(worstSlope,
      Math.abs(deform.pulseVelocity(x) - swim.pulseDerivative(x)));
  }
  assert(worstPulse === 0, 'agree: sim/deform.js and sim/swim.js are the same pulse',
    `worst |delta| = ${worstPulse}`);
  assert(worstSlope === 0, 'agree: and the same analytic derivative',
    `worst |delta| = ${worstSlope}`);
  assert(swim.pulse === deform.pulse && swim.pulseDerivative === deform.pulseVelocity,
    'agree: literally one function, not two that happen to match');

  // The waveform constants live in two frozen tables. They describe the same
  // four numbers and nothing enforces that but this.
  const waveform = [
    ['CONTRACTION_FRACTION', 'CONTRACTION_FRACTION'],
    ['RECOIL_DECAY', 'RECOIL_DECAY'],
    ['RECOIL_RING', 'RECOIL_RING'],
    ['CONTRACTION_EXPONENT', 'CONTRACTION_EASE'],
    ['KINEMATIC_WAVE_LAG', 'WAVE_LAG']
  ];
  const drifted = waveform
    .filter(([a, b]) => swim.SWIM_CONSTANTS[a] !== deform.DEFORM[b])
    .map(([a, b]) => `${a} ${swim.SWIM_CONSTANTS[a]} vs DEFORM.${b} ${deform.DEFORM[b]}`);
  assert(drifted.length === 0, 'agree: the two waveform tables hold the same numbers',
    drifted.join('\n'));

  assert(swim.SWIM_CONSTANTS.REDUCED_MOTION_PHASE === deform.REDUCED_MOTION_PHASE,
    'agree: one frozen pose for §4.6',
    `${swim.SWIM_CONSTANTS.REDUCED_MOTION_PHASE} vs ${deform.REDUCED_MOTION_PHASE}`);

  const verlet = await import(pathToFileURL(join(JS, 'sim/verlet.js')).href);
  assert(verlet.VERLET_CONSTANTS.RETARDED_LAG === deform.RETARDED_TIME_LAG,
    'agree: one retarded-time lag',
    `${verlet.VERLET_CONSTANTS.RETARDED_LAG} vs ${deform.RETARDED_TIME_LAG}`);
  assert(Math.abs(verlet.retardedTime(10, 0.4) - deform.retardedTime(10, 0.4)) < 1e-12,
    'agree: and one retarded-time function');

  // §5.4 and §4.4 both need the animal's wake to disturb the particulate at the
  // same radius, and the two files carry the number separately.
  const flow = await import(pathToFileURL(join(JS, 'sim/flow.js')).href);
  const snowSim = await import(pathToFileURL(join(JS, 'sim/snow.js')).href);
  assert(flow.FLOW_CONSTANTS.DISTURBANCE_RADIUS === snowSim.SNOW_CONSTANTS.DISTURBANCE_RADIUS,
    'agree: the flow and the snow share one disturbance radius');
}

/* ============================================================
   Section: run — the real renderer against a mock WebGL2 context
   ============================================================ */

/**
 * The strongest check available without a GPU. It boots js/main.js — the actual
 * module, with its actual auto-start — against tests/mockgl.mjs and pumps real
 * frames through it, so every pass in the eight-pass graph, the whole
 * simulation step order, the quality controller, the resize path, the
 * visibility gate and the context-loss rebuild all execute.
 *
 * The mock introspects each program by parsing the source it was handed, so a
 * uniform set with the wrong component count, a matrix uploaded with
 * transpose:true, a draw with no program bound or a zero-sized texture is an
 * error here rather than a black frame in a browser.
 */

function makeElement(tag, doc) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    children: [],
    style: { cssText: '' },
    classList: {
      set: new Set(),
      add(c) { el.classList.set.add(c); },
      remove(c) { el.classList.set.delete(c); },
      contains(c) { return el.classList.set.has(c); }
    },
    clientWidth: 1600,
    clientHeight: 900,
    width: 300,
    height: 150,
    textContent: '',
    setAttribute() {},
    appendChild(child) { el.children.push(child); return child; },
    append(...kids) { el.children.push(...kids); },
    remove() {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    dispatch(type) {
      const event = { type, preventDefault() { event.defaultPrevented = true; }, defaultPrevented: false };
      for (const fn of listeners.get(type) || []) fn(event);
      return event;
    },
    listenerCount(type) { return (listeners.get(type) || new Set()).size; }
  };
  return el;
}

function installBrowser(mock) {
  const doc = {
    hidden: false,
    _listeners: new Map(),
    getElementById(id) { return id === 'sea' ? host : (id === 'gl' ? canvas : null); },
    createElement: (tag) => makeElement(tag, doc),
    addEventListener(type, fn) {
      if (!doc._listeners.has(type)) doc._listeners.set(type, new Set());
      doc._listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (doc._listeners.has(type)) doc._listeners.get(type).delete(fn);
    },
    dispatch(type) { for (const fn of doc._listeners.get(type) || []) fn({ type }); }
  };
  const host = makeElement('main', doc);
  const canvas = makeElement('canvas', doc);
  canvas.getContext = () => mock.gl;
  host.appendChild(canvas);

  const queue = [];
  globalThis.document = doc;
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  globalThis.location = { search: '' };
  globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };

  let now = 0;
  const pump = (frames, stepMs = 16.7) => {
    for (let i = 0; i < frames; i++) {
      const pendingFrames = queue.splice(0, queue.length);
      if (!pendingFrames.length) break;
      now += stepMs;
      for (const fn of pendingFrames) fn(now);
    }
  };

  const teardown = () => {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.location;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
    delete globalThis.ResizeObserver;
  };

  return { doc, host, canvas, pump, teardown, get pendingFrames() { return queue.length; } };
}

async function bootMain(tag) {
  // A fresh URL so main.js's module-level auto-start runs again against the DOM
  // that is installed right now. Its imports are already cached, so only the
  // boot path is re-executed.
  const url = pathToFileURL(join(JS, 'main.js')).href + `?run=${tag}`;
  return import(url);
}

async function runConfiguration(label, mockOptions, search, frames) {
  const { createMockGL } = await import(pathToFileURL(join(ROOT, 'tests/mockgl.mjs')).href);
  const mock = createMockGL(mockOptions);
  const browser = installBrowser(mock);
  globalThis.location = { search };

  let app = null;
  try {
    const mod = await bootMain(`${label}-${Math.random().toString(36).slice(2)}`);
    app = mod.jellyfish;
    assert(app && app.gl === mock.gl, `run/${label}: boots against the mock context`);
    browser.pump(frames);

    assert(mock.errors.length === 0, `run/${label}: no GL misuse over ${frames} frames`,
      [...new Set(mock.errors)].slice(0, 12).join('\n'));

    const counts = mock.counts;
    const draws = (counts.drawArrays || 0) + (counts.drawElements || 0) +
      (counts.drawArraysInstanced || 0) + (counts.drawElementsInstanced || 0);
    assert(draws > 0, `run/${label}: the graph actually draws`, JSON.stringify(counts));
    assert((counts.drawElements || 0) > 0, `run/${label}: indexed geometry is drawn`);
    // The snow is the project's only instanced draw, and it is a non-indexed
    // triangle strip: four corners, one instance per mote.
    assert((counts.drawArraysInstanced || 0) > 0, `run/${label}: snow is instanced`);
    assert(app.graph && app.graph.programsReady, `run/${label}: every program linked`);
    assert(browser.canvas.classList.contains('ready'),
      `run/${label}: the canvas is faded up after the first presented frame`);

    // Every uniform a pass sets must exist in the linked program. A name that
    // does not is a silent no-op in a browser, which is how a shading term
    // quietly stops working; here it is a failure with the name in it.
    const missing = app.graph.missingUniforms();
    assert(Object.keys(missing).length === 0,
      `run/${label}: no pass sets a uniform its program does not have`,
      JSON.stringify(missing));

    const unimplemented = Object.keys(counts).filter((k) => k.startsWith('unimplemented:'));
    assert(unimplemented.length === 0, `run/${label}: no unmodelled WebGL entry point`,
      unimplemented.join(', '));

    return { app, browser, mock };
  } catch (err) {
    fail(`run/${label}: boots and renders`, err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
    return { app, browser, mock };
  }
}

/**
 * The §7 floor, driven directly. This is the one behaviour in the project that a
 * rendered frame cannot demonstrate — reaching it takes several hundred slow
 * frames — and it is also the one with a trap in it: at the 30 Hz clamp
 * main.js must report the wall-clock rAF interval and not the accumulated
 * simulation step, or on Safari and Firefox (no timer query, so the controller
 * counts frames over 20 ms) every rendered frame looks dropped and the clamp
 * never lifts.
 */
async function checkHalfRateRecovery() {
  const { createQualityController, QUALITY_CONSTANTS } =
    await import(pathToFileURL(join(JS, 'render/quality.js')).href);

  // No timer object at all: the dropped-frame fallback, which is what Safari
  // and Firefox actually run.
  const q = createQualityController({
    caps: { floatTargets: true, dprCap: 2 },
    timer: null,
    cssWidth: 1920,
    cssHeight: 1080
  });
  assert(q.mode === 'dropped-frames', 'ladder: no timer query means dropped-frame mode');

  const slow = 0.040;                       // 40 ms: comfortably "dropped"
  for (let i = 0; i < 4000 && !q.halfRate; i++) {
    q.shouldRender(slow);
    q.update(slow);
  }
  assert(q.halfRate, 'ladder: sustained slow frames reach the 30 Hz clamp');
  assert(q.settings.tier === 4, 'ladder: and only after every tier has been spent');

  // Now the machine is idle again. Each rAF is a healthy 16.7 ms; the clamp
  // renders every other one, and reports the interval it actually measured.
  const rAF = 1 / 60;
  let rendered = 0;
  for (let i = 0; i < 4000 && q.halfRate; i++) {
    if (q.shouldRender(rAF)) { q.update(rAF); rendered++; }
  }
  assert(!q.halfRate, 'ladder: and the clamp lifts again when the machine recovers',
    `still clamped after ${rendered} rendered frames`);

  // The trap, stated as a test: reporting the accumulated step instead would
  // never clear it, because 33 ms is over the dropped-frame threshold.
  const stuck = createQualityController({
    caps: { floatTargets: true, dprCap: 2 }, timer: null, cssWidth: 1920, cssHeight: 1080
  });
  for (let i = 0; i < 4000 && !stuck.halfRate; i++) { stuck.shouldRender(slow); stuck.update(slow); }
  let accumulated = 0;
  for (let i = 0; i < 4000; i++) {
    accumulated += rAF;
    if (stuck.shouldRender(rAF)) { stuck.update(accumulated); accumulated = 0; }
  }
  assert(stuck.halfRate,
    'ladder: reporting the accumulated step instead would latch 30 Hz for the session',
    'this assertion documents WHY main.js passes dt and not stepDt; if it ever ' +
    'fails, the hazard is gone and the comment in main.js can go with it');
}

async function sectionRun() {
  console.log('\n-- run --');

  await checkHalfRateRecovery();

  // 1. The float path at tier 1: every pass, RAYS, ZFRONT, THICK, the shadow
  //    map, MSAA resolved, five bloom levels.
  {
    const { app, browser, mock } = await runConfiguration('float', {}, '', 40);
    if (app) {
      assert(app.graph.floatPath, 'run/float: the float path was selected');
      assert((mock.counts.blitFramebuffer || 0) > 0,
        'run/float: MSAA resolves through the one legal blit');

      // The twenty-eight interpolated strands are rotated about the bell axis,
      // so anything non-finite reaching that rotation silently deletes them:
      // they rasterise nothing AND their centroids fail the §2.6 behind/front
      // comparison, so they all land in the wrong group. Nothing else in the
      // suite looks at the solved nodes, which is how that shipped once.
      const nodes = app.strands.tentacleNodes;
      let firstBad = -1;
      for (let i = 0; i < nodes.length; i++) {
        if (!Number.isFinite(nodes[i])) { firstBad = i; break; }
      }
      assert(firstBad < 0, 'run/float: every solved tentacle node is finite',
        `float ${firstBad} of ${nodes.length} is ${firstBad < 0 ? '' : nodes[firstBad]}` +
        ` (strand ${Math.floor(firstBad / (nodes.length / 40))})`);

      // §10: the tab hidden and then shown must resume at the correct pose.
      const poseBefore = app.swim.phase;
      browser.doc.hidden = true;
      browser.doc.dispatch('visibilitychange');
      const idle = browser.pendingFrames;
      browser.pump(5);
      assert(app.swim.phase === poseBefore,
        'run/float: a hidden tab does no simulation at all');
      assert(idle === 0 || browser.pendingFrames === 0,
        'run/float: a hidden tab schedules no frame');

      browser.doc.hidden = false;
      browser.doc.dispatch('visibilitychange');
      mock.reset();
      // A resume after a nine-hour sleep: one rAF, an enormous timestamp jump.
      browser.pump(1, 9 * 3600 * 1000);
      browser.pump(4);
      assert(mock.errors.length === 0, 'run/float: resuming after nine hours is clean',
        mock.errors.slice(0, 6).join('\n'));
      assert(Number.isFinite(app.swim.position.x) && Math.abs(app.swim.position.x) < 1,
        'run/float: the animal did not explode on resume',
        `position.x = ${app.swim.position.x}`);

      // §10: forced context loss and restore, full recovery.
      mock.reset();
      const lost = browser.canvas.dispatch('webglcontextlost');
      assert(lost.defaultPrevented,
        'run/float: the loss event is preventDefault-ed, or restore never fires');
      browser.canvas.dispatch('webglcontextrestored');
      browser.pump(10);
      assert(mock.errors.length === 0, 'run/float: rebuilds cleanly after a context restore',
        mock.errors.slice(0, 6).join('\n'));
      assert(app.graph && app.graph.programsReady,
        'run/float: the rebuilt graph relinked every program');

      // §10: "window drag-resize for 10 s allocates targets at most 3 times".
      // Every frame of the drag changes the host's size, which is the worst case
      // targets.js's 250 ms debounce has to absorb.
      mock.reset();
      const allocationsBefore = app.graph.targets.allocationCount;
      for (let i = 0; i < 600; i++) {
        browser.host.clientWidth = 1200 + (i % 240);
        browser.host.clientHeight = 700 + ((i * 3) % 180);
        browser.pump(1);
      }
      const allocations = app.graph.targets.allocationCount - allocationsBefore;
      assert(mock.errors.length === 0, 'run/float: survives a ten-second drag-resize',
        mock.errors.slice(0, 6).join('\n'));
      assert(allocations <= 3, 'run/float: a ten-second drag allocates at most 3 times',
        `allocated ${allocations} times`);
      assert(browser.canvas.width === app.graph.targets.width &&
             browser.canvas.height === app.graph.targets.height,
        'run/float: the backing store tracks the scene targets exactly',
        `canvas ${browser.canvas.width}x${browser.canvas.height} vs ` +
        `targets ${app.graph.targets.width}x${app.graph.targets.height}`);

      // §10's other soak property: nothing in the frame path allocates a GL
      // object once the targets have settled. "Settled" has to be waited for —
      // the drag above ends with one reallocation still owed to the debounce,
      // and the render scale is still easing.
      browser.pump(120);
      const objectsBefore = mock.objectCount;
      browser.pump(120);
      assert(mock.objectCount === objectsBefore,
        'run/float: a steady-state frame creates no GL objects',
        `${mock.objectCount - objectsBefore} created over 120 frames`);
      assert(Object.keys(app.graph.missingUniforms()).length === 0,
        'run/float: every uniform a pass sets exists in its linked program',
        JSON.stringify(app.graph.missingUniforms()));

      app.destroy();
      browser.pump(3);
      assert(browser.canvas.listenerCount('webglcontextlost') === 0,
        'run/float: destroy() unwires the context listeners');
    }
    browser.teardown();
  }

  // 2. The RGBA8 / analytic-thickness path — a real shipping configuration
  //    (§2.5) and the one no developer machine exercises by accident.
  {
    const { app, browser, mock } = await runConfiguration('rgba8',
      { extensions: [], maxSamples: 0 }, '', 30);
    if (app) {
      assert(!app.graph.floatPath, 'run/rgba8: the fallback path was selected');
      assert(app.graph.targets.rays === null, 'run/rgba8: RAYS is never allocated');
      assert(app.graph.targets.thick === null, 'run/rgba8: THICK is never allocated');
      assert(app.quality.settings.tier === 4, 'run/rgba8: the ladder has one rung');
      assert((mock.counts.blitFramebuffer || 0) === 0,
        'run/rgba8: no MSAA, therefore no blit at all');
      app.destroy();
    }
    browser.teardown();
  }

  // 3. Tier 4 on a float device: retarded-time strands, no THICK, no RAYS, but
  //    the sun-side shadow map survives because it needs no prepass.
  {
    const { app, browser } = await runConfiguration('tier4', {}, '?tier=4', 30);
    if (app) {
      assert(app.quality.settings.retardedStrands,
        'run/tier4: the strand solver falls back to retarded time');
      assert(app.quality.settings.analyticThickness,
        'run/tier4: thickness falls back to the analytic slab');
      // The tier turns THICK off on a device whose capability would allow it,
      // so a bell program compiled to sample uThick would be sampling a unit
      // nothing bound — in practice the caustic gobo setCaustic left there.
      // The analytic variant has to exist and has to be free of the sampler.
      assert(app.graph.targets.thick === null,
        'run/tier4: no THICK target is allocated');
      for (const shell of ['exumbrella', 'subumbrella']) {
        const analytic = app.graph.programs[`bell.${shell}.analytic`];
        assert(analytic && !analytic.has('uThick'),
          `run/tier4: bell.${shell}.analytic exists and samples no THICK`);
      }
      app.destroy();
    }
    browser.teardown();
  }

  // 4. The ?dev=1 panel, which also makes camera.js's elevation assertion throw
  //    rather than clamp — §4.5's anti-flare guarantee, checked live.
  {
    const { app, browser } = await runConfiguration('dev', {}, '?dev=1', 40);
    if (app) {
      assert(app.camera.elevationClampCount === 0,
        'run/dev: the camera never reached the 25 degree elevation clamp',
        `clamped ${app.camera.elevationClampCount} times, max seen ` +
        `${app.camera.maxElevationDegreesSeen.toFixed(2)} degrees`);
      app.destroy();
    }
    browser.teardown();
  }
}

/* ============================================================
   Section: policy — the §10 constraints that are greppable
   ============================================================ */

async function sectionPolicy() {
  console.log('\n-- policy --');

  const sources = SOURCES.map((f) => ({ rel: relative(ROOT, f), text: readFileSync(f, 'utf8') }));
  const offenders = (re, skip = () => false) =>
    sources.filter((s) => !skip(s) && re.test(stripComments(s.text))).map((s) => s.rel);

  // §10: "no CDN request at runtime. Loading the folder over file:// produces
  // the identical render (proves no fetched GLSL)."
  assert(offenders(/\bfetch\s*\(/).length === 0, 'policy: no fetch() anywhere in js/',
    offenders(/\bfetch\s*\(/).join(', '));
  assert(offenders(/XMLHttpRequest/).length === 0, 'policy: no XMLHttpRequest');
  assert(offenders(/\bimport\s*\(/, (s) => s.rel === 'js/main.js').length === 0,
    'policy: no dynamic import outside the boot path',
    offenders(/\bimport\s*\(/, (s) => s.rel === 'js/main.js').join(', '));

  // §6: "No readPixels anywhere — one readback would stall the pipeline and
  // cost more than the whole post chain."
  assert(offenders(/readPixels/).length === 0, 'policy: no readPixels anywhere',
    offenders(/readPixels/).join(', '));

  // §2.6 / §10: blitFramebuffer appears ONLY in the MS -> single-sample resolve.
  const blitters = offenders(/blitFramebuffer/);
  assert(blitters.length === 1 && blitters[0] === 'js/gl.js',
    'policy: blitFramebuffer exists only in gl.js\'s resolveMultisample', blitters.join(', '));

  // geometry/strands.js reads every vector it is handed by numeric index, so a
  // Vec3 crossing that boundary reads as three undefineds. normalizeInto() now
  // takes the fallback rather than propagating NaN, which means the failure is
  // no longer a visible one: the fringe would quietly stop tracking the bell
  // axis and hang from a fixed world up instead. Caught here, at the call.
  const vec3ToStrands = offenders(/packTentacles(?:Analytic)?\s*\([^)]*\.(?:bellAxis|position|forward)\b/);
  assert(vec3ToStrands.length === 0,
    'policy: the strand packers are handed indexables, never a Vec3',
    vec3ToStrands.join(', '));

  // The foundation's rule: no Math.random in the render path, so that adding a
  // snow mote cannot shift the tentacle lengths.
  assert(offenders(/Math\.random/).length === 0, 'policy: no Math.random anywhere',
    offenders(/Math\.random/).join(', '));

  // §8: nothing is vendored and there is no build step.
  for (const name of ['vendor', 'node_modules', 'package.json']) {
    let present = true;
    try { statSync(join(ROOT, name)); } catch { present = false; }
    assert(!present, `policy: no ${name}`);
  }

  // §10: the untouched files, by byte length, so a stray edit is caught here
  // rather than in a diff review.
  const untouched = {
    CNAME: 24, LICENSE: 34523, 'carino-navbar.js': 11383, 'carino-clock.js': 4213
  };
  for (const [name, size] of Object.entries(untouched)) {
    const actual = statSync(join(ROOT, name)).size;
    assert(actual === size, `policy: ${name} is untouched`, `${actual} bytes, expected ${size}`);
  }

  // §1: the context attributes are the ones the spec fixes, and
  // powerPreference stays 'default' — forcing the discrete GPU on a page left
  // open for fifteen hours is a thermal and battery bug.
  const { CONTEXT_ATTRIBUTES } = await import(pathToFileURL(join(JS, 'gl.js')).href);
  const wanted = {
    antialias: false, alpha: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'default'
  };
  const wrong = Object.entries(wanted)
    .filter(([k, v]) => CONTEXT_ATTRIBUTES[k] !== v)
    .map(([k, v]) => `${k}: ${CONTEXT_ATTRIBUTES[k]} (want ${v})`);
  assert(wrong.length === 0, 'policy: the §1 context attributes', wrong.join(', '));

  // §7: the ladder is forbidden from touching the tentacle count or the near
  // and mid snow. This is the invariant the judges called out by name.
  const { QUALITY_TIERS, QUALITY_INVARIANTS } =
    await import(pathToFileURL(join(JS, 'render/quality.js')).href);
  assert(QUALITY_INVARIANTS.tentacleCount === 40,
    'policy: tentacle count is 40 in every tier, forever');
  const touchesInvariants = QUALITY_TIERS.some((t) =>
    'tentacleCount' in t || 'nearSnow' in t || 'midSnow' in t);
  assert(!touchesInvariants, 'policy: no tier row can move an invariant');

  // Numbers that exist in two modules because the modules were written in
  // parallel. Each pair below is one physical quantity, and nothing but this
  // stops them drifting apart — which is a class of bug that produces a
  // slightly wrong image and no error anywhere.
  const [targetsMod, cookie, postMod, strandsGeo, strandsSh, snowSh, snowSim, bellGeo, profile] =
    await Promise.all([
      'render/targets.js', 'shaders/cookie.js', 'shaders/post.js',
      'geometry/strands.js', 'shaders/strands.js', 'shaders/snow.js',
      'sim/snow.js', 'geometry/bell.js', 'geometry/profile.js'
    ].map((f) => import(pathToFileURL(join(JS, f)).href)));

  const pairs = [
    ['cookie tile size', cookie.COOKIE_SIZE, targetsMod.TARGET_CONSTANTS.COOKIE_SIZE],
    ['cookie mip levels', cookie.COOKIE_MIP_LEVELS, targetsMod.TARGET_CONSTANTS.COOKIE_LEVELS],
    ['RGBA8 pre-exposure', postMod.POST_CONSTANTS.HDR_PRE_EXPOSURE,
      targetsMod.TARGET_CONSTANTS.RGBA8_PRE_EXPOSURE],
    ['strand minimum screen width', strandsGeo.STRAND_MIN_WIDTH_PX, strandsSh.STRAND_MIN_WIDTH_PX],
    ['tentacle half width', strandsGeo.TENTACLE_HALF_WIDTH, strandsSh.TENTACLE_HALF_WIDTH],
    ['supergaussian scale', strandsGeo.STRAND_SHADER_CONSTANTS.SUPERGAUSSIAN_SCALE,
      strandsSh.STRAND_FALLOFF_SCALE],
    ['supergaussian exponent', strandsGeo.STRAND_SHADER_CONSTANTS.SUPERGAUSSIAN_EXPONENT,
      strandsSh.STRAND_FALLOFF_EXPONENT],
    ['bokeh sprite size', snowSh.SNOW_SPRITE_SIZE, snowSim.SNOW_CONSTANTS.BOKEH_SIZE],
    ['bell wall reference', bellGeo.BELL_WALL_REFERENCE, profile.wallThickness(0)]
  ];
  const mismatched = pairs
    .filter(([, a, b]) => a !== b)
    .map(([label, a, b]) => `${label}: ${a} vs ${b}`);
  assert(mismatched.length === 0, 'policy: constants shared across modules agree',
    mismatched.join('\n'));

  // §5.5's ΔE harness and the poster ground both read MEDIUM from JS, and §2.0
  // is required to ship byte-identical. Assert the JS transcription still
  // matches the GLSL text rather than trusting that it did once.
  const { COMMON_GLSL, MEDIUM } = await import(pathToFileURL(join(JS, 'shaders/common.js')).href);
  const glslVec = (name) => {
    const m = COMMON_GLSL.match(new RegExp(`${name}\\s*=\\s*vec3\\(([^)]*)\\)`));
    return m ? m[1].split(',').map((v) => Number(v.trim())) : null;
  };
  const transcription = [
    ['SIG_T_W', MEDIUM.SIG_T_W], ['SIG_S_W', MEDIUM.SIG_S_W], ['KD', MEDIUM.KD],
    ['SIG_A_G', MEDIUM.SIG_A_G], ['SIG_S_G', MEDIUM.SIG_S_G]
  ];
  const badMedium = transcription.filter(([name, js]) => {
    const g = glslVec(name);
    return !g || g.length !== 3 || g.some((v, i) => Math.abs(v - js[i]) > 1e-9);
  }).map(([name]) => name);
  assert(badMedium.length === 0, 'policy: MEDIUM transcribes §2.0 exactly', badMedium.join(', '));
}

/* ============================================================
   Section: soak — a minute of simulated time, every frame checked
   ============================================================ */

/**
 * §10 asks for an eight-hour soak with no memory growth, no drift of the animal
 * off frame, no exposure creep and no frame-time degradation. Eight hours is not
 * a unit test, but the properties it is checking are structural and one minute
 * of simulated time is enough to see all of them break: the floating-origin
 * leash either holds or it does not, the depth-keeping term either converges or
 * it does not, and a GL object allocated per frame is 3600 of them by the end.
 *
 * Every uniform value is validated for finiteness by the mock on the way past,
 * so this also proves the whole sim stays numerically sane over thousands of
 * beats — which is the failure mode a spring or a verlet chain actually has.
 */
async function sectionSoak() {
  console.log('\n-- soak --');

  const { createMockGL } = await import(pathToFileURL(join(ROOT, 'tests/mockgl.mjs')).href);
  const mock = createMockGL({});
  const browser = installBrowser(mock);

  try {
    const mod = await bootMain(`soak-${Math.random().toString(36).slice(2)}`);
    const app = mod.jellyfish;
    browser.pump(120);

    const objectsAtStart = mock.objectCount;
    const allocationsAtStart = app.graph.targets.allocationCount;

    let maxRadius = 0;
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    let maxElevation = -Infinity;
    const FRAMES = 3600;                       // one minute at 60 fps

    for (let i = 0; i < FRAMES; i++) {
      browser.pump(1);
      const p = app.swim.position;
      maxRadius = Math.max(maxRadius, Math.hypot(p.x, p.z));
      minDepth = Math.min(minDepth, app.swim.worldY);
      maxDepth = Math.max(maxDepth, app.swim.worldY);
      maxElevation = Math.max(maxElevation, app.camera.elevationDegrees);
    }

    assert(mock.errors.length === 0, 'soak: no GL misuse over a minute',
      [...new Set(mock.errors)].slice(0, 8).join('\n'));

    // §4.3's floating origin. The leash is 0.5 m and it is a hard bound, not a
    // tendency: the animal cannot swim off the world in eight hours because it
    // never gets more than half a metre from the render origin in the first
    // place.
    assert(maxRadius <= 0.5 + 1e-6, 'soak: the floating origin holds its leash',
      `max |xz| = ${maxRadius.toFixed(4)} m`);
    assert(app.swim.worldPosition.isFinite() && app.swim.worldOffset.len() > 0.1,
      'soak: and the world scrolls past instead',
      `offset ${app.swim.worldOffset.toString()}`);

    // §5.1 puts the camera at 14 m. The animal is faintly negatively buoyant and
    // station-keeps against that; if the depth-keeping term were wrong it would
    // sink out of the lit column over a session rather than immediately.
    assert(minDepth > -18 && maxDepth < -10, 'soak: the animal holds its depth',
      `depth ranged ${minDepth.toFixed(2)} .. ${maxDepth.toFixed(2)} m`);

    // §4.5's anti-flare geometry, asserted over a run rather than over the
    // constants: the sun is at 72° and the camera must never look up at it.
    assert(maxElevation <= 25, 'soak: the camera never rises above 25 degrees',
      `peak elevation ${maxElevation.toFixed(2)} degrees`);
    assert(app.camera.elevationClampCount === 0,
      'soak: and never needed the hard clamp to stay there');

    // §10: no memory growth. Every buffer, texture and program is allocated at
    // boot or at a resize; a frame allocates nothing.
    assert(mock.objectCount === objectsAtStart,
      'soak: no GL object is created after the targets settle',
      `${mock.objectCount - objectsAtStart} created over ${FRAMES} frames`);
    assert(app.graph.targets.allocationCount === allocationsAtStart,
      'soak: and the targets are never reallocated at a fixed size');

    assert(app.swim.beatIndex > 20, 'soak: the animal actually beat',
      `${app.swim.beatIndex} beats`);
    assert(app.quality.settings.tier === 1,
      'soak: an instant GPU does not trip the ladder down',
      `settled at tier ${app.quality.settings.tier}`);

    app.destroy();
  } catch (err) {
    fail('soak: runs a minute of simulated time',
      err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
  } finally {
    browser.teardown();
  }
}

/* ============================================================ */

const SECTIONS = {
  syntax: sectionSyntax,
  graph: sectionGraph,
  glsl: sectionGlsl,
  wiring: sectionWiring,
  agree: sectionAgree,
  policy: sectionPolicy,
  run: sectionRun,
  soak: sectionSoak
};

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = requested.length ? requested : Object.keys(SECTIONS);

for (const name of names) {
  const fn = SECTIONS[name];
  if (!fn) { fail(`unknown section: ${name}`, `known: ${Object.keys(SECTIONS).join(', ')}`); continue; }
  await fn();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
