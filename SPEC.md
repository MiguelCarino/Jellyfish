# Jellyfish — Build Spec

**`jellyfish.carino.systems` · Carino Systems fleet · AGPL-3.0 · static, no build step**

*One ambient WebGL2 page. A moon jelly (*Aurelia aurita*) swimming at 14 m depth. Blue only. Nothing else on screen.*

---

## 0. Synthesis record — what was taken, what was grafted, what lost

The backbone is **Mesoglea** (rasterised two-shell bell + signed additive optical-depth buffer). It won on the strength of the thickness pass and the composite-through-the-bell frame graph. Every judge criticism of it is answered below, and every runner-up's `strongest_idea` is grafted or explicitly refused.

### Grafts accepted

| From | Idea | Where it lands |
|---|---|---|
| **Volumetric** | Palette *derived* from per-channel extinction; sun is scene-referred white, never tinted | §5. There is not one hard-coded blue anywhere in the render path. |
| **Volumetric** | One `causticAt()` fetch lights the shafts, the bell and the snow — shafts and surface ripple are the same phenomenon | §2.2, §5.3 |
| **Volumetric** | Hillaire closed-form segment integration, so step count does not change brightness | §2.3 — this is what makes the quality ladder invisible (§7) |
| **Volumetric** | Absolute pixel budget for the expensive buffers, decoupled from display size | §7 |
| **Volumetric** | 30 Hz cadence clamp at the floor instead of degrading further | §7 |
| **Volumetric** | Snell's-window brightening in the far field | §5.2 |
| **Volumetric** | Cookie mip-blurs with depth (shafts crisp near surface, soft at 14 m) | §5.3 |
| **Photographic** | Near-field bokeh **is** the sprite — a pre-generated disc, never gathered | §5.4, §6. Kills the DOF pass outright. |
| **Photographic** | Sensor shot + read noise injected **pre-tonemap**, in linear HDR | §6 |
| **Photographic** | AgX over ACES/Reinhard — desaturates toward white on rolloff instead of clipping neon cyan | §6 |
| **Photographic** | Baked, never-animating anatomical imperfection in the VBO | §3.5 |
| **Photographic** | Poisson skipped/doubled beats | §4.1 |
| **Photographic** | Real CoC arithmetic driving snow sprite size | §5.4 |
| **Raymarch** | Tentacles are **scatterers, not surfaces** — soft supergaussian cross-section, no silhouette to alias | §3.4, §2.6. This replaces WBOIT entirely. |
| **Raymarch** | Elastic recoil **unclamped**, so the bell flares ~8% past rest before settling | §4.1 |
| **Raymarch** | Per-strand hash decorrelation (length, phase, thickness) | §3.4 |
| **Raymarch** | Floating origin — the animal stays near `p≈0`, the sea scrolls | §4.3 |
| **Raymarch** | Retarded-time analytic sway as the stable low-tier / reduced-motion path | §4.4 |

### Judge fatal flaws against the winner — all answered

| Flaw | Answer | §  |
|---|---|---|
| Thickness accumulates **absolute** view distance; a 6 mm wall is 3 ulps of fp16 at 2.5 m; the rim will band and flicker | **Relative encoding.** A front-depth prepass writes `zFront`; the thickness pass accumulates `s·(viewZ − zFront)·density`. Every term is now O(1 cm), one ulp ≈ 15 µm, the wall is ~400 ulps. Mathematically identical sum, 160× the precision. | §2.4 |
| RGBA8 fallback **cannot run** the thickness pass (UNORM blending clamps; front faces cannot subtract) | The fallback does not attempt it. It uses the **analytic slab path** `L = 2·w(φ)·ρ(φ,θ)/max(\|N·V\|,0.15)`, exact for a locally planar shell. Loses only the "arm folded under the bell adds to τ" case. | §2.5 |
| Reintroduced `F0 = 0.02` anisotropic GGX ribbon + bloom = blown glass, undoing its own Fresnel argument | **Cut.** No anisotropy, no ribbon. One broad sheen at `F0 = 0.0004`, α = 0.45, and the bloom knee sits *above* any value it can reach. The rim comes from τ, always. | §2.5 |
| Vignette to `#050505` — there is no black underwater; inscatter puts a floor on every pixel | Vignette falls to the **far-field veil colour**, never to black. The seam under the navbar is handled in CSS with a 28 px gradient strip, not by crushing the frame. | §6, §9 |
| No veiling glare / near-field particulate lift → reads as clean CG | Added: flat veiling term off the level-4 bloom mip, plus pre-tonemap grain. | §6 |
| **No minimum shippable subset** — 13 passes, nothing visible until pass 9 | Cut to **8 passes**, with a 4-milestone build order where M1 is already a watchable page. | §2, §10 |
| `blitFramebuffer` into a multisampled draw FBO is `INVALID_OPERATION` | Correct — that direction is illegal. SEA→FINAL is a **fullscreen-triangle draw**. The only blit is MS→single-sample, which is legal, and MSAA is now an optional probe-gated bonus, not load-bearing. | §2.6 |
| Tentacles rendered half-res non-MSAA, contradicting the whole MSAA argument | Strands are **full-res**, soft-edged, per-strand CPU-sorted. No WBOIT, no half-res, no MSAA dependence. | §2.6 |
| Mobile story self-contradicts (FP16 targets on a TBDR GPU) | Mobile tiers reduce **pass count and format**, not just resolution: 4 passes, two RGBA8 targets, no THICK, no RAYS. | §7 |
| **Designed-in periodic flare** — HG g=0.86 backlight blaze on a 47 s camera axis, amplified by bloom | Four independent fixes: sun near-vertical (72°) with the camera never above 25°, so the "sun behind animal" alignment is *never reached*; `g` 0.86→0.72 with a hard cap on the HG peak; luminance governor with a ±0.25 EV clamp; bloom knee above the rim's operating level. | §4.5, §5.1, §6 |
| Sharp `pow(c,6)` caustics are agitating, not calming | `pow(c, 2.5)`, depth-mipped, amplitude 0.35 on the bell, scroll rate halved. A **rate budget** is now a shipping requirement. | §5.3, §10 |
| Quality tiers pop (tentacles 48→24, bloom 5→3) | **Tentacle count is fixed at 40 in every tier, forever.** Ladder touches only shaft steps, bloom levels, far-snow count, bell LOD, buffer scale — all brightness-invariant by construction. renderScale cross-fades over 0.75 s. | §7 |

### Contradictions between grafts — resolved

1. **Verlet chains vs. retarded-time analytic sway.** *Verlet wins for the primary path.* The vortex-ring recoil — the single best motion idea in the winner — requires force integration; retarded time cannot respond to a shed ring. But retarded time is unconditionally stable and stateless, so it is the **reduced-motion path and the tier-4 path**, and it drives the frill phase across arm width where a solver buys nothing. Both ship. (§4.4)
2. **AgX vs. Reinhard-Jodie.** *AgX wins.* Reinhard-Jodie preserves hue including at the highlight, which is exactly wrong here: an overexposed bell in a photograph goes **pale, then near-white**, never saturated. AgX desaturates on rolloff. Costs ~15 lines. (§6)
3. **Blue-lock grade: 82/18 ramp (mesh) vs. 72 % `lockBlue` (photographic).** *Both lose.* Mesh's ramp kills the hue-drift-with-distance that reads as depth; photographic's `PALETTE` is arithmetically broken (its luma is 0.53, not 1.0, so it darkens by 34 % and drags neutral highlights back to saturated blue, undoing AgX). Replaced by a **guard rail**: a clamp that forbids hue leaving the blue-cyan wedge and is a no-op on a correct frame. Clamp, not mix. (§6)
4. **Per-fragment strand/bell depth split vs. per-strand sort.** *Per-strand sort wins.* The per-fragment split needs a full-res `BELLDEPTH` and cuts a **soft** object at a hard boundary — the wrong operation. 40 strands sort in microseconds and the granularity error is invisible on an object with no silhouette. (§2.6)
5. **Jerlov Type I clear water vs. heavy marine snow.** Contradictory water types (the clarity argues 30 m visibility, the snow argues coastal turbidity). *Compromise stated:* Jerlov IB→II coefficients, moderate snow density. Numbers in §5.1.
6. **Diffuse attenuation `Kd` used as beam extinction.** Both losing proposals made this error, which under-hazes the far field. Fixed: **two coefficient sets** — `SIG_T_W` (beam, for transmittance) and `KD` (diffuse, for the downwelling depth ramp). (§5.1)
7. **Dome-port dust specks (photographic).** *Cut.* On an always-open second monitor a static blurred blob reads as a dead pixel and invites the viewer to wipe the screen. The calm lens beats the photographic lens on a page whose purpose is ambience.
8. **Depth-of-field pass.** *Cut, deliberately.* Near snow *is* pre-blurred bokeh; mid/far snow gets CoC-scaled point size; the animal is the subject and stays sharp. A separable bokeh gather would cost more than the rest of the frame and improve nothing.

