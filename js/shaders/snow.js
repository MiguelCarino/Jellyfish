/* ============================================================
   shaders/snow.js — marine snow, spec §2.7 / §5.4 (passes 2, 6).
   ------------------------------------------------------------
   Camera-facing instanced quads, lit by the same causticAt() x
   downwelling() x extinction as the shafts and the animal, so a
   mote twinkles when it drifts through a shaft and cannot
   disagree with the light that shaft is made of. Far and mid
   strata draw into SEA in pass 2, near into FINAL in pass 6, so
   the jellyfish is genuinely sandwiched in the particulate rather
   than pasted over it. One program serves all three.

   QUADS, NOT POINT SPRITES. §2.7's listing sets gl_PointSize and
   §2.7's prose says instanced quads. The prose wins, and the
   listing's arithmetic is preserved exactly as the size
   computation. A GL point is clipped on its CENTRE, so an 88 px
   near-field bokeh disc would vanish whole the instant its centre
   crossed the frame edge — a hard pop, on the stratum §5.4 calls
   the strongest "this is a camera in water" cue in the frame.
   Point size limits are also driver-dependent and low on some
   mobile parts. A quad offset in clip space costs one extra
   attribute and has neither problem.

   THE SPRITE IS THE BOKEH. §5.4 and §0 both kill the depth-of-
   field pass outright: an 88 px circle of confusion that would be
   ruinous to gather is simply one textured quad. There is no DOF
   pass anywhere in this renderer, and there must not be one.

   SIZE AND BRIGHTNESS ARE THE SAME NUMBER. A defocused point
   spreads a FIXED flux over a larger disc, so peak coverage falls
   as the square of the drawn diameter. That single line is what
   makes the three strata sit correctly against each other without
   a per-stratum brightness constant, what stops a mote flaring as
   it drifts towards the camera, and — the same trick §2.6 uses on
   the strands — what keeps a sub-pixel mote from shimmering into
   static when it is clamped up to the minimum drawn width.

   It is also why the §7 ladder can cut the far stratum from 900
   to 0 without the frame changing brightness: at 20 m the beam
   transmittance leaves 3 % of a mote's own radiance, and its
   coverage is a few per cent of a pixel, so each far mote moves
   its pixel by well under a tenth of a per cent. They read as
   faint texture on the veil at 12 m and honestly fade to nothing
   by 25 m, which is exactly what §5.4 asks for and exactly why
   removing them is invisible.

   TWO PROFILES, BLENDED BY DRAWN SIZE. A bokeh disc is defined by
   having an EDGE — that is what makes it read as a lens rather
   than as a smudge — but an edge on a three-pixel quad is a
   flicker generator: with no MSAA the rasteriser's coverage is
   binary, so a small hard-edged quad gains and loses whole pixels
   as it drifts across the grid, and a field of nine hundred of
   them boils. So the sprite disc is crossfaded, over 6 to 16
   pixels of drawn diameter, into a smooth (1 - r^2)^2 kernel that
   reaches zero with zero slope at the quad edge and therefore
   rasterises quietly. The soft kernel is renormalised by the
   measured mean of the disc, so the two profiles carry the same
   flux and the crossfade costs no brightness. Near-field bokeh
   keeps its edge; distant motes become the soft points they
   physically are.

   THE PHASE FUNCTION IS THE BARE hg(). §2.0's inscatter() used to
   put a flat 0.75 where a phase function belongs, so a mote lit
   by a normalised hg() came out darker than the water it floats
   in and SNOW_PHASE_NORM existed to rescale it back. inscatter()
   now carries hg(0.0, 0.62) itself, so both sides are radiance
   per steradian and the norm is 1: a mote in unlit water sits at
   albedo * E * hg(theta) against a veil of (sigma_s/sigma_t) * E
   * 0.030, which is about two and a half times the veil looking
   level, and brightens further by hg/hg_isotropic towards the sun
   and by causticAt() inside a shaft. No hard-coded blue, no
   fudge factor, and the twinkle comes out at four to five times
   the veil in a caustic filament.

   LIGHTING IS PER MOTE, IN THE VERTEX SHADER. A floc is a point
   scatterer a few millimetres across; evaluating causticAt()
   across the face of a 96 px bokeh disc would paint a caustic
   gradient onto an object far too small to have one, as well as
   costing nine thousand texture fetches for one particle.
   ============================================================ */

