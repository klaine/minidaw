/* Layers dock tab: mode and count, one strip per layer, the key-split
 * keyboard and layer copy.  Built on first open (layout.js dock).
 *
 * Strips are pinned to their layer (Store.bind { layer: n }), so they show all
 * four at once whatever the edit layer is.  Key ranges only act in Split mode
 * (docs/04); the keyboard still shows and edits them otherwise, dimmed.
 * Copy writes every layer parameter of the source layer to the target, as the
 * device's Layer Tools copy does.
 */
import { choice, control, knob, toggle } from "./controls.js";
import { noteName } from "./format.js";
import { lazyStyles } from "./lazy.js";

lazyStyles();

const MODE_HELP = {
  Stack: "Every enabled layer plays every note.",
  RoundRb: "Notes rotate through the enabled layers in turn.",
  RandRR: "Each note picks a random enabled layer.",
  Split: "Each layer plays only inside its key range — drag the bars below.",
  Chan: "Each layer listens on its own MIDI channel (Chan).",
};
const KEYS = 128;
const SVG = "http://www.w3.org/2000/svg";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function countPicker(store) {
  const wrap = el("div", "choice");
  wrap.appendChild(el("div", "choice-label", "Layers"));
  const seg = el("div", "seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Layer count");
  const buttons = [1, 2, 3, 4].map((n) => {
    const b = el("button", "seg-btn", String(n));
    b.type = "button";
    b.setAttribute("role", "radio");
    b.onclick = () => store.set("layer_count", String(n));
    seg.appendChild(b);
    return b;
  });
  wrap.appendChild(seg);
  store.bind("layer_count", (v) => {
    const n = Math.round(Number(v) || 1);
    buttons.forEach((b, i) => { b.classList.toggle("on", i + 1 === n); b.setAttribute("aria-checked", String(i + 1 === n)); });
  });
  return wrap;
}

function strip(store, n) {
  const s = el("div", "layer-col");
  s.style.setProperty("--c", "var(--l" + n + ")");
  const head = el("div", "layer-col-head");
  const title = el("button", "layer-col-title", "Layer " + n);
  title.type = "button";
  title.title = "Edit layer " + n;
  title.onclick = () => store.set("edit_layer", String(n));
  const copy = el("select", "select layer-copy");
  copy.setAttribute("aria-label", "Copy layer " + n + " to");
  copy.appendChild(Object.assign(el("option", "", "Copy to…"), { value: "" }));
  for (let m = 1; m <= 4; m++) if (m !== n) copy.appendChild(Object.assign(el("option", "", "L" + m), { value: String(m) }));
  copy.onchange = () => {
    const to = Number(copy.value);
    copy.value = "";
    if (!to) return;
    store.history?.bulk("Copy L" + n + " to L" + to);
    const values = {};
    for (const key of store.meta.layerKeys) values["l" + to + "_" + key] = store.get("l" + n + "_" + key);
    store.apply(values);
  };
  head.append(title, copy);
  const o = { layer: n };
  const row = (...items) => { const r = el("div", "ctl-row"); r.append(...items); return r; };
  s.append(
    head,
    row(toggle(store, "on", Object.assign({ label: "On" }, o)), knob(store, "vol", Object.assign({ label: "Level" }, o)),
      knob(store, "pan", Object.assign({ label: "Pan" }, o))),
    row(choice(store, "route", Object.assign({ label: "Route" }, o)), knob(store, "send", Object.assign({ label: "Send" }, o))),
    row(choice(store, "poly", Object.assign({ label: "Voice" }, o)), control(store, "octave", o), control(store, "midi_ch", o)),
  );
  const paint = () => {
    const count = Math.round(store.num("layer_count", 1));
    s.classList.toggle("unused", n > count);
    s.classList.toggle("muted", store.num("l" + n + "_on") < 0.5);
    s.classList.toggle("focused", store.layer === n);
  };
  for (const k of ["layer_count", "l" + n + "_on", "edit_layer"]) store.bind(k, paint);
  return s;
}