---

## 1. Rendering pipeline — pass by pass

WebGL2, forward, HDR-linear throughout. All GLSL ships as ES-module template strings in `js/shaders/*.js` and is concatenated at program-build time — **never** `fetch`ed, so the site runs from `file://` as well as GitHub Pages.

```js
canvas.getContext('webgl2', {
  antialias: false, alpha: false, depth: false, stencil: false,
  preserveDrawingBuffer: false, powerPreference: 'default'
});
```

`powerPreference:'default'` is deliberate — forcing the discrete GPU on a page left open for fifteen hours is a thermal and battery bug.

### Buffers

`RS` = scene render scale (§7). `W,H` = CSS size × `min(devicePixelRatio, dprCap)`.

| Name | Size | Format | Contents |
|---|---|---|---|
| `COOKIE` | 256×256, 4 mips | `R8` | caustic gobo, regenerated per frame |
| `RAYS_A/B` | `RS/2` | `RGBA16F` ×2 ping-pong | raymarched shafts + 4-frame history |
| `SEA` | `RS` | `RGBA16F` + `DEPTH_COMPONENT24` | water column, shafts, far+mid snow, behind-strands, bell interior |
| `ZFRONT` | `RS/2` | `R16F` | view-space Z of the nearest bell **front** face |
| `THICK` | `RS/2` | `RG16F` | R = optical depth Σρ·ds, G = geometric Σds (both relative to `ZFRONT`) |
| `FINAL` | `RS` | `RGBA16F` (+ optional 4× MS renderbuffer) | composited scene |
| `BLOOM[0..4]` | `RS/2 … RS/32` | `RGBA16F` ×2 chains | dual-filter Kawase down/up |
| `EXPO_A/B` | 1×1 | `R16F` | luminance EMA ping-pong (no `readPixels`, ever) |

Memory at 1920×1080 CSS, `RS`=1.12: ≈ 31 MB. RGBA8 fallback path halves it.

### The eight passes

| # | Pass | Target | Res | Depth | Cull | Blend |
|---|---|---|---|---|---|---|
| 0 | `cookie` — 3-layer ridged noise gobo | `COOKIE` | 256² | off | – | off |
| 1 | `shafts` — 16-step jittered march, Hillaire closed form, blended with 4-frame history | `RAYS_A↔B` | RS/2 | off | – | off |
| 2 | `sea` — analytic water column + bilateral-upsampled shafts + far & mid snow + **behind** strands | `SEA` | RS | write on for snow/strands only | – | premultiplied `ONE, 1-SRC_ALPHA` |
| 3 | `bellfront` — bell front faces, view-Z out | `ZFRONT` | RS/2 | test+write | BACK | off |
| 4 | `thickness` — **all** jelly geometry, signed additive | `THICK` | RS/2 | **off** | **disabled** | `ONE, ONE`, cleared to 0 |
| 5 | `interior` — subumbrella (cull FRONT) + gonad tubes + manubrium + oral arms | `SEA` | RS | test on, write off | FRONT / BACK | `SRC_ALPHA, 1-SRC_ALPHA` |
| 6 | `main` — fullscreen SEA→FINAL draw, then **exumbrella** (samples SEA for refraction), then **front** strands, then near snow | `FINAL` | RS | off | BACK | premultiplied |
| 7 | `post` — bright-pass, 5-level bloom, composite → default framebuffer | – | native | – | – | – |

**Why nothing depth-tests against the bell.** The exumbrella is drawn last and composites everything behind it *through itself*: its shader outputs `emitted + Tr·refract(SEA)`. So the subumbrella, gonads and far tentacles are not merely occluded by the bell — they are tinted, dimmed and optically distorted by it. This is strictly more correct than depth sorting *and* cheaper than an eight-pass depth peel.

**Antialiasing.** MSAA is a probe-gated bonus only (`getInternalformatParameter(RENDERBUFFER, RGBA16F, SAMPLES)` ≥ 4 → allocate `FINAL` multisampled, resolve MS→SS with `blitFramebuffer`, which is the legal direction). Baseline is `RS > 1.0` supersampling where the pixel budget allows plus a 9-tap FXAA in the composite. Everything soft — strands, snow, shafts — is analytically antialiased and does not depend on either.

---

## 2. Every shader

### 2.0 `common.js` — shared by every program

```glsl
#define PI 3.14159265
#define TAU 6.28318531

// --- The medium. Two coefficient sets, deliberately. -----------------
// Beam attenuation (for transmittance over a path). Jerlov IB->II.
const vec3 SIG_T_W = vec3(0.560, 0.230, 0.170);   // 1/m
// Scattering only (for in-scatter). Blue-leaning: lambda^-4 lean + particulate.
const vec3 SIG_S_W = vec3(0.045, 0.055, 0.075);   // 1/m
// Diffuse downwelling attenuation with DEPTH. NOT the same number.
const vec3 KD      = vec3(0.420, 0.075, 0.032);   // 1/m
// Mesoglea. Reduced (similarity theory) at use site.
const vec3 SIG_A_G = vec3(2.60, 0.55, 0.16);      // 1/m
const vec3 SIG_S_G = vec3(14.0, 16.5, 19.0);      // 1/m
const float G_GEL  = 0.72;                        // was 0.86 -- see §4.5

// Scene-referred, essentially white. NEVER tinted blue.
const vec3 SUN_E0  = vec3(1.00, 1.02, 1.05) * 22.0;

// Downwelling radiance at depth. worldY <= 0, surface at y = 0.
vec3 downwelling(float y){ return SUN_E0 * exp(KD * y); }

// Ambient in-scatter: single-scattering albedo x downwelling.
vec3 inscatter(float y){ return (SIG_S_W / SIG_T_W) * downwelling(y) * 0.75; }

// THE SHARED SNIPPET. Ends every shader in the project. This one function is
// why the animal sits IN the water instead of on top of it.
vec3 waterApply(vec3 c, float dist, float y){
  vec3 T = exp(-SIG_T_W * dist);
  return c * T + inscatter(y) * (1.0 - T);
}

float hg(float c, float g){
  float g2 = g*g;
  return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5));
}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056,0.00583715)))); }
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; return fract(p*(p+p)); }
```

### 2.1 `cookie.js` — the caustic gobo (pass 0)

One 256² `R8` texture with mips, regenerated per frame (every other frame at tier ≥ 3). It is a *texture* rather than an inline function because the shaft march samples it 16×/pixel.

```glsl
float ridged(vec2 p, float t){
  float k = 0.0, a = 1.0;
  for (int i = 0; i < 3; i++){
    vec2 q = p * (1.0 + 0.9*float(i)) + float(i)*17.3;
    k += a * abs(sin(q.x*1.9 + sin(q.y*1.6 + t*0.42)));
    a *= 0.58;
    p  = mat2(0.80,-0.60,0.60,0.80) * p * 1.7;
  }
  // pow 2.5, NOT 6.0. Sharp filaments crawling over the subject are agitating,
  // not calming. Softened deliberately -- see the calm rate budget in §10.
  return pow(max(1.0 - k/1.85, 0.0), 2.5);
}
```
Scroll: layer speeds `0.025` and `−0.016` u/s at scales 1.0× and 1.7×. `uCookieDrift` advances on the same clock as the shafts.

```glsl
// Sampled by projecting a world point up the sun ray onto the surface plane.
// The mip term is physical: multiple scattering diffuses shafts with depth.
float causticAt(vec3 p){
  vec2 uv = (p.xz - uSunDir.xz * (p.y / uSunDir.y)) * uCookieScale + uCookieDrift;
  float mip = clamp(-p.y * 0.11, 0.0, 4.0);
  return textureLod(uCookie, uv, mip).r;
}
```
**This is the same fetch used by the shaft march, the bell key light and the snow twinkle.** There is no separate godray system that can disagree with the animal's lighting.

