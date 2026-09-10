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

  // The station framing's geometry lives in two frozen tables — camera.js owns
  // where the lens is and sim/director.js owns where the animal is allowed to
  // be — and every relation below is an INEQUALITY between them. That is a
  // worse class of bug than a mismatched number: nothing throws when one
  // drifts, the page still boots and still draws, and the only symptom is a
  // wrong image nobody can name. §4.5's own anti-flare arithmetic is asserted
  // at construction; these are the orderings that are not.
  const camera = await import(pathToFileURL(join(JS, 'camera.js')).href);
  const director = await import(pathToFileURL(join(JS, 'sim/director.js')).href);
  const snowShaders = await import(pathToFileURL(join(JS, 'shaders/snow.js')).href);
  const cookie = await import(pathToFileURL(join(JS, 'shaders/cookie.js')).href);
  const { TAU } = await import(pathToFileURL(join(JS, 'math.js')).href);
  const K = camera.CAMERA_CONSTANTS;
  const D = director.DIRECTOR_CONSTANTS;

  // The one that stops the animal ever getting behind the lens: the station is
  // 3.10 m out, the animal's overdrive band ends at 2.05 m, and the 0.65 m
  // standoff is what is left over — 0.40 m of margin. The Director constructor
  // asserts the same inequality at runtime, because a page that boots with it
  // violated should never reach a frame; this is the version that names the
  // two tables it is comparing.
  assert(K.STATION_RADIUS >= D.TANK_HARD_RADIUS + K.STATION_STANDOFF,
    'agree: the station stands clear of the tank',
    `STATION_RADIUS ${K.STATION_RADIUS} vs TANK_HARD_RADIUS ${D.TANK_HARD_RADIUS} ` +
    `+ STATION_STANDOFF ${K.STATION_STANDOFF} = ${(D.TANK_HARD_RADIUS + K.STATION_STANDOFF).toFixed(2)}`);

  // js/math.js:75's smoothstep saturates rather than complaining about
  // reversed edges, so a swapped pair here would not error — it would silently
  // return a constant and switch the wall off, which reads as an animal that
  // wandered away rather than as a bug.
  assert(D.TANK_SOFT_RADIUS < D.TANK_RADIUS && D.TANK_RADIUS < D.TANK_HARD_RADIUS,
    'agree: the tank\'s three radii stay ordered',
    `${D.TANK_SOFT_RADIUS} / ${D.TANK_RADIUS} / ${D.TANK_HARD_RADIUS}`);

  // The keep-out band is what sets the animal's closest approach, and that
  // number has a second owner: shaders/snow.js's bokeh refocus term clips
  // below SNOW_FOCUS_MIN, at exactly the distance where the near snow is most
  // visible. 1.35 m against 1.0 m is the margin that keeps it out of the clip.
  assert(D.STATION_KEEPOUT_HARD > snowShaders.SNOW_FOCUS_MIN,
    'agree: the animal never gets inside the near-snow focus floor',
    `closest approach ${D.STATION_KEEPOUT_HARD} m vs SNOW_FOCUS_MIN ${snowShaders.SNOW_FOCUS_MIN} m`);
  assert(D.STATION_KEEPOUT_HARD < D.STATION_KEEPOUT_SOFT,
    'agree: and the keep-out band opens outward from it',
    `${D.STATION_KEEPOUT_HARD} / ${D.STATION_KEEPOUT_SOFT}`);

  // §4.5's wandering look error is a fixed 0.24 m, which over the station's
  // 1.35-5.15 m subject range would subtend 10° on a close pass and 2.7° at
  // the far wall — the term's own purpose inverted across the mode's range.
  // camera.js scales it by distanceToTarget / ORBIT_RADIUS_MEAN, floored at
  // STATION_MIN_AIM_DISTANCE, so this inequality is what guarantees the scale
  // is always >= 1 and the error therefore only ever grows.
  assert(K.STATION_MIN_AIM_DISTANCE > K.ORBIT_RADIUS_MEAN,
    'agree: the station look error scales up, never down',
    `STATION_MIN_AIM_DISTANCE ${K.STATION_MIN_AIM_DISTANCE} vs ` +
    `ORBIT_RADIUS_MEAN ${K.ORBIT_RADIUS_MEAN}`);

  /*
   * CLOSE FRAMING, whose whole design is one distance held against three
   * numbers that live in three other files. It is anchored to the animal
   * rather than to the world, so none of the director's tank inequalities
   * above constrain it and there is nothing else in the repo that would
   * notice if it drifted inward.
   */

  // The same clip STATION_KEEPOUT_HARD is held clear of, read from the other
  // end: the station keeps the ANIMAL out of the near-snow focus floor, and
  // this keeps the EYE out of it. Inside SNOW_FOCUS_MIN the plane of focus
  // sits behind the subject in the one framing where the near bokeh is most of
  // the foreground, and the 0.15 m here is the designed margin — the framing
  // section measures what the position spring actually delivers.
  assert(K.CLOSE_MIN_EYE_DISTANCE > snowShaders.SNOW_FOCUS_MIN,
    'agree: close framing keeps the eye outside the near-snow focus floor',
    `CLOSE_MIN_EYE_DISTANCE ${K.CLOSE_MIN_EYE_DISTANCE} m vs ` +
    `SNOW_FOCUS_MIN ${snowShaders.SNOW_FOCUS_MIN} m`);

  // And the standoff is a floor, not the design: the orbit's own near end has
  // to sit above it, or the rig would spend part of every 1310 s radius cycle
  // being carried by a clamp instead of by its carrier, which is a rig with
  // a flat spot in it rather than one that breathes.
  assert(K.CLOSE_RADIUS_MEAN - K.CLOSE_RADIUS_SWING >= K.CLOSE_MIN_EYE_DISTANCE,
    'agree: the close orbit\'s own floor is above its standoff',
    `${K.CLOSE_RADIUS_MEAN} - ${K.CLOSE_RADIUS_SWING} = ` +
    `${(K.CLOSE_RADIUS_MEAN - K.CLOSE_RADIUS_SWING).toFixed(2)} m vs ` +
    `CLOSE_MIN_EYE_DISTANCE ${K.CLOSE_MIN_EYE_DISTANCE} m`);

  // Deliberate reuse, asserted so that it is checked rather than coincidental.
  // The radius carrier is the only thing in close framing that modulates the
  // animal's screen coverage, and screen coverage is what feeds the highlight
  // meter; giving it a period of its own would have added a seventh carrier and
  // the manifest below — which is enumerated by hand precisely because "every
  // carrier" cannot be read off the source — would have had to grow with it.
  // It does not, and this is why it does not.
  assert(K.CLOSE_RADIUS_PERIOD === K.STATION_HEIGHT_PERIOD,
    'agree: the close radius carrier reuses the station\'s rather than adding a seventh',
    `CLOSE_RADIUS_PERIOD ${K.CLOSE_RADIUS_PERIOD} vs ` +
    `STATION_HEIGHT_PERIOD ${K.STATION_HEIGHT_PERIOD}`);

  // §4.5's anti-flare guarantee survives a blend only because `_capPitch`
  // asymptotes strictly inside whatever cap it is handed and the blended cap is
  // a convex combination of these: if every one of them is strictly under
  // MAX_LOOK_ELEVATION then so is every combination of them, at any weights and
  // for any number of framings, and `_clampElevation` stays the unreachable
  // tripwire it is written to be. The argument holds for the list, so the list
  // is what is asserted.
  const softCaps = [K.STATION_PITCH_CAP, K.CLOSE_PITCH_CAP];
  assert(softCaps.every((cap) => cap < K.MAX_LOOK_ELEVATION),
    'agree: every soft pitch cap stays strictly inside the hard one',
    `${softCaps.map((c) => (c * 180 / Math.PI).toFixed(1)).join('° / ')}° vs ` +
    `MAX_LOOK_ELEVATION ${(K.MAX_LOOK_ELEVATION * 180 / Math.PI).toFixed(1)}°`);

  // §4.6 has one reduce-motion rate, and it now appears in two files: cookie.js
  // slows the caustic clock by it and director.js slows the whole optical
  // schedule by it. If they drifted apart the sun and the surface it lights
  // would run on two different clocks under the same OS switch.
  assert(D.REDUCED_LIGHT_RATE === cookie.COOKIE_TIME_SCALE_REDUCED,
    'agree: one reduce-motion rate',
    `${D.REDUCED_LIGHT_RATE} vs COOKIE_TIME_SCALE_REDUCED ${cookie.COOKIE_TIME_SCALE_REDUCED}`);

  // The depth schedule only reaches the image through the animal's own
  // station-keeping: director.js moves the SETPOINT and swim.js's ±22° pitch
  // authority is what chases it. If the setpoint moves faster than the animal
  // can swim, the KD ramp the whole lighting design rests on never
  // materialises — the animal simply lags a target it never reaches, and the
  // failure is invisible rather than wrong. Peak scheduled rate is the sum of
  // the two carriers' peak slopes plus the OU process's typical rate
  // sigma*sqrt(2/tau); authority is cruise * sin(DEPTH_KEEP_LIMIT).
  const scheduledDepthRate =
    D.DEPTH_A_AMPLITUDE * TAU / D.DEPTH_A_PERIOD +
    D.DEPTH_B_AMPLITUDE * TAU / D.DEPTH_B_PERIOD +
    D.DEPTH_OU_SIGMA * Math.sqrt(2 / D.DEPTH_OU_TAU);
  const depthAuthority = 0.086 * Math.sin(swim.SWIM_CONSTANTS.DEPTH_KEEP_LIMIT);
  assert(scheduledDepthRate < 0.60 * depthAuthority,
    'agree: the depth schedule stays inside the animal\'s own steering authority',
    `${scheduledDepthRate.toFixed(5)} m/s scheduled vs ${depthAuthority.toFixed(5)} m/s ` +
    `available (${(100 * scheduledDepthRate / depthAuthority).toFixed(1)} % of authority, ` +
    'budget 60 %)');

  // PERIODS is the manifest the policy section greps for the 20-300 s ban, and
  // a manifest is only worth anything if it is complete. There is no way to
  // enumerate "every carrier" from the source text, so it is enumerated here
  // instead: the three director carriers plus the caustic rate, and the three
  // that live in CAMERA_CONSTANTS because the camera owns the station and the
  // sun. Adding a seventh carrier without listing it fails by name.
  const manifest = [...D.PERIODS].sort((a, b) => a - b);
  const carriers = [
    D.DEPTH_A_PERIOD, D.DEPTH_B_PERIOD, D.CAUSTIC_RATE_PERIOD,
    K.STATION_HEIGHT_PERIOD, K.STATION_BEARING_PERIOD, K.SUN_ELEVATION_PERIOD
  ].sort((a, b) => a - b);
  assert(manifest.length === carriers.length && manifest.every((p, i) => p === carriers[i]),
    'agree: the period manifest names every carrier',
    `PERIODS [${manifest.join(', ')}] vs carriers [${carriers.join(', ')}]`);
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