/** 128-key keyboard with one draggable range bar per layer. */
function keySplit(store) {
  const wrap = el("div", "keysplit");
  // The view box tracks the real width so labels are never stretched.
  const box = svg("svg", { class: "keysplit-svg", viewBox: "0 0 1280 150",
    role: "group", "aria-label": "Key ranges" });
  let keyW = 1280 / KEYS;
  const black = (k) => [1, 3, 6, 8, 10].includes(k % 12);
  const keys = svg("g");
  box.appendChild(keys);
  const drawKeys = (width) => {
    keyW = width / KEYS;
    box.setAttribute("viewBox", `0 0 ${width} 150`);
    keys.textContent = "";
    for (let k = 0; k < KEYS; k++) {
      keys.appendChild(svg("rect", { x: k * keyW, y: 104, width: keyW, height: black(k) ? 28 : 46,
        class: black(k) ? "kb-black" : "kb-white" }));
      if (k % 12 === 0) {
        const t = svg("text", { x: k * keyW + 2, y: 146, class: "kb-label" });
        t.textContent = "C" + (k / 12 - 1);
        keys.appendChild(t);
      }
    }
  };
  drawKeys(1280);
  const bars = [];
  for (let n = 1; n <= 4; n++) {
    const y = 6 + (n - 1) * 24;
    const g = svg("g", { class: "ks-layer", style: "--c: var(--l" + n + ")" });
    const bar = svg("rect", { y, height: 18, rx: 4, class: "ks-bar" });
    const lo = svg("rect", { y: y - 2, width: 10, height: 22, rx: 3, class: "ks-handle", tabindex: "0", role: "slider",
      "aria-label": "Layer " + n + " lowest key" });
    const hi = svg("rect", { y: y - 2, width: 10, height: 22, rx: 3, class: "ks-handle", tabindex: "0", role: "slider",
      "aria-label": "Layer " + n + " highest key" });
    const label = svg("text", { y: y + 13, class: "ks-text" });
    g.append(bar, label, lo, hi);
    box.appendChild(g);
    bars.push({ n, g, bar, lo, hi, label });
  }
  const caption = el("div", "wave-caption");
  const hint = el("span", "wave-pos");
  caption.appendChild(hint);
  wrap.append(box, caption);

  const keyOf = (bare, n) => Math.round(store.num("l" + n + "_" + bare, bare === "key_hi" ? 127 : 0));
  const paint = () => {
    const split = Math.round(store.num("layer_mode")) === 3;
    const count = Math.round(store.num("layer_count", 1));
    wrap.classList.toggle("inactive", !split);
    hint.textContent = split ? "Drag bar ends to set each layer's range; arrow keys on a handle move it a semitone."
      : "Key ranges only apply in Split mode.";
    for (const b of bars) {
      const a = keyOf("key_lo", b.n), z = keyOf("key_hi", b.n);
      const x0 = Math.min(a, z) * keyW, x1 = (Math.max(a, z) + 1) * keyW;
      b.bar.setAttribute("x", x0);
      b.bar.setAttribute("width", Math.max(keyW, x1 - x0));
      b.lo.setAttribute("x", x0 - 5);
      b.hi.setAttribute("x", x1 - 5);
      b.lo.setAttribute("aria-valuetext", noteName(a));
      b.hi.setAttribute("aria-valuetext", noteName(z));
      b.label.setAttribute("x", x0 + 12);
      b.label.textContent = "L" + b.n + "  " + noteName(a) + "–" + noteName(z);
      b.g.classList.toggle("unused", b.n > count);
    }
  };
  for (let n = 1; n <= 4; n++) for (const k of ["key_lo", "key_hi"]) store.bind(k, paint, { layer: n });
  store.bind("layer_mode", paint);
  store.bind("layer_count", paint);

  const set = (n, bare, key) => {
    const other = keyOf(bare === "key_lo" ? "key_hi" : "key_lo", n);
    const v = bare === "key_lo" ? Math.min(key, other) : Math.max(key, other);
    store.set("l" + n + "_" + bare, String(Math.max(0, Math.min(127, v))));
    paint();
  };
  for (const b of bars) {
    for (const [handle, bare] of [[b.lo, "key_lo"], [b.hi, "key_hi"]]) {
      let dragging = false;
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        dragging = true;
      });
      handle.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const r = box.getBoundingClientRect();
        set(b.n, bare, Math.floor(((e.clientX - r.left) / r.width) * KEYS));
      });
      handle.addEventListener("pointerup", () => { dragging = false; });
      handle.addEventListener("pointercancel", () => { dragging = false; });
      handle.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 12 : 1;
        const v = keyOf(bare, b.n);
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(b.n, bare, v - step);
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") set(b.n, bare, v + step);
        else return;
        e.preventDefault();
      });
    }
  }
  new ResizeObserver((entries) => {
    const width = Math.round(entries[0].contentRect.width);
    if (width > 0 && Math.abs(width - keyW * KEYS) > 1) { drawKeys(width); paint(); }
  }).observe(box);
  paint();
  return wrap;
}

export function layersTab(store) {
  const wrap = el("div", "layers-tab");
  const top = el("div", "ctl-row");
  const help = el("p", "mode-help");
  top.append(choice(store, "layer_mode", { label: "Mode", segmentMax: 5 }), countPicker(store), help);
  store.bind("layer_mode", (v) => {
    const name = store.metaFor("layer_mode").options[Math.round(Number(v) || 0)];
    help.textContent = MODE_HELP[name] || "";
  });
  const strips = el("div", "layer-cols");
  for (let n = 1; n <= 4; n++) strips.appendChild(strip(store, n));
  wrap.append(top, strips, keySplit(store));
  return wrap;
}