### 2.2 `shafts.js` — raymarched godrays (pass 1)

16 steps, blue-noise jittered per pixel per frame, accumulated four frames deep. Half-res. `~0.55 ms` at 1600×900.

**Hillaire energy-conserving segment integration — load-bearing.** Never a Riemann sum: without it, halving the step count visibly dims the volume, so every tier change would flash.

```glsl
vec3  L = vec3(0.0);
vec3  T = vec3(1.0);
float t = tNear + ign(gl_FragCoord.xy + uFrame*7.0) * dt;
for (int i = 0; i < SHAFT_STEPS; i++){
  vec3 p = ro + rd * t;
  vec3 S = SUN_E0 * causticAt(p) * exp(KD * p.y) * hg(dot(rd, -uSunDir), 0.62)
         * SIG_S_W
         + inscatter(p.y) * SIG_S_W;
  // closed form over a locally-constant segment: brightness is step-count invariant
  vec3 Sint = (S - S * exp(-SIG_T_W * dt)) / max(SIG_T_W, vec3(1e-5));
  L += T * Sint;
  T *= exp(-SIG_T_W * dt);
  t += dt;
}
```
History blend `0.90`, rejected when camera translation exceeds 4 cm/frame (the camera drifts at under 2 cm/s, so this effectively never fires). Bilateral upsample into `SEA` using the depth attachment.

### 2.3 `sea.js` — water column + snow (pass 2)

Fullscreen: `inscatter(y)` along the view ray gives the vertical gradient for free — there is no painted ramp anywhere. Far field adds the **Snell's-window** term (refraction packs the whole sky into a 97.2° cone overhead; still a real brightening straight up even after diffusion):

```glsl
vec3 far = inscatter(uCamY + rd.y * 45.0);
far += SUN_E0 * 0.0028 * smoothstep(0.66, 1.0, rd.y);
```
Then bilateral-upsampled shafts, then instanced far/mid snow (§5.4), then behind-strands (§2.6).

### 2.4 `thickness.js` — the optical-depth accumulator (pass 4)

The centrepiece, and the pass where the winner's fatal precision flaw is fixed.

```glsl
#version 300 es
precision highp float;
in float vViewZ;      // positive distance from eye, this fragment
in float vDensity;    // tissue density from density(phi,theta)
uniform sampler2D uZFront;
uniform vec2  uInvRes;
out vec2 oThick;
void main(){
  // ---- THE FIX ----------------------------------------------------------
  // Reference every layer to the bell's own front depth. The signed sum is
  // mathematically unchanged, but each term is now O(1 cm) instead of O(2.5 m).
  // fp16 ulp at magnitude 0.02 is ~15 um; a 6 mm wall is ~400 ulps instead of 3.
  float zf = texture(uZFront, gl_FragCoord.xy * uInvRes).r;
  float d  = vViewZ - zf;                 // relative depth, metres
  // -----------------------------------------------------------------------
  float s = gl_FrontFacing ? -1.0 : 1.0;  // back faces add, front faces subtract
  oThick = vec2(s * d * vDensity, s * d);
}
```

Culling **disabled**, depth **off**, blend `ONE, ONE`, cleared to `(0,0)`. Summed over every layer along the ray — the double-walled bell, an oral arm crossing it, a tentacle behind it — the R channel is the total optical path *inside* the animal and the G channel the geometric one. Any number of layers, any concavity, one pass, no peeling.

**Density is a pattern, not a constant.** Real mesoglea is 96 % water and nearly clear; a constant σ_s gives an invisible animal, and cranking it gives wax. What a photograph shows is *structure*:

```glsl
float density(float phi, float theta){          // phi: 0 apex -> 1 margin
  float bulk   = 1.0;
  float muscle = 3.2 * smoothstep(0.45, 0.95, phi);                 // coronal ring
  float canal  = 2.0 * pow(abs(cos(8.0*theta)), 24.0)               // 16 radial canals
                     * smoothstep(0.25, 0.90, phi);
  float rim    = 3.6 * smoothstep(0.88, 1.00, phi);                 // dense margin
  float gonad  = 2.4 * smoothstep(0.55, 0.20, abs(cos(2.0*theta)))  // 4 horseshoes
                     * smoothstep(0.58, 0.34, phi) * smoothstep(0.16, 0.30, phi);
  return bulk + muscle + canal + rim + gonad;
}
```
The canals and gonads therefore show *through* the bell as denser, brighter structures, correctly occluding and correctly summing where an arm folds underneath. That is the difference between "translucent object" and "tissue", and it is what a baked per-vertex thickness map cannot do.

Read side, with the guards the flaw report demanded:

```glsl
vec2  th   = max(texture(uThick, vScreenUV).rg, vec2(0.0));  // clamp precision noise
float tau  = min(th.x, 6.0);        // hard clamp: an unsealed rim must not blow out
float dGeo = min(th.y, 0.40);
```

### 2.5 `bell.js` — exumbrella and subumbrella (passes 3, 5, 6)

One source, two programs via `#define SUBUMBRELLA`.

**Vertex: analytic normals from three evaluations of `deform()`.** No skinning, no CPU morph, no normal-map cheat:

```glsl
vec3 p0  = deform(vUV);
vec3 nrm = normalize(cross(deform(vUV + vec2(0.0, dTheta)) - p0,
                           deform(vUV + vec2(dPhi,  0.0)) - p0));
```

**Fragment — Beer–Lambert with similarity theory:**

```glsl
vec3 sigS = SIG_S_G * (1.0 - G_GEL);   // reduced scattering
vec3 sigT = SIG_A_G + sigS;
vec3 Tr   = exp(-sigT * tau);          // transmittance of the slab
vec3 alb  = sigS / sigT;               // single-scattering albedo = the tint
```

**Two SSS terms with different jobs:**

```glsl
float wrapDiffuse(vec3 N, vec3 L, float w){
  return clamp((dot(N,L) + w) / ((1.0 + w)*(1.0 + w)), 0.0, 1.0);
}

// (1) MULTIPLE SCATTERING: light that entered and did not get through.
vec3 ms = alb * (1.0 - Tr) * wrapDiffuse(N, L, 0.65) * uSunCol * shadowG;

// (2) SINGLE SCATTERING: forward-peaked. g is 0.72, and the peak is CAPPED --
//     this is the term that produced the periodic flare the calm judge flagged.
float phase = min(hg(dot(-L, V), G_GEL), 2.4);
vec3 ss = uSunCol * phase * Tr * (1.0 - exp(-sigS * tau)) * shadowG;

// (3) AMBIENT: analytic water dome, no cubemap, no asset, no network.
vec3 amb = mix(inscatter(vWorldY - 0.6), inscatter(vWorldY + 0.6), N.y*0.5 + 0.5)
         * alb * (1.0 - Tr) * 0.6;
```

**Fresnel, honestly.** n_gel/n_water = 1.35/1.333 = 1.0128, so F0 = 4.0×10⁻⁵. A real jellyfish has essentially *no* Fresnel reflection — that is exactly why it is nearly invisible in water. The luminous rim is not reflection: at the silhouette the ray travels centimetres through the dense margin, τ explodes, and the tissue lights up from scattering. `tau` produces that automatically.

```glsl
// F0 = 4e-4 stands in for the surface mucus film ONLY -- 10x physical, which is
// as far as this is allowed to go. NO anisotropic ribbon, NO bloom on it:
// the bloom knee (1.15) sits above anything this term can produce.
const float F0 = 0.0004;
float F    = F0 + (1.0 - F0) * pow(1.0 - max(dot(N,V), 0.0), 5.0);
vec3  spec = ggx(N, V, L, 0.45) * F * uSunCol;
```

**Refraction with a real march distance** (the measured `dGeo`, so distortion grows where the bell is thick and vanishes at the margin — structure a `uv += N.xy*k` hack cannot produce):