/**
 * One line of the parent bookkeeping a DOM does for free and an object literal
 * does not: `remove()` below needs to know which list to splice the node out
 * of, and the page's own code never reads `parentNode`, so this exists purely
 * to make removal observable. Non-object children (a bare string handed to
 * append()) are left alone rather than having a property forced onto them.
 */
function adopt(parent, child) {
  if (child && typeof child === 'object') child.parentNode = parent;
}

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
    parentNode: null,
    setAttribute() {},
    appendChild(child) { adopt(el, child); el.children.push(child); return child; },
    append(...kids) { for (const kid of kids) adopt(el, kid); el.children.push(...kids); },
    /*
     * A real remove(), where this shim used to have a no-op. §9's amendment 2
     * claims the controls hint is REMOVED FROM THE DOCUMENT at 8.7 s rather
     * than left sitting at opacity 0, and the difference between those two is
     * exactly what a no-op cannot see: with children never spliced, an element
     * that had been taken out of the page would still be found in its parent's
     * list and the whole lifecycle would assert against nothing.
     *
     * Safe to change under the existing checks because nothing in the suite
     * counted `children` before the hint did: the page's other two callers are
     * destroy()'s `devPanel.remove()` and the poster handle's `poster.remove()`,
     * and no assertion reads what either of them leaves behind.
     */
    remove() {
      const parent = el.parentNode;
      if (!parent) return;
      const at = parent.children.indexOf(el);
      if (at >= 0) parent.children.splice(at, 1);
      el.parentNode = null;
    },
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
    // `init` is spread over the event, so a check can send a real key event —
    // `dispatch('keydown', { key: '2' })` — rather than only a type. Every
    // existing caller passes nothing and still receives exactly `{ type }`,
    // which is also the shape §9's key handler is written to survive: it reads
    // `event && event.key` and returns before touching anything else.
    dispatch(type, init) { for (const fn of doc._listeners.get(type) || []) fn({ type, ...init }); }
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

  const { CAMERA_CONSTANTS } = await import(pathToFileURL(join(JS, 'camera.js')).href);

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

      // Which framing this whole section has been measuring. Every camera
      // assertion in run/* and in the soak boots with no query at all, so if
      // the default ever moved they would quietly start measuring the other
      // mode and still pass. The handle and the camera hold the mode
      // separately — one is the closure's `let`, the other the camera's own
      // field — and they are asserted together for that reason.
      assert(app.mode === 'tank' && app.camera.mode === 'tank',
        'run/float: tank mode is the default',
        `handle ${app.mode}, camera ${app.camera.mode}`);

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

  // 5. Free view, entered from the query rather than from a key, so the whole
  //    of runConfiguration's battery — zero GL misuse, three kinds of draw,
  //    programsReady, the ready class, an EMPTY missingUniforms() and no
  //    unmodelled entry point — covers the subject rig as well as the station.
  //    Without this, every run/* check above measures only one of the two
  //    framings the page ships.
  {
    const { app, browser } = await runConfiguration('free', {}, '?mode=free', 40);
    if (app) {
      assert(app.mode === 'free', 'run/free: ?mode=free boots the subject rig',
        `mode ${app.mode}`);
      // Booted with the mix already terminal rather than eased into, so the
      // lens is the shipped 38 degrees exactly and not somewhere along a
      // three-second ramp. Exact, not approximate: at _modeMix === 0 the lerp
      // returns its first argument unchanged.
      assert(Math.abs(app.camera.fovY - CAMERA_CONSTANTS.FOV_Y) < 1e-9,
        'run/free: and keeps the shipped 38 degree lens',
        `fovY ${(app.camera.fovY * 180 / Math.PI).toFixed(4)} degrees`);
      app.destroy();
    }
    browser.teardown();
  }

  // 6. Free view under ?dev=1, where camera.js's elevation assertion THROWS
  //    rather than clamps. run/dev covers the station framing; this is the same
  //    guarantee for the subject rig, whose own steady-state worst case has
  //    only 2.3 degrees of headroom against the 25 and is therefore the half
  //    that would fail first.
  {
    const { app, browser } = await runConfiguration('dev-free', {}, '?dev=1&mode=free', 40);
    if (app) {
      assert(app.camera.elevationClampCount === 0,
        'run/dev-free: the subject rig never reached the 25 degree elevation clamp',
        `clamped ${app.camera.elevationClampCount} times, max seen ` +
        `${app.camera.maxElevationDegreesSeen.toFixed(2)} degrees`);
      app.destroy();
    }
    browser.teardown();
  }

  // 7. Close framing, again under ?dev=1 so the elevation assertion THROWS
  //    rather than clamps. run/dev covers the station and run/dev-free the
  //    subject rig; this is the third rig, and it is the one with no shipping
  //    history behind its clause. Its 4.516 degrees of headroom sit between the
  //    subject rig's 2.275 and the station's 5.805, so it is not the tightest —
  //    but it is the only one whose worst case is built on a look error that
  //    scales DOWN with distance, and a clause derived from constants is a
  //    statement about where the carriers can reach rather than about where the
  //    animal actually takes the rig. `hint=1` rides along because an explicit
  //    ?mode= otherwise suppresses the hint: it puts §9's transient inside the
  //    whole of runConfiguration's battery, so the forty frames that carry it
  //    are checked for GL misuse and unmodelled entry points like any other.
  {
    const { app, browser } = await runConfiguration('close', {}, '?dev=1&mode=close&hint=1', 40);
    if (app) {
      assert(app.mode === 'close' && app.camera.mode === 'close',
        'run/close: ?mode=close boots the close rig',
        `handle ${app.mode}, camera ${app.camera.mode}`);
      // Booted with the weights already terminal rather than eased into, so the
      // lens is exactly 30 degrees and not somewhere along a three-second ramp.
      // Exact, not approximate: at a one-hot the weighted sum is 1*x + 0 + 0.
      assert(Math.abs(app.camera.fovY - CAMERA_CONSTANTS.CLOSE_FOV_Y) < 1e-9,
        'run/close: and opens on the 30 degree lens exactly',
        `fovY ${(app.camera.fovY * 180 / Math.PI).toFixed(4)} degrees`);
      assert(app.camera.elevationClampCount === 0,
        'run/close: the close rig never reached the 25 degree elevation clamp',
        `clamped ${app.camera.elevationClampCount} times, max seen ` +
        `${app.camera.maxElevationDegreesSeen.toFixed(2)} degrees`);
      app.destroy();
    }
    browser.teardown();
  }
}