import { CAUSTIC_GLSL } from './cookie.js';

/* --- The lens, spec §2.7 ----------------------------------------------- */

/** Focal length in metres. §2.7: f = 50 mm. */
export const SNOW_FOCAL_LENGTH = 0.050;

/** f-number. §2.7: N = 2.8. */
export const SNOW_APERTURE = 2.8;

/** Focus distance in metres. §2.7: 6.0 m — the animal's working range. */
export const SNOW_FOCUS_DISTANCE = 6.0;

/** Sensor width in metres. §2.7: a 36 mm full-frame sensor. */
export const SNOW_SENSOR_WIDTH = 0.036;

/** §2.7's `clamp(px, 1.0, 96.0)` ceiling. */
export const SNOW_MAX_PIXELS = 96.0;

/**
 * Floor on the drawn diameter, in pixels. Above §2.7's 1.0 because without
 * multisampling a quad of one or two pixels gains and loses whole pixels of
 * rasterised coverage as it drifts, which is a flicker source rather than an
 * aliasing one. At 2.5 px, under the soft profile below, the variation is
 * small. Raising this floor costs brightness rather than gaining it — the
 * coverage term compensates exactly — so it cannot be used to sneak the snow up.
 */
export const SNOW_MIN_PIXELS = 2.5;

/**
 * Drawn diameters between which the smooth kernel is crossfaded into the bokeh
 * disc. Below the first the mote is a soft point; above the second it is a lens.
 */
export const SNOW_SOFT_PIXELS = 6.0;
export const SNOW_DISC_PIXELS = 16.0;

/* --- The floc ---------------------------------------------------------- */

/**
 * Henyey-Greenstein asymmetry of a marine snow aggregate. Moderately forward
 * scattering: a floc lights up when the camera is between it and the sun's
 * downward direction, which is what produces the drifting sparkle rather than a
 * field of uniform dots.
 */
export const SNOW_PHASE_G = 0.45;

/**
 * Kept as a named constant, and kept at 1, because it is the seam between the
 * mote and the medium: hg() already integrates to one over the sphere, and
 * inscatter() now carries its own phase factor, so no rescale belongs here.
 * It existed only to undo the flat 0.75 the veil used to be built from.
 */
export const SNOW_PHASE_NORM = 1.0;

/** Default `uSnowAlbedo`. Detrital aggregates are pale but not white. */
export const SNOW_ALBEDO = 0.8;

/**
 * Coverage fades to zero over this range of camera distance, in metres, so a
 * mote that drifts into the lens dissolves instead of swelling into a
 * frame-filling disc. Below the near stratum's 0.4 m inner edge, so on a
 * correct frame it never fires.
 */
export const SNOW_NEAR_FADE_START = 0.12;
export const SNOW_NEAR_FADE_END = 0.30;

/**
 * Alpha below which a fragment is discarded. Keeps the transparent corners of
 * every quad out of the blender and, where frame.js enables depth writes for
 * the snow in pass 2, out of the depth buffer.
 */
export const SNOW_ALPHA_EPSILON = 1.0 / 2048.0;

/* --- Vertex layout ----------------------------------------------------- */

/**
 * Attribute locations, bound at link time so one VAO can serve every stratum.
 *   aCorner    vec2, divisor 0 — the four quad corners, SNOW_QUAD_CORNERS
 *   aSnowPos   vec3, divisor 1 — mote position in RENDER space, metres
 *   aSnowParam vec3, divisor 1 — (radius in metres, albedo scale, fade 0..1)
 *
 * `radius` is the floc's physical radius; it sets the mote's angular size and
 * therefore its flux, so a bigger floc is genuinely brighter rather than merely
 * bigger. `albedo scale` is a per-mote multiplier on uSnowAlbedo, nominally 1.
 * `fade` is the CPU's handle for spawning and retiring motes at a stratum
 * boundary without a pop; it multiplies coverage.
 */