```glsl
vec3 rd   = refract(-V, N, 1.0/1.0128);
vec4 clip = uViewProj * vec4(vWorldPos + rd * dGeo, 1.0);
vec2 uvR  = clip.xy / clip.w * 0.5 + 0.5;

// Cauchy dispersion, +-1.5% on eta -> an indigo/cyan fringe at the rim.
vec3 bg;
bg.r = texture(uSea, mix(vScreenUV, uvR, 0.985)).r;
bg.g = texture(uSea, uvR).g;
bg.b = texture(uSea, mix(vScreenUV, uvR, 1.015)).b;

// Guard: a tap that leaves the frame falls back to the straight one.
float ok = step(0.0, min(uvR.x,uvR.y)) * step(max(uvR.x,uvR.y), 1.0);
bg = mix(texture(uSea, vScreenUV).rgb, bg, ok);

vec3 col = ms + ss + amb + spec + bg * Tr;
fragColor = vec4(waterApply(col, vViewDist, vWorldY) * coverage, coverage);
```

The SEA texture is rendered with **8 % guard-band overscan** so refraction taps near the frame edge still find data (the loose look-at camera makes edge framing likely). Overscan is dropped at tier ≥ 3.

**Analytic thickness fallback** (no `EXT_color_buffer_float`, i.e. iOS < 16.4 only). The THICK and ZFRONT passes are skipped entirely:

```glsl
#ifdef ANALYTIC_THICKNESS
  float ndv  = max(abs(dot(N, V)), 0.15);
  float tau  = 2.0 * uWall * vThickScale * density(vPhi, vTheta) / ndv;
  float dGeo = 2.0 * uWall * vThickScale / ndv;
#endif
```
Exact for a locally planar shell; loses only cross-body summation. This is a *real* fallback that produces a good image, not a degraded version of a pass that cannot run.

**Self-shadowing** (`shadowG`): the same thickness program re-rendered from the sun's view at 256² into an `R16F` light-space optical depth, **every frame** (it costs 0.03 ms; a 1 s cache would lag visibly against a 2.2 s pulse). Oral arms cast soft coloured shadow into the bell interior — the dark subumbrellar cavity under a bright dome is one of the most recognisable things in real *Aurelia* footage. Ambient is cos-weighted downward (`N.y` term above) so the cavity does not flood back in.

### 2.6 `strands.js` — oral arms and tentacles (passes 5, 6)

**Tentacles are scatterers, not surfaces.** A 1 mm translucent thread genuinely is a low-density scatterer with a soft cross-section, not a hard boundary. Rendering it as one deletes the entire class of thin-geometry aliasing.

```glsl
// Supergaussian cross-section: a definite core, no hard edge, no silhouette.
// Exponent 1.6 -- a plain Gaussian reads as smoke, a hard edge aliases.
float r  = abs(vAcross);                         // 0 at spine, 1 at ribbon edge
float a  = exp(-pow(r * 1.45, 1.6));

// Screen-space minimum width with compensating alpha: without this a 4K render
// shimmers into static.
a *= min(1.0, vWorldWidthPx / 1.4);

vec3 sc = alb * uSunCol * hg(dot(-L, V), 0.55) * vDensity * shadowG
        + inscatter(vWorldY) * 0.5;
vec3 col = waterApply(sc, vViewDist, vWorldY);
fragColor = vec4(col * a, a);                    // premultiplied
```

**Ordering.** Per-strand CPU sort (40 chains — microseconds), split into two groups by chain-centroid depth relative to the bell centre: the *behind* group draws into `SEA` (pass 2) and is therefore composited *through* the bell by the exumbrella; the *front* group draws into `FINAL` (pass 6). Per-strand granularity is invisible on an object with no silhouette, and a strand crossing the rim gets fogged rather than clipped.

**WBOIT is dropped.** Its weight function has a narrow usable range and outside it the bundle becomes a flat grey-blue smear — which, in a one-hue palette, has no chroma difference to rescue it. Soft cross-sections plus a per-strand sort are both cheaper and better.

Oral arms use the same fragment shader with `vDensity` ~3× higher and a ruffled 5-point cross-section.

### 2.7 `snow.js` — marine snow (passes 2, 6)

Instanced camera-facing quads, premultiplied additive, lit by the same `causticAt` × `SUN_E0` × extinction as everything else, so a mote twinkles when it crosses a shaft.

```glsl
// Real CoC. f = 50mm, N = 2.8, focus 6.0m, 36mm sensor.
float coc = (uF/uN) * uF * abs(z - uFocus) / max(z * (uFocus - uF), 1e-4);
float px  = coc * (uResX / 0.036);
gl_PointSize = clamp(px, 1.0, 96.0);
```
**The near stratum's sprite texture IS the bokeh** — a pre-generated 64×64 disc with a soft edge and a faint outer ring. An 88 px CoC that would be ruinous to gather is one textured quad. No DOF pass exists anywhere in this renderer.

### 2.8 `post.js` — the composite (pass 7)

Full listing in §6.

---

## 3. Anatomy and procedural geometry

All geometry generated in JS at load, uploaded once as static VBOs. Strand vertices are the only per-frame upload (`bufferSubData`, ~34 KB/frame).

### 3.1 Bell — closed two-shell surface of revolution

- **Radius** `R = 0.13 m` (26 cm bell). **Height** `H = 0.34 R` relaxed.
- **Profile:** Catmull–Rom through `(r/R, y/R)` = `(0.00,0.340) (0.28,0.325) (0.55,0.285) (0.78,0.205) (0.93,0.105) (1.00,0.000)`.
- **Wall half-thickness:** `w(φ) = R · (0.058·(1 − φ²) + 0.006)` → 8.3 mm at apex, 0.78 mm at margin. Not cosmetic: the closed shell is what makes the signed accumulation valid.
- **Tessellation:** 160 azimuthal × 48 rings, generated **twice** — outer exumbrella, inner subumbrella offset by `−N·w(φ)` — plus a rim band stitching them into a **watertight** shell. ≈ 34 k triangles. LOD1 (tier 3+): 112 × 36, pre-generated at load; switching is a `bindVertexArray`, not a rebuild.
- **Margin:** 16 lappets, `r *= 1 + 0.038·cos(16θ)`, with a matching downward fold; 8 rhopalia notches at `−0.010·pow(abs(cos(8θ)),12)`. The silhouette is scalloped, never a circle.
- **Fringe band:** the rim band carries a shader-side noise-modulated density term producing the dense short-tentacle fringe for free — no geometry, no draw call.

### 3.2 Gonads and manubrium

Four horseshoe tube segments (24 × 8 each) inside the bell at `φ ∈ [0.30, 0.55]`, spanning 70° centred at `45° + 90°k`. Drawn in the interior pass; *also* boosted in `density()` so they attenuate correctly through the bell. This is the single most recognisable feature of a moon jelly and the reason the interior pass exists. Manubrium: a 4-lobed stub at the subumbrella centre, 12 × 8.

### 3.3 Oral arms

4 ribbons, 20 nodes, 5-point ruffled cross-section. Width `0.9 R` at root → `0.15 R` at tip. Frill: `w += 0.012 R · sin(9s + 2.4·t_ret + hash(arm))` where `t_ret` is the retarded time (§4.4) — the ruffled curtain undulates independently of the arm's gross motion.

### 3.4 Tentacles

**40 strands, fixed at 40 in every quality tier, forever** (this is what makes the perf ladder invisible). 14 nodes each. Camera-facing strips, world half-width 0.9 mm with a 1.4 px screen minimum and compensating alpha.

- 12 **guide** chains: full verlet.
- 28 **interpolated**: barycentric between adjacent guides, with per-strand hash decorrelation of length (log-normal, σ = 0.35), phase, and thickness. Three noticeably long, two broken short.

### 3.5 Baked imperfection — never animates

Perfection is the loudest CG tell, and a one-hue palette leaves nowhere for form errors to hide. Baked into `aParam2` at init and frozen, so it reads as **anatomy**, not wobble:

1. 3-D value noise on the rest radius, 1.4 cycles/bell, amplitude 2.5 % of R.
2. One torn lappet: a random θ₀, margin arc shortened up to 12 % inside a 25° wedge with a smoothstep falloff.
3. Per-lappet contraction gain jitter ±6 %, so the eight lobes never move in unison.
4. Asymmetric coronal muscle gain: one side contracts 8 % harder, so the animal slowly and unrepeatably yaws.
5. Gonad horseshoes are not identical — each gets ±12 % area and ±4° rotation.

---

## 4. Motion

### 4.1 The pulse

Contraction is fast and muscular; relaxation is slow, passive elastic recoil. A symmetric sine reads as a beating toy; this asymmetry is the entire tell.

