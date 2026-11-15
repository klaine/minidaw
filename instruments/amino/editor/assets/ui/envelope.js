/* Draggable ADSR editor for the four envelopes (e1 Wave, e2 Filter, e3 Amp, e4 Aux).
 *
 * Each stage's width is proportional to its knob value, so the 0..20 s cubic
 * time curve gets the same resolution as the knob, and the curve inside each
 * stage follows env_step in voice.c.  Handles: the attack peak (time), the
 * decay corner (time and sustain), the sustain end (sustain) and the release
 * end (time).  Handles are focusable; arrow keys move them.
 */
import { formatSeconds, envSeconds } from "./format.js";
import { attackLevel, decayLevel, releaseLevel } from "./curves.js";
import { cssVar } from "./wavetable.js";
import { onLive } from "./live.js";

const SVG = "http://www.w3.org/2000/svg";
const SPAN = { a: 0.26, d: 0.26, hold: 0.14, r: 0.30 }; // share of the width
const STEPS = 28;

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

export function envelopeView(store, prefix, title) {
  const keys = { a: prefix + "_a", d: prefix + "_d", s: prefix + "_s", r: prefix + "_r" };
  const root = document.createElement("div");
  root.className = "env-view";
  const box = svg("svg", { class: "env-svg", role: "group", "aria-label": title + " envelope" });
  const grid = svg("g", { class: "env-grid" });
  const area = svg("path", { class: "env-area" });
  const line = svg("path", { class: "env-line" });
  const tip = svg("text", { class: "env-tip" });
  box.append(grid, area, line);
  root.appendChild(box);

  // Bindings call back immediately, so the scheduler must exist first.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  };
  const bindings = {};
  for (const k in keys) bindings[k] = store.bind(keys[k], () => schedule());
  store.bind("edit_layer", () => schedule());
  // Telemetry: the stage and level of the focused layer's newest voice.
  const index = { e1: 0, e2: 1, e3: 2, e4: 3 }[prefix];
  let live = null;
  onLive(store, (s) => { live = s.env ? s.env[index] : null; schedule(); });

  let size = { w: 300, h: 110 };
  const pad = { l: 8, r: 10, t: 12, b: 16 };
  const geo = () => {
    const W = size.w - pad.l - pad.r;
    const v = (k) => Math.min(1, Math.max(0, store.value(keys[k])));
    const a = v("a"), d = v("d"), s = v("s"), r = v("r");
    const top = pad.t, base = size.h - pad.b;
    const x0 = pad.l;
    const xA = x0 + Math.max(1, a * SPAN.a * W);
    const xD = xA + Math.max(1, d * SPAN.d * W);
    const xH = xD + SPAN.hold * W;
    const xR = xH + Math.max(1, r * SPAN.r * W);
    const yOf = (lv) => base - lv * (base - top);
    return { W, a, d, s, r, top, base, x0, xA, xD, xH, xR, yOf };
  };

  /* Handles: [key(s), how dragging maps to values, aria label] */
  const handles = [
    { id: "a", label: "Attack", x: (g) => g.xA, y: (g) => g.top },
    { id: "d", label: "Decay and sustain", x: (g) => g.xD, y: (g) => g.yOf(g.s) },
    { id: "s", label: "Sustain", x: (g) => g.xH, y: (g) => g.yOf(g.s) },
    { id: "r", label: "Release", x: (g) => g.xR, y: (g) => g.base },
  ].map((hd) => {
    const g = svg("g", { class: "env-handle", tabindex: "0", role: "slider", "aria-label": title + " " + hd.label });
    const hit = svg("circle", { class: "env-hit", r: 13 });
    const dot = svg("circle", { class: "env-dot", r: 4.5 });
    g.append(hit, dot);
    box.appendChild(g);
    return Object.assign(hd, { g, hit, dot });
  });
  box.appendChild(tip);

  const describe = (g) => {
    const t = stageSeconds();
    return {
      a: "Attack " + formatSeconds(t.a),
      d: "Decay " + formatSeconds(t.d) + " · Sustain " + Math.round(g.s * 100) + "%",
      s: "Sustain " + Math.round(g.s * 100) + "%",
      r: "Release " + formatSeconds(t.r),
    };
  };
  const stageSeconds = () => ({
    a: envSeconds(store.value(keys.a)), d: envSeconds(store.value(keys.d)), r: envSeconds(store.value(keys.r)),
  });

  let active = null;
  const draw = () => {
    const g = geo();
    const color = cssVar("--l" + store.layer);
    root.style.setProperty("--env", color);
    box.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`);
    grid.textContent = "";
    for (const lv of [0, 0.5, 1]) {
      const y = g.yOf(lv);
      grid.appendChild(svg("line", { x1: g.x0, x2: size.w - pad.r, y1: y, y2: y }));
    }
    for (const x of [g.xA, g.xD, g.xH]) grid.appendChild(svg("line", { x1: x, x2: x, y1: g.top, y2: g.base, class: "env-stage" }));
    if (live && live.stage > 0) {
      // Attack / Decay+Sustain / Release, as AminoEnvStage.
      const span = [[g.x0, g.xA], [g.xA, g.xH], [g.xH, g.xR]][live.stage - 1];
      grid.prepend(svg("rect", { class: "env-live", x: span[0], y: g.top, width: Math.max(2, span[1] - span[0]), height: g.base - g.top }));
      const y = g.yOf(Math.min(1, live.level));
      grid.appendChild(svg("line", { class: "env-live-level", x1: span[0], x2: span[1], y1: y, y2: y }));
    }

    const pts = [[g.x0, g.base]];
    for (let i = 1; i <= STEPS; i++) {
      const u = i / STEPS;
      pts.push([g.x0 + (g.xA - g.x0) * u, g.yOf(attackLevel(u))]);
    }
    for (let i = 1; i <= STEPS; i++) {
      const u = i / STEPS;
      pts.push([g.xA + (g.xD - g.xA) * u, g.yOf(decayLevel(u, g.s))]);
    }
    // Decay has not fully reached sustain at the corner (exp(-4.6) ~ 1 %);
    // the hold segment continues from the drawn level.
    const held = decayLevel(1, g.s);
    pts.push([g.xH, g.yOf(held)]);
    for (let i = 1; i <= STEPS; i++) {
      const u = i / STEPS;
      pts.push([g.xH + (g.xR - g.xH) * u, g.yOf(releaseLevel(u, held))]);
    }
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    line.setAttribute("d", d);
    area.setAttribute("d", d + ` L ${g.xR.toFixed(1)} ${g.base} L ${g.x0} ${g.base} Z`);

    const text = describe(g);
    for (const hd of handles) {
      const x = hd.x(g), y = hd.y(g);
      hd.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      hd.g.setAttribute("aria-valuetext", text[hd.id]);
    }
    if (active) {
      const hd = handles.find((h) => h.id === active);
      const x = hd.x(g), y = hd.y(g);
      tip.textContent = text[active];
      tip.setAttribute("y", Math.max(10, y - 9));
      const right = x > size.w * 0.6;
      tip.setAttribute("x", right ? x - 8 : x + 8);
      tip.setAttribute("text-anchor", right ? "end" : "start");
      tip.style.display = "";
    } else {
      tip.style.display = "none";
    }
  };

  // A binding is not called back for its own writes, so redraw here.
  const put = (k, v) => {
    bindings[k].set(Math.min(1, Math.max(0, v)).toFixed(4));
    schedule();
  };

  /* Dragging maps pixels back to knob values through the same geometry. */
  let drag = null;
  for (const hd of handles) {
    hd.g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      hd.g.focus({ preventScroll: true });
      hd.g.setPointerCapture(e.pointerId);
      const g = geo();
      drag = { id: hd.id, x: e.clientX, y: e.clientY, g, scale: box.getBoundingClientRect().width / size.w };
      active = hd.id;
      root.classList.add("active");
      schedule();
    });
    hd.g.addEventListener("pointermove", (e) => {
      if (!drag || drag.id !== hd.id) return;
      const g = drag.g;
      const fine = e.shiftKey ? 0.25 : 1;
      const dx = (e.clientX - drag.x) / drag.scale * fine;
      const dy = (e.clientY - drag.y) / drag.scale * fine;
      const height = g.base - g.top;
      if (hd.id === "a") put("a", g.a + dx / (SPAN.a * g.W));
      if (hd.id === "d") { put("d", g.d + dx / (SPAN.d * g.W)); put("s", g.s - dy / height); }
      if (hd.id === "s") put("s", g.s - dy / height);
      if (hd.id === "r") put("r", g.r + dx / (SPAN.r * g.W));
    });
    const end = () => { drag = null; active = null; root.classList.remove("active"); schedule(); };
    hd.g.addEventListener("pointerup", end);
    hd.g.addEventListener("pointercancel", end);
    hd.g.addEventListener("dblclick", () => {
      for (const k of hd.id === "d" ? ["d", "s"] : [hd.id]) put(k, store.metaFor(keys[k]).default);
    });
    hd.g.addEventListener("focus", () => { active = hd.id; schedule(); });
    hd.g.addEventListener("blur", () => { if (!drag) { active = null; schedule(); } });
    hd.g.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.002 : 0.02;
      const time = hd.id === "s" ? null : hd.id;
      const level = hd.id === "s" || hd.id === "d" ? "s" : null;
      let handled = true;
      if (e.key === "ArrowRight" && time) put(time, store.value(keys[time]) + step);
      else if (e.key === "ArrowLeft" && time) put(time, store.value(keys[time]) - step);
      else if (e.key === "ArrowUp" && level) put(level, store.value(keys.s) + step);
      else if (e.key === "ArrowDown" && level) put(level, store.value(keys.s) - step);
      else handled = false;
      if (handled) e.preventDefault();
    });
  }

  new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    if (r.width > 0) { size = { w: r.width, h: r.height }; schedule(); }
  }).observe(box);
  return root;
}
