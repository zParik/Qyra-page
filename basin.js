// The ink basin: a small stable-fluid simulation (semi-Lagrangian advection,
// Jacobi pressure solve) in WebGL. The dye texture holds ink absorbance per
// colour channel, so overlapping inks darken the way real ink on water does.
// A slow current keeps the ink drifting; the visitor's strokes and drops ride
// on top of it. While nobody touches the water the loop runs at 30 fps, and
// it stops when the basin scrolls out of view or the tab is hidden. With
// reduced motion there is no current and the ink moves only when touched.
(function () {
  "use strict";

  const canvas = document.getElementById("basin");
  if (!canvas) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Ink absorbance, -ln(colour / paper) per channel.
  const PAPER = [0.995, 0.992, 0.984];
  const INK = {
    sumi: [2.15, 2.0, 1.6],
    indigo: [1.75, 1.45, 0.72],
    rose: [0.26, 1.45, 0.86],
  };

  const config = {
    simRes: 128,
    dyeRes: window.innerWidth < 720 ? 720 : 1200,
    // How fast a stroke's momentum fades (per second). Lower keeps water moving.
    velocityDissipation: 1.4,
    pressure: 0.8,
    pressureIterations: 20,
    // Vorticity confinement: curls the ink into eddies instead of smears.
    curl: 5,
    splatRadius: 0.0026,
    splatForce: 6200,
    // The background current, in sim texels per second at its strongest.
    current: reduceMotion ? 0 : 0.8,
  };

  const gl = getContext(canvas);
  if (!gl) {
    paintStatic(canvas);
    return;
  }
  const ext = gl.ext;

  // ── Shaders ───────────────────────────────────────────────────────────
  const vertexSrc = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  const head = "precision highp float; precision highp sampler2D; varying vec2 vUv, vL, vR, vT, vB;\n";

  const sources = {
    // Rings of ink as a peacock-feather eye: alternating sumi and indigo bands,
    // stretched upright, with a rose drop at the centre. Up to three drops.
    rings: head + `
      uniform float aspect;
      uniform vec4 eyes[3];
      uniform vec3 sumi, indigo, rose;
      float hash (vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5); }
      void main () {
        vec3 a = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          vec4 e = eyes[i];
          if (e.z <= 0.0) continue;
          vec2 p = vUv - e.xy;
          p.x *= aspect;
          float ang = atan(p.y, p.x);
          // Upright, slightly heart-shaped like an eye feather.
          vec2 q = vec2(p.x, p.y * 0.78 - 0.06 * e.z * max(p.y / e.z, 0.0));
          float r = length(q) / e.z;
          r += 0.012 * sin(ang * 5.0 + float(i) * 2.1) + 0.008 * sin(ang * 11.0);
          float n = e.w;
          float k = r * n;
          float band = fract(k);
          float idx = floor(k);
          float w = 0.2 + 0.18 * hash(vec2(idx, float(i)));
          float inkBand = smoothstep(0.0, 0.03, band) * (1.0 - smoothstep(w, w + 0.04, band));
          vec3 col = mod(idx, 2.0) < 1.0 ? indigo : sumi;
          float strength = (0.55 + 0.45 * hash(vec2(idx + 7.0, float(i)))) * (1.0 - smoothstep(0.92, 1.0, r));
          a += col * inkBand * strength;
          // The rose drop at the centre.
          float core = 1.0 - smoothstep(0.6 / n, 0.9 / n, length(q) / e.z);
          a = mix(a, rose * 1.15, core);
        }
        gl_FragColor = vec4(a, 1.0);
      }`,
    splat: head + `
      uniform sampler2D uTarget;
      uniform float aspect, radius;
      uniform vec3 color;
      uniform vec2 point;
      void main () {
        vec2 p = vUv - point;
        p.x *= aspect;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + exp(-dot(p, p) / radius) * color, 1.0);
      }`,
    // A drop of ink or of clear water: pushes what is there outward.
    radial: head + `
      uniform sampler2D uTarget;
      uniform float aspect, radius, force;
      uniform vec2 point;
      void main () {
        vec2 p = vUv - point;
        p.x *= aspect;
        float d = length(p) + 1e-5;
        vec2 base = texture2D(uTarget, vUv).xy;
        vec2 push = (p / d) * force * exp(-dot(p, p) / radius);
        push.x /= aspect;
        gl_FragColor = vec4(base + push, 0.0, 1.0);
      }`,
    // Clear water at the centre of a drop: lifts the ink there.
    clearDrop: head + `
      uniform sampler2D uTarget;
      uniform float aspect, radius;
      uniform vec2 point;
      void main () {
        vec2 p = vUv - point;
        p.x *= aspect;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base * (1.0 - 0.96 * exp(-dot(p, p) / radius)), 1.0);
      }`,
    advection: head + `
      uniform sampler2D uVelocity, uSource;
      uniform vec2 texelSize, dyeTexelSize;
      uniform float dt, dissipation;
      #ifdef MANUAL_FILTERING
      vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;
        vec2 iuv = floor(st);
        vec2 fuv = fract(st);
        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
      }
      #endif
      void main () {
      #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
      #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
      #endif
        gl_FragColor = result / (1.0 + dissipation * dt);
      }`,
    // MacCormack correction for the dye: advect forward, advect that back,
    // and add back half the round-trip error. Plain semi-Lagrangian
    // advection blurs the ink a little every frame, which a drifting basin
    // turns into grey wash within half a minute. The result is clamped to the
    // four source texels it came from, so the correction cannot overshoot.
    maccormack: head + `
      uniform sampler2D uVelocity, uSource, uForward, uBackward;
      uniform vec2 texelSize, dyeTexelSize;
      uniform float dt;
      void main () {
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec2 st = coord / dyeTexelSize - 0.5;
        vec2 base = (floor(st) + 0.5) * dyeTexelSize;
        vec4 a = texture2D(uSource, base);
        vec4 b = texture2D(uSource, base + vec2(dyeTexelSize.x, 0.0));
        vec4 c = texture2D(uSource, base + vec2(0.0, dyeTexelSize.y));
        vec4 d = texture2D(uSource, base + dyeTexelSize);
        vec4 lo = min(min(a, b), min(c, d));
        vec4 hi = max(max(a, b), max(c, d));
        vec4 fwd = texture2D(uForward, vUv);
        vec4 corrected = fwd + 0.5 * (texture2D(uSource, vUv) - texture2D(uBackward, vUv));
        gl_FragColor = clamp(corrected, lo, hi);
      }`,
    divergence: head + `
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;
        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }
        gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
      }`,
    curl: head + `
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
      }`,
    vorticity: head + `
      uniform sampler2D uVelocity, uCurl;
      uniform float curl, dt;
      void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;
        vec2 v = texture2D(uVelocity, vUv).xy + force * dt;
        gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
      }`,
    pressure: head + `
      uniform sampler2D uPressure, uDivergence;
      void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float d = texture2D(uDivergence, vUv).x;
        gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
      }`,
    // A slow, divergence-free current from a drifting stream function:
    // velocity = (dpsi/dy, -dpsi/dx), so it stirs without piling water up.
    current: head + `
      uniform sampler2D uVelocity;
      uniform float aspect, t, strength;
      void main () {
        vec2 p = vec2(vUv.x * aspect, vUv.y) * 2.4;
        float a = p.x + t * 0.21;
        float b = p.y * 1.3 - t * 0.17;
        float c = (p.x * 0.7 - p.y * 0.9) * 1.7 + t * 0.13;
        float dx = cos(a) * cos(b) + 0.6 * 1.7 * 0.7 * cos(c);
        float dy = -1.3 * sin(a) * sin(b) - 0.6 * 1.7 * 0.9 * cos(c);
        vec2 v = texture2D(uVelocity, vUv).xy + strength * vec2(dy, -dx);
        gl_FragColor = vec4(v, 0.0, 1.0);
      }`,
    gradient: head + `
      uniform sampler2D uPressure, uVelocity;
      void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 v = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
        gl_FragColor = vec4(v, 0.0, 1.0);
      }`,
    scale: head + `
      uniform sampler2D uTexture;
      uniform float value;
      void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`,
    // Ink on white water, with a faint paper grain.
    display: head + `
      uniform sampler2D uTexture;
      uniform vec3 paper;
      uniform vec2 res;
      float hash (vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main () {
        vec3 a = max(texture2D(uTexture, vUv).rgb, 0.0);
        // Advection blurs the ink a little every frame. A contrast curve on
        // its density keeps edges crisp: faint washes clear to water, bands
        // stay full strength, as ink does on a real size bath.
        float d = dot(a, vec3(0.3333));
        a *= smoothstep(0.12, 0.62, d) * 1.25 / max(d, 0.001) * min(d, 1.6);
        vec3 c = paper * exp(-a);
        c -= (hash(floor(vUv * res)) - 0.5) * 0.014;
        gl_FragColor = vec4(c, 1.0);
      }`,
  };

  const programs = {};
  for (const [name, src] of Object.entries(sources)) {
    const defines = name === "advection" && !ext.linear ? "#define MANUAL_FILTERING\n" : "";
    programs[name] = makeProgram(vertexSrc, defines + src);
  }
  if (Object.values(programs).some((p) => !p)) {
    paintStatic(canvas);
    return;
  }

  // ── Geometry and targets ──────────────────────────────────────────────
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  let dye, dyeForward, dyeBackward, velocity, divergence, curlTarget, pressure;

  function blit(target) {
    if (target) {
      gl.viewport(0, 0, target.w, target.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  function use(name, target, uniforms) {
    const p = programs[name];
    gl.useProgram(p.program);
    let unit = 0;
    for (const [key, value] of Object.entries(uniforms)) {
      const loc = p.uniforms[key];
      if (loc === undefined) continue;
      if (value && value.attach) {
        gl.uniform1i(loc, value.attach(unit++));
      } else if (typeof value === "number") {
        gl.uniform1f(loc, value);
      } else if (value.length === 2) {
        gl.uniform2f(loc, value[0], value[1]);
      } else if (value.length === 3) {
        gl.uniform3f(loc, value[0], value[1], value[2]);
      } else {
        gl.uniform4fv(loc, value);
      }
    }
    blit(target);
  }

  function resolution(res) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const min = Math.round(res);
    const max = Math.round(res * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { w: max, h: min } : { w: min, h: max };
  }

  function initTargets() {
    const simRes = resolution(config.simRes);
    const dyeRes = resolution(config.dyeRes);
    const filter = ext.linear ? gl.LINEAR : gl.NEAREST;
    dye = doubleFbo(dyeRes.w, dyeRes.h, ext.rgba, filter);
    dyeForward = fbo(dyeRes.w, dyeRes.h, ext.rgba, filter);
    dyeBackward = fbo(dyeRes.w, dyeRes.h, ext.rgba, filter);
    velocity = doubleFbo(simRes.w, simRes.h, ext.rg, filter);
    divergence = fbo(simRes.w, simRes.h, ext.r, gl.NEAREST);
    curlTarget = fbo(simRes.w, simRes.h, ext.r, gl.NEAREST);
    pressure = doubleFbo(simRes.w, simRes.h, ext.r, gl.NEAREST);
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  // ── The opening pattern ───────────────────────────────────────────────
  const aspect = () => canvas.width / canvas.height;

  function layEyes() {
    const wide = canvas.width > canvas.height;
    // The main eye sits right of the washi sheet on wide screens, above it on tall ones.
    const eyes = wide
      ? [0.71, 0.46, 0.36, 24, 0.99, 0.06, 0.24, 12, 0.03, 0.04, 0.2, 10]
      : [0.5, 0.88, 0.22, 16, 0.02, 0.62, 0.16, 10, 0.98, 0.3, 0.16, 10];
    use("rings", dye.write, { aspect: aspect(), eyes, sumi: INK.sumi, indigo: INK.indigo, rose: INK.rose });
    dye.swap();
  }

  // ── Simulation step ───────────────────────────────────────────────────
  function step(dt, now) {
    const sim = { texelSize: velocity.texel };
    if (config.current > 0) {
      // Scaled by the velocity's decay so the current settles at config.current.
      use("current", velocity.write, {
        ...sim, uVelocity: velocity.read, aspect: aspect(), t: now / 1000,
        strength: config.current * config.velocityDissipation * dt,
      });
      velocity.swap();
    }
    use("curl", curlTarget, { ...sim, uVelocity: velocity.read });
    use("vorticity", velocity.write, { ...sim, uVelocity: velocity.read, uCurl: curlTarget, curl: config.curl, dt });
    velocity.swap();
    use("divergence", divergence, { ...sim, uVelocity: velocity.read });
    use("scale", pressure.write, { ...sim, uTexture: pressure.read, value: config.pressure });
    pressure.swap();
    for (let i = 0; i < config.pressureIterations; i++) {
      use("pressure", pressure.write, { ...sim, uPressure: pressure.read, uDivergence: divergence });
      pressure.swap();
    }
    use("gradient", velocity.write, { ...sim, uPressure: pressure.read, uVelocity: velocity.read });
    velocity.swap();
    use("advection", velocity.write, {
      ...sim, dyeTexelSize: velocity.texel, uVelocity: velocity.read, uSource: velocity.read,
      dt, dissipation: config.velocityDissipation,
    });
    velocity.swap();
    const dyeSim = { ...sim, dyeTexelSize: dye.texel, uVelocity: velocity.read, dissipation: 0 };
    use("advection", dyeForward, { ...dyeSim, uSource: dye.read, dt });
    use("advection", dyeBackward, { ...dyeSim, uSource: dyeForward, dt: -dt });
    use("maccormack", dye.write, { ...dyeSim, uSource: dye.read, uForward: dyeForward, uBackward: dyeBackward, dt });
    dye.swap();
  }

  function render() {
    use("display", null, { texelSize: [1 / canvas.width, 1 / canvas.height], uTexture: dye.read, paper: PAPER, res: [canvas.width, canvas.height] });
  }

  function splatVelocity(x, y, dx, dy, radius = config.splatRadius) {
    use("splat", velocity.write, {
      texelSize: velocity.texel, uTarget: velocity.read, aspect: aspect(),
      point: [x, y], color: [dx, dy, 0], radius,
    });
    velocity.swap();
  }

  // A drop: clear water or ink lands and spreads the rings outward.
  function drop(x, y, ink) {
    const a = aspect();
    use("radial", velocity.write, { texelSize: velocity.texel, uTarget: velocity.read, aspect: a, point: [x, y], radius: 0.0018, force: 95 });
    velocity.swap();
    if (ink) {
      use("splat", dye.write, { texelSize: dye.texel, uTarget: dye.read, aspect: a, point: [x, y], color: ink.map((c) => c * 1.1), radius: 0.00035 });
    } else {
      use("clearDrop", dye.write, { texelSize: dye.texel, uTarget: dye.read, aspect: a, point: [x, y], radius: 0.0005 });
    }
    dye.swap();
    wake();
  }

  // ── Loop ──────────────────────────────────────────────────────────────
  let running = false;
  let visible = true;
  let lastTime = 0;
  let settleUntil = 0;
  let lastInput = performance.now();
  let lastPrint = 0;
  const scripted = []; // queued strokes and drops: {at, run}
  let onSettle = null;

  function wake(ms = 3200) {
    settleUntil = Math.max(settleUntil, performance.now() + ms);
    if (ms > 0) lastInput = performance.now();
    if (!running && visible && !document.hidden) {
      running = true;
      lastTime = performance.now();
      requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    if (!visible || document.hidden) {
      running = false;
      return;
    }
    const busy = now < settleUntil || scripted.length > 0;
    // Drifting on its own, 30 fps is plenty and halves the GPU work.
    if (!busy && now - lastTime < 1000 / 31) {
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min((now - lastTime) / 1000, 1 / 20);
    lastTime = now;
    if (resizeCanvas()) {
      // Keep the ink: the targets are re-made and the pattern re-laid only on a real resize.
      initTargets();
      layEyes();
    }
    for (let i = scripted.length - 1; i >= 0; i--) {
      if (scripted[i].at <= now) {
        scripted[i].run();
        scripted.splice(i, 1);
      }
    }
    applyPointer();
    streamInk(now, dt);
    step(dt, now);
    render();
    if (now - lastContrast > 300) {
      lastContrast = now;
      updateNavContrast();
    }
    // Reprint the sheets once the visitor has let the water be for a moment.
    if (!busy && onSettle && lastInput > lastPrint && now - lastInput > 1500) {
      lastPrint = now;
      onSettle();
    }
    if (busy || config.current > 0) {
      requestAnimationFrame(frame);
    } else {
      running = false;
      if (onSettle && lastInput > lastPrint) {
        lastPrint = now;
        onSettle();
      }
    }
  }

  // ── Nav text over the ink ─────────────────────────────────────────────
  // The nav floats on the water, so ink drifting under a link would hide it.
  // Read the pixels under each label; when enough of them are inked, the
  // label gets a paper backing (CSS .on-ink). It counts dark pixels rather
  // than averaging, since one dark streak through a word is enough to hide
  // it. Two thresholds keep a label from flickering at the edge.
  const navLabels = Array.from(document.querySelectorAll(".nav .nav-mark, .nav .nav-links a"));
  const nav = document.getElementById("nav");
  let lastContrast = 0;
  let readBuf = new Uint8Array(0);

  /** Share of the canvas pixels under `rect` that carry visible ink. */
  function inkCover(rect) {
    const c = canvas.getBoundingClientRect();
    const sx = canvas.width / c.width;
    const sy = canvas.height / c.height;
    const x = Math.max(0, Math.round((rect.left - c.left) * sx));
    const w = Math.min(canvas.width - x, Math.round(rect.width * sx));
    const top = Math.round((rect.top - c.top) * sy);
    const h = Math.min(canvas.height, Math.round(rect.height * sy));
    const y = canvas.height - top - h;
    if (w <= 0 || h <= 0 || y < 0) return null;
    if (readBuf.length < w * h * 4) readBuf = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, readBuf);
    let inked = 0;
    const n = w * h;
    for (let i = 0; i < n * 4; i += 4) {
      if (0.2126 * readBuf[i] + 0.7152 * readBuf[i + 1] + 0.0722 * readBuf[i + 2] < 0.78 * 255) inked++;
    }
    return inked / n;
  }

  function updateNavContrast() {
    if (!nav || nav.classList.contains("is-solid")) {
      navLabels.forEach((el) => el.classList.remove("on-ink"));
      return;
    }
    for (const el of navLabels) {
      const cover = inkCover(el.getBoundingClientRect());
      if (cover == null) continue;
      const on = el.classList.contains("on-ink");
      if (!on && cover > 0.05) el.classList.add("on-ink");
      else if (on && cover < 0.015) el.classList.remove("on-ink");
    }
  }

  // ── Pointer ───────────────────────────────────────────────────────────
  const pointer = { x: 0, y: 0, dx: 0, dy: 0, moved: false, down: false, downAt: 0, streamed: false };

  // Holding the button streams ink from the pointer, as from a loaded brush
  // held to the water. The ink switches between indigo and sumi every so
  // often, so a held stream lays down bands like a real marbler's drops.
  // A quick click still drops a set of rings (below).
  const HOLD_MS = 180;
  function streamInk(now, dt) {
    if (!pointer.down || now - pointer.downAt < HOLD_MS) return;
    pointer.streamed = true;
    const a = aspect();
    const ink = Math.floor((now - pointer.downAt) / 700) % 2 ? INK.sumi : INK.indigo;
    use("splat", dye.write, {
      texelSize: dye.texel, uTarget: dye.read, aspect: a, point: [pointer.x, pointer.y],
      color: ink.map((c) => c * 5 * dt), radius: 0.00028,
    });
    dye.swap();
    // A gentle outward push, so the stream spreads into the water.
    use("radial", velocity.write, {
      texelSize: velocity.texel, uTarget: velocity.read, aspect: a, point: [pointer.x, pointer.y],
      radius: 0.0012, force: 32 * dt,
    });
    velocity.swap();
    wake(1500);
  }

  function toUv(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  }

  function applyPointer() {
    if (!pointer.moved) return;
    pointer.moved = false;
    const force = pointer.down ? config.splatForce : config.splatForce * 0.6;
    splatVelocity(pointer.x, pointer.y, pointer.dx * force, pointer.dy * force);
  }

  const surface = canvas.closest("[data-basin]") || canvas;
  let lastMove = null;
  surface.addEventListener("pointermove", (e) => {
    if (e.target.closest("a, button, [data-no-ink]")) { lastMove = null; return; }
    const [x, y] = toUv(e);
    if (lastMove) {
      pointer.dx = (x - lastMove[0]) * aspect();
      pointer.dy = y - lastMove[1];
      pointer.x = x;
      pointer.y = y;
      pointer.moved = Math.abs(pointer.dx) + Math.abs(pointer.dy) > 0;
      if (pointer.moved) wake();
    }
    lastMove = [x, y];
  }, { passive: true });
  surface.addEventListener("pointerleave", () => { lastMove = null; pointer.down = false; });
  surface.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("a, button, [data-no-ink]")) return;
    [pointer.x, pointer.y] = toUv(e);
    pointer.down = true;
    pointer.downAt = performance.now();
    pointer.streamed = false;
    wake();
  });
  window.addEventListener("pointerup", () => { pointer.down = false; });
  window.addEventListener("pointercancel", () => { pointer.down = false; });

  // A click drops ink: alternating ink and clear water make new rings.
  let dropCount = 0;
  surface.addEventListener("click", (e) => {
    if (e.target.closest("a, button, [data-no-ink]")) return;
    // A held press already streamed its ink.
    if (pointer.streamed) return;
    const [x, y] = toUv(e);
    const t = performance.now();
    const ink = dropCount++ % 2 ? INK.sumi : INK.indigo;
    for (let i = 0; i < 4; i++) {
      scripted.push({ at: t + i * 170, run: () => drop(x, y, i % 2 ? null : ink) });
    }
    wake(4200);
  });

  // ── The opening fan pass ──────────────────────────────────────────────
  // Strokes through the rings, as a marbler draws a feather.
  function fanPass() {
    const t0 = performance.now() + 500;
    const wide = canvas.width > canvas.height;
    const cx = wide ? 0.71 : 0.5;
    const cy = wide ? 0.5 : 0.88;
    const span = wide ? 0.034 : 0.03;
    const reach = wide ? 0.3 : 0.1;
    const steps = 36;
    // One slow stroke up through the eye draws the rings into a feather;
    // two lighter tines beside it, drawn down, give it barbs.
    const strokes = [[0, 1, 26, 0.00045], [-span * 2.2, -1, 10, 0.00018], [span * 2.2, -1, 10, 0.00018]];
    strokes.forEach(([off, dir, force, radius], s) => {
      for (let i = 0; i < steps; i++) {
        const f = i / (steps - 1);
        const y = cy + dir * (f * 2 - 1) * reach;
        scripted.push({ at: t0 + s * 420 + i * 34, run: () => splatVelocity(cx + off, y, 0, dir * force, radius) });
      }
    });
    wake(4200);
  }

  // ── Visibility ────────────────────────────────────────────────────────
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible && (config.current > 0 || scripted.length || performance.now() < settleUntil)) wake(0);
  }).observe(canvas);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(0); });
  window.addEventListener("resize", () => wake(200), { passive: true });

  // ── Start ─────────────────────────────────────────────────────────────
  resizeCanvas();
  initTargets();
  layEyes();
  render();
  canvas.classList.add("is-live");
  if (!reduceMotion) fanPass();

  // Hand the finished pattern to the page, which prints it onto its sheets.
  let printTimer = 0;
  onSettle = () => {
    clearTimeout(printTimer);
    printTimer = setTimeout(() => {
      render();
      canvas.toBlob((blob) => {
        if (blob) document.dispatchEvent(new CustomEvent("basin:print", { detail: URL.createObjectURL(blob) }));
      }, "image/webp", 0.86);
    }, 120);
  };
  if (reduceMotion) onSettle();

  // ── WebGL plumbing ────────────────────────────────────────────────────
  function getContext(c) {
    const params = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: true };
    let g = c.getContext("webgl2", params);
    const isGL2 = !!g;
    if (!g) g = c.getContext("webgl", params) || c.getContext("experimental-webgl", params);
    if (!g) return null;
    let halfFloat, linear;
    if (isGL2) {
      // Either extension makes half-float targets renderable; mobile GPUs
      // often have only the half-float one.
      g.getExtension("EXT_color_buffer_float");
      g.getExtension("EXT_color_buffer_half_float");
      // Half-float textures are always filterable in WebGL2.
      linear = true;
      halfFloat = g.HALF_FLOAT;
    } else {
      const hf = g.getExtension("OES_texture_half_float");
      if (!hf) return null;
      linear = !!g.getExtension("OES_texture_half_float_linear");
      halfFloat = hf.HALF_FLOAT_OES;
    }
    // Can a half-float texture of this format be drawn into here?
    const renders = (f) => {
      const tex = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, tex);
      g.texImage2D(g.TEXTURE_2D, 0, f.internal, 4, 4, 0, f.format, halfFloat, null);
      const fb = g.createFramebuffer();
      g.bindFramebuffer(g.FRAMEBUFFER, fb);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
      const ok = g.checkFramebufferStatus(g.FRAMEBUFFER) === g.FRAMEBUFFER_COMPLETE;
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      g.deleteFramebuffer(fb);
      g.deleteTexture(tex);
      return ok;
    };
    const fmt = (internal, format) => ({ internal, format });
    const rgba = isGL2 ? fmt(g.RGBA16F, g.RGBA) : fmt(g.RGBA, g.RGBA);
    if (!renders(rgba)) return null;
    // One- and two-channel targets save memory; fall back to RGBA where a
    // device cannot render into them.
    const rg = isGL2 && renders(fmt(g.RG16F, g.RG)) ? fmt(g.RG16F, g.RG) : rgba;
    const r = isGL2 && renders(fmt(g.R16F, g.RED)) ? fmt(g.R16F, g.RED) : rgba;
    g.ext = { halfFloat, linear, rgba, rg, r };
    return g;
  }

  function makeProgram(vs, fs) {
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn(gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const program = gl.createProgram();
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, "");
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  function fbo(w, h, format, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, format.internal, w, h, 0, format.format, ext.halfFloat, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      fbo: framebuffer, w, h, texel: [1 / w, 1 / h],
      attach(unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return unit;
      },
    };
  }

  function doubleFbo(w, h, format, filter) {
    let a = fbo(w, h, format, filter);
    let b = fbo(w, h, format, filter);
    return {
      get read() { return a; },
      get write() { return b; },
      get texel() { return a.texel; },
      swap() { const t = a; a = b; b = t; },
    };
  }

  // Without WebGL: the same rings, drawn once on a 2D canvas.
  function paintStatic(c) {
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = (c.width = Math.round(c.clientWidth / 2) || 720);
    const h = (c.height = Math.round(c.clientHeight / 2) || 450);
    ctx.fillStyle = "#fdfcfa";
    ctx.fillRect(0, 0, w, h);
    const wide = w > h;
    const cx = (wide ? 0.7 : 0.5) * w;
    const cy = (1 - (wide ? 0.52 : 0.74)) * h;
    const R = (wide ? 0.36 : 0.42) * h;
    for (let i = 15; i >= 1; i--) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, (R * i) / 15, (R * i) / 15 / 0.78, 0, 0, Math.PI * 2);
      ctx.lineWidth = (R / 15) * 0.42;
      ctx.strokeStyle = i % 2 ? "rgba(31,36,51,0.7)" : "rgba(44,58,120,0.7)";
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(cx, cy, R / 20, R / 20 / 0.78, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#c43d6b";
    ctx.fill();
    c.classList.add("is-static");
    document.dispatchEvent(new CustomEvent("basin:print", { detail: c.toDataURL("image/png") }));
  }
})();