```js
const C = 0.26;
function pulse(x){                       // x in [0,1)
  if (x < C){ const u = x / C; return Math.pow(u*u*(3-2*u), 0.8); }
  const u = (x - C) / (1 - C);
  return Math.exp(-2.4*u) * Math.cos(2.6*u);   // NOT clamped at zero
}
```
The recoil term is **deliberately unclamped**: it dips to ≈ −0.081, so the bell flares about 8 % *wider than rest* before settling. That overshoot is the visible signature of an under-damped elastic body, and it is what sells "soft" rather than "shape key".

- **Base period** 2.20 s (0.455 Hz), wandering ±14 % on a 96 s carrier plus an Ornstein–Uhlenbeck jitter of ±6 % per beat.
- **Poisson irregularity**, λ = 1/28 s: 60 % of events *skip* a beat (hold relaxed 0.5–1.0 s), 40 % fire a *double* (period ×0.58 for two cycles, as a real medusa does when correcting course). Over the ten minutes someone leaves this open at 3am, the pattern never resolves.

### 4.2 The kinematic wave

The contraction phase is a function of position on the bell, so it *travels* from apex to margin, arriving 0.20 of a cycle (0.44 s) later. The margin always lags the crown. One constant, and it does more for "alive" than any shading term.

```glsl
vec3 deform(vec2 uvp){                     // uvp = (phi apex->margin, theta)
  vec3  r  = restPos(uvp);
  float ph = uTime * uFreq - uvp.x * 0.20;
  float p  = pulse(fract(ph)) * uLappetGain(uvp.y);   // baked per-lappet jitter
  float k  = p * uAmp * smoothstep(0.12, 1.0, uvp.x);

  vec3 o;
  o.xz = r.xz * (1.0 - 0.34 * k);                                // radial squeeze
  o.y  = r.y  - 0.62 * k * uR * smoothstep(0.55, 1.0, uvp.x);    // margin curls UNDER
  o.y += 0.11 * k * uR * (1.0 - uvp.x);                          // apex domes up
  o    = twist(o, 0.04 * sin(uTime*0.13 + uvp.x*2.1));           // lazy asymmetry
  return o;
}
```
The `0.62·k·R` margin curl is what closes the subumbrellar cavity — a radius/height lerp alone reads as an inflating balloon, not an animal ejecting water. `js/sim/deform.js` is the JS port of exactly this function, so the vertex shader and the tentacle roots can never disagree about where the margin is.

### 4.3 Propulsion — integrated, never keyframed

```js
const dp     = (p - pPrev) / dt;
const thrust = K1 * Math.max(0, dp)            // power stroke
             + K2 * Math.max(0, -dp) * 0.30;   // passive energy recapture
vel = vel.addScaled(bellAxis, (thrust / mass) * dt);
vel = vel.scale(1 / (1 + DRAG * vel.len() * dt));   // quadratic drag
vel.y -= 0.012 * dt;                                // faintly negatively buoyant
pos = pos.addScaled(vel, dt);
```
Quadratic drag gives the long flattening glide that reads as water; linear drag reads as an elevator. It surges, coasts, sinks a little, surges again. The bell axis is a damped spring toward a slowly wandering target (τ = 4 s), so it banks into turns and tips after a hard pulse. **Floating origin:** the animal stays near `p ≈ 0` and the sea's depth uniform scrolls, so there is no float precision loss and it cannot swim off the world after eight hours.

### 4.4 Secondary motion

**Primary path — verlet, 120 Hz fixed substeps** (2 per 60 fps frame, accumulator clamped to 4):
- Distance constraints, 4 Gauss–Seidel iterations, root pinned to the deformed attachment point.
- **Bend constraints**, rest angle 0, stiffness falling 0.55 (root) → 0.04 (tip). Without bend stiffness a tentacle is wet string; with too much it is wire. This ramp is the tuning knob that matters most.
- Drag against `u(x,t) − v_node`, quadratic, scaled by cross-section.
- Gravity 0.15 m/s² (near-neutrally buoyant).

**The flow field is what makes it look alive:**
```
u(x,t) = 0.6·curlNoise(x·0.35, t·0.07)     // ambient current, 3 octaves
       + jet(x)·max(0, dp/dt)·J             // radial jet from the aperture
       + Σ ringVortex(x, shedRing[i])       // rings shed each contraction
```
Each contraction sheds a vortex ring (position, radius, circulation, 6 s decay; keep the last 4). Tentacles stream backwards during the power stroke, then get *caught and flicked* by the passing ring during the glide. That recoil is the difference between an alive animal and a bundle of noodles.

**Fallback path — retarded time.** Unconditionally stable, stateless, frame-rate independent, evaluable anywhere. Used at tier 4 and under `prefers-reduced-motion`:
```glsl
float tRet = uTime - (-p.y) * 0.55;    // 0.55 s of lag per unit below the bell
float sway = A(s) * sin(6.0*s - tRet*1.7 + phi) * s*s;
```
Cost: it cannot respond to the shed ring. Accepted at those tiers.

### 4.5 Camera — and the anti-flare geometry

- **Sun elevation 72°, near-vertical**, with a 6-minute azimuth drift. **The camera is clamped to never look higher than 25° above horizontal.** The "sun directly behind the animal" alignment is therefore *never reachable* — this is the structural fix for the periodic backlight flare. The rim still lights, because the sun is above and the animal is below it; that is a *stable* top-down condition, not a periodic alignment.
- **Lissajous drift** on periods **59 / 83 / 127 s** — mutually near-irrational, so the path does not repeat within any plausible viewing session. Radius breathes 1.9–3.2 m. (Retuned away from 47 s specifically to remove the sub-minute compositional cadence.)
- **FOV 38°** — a lens, not a game camera.
- **Look-at** is a very loose spring (τ = 5 s) toward a target offset from the animal by a slowly wandering error vector, so the jellyfish drifts around the frame instead of being pinned to the centre. Pinning is the instant tell of a tech demo.
- **Handheld:** 0.25 Hz, 0.0015 rad. Deliberately *not* the 0.9 Hz tremor a losing proposal specified — that frequency band reads as "something is shaking" and is fatiguing over an hour. Plus a 5 s breathing bob of ±1.2 cm and roll within ±0.5°.
- **Bioluminescence:** a 5 %-intensity emissive pulse travels once around the bell margin per swim cycle, offset 0.35 of a cycle from the mechanical pulse. Barely perceptible; entirely responsible for the page being worth watching at 3am.

### 4.6 `prefers-reduced-motion: reduce`

Following Topo's stance — *keep each identity, drop the loop*. Freeze the swim cycle at φ = 0.62 (mid-relaxation, arms streaming — the prettiest pose), switch strands to retarded-time sway at 15 % amplitude, caustics at 15 % speed, snow at 20 %, camera drift stopped. Grain, dither and exposure stay alive, so the image still breathes. **Not** a static frame, which just reads as broken.

---

## 5. The sea — blue by derivation

### 5.1 Extinction

There is not one hard-coded blue in the render path. `SUN_E0` is essentially white and scene-referred; every blue on screen is what survives absorption. Pre-tinting the sun would double-count the extinction and is what makes a scene look *graded* rather than photographed.

| Constant | Value (1/m) | Role |
|---|---|---|
| `SIG_T_W` beam attenuation | `(0.560, 0.230, 0.170)` | transmittance over a path |
| `SIG_S_W` scattering | `(0.045, 0.055, 0.075)` | in-scatter, veil floor |
| `KD` diffuse downwelling | `(0.420, 0.075, 0.032)` | brightness vs. depth |

Two coefficient sets, deliberately: using `Kd` for beam transmittance (as two losing proposals did) under-hazes the far field and makes the sea read as an aquarium tank. Beam attenuation at 20 m leaves red at 1.4×10⁻⁵ and blue at 0.033 — real contrast loss with distance.

Water type is **Jerlov IB→II**, a stated compromise: Type I clarity is inconsistent with visible marine snow, which comes from more productive water. We take moderately turbid-but-still-blue and moderate snow density rather than letting the two art directions contradict each other.

Camera depth **14 m**: downwelling is `(0.0028, 0.351, 0.639)` of surface — red is gone, and the palette follows.

### 5.2 Depth gradient and far field

Analytic, from `inscatter(y)`. Never a painted ramp. Top of frame is brighter and paler; the bottom sinks to indigo. The medium saturates to the far-field value at ~28 m, so there is no visible back wall at any camera angle. Plus the Snell's-window term (§2.3).

