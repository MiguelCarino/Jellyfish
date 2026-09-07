# Jellyfish
One ambient WebGL2 page — a moon jelly, swimming

Part of [Carino Systems](https://carino.systems). Live at **jellyfish.carino.systems**.

A single *Aurelia aurita* at 14 m depth, drifting in open blue water. Nothing else
is on screen: no controls, no readout, no title card, no counter. It is built to
be opened on a second monitor and left there.

## What it is

- **A whole animal, simulated.** The bell is a closed two-shell surface of
  revolution with a scalloped 16-lappet margin. It contracts fast and recoils
  slowly, and the recoil is deliberately under-damped, so the bell flares about
  8 % past rest before it settles. The contraction travels from the crown to the
  margin, arriving a fifth of a cycle later — the margin always lags.
- **It swims because it pushes water.** Thrust is integrated from the contraction
  rate against quadratic drag, never keyframed, so the animal surges, coasts,
  sinks a little and surges again. Each contraction sheds a vortex ring; the
  tentacles get caught and flicked by it during the glide.
- **Forty tentacles and four oral arms**, run as verlet chains against a
  curl-noise current, with distance and bend constraints at 120 Hz.
- **It never repeats.** The beat period wanders on a 96 s carrier with a
  mean-reverting jitter, and a Poisson process skips or doubles the occasional
  stroke, as a real medusa does when correcting course. The camera drifts on a
  Lissajous path of 59 / 83 / 127 s — mutually near-irrational, so the framing
  does not come back around within any plausible sitting.

## How it renders

Eight passes, forward, HDR-linear throughout, at an absolute pixel budget rather
than a fixed resolution.

**The blue is derived, not painted.** There is not one hard-coded blue anywhere
in the render path. The sun is scene-referred and essentially white; every colour
on screen is what survives per-channel absorption through sea water, and the
depth gradient is the in-scatter integral rather than an artist's ramp. Zeroing
the red absorption coefficient visibly reddens the animal, which is the test.

**The jelly is lit by its own thickness.** A signed additive buffer accumulates
optical depth along the view ray through every layer of tissue at once — both
walls of the bell, an arm folded underneath, a tentacle behind — encoded relative
to the bell's front depth so that a centimetre of wall is hundreds of ulps of
fp16 instead of three. Tissue density is a pattern, not a constant: the coronal muscle ring,
sixteen radial canals and four gonad horseshoes all sum into it, so they show
*through* the bell exactly as they do in a photograph. The luminous rim is that
integral at grazing incidence, not a Fresnel term; a real jellyfish has almost no
Fresnel reflection, which is precisely why it is nearly invisible in water.

**The near shell composites the scene through itself.** Whichever half of the
bell is facing the camera — the exumbrella from above, the subumbrella when the
orbit swings underneath — is drawn last and refracts the water column behind it
with a real march distance and a touch of Cauchy dispersion, so the far shell,
the gonads and the far tentacles are not merely occluded by the bell: they are
tinted, dimmed and bent by it.

**One caustic texture lights everything.** The godray march, the ripple crawling
over the bell and the twinkle on a passing snow mote are the same fetch, so they
cannot disagree. Marine snow runs in three strata with real circle-of-confusion
arithmetic; the near stratum's sprite *is* the bokeh, which is why there is no
depth-of-field pass anywhere in the renderer.

**The post chain is photographic.** Sensor shot and read noise are injected in
linear HDR before the transfer curve, then AgX, which desaturates toward white on
rolloff instead of clipping to neon cyan. Auto-exposure is clamped to ±0.25 EV,
tighter than a game's, because a brightness pump in peripheral vision at 3 am is
the thing that makes an ambient page unwatchable. Triangular-PDF dither is
non-negotiable: a near-black blue ramp on an 8-bit panel bands catastrophically.

**Calm is a shipping requirement.** The quality ladder is invisible by
construction — the shaft march uses closed-form segment integration, so halving
the step count changes sharpness and never brightness, and the tentacle count is
fixed at forty in every tier, forever. Nothing in the frame should be nameable
while you are looking at it.

`prefers-reduced-motion: reduce` freezes the swim cycle mid-relaxation with the
arms streaming, drops the strands to a stateless retarded-time sway and stops the
camera, but leaves the grain, dither and exposure alive. A still image, not a
dead one.

## Where this departs from SPEC.md

`SPEC.md` is the build spec, and it is authoritative about intent. These are the
places the shipped renderer disagrees with its numbers, every one of them
because the frame measured wrong against the spec's own acceptance checks.

| Subject | Spec | Ships | Why |
| --- | --- | --- | --- |
| Ambient in-scatter | a flat `0.75` in place of a phase function | `hg(0, 0.62) = 0.030` | The veil is a radiance, and the shafts, the snow and the animal are all lit from `downwelling()` directly. At 0.75 the water was twenty five times too bright and everything in the frame sat a few per cent above it. |
| Post chain | no scene-referred exposure | `SCENE_EXPOSURE`, on `hdrDecode` | `SUN_E0` is scene-referred and AgX puts middle grey at 0.18, so the column arrived several stops into the shoulder and landed near white. |
| Mesoglea | `WALL_A` 0.058 R, `SIG_S_G` (14, 16.5, 19) | 0.120 R, (22, 26, 30) | 7.5 mm over the apex of a 26 cm animal scattered under nine per cent of the light reaching it. §5.5's anchors put the lit bell three to four times above the column; this is what gets it there. |
| Passes 5 and 6 | subumbrella, then exumbrella | far shell, then near shell | The orbit spends long stretches below the animal, and the pinned version culled every visible triangle of the shell facing the eye. |
| Oral arms | 0.9 R wide, one strand shader | 0.42 R, plus a coverage term and their own ribbon plane | The shader read a ribbon's width as its depth, so the arms rasterised as opaque camera-facing sails in front of the bell. |
| Camera | 1.9–3.2 m orbit | 1.3–2.2 m, and each spring leads by its own tau | A 26 cm animal at 2.55 m is 15 % of the frame height, and a spring following a swimmer trails it by `v*tau` — half a metre, measured, which walked the animal to the frame edge. |
| Marine snow | §5.4's counts, focus at 6 m | mid and near counts divided by the frustum's solid-angle fraction, focus on the animal | The counts are seeded over a full sphere, of which a 38° lens sees 5.7 %: three near motes reached the screen, thirty pixels out of focus. |

Everything else is the spec as written, including the parts that are easy to
mistake for bugs: the ±0.25 EV exposure clamp, the fixed forty tentacles, the
2.5 caustic softening exponent, and the fact that nothing in the render path
contains a blue constant.

## Setup

Static site — just serve the folder. No build step.

No npm, no bundler, no transpile, no CDN and no network at runtime. Plain ES
modules; the GLSL ships as exported template strings rather than fetched files,
so opening `index.html` over `file://` renders exactly what GitHub Pages does.
There is no service worker, deliberately: a hand-maintained precache list on a
no-build static host strands people on a stale bundle.

```
index.html · css/jellyfish.css
js/main.js           boot, capability probe, rAF loop, lifecycle
js/gl.js             the only file that names a WebGL enum
js/math.js           vec3 / mat4 / quat, seeded PRNG
js/noise.js          value, curl, IGN and blue noise — JS and GLSL from one source
js/render/           target allocation, the eight-pass graph, the quality ladder
js/geometry/         bell profile, two-shell mesh, strand topology
js/sim/              pulse, propulsion, verlet chains, flow field, marine snow
js/camera.js         Lissajous drift, damped look-at, handheld
js/shaders/          one module per program; template strings, never fetched
tests/check.mjs      the static check: node tests/check.mjs
```

`node tests/check.mjs` needs nothing installed. It parses and loads every
module, resolves every import, assembles every shader program exactly as the
renderer does and checks the GLSL statically, compares the uniform names each
pass sets against the ones its program declares, and then boots the real
`js/main.js` against a mock WebGL2 context and runs a minute of simulated time
through the whole eight-pass graph — including the RGBA8 fallback, the tier-4
path, a context loss and restore, a ten-second drag-resize and a hidden tab. It
cannot prove the page is beautiful. It does prove the wiring.

## Licensing

**Mine — GNU Affero General Public License v3.0 or later.** Everything in this
repository *except* the paths listed below. Copyright © 2026 Miguel Carino.
Full terms in [LICENSE](LICENSE).

**Not mine.** The files below are third-party works redistributed here. This
project's licence does not cover them and could not: they are not mine to
relicense. Each keeps its own terms, and each carries its own notice.

| Path | What it is | Licence | Notice |
| --- | --- | --- | --- |
| [`fonts/`](fonts/) | IBM Plex Mono, IBM Plex Sans, Red Hat Display | SIL OFL 1.1 | [`fonts/OFL.txt`](fonts/OFL.txt) |

Those files travel with any fork, mirror or repackaging of this repository, and
their notices must travel with them.
