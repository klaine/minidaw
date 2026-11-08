/* Panel controls bound to store keys: knob, fader, segmented buttons, select, LED switch, and a
 * bipolar depth slider. Every control drags (shift = fine), scrolls, steps with the arrow keys,
 * and resets to its default on double-click. One drag is one undo step. */
import { reading, norm, denorm } from "./format.js";

export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

const svg = (tag, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

/* Shared drag/scroll/keyboard behaviour on a 0..1 normalised value. */
function makeAdjustable(el, ui, key, { vertical = true, span = 220 } = {}) {
  const { store } = ui;
  const p = store.p(key);
  const steps = p.t === "enum" ? p.o.length - 1 : p.t === "int" ? p.mx - p.mn : 0;
  const setNorm = (u) => store.set(key, denorm(p, Math.min(1, Math.max(0, u))));
  const nudge = (dir, fine, big) => {
    const cur = norm(p, store.get(key));
    if (steps && !fine && !big && steps <= 200) setNorm(cur + dir / steps);
    else setNorm(cur + dir * (big ? 0.1 : fine ? 0.002 : 0.01));
  };
  let start = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    store.beginGesture();
    start = { x: e.clientX, y: e.clientY, u: norm(p, store.get(key)) };
    ui.touch(key);
    el.classList.add("active");
  });
  el.addEventListener("pointermove", (e) => {
    if (!start) return;
    const d = vertical ? start.y - e.clientY : e.clientX - start.x;
    const s = e.shiftKey ? span * 6 : span;
    setNorm(start.u + d / s);
    if (e.shiftKey) { start = { x: e.clientX, y: e.clientY, u: norm(p, store.get(key)) }; } // fine mode re-anchors
  });
  const end = () => {
    if (!start) return;
    start = null;
    store.endGesture();
    el.classList.remove("active");
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    ui.touch(key);
    nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey, false);
  }, { passive: false });
  el.addEventListener("dblclick", () => store.set(key, p.d));
  el.addEventListener("keydown", (e) => {
    const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
    if (e.key in map) {
      e.preventDefault();
      const d = map[e.key];
      nudge(Math.sign(d), e.shiftKey, Math.abs(d) > 1);
      ui.touch(key);
    } else if (e.key === "Home") { e.preventDefault(); setNorm(0); }
    else if (e.key === "End") { e.preventDefault(); setNorm(1); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); store.set(key, p.d); }
  });
  el.addEventListener("focus", () => ui.touch(key));
  el.addEventListener("pointerenter", () => ui.hover(key));
  el.addEventListener("pointerleave", () => ui.hover(null));
}

function aria(el, p, v) {
  el.setAttribute("aria-valuenow", String(v));
  el.setAttribute("aria-valuetext", reading(p, v));
}

const ARC_SWEEP = 270; // knob track: 7 o'clock to 5 o'clock