### 5.3 Godrays and caustics

One `causticAt()` (§2.1) drives all three: the shafts in open water, the ripple crawling over the bell (amplitude **0.35**, softened `pow(c,2.5)`, depth-mipped), and the snow twinkle. They cannot disagree because they are the same number.

Shafts must be **sparse and soft** — three or four columns, a suggestion of light, not a light show. `hg(·, 0.62)` on the view/sun angle so they bloom toward the sun and fade away from it.

### 5.4 Marine snow — three strata

| Stratum | Range | Count (tier 1) | CoC | Notes |
|---|---|---|---|---|
| Far | 12–25 m | 900 | 0–2 px | heavily fogged; reads as texture on the veil |
| Mid | 4–12 m | 420 | 0–8 px | the parallax reference against the animal |
| Near | 0.4–2.5 m | 60 | 30–88 px | **pre-blurred bokeh sprites**; these sell the shot |

Poisson-clustered, not uniform. Brownian jitter + 0.9 cm/s sink + advection by the same `u(x,t)` the tentacles feel — so a passing vortex ring visibly disturbs the particulate around the animal. Far/mid draw in pass 2, near in pass 6, so the animal is genuinely sandwiched in the particulate rather than pasted over it. One large piece of detritus tumbles through frame roughly every 90 s.

**Far is the only stratum the perf ladder is allowed to cut.** Near is the strongest "this is a camera in water" cue in the frame and is never reduced.

### 5.5 The palette — exact hex

These are **verification anchors, not inputs**. Nothing in the shader contains them. If the render does not land within ΔE ≈ 4 of these after AgX and auto-exposure, the coefficients or the exposure key are wrong.

| Element | Hex | Note |
|---|---|---|
| Page ground / navbar meet | `#050505` | fleet `--bg`, unchanged |
| Deepest corner, vignette floor | `#04070E` | the veil, **never black** |
| Lower water column | `#071426` | |
| Mid column, frame centre | `#0B2338` | |
| Upper column near shafts | `#14385C` | |
| Shaft body | `#2E6B9E` | |
| Shaft core | `#6FA8D8` | |
| Bell apex (thick, τ high) | `#1E4E77` | |
| Bell mid, lit | `#4E8CBB` | |
| Gonad horseshoes | `#8FC0DD` | denser tissue, brighter |
| Bell margin rim (τ-driven) | `#B9D9EE` | *this is not a Fresnel term* |
| Highlight clip ceiling | `#E8F2F8` | near-white, never neon cyan |
| Near-snow bokeh peak | `#7FB2D6` | |
| Tentacle core, backlit | `#A9CFE6` | |

Hue of every anchor lies between 200° and 215°. No green, no cyan-past-200°, no warm anywhere.

---

## 6. Post-processing chain

Order is fixed. Parameters are collected in one block at the top of `post.js` with the tuning rule written beside them: *if you can name the effect while looking at the image, it is too strong.*

**1. Auto-exposure.** 1×1 `R16F` ping-pong EMA (τ = 3 s) sampled from the smallest bloom mip. **No `readPixels` anywhere** — one readback would stall the pipeline and cost more than the whole post chain. Clamped to **±0.25 EV** — tighter than a game's eye adaptation, because a periodic brightness pump in peripheral vision at 3am is the classic ambient killer. Rate-limited to 0.08 EV/s.

**2. Lateral chromatic aberration**, applied as the composite's three-tap read of `FINAL`: `uv' = c + (uv−c)(1 + k·r²)`, `k_R = +0.0011`, `k_B = −0.0009`. Sub-pixel at centre, ~1.6 px in the corners.

**3. Bloom.** 5-level dual-filter Kawase (4 taps down, 8 up) off a bright-pass at ¼ res. Soft knee at **threshold 1.15, knee width 0.6** — set above anything the specular sheen can produce, so bloom serves only the shaft cores and the τ-driven rim. Composite weight **0.055**. Wide and weak, never tight and bright: water in front of a bright bell scatters omnidirectionally.

**4. Veiling glare.** The level-4 bloom mip added flat at **0.035**. This is the missing cue that made the winner read as clean CG — real underwater footage always has it, and its absence is immediately legible.

**5. Sensor noise, injected here — in linear HDR, before the transfer curve.** Underwater photography is high-ISO; what you see is shot + read noise strongest in the shadows, not mid-tone film grain. Post-tonemap grain is uniform and always reads as a Photoshop filter.

```glsl
float n1 = gaussIGN(uv, uFrame);
c += n1 * (sqrt(max(c.g, 0.0)) * 0.010 + 0.0016);
c.rb += gaussIGN(uv * 0.25, uFrame + 7.0) * 0.0030;   // low-freq chroma blotch
```

**6. AgX tonemap.** Chosen over Reinhard-Jodie and ACES: ACES' RRT skews saturated blues toward cyan and clips them neon, which is fatal in a blue-only frame; Reinhard-Jodie preserves hue *including at the highlight*, where an overexposed bell should go pale then near-white.

```glsl
const mat3 AGX_IN = mat3(0.842479,0.0784336,0.0792237,
                         0.0423282,0.878468, 0.0791661,
                         0.0423756,0.0784336,0.879142);
vec3 agx(vec3 c){
  c = AGX_IN * c;
  c = clamp((log2(c + 1e-10) + 12.47393) / 16.5, 0.0, 1.0);
  vec3 x = c, x2 = x*x, x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
}
```

**7. Blue guard rail — a clamp, not a mix.** No grade. The physics already produces blue; the guard exists solely so that no shader bug can ever emit a green jellyfish. It is a no-op on a correct frame.

```glsl
vec3 blueGuard(vec3 c){
  float y   = dot(c, vec3(0.2126,0.7152,0.0722));
  vec3  chr = c - y;
  // Blue-cyan wedge: b must lead g must lead r. Push, do not blend.
  chr.r = min(chr.r, chr.g - 0.004);
  chr.g = min(chr.g, chr.b - 0.002);
  return max(y + chr, vec3(0.0));
}
```
This preserves the hue *drift with distance* (cyan-leaning near field, deeper blue far field) that reads as depth — the thing a 72–82 % grade destroys.

**8. Vignette.** Physically derived `cos⁴` from the actual FOV, plus a 0.30-weight mechanical term. **Falls to the far-field veil colour `#04070E`, not to black.** There is no black underwater.

**9. FXAA** (9-tap) unless MSAA resolved.

**10. Triangular-PDF dither**, ±1 LSB. Non-negotiable — a near-black blue ramp on an 8-bit panel bands catastrophically, and this page is stared at for hours on a dark second monitor.

```glsl
outColor.rgb += (ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + 17.0) - 1.0) / 255.0;
```

---

## 7. Performance ladder

**Target ≤ 8 ms GPU, not 16 ms.** A page left open for fifteen hours must not run the fans. Fan noise is a relaxation constraint.

**Absolute pixel budget, decoupled from display size.** The scene render scale is:

```js
const RS = Math.min(dprCap, Math.sqrt(TIER_BUDGET / (cssW * cssH)));
```

`dprCap` = 2 desktop, **1.5 on iOS** (tile-based deferred GPUs hate large FP16 targets more than they hate fragment work).

| Tier | Budget (px) | Shaft steps | Bloom | Far snow | Bell LOD | THICK | Overscan | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 2.60 M | 16 | 5 | 900 | 160×48 | RS/2 | 8 % | 1080p → RS 1.12 (mild SSAA) |
| 2 | 1.80 M | 12 | 4 | 450 | 160×48 | RS/2 | 8 % | |
| 3 | 1.15 M | 8 | 3 | 200 | 112×36 | RS/3 | off | cookie every other frame |
| 4 | 0.75 M | 8 (inline, no RAYS) | 2 | 0 | 112×36 | analytic | off | retarded-time strands |

**Never touched by the ladder:** tentacle count (40, always), near and mid snow, the pulse, the caustic amplitude, the dither, the vignette. Judge finding: half the tentacles vanishing is not a graceful degrade, it is an *event*.

**Brightness invariance is a hard requirement.** Because the shaft march uses closed-form segment integration, 16 → 8 steps changes sharpness, not brightness. Because the ladder never removes a lighting term, no tier change shifts exposure. The controller is therefore *invisible*, which is the only acceptable behaviour for something you stare at.

