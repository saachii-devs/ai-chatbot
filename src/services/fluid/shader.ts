// GLSL sources for the fluid halo background, as template-literal strings.
// Two rules for the GLSL, both fail silently with a NULL info log: NO BACKTICKS
// (a backtick ends the template literal) and PURE ASCII only (WebGL rejects
// non-ASCII source, so no em dashes or curly quotes even in shader comments).

export const VERTEX_SOURCE = `#version 300 es
// A single triangle covering the clip volume - no vertex buffer, no attributes.
// Cheaper than two: there is no diagonal seam whose pixels get shaded twice.
void main() {
  float x = float((gl_VertexID << 1) & 2);
  float y = float(gl_VertexID & 2);
  gl_Position = vec4(vec2(x, y) * 2.0 - 1.0, 0.0, 1.0);
}
`

export const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uAspect;
uniform float uTime;
uniform float uSettle;     // 0 = new chat (pooled at the input), 1 = ongoing (bottom)
uniform float uSettleVel;  // spring velocity - the fluid's momentum
uniform float uPulse;      // 0..1, rises while a reply streams
uniform vec4  uAnchor;     // composer rect: center.xy, halfSize.xy  (p space, y-up)
uniform float uRadius;     // composer corner radius, in screen-heights
uniform float uReach;      // how far the bloom spills past the composer edge
uniform vec4  uRipples[3]; // center.xy (p space), birthTime, strength

// The halo is ONE colour. Its falloff is carried entirely by alpha, never by
// hue - a glow that shifts through navy, blue and cyan on the way out reads as
// several overlapping lights rather than one.
const vec3 HALO = vec3(0.11, 0.17, 0.58);   // ~#1c2b94, a dim navy, not electric

// Peak opacity of the halo over the near-black page.
const float ALPHA = 0.46;

// The floor glow in the chat view: an enormous circle sitting mostly below the
// viewport, lit along its rim. Because the rim is an arc rather than a straight
// line, the light spreads right across the width and falls away at the corners
// on its own - no separate horizontal mask needed. Centre and radius are in
// screen-heights, in aspect-corrected space, so the arc keeps its curvature on
// any viewport instead of flattening out on wide ones.
const float DOME_R     = 1.35;
const float DOME_Y     = -1.15;  // arc crests at DOME_Y + DOME_R of screen height
const float DOME_UP    = 5.0;    // how far the glow bleeds upward past the rim
const float DOME_IN    = 13.0;   // tight falloff below it, so the floor stays dark
const float DOME_ALPHA = 0.55;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i),                  hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Three octaves is enough: the field is heavily blurred by its own falloff, so
// a fourth would cost fill rate nobody can see.
float fbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p *= 2.02;   // not exactly 2.0 - keeps octaves from lining up on a lattice
    a *= 0.5;
  }
  return s;
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

// Each ripple is a decaying travelling sine, dropped when a message is sent.
// Two decays: exp(-d) in space so it never reaches the far corner, exp(-age)
// in time so the buffer slot can be reused without a visible cut.
float ripples(vec2 P) {
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    float age = uTime - r.z;
    if (age < 0.0 || age > 3.0) continue;
    float d = distance(P, vec2(r.x * uAspect, r.y));
    s += sin(d * 28.0 - age * 6.0) * exp(-d * 3.0) * exp(-age * 1.6) * r.w;
  }
  return s;
}

// The whole fluid, evaluated at one point, returning straight
// (un-premultiplied) colour and coverage.
void fieldAt(vec2 P, vec2 p, out vec3 outCol, out float outA) {
  // Domain warp: sample the noise at a position that is itself displaced by
  // noise. This is what separates "drifting blobs" from something that looks
  // like it has surface tension.
  vec2 q = P + 0.30 * vec2(fbm(P * 3.0 + uTime * 0.05),
                           fbm(P * 3.0 + vec2(5.2, 1.3)));
  float n = fbm(q * 2.0 + uTime * 0.08);
  float nc = n - 0.35; // fbm's rough mean, so this swings either side of zero

  float rp = ripples(P);

  // --- The halo: liquid clinging to the composer, wherever it currently is.
  // It is now the ONLY light source, on both screens, so it no longer fades as
  // the box sinks - it simply travels down with it. (It used to hand off to the
  // strand band at the bottom; restore that fade when the strands come back.)
  vec2 ac = vec2(uAnchor.x * uAspect, uAnchor.y);
  vec2 ab = vec2(uAnchor.z * uAspect, uAnchor.w);
  // The ripple pushes the halo's edge outward, so sending a message still
  // registers even without the strands to carry it.
  float d = sdRoundBox(P - ac, ab, uRadius) + nc * 0.06 - rp * 0.01;
  // Exponential falloff, not smoothstep. smoothstep sits near 1.0 for much of
  // its range, so the halo held full brightness in a collar around the box and
  // then fell off a cliff. exp() starts decaying the instant it leaves the
  // edge, which is what gives a glow its soft, endless tail.
  float halo = exp(-max(d, 0.0) * (2.2 / uReach));
  float haloA = pow(halo, 1.35) * ALPHA;

  // --- The floor glow: only once the composer has begun to sink.
  float gate = smoothstep(0.0, 0.18, uSettle);

  vec2 domeC = vec2(0.5 * uAspect, DOME_Y);
  float domeD = distance(P, domeC) + nc * 0.05 + rp * 0.01;

  // Asymmetric falloff off the rim: light spills a long way upward and dies
  // quickly below, so the floor stays dark and the arc reads as an edge rather
  // than a filled disc. Exactly one of these is non-zero at any pixel, so this
  // is a single exp(-k*|distance to rim|) with a different k on each side.
  // (Do NOT write it as max() of two exp()s: outside the circle the "inside"
  // term collapses to exp(0) = 1 and floods the whole page.)
  float above = max(domeD - DOME_R, 0.0);
  float below = max(DOME_R - domeD, 0.0);
  float dome = exp(-above * DOME_UP - below * DOME_IN);
  float domeA = pow(dome, 1.3) * DOME_ALPHA * gate;

  // One colour, so compositing order only has to get the coverage right.
  outCol = HALO * (1.0 + 0.30 * uPulse);
  outA = domeA + haloA * (1.0 - domeA);
}

void main() {
  vec2 p = gl_FragCoord.xy / uRes;
  vec2 P = vec2(p.x * uAspect, p.y);

  vec3 col;
  float a;
  fieldAt(P, p, col, a);

  // Dither. A wide, dark blue falloff is the worst case for 8-bit output: it
  // quantises into visible contour rings. The fract() keeps the hash's input
  // small - uTime grows without bound, and sin() of a large argument loses the
  // precision the hash relies on.
  float dither = (hash(gl_FragCoord.xy + fract(uTime) * 17.0) - 0.5) * (1.6 / 255.0);
  a += dither;
  col += dither;

  a = clamp(a, 0.0, 1.0);

  // Premultiplied: the canvas blends with ONE, ONE_MINUS_SRC_ALPHA.
  fragColor = vec4(col * a, a);
}
`
