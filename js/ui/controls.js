// Controls: knobs, faders, toggles, menus, sheets, prompts and toasts, all finger-sized.
import { h, clamp } from "../util.js";

/**
 * knob({ label, value (0..1), format(v) -> text, onInput(v), onChange(v), def, size, bipolar, color })
 * Drag up/down (or sideways) to turn, double tap to reset. Returns the element with .set(v).
 */
export function knob(o) {
  let v = o.value ?? 0;
  const size = o.size || 44;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 44 44");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  const track = document.createElementNS(svgNS, "path");
  track.setAttribute("class", "knob-track");
  const arc = document.createElementNS(svgNS, "path");
  arc.setAttribute("class", "knob-arc");
  if (o.color) arc.style.stroke = o.color;
  const dot = document.createElementNS(svgNS, "line");
  dot.setAttribute("class", "knob-dot");
  svg.append(track, arc, dot);
  const val = h("div", { class: "knob-val" });
  const el = h("div", { class: "knob" + (o.small ? " small" : ""), title: o.title || o.label || "" }, svg, o.label ? h("div", { class: "knob-label" }, o.label) : null, val);
  const A0 = -135, A1 = 135;
  const polar = (a, r = 17) => { const t = (a - 90) * Math.PI / 180; return [22 + r * Math.cos(t), 22 + r * Math.sin(t)]; };
  const arcPath = (a, b) => {
    const [x0, y0] = polar(a), [x1, y1] = polar(b);
    return `M${x0} ${y0} A17 17 0 ${b - a > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  track.setAttribute("d", arcPath(A0, A1));
  function paint() {
    const a = A0 + (A1 - A0) * v;
    const from = o.bipolar ? 0 : A0;
    arc.setAttribute("d", Math.abs(a - from) < 0.5 ? "" : a > from ? arcPath(from, a) : arcPath(a, from));
    const [x0, y0] = polar(a, 7), [x1, y1] = polar(a, 15);
    dot.setAttribute("x1", x0); dot.setAttribute("y1", y0); dot.setAttribute("x2", x1); dot.setAttribute("y2", y1);
    val.textContent = o.format ? o.format(v) : Math.round(v * 100) + "%";
  }
  paint();
  let start = null, lastTap = 0;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastTap < 300 && o.def !== undefined) { v = o.def; paint(); o.onInput && o.onInput(v); o.onChange && o.onChange(v); lastTap = 0; return; }
    lastTap = now;
    el.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY, v, fine: e.shiftKey };
    el.classList.add("active");
    o.onStart && o.onStart();
  });
  el.addEventListener("pointermove", (e) => {
    if (!start) return;
    const d = (start.y - e.clientY) + (e.clientX - start.x) * 0.5;
    const range = e.shiftKey ? 600 : 160;
    const nv = clamp(start.v + d / range, 0, 1);
    if (nv !== v) { v = o.step ? Math.round(nv / o.step) * o.step : nv; paint(); o.onInput && o.onInput(v); }
  });
  const end = () => { if (!start) return; start = null; el.classList.remove("active"); o.onChange && o.onChange(v); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.set = (nv) => { if (start) return; v = clamp(nv, 0, 1); paint(); };
  el.get = () => v;
  return el;
}

/** fader({ value 0..1, onInput, onChange, format, def, height }) – vertical, with a meter canvas beside it */
export function fader(o) {
  let v = o.value ?? 0.7;
  const thumb = h("div", { class: "fader-thumb" });
  const fill = h("div", { class: "fader-fill" });
  const slot = h("div", { class: "fader-slot" }, fill, thumb);
  const meter = h("canvas", { class: "fader-meter", width: 8, height: 100 });
  const label = h("div", { class: "fader-val" });
  const el = h("div", { class: "fader" }, h("div", { class: "fader-body" }, slot, meter), label);
  function paint() {
    thumb.style.bottom = `calc(${v * 100}% - ${v * 22}px)`;
    fill.style.height = v * 100 + "%";
    label.textContent = o.format ? o.format(v) : Math.round(v * 100);
  }
  paint();
  let start = null, lastTap = 0;
  slot.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastTap < 300 && o.def !== undefined) { v = o.def; paint(); o.onInput && o.onInput(v); o.onChange && o.onChange(v); lastTap = 0; return; }
    lastTap = now;
    slot.setPointerCapture(e.pointerId);
    start = { y: e.clientY, v, hgt: slot.getBoundingClientRect().height };
    el.classList.add("active");
    o.onStart && o.onStart();
  });
  slot.addEventListener("pointermove", (e) => {
    if (!start) return;
    const scale = e.shiftKey ? 4 : 1;
    v = clamp(start.v + (start.y - e.clientY) / (start.hgt * scale), 0, 1);
    paint();
    o.onInput && o.onInput(v);
  });
  const end = () => { if (!start) return; start = null; el.classList.remove("active"); o.onChange && o.onChange(v); };
  slot.addEventListener("pointerup", end);
  slot.addEventListener("pointercancel", end);
  el.set = (nv) => { if (start) return; v = clamp(nv, 0, 1); paint(); };
  el.meter = meter;
  return el;
}

/** Draw a level (peak 0..1+) into a meter canvas, with a falling hold */
export function drawMeter(canvas, peak) {
  const r = canvas.clientHeight || canvas.height;
  if (canvas.height !== r) canvas.height = r;
  const c = canvas.getContext("2d");
  const w = canvas.width, hgt = canvas.height;
  const db = peak > 0 ? 20 * Math.log10(peak) : -100;
  const lvl = clamp((db + 54) / 60, 0, 1);
  canvas._hold = Math.max(lvl, (canvas._hold || 0) - 0.012);
  c.clearRect(0, 0, w, hgt);
  c.fillStyle = "#2a2c31";
  c.fillRect(0, 0, w, hgt);
  const g = c.createLinearGradient(0, hgt, 0, 0);
  g.addColorStop(0, "#3fd67a"); g.addColorStop(0.75, "#c8e04a"); g.addColorStop(0.9, "#ffb03a"); g.addColorStop(1, "#ff4d3d");
  c.fillStyle = g;
  c.fillRect(0, hgt * (1 - lvl), w, hgt * lvl);
  c.fillStyle = db > -0.3 ? "#ff4d3d" : "#e8e8e8";
  c.fillRect(0, hgt * (1 - canvas._hold), w, 2);
}

export function toggle(label, on, onClick, cls = "") {
  const b = h("button", { type: "button", class: "tog " + cls + (on ? " on" : ""), onclick: (e) => { e.stopPropagation(); onClick(e); } }, label);
  b.setOn = (v) => b.classList.toggle("on", !!v);
  return b;
}

let openMenu = null;
export function closeMenus() { if (openMenu) { openMenu.remove(); openMenu = null; } }

/**
 * menu(anchor | {x,y}, items): a popover list. items: [{label, onClick, checked, disabled, danger, sub?}] | "-"
 */
export function menu(anchor, items, { title, width } = {}) {
  closeMenus();
  const list = h("div", { class: "menu-list" });
  for (const it of items) {
    if (it === "-") { list.append(h("div", { class: "menu-sep" })); continue; }
    if (!it) continue;
    const row = h("button", {
      type: "button", class: "menu-item" + (it.danger ? " danger" : "") + (it.checked ? " checked" : ""), disabled: it.disabled,
      onclick: (e) => { e.stopPropagation(); closeMenus(); it.onClick && it.onClick(); },
    }, h("span", { class: "menu-check" }, it.checked ? "✓" : ""), h("span", { class: "menu-label" }, it.label), it.hint ? h("span", { class: "menu-hint" }, it.hint) : null);
    if (it.color) row.prepend(h("span", { class: "menu-swatch", style: { background: it.color } }));
    list.append(row);
  }
  const box = h("div", { class: "menu" }, title ? h("div", { class: "menu-title" }, title) : null, list);
  if (width) box.style.width = width + "px";
  const veil = h("div", { class: "menu-veil", onpointerdown: (e) => { if (e.target === veil) { e.preventDefault(); closeMenus(); } } }, box);
  document.body.append(veil);
  openMenu = veil;
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const bw = box.offsetWidth, bh = box.offsetHeight, vw = innerWidth, vh = innerHeight;
  let x = r.left, y = r.bottom + 4;
  if (x + bw > vw - 8) x = Math.max(8, vw - bw - 8);
  if (y + bh > vh - 8) y = Math.max(8, r.top - bh - 4);
  if (y < 8) y = 8;
  box.style.left = x + "px";
  box.style.top = y + "px";
  box.style.maxHeight = vh - y - 12 + "px";
  return box;
}

/** A modal sheet: sheet(title, body, {actions: [{label, primary, onClick}]}) -> {close} */
export function sheet(title, body, { actions = [], wide = false, onClose, full = false } = {}) {
  closeMenus();
  const close = () => { veil.remove(); onClose && onClose(); };
  const head = h("div", { class: "sheet-head" }, h("div", { class: "sheet-title" }, title), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, "✕"));
  const foot = actions.length ? h("div", { class: "sheet-foot" }, actions.map((a) => h("button", {
    type: "button", class: "btn" + (a.primary ? " primary" : "") + (a.danger ? " danger" : ""),
    onclick: async () => { if (a.onClick && (await a.onClick()) === false) return; close(); },
  }, a.label))) : null;
  const box = h("div", { class: "sheet" + (wide ? " wide" : "") + (full ? " full" : "") }, head, h("div", { class: "sheet-body" }, body), foot);
  const veil = h("div", { class: "sheet-veil", onpointerdown: (e) => { if (e.target === veil) close(); } }, box);
  document.body.append(veil);
  return { close, box };
}

export function prompt(title, value, { placeholder = "", ok = "OK" } = {}) {
  return new Promise((resolve) => {
    const input = h("input", { class: "text", type: "text", value: value || "", placeholder });
    let done = false;
    const s = sheet(title, input, {
      actions: [{ label: "Cancel" }, { label: ok, primary: true, onClick: () => { done = true; resolve(input.value); } }],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { done = true; resolve(input.value); s.close(); } });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

export function confirmBox(title, text, ok = "OK", danger = false) {
  return new Promise((resolve) => {
    let done = false;
    sheet(title, h("p", { class: "sheet-text" }, text), {
      actions: [{ label: "Cancel" }, { label: ok, primary: !danger, danger, onClick: () => { done = true; resolve(true); } }],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function toast(text, ms = 2600) {
  const t = h("div", { class: "toast" }, text);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

/** A number you drag (up/down) or tap to type: numberDrag({value, min, max, step, format, onChange}) */
export function numberDrag(o) {
  let v = o.value;
  const el = h("button", { type: "button", class: "numdrag " + (o.cls || "") });
  const paint = () => { el.textContent = o.format ? o.format(v) : String(v); };
  paint();
  let start = null, moved = false;
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); start = { y: e.clientY, v }; moved = false; });
  el.addEventListener("pointermove", (e) => {
    if (!start) return;
    const d = Math.round((start.y - e.clientY) / (o.pxPerStep || 6));
    if (d !== 0) moved = true;
    const nv = clamp(Math.round((start.v + d * o.step) / o.step) * o.step, o.min, o.max);
    if (nv !== v) { v = +nv.toFixed(4); paint(); o.onInput && o.onInput(v); }
  });
  el.addEventListener("pointerup", async () => {
    if (!start) return;
    start = null;
    if (moved) { o.onChange && o.onChange(v); return; }
    const r = await prompt(o.title || "Value", String(v));
    if (r === null) return;
    const n = parseFloat(r);
    if (!isFinite(n)) return;
    v = clamp(n, o.min, o.max);
    paint();
    o.onChange && o.onChange(v);
  });
  el.set = (nv) => { if (start) return; v = nv; paint(); };
  return el;
}

export function segmented(options, value, onChange, cls = "") {
  const el = h("div", { class: "seg " + cls });
  const btns = options.map((o) => {
    const b = h("button", { type: "button", class: "seg-btn" + (o.value === value ? " on" : ""), onclick: () => { set(o.value); onChange(o.value); } }, o.label);
    b.dataset.value = o.value;
    return b;
  });
  el.append(...btns);
  function set(v) { btns.forEach((b) => b.classList.toggle("on", b.dataset.value === String(v))); }
  el.set = set;
  return el;
}

export function select(options, value, onChange, cls = "") {
  const s = h("select", { class: "sel " + cls, onchange: () => onChange(s.value) });
  for (const o of options) s.append(h("option", { value: o.value, selected: String(o.value) === String(value) }, o.label));
  return s;
}