/* ============================================================
   Section: modes — the three framings, switched live
   ============================================================ */

/**
 * §9's three key affordances, driven through the same document the page
 * listens on. This is the only section that exercises a MODE TRANSITION, which
 * is where the design's riskiest claim lives: the switch is an eased blend of
 * the desired eye and the look centre, applied before the springs, so it
 * creates nothing, destroys nothing and invalidates no history. That claim is
 * unfalsifiable by inspection and trivially falsifiable here — a switch that
 * reprimed the camera, re-scattered the snow or relinked a program would show
 * up as a GL object, and a switch that teleported the eye would show up as a
 * clamped elevation.
 *
 * Three framings make one more thing checkable than two did. A scalar mix can
 * only be re-targeted along the one axis it has, so a key pressed part way
 * through a transition was previously a case with nowhere to go wrong; over a
 * weight simplex it is a real question, and the last leg below asks it — "3"
 * pressed four frames into a 1 → 2 ease, from a pose that is none of the three
 * framings, must still land exactly one-hot.
 *
 * It is also the only section that boots with the controls hint turned on, and
 * therefore the only place the one element §9's second amendment licenses is
 * watched from its arrival to its removal.
 */
async function sectionModes() {
  console.log('\n-- modes --');

  const { CAMERA_CONSTANTS } = await import(pathToFileURL(join(JS, 'camera.js')).href);

  /*
   * How long the ease actually takes, worked out rather than guessed. The mix
   * closes (1 - exp(-h/MODE_TAU)) of its remaining distance each frame, so
   * from a terminal 1 it reaches the 1e-3 snap threshold after
   * MODE_TAU * ln(1000) = 3.0 * 6.908 = 20.7 s — frame 1241 at the harness's
   * 16.7 ms step. The nine seconds MODE_TAU suggests is the time to 95 %, not
   * the time to the snap, and pumping that instead would catch the mix at
   * 0.036 and the lens at 37.6 degrees, failing the exact-equality assertions
   * below on entirely correct code. 1800 frames is 30 s of simulated time:
   * comfortably past the snap, with room for a slower step.
   */
  const EASE_FRAMES = 1800;

  /*
   * `?hint=1` is the door SPEC §9's amendment 2 leaves open for exactly this
   * check. The hint's default gate wants a fine pointer, and installBrowser's
   * matchMedia stub reports `matches: false` for every query it is handed, so
   * on the empty search string this boot used to run the page would create no
   * hint at all and its lifecycle would go unwatched. Forcing it on changes
   * nothing else about the configuration: it adds no listener of its own, no
   * GL object and no allocation, and it has removed itself from the document
   * well before the first mode switch below — so every churn baseline taken
   * further down is taken on a page that is already back to one element and
   * one child.
   */
  const { app, browser, mock } = await runConfiguration('modes', {}, '?hint=1', 60);
  if (!app) { browser.teardown(); return; }

  try {
    assert(app.mode === 'tank' && app.camera.mode === 'tank',
      'modes: the page boots into tank framing',
      `handle ${app.mode}, camera ${app.camera.mode}`);

    // The exact shape the harness's own shim sent before this section existed,
    // and the shape any dispatched stub can still send: an event with a type
    // and nothing else. The handler reads `event && event.key` first for this
    // reason, and a TypeError here would take down every check that boots
    // main.js rather than only this one.
    let threw = null;
    try { browser.doc.dispatch('keydown'); } catch (err) { threw = err; }
    assert(threw === null && app.mode === 'tank',
      'modes: a key event with no key is ignored',
      threw ? String(threw && threw.message) : `mode is now ${app.mode}`);

    /*
     * THE ONE ELEMENT THIS PAGE ADDS TO THE DOCUMENT, from its arrival to its
     * removal. §9's first amendment licensed the framing keys on the ground
     * that "not one element" was added for them; the second amendment reverses
     * that for one transient line of text and bounds it instead, and every one
     * of those bounds is a claim about the document rather than about pixels —
     * which is precisely the class of claim this harness can settle.
     *
     * It is appended to #sea and not to <body>: a direct child of <body> would
     * become a third flex row, steal height from `#sea{flex:1 1 auto}` and fire
     * the ResizeObserver, and #sea's own children are otherwise just the canvas.
     * So "exactly one more child than the canvas" is the shape of the whole
     * structural claim, and it is worth asserting as a count rather than by
     * looking the element up.
     */
    const hint = browser.host.children[browser.host.children.length - 1];
    assert(browser.host.children.length === 2 && hint !== browser.canvas &&
           hint.tagName === 'P',
      'modes: the controls hint is the one element §9 amendment 2 licenses',
      `#sea holds ${browser.host.children.length} children, last is ` +
      `<${hint && hint.tagName}>`);

    // Styled inline, which is not a detail. css/jellyfish.css has no rule for
    // this element and deliberately never will — its header, SPEC §8's file
    // table and showPoster()'s own stated policy all turn on that file having
    // no UI in it — so the inline style is the ONLY thing that positions the
    // line, colours it and starts it at opacity 0. An empty cssText means the
    // page is leaning on a rule that does not exist, and what would actually
    // ship is default 16 px white text in the top-left corner of the water box,
    // behind an absolutely-positioned canvas.
    assert(hint.style.cssText.length > 0 && hint.textContent.length > 0,
      'modes: and it is styled inline rather than from the stylesheet',
      `cssText ${hint.style.cssText.length} chars, text ` +
      `${JSON.stringify(hint.textContent)}`);

    /*
     * 600 frames is 10.0 s at the harness's 16.7 ms step, against a designed
     * life of HINT_RISE + HINT_HOLD + HINT_FALL = 1.2 + 5.0 + 2.5 = 8.7 s from
     * the first PRESENTED frame — 1.3 s of margin, and the clock is the render
     * loop's own dt, so pumping frames is the only thing that can advance it.
     * What is asserted is removal from the parent's children and not an
     * opacity, because "the document is once again <main><canvas></main>" is
     * the property the amendment actually claims and a line left at opacity 0
     * would satisfy every visual check and none of that one.
     */
    browser.pump(600);
    assert(!browser.host.children.includes(hint) && browser.host.children.length === 1,
      'modes: and it is gone from the document by 8.7 s, not merely transparent',
      `#sea still holds ${browser.host.children.length} children`);

    // The targets are still settling sixty frames in — the render scale eases
    // toward its steady value and reallocates as it goes — so the object and
    // allocation baselines are taken after a settle window rather than at the
    // switch, exactly as run/float takes its own.
    browser.pump(120);

    // Key "2": into free view. The counts are captured immediately before the
    // keystroke, so anything the switch itself allocates is inside the window.
    const objectsBeforeFree = mock.objectCount;
    const allocationsBeforeFree = app.graph.targets.allocationCount;
    browser.doc.dispatch('keydown', { key: '2' });
    browser.pump(EASE_FRAMES);

    assert(app.mode === 'free' && app.camera.mode === 'free',
      'modes: key 2 selects free view',
      `handle ${app.mode}, camera ${app.camera.mode}`);
    assert(app.camera.modeMix === 0,
      'modes: and the blend settles all the way onto it',
      `modeMix ${app.camera.modeMix}`);
    assert(Math.abs(app.camera.fovY - CAMERA_CONSTANTS.FOV_Y) < 1e-6,
      'modes: with the shipped 38 degree lens eased back in',
      `fovY ${(app.camera.fovY * 180 / Math.PI).toFixed(4)} degrees`);
    assert(app.camera.elevationClampCount === 0,
      'modes: and the elevation clamp never fired across the transition',
      `clamped ${app.camera.elevationClampCount} times, max seen ` +
      `${app.camera.maxElevationDegreesSeen.toFixed(2)} degrees`);
    assert(mock.errors.length === 0, 'modes: no GL misuse across the transition',
      [...new Set(mock.errors)].slice(0, 8).join('\n'));
    assert(mock.objectCount === objectsBeforeFree,
      'modes: a mode switch creates no GL object',
      `${mock.objectCount - objectsBeforeFree} created over ${EASE_FRAMES} frames`);
    assert(app.graph.targets.allocationCount === allocationsBeforeFree,
      'modes: and reallocates no target',
      `${app.graph.targets.allocationCount - allocationsBeforeFree} reallocations`);

    // Key "1": back into tank framing. The return trip is the interesting
    // half — it is the one that re-plants the station, and it is the one whose
    // aim clamps are applied unblended all the way through the ease.
    const objectsBeforeTank = mock.objectCount;
    const allocationsBeforeTank = app.graph.targets.allocationCount;
    browser.doc.dispatch('keydown', { key: '1' });
    browser.pump(EASE_FRAMES);

    assert(app.mode === 'tank' && app.camera.mode === 'tank',
      'modes: key 1 selects tank framing again',
      `handle ${app.mode}, camera ${app.camera.mode}`);
    assert(app.camera.modeMix === 1,
      'modes: and the blend settles all the way back',
      `modeMix ${app.camera.modeMix}`);
    assert(Math.abs(app.camera.fovY - CAMERA_CONSTANTS.TANK_FOV_Y) < 1e-6,
      'modes: with the 28 degree lens eased in',
      `fovY ${(app.camera.fovY * 180 / Math.PI).toFixed(4)} degrees`);
    assert(app.camera.elevationClampCount === 0,
      'modes: and the elevation clamp never fired on the way back',
      `clamped ${app.camera.elevationClampCount} times, max seen ` +
      `${app.camera.maxElevationDegreesSeen.toFixed(2)} degrees`);
    assert(mock.errors.length === 0, 'modes: no GL misuse on the way back',
      [...new Set(mock.errors)].slice(0, 8).join('\n'));
    assert(mock.objectCount === objectsBeforeTank,
      'modes: the return trip creates no GL object either',
      `${mock.objectCount - objectsBeforeTank} created over ${EASE_FRAMES} frames`);
    assert(app.graph.targets.allocationCount === allocationsBeforeTank,
      'modes: and reallocates no target either');

    /*
     * Key "3": close framing, entered from the world-anchored station, which is
     * the longest journey the rig can make — 3.10 m out and 28° becomes 1.35 m
     * out and 30°, through a blend that has to leave the station's coordinate
     * frame entirely. It is also the transition that most obviously LOOKS like
     * it should cost something: a dolly of nearly two metres, a new lens, and a
     * bearing that is suddenly a function of where the sun is. It costs the same
     * as the other two, which is nothing, and that is what is asserted.
     */
    const objectsBeforeClose = mock.objectCount;
    const allocationsBeforeClose = app.graph.targets.allocationCount;
    browser.doc.dispatch('keydown', { key: '3' });
    browser.pump(EASE_FRAMES);

    assert(app.mode === 'close' && app.camera.mode === 'close',
      'modes: key 3 selects close framing',
      `handle ${app.mode}, camera ${app.camera.mode}`);
    // The simplex, read as a simplex. `modeMix` is the tank weight and is what
    // the rest of the suite has always asserted against; the close weight is
    // the new half of the same statement, and the pair is what distinguishes a
    // settled close framing from a blend that merely left tank framing.
    assert(app.camera.modeWeights.close === 1,
      'modes: and the weights settle exactly one-hot on it',
      `weights ${JSON.stringify(app.camera.modeWeights)}`);
    assert(app.camera.modeMix === 0,
      'modes: with no station left in the blend at all',
      `modeMix ${app.camera.modeMix}`);
    assert(Math.abs(app.camera.fovY - CAMERA_CONSTANTS.CLOSE_FOV_Y) < 1e-6,
      'modes: on the 30 degree lens close framing is derived around',
      `fovY ${(app.camera.fovY * 180 / Math.PI).toFixed(4)} degrees`);
    // §4.5's anti-flare budget, driven rather than argued. Close framing stands
    // 6°-14° below the animal and looks up at it, so it is the framing that
    // spends the most of the 25° elevation limit — 20.484° of worst case, with
    // 4.516° left — and it is therefore the one where a blend that overshot its
    // cap would show up first.
    assert(app.camera.elevationClampCount === 0,
      'modes: and the elevation clamp never fired on the way in',
      `clamped ${app.camera.elevationClampCount} times, max seen ` +
      `${app.camera.maxElevationDegreesSeen.toFixed(2)} degrees`);
    assert(mock.errors.length === 0, 'modes: no GL misuse entering close framing',
      [...new Set(mock.errors)].slice(0, 8).join('\n'));
    assert(mock.objectCount === objectsBeforeClose,
      'modes: close framing creates no GL object either',
      `${mock.objectCount - objectsBeforeClose} created over ${EASE_FRAMES} frames`);
    assert(app.graph.targets.allocationCount === allocationsBeforeClose,
      'modes: and reallocates no target to get there',
      `${app.graph.targets.allocationCount - allocationsBeforeClose} reallocations`);

    // Key "1" again: 3 → 1 is the direction that re-plants the station from a
    // rig that never held one, so it is the leg that would expose a station
    // left stale — or a `_hasStation` that close framing had quietly cleared.
    const objectsAfterClose = mock.objectCount;
    const allocationsAfterClose = app.graph.targets.allocationCount;
    browser.doc.dispatch('keydown', { key: '1' });
    browser.pump(EASE_FRAMES);

    assert(app.mode === 'tank' && app.camera.mode === 'tank',
      'modes: key 1 comes back out of close framing',
      `handle ${app.mode}, camera ${app.camera.mode}`);
    assert(app.camera.modeMix === 1 && app.camera.modeWeights.close === 0,
      'modes: and the simplex lands back on the station, with no close left in it',
      `weights ${JSON.stringify(app.camera.modeWeights)}`);
    assert(Math.abs(app.camera.fovY - CAMERA_CONSTANTS.TANK_FOV_Y) < 1e-6,
      'modes: on the 28 degree lens again',
      `fovY ${(app.camera.fovY * 180 / Math.PI).toFixed(4)} degrees`);
    assert(app.camera.elevationClampCount === 0,
      'modes: and the elevation clamp never fired coming back out',
      `clamped ${app.camera.elevationClampCount} times, max seen ` +
      `${app.camera.maxElevationDegreesSeen.toFixed(2)} degrees`);
    assert(mock.objectCount === objectsAfterClose &&
           app.graph.targets.allocationCount === allocationsAfterClose,
      'modes: and the way out is as free of churn as the way in',
      `${mock.objectCount - objectsAfterClose} objects, ` +
      `${app.graph.targets.allocationCount - allocationsAfterClose} reallocations`);

    /*
     * THE CASE THE SIMPLEX EXISTS FOR. Each frame closes
     * 1 - exp(-h/MODE_TAU) = 0.00554 of the remaining distance at the
     * harness's 16.7 ms step, so four frames into a 1 → 2 ease the weights are
     * {free 0.0220, tank 0.9780, close 0} — a pose that is none of the three
     * framings, and the "from" pose of the transition that starts here is
     * therefore not one either. An outgoing → incoming state machine has to
     * invent an answer for that; a pair of independently-eased scalars can put
     * the rig at a point on no edge of the simplex, whose elevation nobody
     * derived. A simplex re-targets by construction, because every weight is
     * only ever pulled toward the same one-hot corner and the sum is conserved
     * analytically — Σw' = Σw + k(1 − Σw) = 1 — rather than by renormalising.
     *
     * Four frames is deliberate: far enough in that the blend has genuinely
     * left the corner it started on, and far short of the 1e-3 snap 1241
     * frames away, so this is a mid-ease re-target and not a second switch
     * from a pose that had already arrived. The transient hint is long gone by
     * now, so these keystrokes exercise the key handler alone.
     */
    const objectsBeforeRetarget = mock.objectCount;
    const allocationsBeforeRetarget = app.graph.targets.allocationCount;
    browser.doc.dispatch('keydown', { key: '2' });
    browser.pump(4);
    browser.doc.dispatch('keydown', { key: '3' });
    browser.pump(EASE_FRAMES);

    const retargeted = app.camera.modeWeights;
    assert(app.mode === 'close' && app.camera.mode === 'close' &&
           retargeted.close === 1 && retargeted.free === 0 && retargeted.tank === 0,
      'modes: a framing chosen mid-ease still lands exactly one-hot',
      `handle ${app.mode}, camera ${app.camera.mode}, weights ` +
      `${JSON.stringify(retargeted)}`);
    assert(Math.abs(app.camera.fovY - CAMERA_CONSTANTS.CLOSE_FOV_Y) < 1e-6,
      'modes: with the lens following the weights rather than the last key',
      `fovY ${(app.camera.fovY * 180 / Math.PI).toFixed(4)} degrees`);
    assert(app.camera.elevationClampCount === 0,
      'modes: and a re-targeted blend never reaches the elevation clamp',
      `clamped ${app.camera.elevationClampCount} times, max seen ` +
      `${app.camera.maxElevationDegreesSeen.toFixed(2)} degrees`);
    assert(mock.errors.length === 0 &&
           mock.objectCount === objectsBeforeRetarget &&
           app.graph.targets.allocationCount === allocationsBeforeRetarget,
      'modes: and costs nothing either',
      `${mock.errors.length} GL errors, ` +
      `${mock.objectCount - objectsBeforeRetarget} objects, ` +
      `${app.graph.targets.allocationCount - allocationsBeforeRetarget} reallocations`);

    // The suite re-imports main.js once per configuration it boots, with a
    // cache-busted URL, and every boot adds a keydown listener to a document
    // that outlives it. One
    // that is not removed would keep driving a destroyed app's camera on the
    // next section's keystrokes, which is exactly the kind of leak that only
    // ever shows up as a failure somewhere else.
    app.destroy();
    assert((browser.doc._listeners.get('keydown') || new Set()).size === 0,
      'modes: destroy() unwires the key listener',
      `${(browser.doc._listeners.get('keydown') || new Set()).size} left behind`);
  } catch (err) {
    fail('modes: switches framings on a keystroke',
      err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
  } finally {
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

  // §10: "no FFT peak in frame-mean luminance at any period between 20 s and
  // 300 s". That check needs tests/shot.mjs, a real GPU and a Mac, so it
  // cannot run here. What CAN run here is the argument the design makes
  // instead: every carrier it introduces is longer than 300 s by construction,
  // and carriers are summed and never multiplied — a sum of sinusoids has
  // energy only at its own frequencies, whereas the PRODUCT of the 511 s and
  // 743 s depth carriers would place a sum-frequency at
  // 1/(1/511 + 1/743) = 302.7 s, three seconds outside the band. The manifest
  // is what makes the first half greppable; the second half is a rule in
  // sim/director.js's header and in the code that implements it.
  const { DIRECTOR_CONSTANTS } = await import(pathToFileURL(join(JS, 'sim/director.js')).href);
  const insideBand = DIRECTOR_CONSTANTS.PERIODS.filter((p) => !(p > 300));
  assert(insideBand.length === 0,
    'policy: no carrier lands in §10\'s forbidden 20-300 s band',
    `${insideBand.join(', ')} s`);

  // §5.3's calm budget and shaders/cookie.js:104-170's "COOKIE_LAYER_DRIFT
  // must not be raised" are both statements about a RATE, and the caustic
  // clock is now driven through a multiplier. Capping that multiplier's
  // maximum at 1.0 means the shipped rate is the fastest the surface can ever
  // run, so both budgets are respected by construction rather than by care;
  // and keeping the minimum above zero keeps the clock strictly forward-
  // running, because a caustic gobo that stalls reads as a frozen frame.
  assert(DIRECTOR_CONSTANTS.CAUSTIC_RATE_MEAN + DIRECTOR_CONSTANTS.CAUSTIC_RATE_SWING <= 1.0,
    'policy: the caustic clock never runs faster than shipped',
    `peak rate ${(DIRECTOR_CONSTANTS.CAUSTIC_RATE_MEAN +
      DIRECTOR_CONSTANTS.CAUSTIC_RATE_SWING).toFixed(3)}`);
  assert(DIRECTOR_CONSTANTS.CAUSTIC_RATE_MEAN - DIRECTOR_CONSTANTS.CAUSTIC_RATE_SWING > 0,
    'policy: and never runs backwards',
    `floor rate ${(DIRECTOR_CONSTANTS.CAUSTIC_RATE_MEAN -
      DIRECTOR_CONSTANTS.CAUSTIC_RATE_SWING).toFixed(3)}`);
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
/*
 * FRAMING — hours of the simulation, with no GPU anywhere near it.
 *
 * This section exists because of a timescale mismatch the `soak` section
 * cannot fix by trying harder. Everything the soak measures — GL churn, target
 * reallocation, the leash, numerical sanity — either fails inside a minute or
 * does not fail. Whether the animal stays in frame is not like that. It leaves
 * the frame when its depth wanders out from under the station's aim, and that
 * wander is driven by carriers of 511 s and 743 s and a mean-reverting process
 * with τ = 180 s. Sixty seconds is a fifth of the fastest of them: the
 * statistic is identically zero over the soak's window, and both bounds pass
 * against nothing.
 *
 * Pushing the mock-GL soak out to the horizon this needs is not the answer
 * either — thirty minutes of it costs over four minutes of wall clock, and the
 * bound wants hours, not minutes. But the framing statistic reads only CPU
 * state: three classes, four vectors and an angle. So this drives Swim,
 * Director and Camera directly, in js/main.js's exact per-frame order, and
 * gets eight hours of simulated time for a couple of seconds. Nothing here
 * touches the render path, which is what `soak` and the `run/*` configurations
 * are for.
 *
 * It is run at three timestep sizes — the 60 Hz nominal, 50 Hz, and the 1/30 s
 * clamp js/main.js applies to a stalled tab — because the actors are all
 * stochastic and a bound that holds only at one dt is a coincidence rather
 * than a property.
 */
async function sectionFraming() {
  console.log('\n-- framing --');

  const { Swim, SCENE_DEPTH_ORIGIN } = await import(pathToFileURL(join(JS, 'sim/swim.js')).href);
  const { Camera } = await import(pathToFileURL(join(JS, 'camera.js')).href);
  const { Director } = await import(pathToFileURL(join(JS, 'sim/director.js')).href);

  const HOURS = 2;
  const BOUND_RUN = 1080;                      // eighteen seconds at 60 fps
  const BOUND_DUTY = 0.10;
  const BOUND_DEPTH = 2.0;                     // metres of scene y, either way

  for (const dt of [1 / 60, 1 / 50, 1 / 30]) {
    const label = `${(1 / dt).toFixed(0)} Hz`;
    const frames = Math.round((HOURS * 3600) / dt);

    /*
     * The boot pose from js/main.js, minus the SnowField, which needs a camera
     * that has already snapped onto the framing and is not read here.
     */
    const swim = new Swim({ seed: 'aurelia-swim' });
    const camera = new Camera({
      seed: 'aurelia-camera',
      aspect: 16 / 9,
      depthOrigin: SCENE_DEPTH_ORIGIN
    });
    const director = new Director({ seed: 'aurelia-director' });
    director.enterTank(camera.position, swim);
    director.step(0, swim);
    director.compose(swim, 'tank');
    camera.sunTime = director.lightTime;
    camera.setStation(director.stationScene, director.aimTarget, director.aimVelocity);
    camera.setMode('tank', swim.position, true);
    camera.step(0, swim.position, swim.velocity);

    let offFrames = 0;
    let run = 0;
    let longestRun = 0;
    let longestRunAt = 0;
    let depthLow = Infinity;
    let depthHigh = -Infinity;
    let finite = true;

    for (let i = 0; i < frames; i++) {
      // js/main.js's simulate() order, for the actors that decide the framing.
      // The rebase broadcast is here because the camera is in it; the director
      // deliberately is not, because it holds world coordinates and converts
      // inside compose().
      director.step(dt, swim);
      swim.step(dt);
      if (swim.rebasedThisStep) {
        const d = swim.originShift;
        camera.translate(d.x, d.y, d.z);
      }
      director.compose(swim, 'tank');
      camera.sunTime = director.lightTime;
      camera.setStation(director.stationScene, director.aimTarget, director.aimVelocity);
      camera.step(dt, swim.position, swim.velocity);

      const p = swim.position;
      if (p.y < depthLow) depthLow = p.y;
      if (p.y > depthHigh) depthHigh = p.y;
      if (finite && !(swim.worldPosition.isFinite() && camera.position.isFinite())) finite = false;

      // The same in-frame test the GPU would run, from CPU state alone: put
      // the animal in the camera's own basis and compare it against the
      // half-angles the projection is built from. Tank framing is supposed to
      // let the animal graze the edges and occasionally leave — that is the
      // difference between an aquarium and a Steadicam — so this is bounded
      // rather than forbidden.
      const dx = p.x - camera.position.x;
      const dy = p.y - camera.position.y;
      const dz = p.z - camera.position.z;
      const rx = dx * camera.right.x + dy * camera.right.y + dz * camera.right.z;
      const ry = dx * camera.up.x + dy * camera.up.y + dz * camera.up.z;
      const rz = dx * camera.forward.x + dy * camera.forward.y + dz * camera.forward.z;
      const tanY = Math.tan(camera.fovY * 0.5);
      const tanX = tanY * camera.aspect;
      if (!(rz > 0) || Math.abs(ry) > tanY * rz || Math.abs(rx) > tanX * rz) {
        offFrames += 1;
        run += 1;
        if (run > longestRun) { longestRun = run; longestRunAt = i * dt; }
      } else {
        run = 0;
      }
    }

    const duty = offFrames / frames;
    const runSeconds = longestRun * dt;

    assert(finite, `framing/${label}: the simulation stays finite for hours`,
      `went non-finite inside ${HOURS} h at dt = ${dt.toFixed(5)}`);

    /*
     * The depth band, asserted as a BAND rather than as a tendency. The
     * station's aim geometry is sized against how far the animal can get from
     * scene y = 0, and until swim.js's depth term was given a wall outside
     * DEPTH_SOFT_BAND it could not hold one: the 9°/m bias is smaller than the
     * animal's own 12° of tilt noise, and this ran to ±2.4 m. If the wall is
     * ever weakened this fails here rather than showing up as empty water.
     */
    assert(Math.max(-depthLow, depthHigh) < BOUND_DEPTH,
      `framing/${label}: the animal holds a depth band for hours`,
      `scene y spanned ${depthLow.toFixed(3)} … ${depthHigh.toFixed(3)} m over ` +
      `${HOURS} h, bound ±${BOUND_DEPTH.toFixed(1)} m`);

    // §10's "no drift of the animal off frame", read the way tank framing
    // means it. A follow-cam would score a flat 0 % and prove nothing; what is
    // asserted is that the aim dead band lets the animal cross the frame and
    // graze its edges without ever losing it for long enough that somebody is
    // watching an empty tank.
    assert(duty < BOUND_DUTY, `framing/${label}: the animal is in frame`,
      `off frame on ${offFrames} of ${frames} frames (${(100 * duty).toFixed(2)} %)`);
    assert(longestRun < BOUND_RUN,
      `framing/${label}: and never gone for more than eighteen seconds`,
      `longest excursion ${longestRun} frames (${runSeconds.toFixed(1)} s), ` +
      `beginning ${(longestRunAt / 60).toFixed(1)} min in`);
  }

  /*
   * CLOSE FRAMING, OVER THE SAME HOURS AND AT THE SAME THREE TIMESTEPS.
   *
   * The bounds above are re-measured here because none of them is inherited:
   * the close rig is a different radius, a different lens, a different look
   * centre and a different look-error scale, and it is the only one of the
   * three whose bearing is a function of where the sun is — so it is the only
   * rig that keeps moving for a reason that has nothing to do with the animal.
   * Two hours is 20 laps of the sun's own 360 s azimuth carrier, which is what
   * makes this a test of the bearing lock rather than of one arbitrary phase
   * of it.
   *
   * And it carries one bound the tank runs cannot: the MEASURED eye-to-animal
   * distance. `CLOSE_MIN_EYE_DISTANCE = 1.15 m > SNOW_FOCUS_MIN = 1.0 m` is
   * asserted in the agree section, and it is necessary and NOT sufficient —
   * the standoff clamps the DESIRED eye, and what reaches the frame is a
   * position spring that can overshoot a clamped desired by a few centimetres
   * on the frames where the animal is accelerating toward it. Inside 1.0 m the
   * plane of focus sits behind the subject in the one framing where the near
   * bokeh is most of the foreground, so this is the assertion that actually
   * protects the property. If it ever fails, the fix is to raise
   * CLOSE_MIN_EYE_DISTANCE and not to lower SNOW_FOCUS_MIN: at focus 0.8 m the
   * near stratum's own 0.4 m inner edge approaches the focal plane and its
   * bokeh collapses into small sharp opaque specks.
   */
  {
    const snowShaders = await import(pathToFileURL(join(JS, 'shaders/snow.js')).href);
    const BOUND_SUBJECT = snowShaders.SNOW_FOCUS_MIN + 0.05;

    for (const dt of [1 / 60, 1 / 50, 1 / 30]) {
      const label = `close ${(1 / dt).toFixed(0)} Hz`;
      const frames = Math.round((HOURS * 3600) / dt);

      /*
       * js/main.js's boot pose again, unchanged except for the framing it ends
       * on. `enterTank()` and `setStation()` are still called, and still called
       * unconditionally, because that is what main.js does in every framing —
       * the close rig simply ignores what it is handed, its station weight
       * being zero. Testing it any other way would be testing a page that does
       * not exist.
       */
      const swim = new Swim({ seed: 'aurelia-swim' });
      const camera = new Camera({
        seed: 'aurelia-camera',
        aspect: 16 / 9,
        depthOrigin: SCENE_DEPTH_ORIGIN
      });
      const director = new Director({ seed: 'aurelia-director' });
      director.enterTank(camera.position, swim);
      director.step(0, swim);
      director.compose(swim, 'close');
      camera.sunTime = director.lightTime;
      camera.setStation(director.stationScene, director.aimTarget, director.aimVelocity);
      camera.setMode('close', swim.position, true);
      camera.step(0, swim.position, swim.velocity);

      let offFrames = 0;
      let run = 0;
      let longestRun = 0;
      let longestRunAt = 0;
      let depthLow = Infinity;
      let depthHigh = -Infinity;
      let minSubject = Infinity;
      let minSubjectAt = 0;
      let finite = true;

      for (let i = 0; i < frames; i++) {
        director.step(dt, swim);
        swim.step(dt);
        if (swim.rebasedThisStep) {
          const d = swim.originShift;
          camera.translate(d.x, d.y, d.z);
        }
        director.compose(swim, 'close');
        camera.sunTime = director.lightTime;
        camera.setStation(director.stationScene, director.aimTarget, director.aimVelocity);
        camera.step(dt, swim.position, swim.velocity);

        const p = swim.position;
        if (p.y < depthLow) depthLow = p.y;
        if (p.y > depthHigh) depthHigh = p.y;
        if (finite && !(swim.worldPosition.isFinite() && camera.position.isFinite())) finite = false;

        // The distance the whole rig is built around, measured to the ANIMAL
        // rather than to the orbit centre: the orbit is centred on
        // `centre + velocity * 2 * POSITION_TAU`, a 0.31 m lead at the 0.086
        // m/s cruise, so the orbit radius is not the eye-to-animal distance and
        // the constants floor alone never was the guarantee.
        const subject = camera.position.distanceTo(p);
        if (subject < minSubject) { minSubject = subject; minSubjectAt = i * dt; }

        // The same in-frame test the tank runs use, and it needs no adjusting
        // for the new lens because it reads `camera.fovY` live: at a settled
        // close framing that is 30 degrees rather than 28, and through the ease
        // it is whatever the weights make it.
        const dx = p.x - camera.position.x;
        const dy = p.y - camera.position.y;
        const dz = p.z - camera.position.z;
        const rx = dx * camera.right.x + dy * camera.right.y + dz * camera.right.z;
        const ry = dx * camera.up.x + dy * camera.up.y + dz * camera.up.z;
        const rz = dx * camera.forward.x + dy * camera.forward.y + dz * camera.forward.z;
        const tanY = Math.tan(camera.fovY * 0.5);
        const tanX = tanY * camera.aspect;
        if (!(rz > 0) || Math.abs(ry) > tanY * rz || Math.abs(rx) > tanX * rz) {
          offFrames += 1;
          run += 1;
          if (run > longestRun) { longestRun = run; longestRunAt = i * dt; }
        } else {
          run = 0;
        }
      }

      const duty = offFrames / frames;
      const runSeconds = longestRun * dt;

      assert(finite, `framing/${label}: the simulation stays finite for hours`,
        `went non-finite inside ${HOURS} h at dt = ${dt.toFixed(5)}`);

      /*
       * The same depth band, re-measured under the close rig. Nothing reads the
       * camera back into the simulation today, so this is the same excursion the
       * tank runs above measure — which is exactly why it is worth asserting a
       * second time. That independence is a property of the current code and
       * not a law: the first change that lets the framing influence where the
       * animal goes turns the two runs into two different measurements, and
       * this is where the second one is already waiting.
       */
      assert(Math.max(-depthLow, depthHigh) < BOUND_DEPTH,
        `framing/${label}: the animal holds a depth band for hours`,
        `scene y spanned ${depthLow.toFixed(3)} … ${depthHigh.toFixed(3)} m over ` +
        `${HOURS} h, bound ±${BOUND_DEPTH.toFixed(1)} m`);

      // The same bound as tank framing, held to for a different reason. Tank
      // framing is allowed to let the animal cross the frame and graze its
      // edges; close framing is aimed at the animal, so what this is really
      // bounding is the 0.24 m look error scaled to 5.114 degrees of subtense
      // and the 0.10 m framing drop, against a 15 degree half-frame. The bound
      // is left at the tank's 10 % deliberately: an assertion tightened to what
      // the rig happens to measure today is a tripwire on the next carrier
      // phase rather than on a defect.
      assert(duty < BOUND_DUTY, `framing/${label}: the animal is in frame`,
        `off frame on ${offFrames} of ${frames} frames (${(100 * duty).toFixed(2)} %)`);
      assert(longestRun < BOUND_RUN,
        `framing/${label}: and never gone for more than eighteen seconds`,
        `longest excursion ${longestRun} frames (${runSeconds.toFixed(1)} s), ` +
        `beginning ${(longestRunAt / 60).toFixed(1)} min in`);

      assert(minSubject >= BOUND_SUBJECT,
        `framing/${label}: and the eye never gets inside the near-snow focus floor`,
        `closest approach ${minSubject.toFixed(3)} m at ` +
        `${(minSubjectAt / 60).toFixed(1)} min, bound ${BOUND_SUBJECT.toFixed(2)} m ` +
        `(SNOW_FOCUS_MIN ${snowShaders.SNOW_FOCUS_MIN} + 0.05)`);
    }
  }

  /*
   * FREE VIEW IS THE SHIPPED RIG, EVEN WHEN A STATION IS BEING HANDED TO IT.
   *
   * js/main.js calls `setStation()` every frame in BOTH framings, so a settled
   * free view is a camera with `_hasStation` true, `_modeMix` exactly 0, and
   * the station aim clamps running over its look centre. Those clamps are
   * eased on `_modeMix` — `lerp(y, ceiling, 0)` is `y` and `lerp(d, minD, 0)`
   * is `d`, so at a mix of zero the whole function is an identity — and that
   * identity is the entire licence for calling it unconditionally. It is worth
   * an assertion rather than an argument, because the failure it guards
   * against is silent: someone reads the two lerps as redundant, replaces them
   * with the constants, and free view is quietly aimed by the station's 0.57 m
   * height ceiling for ever after, which is exactly the defect the easing was
   * introduced to fix in the first place.
   *
   * Two cameras, the same seed, the same per-frame input, differing only in
   * whether they are given the station. Bit-identical or the property is gone.
   */
  {
    const dt = 1 / 60;
    const swim = new Swim({ seed: 'aurelia-swim' });
    const director = new Director({ seed: 'aurelia-director' });
    const withStation = new Camera({
      seed: 'aurelia-camera', aspect: 16 / 9, depthOrigin: SCENE_DEPTH_ORIGIN
    });
    const without = new Camera({
      seed: 'aurelia-camera', aspect: 16 / 9, depthOrigin: SCENE_DEPTH_ORIGIN
    });
    director.enterTank(withStation.position, swim);
    director.step(0, swim);
    director.compose(swim, 'free');
    for (const cam of [withStation, without]) {
      cam.sunTime = director.lightTime;
      cam.setMode('free', swim.position, true);
      cam.step(0, swim.position, swim.velocity);
    }

    let worst = 0;
    for (let i = 0; i < 3600; i++) {
      director.step(dt, swim);
      swim.step(dt);
      if (swim.rebasedThisStep) {
        const d = swim.originShift;
        withStation.translate(d.x, d.y, d.z);
        without.translate(d.x, d.y, d.z);
      }
      director.compose(swim, 'free');
      withStation.sunTime = director.lightTime;
      without.sunTime = director.lightTime;
      withStation.setStation(director.stationScene, director.aimTarget, director.aimVelocity);
      withStation.step(dt, swim.position, swim.velocity);
      without.step(dt, swim.position, swim.velocity);
      worst = Math.max(
        worst,
        Math.abs(withStation.position.x - without.position.x),
        Math.abs(withStation.position.y - without.position.y),
        Math.abs(withStation.position.z - without.position.z),
        Math.abs(withStation.target.y - without.target.y)
      );
    }
    assert(withStation.modeMix === 0 && worst === 0,
      'framing: a station-fed free view is bit-identical to the shipped rig',
      `mix ${withStation.modeMix}, worst divergence ${worst.toExponential(3)} m over 3600 frames`);
  }
}

async function sectionSoak() {
  console.log('\n-- soak --');

  const { createMockGL } = await import(pathToFileURL(join(ROOT, 'tests/mockgl.mjs')).href);
  const { DIRECTOR_CONSTANTS } = await import(pathToFileURL(join(JS, 'sim/director.js')).href);
  const mock = createMockGL({});
  const browser = installBrowser(mock);

  try {
    const mod = await bootMain(`soak-${Math.random().toString(36).slice(2)}`);
    const app = mod.jellyfish;
    browser.pump(120);

    const objectsAtStart = mock.objectCount;
    const allocationsAtStart = app.graph.targets.allocationCount;

    let maxRadius = 0;
    let maxWorldRadius = 0;
    let maxWorldOffset = 0;
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    let maxElevation = -Infinity;
    const FRAMES = 3600;                       // one minute at 60 fps

    for (let i = 0; i < FRAMES; i++) {
      browser.pump(1);
      const p = app.swim.position;
      const o = app.swim.worldOffset;
      maxRadius = Math.max(maxRadius, Math.hypot(p.x, p.z));
      // Where the animal is in the WORLD, which is the only frame the tank is
      // expressed in: scene position plus the accumulated origin shift.
      maxWorldRadius = Math.max(maxWorldRadius, Math.hypot(p.x + o.x, p.z + o.z));
      maxWorldOffset = Math.max(maxWorldOffset, o.len());
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
    // A MAXIMUM over the run, not the final frame's value. This used to sample
    // once at the end and was safe only by accident: the animal random-walked
    // away and never came back, so the offset grew monotonically and the last
    // frame was also the largest. Inside a bounded tank it circulates instead,
    // and a run that happens to end with the animal back near the world origin
    // would report an offset near zero and fail an assertion about something
    // that had in fact worked perfectly for a minute.
    assert(app.swim.worldPosition.isFinite() && maxWorldOffset > 0.1,
      'soak: and the world scrolls past instead',
      `peak offset ${maxWorldOffset.toFixed(3)} m, final ${app.swim.worldOffset.toString()}`);

    // The tank, which is the whole point of the mode and is enforced nowhere
    // near here: it is a heading-rate bias fed into the yaw integration, so it
    // can only ever be checked by watching where the animal ends up. Both
    // halves matter and they fail for opposite reasons — the upper bound is
    // the steering doing its job, the lower bound is the animal actually using
    // the volume rather than hovering at the origin because the bias was
    // written but never read.
    assert(maxWorldRadius <= DIRECTOR_CONSTANTS.TANK_HARD_RADIUS + 0.40,
      'soak: the animal stays inside its volume',
      `reached ${maxWorldRadius.toFixed(3)} m from the world origin, bound ` +
      `${(DIRECTOR_CONSTANTS.TANK_HARD_RADIUS + 0.40).toFixed(2)} m`);
    assert(maxWorldRadius > 0.90, 'soak: and it actually crosses it',
      `only reached ${maxWorldRadius.toFixed(3)} m in ${FRAMES} frames`);

    // Whether the animal is in frame is deliberately NOT measured here, and
    // the reason is worth writing down so it does not get moved back. This
    // window is one minute. The thing that takes the animal off frame is its
    // depth wandering out from under the aim, and that wander is driven by a
    // 511 s carrier, a 743 s carrier and a 180 s mean-reverting process — the
    // fastest of them is three times longer than the whole window, so over
    // these 3600 frames the statistic is identically zero and both bounds pass
    // against nothing at all. A gate that cannot observe what it asserts is
    // worse than no gate, because it reads as evidence. It lives in the
    // `framing` section instead, which runs hours of the same simulation on
    // the CPU in a fraction of the time this loop takes, and this window keeps
    // the assertions a minute genuinely exercises: GL misuse, GL-object churn,
    // target reallocation, the leash, the depth band and the beat.

    // Which framing every assertion in this section has been measuring. The
    // soak boots with no query, so it measures whatever the default is; if the
    // default ever moved, all of the above would quietly start describing the
    // other mode.
    assert(app.mode === 'tank', 'soak: measures the default mode', `mode ${app.mode}`);

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
  modes: sectionModes,
  framing: sectionFraming,
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
