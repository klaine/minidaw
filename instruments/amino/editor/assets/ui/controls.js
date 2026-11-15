/* Remote UI controls: knob, enum (segmented or list) and switch.
 *
 * Every control binds to one bare key through Store.bind, so it follows the
 * edit layer and repaints only when its own value changes.  `control()` picks
 * the widget from the parameter's metadata.
 *
 * Knob gestures: drag vertically (Shift = fine), double-click to reset,
 * arrow/Page/Home/End keys, wheel while focused, and click the value to type
 * one ("2.5 kHz", "350 ms", "-12").
 */
import { clampTo, formatValue, optionIndex, optionValue, parseValue } from "./format.js";
import { modulatedPositions, ringSpan } from "./curves.js";

const SVG = "http://www.w3.org/2000/svg";
const SWEEP = 270;
const DRAG_PX = 180;   // pixels for the full range
const FINE = 6;        // Shift divides drag speed by this

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(tag, attrs) {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function arcPath(cx, cy, r, a0, a1) {
  const rad = (a) => (a - 90) * Math.PI / 180;
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const range = (m) => [m.min !== undefined ? m.min : 0, m.max !== undefined ? m.max : 1];
const fraction = (m, v) => {
  const [lo, hi] = range(m);
  return hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0;
};
const fromFraction = (m, f) => {
  const [lo, hi] = range(m);
  return clampTo(m, lo + (hi - lo) * Math.min(1, Math.max(0, f)));
};
function keyStep(m, big) {
  const [lo, hi] = range(m);
  if (m.type === "int") return big ? Math.max(1, Math.round((hi - lo) / 10)) : 1;
  return (hi - lo) * (big ? 0.1 : 0.01);
}

/**
 * A rotary control.  opts: { label, meta, size: "sm"|"md"|"lg", layer }.
 * Returns the element; `el.setMeta(meta)` swaps ranges/labels in place
 * (FX slot knobs change meaning with the effect type).
 */
export function knob(store, bare, opts = {}) {
  let meta = opts.meta || store.metaFor(bare);
  const root = el("div", "knob knob-" + (opts.size || "md"));
  root.dataset.key = bare;
  const label = el("div", "knob-label", opts.label !== undefined ? opts.label : meta.short || meta.name);
  const dial = el("div", "knob-dial");
  dial.tabIndex = 0;
  dial.setAttribute("role", "slider");
  const face = svg("svg", { viewBox: "0 0 64 64", "aria-hidden": "true" });
  const track = svg("path", { class: "knob-track", d: arcPath(32, 32, 26, -SWEEP / 2, SWEEP / 2) });
  const fill = svg("path", { class: "knob-fill" });
  const cap = svg("circle", { class: "knob-cap", cx: 32, cy: 32, r: 19 });
  const pointer = svg("line", { class: "knob-pointer", x1: 32, y1: 32, x2: 32, y2: 16 });
  const ringLayer = svg("g", { class: "knob-rings" });
  // Where live modulation puts the value right now (modanim.js moves it).
  const ghost = svg("circle", { class: "knob-ghost", r: 2.6, cx: 32, cy: 6 });
  face.append(ringLayer, track, fill, ghost, cap, pointer);
  dial.appendChild(face);
  const value = el("button", "knob-value");
  value.type = "button";
  root.append(label, dial, value);

  let current = 0;
  let dragging = false;
  let editing = false;
  let rings = [];        // modulation slots aimed at this knob (mod.js)
  let amountDrag = null; // editing an armed source's amount instead of the value

  /* One arc per slot just outside the track, from the swept span. */
  let ringDots = [];     // one moving dot per drawn ring
  let lastSignals = null;
  const angleOf = (v) => -SWEEP / 2 + fraction(meta, v) * SWEEP;
  const place = (el, v, radius) => {
    const rad = (angleOf(v) - 90) * Math.PI / 180;
    el.setAttribute("cx", (32 + radius * Math.cos(rad)).toFixed(2));
    el.setAttribute("cy", (32 + radius * Math.sin(rad)).toFixed(2));
  };
  const paintRings = () => {
    ringLayer.textContent = "";
    ringDots = [];
    const [lo, hi] = range(meta);
    rings.slice(0, 3).forEach((r, i) => {
      const [a, b] = ringSpan(current, r.amount, r.scale, r.bipolar, lo, hi);
      const a0 = angleOf(a), a1 = angleOf(b);
      const radius = 30.5 + i * 3;
      const path = svg("path", { class: "knob-ring", stroke: r.color,
        d: a1 - a0 < 1.5 ? arcPath(32, 32, radius, a0 - 1, a0 + 1) : arcPath(32, 32, radius, a0, a1) });
      const dot = svg("circle", { class: "knob-ring-dot", r: 2.2, fill: r.color });
      ringLayer.append(path, dot);
      ringDots.push({ path, dot, radius });
    });
    root.classList.toggle("modulated", rings.length > 0);
    animate(lastSignals);
  };

  /**
   * Move the ring dots and the ghost tick to where each source has the value
   * now.  `signals` holds one entry per ring: the source's current output, or
   * null when there is no telemetry for it (its ring then shows a flowing
   * dash instead of a dot).  `idle` dims dots while no voice is playing.
   */
  const animate = (signals, idle) => {
    lastSignals = signals;
    const live = signals && rings.length ? signals.slice(0, ringDots.length) : null;
    if (!live) {
      for (const d of ringDots) { d.dot.style.display = "none"; d.path.classList.remove("flow"); }
      ghost.style.display = "none";
      return;
    }
    const [lo, hi] = range(meta);
    const pos = modulatedPositions(current, rings.slice(0, ringDots.length), live, lo, hi);
    ringDots.forEach((d, i) => {
      const v = pos.each[i];
      d.path.classList.toggle("flow", v === null);
      d.dot.style.display = v === null ? "none" : "";
      if (v !== null) place(d.dot, v, d.radius);
    });
    ghost.style.display = pos.total === null ? "none" : "";
    if (pos.total !== null) place(ghost, pos.total, 26);
    root.classList.toggle("mod-idle", !!idle);
  };

  const paint = () => {
    const f = fraction(meta, current);
    const angle = -SWEEP / 2 + f * SWEEP;
    const [lo] = range(meta);
    const origin = lo < 0 ? fraction(meta, 0) : 0;
    const a0 = -SWEEP / 2 + origin * SWEEP;
    fill.setAttribute("d", Math.abs(angle - a0) < 0.5 ? "" : arcPath(32, 32, 26, Math.min(a0, angle), Math.max(a0, angle)));
    pointer.setAttribute("transform", `rotate(${angle.toFixed(2)} 32 32)`);
    const text = formatValue(meta, current);
    if (!editing && !amountDrag) value.textContent = text;
    paintRings();
    dial.setAttribute("aria-valuenow", String(current));
    dial.setAttribute("aria-valuetext", text);
  };

  const binding = store.bind(bare, (v) => {
    if (dragging) return;
    const n = parseFloat(v);
    current = Number.isFinite(n) ? n : (meta.default || 0);
    paint();
  }, { layer: opts.layer });

  const commit = (v) => {
    const next = clampTo(meta, v);
    if (next === current) return;
    current = next;
    paint();
    binding.set(meta.type === "int" ? String(next) : next.toFixed(4));
  };

  const describe = () => {
    dial.setAttribute("aria-label", opts.ariaLabel || meta.name);
    const [lo, hi] = range(meta);
    dial.setAttribute("aria-valuemin", String(lo));
    dial.setAttribute("aria-valuemax", String(hi));
    root.title = meta.name + rings.map((r) =>
      "\n" + r.name + " (slot " + r.slot + "): " + (r.amount > 0 ? "+" : "") + Math.round(r.amount * 100) + "%").join("");
    root.classList.toggle("bipolar", lo < 0);
  };
  describe();

  /* drag */
  let startY = 0, startF = 0;
  dial.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dial.focus({ preventScroll: true });
    dial.setPointerCapture(e.pointerId);
    const mod = store.mod;
    if (mod && mod.armed && root.dataset.modKey) {
      // An armed source turns this drag into an amount edit for that source.
      const slot = mod.slotFor(mod.armed, root.dataset.modKey, false);
      const sl = slot ? mod.slots[slot - 1] : null;
      amountDrag = { mod, src: mod.armed, slot, start: sl ? sl.amt : 0, y: e.clientY };
      root.classList.add("active", "amount");
      showAmount(amountDrag.start);
      return;
    }
    dragging = true;
    root.classList.add("active");
    startY = e.clientY;
    startF = fraction(meta, current);
    dial._fine = e.shiftKey;
  });
  dial.addEventListener("pointermove", (e) => {
    if (amountDrag) {
      const d = amountDrag;
      const amt = Math.min(1, Math.max(-1, d.start + (d.y - e.clientY) / (e.shiftKey ? DRAG_PX * FINE : DRAG_PX / 2)));
      if (!d.slot) {
        if (Math.abs(amt) < 0.005) return;
        d.slot = d.mod.slotFor(d.src, root.dataset.modKey, true, amt);
        if (!d.slot) { showAmount(null); return; }
      }
      d.mod.setAmount(d.slot, amt);
      showAmount(amt);
      return;
    }
    if (!dragging) return;
    // Re-anchor when Shift changes so the knob does not jump.
    const scale = e.shiftKey ? DRAG_PX * FINE : DRAG_PX;
    if (e.shiftKey !== dial._fine) {
      dial._fine = e.shiftKey;
      startY = e.clientY;
      startF = fraction(meta, current);
    }
    commit(fromFraction(meta, startF + (startY - e.clientY) / scale));
  });
  const showAmount = (amt) => {
    const mod = store.mod;
    value.textContent = amt === null ? "slots full"
      : mod.sourceName(amountDrag.src).replace(/ Env$/, "") + " " + (amt > 0 ? "+" : "") + Math.round(amt * 100) + "%";
  };
  const end = () => {
    if (amountDrag) {
      amountDrag = null;
      root.classList.remove("active", "amount");
      paint();
      return;
    }
    if (!dragging) return;
    dragging = false;
    root.classList.remove("active");
    binding.update(store.get(binding.key));
  };
  dial.addEventListener("pointerup", end);
  dial.addEventListener("pointercancel", end);
  dial.addEventListener("lostpointercapture", end);
  dial.addEventListener("dblclick", () => commit(meta.default !== undefined ? meta.default : range(meta)[0]));

  /* keyboard and wheel */
  dial.addEventListener("keydown", (e) => {
    const [lo, hi] = range(meta);
    const fine = e.shiftKey ? 0.1 : 1;
    let next = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = current + keyStep(meta, false) * fine;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = current - keyStep(meta, false) * fine;
    else if (e.key === "PageUp") next = current + keyStep(meta, true);
    else if (e.key === "PageDown") next = current - keyStep(meta, true);
    else if (e.key === "Home") next = lo;
    else if (e.key === "End") next = hi;
    else if (e.key === "Delete" || e.key === "Backspace") next = meta.default;
    else if (e.key === "Enter") { startEdit(); e.preventDefault(); return; }
    if (next === null || next === undefined) return;
    e.preventDefault();
    commit(next);
  });
  dial.addEventListener("wheel", (e) => {
    if (document.activeElement !== dial) return; // never hijack page scrolling
    e.preventDefault();
    const steps = Math.max(-5, Math.min(5, -e.deltaY / 40));
    commit(current + keyStep(meta, false) * (e.shiftKey ? 0.1 : 1) * steps);
  }, { passive: false });

  /* type a value */
  const startEdit = () => {
    if (editing) return;
    editing = true;
    const input = el("input", "knob-edit");
    input.type = "text";
    input.value = formatValue(meta, current);
    input.setAttribute("aria-label", meta.name + " value");
    value.replaceWith(input);
    input.focus();
    input.select();
    const finish = (apply) => {
      if (!editing) return;
      editing = false;
      if (apply) {
        const v = parseValue(meta, input.value);
        if (v !== null) commit(v);
      }
      input.replaceWith(value);
      paint();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); dial.focus(); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); dial.focus(); }
    });
    input.addEventListener("blur", () => finish(true));
  };
  value.addEventListener("click", startEdit);

  root.setMeta = (m, labelText) => {
    meta = m;
    label.textContent = labelText || m.short || m.name;
    describe();
    paint();
  };
  root.getMeta = () => meta;
  root.getRings = () => rings;
  root.animateRings = animate;
  root.setRings = (r) => {
    rings = r;
    describe();
    paint();
  };
  root.binding = binding;
  if (store.mod && !opts.layer) store.mod.register(bare, root);
  return root;
}

