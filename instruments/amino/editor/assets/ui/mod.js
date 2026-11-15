/* Modulation model and source chips for the focused layer.
 *
 * ModModel reads the eight matrix slots (m1..m8) of the edit layer from the
 * store and tells every registered knob which slots point at it, so knobs can
 * draw rings.  Sources can be assigned two ways:
 *   - drag a source chip onto a knob: the slot already routing that source to
 *     that knob is reused, otherwise the first empty slot gets amount +25 %;
 *   - click a chip to arm it: dragging any target knob then edits that
 *     source's amount on it (creating the slot on first move).  Click again,
 *     or press Escape, to disarm.
 */

export const SLOTS = 8;
const DEFAULT_AMOUNT = 0.25;

/* Chips shown in the header: the sources most patches use. */
const CHIP_SOURCES = ["Wave Env", "Filter Env", "Amp Env", "Aux Env", "LFO1", "LFO2", "Velocity",
  "ModWheel", "Chan AT", "Key", "Random"];
const CHIP_LABELS = { "Wave Env": "W.Env", "Filter Env": "F.Env", "Amp Env": "A.Env", "Aux Env": "X.Env",
  Velocity: "Vel", ModWheel: "MW", "Chan AT": "AT", Random: "Rnd" };

/** Colour for a source index: one hue per source, grouped by family. */
export function sourceColor(meta, src) {
  const names = meta.params.m1_src.options;
  const name = names[src] || "";
  const fixed = { "Wave Env": "#5fe0bf", "Filter Env": "#3fc7e8", "Amp Env": "#7ab8ff", "Aux Env": "#8fd9a8",
    LFO1: "#f2b85c", LFO2: "#ff8f5a", LFO1xMW: "#e8c66a", LFO2xMW: "#ff9f7a",
    Velocity: "#ff6fa8", ModWheel: "#c08bff", "Chan AT": "#a98bff", "Poly AT": "#9a7dff",
    Key: "#e7e36b", Random: "#9fe86b" };
  if (fixed[name]) return fixed[name];
  const group = (meta.modSources[src] || {}).group;
  return group === "random" ? "#9fe86b" : group === "env" ? "#5fe0bf" : "#d0a2ff";
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class ModModel {
  constructor(store) {
    this.store = store;
    this.meta = store.meta;
    this.targetIndex = new Map();     // bare knob key -> mod target index
    this.meta.modTargetKeys.forEach((key, i) => { if (key) this.targetIndex.set(key, i); });
    this.knobs = new Map();           // bare key -> Set<knob element>
    this.listeners = new Set();
    this.armed = 0;                   // armed source index, 0 = none
    this.slots = [];
    this.queued = false;
    store.mod = this;
    store.onChange((keys) => {
      if (keys.some((k) => k === "edit_layer" || /^l[1-4]_m[1-8]_/.test(k))) this.schedule();
    });
    this.read();
  }

  schedule() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.read(); });
  }

  /** Re-read the slots and push rings to every knob. */
  read() {
    const s = this.store;
    this.slots = [];
    for (let m = 1; m <= SLOTS; m++) {
      const v = (k) => s.value("m" + m + "_" + k);
      this.slots.push({ slot: m, src: Math.round(v("src")), dst: Math.round(v("dst")),
        amt: v("amt"), via: Math.round(v("via")), depth: v("via_depth") });
    }
    for (const [key, set] of this.knobs) {
      const rings = this.ringsFor(key);
      for (const knob of set) knob.setRings(rings);
    }
    for (const fn of this.listeners) fn(this.slots);
  }

  /** Rings for a knob: one per live slot targeting it. */
  ringsFor(bare) {
    const dst = this.targetIndex.get(bare);
    if (dst === undefined) return [];
    const scale = this.meta.modTargetScale[dst];
    return this.slots
      .filter((sl) => sl.src > 0 && sl.dst === dst && sl.amt !== 0)
      .map((sl) => ({
        slot: sl.slot, src: sl.src, amount: sl.amt, scale,
        bipolar: !!(this.meta.modSources[sl.src] || {}).bipolar,
        color: sourceColor(this.meta, sl.src),
        name: this.meta.params.m1_src.options[sl.src],
      }));
  }

  register(bare, knob) {
    if (!this.targetIndex.has(bare)) return;
    if (!this.knobs.has(bare)) this.knobs.set(bare, new Set());
    this.knobs.get(bare).add(knob);
    knob.dataset.modKey = bare;
    knob.setRings(this.ringsFor(bare));
  }

  onSlots(fn) {
    this.listeners.add(fn);
    fn(this.slots);
  }

  /**
   * The slot routing `src` to knob `bare`, creating one in the first empty
   * slot when `create` is set.  Returns the slot number or 0 (none / full).
   */
  slotFor(src, bare, create, amount = DEFAULT_AMOUNT) {
    const dst = this.targetIndex.get(bare);
    if (dst === undefined || !src) return 0;
    const found = this.slots.find((sl) => sl.src === src && sl.dst === dst);
    if (found) return found.slot;
    if (!create) return 0;
    const free = this.slots.find((sl) => sl.src === 0 && sl.dst === 0);
    if (!free) return 0;
    const p = "m" + free.slot + "_";
    this.store.setBare(p + "src", String(src));
    this.store.setBare(p + "dst", String(dst));
    this.store.setBare(p + "amt", amount.toFixed(4));
    this.store.setBare(p + "via", "0");
    this.store.setBare(p + "via_depth", "1");
    this.read();
    return free.slot;
  }

  setAmount(slot, amount) {
    this.store.setBare("m" + slot + "_amt", Math.min(1, Math.max(-1, amount)).toFixed(4));
    this.read();
  }

  arm(src) {
    this.armed = this.armed === src ? 0 : src;
    const root = document.documentElement;
    root.classList.toggle("mod-armed", !!this.armed);
    root.style.setProperty("--armed", this.armed ? sourceColor(this.meta, this.armed) : "transparent");
    for (const fn of this.listeners) fn(this.slots);
  }

  sourceName(src) { return this.meta.params.m1_src.options[src] || ""; }
  targetName(bare) {
    const i = this.targetIndex.get(bare);
    return i === undefined ? bare : this.meta.params.m1_dst.options[i];
  }
}