export const SNOW_ATTRIBUTE_LOCATIONS = Object.freeze({
  aCorner: 0,
  aSnowPos: 1,
  aSnowParam: 2
});

/** The four corners, in triangle-strip order. Draw with drawInstanced('triangle-strip', 4, n). */
export const SNOW_QUAD_CORNERS = new Float32Array([
  -1.0, -1.0,
   1.0, -1.0,
  -1.0,  1.0,
   1.0,  1.0
]);

/* --- The bokeh disc ---------------------------------------------------- */

/** Side of the sprite texture, in texels. §2.7: 64x64. */
export const SNOW_SPRITE_SIZE = 64;

/** GLSL smoothstep semantics, so the sprite and the shader agree on a falloff. */
function smoothstepScalar(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0.0), 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/**
 * Generates the pre-blurred bokeh disc of §2.7 as an R8 texel array, row-major,
 * peak 255. Upload as an R8 texture, LINEAR, CLAMP_TO_EDGE, no mips; the shader
 * reads `.r` with the quad's own [0,1]^2 uv.
 *
 * The faint outer ring is not decoration. A real lens's out-of-focus disc is
 * slightly brighter at its rim, and without it a bokeh sprite reads as an
 * airbrushed blob — the exact "clean CG" tell §0 spends a whole row of its
 * table fixing. It is kept to 12 %, well short of the doughnut a mirror lens
 * gives, because a ring you can name is a ring that is too strong. The disc
 * stops short of the quad edge so bilinear filtering never clips it square.
 */
export function buildBokehSprite(size = SNOW_SPRITE_SIZE) {
  const field = new Float32Array(size * size);
  const centre = (size - 1) * 0.5;
  const scale = 1.0 / centre;

  let peak = 0.0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) * scale;
      const dy = (y - centre) * scale;
      const r = Math.sqrt(dx * dx + dy * dy);

      const body = 1.0 + 0.12 * smoothstepScalar(0.30, 0.88, r);
      const edge = 1.0 - smoothstepScalar(0.84, 0.98, r);
      const v = body * edge;

      field[y * size + x] = v;
      if (v > peak) peak = v;
    }
  }

  const norm = peak > 0 ? 1.0 / peak : 0.0;
  const out = new Uint8Array(size * size);
  for (let i = 0; i < field.length; i++) out[i] = Math.round(field[i] * norm * 255.0);
  return out;
}

/** The shipped sprite, built once. Hand it straight to createTexture2D as `data`. */
export const SNOW_SPRITE = buildBokehSprite(SNOW_SPRITE_SIZE);

/**
 * Mean of the sprite over the whole quad, in [0,1]. This is the disc's flux per
 * unit quad area, and it is what the smooth kernel is renormalised against so
 * that the crossfade in the fragment shader costs sharpness and never
 * brightness.
 */
export const SNOW_SPRITE_MEAN = (() => {
  let sum = 0;
  for (let i = 0; i < SNOW_SPRITE.length; i++) sum += SNOW_SPRITE[i];
  return sum / (SNOW_SPRITE.length * 255.0);
})();

/**
 * Mean of `(1 - r^2)^2` over the quad, which is pi/12 exactly: the integral of
 * the kernel over its unit disc, divided by the quad's area of 4.
 */
const SOFT_KERNEL_MEAN = Math.PI / 12.0;

/** What the soft kernel is multiplied by so it carries the disc's flux. */
export const SNOW_SOFT_NORM = SNOW_SPRITE_MEAN / SOFT_KERNEL_MEAN;