function arcPath(cx, cy, r, a0, a1) {
  const pt = (a) => [cx + r * Math.sin(a * Math.PI / 180), cy - r * Math.cos(a * Math.PI / 180)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} ${a1 > a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** A rotary knob. opts: { label, size: "s"|"m"|"l", accent } */
export function knob(ui, key, opts = {}) {
  const p = ui.store.p(key);
  const bip = p.t !== "enum" && p.mn < 0;
  const size = opts.size || "m";
  const s = svg("svg", { viewBox: "0 0 48 48", "aria-hidden": "true" });
  const track = svg("path", { class: "k-track", d: arcPath(24, 24, 19, -135, 135) });
  const arc = svg("path", { class: "k-arc" });
  const cap = svg("circle", { class: "k-cap", cx: 24, cy: 24, r: 14 });
  const ptr = svg("line", { class: "k-ptr", x1: 24, y1: 24, x2: 24, y2: 12 });
  s.append(track, arc, cap, ptr);
  const val = h("span", { class: "val" });
  const dial = h("div", {
    class: "dial", tabindex: 0, role: "slider", "aria-label": p.n,
    "aria-valuemin": p.t === "enum" ? 0 : p.mn, "aria-valuemax": p.t === "enum" ? p.o.length - 1 : p.mx,
  }, s);
  const el = h("div", { class: `knob k-${size}${opts.accent ? " accent" : ""}`, title: p.n }, dial,
    h("span", { class: "lbl" }, opts.label || p.s), val);
  makeAdjustable(dial, ui, key);
  ui.store.bind(key, (v) => {
    const u = Math.min(1, Math.max(0, norm(p, v)));
    const a = -135 + u * ARC_SWEEP;
    const a0 = bip ? 0 : -135;
    arc.setAttribute("d", Math.abs(a - a0) < 0.5 ? "" : arcPath(24, 24, 19, Math.min(a0, a), Math.max(a0, a)));
    ptr.setAttribute("transform", `rotate(${a} 24 24)`);
    val.textContent = reading(p, v);
    aria(dial, p, v);
  });
  return el;
}

/** A vertical fader (mixer levels, envelope stages). */
export function fader(ui, key, opts = {}) {
  const p = ui.store.p(key);
  const fill = h("i", { class: "f-fill" });
  const thumb = h("b", { class: "f-thumb" });
  const slot = h("div", {
    class: "f-slot", tabindex: 0, role: "slider", "aria-label": p.n, "aria-orientation": "vertical",
    "aria-valuemin": p.mn, "aria-valuemax": p.mx,
  }, fill, thumb);
  const val = h("span", { class: "val" });
  const el = h("div", { class: "fader", title: p.n }, val, slot, h("span", { class: "lbl" }, opts.label || p.s));
  makeAdjustable(slot, ui, key, { span: 140 });
  // a click on the track jumps there
  slot.addEventListener("pointerdown", (e) => {
    if (e.target !== slot && e.target !== fill) return;
    const r = slot.getBoundingClientRect();
    ui.store.set(key, denorm(p, 1 - (e.clientY - r.top) / r.height));
  }, true);
  ui.store.bind(key, (v) => {
    const u = Math.min(1, Math.max(0, norm(p, v)));
    fill.style.height = (u * 100).toFixed(2) + "%";
    thumb.style.bottom = `calc(${(u * 100).toFixed(2)}% - 5px)`;
    val.textContent = reading(p, v);
    aria(slot, p, v);
  });
  return el;
}

/** Buttons for a short enum. opts.labels / opts.icons (SVG path per option) override the text. */
export function segmented(ui, key, opts = {}) {
  const p = ui.store.p(key);
  const btns = p.o.map((name, i) => {
    const content = opts.icons && opts.icons[i]
      ? (() => { const s = svg("svg", { viewBox: "0 0 24 14", "aria-hidden": "true" }); s.append(svg("path", { d: opts.icons[i] })); return s; })()
      : (opts.labels ? opts.labels[i] : name);
    return h("button", {
      type: "button", class: "seg-b", title: name, "aria-label": `${p.n}: ${name}`,
      onclick: () => { ui.touch(key); ui.store.set(key, i); },
    }, content);
  });
  const el = h("div", { class: "seg" + (opts.vertical ? " vertical" : ""), role: "group", "aria-label": p.n }, btns);
  ui.store.bind(key, (v) => btns.forEach((b, i) => b.setAttribute("aria-pressed", String(i === Math.round(v)))));
  if (opts.label) return h("div", { class: "seg-wrap" }, h("span", { class: "lbl" }, opts.label), el);
  return el;
}

/** A dropdown for an enum (or an int with opts.names). */
export function select(ui, key, opts = {}) {
  const p = ui.store.p(key);
  const names = opts.names || p.o || Array.from({ length: p.mx - p.mn + 1 }, (_, i) => String(p.mn + i));
  const base = p.t === "enum" ? 0 : p.mn;
  const sel = h("select", {
    "aria-label": p.n, class: opts.class,
    onchange: () => { ui.touch(key); ui.store.set(key, Number(sel.value)); },
    onfocus: () => ui.touch(key),
  }, names.map((n, i) => h("option", { value: base + i }, n)));
  ui.store.bind(key, (v) => { sel.value = String(Math.round(v)); });
  if (opts.label === false) return sel;
  return h("label", { class: "sel" }, h("span", { class: "lbl" }, opts.label || p.s), sel);
}

/** An LED push button for a two-option enum (Off/On). */
export function led(ui, key, opts = {}) {
  const p = ui.store.p(key);
  const b = h("button", {
    type: "button", class: "led" + (opts.class ? " " + opts.class : ""), title: p.n,
    onclick: () => { ui.touch(key); ui.store.set(key, Math.round(ui.store.get(key)) ? 0 : 1); },
  }, h("i", { class: "lamp" }), h("span", {}, opts.label || p.s));
  ui.store.bind(key, (v) => b.setAttribute("aria-pressed", String(Math.round(v) === 1)));
  return b;
}

/** A horizontal bipolar slider (matrix and macro depths). */
export function depth(ui, key) {
  const p = ui.store.p(key);
  const fill = h("i", { class: "d-fill" });
  const bar = h("div", {
    class: "depth", tabindex: 0, role: "slider", "aria-label": p.n,
    "aria-valuemin": p.mn, "aria-valuemax": p.mx,
  }, h("i", { class: "d-mid" }), fill);
  const val = h("span", { class: "val" });
  makeAdjustable(bar, ui, key, { vertical: false, span: 260 });
  ui.store.bind(key, (v) => {
    const u = (v - p.mn) / (p.mx - p.mn);
    const l = Math.min(u, 0.5), r = Math.max(u, 0.5);
    fill.style.left = (l * 100).toFixed(2) + "%";
    fill.style.width = ((r - l) * 100).toFixed(2) + "%";
    bar.classList.toggle("neg", v < 0);
    val.textContent = reading(p, v);
    aria(bar, p, v);
  });
  return h("div", { class: "depth-wrap" }, bar, val);
}
