'use strict';

// The room behind the page, in raw WebGL2: a calm pastel room of light over rippled mirror water, an iridescent pearl
// behind the headline, sparse specks, slow light and a hand-held drift. The pointer stirs a flow field that smears the
// room and settles in about 1.5 s, and a last pass adds grain, a soft vignette and a slight RGB split at the edges.
// Everything is drawn in one fragment shader per pass, so there are no models, textures or libraries to load.
// The page works the same without it: html keeps no "has-gl" class and the CSS paints a still of the room.
(() => {
  const noop = () => {};
  const api = { ready: false, setMode: noop, setPearl: noop, probe: () => null };
  window.PledgeScene = api;

  const canvas = document.getElementById('scene');
  if (!canvas) return;
  const root = document.documentElement;
  const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  const isCase = root.dataset.page === 'staff';

  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  } catch {
    gl = null;
  }
  if (!gl) return;

  const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // smoothstep edges always run low to high and pow bases stay at or above 0, since both are undefined otherwise.
  const COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
`;

  const SCENE = `${COMMON}
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uDrift;
uniform vec3 uPearl;
uniform vec3 uView;
uniform float uDark;
uniform float uCalm;
uniform float uCase;
uniform sampler2D uFlow;
uniform float uFlowOn;

const float H = -0.17;

vec3 pal(vec3 light, vec3 dark) { return mix(light, dark, uDark); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
// An arch standing on y = 0, half width w, total height h, with a round top.
float sdArch(vec2 p, float w, float h) {
  float r = sdBox(p - vec2(0.0, (h - w) * 0.5), vec2(w, (h - w) * 0.5));
  return min(r, length(p - vec2(0.0, h - w)) - w);
}
float inside(float d, float s) { return 1.0 - smoothstep(-s, s, d); }

vec3 sky(vec2 p) {
  float t = clamp((p.y - H) / 0.6, 0.0, 1.0);
  vec3 col = mix(pal(vec3(0.975, 0.875, 0.81), vec3(0.44, 0.38, 0.47)), pal(vec3(0.74, 0.85, 0.9), vec3(0.2, 0.24, 0.32)), smoothstep(0.0, 1.0, t));
  float far = H + 0.055 + 0.022 * sin(p.x * 6.0 + 1.3) + 0.012 * sin(p.x * 17.0 + 0.4);
  float near = H + 0.025 + 0.03 * sin(p.x * 3.4 + 4.1) + 0.01 * sin(p.x * 11.0);
  col = mix(col, pal(vec3(0.84, 0.8, 0.84), vec3(0.3, 0.31, 0.34)), 1.0 - smoothstep(far - 0.003, far + 0.003, p.y));
  col = mix(col, pal(vec3(0.76, 0.81, 0.77), vec3(0.22, 0.26, 0.26)), 1.0 - smoothstep(near - 0.003, near + 0.003, p.y));
  return col;
}

vec3 pearl(vec2 p, float soft, out float a) {
  vec2 d = (p - uPearl.xy) / uPearl.z;
  float r = length(d);
  a = 1.0 - smoothstep(1.0 - soft * 8.0 - 0.012, 1.0 + 0.012, r);
  if (a <= 0.0) return vec3(0.0);
  vec3 n = vec3(d, sqrt(max(1.0 - r * r, 0.0)));
  float ndv = clamp(n.z, 0.0, 1.0);
  vec3 key = normalize(vec3(0.55, 0.6, 0.6));
  float wrap = clamp(dot(n, key) * 0.5 + 0.5, 0.0, 1.0);
  // A thin-film shimmer that slides slowly round the rim, over a satin body that takes the room's warm light.
  float x = ndv * 1.3 + n.y * 0.25 + uTime * 0.025;
  vec3 film = 0.5 + 0.5 * cos(6.28318 * (x + vec3(0.0, 0.33, 0.67)));
  vec3 body = pal(vec3(0.83, 0.8, 0.79), vec3(0.36, 0.36, 0.4)) + pal(vec3(0.17), vec3(0.12)) * wrap;
  float rim = pow(clamp(1.0 - ndv, 0.0, 1.0), 2.2);
  body = mix(body, body * (0.75 + 0.5 * film), 0.25 + 0.55 * rim);
  float spec = pow(max(dot(reflect(-vec3(0.0, 0.0, 1.0), n), key), 0.0), 60.0);
  body += pal(vec3(0.35), vec3(0.4)) * spec;
  return body;
}

vec3 room(vec2 p, float soft) {
  float t = uTime;
  float y = p.y - H;
  // Plaster, a touch warmer low down, with a slow breathing of the light across it.
  vec3 wall = mix(pal(vec3(0.957, 0.893, 0.855), vec3(0.3, 0.29, 0.31)), pal(vec3(0.913, 0.827, 0.798), vec3(0.25, 0.24, 0.27)), smoothstep(0.0, 0.7, y));
  // A long diagonal shadow over the upper left of the wall, with the hard edge of direct sun.
  float shade = smoothstep(0.023, 0.047, y * 0.9 - (p.x + 0.05) * 0.75 - 0.12);
  wall *= 1.0 - shade * pal(vec3(0.15, 0.16, 0.12), vec3(0.22));

  // The window high on the right, and the patch of light it throws down and to the left.
  vec2 wq = p - vec2(0.48, 0.2);
  float breath = 0.82 + 0.18 * sin(t * 0.21) * sin(t * 0.13 + 1.0);
  vec2 lq = wq - vec2(-0.29, -0.27);
  lq.x += lq.y * 0.55;
  float sunPatch = inside(sdBox(lq, vec2(0.085, 0.16)), 0.008 + soft);
  wall += pal(vec3(0.09, 0.078, 0.054), vec3(0.05, 0.06, 0.075)) * sunPatch * breath;

  // Steps rising from the water, centre left, each tread a little lighter than its riser.
  vec2 sq = p - vec2(-0.06, H);
  float steps = 0.0;
  float tread = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float top = (fi + 1.0) * 0.024;
    float hw = 0.27 - fi * 0.012;
    float m = inside(sdBox(sq - vec2(fi * 0.012, top * 0.5), vec2(hw, top * 0.5)), 0.002 + soft);
    steps = max(steps, m);
    tread = max(tread, m * (1.0 - smoothstep(0.0, 0.006 + soft, abs(sq.y - top))));
  }
  vec3 stone = pal(vec3(0.935, 0.895, 0.87), vec3(0.32, 0.31, 0.33));
  wall = mix(wall, stone * (0.9 + 0.1 * smoothstep(-0.3, 0.3, sq.x)), steps);
  wall += tread * pal(vec3(0.06, 0.055, 0.045), vec3(0.03));

  // A low ledge along the right.
  float ledge = inside(sdBox(p - vec2(0.72, H + 0.045), vec2(0.42, 0.045)), 0.002 + soft);
  float ledgeTop = ledge * (1.0 - smoothstep(0.0, 0.01 + soft, abs(p.y - (H + 0.09))));
  wall = mix(wall, pal(vec3(0.925, 0.878, 0.85), vec3(0.28, 0.27, 0.29)), ledge);
  wall += ledgeTop * pal(vec3(0.035), vec3(0.03));

  // Three arches on the left open onto a soft sky and two ranges of hills. Each shows a shaded jamb on one side.
  vec3 col = wall;
  for (int i = 0; i < 3; i++) {
    vec2 aq = p - vec2(-0.96 + float(i) * 0.27, H);
    float open = inside(sdArch(aq, 0.088, 0.42), 0.0015 + soft);
    float jamb = inside(sdArch(aq + vec2(0.026, 0.0), 0.088, 0.42), 0.0015 + soft) * (1.0 - open);
    col = mix(col, wall * pal(vec3(0.8, 0.79, 0.84), vec3(0.7, 0.72, 0.75)), jamb);
    col = mix(col, sky(p), open);
  }
  float win = inside(sdBox(wq, vec2(0.058, 0.2)), 0.0015 + soft);
  float winJamb = inside(sdBox(wq + vec2(0.03, 0.0), vec2(0.058, 0.2)), 0.0015 + soft) * (1.0 - win);
  col = mix(col, wall * pal(vec3(0.82, 0.8, 0.84), vec3(0.72, 0.74, 0.77)), winJamb);
  col = mix(col, sky(p + vec2(0.0, 0.1)), win);

  // A shaft of light from the window, faint, with dust drifting through it.
  vec2 sp = wq;
  float along = clamp(-(sp.y * 0.7 + sp.x * 0.71) / 0.55, 0.0, 1.0);
  float across = abs(sp.x * 0.7 - sp.y * 0.71 + 0.02);
  float shaft = (1.0 - smoothstep(0.03, 0.13, across)) * smoothstep(0.0, 0.15, along) * (1.0 - along);
  float dust = 0.7 + 0.3 * noise(vec2(across * 40.0, along * 9.0 - t * 0.15));
  col += pal(vec3(0.07, 0.06, 0.045), vec3(0.03, 0.035, 0.045)) * shaft * dust * breath * (1.0 - uCalm * 0.6);

  // Contact shade where the wall meets the water.
  col *= 1.0 - pal(vec3(0.08), vec3(0.15)) * exp(-max(y, 0.0) * 28.0);

  float pa;
  vec3 pc = pearl(p, soft, pa);
  col = mix(col, pc, pa);
  return col;
}

vec3 specks(vec2 p) {
  vec2 g = p * 11.0;
  vec2 cell = floor(g);
  float r = hash(cell);
  if (r < 0.9) return vec3(0.0);
  vec2 c = cell + 0.5 + 0.3 * vec2(sin(uTime * 0.11 + r * 40.0), cos(uTime * 0.09 + r * 23.0));
  float d = length(g - c);
  float tw = 0.5 + 0.5 * sin(uTime * (0.6 + r) + r * 60.0);
  return pal(vec3(1.0, 0.98, 0.95), vec3(0.7, 0.8, 0.85)) * exp(-d * d * 260.0) * tw * tw * 0.55 * (1.0 - uCalm * 0.7);
}

vec3 caseRoom(vec2 p) {
  // The staff view's dark case page: near black with one slow pool of light and the same specks.
  vec3 col = vec3(0.052, 0.058, 0.057);
  vec2 lp = vec2(0.35 + 0.1 * sin(uTime * 0.05), 0.25 + 0.06 * cos(uTime * 0.04));
  col += vec3(0.035, 0.045, 0.045) * exp(-dot(p - lp, p - lp) * 4.0);
  col += vec3(0.02, 0.02, 0.025) * exp(-dot(p + vec2(0.6, 0.3), p + vec2(0.6, 0.3)) * 3.0);
  return col;
}

void main() {
  vec2 frag = vUv * uRes;
  vec2 p = (frag - 0.5 * uRes) / uRes.y;
  p = p * uView.x + vec2(uView.y, uView.z) + uDrift;
  if (uCase > 0.5) {
    o = vec4(caseRoom(p) + specks(p) * 0.35, 1.0);
    return;
  }
  vec4 flow = texture(uFlow, vUv) * uFlowOn;
  vec3 col;
  if (p.y >= H) {
    col = room(p, 0.0) + specks(p);
  } else {
    // Mirror water: the room reflected about the waterline, bent by slow ripples and by the pointer's trail.
    float depth = H - p.y;
    float z = 0.14 / (depth + 0.03);
    vec2 w = vec2(p.x * z, z);
    float calm = 1.0 - uCalm * 0.7;
    float r1 = sin(w.x * 6.0 + uTime * 0.55) + 0.6 * sin(w.x * 2.7 - w.y * 4.0 + uTime * 0.42) + 0.4 * sin(w.y * 7.5 - uTime * 0.8);
    float r2 = cos(w.x * 4.3 - uTime * 0.47) + 0.5 * sin(w.y * 5.3 + w.x * 1.7 + uTime * 0.63);
    vec2 bend = vec2(r1 * 0.006, r2 * 0.004) * (0.35 + depth * 3.0) * calm;
    bend += flow.xy * flow.z * 0.25;
    vec2 pr = vec2(p.x + bend.x, 2.0 * H - p.y + bend.y);
    vec3 refl = room(pr, 0.004 + depth * 0.035);
    float k = mix(0.84, 0.56, smoothstep(0.0, 0.45, depth));
    vec3 tint = pal(vec3(0.69, 0.79, 0.75), vec3(0.12, 0.13, 0.15));
    col = mix(tint, refl * pal(vec3(0.97, 0.99, 1.0), vec3(0.8, 0.85, 0.85)), k);
    // Glints where the ripples face the window.
    float glint = pow(clamp(r1 * 0.5 + 0.2, 0.0, 1.0), 10.0) * (1.0 - smoothstep(0.0, 0.25, abs(p.x - 0.3 + depth * 0.4)));
    col += pal(vec3(0.06, 0.055, 0.05), vec3(0.04, 0.05, 0.06)) * glint * calm;
    col *= 1.0 - smoothstep(0.2, 0.75, depth) * pal(vec3(0.06), vec3(0.25));
  }
  o = vec4(col, 1.0);
}`;

  const FLOW = `${COMMON}
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
uniform sampler2D uScene;
uniform sampler2D uFlow;
uniform vec2 uRes;
uniform float uTime;
uniform float uFlowAmt;
uniform float uGrain;
uniform float uCA;
uniform float uVig;
uniform float uCalm;
uniform float uDark;
uniform float uIntro;
uniform vec3 uMist;
void main() {
  vec4 f = texture(uFlow, vUv);
  vec2 uv = vUv - f.xy * f.z * uFlowAmt;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 off = c * r2 * uCA;
  vec3 col = vec3(texture(uScene, uv + off).r, texture(uScene, uv).g, texture(uScene, uv - off).b);
  col = mix(col, uMist, uCalm);
  col *= 1.0 - uVig * smoothstep(0.12, 0.6, r2);
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
  function program(frag) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i += 1) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u: uniforms };
  }

  let progs;
  try {
    progs = { scene: program(SCENE), flow: program(FLOW), post: program(POST) };
  } catch {
    // A driver that can't build the shaders gets the painted still, like a browser with no WebGL.
    return;
  }

  const floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const vao = gl.createVertexArray();

  function target(w, h, half) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h, ok };
  }
  function drop(t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  }

  // The scene draws at a fraction of the screen and the post pass scales it up. Grain hides the difference, and a slow
  // frame drops the fraction once, so a laptop holds 60 fps.
  const quality = { dpr: Math.min(window.devicePixelRatio || 1, 1.5), scale: 0.62 };
  let rt = { scene: null, flowA: null, flowB: null };
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
    drop(rt.scene); drop(rt.flowA); drop(rt.flowB);
    rt.scene = target(Math.max(2, Math.round(w * quality.scale)), Math.max(2, Math.round(h * quality.scale)), false);
    const fw = Math.max(2, Math.round(cssW / 6));
    const fh = Math.max(2, Math.round(cssH / 6));
    rt.flowA = target(fw, fh, floatTargets);
    rt.flowB = target(fw, fh, floatTargets);
    flowOk = floatTargets && rt.flowA.ok && rt.flowB.ok;
    for (const t of [rt.flowA, rt.flowB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    view = framing();
  }

  // Portrait screens keep a wide view of the room, the way unseen's phone layout does, so the arches and the window
  // stay in frame and the wall never ends above the headline.
  function framing() {
    const aspect = size.cssW / size.cssH;
    if (aspect >= 1.2) return [1, 0, 0];
    if (aspect >= 0.8) return [1.35, -0.03, 0.02];
    return [1.95, -0.04, 0.06];
  }
  let view = [1, 0, 0];

  // ---- State the page sets ----
  const state = {
    mode: isCase ? 'case' : 'hero',
    calm: 0, calmTarget: 0,
    pearl: [0.3, 0.12, 0.08], pearlTarget: [0.3, 0.12, 0.08],
    intro: 0,
    dark: isCase || darkMq.matches ? 1 : 0,
    pointer: { x: 0.5, y: 0.5, px: 0.5, py: 0.5, moved: false, look: [0, 0], lookTarget: [0, 0] },
    t0: performance.now(), last: performance.now(), running: false, raf: 0, hidden: document.hidden,
    slow: 0, frames: 0,
  };
  const reduced = () => reduceMq.matches;

  api.setMode = (mode) => {
    if (isCase) return;
    state.mode = mode;
    state.calmTarget = mode === 'call' ? 1 : 0;
    if (reduced()) state.calm = state.calmTarget;
    kick();
  };
  /** The pearl's centre and radius in CSS pixels, from the headline's first line. */
  api.setPearl = (x, y, r) => {
    const toP = (px, py) => [(px - size.cssW / 2) / size.cssH, -(py - size.cssH / 2) / size.cssH];
    const [px, py] = toP(x, y);
    const v = view;
    // The scene's p runs through the view's zoom and offset, so the pearl is placed back through it.
    state.pearlTarget = [px * v[0] + v[1], py * v[0] + v[2], (r / size.cssH) * v[0]];
    if (!state.placed) {
      state.pearl = [...state.pearlTarget];
      state.placed = true;
    }
    kick();
  };

  // ---- Pointer flow and the hand-held look ----
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
    state.pointer.lookTarget = [(x - 0.5) * 2, (y - 0.5) * 2];
  }
  window.addEventListener('pointermove', onPointer, { passive: true });

  // About 27 by 23 px over a minute, never still, never fast.
  function drift(t) {
    if (reduced()) return [0, 0];
    const px = 1 / size.cssH;
    const x = (Math.sin(t * 0.105) * 9 + Math.sin(t * 0.047 + 1.7) * 5) * px;
    const y = (Math.sin(t * 0.083 + 0.6) * 7.5 + Math.cos(t * 0.039) * 4) * px;
    const look = state.pointer.look;
    return [x + look[0] * 8 * px, y + look[1] * 6 * px];
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

  function frame(time, dt) {
    const s = state;
    const k = 1 - Math.exp(-dt / 0.9);
    s.calm += (s.calmTarget - s.calm) * k;
    for (let i = 0; i < 3; i += 1) s.pearl[i] += (s.pearlTarget[i] - s.pearl[i]) * (1 - Math.exp(-dt / 0.5));
    const look = s.pointer.look;
    look[0] += (s.pointer.lookTarget[0] - look[0]) * (1 - Math.exp(-dt / 1.2));
    look[1] += (s.pointer.lookTarget[1] - look[1]) * (1 - Math.exp(-dt / 1.2));
    gl.bindVertexArray(vao);

    // Flow: fade the old field, stamp the pointer's velocity where it is.
    let flowTex = rt.flowA.tex;
    if (flowOk && !reduced()) {
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
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [rt.flowA, rt.flowB] = [rt.flowB, rt.flowA];
      flowTex = rt.flowA.tex;
    }

    // The room.
    const sc = progs.scene;
    useTarget(rt.scene);
    gl.useProgram(sc.p);
    bindTex(0, flowTex);
    gl.uniform1i(sc.u.uFlow, 0);
    gl.uniform1f(sc.u.uFlowOn, flowOk && !reduced() ? 1 : 0);
    gl.uniform2f(sc.u.uRes, rt.scene.w, rt.scene.h);
    gl.uniform1f(sc.u.uTime, time);
    const d = drift(time);
    gl.uniform2f(sc.u.uDrift, d[0], d[1]);
    gl.uniform3f(sc.u.uPearl, s.pearl[0], s.pearl[1], s.pearl[2]);
    gl.uniform3f(sc.u.uView, view[0], view[1], view[2]);
    gl.uniform1f(sc.u.uDark, s.dark);
    gl.uniform1f(sc.u.uCalm, s.calm);
    gl.uniform1f(sc.u.uCase, isCase ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Grain, vignette, the split at the edges, the pointer's smear, and the calm mist for the call.
    const po = progs.post;
    useTarget(null);
    gl.useProgram(po.p);
    bindTex(0, rt.scene.tex);
    bindTex(1, flowTex);
    gl.uniform1i(po.u.uScene, 0);
    gl.uniform1i(po.u.uFlow, 1);
    gl.uniform2f(po.u.uRes, size.w, size.h);
    gl.uniform1f(po.u.uTime, time);
    gl.uniform1f(po.u.uFlowAmt, flowOk && !reduced() ? 0.55 : 0);
    gl.uniform1f(po.u.uGrain, isCase ? 0.055 : s.dark ? 0.045 : 0.05);
    gl.uniform1f(po.u.uCA, 0.028);
    gl.uniform1f(po.u.uVig, isCase ? 0.35 : s.dark ? 0.22 : 0.16);
    gl.uniform1f(po.u.uCalm, s.calm * 0.55);
    gl.uniform1f(po.u.uDark, s.dark);
    gl.uniform1f(po.u.uIntro, s.intro);
    const mist = s.dark ? [0.075, 0.09, 0.088] : [0.945, 0.925, 0.905];
    gl.uniform3f(po.u.uMist, mist[0], mist[1], mist[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function tick(now) {
    state.raf = 0;
    if (!state.running) return;
    const dt = Math.min(0.1, Math.max(0.001, (now - state.last) / 1000));
    state.last = now;
    state.intro = Math.min(1, state.intro + dt / 1.8);
    // One step down in quality when frames run long for a second, then never again.
    state.frames += 1;
    if (dt > 0.021) state.slow += 1;
    if (state.frames === 90 && state.slow > 45 && quality.scale > 0.5) {
      quality.scale = 0.48;
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

  // Reduced motion draws one still frame per change: no drift, no flow, no intro.
  function kick() {
    if (state.hidden) return;
    if (reduced()) {
      state.intro = 1;
      state.calm = state.calmTarget;
      state.pearl = [...state.pearlTarget];
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
  darkMq.addEventListener('change', () => { state.dark = isCase || darkMq.matches ? 1 : 0; kick(); });
  reduceMq.addEventListener('change', () => { stop(); kick(); });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    stop();
    root.classList.remove('has-gl');
  });

  /**
   * For the legibility check: draws the room at each given time with the drift of that moment, reads the canvas
   * pixels inside each CSS-pixel rect, and returns the darkest and lightest relative luminance found in each.
   */
  api.probe = (rects, times) => {
    const out = [];
    const wasRunning = state.running;
    stop();
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
        let min = 1, max = 0;
        for (let i = 0; i < px.length; i += 4) {
          const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const l = 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
          if (l < min) min = l;
          if (l > max) max = l;
        }
        out.push({ t, name: r.name, min, max });
      }
    }
    if (wasRunning) kick();
    return out;
  };

  resize();
  root.classList.add('has-gl');
  api.ready = true;
  if (reduced()) state.intro = 1;
  kick();
})();