/**
 * JS twin of the shader's circle of confusion, in pixels, for a mote `z` metres
 * from the camera on a target `resX` pixels wide. Exported so the CPU side can
 * retire a mote whose disc has grown past anything worth drawing, and so §10's
 * capture harness can assert the near stratum really is landing in the 30-88 px
 * band §5.4 specifies.
 */
export function snowCoCPixels(z, resX) {
  const f = SNOW_FOCAL_LENGTH;
  const coc = (f / SNOW_APERTURE) * f * Math.abs(z - SNOW_FOCUS_DISTANCE) /
              Math.max(z * (SNOW_FOCUS_DISTANCE - f), 1e-4);
  return coc * (resX / SNOW_SENSOR_WIDTH);
}

/** GLSL float literal: always carries a decimal point. */
function fl(x, digits = 6) {
  if (!Number.isFinite(x)) throw new Error(`snow.js: refusing to emit non-finite GLSL constant ${x}`);
  return x.toFixed(digits);
}

/* --- The program ------------------------------------------------------- */

/**
 * Uniforms shared by both stages:
 *   uViewProj    mat4   the pass's view-projection (SEA's includes the 8 %
 *                       overscan; FINAL's does not)
 *   uCamPos      vec3   camera position in render space
 *   uInvRes      vec2   1 / target size in pixels
 *   uPixelScale  float  0.5 * targetHeightPx * P[1][1] — pixels per (metre per
 *                       metre of depth), i.e. the projection's own scale
 *   uCocScale    float  targetWidthPx / 0.036 — pixels per metre of sensor CoC
 *   uF, uN, uFocus float the lens; SNOW_FOCAL_LENGTH / _APERTURE / _FOCUS_DISTANCE
 *   uSnowMinPx   float  SNOW_MIN_PIXELS
 *   uSnowAlbedo  float  SNOW_ALBEDO
 *   uSnowSprite  sampler2D  the bokeh disc, R8, LINEAR, CLAMP_TO_EDGE
 * plus everything CAUSTIC_GLSL declares.
 */