**Measurement.** `EXT_disjoint_timer_query_webgl2` for true GPU time on Chrome. Safari and Firefox do not expose it, so there the controller counts dropped frames (`dt > 20 ms`) instead — it reacts correctly but more slowly, and it is tuned accordingly. Rolling **45-frame median** (not mean — one GC spike must not trigger a downgrade).

**Hysteresis, deliberately asymmetric.** Down after 30 consecutive frames > 17.5 ms. Up only after 240 frames < 10.5 ms, one step. renderScale changes **cross-fade over 0.75 s**. After 3 transitions in 5 minutes, latch to the lower tier for the session.

**Below tier 4 we do not keep degrading — we clamp to 30 Hz** (render every other rAF) and hold. A rock-steady 30 fps on an ambient scene is calmer and more convincing than a jittery 44, and the motion is slow enough that 30 Hz is genuinely fine.

**Mobile / low-capability reduces pass count and format, not just resolution:**
- No `EXT_color_buffer_float` → `SEA` and `FINAL` become `RGBA8` with a fixed 1/8 pre-exposure on write, undone on read (dither covers the loss). `THICK` and `ZFRONT` are **not allocated**; the analytic slab path runs instead. `RAYS` is not allocated; shafts are computed inline at 8 steps. Bloom 2 levels. **Four passes total.**
- iOS starts at tier 3 and settles within ~2 s.

**Capability probe at boot:**
1. `webgl2` → else static poster frame (`logo.webp` scaled, `#050505` ground) and one line of text.
2. `EXT_color_buffer_float` → FP16 path. Else `EXT_color_buffer_half_float` → same. Else RGBA8 path above.
3. `getInternalformatParameter(RENDERBUFFER, RGBA16F, SAMPLES)` ≥ 4 → optional MSAA `FINAL`. Else FXAA.
4. `OES_texture_float_linear` gates LINEAR vs. NEAREST + manual 4-tap on `THICK`.
5. `KHR_parallel_shader_compile` where present; programs compile asynchronously behind a 1.2 s fade-up from `#050505` (which reads as descending into water, not as loading). No spinner — a loading indicator would be the loudest thing on the page.

**Lifecycle** (matching fleet patterns exactly):
- `ResizeObserver` on `#sea`, **not** `window.resize`, coalesced through one rAF token, with a zero-size bail (`if (!el.clientWidth || !el.clientHeight) return;`). Targets reallocate only when the rounded pixel size actually changes, with a 250 ms debounce so a window drag does not allocate 60 sets of FP16 targets.
- Backing store is `rect × RS`; CSS size set separately. Never the browser's bilinear upscale.
- `document.hidden` → `cancelAnimationFrame`, full stop, no GPU work. On resume, `dt` clamped to 1/30 s and the verlet accumulator dropped so the sim cannot explode after a nine-hour tab sleep.
- `webglcontextlost` → `preventDefault()`, cancel, mark dead. `webglcontextrestored` → full rebuild from the module-level scene description (all geometry is generated from parameters; nothing to reload). macOS resets the GPU on sleep, and this page will be asleep.
- `destroy()` per `Stocks/js/widgets.js:627` — cancel the pending frame, disconnect the observer, unwire the visibility and context listeners, delete every GL object, `loseContext()`, empty the host.

---

## 8. File layout

Everything below `/Users/eden/Github/Jellyfish/`. **Nothing is vendored** — no `vendor/` directory exists.

| Path | Responsibility |
|---|---|
| `index.html` | The whole shell. §9. |
| `css/jellyfish.css` | Fleet tokens + the flex-column layout contract + the navbar seam strip + reduced-motion note. ~55 lines; there is no UI to style. |
| `js/main.js` | Boot, capability probe, fade-up, fixed-step accumulator + rAF loop, visibility gating, `ResizeObserver`, context loss/restore, `destroy()`. |
| `js/gl.js` | The only file that touches raw WebGL enums. Context creation, extension probe, program compile/link with annotated error dump, VAO/FBO/texture helpers, uniform cache, fullscreen-triangle. |
| `js/math.js` | vec3 / mat4 / quat. No dependency. |
| `js/noise.js` | Value noise, curl noise, IGN, blue-noise tile — JS and GLSL versions defined side by side from one source of truth so the CPU current and the GPU haze agree. |
| `js/render/targets.js` | Allocation of every buffer in §1, format selection from the probe, debounced resize reallocation. |
| `js/render/frame.js` | The eight-pass graph and every blend/depth/cull state transition, in one readable list. The pass table lives here as a comment. |
| `js/render/quality.js` | Tier table, rolling median, timer-query probe with dropped-frame fallback, asymmetric hysteresis, renderScale cross-fade, 30 Hz clamp, transition latch. |
| `js/geometry/profile.js` | The *Aurelia* profile curve and `w(φ)`. Shared by the mesh builder and the sim. |
| `js/geometry/bell.js` | Closed two-shell revolution + rim band + 16 lappets + 8 rhopalia, at two LODs; gonad tubes; manubrium; the baked-imperfection pass. |
| `js/geometry/strands.js` | Oral-arm ribbon and tentacle-strip topology, index buffers, per-frame vertex packer, per-strand depth sort. |
| `js/sim/deform.js` | JS port of `deform()`. One shared definition so the vertex shader and the tentacle roots never disagree about where the margin is. |
| `js/sim/swim.js` | Pulse waveform, period wander, OU jitter, Poisson skip/double, thrust integration, body pose, floating origin. |
| `js/sim/verlet.js` | Chain integrator, distance + bend constraints, root pinning, 120 Hz substeps, retarded-time fallback. |
| `js/sim/flow.js` | Curl-noise current, aperture jet, shed vortex-ring stack. |
| `js/sim/snow.js` | Three strata, Poisson clustering, advection, near/mid/far partition, the pre-generated bokeh disc. |
| `js/camera.js` | Lissajous target, damped springs, loose look-at with wandering error, handheld noise, elevation clamp, view/proj. |
| `js/shaders/common.js` | §2.0 verbatim, concatenated into every program. |
| `js/shaders/cookie.js` | The 256² gobo generator. |
| `js/shaders/shafts.js` | Jittered march + Hillaire integration + history blend. |
| `js/shaders/sea.js` | Water column, Snell's window, bilateral shaft upsample. |
| `js/shaders/thickness.js` | The relative-encoded signed accumulator and `density(φ,θ)`. |
| `js/shaders/bell.js` | `deform()`, analytic normals, Beer–Lambert, two-term SSS, sheen, refraction with dispersion and guard. `#define SUBUMBRELLA` / `#define ANALYTIC_THICKNESS`. |
| `js/shaders/strands.js` | Supergaussian cross-section, min-screen-width trick, shared by arms and tentacles. |
| `js/shaders/snow.js` | Instanced CoC-scaled sprites, caustic twinkle, depth occlusion. |
| `js/shaders/post.js` | Bright-pass, Kawase down/up, and the composite: CA, bloom, veil, noise, AgX, blue guard, vignette, FXAA, dither. |
| `README.md` | Topo's wording verbatim, minus the `vendor/` row, plus "Live at **jellyfish.carino.systems**" and "Static site — just serve the folder. No build step." |
| `logo.svg`, `logo.webp` | A pale blue bell silhouette. The only new binary assets. |
| `manifest.webmanifest` | Stocks' shape: `background_color`/`theme_color` `#050505`, `display: standalone`, `start_url: ./index.html`, `scope: ./`. Deliberately **no service worker**, per fleet policy. |
| `.gitignore` | `.DS_Store` |

**Untouched:** `CNAME` (`jellyfish.carino.systems`, no trailing newline — verified), `LICENSE` (AGPL-3.0, 34523 bytes), `fonts/` including `carino-fonts.css` and `OFL.txt`, `carino-navbar.js`, `carino-clock.js`.

---

## 9. The HTML/CSS shell

The navbar is **not** `position:fixed`. It is injected as the first child of `<body>`, 60 px tall plus a 1 px border, `box-sizing:border-box`, `flex-shrink:0`, in normal flow. So the fleet pattern applies: body is a 100 % flex column and the app fills the remainder. Never `padding-top:60px`, never `top:60px`.

Ship **no** `header.cs-header` — `relocateActions()` then finds nothing to move, and `.social-row:not(:only-child)` correctly omits the divider. That is what "no UI noise" means structurally, not just visually.

