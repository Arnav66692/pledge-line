'use strict';

// The room behind the page, in raw WebGL2. It is Arnav's Blender room from his portfolio build (web/room/README.md):
// plaster walls with their sunlight and shadows baked into a light map, an arcade of three arches in the left wall open
// onto a dusk world, a high window and a ledge, standing in still water. The donor page uses the light palette: white
// plaster, a blue dusk and blue water, with a gold sun in the arcade. The staff view keeps its own dark palette. The
// water is a real planar mirror: the room is drawn upside down into a texture each frame, then the water samples it
// through slow ripples. A pearl floats past the end of the headline's first line, specks drift in the air, and the
// camera wanders like a hand-held shot and turns a few degrees toward the pointer. The pointer also stirs a flow field
// that smears the picture and settles in about 1.5 s, and a last pass adds grain and a soft vignette.
// The page works the same without it: html keeps no "has-gl" class and the CSS paints a still of the room.
(() => {
  const noop = () => {};
  const api = { ready: false, setMode: noop, setPearl: noop, probe: () => null };
  window.PledgeScene = api;

  const canvas = document.getElementById('scene');
  if (!canvas) return;
  const root = document.documentElement;
  const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isCase = root.dataset.page === 'staff';

  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  } catch {
    gl = null;
  }
  if (!gl) return;

  // ---- Small column-major 4x4 matrix helpers ----
  const M = {
    perspective(fovy, aspect, near, far) {
      const t = 1 / Math.tan(fovy / 2);
      return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    },
    lookAt(eye, target, up) {
      const z = norm(sub(eye, target));
      const x = norm(cross(up, z));
      const y = cross(z, x);
      return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
    },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c += 1) {
        for (let r = 0; r < 4; r += 1) {
          o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
      }
      return o;
    },
    invert(m) {
      const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      const d = det ? 1 / det : 0;
      return new Float32Array([
        (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
        (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
        (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
        (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
        (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
        (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
        (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
        (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
      ]);
    },
    // translation, rotation quaternion and scale from a glTF node
    trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
      const [x, y, z, w] = q;
      return new Float32Array([
        (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
        2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
        2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
        t[0], t[1], t[2], 1,
      ]);
    },
  };
  // The water is the plane y = 0. Drawing through this flip shows the room as the water mirrors it.
  const MIRROR = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b, k = 1) { return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const DEG = Math.PI / 180;

  // ---- Shaders. smoothstep edges always run low to high and pow bases stay at or above 0: both are undefined
  // otherwise, and Metal turns them into NaN pixels. ----
  const FULL_VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const COMMON = `#version 300 es
precision highp float;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; } return v; }
`;

  // The dusk outside: a peach horizon under a lilac sky, a glow past the arcade, long thin clouds, and three ranges of
  // hills that darken as they come closer. Hills follow the direction, not the azimuth angle, so there is no seam.
  const SKY_FN = `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGlowCol;
uniform vec3 uGlowDir;
uniform float uGlow;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
uniform float uClouds;
uniform vec3 uRidgeFar;
uniform vec3 uRidgeMid;
uniform vec3 uRidgeNear;
uniform float uTime;
float ridgeH(vec2 dir, float k, float seed) { return fbm(dir * k + seed); }
vec3 sky(vec3 d) {
  float up = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.5, up));
  float s = max(dot(d, uGlowDir), 0.0);
  float breath = 0.88 + 0.12 * sin(uTime * 0.31);
  col += uGlowCol * (pow(s, 3.0) * 0.45 + pow(s, 24.0) * 0.4) * uGlow * breath;
  vec2 q = d.xz / max(up + 0.12, 0.05) * 2.2 + vec2(uTime * 0.004, 0.0);
  q = vec2(q.x * 0.3, q.y * 1.7);
  float c = fbm(q * 0.8);
  float cover = smoothstep(0.42, 0.6, c) * smoothstep(0.03, 0.14, up) * (1.0 - smoothstep(0.45, 0.9, up));
  float lit = (1.0 - smoothstep(0.0, 0.5, up)) * (0.55 + 0.45 * s);
  col = mix(col, mix(uCloudDark, uCloudLit, lit), cover * uClouds);
  col += uGlowCol * exp(-up * 34.0) * 0.22 * (0.5 + 0.5 * s);
  vec2 dir = normalize(d.xz + vec2(1e-5));
  float aa = 0.0022;
  float hf = 0.035 + ridgeH(dir, 3.1, 1.7) * 0.08;
  float hm = 0.02 + ridgeH(dir, 2.2, 9.2) * 0.07;
  float hn = 0.004 + ridgeH(dir, 1.6, 4.4) * 0.055;
  float tex = fbm(vec2(dir.x * 90.0 + dir.y * 40.0, d.y * 260.0));
  vec3 far = mix(uRidgeFar, uHorizon, 0.25) + uGlowCol * pow(s, 3.0) * 0.12 * uGlow;
  vec3 mid = uRidgeMid * (0.93 + 0.12 * tex) + uGlowCol * pow(s, 3.0) * 0.06 * uGlow;
  vec3 near = uRidgeNear * (0.88 + 0.22 * tex);
  near += uGlowCol * 0.12 * (1.0 - smoothstep(0.0, 0.012, hn - d.y)) * (0.4 + 0.6 * s);
  col = mix(col, far, 1.0 - smoothstep(hf - aa, hf + aa, d.y));
  col = mix(col, mid, 1.0 - smoothstep(hm - aa, hm + aa, d.y));
  col = mix(col, near, 1.0 - smoothstep(hn - aa, hn + aa, d.y));
  return col;
}`;

  const SKY = `${COMMON}
in vec2 vUv;
uniform mat4 uInvVP;
${SKY_FN}
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 d = normalize(b.xyz / b.w - a.xyz / a.w);
  o = vec4(sky(d), 1.0);
}`;

  const MESH_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uVP;
uniform mat4 uModel;
out vec2 vUv;
out vec3 vWorld;
out vec3 vN;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  vN = mat3(uModel) * aNormal;
  vUv = aUv;
  gl_Position = uVP * wp;
}`;

  // The bake's light, re-coloured: its brightness picks a colour from lilac shade through pink plaster to a peach sun
  // patch, and a little of its own warm bounce is kept so corners still glow.
  const ROOM = `${COMMON}
in vec2 vUv;
in vec3 vWorld;
in vec3 vN;
uniform sampler2D uBake;
uniform vec3 uLit;
uniform vec3 uMid;
uniform vec3 uShade;
uniform vec3 uDeep;
uniform float uKeep;
uniform float uExposure;
uniform vec3 uCam;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform vec3 uGlowCol;
uniform float uSheen;
uniform float uClip;
void main() {
  if (uClip > 0.5 && vWorld.y < 0.0) discard;
  // The portfolio's column stands where the pearl used to rest. Here the pearl floats by the headline instead.
  if (vWorld.y > 2.18 && length(vWorld.xz - vec2(6.6, -7.2)) < 0.64) discard;
  vec3 b = texture(uBake, vUv).rgb;
  float l = dot(b, vec3(0.2126, 0.7152, 0.0722));
  vec3 c = mix(uDeep, uShade, smoothstep(0.3, 0.6, l));
  c = mix(c, uMid, smoothstep(0.6, 0.76, l));
  c = mix(c, uLit, smoothstep(0.76, 0.9, l));
  c += (b - vec3(l)) * uKeep;
  // Hand-floated plaster: a soft mottle and a fine tooth laid along each wall, so lit faces read as a surface.
  vec3 an = abs(normalize(vN));
  vec2 wp = an.x > 0.5 ? vWorld.zy : an.y > 0.5 ? vWorld.xz : vWorld.xy;
  float mottle = fbm(wp * 0.55) - 0.5;
  float tooth = noise(wp * 9.0) - 0.5;
  c *= 1.0 + mottle * 0.07 + tooth * 0.035;
  c *= uExposure;
  vec3 v = normalize(uCam - vWorld);
  float fres = pow(clamp(1.0 - abs(dot(normalize(vN), v)), 0.0, 1.0), 5.0);
  c += uGlowCol * fres * 0.06 * uSheen;
  float d = length(uCam - vWorld);
  c = mix(c, uFogCol, 1.0 - exp(-pow(d * uFogDensity, 2.0)));
  o = vec4(c, 1.0);
}`;

  const WATER_VERT = `#version 300 es
layout(location = 0) in vec2 aXZ;
uniform mat4 uVP;
out vec3 vWorld;
void main() {
  vWorld = vec3(aXZ.x, 0.0, aXZ.y);
  gl_Position = uVP * vec4(vWorld, 1.0);
}`;

  // The mirror water: the flipped room from the reflection pass, bent by slow ripples that stretch into long vertical
  // streaks toward the camera, and by the pointer's trail. Close water reflects less and shows its own lilac.
  const WATER = `${COMMON}
in vec3 vWorld;
uniform sampler2D uRefl;
uniform sampler2D uFlow;
uniform float uFlowOn;
uniform vec2 uRes;
uniform float uTime;
uniform float uCalm;
uniform vec3 uCam;
uniform vec3 uWaterCol;
uniform float uReflect;
uniform float uBlur;
uniform float uWave;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uFogCol;
uniform float uFogDensity;
void main() {
  float t = uTime;
  vec2 p = vWorld.xz * vec2(1.6, 4.5);
  vec2 n = vec2(
    sin(p.x * 0.31 + t * 0.55) + 0.6 * sin(p.y * 0.17 - t * 0.42) + 0.35 * sin((p.x + p.y) * 0.29 + t * 0.9),
    cos(p.y * 0.13 + t * 0.47) + 0.5 * cos(p.x * 0.39 + t * 0.63) + 0.35 * sin((p.x - p.y) * 0.23 - t * 0.81)
  );
  float dist = length(uCam - vWorld);
  float near = 1.0 - smoothstep(6.0, 34.0, dist);
  vec2 suv = gl_FragCoord.xy / uRes;
  vec4 f = texture(uFlow, suv) * uFlowOn;
  vec2 bend = vec2(n.x * 1.2, n.y * 0.55) * uWave * (0.35 + 1.4 * near) * (1.0 - uCalm * 0.7);
  vec2 ruv = suv + bend + f.xy * f.z * 0.2;
  vec3 r = textureLod(uRefl, ruv, uBlur + near * 0.8).rgb;
  vec3 v = normalize(uCam - vWorld);
  float fres = pow(clamp(1.0 - v.y, 0.0, 1.0), 3.0);
  vec3 col = mix(uWaterCol, r, uReflect * (0.5 + 0.5 * fres));
  vec3 nn = normalize(vec3(n.x * 0.06, 1.0, n.y * 0.06));
  col += uSunCol * pow(max(dot(nn, normalize(uSunDir + v)), 0.0), 180.0) * 0.3 * (1.0 - uCalm);
  col = mix(col, uFogCol, 1.0 - exp(-pow(dist * uFogDensity * 0.85, 2.0)));
  o = vec4(col, 1.0);
}`;

  // The pearl: a satin body with a thin-film shimmer that slides round its rim, under a gloss that reflects a stand-in
  // for the room around it (plaster at eye level, water below, sky above, the window's sun).
  const PEARL_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uVP;
uniform vec4 uPearl;
uniform float uClip;
out vec3 vWorld;
out vec3 vN;
void main() {
  vN = aPos;
  vWorld = uPearl.xyz + aPos * uPearl.w;
  gl_Position = uVP * vec4(vWorld, 1.0);
}`;
  const PEARL = `${COMMON}
in vec3 vWorld;
in vec3 vN;
uniform vec3 uCam;
uniform vec3 uKey;
uniform float uTime;
uniform vec3 uMid;
uniform vec3 uShade;
uniform vec3 uWaterCol;
uniform vec3 uZenith;
uniform vec3 uGlowCol;
uniform vec3 uGlowDir;
uniform vec3 uBody;
uniform float uSpec;
uniform float uFilm;
uniform float uClip;
vec3 film(float x) { return 0.5 + 0.5 * cos(6.28318 * (x + vec3(0.0, 0.33, 0.67))); }
vec3 env(vec3 r) {
  vec3 c = mix(uWaterCol, mix(uShade, uMid, 0.6), smoothstep(-0.06, 0.04, r.y));
  c = mix(c, uZenith, smoothstep(0.35, 0.95, r.y));
  c += uGlowCol * pow(max(dot(r, uGlowDir), 0.0), 6.0) * 0.5;
  c += vec3(1.0, 0.97, 0.94) * pow(max(dot(r, uKey), 0.0), 48.0) * 0.9 * uSpec;
  return c;
}
void main() {
  if (uClip > 0.5 && vWorld.y < 0.0) discard;
  vec3 n = normalize(vN);
  vec3 v = normalize(uCam - vWorld);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  vec3 r = reflect(-v, n);
  float wrap = clamp(dot(n, uKey) * 0.5 + 0.5, 0.0, 1.0);
  vec3 body = uBody * (0.78 + 0.3 * wrap);
  vec3 orient = mix(vec3(1.0), film(ndv * 1.15 + n.y * 0.18 + uTime * 0.02) * 1.25, 0.65);
  body = mix(body, body * orient, (0.12 + 0.3 * (1.0 - ndv)) * uFilm);
  vec3 e = env(r);
  float fres = 0.05 + 0.95 * pow(clamp(1.0 - ndv, 0.0, 1.0), 4.0);
  vec3 col = mix(body, e, fres * 0.75) + e * 0.08;
  float nh = max(dot(n, normalize(uKey + v)), 0.0);
  col += (pow(nh, 200.0) * 0.8 + pow(nh, 16.0) * 0.06) * uSpec;
  o = vec4(col, 1.0);
}`;

  // Specks of light drifting in the air of the room, twinkling on and off.
  const MOTE_VERT = `#version 300 es
layout(location = 0) in vec4 aSeed;
uniform mat4 uVP;
uniform mat4 uView;
uniform float uTime;
uniform float uPx;
out float vA;
void main() {
  vec3 p = aSeed.xyz;
  float s = aSeed.w * 6.2831;
  p.x += sin(uTime * (0.08 + aSeed.w * 0.07) + s) * 0.9;
  p.y += sin(uTime * (0.11 + aSeed.w * 0.05) + s * 2.0) * 0.6;
  p.z += cos(uTime * (0.09 + aSeed.w * 0.06) + s * 3.0) * 0.9;
  float depth = -(uView * vec4(p, 1.0)).z;
  float tw = 0.5 + 0.5 * sin(uTime * (0.5 + aSeed.w * 1.3) + aSeed.w * 40.0);
  vA = tw * tw * smoothstep(2.0, 6.0, depth);
  gl_PointSize = clamp(0.16 * (0.35 + tw) * uPx / max(depth, 0.5), 1.0, 7.0);
  gl_Position = uVP * vec4(p, 1.0);
}`;
  const MOTE = `${COMMON}
in float vA;
uniform vec3 uCol;
uniform float uAmt;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = 1.0 - smoothstep(0.0, 0.5, d);
  o = vec4(uCol * a * a * vA * uAmt, 1.0);
}`;

  // The staff view's dark case page: near black with one slow pool of light and sparse specks.
  const CASE = `${COMMON}
in vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
void main() {
  vec2 p = (vUv * uRes - 0.5 * uRes) / uRes.y;
  vec3 col = vec3(0.052, 0.058, 0.057);
  vec2 lp = vec2(0.35 + 0.1 * sin(uTime * 0.05), 0.25 + 0.06 * cos(uTime * 0.04));
  col += vec3(0.035, 0.045, 0.045) * exp(-dot(p - lp, p - lp) * 4.0);
  col += vec3(0.02, 0.02, 0.025) * exp(-dot(p + vec2(0.6, 0.3), p + vec2(0.6, 0.3)) * 3.0);
  vec2 g = p * 11.0;
  vec2 cell = floor(g);
  float r = hash(cell);
  if (r > 0.9) {
    vec2 c = cell + 0.5 + 0.3 * vec2(sin(uTime * 0.11 + r * 40.0), cos(uTime * 0.09 + r * 23.0));
    float d = length(g - c);
    float tw = 0.5 + 0.5 * sin(uTime * (0.6 + r) + r * 60.0);
    col += vec3(0.7, 0.8, 0.85) * exp(-d * d * 260.0) * tw * tw * 0.2;
  }
  o = vec4(col, 1.0);
}`;

  const FLOW = `${COMMON}
in vec2 vUv;
uniform sampler2D uPrev;
uniform vec2 uMouse;
uniform vec2 uVel;
uniform float uAspect;
uniform float uRadius;
uniform float uDecay;
void main() {
  vec4 c = texture(uPrev, vUv) * uDecay;
  vec2 d = (vUv - uMouse) * vec2(uAspect, 1.0);
  float fall = 1.0 - smoothstep(0.0, uRadius, length(d));
  float speed = length(uVel);
  vec4 stamp = vec4(uVel, min(1.0, speed * 40.0), 1.0);
  o = mix(c, stamp, fall * step(0.00001, speed));
}`;

  const POST = `${COMMON}
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uFlow;
uniform float uTime;
uniform float uFlowAmt;
uniform float uGrain;
uniform float uCA;
uniform float uVig;
uniform float uCalm;
uniform float uIntro;
uniform vec3 uMist;
uniform vec3 uFloor;
uniform float uFloorAmt;
void main() {
  vec4 f = texture(uFlow, vUv);
  vec2 uv = vUv - f.xy * f.z * uFlowAmt;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 off = c * r2 * uCA;
  vec3 col = vec3(texture(uScene, uv + off).r, texture(uScene, uv).g, texture(uScene, uv - off).b);
  col = mix(col, uMist, uCalm);
  col *= 1.0 - uVig * smoothstep(0.12, 0.6, r2);
  // The bottom edge settles toward a plain tone, so the small corner labels and the note never sit on mid tones.
  col = mix(col, uFloor, uFloorAmt * (1.0 - smoothstep(0.0, 0.24, vUv.y)));
  col += (hash(gl_FragCoord.xy + fract(uTime * 7.31) * 91.7) - 0.5) * uGrain;
  col = mix(uMist, col, uIntro);
  o = vec4(col, 1.0);
}`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }
  function program(vert, frag) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i += 1) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  let progs;
  try {
    progs = isCase
      ? { scene: program(FULL_VERT, CASE), flow: program(FULL_VERT, FLOW), post: program(FULL_VERT, POST) }
      : {
        sky: program(FULL_VERT, SKY), room: program(MESH_VERT, ROOM), water: program(WATER_VERT, WATER),
        pearl: program(PEARL_VERT, PEARL), mote: program(MOTE_VERT, MOTE), flow: program(FULL_VERT, FLOW), post: program(FULL_VERT, POST),
      };
  } catch {
    // A driver that can't build the shaders gets the painted still, like a browser with no WebGL.
    return;
  }

  // ---- The room's files: a glTF binary (a JSON chunk and a binary chunk) and the WebP light maps ----
  const TYPES = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
  const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  function parseGlb(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 28 || dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) throw new Error('not a glb');
    const jsonLen = dv.getUint32(12, true);
    if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('glb json chunk');
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
    const binAt = 20 + jsonLen;
    if (dv.getUint32(binAt + 4, true) !== 0x004e4942) throw new Error('glb bin chunk');
    const bin = binAt + 8;
    const accessor = (i) => {
      const a = json.accessors[i];
      const view = json.bufferViews[a.bufferView];
      const Ctor = TYPES[a.componentType];
      const comps = SIZES[a.type];
      if (!Ctor || !comps) throw new Error('glb accessor type');
      if (view.byteStride && view.byteStride !== comps * Ctor.BYTES_PER_ELEMENT) throw new Error('glb interleaved');
      const start = bin + (view.byteOffset || 0) + (a.byteOffset || 0);
      // A copy, so the typed array always starts on its own alignment.
      return new Ctor(buf.slice(start, start + a.count * comps * Ctor.BYTES_PER_ELEMENT));
    };
    const parts = [];
    for (const node of json.nodes || []) {
      if (node.mesh === undefined) continue;
      const model = node.matrix ? new Float32Array(node.matrix) : M.trs(node.translation, node.rotation, node.scale);
      for (const prim of json.meshes[node.mesh].primitives) {
        const at = prim.attributes;
        if (at.POSITION === undefined || at.NORMAL === undefined || prim.indices === undefined) continue;
        // The light map lives on the second uv set when there is one, otherwise on the first.
        const uvSet = at.TEXCOORD_1 ?? at.TEXCOORD_0;
        if (uvSet === undefined) continue;
        parts.push({ name: node.name || '', model, pos: accessor(at.POSITION), normal: accessor(at.NORMAL), uv: accessor(uvSet), index: accessor(prim.indices) });
      }
    }
    return parts;
  }
  function upload(part) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    [[part.pos, 3], [part.normal, 3], [part.uv, 2]].forEach(([data, size], loc) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    });
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, part.index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const type = part.index instanceof Uint32Array ? gl.UNSIGNED_INT : part.index instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT;
    return { vao, count: part.index.length, type, model: part.model, name: part.name };
  }
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  function imageTexture(img) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return tex;
  }
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`image ${url}`));
      img.src = url;
    });
  }
  async function loadRoom() {
    const [buf, roomImg, rockImg] = await Promise.all([
      fetch('/room/room.glb').then((r) => { if (!r.ok) throw new Error('room.glb'); return r.arrayBuffer(); }),
      loadImage('/room/room-light.webp'),
      loadImage('/room/rocks-light.webp'),
    ]);
    const roomTex = imageTexture(roomImg);
    const rockTex = imageTexture(rockImg);
    return parseGlb(buf).map((part) => ({ ...upload(part), tex: part.name.startsWith('rocks') ? rockTex : roomTex }));
  }

  // ---- Generated geometry: the water plane, the pearl's sphere, the specks ----
  function waterMesh() {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    const s = 600;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-s, -s, s, -s, s, s, -s, -s, s, s, -s, s]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, count: 6 };
  }
  function sphereMesh(seg = 64, rings = 32) {
    const pos = [];
    const idx = [];
    for (let j = 0; j <= rings; j += 1) {
      const v = (j / rings) * Math.PI;
      for (let i = 0; i <= seg; i += 1) {
        const u = (i / seg) * Math.PI * 2;
        pos.push(Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u));
      }
    }
    for (let j = 0; j < rings; j += 1) {
      for (let i = 0; i < seg; i += 1) {
        const a = j * (seg + 1) + i;
        const b = a + seg + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: idx.length };
  }
  function moteMesh(n) {
    // A fixed pattern, so every visit sees the same specks.
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i += 1) {
      data.set([(rnd() - 0.5) * 18, 0.5 + rnd() * 11, -11 + rnd() * 21, rnd()], i * 4);
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, count: n };
  }

  // ---- Render targets ----
  const floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const fsVao = gl.createVertexArray();
  const maxSamples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);

  function texTarget(w, h, { half = false, depth = false, mips = false } = {}) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (mips) {
      const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
    } else if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (depth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, rbs: rb ? [rb] : [], w, h, ok };
  }
  // The room's edges are drawn with 4x multisampling where the GPU offers it, then resolved into a texture for the
  // last pass, so arches and window jambs stay clean even below full resolution.
  function msaaTarget(w, h) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const color = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, maxSamples, gl.RGBA8, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, maxSamples, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, rbs: [color, depth], w, h, ok };
  }
  function drop(t) {
    if (!t) return;
    if (t.tex) gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
    (t.rbs || []).forEach((rb) => gl.deleteRenderbuffer(rb));
  }

  // The scene draws at a fraction of the screen and the last pass scales it up. Grain hides the difference, and a slow
  // second drops the fraction once, so a laptop holds 60 fps.
  const quality = { dpr: Math.min(window.devicePixelRatio || 1, 1.5), scale: isCase ? 0.62 : 0.8 };
  const rt = { scene: null, msaa: null, refl: null, flowA: null, flowB: null };
  let size = { w: 1, h: 1, cssW: 1, cssH: 1 };
  let flowOk = false;

  function resize() {
    const cssW = Math.max(1, canvas.clientWidth || window.innerWidth);
    const cssH = Math.max(1, canvas.clientHeight || window.innerHeight);
    const w = Math.round(cssW * quality.dpr);
    const h = Math.round(cssH * quality.dpr);
    if (w === size.w && h === size.h && rt.scene) return;
    size = { w, h, cssW, cssH };
    canvas.width = w;
    canvas.height = h;
    Object.values(rt).forEach(drop);
    const sw = Math.max(2, Math.round(w * quality.scale));
    const sh = Math.max(2, Math.round(h * quality.scale));
    rt.scene = texTarget(sw, sh, { depth: !isCase });
    rt.msaa = null;
    if (!isCase && maxSamples > 1) {
      const m = msaaTarget(sw, sh);
      if (m.ok) rt.msaa = m;
      else drop(m);
    }
    rt.refl = isCase ? null : texTarget(Math.max(2, Math.round(sw * 0.5)), Math.max(2, Math.round(sh * 0.5)), { depth: true, mips: true });
    const fw = Math.max(2, Math.round(cssW / 6));
    const fh = Math.max(2, Math.round(cssH / 6));
    rt.flowA = texTarget(fw, fh, { half: floatTargets });
    rt.flowB = texTarget(fw, fh, { half: floatTargets });
    flowOk = floatTargets && rt.flowA.ok && rt.flowB.ok;
    for (const t of [rt.flowA, rt.flowB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---- The camera, the palettes and the light ----
  // Room metres, y up. The camera stands back in the water looking a little right, so the arcade shows on the left,
  // the high window and the ledge on the right, and plain lit plaster behind the headline. A portrait screen keeps a
  // wider, lower view, the way unseen's phone layout does, and between the two the framing blends by aspect.
  const VIEW = { pos: [-3.5, 1.3, 19], target: [2.0, 4.6, -8], fov: 30, portrait: { pos: [-3.5, 1.5, 19], target: [1.8, 3.6, -8], fov: 52 } };
  const SUN = norm([0.78, -0.56, -0.28]); // the way the light travels through the left window
  const KEY = SUN.map((v) => -v);
  const DUSK = norm([-0.75, 0.06, -0.66]); // the glow sits past the arcade, out of sight of the headline
  // The donor palette: white plaster in pale blue shade, a blue dusk and blue water, and a gold sun in the arcade.
  // keep is 0 so the bake's crimson bounce does not tint the walls, and film is 0 so the pearl shows no rainbow.
  const LIGHT = {
    lit: '#fff1c4', mid: '#f1f7fc', shade: '#cfe1f0', deep: '#8db2d6', keep: 0, exposure: 1.0, sheen: 0.5,
    horizon: '#d3eaf8', zenith: '#2b67b3', glowCol: '#ffc439', glow: 1.0, cloudLit: '#fff6dc', cloudDark: '#8fb7e0', clouds: 0.5,
    ridgeFar: '#a9cce9', ridgeMid: '#739fcc', ridgeNear: '#4b7aae',
    water: '#2a62a6', reflect: 0.9, blur: 1.0, wave: 0.012, fog: '#eaf4fc', fogDensity: 0.0045, sunCol: '#ffd96b',
    mote: '#ffffff', moteAmt: 0.6, body: '#f8fbfe', spec: 1, film: 0, mist: '#eef6fc', floor: '#ffffff', floorAmt: 0.8,
  };
  const DARK = {
    lit: '#68505f', mid: '#4f4055', shade: '#372e44', deep: '#262031', keep: 0.14, exposure: 1.0, sheen: 0.5,
    horizon: '#8e6474', zenith: '#221d36', glowCol: '#e0937a', glow: 0.5, cloudLit: '#d89a92', cloudDark: '#4a3653', clouds: 0.5,
    ridgeFar: '#5e4864', ridgeMid: '#463751', ridgeNear: '#2e263b',
    water: '#1d1928', reflect: 0.85, blur: 1.0, wave: 0.012, fog: '#2d2535', fogDensity: 0.0045, sunCol: '#ffd9c4',
    mote: '#ffd9c8', moteAmt: 0.12, body: '#3e3647', spec: 0, film: 0.6, mist: '#131016', floor: '#15121a', floorAmt: 0.45,
  };
  const toVec = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' ? hex(v) : v]));
  const PALETTES = { light: toVec(LIGHT), dark: toVec(DARK) };

  // ---- State the page sets ----
  const state = {
    mode: isCase ? 'case' : 'hero',
    calm: 0, calmTarget: 0,
    pearl: null, pearlTarget: null,
    intro: 0, entry: 0,
    // The donor page is always light. Only the staff view uses the dark palette.
    dark: isCase ? 1 : 0,
    pointer: { x: 0.5, y: 0.5, px: 0.5, py: 0.5, moved: false, look: [0, 0], lookTarget: [0, 0] },
    t0: performance.now(), last: performance.now(), running: false, raf: 0, hidden: document.hidden,
    slow: 0, frames: 0, loaded: isCase,
  };
  const reduced = () => reduceMq.matches;
  const scene = { parts: [], water: null, sphere: null, motes: null };

  api.setMode = (mode) => {
    if (isCase) return;
    state.mode = mode;
    state.calmTarget = mode === 'call' ? 1 : 0;
    if (reduced()) state.calm = state.calmTarget;
    kick();
  };
  /** The pearl's centre and radius in CSS pixels, from the headline's first line. */
  api.setPearl = (x, y, r) => {
    state.pearlTarget = [x, y, r];
    if (!state.pearl) state.pearl = [x, y, r];
    kick();
  };

  // ---- Pointer flow and the look around ----
  function onPointer(e) {
    if (reduced()) return;
    const x = e.clientX / size.cssW;
    const y = 1 - e.clientY / size.cssH;
    if (!state.pointer.moved) {
      state.pointer.px = x;
      state.pointer.py = y;
      state.pointer.moved = true;
    }
    state.pointer.x = x;
    state.pointer.y = y;
    state.pointer.lookTarget = [Math.max(-1, Math.min(1, (x - 0.5) * 2)), Math.max(-1, Math.min(1, (y - 0.5) * 2))];
  }
  window.addEventListener('pointermove', onPointer, { passive: true });

  /** The page's framing at this screen shape, plus the walk-in on entry. */
  function baseCamera() {
    const aspect = size.cssW / size.cssH;
    const k = Math.min(Math.max((1.25 - aspect) / 0.45, 0), 1);
    const mix = (a, b) => a.map((v, i) => v + (b[i] - v) * k);
    let pos = mix(VIEW.pos, VIEW.portrait.pos);
    const target = mix(VIEW.target, VIEW.portrait.target);
    const fov = VIEW.fov + (VIEW.portrait.fov - VIEW.fov) * k;
    // On entry the room waits a few steps back and the camera walks in over 4.6 s, the slow pan-in unseen opens with.
    const e = 1 - Math.pow(1 - state.entry, 3);
    if (e < 1) {
      const fwd = norm(sub(target, pos));
      const side = norm(cross(fwd, [0, 1, 0]));
      pos = add(add(add(pos, fwd, -3.2 * (1 - e)), side, -1.8 * (1 - e)), [0, 0.4 * (1 - e), 0]);
    }
    return { pos, target, fov };
  }

  /** Where the camera is this moment: the framing, a slow hand-held wander, and a turn toward the pointer. */
  function camera(t) {
    const base = baseCamera();
    const still = reduced();
    const wx = still ? 0 : (Math.sin(t * 0.273) * 0.5 + Math.sin(t * 0.163 + 1.3) * 0.3 + Math.sin(t * 0.091 + 2.1) * 0.2) * 0.2;
    const wy = still ? 0 : (Math.sin(t * 0.211 + 0.7) * 0.5 + Math.sin(t * 0.127 + 2.4) * 0.3 + Math.sin(t * 0.077 + 0.4) * 0.2) * 0.15;
    const fwd = sub(base.target, base.pos);
    const dist = Math.hypot(...fwd);
    const f = norm(fwd);
    const right = norm(cross(f, [0, 1, 0]));
    const up = cross(right, f);
    const pan = add([right[0] * wx, right[1] * wx, right[2] * wx], up, wy);
    const look = state.pointer.look;
    const yaw = 3.2 * DEG * look[0];
    const pitch = 1.5 * DEG * look[1];
    const eye = add(add(base.pos, pan), right, look[0] * 0.4);
    let at = add(base.target, pan);
    at = add(add(at, right, dist * Math.tan(yaw)), up, dist * Math.tan(pitch));
    const aspect = size.cssW / size.cssH;
    const proj = M.perspective(base.fov * DEG, aspect, 0.5, 1500);
    const view = M.lookAt(eye, at, [0, 1, 0]);
    return { eye, view, proj, vp: M.mul(proj, view), base, aspect };
  }

  /** The pearl in the room: on the ray through its screen point, a set distance in front of the framing's camera. */
  function pearlWorld(base, aspect) {
    if (!state.pearl) return null;
    const [x, y, r] = state.pearl;
    const D = 24;
    const f = norm(sub(base.target, base.pos));
    const right = norm(cross(f, [0, 1, 0]));
    const up = cross(right, f);
    const th = Math.tan((base.fov * DEG) / 2);
    const nx = (x / size.cssW) * 2 - 1;
    const ny = 1 - (y / size.cssH) * 2;
    const c = add(add(add(base.pos, f, D), right, nx * th * aspect * D), up, ny * th * D);
    return [c[0], c[1], c[2], (r / (size.cssH / 2)) * th * D];
  }

  // ---- Drawing ----
  function useTarget(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : size.w, t ? t.h : size.h);
  }
  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }
  function setPalette(prog, pal, names) {
    for (const [uniform, key] of names) {
      const loc = prog.u[uniform];
      if (!loc) continue;
      const v = pal[key];
      if (Array.isArray(v)) gl.uniform3f(loc, v[0], v[1], v[2]);
      else gl.uniform1f(loc, v);
    }
  }
  const SKY_KEYS = [['uHorizon', 'horizon'], ['uZenith', 'zenith'], ['uGlowCol', 'glowCol'], ['uGlow', 'glow'], ['uCloudLit', 'cloudLit'],
    ['uCloudDark', 'cloudDark'], ['uClouds', 'clouds'], ['uRidgeFar', 'ridgeFar'], ['uRidgeMid', 'ridgeMid'], ['uRidgeNear', 'ridgeNear']];
  const ROOM_KEYS = [['uLit', 'lit'], ['uMid', 'mid'], ['uShade', 'shade'], ['uDeep', 'deep'], ['uKeep', 'keep'], ['uExposure', 'exposure'],
    ['uFogCol', 'fog'], ['uFogDensity', 'fogDensity'], ['uGlowCol', 'glowCol'], ['uSheen', 'sheen']];
  const WATER_KEYS = [['uWaterCol', 'water'], ['uReflect', 'reflect'], ['uBlur', 'blur'], ['uWave', 'wave'], ['uSunCol', 'sunCol'],
    ['uFogCol', 'fog'], ['uFogDensity', 'fogDensity']];
  const PEARL_KEYS = [['uMid', 'mid'], ['uShade', 'shade'], ['uWaterCol', 'water'], ['uZenith', 'zenith'], ['uGlowCol', 'glowCol'], ['uBody', 'body'], ['uSpec', 'spec'], ['uFilm', 'film']];

  /** The sky, the room, the rocks and the pearl, from one view-projection. The reflection pass flips them about the water. */
  function drawWorld(cam, vp, pal, time, pearl, mirrored) {
    const clip = mirrored ? 1 : 0;
    const sk = progs.sky;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(sk.p);
    gl.uniformMatrix4fv(sk.u.uInvVP, false, M.invert(vp));
    gl.uniform3f(sk.u.uGlowDir, DUSK[0], DUSK[1], DUSK[2]);
    gl.uniform1f(sk.u.uTime, time);
    setPalette(sk, pal, SKY_KEYS);
    gl.bindVertexArray(fsVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    const rm = progs.room;
    gl.useProgram(rm.p);
    gl.uniformMatrix4fv(rm.u.uVP, false, vp);
    gl.uniform3f(rm.u.uCam, cam.eye[0], cam.eye[1], cam.eye[2]);
    gl.uniform1f(rm.u.uClip, clip);
    setPalette(rm, pal, ROOM_KEYS);
    gl.uniform1i(rm.u.uBake, 0);
    for (const part of scene.parts) {
      bindTex(0, part.tex);
      gl.uniformMatrix4fv(rm.u.uModel, false, part.model);
      gl.bindVertexArray(part.vao);
      gl.drawElements(gl.TRIANGLES, part.count, part.type, 0);
    }

    if (pearl) {
      const pp = progs.pearl;
      gl.useProgram(pp.p);
      gl.uniformMatrix4fv(pp.u.uVP, false, vp);
      gl.uniform4f(pp.u.uPearl, pearl[0], pearl[1], pearl[2], pearl[3]);
      gl.uniform3f(pp.u.uCam, cam.eye[0], cam.eye[1], cam.eye[2]);
      gl.uniform3f(pp.u.uKey, KEY[0], KEY[1], KEY[2]);
      gl.uniform3f(pp.u.uGlowDir, DUSK[0], DUSK[1], DUSK[2]);
      gl.uniform1f(pp.u.uTime, time);
      gl.uniform1f(pp.u.uClip, clip);
      setPalette(pp, pal, PEARL_KEYS);
      gl.bindVertexArray(scene.sphere.vao);
      gl.drawElements(gl.TRIANGLES, scene.sphere.count, gl.UNSIGNED_SHORT, 0);
    }
  }

  function palette() {
    return state.dark ? PALETTES.dark : PALETTES.light;
  }

  function stepFlow(dt) {
    let flowTex = rt.flowA.tex;
    if (!flowOk || reduced()) return flowTex;
    const s = state;
    const f = progs.flow;
    useTarget(rt.flowB);
    gl.useProgram(f.p);
    bindTex(0, rt.flowA.tex);
    gl.uniform1i(f.u.uPrev, 0);
    const vx = (s.pointer.x - s.pointer.px);
    const vy = (s.pointer.y - s.pointer.py);
    s.pointer.px = s.pointer.x;
    s.pointer.py = s.pointer.y;
    gl.uniform2f(f.u.uMouse, s.pointer.x, s.pointer.y);
    gl.uniform2f(f.u.uVel, vx * (1 - s.calm * 0.75), vy * (1 - s.calm * 0.75));
    gl.uniform1f(f.u.uAspect, size.cssW / size.cssH);
    gl.uniform1f(f.u.uRadius, 0.11);
    gl.uniform1f(f.u.uDecay, Math.pow(0.955, dt * 60));
    gl.bindVertexArray(fsVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    [rt.flowA, rt.flowB] = [rt.flowB, rt.flowA];
    flowTex = rt.flowA.tex;
    return flowTex;
  }

  function drawRoom(time, flowTex) {
    const s = state;
    const pal = palette();
    const cam = camera(time);
    const pearl = pearlWorld(cam.base, cam.aspect);
    if (pearl && !reduced()) pearl[1] += Math.sin(time * 0.6) * 0.05;

    // The reflection: the room flipped about the water, drawn into a half-size texture whose mip levels blur it.
    useTarget(rt.refl);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawWorld(cam, M.mul(cam.vp, MIRROR), pal, time, pearl, true);
    bindTex(0, rt.refl.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // The room itself, then the water over the floor, then the specks.
    const target = rt.msaa || rt.scene;
    useTarget(target);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawWorld(cam, cam.vp, pal, time, pearl, false);

    const wp = progs.water;
    gl.useProgram(wp.p);
    gl.uniformMatrix4fv(wp.u.uVP, false, cam.vp);
    bindTex(0, rt.refl.tex);
    bindTex(1, flowTex);
    gl.uniform1i(wp.u.uRefl, 0);
    gl.uniform1i(wp.u.uFlow, 1);
    gl.uniform1f(wp.u.uFlowOn, flowOk && !reduced() ? 1 : 0);
    gl.uniform2f(wp.u.uRes, target.w, target.h);
    gl.uniform1f(wp.u.uTime, time);
    gl.uniform1f(wp.u.uCalm, s.calm);
    gl.uniform3f(wp.u.uCam, cam.eye[0], cam.eye[1], cam.eye[2]);
    gl.uniform3f(wp.u.uSunDir, KEY[0], KEY[1], KEY[2]);
    setPalette(wp, pal, WATER_KEYS);
    gl.bindVertexArray(scene.water.vao);
    gl.drawArrays(gl.TRIANGLES, 0, scene.water.count);

    if (!reduced()) {
      const mp = progs.mote;
      gl.useProgram(mp.p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
      gl.uniformMatrix4fv(mp.u.uVP, false, cam.vp);
      gl.uniformMatrix4fv(mp.u.uView, false, cam.view);
      gl.uniform1f(mp.u.uTime, time);
      gl.uniform1f(mp.u.uPx, target.h / (2 * Math.tan((cam.base.fov * DEG) / 2)));
      gl.uniform3f(mp.u.uCol, pal.mote[0], pal.mote[1], pal.mote[2]);
      gl.uniform1f(mp.u.uAmt, pal.moteAmt * (1 - s.calm * 0.8));
      gl.bindVertexArray(scene.motes.vao);
      gl.drawArrays(gl.POINTS, 0, scene.motes.count);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    gl.disable(gl.DEPTH_TEST);

    if (rt.msaa) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rt.msaa.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, rt.scene.fb);
      gl.blitFramebuffer(0, 0, rt.msaa.w, rt.msaa.h, 0, 0, rt.scene.w, rt.scene.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
  }

  function drawCase(time) {
    const sc = progs.scene;
    useTarget(rt.scene);
    gl.useProgram(sc.p);
    gl.uniform2f(sc.u.uRes, rt.scene.w, rt.scene.h);
    gl.uniform1f(sc.u.uTime, time);
    gl.bindVertexArray(fsVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(time, dt) {
    const s = state;
    const k = 1 - Math.exp(-dt / 0.9);
    s.calm += (s.calmTarget - s.calm) * k;
    if (s.pearl && s.pearlTarget) for (let i = 0; i < 3; i += 1) s.pearl[i] += (s.pearlTarget[i] - s.pearl[i]) * (1 - Math.exp(-dt / 0.5));
    const look = s.pointer.look;
    look[0] += (s.pointer.lookTarget[0] - look[0]) * (1 - Math.exp(-dt / 1.2));
    look[1] += (s.pointer.lookTarget[1] - look[1]) * (1 - Math.exp(-dt / 1.2));

    const flowTex = stepFlow(dt);
    if (isCase) drawCase(time);
    else drawRoom(time, flowTex);

    // Grain, vignette, the split at the edges, the pointer's smear, and the calm mist for the call.
    const po = progs.post;
    useTarget(null);
    gl.useProgram(po.p);
    bindTex(0, rt.scene.tex);
    bindTex(1, flowTex);
    gl.uniform1i(po.u.uScene, 0);
    gl.uniform1i(po.u.uFlow, 1);
    gl.uniform1f(po.u.uTime, time);
    gl.uniform1f(po.u.uFlowAmt, flowOk && !reduced() ? 0.55 : 0);
    gl.uniform1f(po.u.uGrain, isCase ? 0.055 : s.dark ? 0.04 : 0.045);
    // The donor page has no RGB split: on white plaster the fringes would read as red and cyan.
    gl.uniform1f(po.u.uCA, isCase ? 0.028 : 0);
    gl.uniform1f(po.u.uVig, isCase ? 0.35 : s.dark ? 0.24 : 0.14);
    gl.uniform1f(po.u.uCalm, s.calm * 0.55);
    gl.uniform1f(po.u.uIntro, s.intro);
    const mist = isCase ? [0.075, 0.09, 0.088] : palette().mist;
    gl.uniform3f(po.u.uMist, mist[0], mist[1], mist[2]);
    const floor = isCase ? [0, 0, 0] : palette().floor;
    gl.uniform3f(po.u.uFloor, floor[0], floor[1], floor[2]);
    gl.uniform1f(po.u.uFloorAmt, isCase ? 0 : palette().floorAmt);
    gl.bindVertexArray(fsVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function tick(now) {
    state.raf = 0;
    if (!state.running) return;
    const dt = Math.min(0.1, Math.max(0.001, (now - state.last) / 1000));
    state.last = now;
    state.intro = Math.min(1, state.intro + dt / 1.8);
    state.entry = Math.min(1, state.entry + dt / 4.6);
    // One step down in quality when frames run long for a second and a half, then never again.
    state.frames += 1;
    if (dt > 0.021) state.slow += 1;
    if (state.frames === 90 && state.slow > 45 && quality.scale > 0.55) {
      quality.scale = isCase ? 0.48 : 0.6;
      quality.dpr = 1;
      rt.scene = null;
      resize();
    }
    frame((now - state.t0) / 1000, dt);
    // In a call the room settles into its dim still and stops drawing, so the line has the machine to itself.
    // setMode('hero'), a resize or a theme change kicks it again.
    const settled = state.mode === 'call' && Math.abs(state.calmTarget - state.calm) < 0.002;
    if (reduced() || settled) {
      state.running = false;
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  // Reduced motion draws one still frame per change: no drift, no flow, no walk-in, no intro.
  function kick() {
    if (state.hidden || !state.loaded) return;
    if (reduced()) {
      state.intro = 1;
      state.entry = 1;
      state.calm = state.calmTarget;
      state.pointer.look = [0, 0];
      if (state.pearlTarget) state.pearl = [...state.pearlTarget];
      frame(12, 1 / 60);
      return;
    }
    if (state.running) return;
    state.running = true;
    state.last = performance.now();
    if (!state.raf) state.raf = requestAnimationFrame(tick);
  }
  function stop() {
    state.running = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  document.addEventListener('visibilitychange', () => {
    state.hidden = document.hidden;
    if (document.hidden) stop();
    else kick();
  });
  window.addEventListener('resize', () => { resize(); kick(); });
  reduceMq.addEventListener('change', () => { stop(); kick(); });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    stop();
    root.classList.remove('has-gl');
  });

  /**
   * For the legibility check: draws the room at each given time with the wander of that moment, with the pointer's look
   * held at `look` ([-1..1, -1..1], right and up) when given, reads the canvas pixels inside each CSS-pixel rect, and
   * returns the darkest and lightest relative luminance found in each, and the 1st and 99th percentiles.
   */
  api.probe = (rects, times, look) => {
    const out = [];
    const wasRunning = state.running;
    stop();
    const keepLook = state.pointer.look;
    const keepTarget = state.pointer.lookTarget;
    if (look) {
      state.pointer.look = [...look];
      state.pointer.lookTarget = [...look];
    }
    const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    for (const t of times) {
      frame(t, 1 / 60);
      for (const r of rects) {
        const sx = size.w / size.cssW;
        const x = Math.max(0, Math.floor(r.x * sx));
        const y = Math.max(0, Math.floor(size.h - (r.y + r.h) * sx));
        const w = Math.max(1, Math.min(size.w - x, Math.floor(r.w * sx)));
        const h = Math.max(1, Math.min(size.h - y, Math.floor(r.h * sx)));
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const ls = new Float32Array(px.length / 4);
        for (let i = 0; i < px.length; i += 4) ls[i / 4] = 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
        ls.sort();
        const at = (q) => ls[Math.min(ls.length - 1, Math.floor(q * ls.length))];
        out.push({ t, name: r.name, min: ls[0], max: ls[ls.length - 1], p01: at(0.01), p99: at(0.99) });
      }
    }
    state.pointer.look = keepLook;
    state.pointer.lookTarget = keepTarget;
    if (wasRunning) kick();
    return out;
  };

  function start() {
    resize();
    // The first frame is drawn before the canvas shows, so a slow first animation frame never flashes black.
    frame(0, 1 / 60);
    root.classList.add('has-gl');
    api.ready = true;
    if (reduced()) {
      state.intro = 1;
      state.entry = 1;
    }
    kick();
  }

  if (isCase) {
    start();
    return;
  }
  scene.water = waterMesh();
  scene.sphere = sphereMesh();
  scene.motes = moteMesh(window.innerWidth < 768 ? 70 : 140);
  // Until the room arrives the page shows the painted still, so a slow network never shows an empty canvas.
  loadRoom().then((parts) => {
    scene.parts = parts;
    state.loaded = true;
    state.t0 = performance.now();
    start();
  }).catch(() => {
    root.classList.remove('has-gl');
  });
})();