export const SNOW_VS = `
layout(location = ${SNOW_ATTRIBUTE_LOCATIONS.aCorner}) in vec2 aCorner;
layout(location = ${SNOW_ATTRIBUTE_LOCATIONS.aSnowPos}) in vec3 aSnowPos;
layout(location = ${SNOW_ATTRIBUTE_LOCATIONS.aSnowParam}) in vec3 aSnowParam;

uniform mat4  uViewProj;
uniform vec3  uCamPos;
uniform vec2  uInvRes;
uniform float uPixelScale;
uniform float uCocScale;
uniform float uF;
uniform float uN;
uniform float uFocus;
uniform float uSnowMinPx;
uniform float uSnowAlbedo;

out vec2  vSprite;
out vec3  vColor;
out float vCoverage;
out float vSoft;

#define SNOW_MAX_PIXELS ${fl(SNOW_MAX_PIXELS, 1)}
#define SNOW_SOFT_PIXELS ${fl(SNOW_SOFT_PIXELS, 1)}
#define SNOW_DISC_PIXELS ${fl(SNOW_DISC_PIXELS, 1)}
#define SNOW_PHASE_G ${fl(SNOW_PHASE_G)}
#define SNOW_PHASE_NORM ${fl(SNOW_PHASE_NORM)}
#define SNOW_NEAR_FADE_START ${fl(SNOW_NEAR_FADE_START)}
#define SNOW_NEAR_FADE_END ${fl(SNOW_NEAR_FADE_END)}

void main(){
  vSprite = aCorner * 0.5 + 0.5;

  vec4 clip = uViewProj * vec4(aSnowPos, 1.0);

  // Behind the eye the perspective divide mirrors the quad back into frame as a
  // bright streak. Collapse it past the far plane instead.
  if (clip.w <= 1e-3){
    vColor      = vec3(0.0);
    vCoverage   = 0.0;
    vSoft       = 1.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec3  toEye = aSnowPos - uCamPos;
  float zRad  = max(length(toEye), 1e-3);
  vec3  rd    = toEye / zRad;

  // The floc's own angular size, and the lens's circle of confusion. §2.7's
  // arithmetic verbatim: f = 50 mm, N = 2.8, focus 6.0 m, 36 mm sensor.
  float dGeo = 2.0 * aSnowParam.x * uPixelScale / clip.w;
  float coc  = (uF / uN) * uF * abs(zRad - uFocus) / max(zRad * (uFocus - uF), 1e-4);
  float dCoc = coc * uCocScale;

  // The drawn disc is the floc convolved with the CoC. In quadrature is exact
  // at both limits and close enough between them for two near-round kernels.
  float dDraw = clamp(sqrt(dGeo * dGeo + dCoc * dCoc), uSnowMinPx, SNOW_MAX_PIXELS);

  // Flux is fixed; spreading it over a wider disc dims it as the square. This
  // one line is the whole depth-of-field model and the whole antialiasing
  // model. See the header.
  float cover = min(1.0, (dGeo * dGeo) / (dDraw * dDraw)) * aSnowParam.z;
  cover *= smoothstep(SNOW_NEAR_FADE_START, SNOW_NEAR_FADE_END, zRad);

  // 1 where the mote is too small to carry a lens edge without flickering,
  // 0 where it is large enough to be honest bokeh.
  vSoft = 1.0 - smoothstep(SNOW_SOFT_PIXELS, SNOW_DISC_PIXELS, dDraw);

  // One scatterer, one lighting evaluation. downwelling(), causticAt(),
  // inscatter() and waterApply() are the same functions the shafts and the bell
  // use, at the mote's own true depth.
  float wy    = seaDepth(aSnowPos);
  float phase = SNOW_PHASE_NORM * hg(dot(rd, -uSunDir), SNOW_PHASE_G);
  vec3  lit   = uSnowAlbedo * aSnowParam.y
              * (downwelling(wy) * causticAt(aSnowPos) * phase + inscatter(wy));

  vColor    = waterApply(lit, zRad, wy);
  vCoverage = cover;

  // Screen-aligned by construction: a pixel offset converted to NDC and scaled
  // by w, so the quad is exactly dDraw pixels across whatever the projection.
  clip.xy += aCorner * (dDraw * uInvRes) * clip.w;
  gl_Position = clip;
}
`;

export const SNOW_FS = `
uniform sampler2D uSnowSprite;

in  vec2  vSprite;
in  vec3  vColor;
in  float vCoverage;
in  float vSoft;

out vec4 fragColor;

#define SNOW_ALPHA_EPSILON ${fl(SNOW_ALPHA_EPSILON)}
#define SNOW_SOFT_NORM ${fl(SNOW_SOFT_NORM)}

// The RGBA8 fallback path writes SEA and FINAL pre-exposed by 1/8; post.js
// undoes it. Absent on the float path, where this is the identity.
#ifndef OUT_GAIN
#define OUT_GAIN 1.0
#endif

void main(){
  vec2  q  = vSprite * 2.0 - 1.0;
  float r2 = dot(q, q);

  // Reaches zero with zero slope at the inscribed circle, so a small quad has
  // no rasterisable edge to flicker on. Renormalised to the disc's own flux, so
  // crossfading between the two costs sharpness and not brightness.
  float s    = max(1.0 - r2, 0.0);
  float soft = s * s * SNOW_SOFT_NORM;

  float profile = mix(texture(uSnowSprite, vSprite).r, soft, vSoft);
  float a = vCoverage * profile;
  if (a < SNOW_ALPHA_EPSILON) discard;

  fragColor = vec4(vColor * a * OUT_GAIN, a);   // premultiplied
}
`;

/**
 * Includes for the snow program. The vertex stage samples the caustic gobo with
 * textureLod, which is the only legal form in a vertex shader and is what
 * causticAt() already uses.
 */
export const SNOW_INCLUDES = Object.freeze([CAUSTIC_GLSL]);