`index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<link rel="icon" type="image/svg+xml" href="logo.svg">
<link rel="alternate icon" type="image/webp" href="logo.webp">
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Jellyfish — Carino Systems</title>
<meta name="description" content="A moon jelly, swimming. Ambient WebGL." />
<meta name="theme-color" content="#050505" />
<!-- Manifest only, deliberately no service worker: a hand-maintained precache
     list on a no-build static host strands users on a stale bundle. -->
<link rel="manifest" href="manifest.webmanifest" />
<link rel="stylesheet" href="fonts/carino-fonts.css" />
<link rel="stylesheet" href="css/jellyfish.css" />
</head>
<body>
  <main id="sea"><canvas id="gl"></canvas></main>
  <script type="module" src="js/main.js"></script>
  <script src="carino-navbar.js" data-app="Jellyfish" data-repo="Jellyfish" defer></script>
</body>
</html>
```

`css/jellyfish.css`:

```css
/* jellyfish.css — Carino Jellyfish. Fleet tokens; the canvas is the only content. */
:root{
  --bg:#050505; --bg-elev:#0d0d0d; --bg-card:#0b0b0b;
  --accent:#eab308; --accent-hi:#fbbf24;
  --border:#262626; --text:#fff; --text-sec:#a3a3a3; --text-muted:#666;
  --sans:'IBM Plex Sans',system-ui,sans-serif; --mono:'IBM Plex Mono',ui-monospace,monospace;
  --nav-h:60px;
  --sea-veil:#04070E;          /* the far-field floor. There is no black underwater. */
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{background:var(--bg);color:var(--text);font-family:var(--sans);
     display:flex;flex-direction:column;overflow:hidden;}

/* min-height:0 is mandatory, or the canvas pushes the page. */
#sea{flex:1 1 auto;min-height:0;position:relative;background:var(--bg);}
#sea canvas{position:absolute;inset:0;width:100%;height:100%;display:block;
            opacity:0;transition:opacity 1.2s ease-out;}
#sea canvas.ready{opacity:1;}

/* The navbar seam. The top of the frame is the BRIGHTEST part of the water, so
   crushing the render to #050505 to hide the join would be physically wrong.
   Instead the nav's own ground is carried 28px into the water. */
#sea::before{content:"";position:absolute;left:0;right:0;top:0;height:28px;
             pointer-events:none;z-index:1;
             background:linear-gradient(180deg,#050505 0%,rgba(5,5,5,0) 100%);}

@media (prefers-reduced-motion: reduce){
  #sea canvas{transition:none;opacity:1;}
}
```

**UI: none.** No overlay, no controls, no readout, no FPS counter, no title text, no watermark, no fade-in logo. The navbar is the only chrome and its gold brand stays — "only blue" governs the canvas. A `?dev=1` tuning panel exists for dialling the bell profile against reference footage and is never rendered otherwise.

---

## 10. Definition of done

### Correctness
- [ ] No `vendor/` directory. No `npm`, no bundler, no transpile, no CDN request at runtime. Loading the folder over `file://` produces the identical render (proves no `fetch`ed GLSL).
- [ ] `CNAME`, `LICENSE`, `fonts/`, `carino-navbar.js`, `carino-clock.js` byte-identical to their current state.
- [ ] `README.md` is Topo's wording, `vendor/` row dropped, `fonts/` row kept, live-URL and no-build lines added.
- [ ] `git log` on `main` has commits; remote is `https://github.com/MiguelCarino/Jellyfish.git`; Pages serving `jellyfish.carino.systems`.

### Rendering
- [ ] All eight passes implemented; `blitFramebuffer` appears **only** in the MS→single-sample resolve, and SEA→FINAL is a fullscreen draw.
- [ ] `THICK` uses relative-to-`ZFRONT` encoding. Verified: sweep the camera from 1.9 m to 3.2 m and confirm the rim luminance profile is invariant to camera distance (the absolute-depth bug shows as distance-dependent banding).
- [ ] Bell mesh is watertight. Verified by a debug view of `THICK.g`: no glowing band anywhere on the rim or gonad tubes at any camera angle.
- [ ] The RGBA8 / analytic-thickness path renders a complete, good image — not a degraded one — and has been run on a real device or via a forced-fallback flag.
- [ ] No anisotropic specular anywhere. Zeroing the specular term changes the rim by < 2 %.
- [ ] Zeroing `SIG_A_G`'s red channel visibly reddens the animal (proves the blue is derived, not graded). The blue guard rail is a no-op on the shipped frame.

### Photorealism QA
- [ ] Every anchor in §5.5 within ΔE ≈ 4 on a calibrated sRGB display.
- [ ] Gonad horseshoes and radial canals are visible *through* the bell, and correctly darker where an oral arm folds beneath.
- [ ] The subumbrellar cavity is visibly in the bell's own shadow. Disabling `shadowG` makes an obvious difference.
- [ ] No pixel in the frame is pure black. `min(luminance)` over a 60-frame sample > 0.004.
- [ ] Screenshot at 3840×2160 has no visible banding in the deep gradient with the dither on, and obvious banding with it off.

### Motion / calm
- [ ] **Rate budget:** across any 1 s window, no screen region larger than 5 % of the frame changes mean luminance by more than 12 %, except during the contraction stroke. Verified by scripted frame capture over 5 minutes.
- [ ] **No periodic bright event.** 20 minutes of capture; frame-mean luminance FFT shows no peak above the noise floor at any period between 20 s and 300 s.
- [ ] Auto-exposure never moves more than ±0.25 EV; no visible pump when a shaft crosses the frame.
- [ ] The camera never rises above 25° elevation. Asserted in code, verified over a 10-minute run.
- [ ] Bell margin visibly lags the crown; the contraction reads as a travelling wave, not a uniform squeeze.
- [ ] Skipped and doubled beats occur and are not identifiable as a pattern over 10 minutes.
- [ ] The elastic overshoot is visible: the bell flares past rest before settling.
- [ ] Tentacles visibly recoil when a shed vortex ring passes during the glide.
- [ ] Quality-tier transitions are invisible. Forced tier 1→4→1 while watching produces no brightness step and no popping element.

### Platform
- [ ] Locked 60 fps at 1920×1080 CSS on an M-series Mac in Safari, Chrome and Firefox, at ≤ 8 ms GPU.
- [ ] Iris-class integrated Mac settles at tier 3–4 within 3 s and holds 60, or clamps cleanly to 30.
- [ ] iPhone (iOS 16+, Safari): starts tier 3, holds 30–60, no layout break when the toolbar collapses.
- [ ] Eight-hour soak: no memory growth, no drift of the animal off-frame (floating origin), no exposure creep, no frame-time degradation.
- [ ] Tab hidden for 30 minutes then shown: resumes at the correct pose, no explosion, no teleport.
- [ ] Forced context loss (`WEBGL_lose_context`) and restore: full recovery, no artefacts.
- [ ] Window drag-resize for 10 s allocates targets at most 3 times.
- [ ] `prefers-reduced-motion: reduce`: a still-but-breathing image, not a frozen frame and not a black rectangle.
- [ ] No WebGL2 at all: the poster frame renders, the page does not error.

### The subjective gate
- [ ] Watch it for 20 unbroken minutes on a dark second monitor at low ambient light. Nothing becomes an itch — no crawling edge, no flicker, no shimmer, no static speck, no repeating flare, no fan noise. If any element can be *named* while looking at it, it is too strong and goes back to §6.

---

### Build order — four milestones, each shippable

| M | Contains | Result |
|---|---|---|
| **M1** | `common`, `cookie`, `sea` (no shafts), bell mesh + analytic thickness path, exumbrella only, post with AgX + vignette + dither. **3 passes.** | A blue sea with a translucent pulsing bell in it. Already worth looking at. **This is the fallback ship point if time runs out.** |
| **M2** | `shafts` + history, snow (three strata), strands with verlet, interior pass, camera rig. | The full composition. |
| **M3** | `ZFRONT` + `THICK` relative-encoded pass, self-shadow map, refraction with dispersion and overscan, bloom + veil + grain. | The photoreal render. |
| **M4** | Quality ladder, capability probes, RGBA8 path, lifecycle, reduced motion, README/manifest/logo. | Shippable. |

Tune only at M3 and M4, against reference *Aurelia* footage, with `?dev=1`. The honest risk in this project is aesthetic, not technical: the approach that can be iterated in seconds is the one that actually gets beautiful.