/* ------------------------------------------------------------ toast */

export function toast(text) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = el("div", "toast");
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 1800);
}

/* ------------------------------------------------------------ chips */

/** The header row of source chips. */
export function sourceChips(model) {
  const names = model.meta.params.m1_src.options;
  const bar = el("div", "mod-chips");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Modulation sources");
  bar.appendChild(el("span", "mod-chips-label", "Mod"));
  const chips = [];
  for (const name of CHIP_SOURCES) {
    const src = names.indexOf(name);
    if (src < 0) continue;
    const chip = el("button", "mod-chip");
    chip.type = "button";
    chip.style.setProperty("--chip", sourceColor(model.meta, src));
    chip.append(el("span", "mod-chip-dot"), el("span", "", CHIP_LABELS[name] || name));
    chip.title = name + ": drag onto a knob, or click to edit its amounts by dragging knobs";
    chip.setAttribute("aria-pressed", "false");
    chip.dataset.src = String(src);
    chips.push(chip);
    bar.appendChild(chip);
    dragChip(model, chip, src);
  }
  const count = el("span", "mod-chip-count");
  bar.appendChild(count);
  model.onSlots((slots) => {
    const used = new Map();
    for (const sl of slots) if (sl.src > 0 && sl.dst > 0) used.set(sl.src, (used.get(sl.src) || 0) + 1);
    for (const chip of chips) {
      const src = Number(chip.dataset.src);
      chip.classList.toggle("armed", model.armed === src);
      chip.setAttribute("aria-pressed", String(model.armed === src));
      chip.classList.toggle("used", used.has(src));
      chip.dataset.count = used.get(src) ? String(used.get(src)) : "";
    }
    const n = slots.filter((sl) => sl.src > 0 || sl.dst > 0).length;
    count.textContent = n + "/" + SLOTS;
    count.title = n + " of " + SLOTS + " matrix slots in use on this layer";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && model.armed) model.arm(model.armed);
  });
  return bar;
}

/* Pointer-driven drag (HTML drag-and-drop does not work on touch). */
function dragChip(model, chip, src) {
  let start = null, ghost = null, over = null;
  const targetAt = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    const knob = hit && hit.closest(".knob[data-mod-key]");
    return knob || null;
  };
  chip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    chip.setPointerCapture(e.pointerId);
  });
  chip.addEventListener("pointermove", (e) => {
    if (!start) return;
    if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
    if (!ghost) {
      ghost = chip.cloneNode(true);
      ghost.classList.add("mod-ghost");
      document.body.appendChild(ghost);
      document.documentElement.classList.add("mod-dragging");
      document.documentElement.style.setProperty("--armed", sourceColor(model.meta, src));
    }
    ghost.style.transform = `translate(${e.clientX + 8}px, ${e.clientY + 8}px)`;
    const t = targetAt(e.clientX, e.clientY);
    if (t !== over) {
      over?.classList.remove("mod-drop");
      t?.classList.add("mod-drop");
      over = t;
    }
  });
  const finish = (e, cancelled) => {
    if (!start) return;
    const dragged = !!ghost;
    start = null;
    ghost?.remove();
    ghost = null;
    over?.classList.remove("mod-drop");
    over = null;
    document.documentElement.classList.remove("mod-dragging");
    if (!model.armed) document.documentElement.style.setProperty("--armed", "transparent");
    if (cancelled) return;
    if (!dragged) { model.arm(src); return; }
    const knob = targetAt(e.clientX, e.clientY);
    if (!knob) return;
    const bare = knob.dataset.modKey;
    const existing = model.slotFor(src, bare, false);
    const slot = existing || model.slotFor(src, bare, true);
    if (!slot) { toast("All " + SLOTS + " mod slots are in use on this layer"); return; }
    toast((existing ? "Slot " + slot + " already routes " : "Slot " + slot + ": ") +
      model.sourceName(src) + " → " + model.targetName(bare));
  };
  chip.addEventListener("pointerup", (e) => finish(e, false));
  chip.addEventListener("pointercancel", (e) => finish(e, true));
  chip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); model.arm(src); }
  });
}