/**
 * An enum.  Up to `segmentMax` options render as a segmented row, more as a
 * native select; `select: true` always uses the select.
 * opts: { label, meta, layer, segmentMax, select, labels }.
 */
export function choice(store, bare, opts = {}) {
  let meta = opts.meta || store.metaFor(bare);
  const root = el("div", "choice");
  root.dataset.key = bare;
  const label = el("div", "choice-label", opts.label !== undefined ? opts.label : meta.short || meta.name);
  if (label.textContent) root.appendChild(label);
  let body = null;
  let index = 0;
  let binding = null;

  const build = () => {
    if (body) body.remove();
    const names = opts.labels || meta.options;
    if (!opts.select && meta.options.length <= (opts.segmentMax || 4)) {
      body = el("div", "seg");
      body.setAttribute("role", "radiogroup");
      body.setAttribute("aria-label", meta.name);
      names.forEach((name, i) => {
        const b = el("button", "seg-btn", name);
        b.type = "button";
        b.setAttribute("role", "radio");
        b.title = meta.options[i];
        b.onclick = () => pick(i);
        body.appendChild(b);
      });
    } else {
      body = el("select", "select");
      body.setAttribute("aria-label", meta.name);
      names.forEach((name, i) => {
        const o = el("option", "", name);
        o.value = String(i);
        body.appendChild(o);
      });
      body.onchange = () => pick(Number(body.value));
    }
    root.appendChild(body);
  };

  const paint = () => {
    if (body.tagName === "SELECT") body.value = String(index);
    else [...body.children].forEach((b, i) => {
      b.classList.toggle("on", i === index);
      b.setAttribute("aria-checked", String(i === index));
    });
  };

  const pick = (i) => {
    index = i;
    paint();
    binding.set(String(optionValue(meta, i)));
  };

  build();
  binding = store.bind(bare, (v) => {
    index = optionIndex(meta, v !== undefined ? v : meta.default || 0);
    paint();
  }, { layer: opts.layer });
  root.title = meta.name;

  root.setMeta = (m, labelText) => {
    meta = m;
    label.textContent = labelText || m.short || m.name;
    build();
    index = optionIndex(meta, store.get(binding.key) || 0);
    paint();
  };
  root.getMeta = () => meta;
  root.binding = binding;
  return root;
}

/** An Off/On parameter as a toggle button. */
export function toggle(store, bare, opts = {}) {
  const meta = opts.meta || store.metaFor(bare);
  const root = el("button", "toggle", opts.label !== undefined ? opts.label : meta.short || meta.name);
  root.dataset.key = bare;
  root.type = "button";
  root.title = meta.name;
  let on = false;
  const binding = store.bind(bare, (v) => {
    on = Number(v) >= 0.5;
    root.classList.toggle("on", on);
    root.setAttribute("aria-pressed", String(on));
  }, { layer: opts.layer });
  root.onclick = () => {
    on = !on;
    root.classList.toggle("on", on);
    root.setAttribute("aria-pressed", String(on));
    binding.set(on ? "1" : "0");
  };
  root.binding = binding;
  return root;
}

/** The right widget for a parameter's metadata. */
export function control(store, bare, opts = {}) {
  const meta = opts.meta || store.metaFor(bare);
  if (!meta) throw new Error("no metadata for " + bare);
  if (meta.options) {
    const o = meta.options;
    if (o.length === 2 && o[0] === "Off" && o[1] === "On") return toggle(store, bare, opts);
    return choice(store, bare, opts);
  }
  return knob(store, bare, opts);
}
