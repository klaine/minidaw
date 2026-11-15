/* Remote UI layout shell: header, signal-flow cards and the modulation dock.
 *
 * Built once.  Everything that changes afterwards (values, the edit layer,
 * the FX type) flows through Store bindings, so nothing here is re-rendered
 * on a parameter update.
 */
import { choice, control, knob, toggle } from "./controls.js";
import { filterView } from "./filter.js";
import { tablePicker, waveView } from "./wavetable.js";
import { loadLibraryWhenIdle } from "./library.js";
import { ModModel, sourceChips, sourceColor } from "./mod.js";
import { liveMeter, onLive } from "./live.js";
import { lfoShape } from "./curves.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function remember(key, fallback) {
  try { return localStorage.getItem("amino." + key) || fallback; } catch (e) { return fallback; }
}
function keep(key, value) {
  try { localStorage.setItem("amino." + key, value); } catch (e) { /* private mode */ }
}

function card(id, title, ...children) {
  const c = el("section", "card card-" + id);
  c.setAttribute("aria-label", title);
  const h = el("h2", "card-title", title);
  c.appendChild(h);
  for (const child of children) if (child) c.appendChild(child);
  return c;
}

/** A card whose body is built by a lazily loaded module (envelopes, LFOs). */
function lazyCard(id, title, build) {
  const c = card(id, title);
  Promise.resolve(build()).then((node) => c.appendChild(node));
  return c;
}

function row(store, keys, opts = {}) {
  const r = el("div", "ctl-row" + (opts.cls ? " " + opts.cls : ""));
  for (const k of keys) {
    if (typeof k === "string") r.appendChild(control(store, k, opts));
    else r.appendChild(k);
  }
  return r;
}

/** A group with its own help page (help.js), for groups that share a card. */
function helpGroup(help, title, ...rows) {
  const g = group(title, ...rows);
  g.dataset.help = help;
  return g;
}

function group(title, ...rows) {
  const g = el("div", "group");
  if (title) g.appendChild(el("h3", "group-title", title));
  for (const r of rows) g.appendChild(r);
  return g;
}

/* ------------------------------------------------------------ header */

/* The preset name until the shared browser (presets.js, presetbrowser.js)
 * mounts in its place: it loads with the library after first paint, which
 * keeps it out of the initial payload (docs/05 9.2). */
function presetNav(store) {
  const wrap = el("div", "preset-nav");
  const prev = el("button", "icon-btn", "‹");
  const next = el("button", "icon-btn", "›");
  prev.disabled = next.disabled = true;
  const name = el("div", "preset-name");
  const title = el("span", "preset-title");
  name.append(el("span", "preset-meta", "Presets"), title);
  wrap.append(prev, name, next);
  const b = store.bind("preset_name", (v) => { title.textContent = v || "Init"; });
  loadLibraryWhenIdle()
    .then(() => import("./presets.js"))
    .then((m) => m.mountPresetNav(store, wrap))
    .then(() => b.unbind(), (err) => console.error("preset browser", err));
  return wrap;
}

function layerStrip(store) {
  const strip = el("div", "layer-strip");
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", "Edit layer");
  const buttons = [];
  for (let n = 1; n <= 4; n++) {
    const b = el("button", "layer-btn");
    b.dataset.layer = String(n);
    b.append(el("span", "layer-dot"), el("span", "", "L" + n));
    b.onclick = () => {
      const count = Math.round(store.num("layer_count", 1));
      if (n > count) store.set("layer_count", String(n));
      store.set("edit_layer", String(n));
    };
    buttons.push(b);
    strip.appendChild(b);
  }
  const paint = () => {
    const count = Math.round(store.num("layer_count", 1));
    const edit = store.layer;
    buttons.forEach((b, i) => {
      const n = i + 1;
      b.classList.toggle("on", n === edit);
      b.classList.toggle("muted", store.num("l" + n + "_on") < 0.5);
      b.classList.toggle("unused", n > count);
      b.setAttribute("aria-pressed", String(n === edit));
      b.title = n > count ? "Add layer " + n : "Edit layer " + n;
    });
    document.documentElement.dataset.layer = String(edit);
  };
  for (const k of ["edit_layer", "layer_count", "l1_on", "l2_on", "l3_on", "l4_on"]) store.bind(k, paint);
  onLive(store, (s) => buttons.forEach((b, i) => {
    b.classList.toggle("playing", s.layerVoices[i] > 0);
    b.title = (b.title.split(" · ")[0]) + (s.layerVoices[i] ? " · " + s.layerVoices[i] + " playing" : "");
  }));
  return strip;
}

function header(store) {
  const h = el("header", "top");
  const brand = el("div", "brand");
  brand.append(el("span", "brand-mark", "∿"), el("span", "brand-name", "Amino"));
  const tools = el("div", "top-tools");
  tools.append(
    choice(store, "layer_mode", { label: "Mode", segmentMax: 0 }),
    knob(store, "master_vol", { label: "Vol", size: "sm" }),
    knob(store, "patch_gain", { label: "Gain", size: "sm" }),
  );
  tools.append(liveMeter(store), historyControls(store));
  if (!hostHasKeys()) tools.append(keysButton(store));
  tools.append(helpButton(store));
  h.append(brand, presetNav(store), layerStrip(store), tools, sourceChips(store.mod));
  return h;
}

/* ------------------------------------------------------------ cards */

function oscCard(store, n) {
  const p = "osc" + n + "_";
  const extra = n === 2 ? [toggle(store, "osc2_link", { label: "Link" })] : [];
  const wave = knob(store, p + "wave", { size: "lg" });
  if (n === 2) {
    // Linked, Osc 2 plays Osc 1's table and position (params.c, voice.c).
    store.bind("osc2_link", (v) => wave.classList.toggle("inactive", Number(v) >= 0.5));
  }
  return card("osc" + n, "Osc " + n,
    row(store, [tablePicker(store, n), ...extra], { cls: "wide" }),
    waveView(store, n),
    row(store, [wave, p + "semi", p + "fine", p + "level"]),
    row(store, [p + "wenv", p + "vel", toggle(store, p + "kbd", { label: "Kbd" })]),
    n === 2 ? group("Cross mod (Osc 2 → 1)", row(store, ["xmod_type", "xmod"])) : null,
  );
}

/** Drive sits before or after the filter and the amp follows it, so the three share a card. */
function filterCard(store) {
  return card("filter", "Drive · Filter · Amp",
    helpGroup("dirt", "Dirt & Drive",
      row(store, [choice(store, "dirt_type", { label: "Dirt", segmentMax: 0 }), "dirt",
        choice(store, "drv_type", { label: "Drive", segmentMax: 0 }), "drive", choice(store, "drv_pos", { label: "Pos" })]),
    ),
    group("Filter",
      row(store, [choice(store, "ftype", { label: "Type", segmentMax: 7,
        labels: ["LP24", "LP12", "Ladder", "HP24", "HP12", "BP12", "Off"] })], { cls: "wide fit" }),
      filterView(store),
      row(store, [knob(store, "cutoff", { size: "lg" }), knob(store, "res", { size: "lg" }), "fenv", "fkbd", "fvel"]),
    ),
    helpGroup("amp", "Amp",
      row(store, [knob(store, "vol", { label: "Level" }), "amp_vel", "pan", "flavour", choice(store, "pan_mode", { label: "Pan mode", segmentMax: 0 })]),
    ),
  );
}

function fxMetaFor(store, type, i) {
  const k = (store.meta.fx[type] || [])[i];
  if (!k) return null;
  const base = { name: k.name, short: k.short, default: k.default, min: 0, max: 1, type: "float" };
  return k.options ? Object.assign(base, { options: k.options, normalized: true })
                   : Object.assign(base, { display: k.display });
}

function fxSlot(store, n) {
  const typeKey = "fx" + n + "_type";
  const slot = el("div", "fx-slot");
  const head = el("div", "ctl-row");
  head.append(choice(store, typeKey, { label: "FX " + n, segmentMax: 0 }), knob(store, "fx" + n + "_mix", { label: "Mix" }));
  const params = el("div", "ctl-row fx-params");
  const cells = [];
  for (let i = 1; i <= 6; i++) {
    const key = "fx" + n + "_p" + i;
    const generic = store.metaFor(key);
    cells.push({ key, generic, knob: knob(store, key, { meta: generic }), choice: null, shown: null });
  }
  const typeMeta = store.metaFor(typeKey);
  const paint = (v) => {
    const type = typeMeta.options[Math.round(Number(v) || 0)] || "Off";
    slot.classList.toggle("off", type === "Off");
    params.textContent = "";
    cells.forEach((c, i) => {
      const m = fxMetaFor(store, type, i) || c.generic;
      let w = c.knob;
      if (m.options) {
        if (!c.choice) c.choice = choice(store, c.key, { meta: m, segmentMax: 0 });
        else c.choice.setMeta(m);
        w = c.choice;
      } else {
        c.knob.setMeta(m);
      }
      params.appendChild(w);
    });
  };
  store.bind(typeKey, paint);
  slot.append(head, params);
  return slot;
}

function fxCard(store) {
  // The routing diagram loads after first paint (fxchain.js).
  const chain = el("div", "fxchain-slot");
  whenIdle(() => import("./fxchain.js").then((m) => chain.appendChild(m.fxChain(store))));
  const slots = el("div", "fx-slots");
  slots.append(fxSlot(store, 1), fxSlot(store, 2));
  return card("fx", "Effects",
    chain,
    slots,
    row(store, [choice(store, "fx_chain", { label: "Chain" }), choice(store, "route", { label: "Layer route" }), knob(store, "send", { label: "Send" })]),
  );
}

/* ------------------------------------------------------------ mod dock */

// The envelope and LFO editors load with their tab (envelope.js, lfo.js).
async function envelopes(store) {
  const { envelopeView } = await import("./envelope.js");
  const names = { e1: "Wave env", e2: "Filter env", e3: "Amp env", e4: "Aux env" };
  const wrap = el("div", "dock-grid");
  for (const e of ["e1", "e2", "e3", "e4"]) {
    const parts = [envelopeView(store, e, names[e]),
      row(store, [e + "_a", e + "_d", e + "_s", e + "_r"])];
    // The Aux env has no fixed destination; its two dedicated routes sit with it.
    if (e === "e4") {
      for (const n of [1, 2]) {
        parts.push(row(store, [
          choice(store, "e4_dst" + n, { label: "Target " + n, segmentMax: 0 }),
          knob(store, "e4_amt" + n, { label: "Amt " + n })], { cls: "aux-route" }));
      }
    }
    wrap.appendChild(group(names[e], ...parts));
  }
  return wrap;
}

async function lfos(store) {
  const { lfoView } = await import("./lfo.js");
  const wrap = el("div", "dock-grid");
  for (const n of [1, 2]) {
    const p = "lfo" + n + "_";
    const rate = knob(store, p + "rate");
    const div = choice(store, p + "div", { label: "Div", segmentMax: 0 });
    // Synced, the LFO runs at a note division instead of a rate: show
    // whichever one is in use rather than a greyed-out twin.
    store.bind(p + "sync", (v) => {
      const synced = Number(v) >= 0.5;
      rate.hidden = synced;
      div.hidden = !synced;
    });
    const mw = toggle(store, p + "mw", { label: "MW" });
    mw.title = "Mod wheel scales this LFO";
    wrap.appendChild(group("LFO " + n,
      lfoView(store, n),
      row(store, [choice(store, p + "shape", { label: "Shape", segmentMax: 0 }), rate, div, toggle(store, p + "sync", { label: "Sync" }), mw]),
      row(store, [choice(store, p + "phase", { label: "Phase", select: true }), p + "fade", knob(store, p + "pitch", { label: "Pitch" })]),
    ));
  }
  return wrap;
}

function matrix(store) {
  const table = el("div", "matrix");
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", "Modulation matrix");
  const headRow = el("div", "matrix-row matrix-head");
  headRow.setAttribute("role", "row");
  for (const t of ["#", "Source", "Target", "Amount", "Via", "Depth", ""]) headRow.appendChild(el("span", "", t));
  table.appendChild(headRow);
  const rows = [];
  // Only routes in use, plus one empty slot to add the next; all eight on request.
  let showAll = remember("matrix.all", "0") === "1";
  let more = null;
  for (let m = 1; m <= 8; m++) {
    const p = "m" + m + "_";
    const r = el("div", "matrix-row");
    r.setAttribute("role", "row");
    const clear = el("button", "icon-btn", "×");
    clear.setAttribute("aria-label", "Clear slot " + m);
    clear.title = "Clear slot";
    const parts = [
      el("span", "slot-num", String(m)),
      choice(store, p + "src", { label: "", segmentMax: 0 }),
      choice(store, p + "dst", { label: "", segmentMax: 0 }),
      knob(store, p + "amt", { label: "", size: "sm", ariaLabel: "Slot " + m + " amount" }),
      choice(store, p + "via", { label: "", segmentMax: 0 }),
      knob(store, p + "via_depth", { label: "", size: "sm", ariaLabel: "Slot " + m + " via depth" }),
      clear,
    ];
    r.append(...parts);
    clear.onclick = () => {
      for (const [k, v] of [["src", "0"], ["dst", "0"], ["amt", "0"], ["via", "0"], ["via_depth", "1"]]) {
        store.setBare(p + k, v);
      }
    };
    const paint = () => {
      const src = Math.round(store.value(p + "src"));
      const live = src > 0 && store.value(p + "dst") > 0;
      r.classList.toggle("idle", !live);
      r.style.setProperty("--slot", src > 0 ? sourceColor(store.meta, src) : "var(--faint)");
    };
    store.bind(p + "src", () => { paint(); refresh(); });
    store.bind(p + "dst", () => { paint(); refresh(); });
    rows.push({ r, p });
    table.appendChild(r);
  }
  more = el("button", "btn matrix-more");
  more.type = "button";
  more.onclick = () => { showAll = !showAll; keep("matrix.all", showAll ? "1" : "0"); refresh(); };
  table.appendChild(more);
  function refresh() {
    if (!more) return;
    let spare = false, hidden = 0;
    for (const { r, p } of rows) {
      const used = store.value(p + "src") > 0 || store.value(p + "dst") > 0;
      const show = showAll || used || !spare;
      if (!used && !showAll) spare = true;
      r.hidden = !show;
      if (!show) hidden++;
    }
    more.hidden = !showAll && hidden === 0;
    more.textContent = showAll ? "Show used slots only" : "Show all 8 slots";
  }
  refresh();
  // Light each live row by its source's current value (envelopes and LFOs of
  // the newest voice; other sources have no telemetry).
  onLive(store, (s) => {
    for (const { r, p } of rows) {
      const src = Math.round(store.value(p + "src"));
      let a = 0;
      if (s.env && src >= 1 && src <= 3) a = s.env[src - 1].level;
      else if (s.lfo && src >= 4 && src <= 7) {
        const k = (src - 4) % 2;
        a = Math.abs(lfoShape(Math.round(store.value("lfo" + (k + 1) + "_shape")), s.lfo[k].phase, s.lfo[k].cur, s.lfo[k].cur));
      }
      r.style.setProperty("--act", Math.min(1, a).toFixed(2));
    }
  });
  return table;
}

function voiceCard(store) {
  return card("voice", "Voice",
    row(store, [choice(store, "poly", { label: "Mode" }), choice(store, "osc_mode", { label: "Char" })]),
    row(store, ["octave", "glide", "midi_ch"]),
    group("Notes",
      row(store, ["key_lo", "key_hi"]),
      row(store, [choice(store, "scale", { label: "Scale", segmentMax: 0 }), choice(store, "chord", { label: "Chord", segmentMax: 0 })]),
    ),
    group("Aftertouch", row(store, ["at_wave", "at_cut", "at_vib"])),
  );
}

function global(store) {
  const wrap = el("div", "dock-grid");
  const actions = el("div", "ctl-row");
  const init = el("button", "btn", "Init layer");
  const rnd = el("button", "btn", "Randomise layer");
  init.onclick = () => { store.history?.bulk("Init layer " + store.layer); store.send("init_layer", "1"); };
  rnd.onclick = () => { store.history?.bulk("Randomise layer " + store.layer); store.send("randomize", "1"); };
  actions.append(init, rnd, knob(store, "rand_amt", { label: "Amount", size: "sm" }));
  wrap.append(
    group("Engine", row(store, ["voices", "bend_range", toggle(store, "mpe", { label: "MPE" }), knob(store, "flavour_global", { label: "Flav G" })])),
    group("Focused layer", actions),
  );
  return wrap;
}

function dock(store) {
  const tabs = [
    ["matrix", "Matrix", matrix],
    ["layers", "Layers", () => import("./layers.js").then((m) => m.layersTab(store))],
    ["global", "Global", global],
  ];
  const d = el("section", "dock");
  d.setAttribute("aria-label", "Modulation and voice");
  const bar = el("div", "dock-tabs");
  bar.setAttribute("role", "tablist");
  const panes = el("div", "dock-panes");
  let current = remember("dock", "matrix");
  const buttons = {};
  const bodies = {};
  const builders = {};
  for (const [id, label, build] of tabs) {
    const b = el("button", "dock-tab", label);
    b.setAttribute("role", "tab");
    b.onclick = () => show(id);
    buttons[id] = b;
    bar.appendChild(b);
    const pane = el("div", "dock-pane");
    pane.setAttribute("role", "tabpanel");
    pane.dataset.tab = id;
    bodies[id] = pane;
    builders[id] = build;
    panes.appendChild(pane);
  }
  // Panes are built on first view; a builder may return a Promise (lazy module).
  const ensure = (id) => {
    if (!builders[id]) return;
    const build = builders[id];
    builders[id] = null;
    Promise.resolve(build(store)).then((node) => bodies[id].appendChild(node));
  };
  const show = (id) => {
    if (!buttons[id]) id = "matrix";
    current = id;
    keep("dock", id);
    ensure(id);
    for (const k in buttons) {
      buttons[k].classList.toggle("on", k === id);
      buttons[k].setAttribute("aria-selected", String(k === id));
      bodies[k].hidden = k !== id;
    }
  };
  show(current);
  d.append(bar, panes);
  return d;
}

/* ------------------------------------------------------------ history, help */

function whenIdle(fn) {
  if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 400);
}

const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);

/** Undo, redo and A/B; history.js loads after first paint. */
function historyControls(store) {
  const wrap = el("div", "history-tools");
  const undo = el("button", "icon-btn", "↶");
  const redo = el("button", "icon-btn", "↷");
  undo.setAttribute("aria-label", "Undo");
  redo.setAttribute("aria-label", "Redo");
  const ab = el("div", "seg ab");
  ab.setAttribute("role", "radiogroup");
  ab.setAttribute("aria-label", "Compare A/B");
  const slots = ["A", "B"].map((x) => {
    const b = el("button", "seg-btn", x);
    b.type = "button";
    b.setAttribute("role", "radio");
    ab.appendChild(b);
    return b;
  });
  for (const b of [undo, redo, ...slots]) b.disabled = true;
  wrap.append(undo, redo, ab);
  whenIdle(() => import("./history.js").then(({ History }) => {
    const h = store.history = new History(store);
    undo.onclick = () => h.undo();
    redo.onclick = () => h.redo();
    slots.forEach((b) => { b.onclick = () => h.switchTo(b.textContent); });
    h.onChange(() => {
      undo.disabled = !h.canUndo;
      redo.disabled = !h.canRedo;
      undo.title = h.canUndo ? "Undo " + h.describe(h.undos) : "Nothing to undo";
      redo.title = h.canRedo ? "Redo " + h.describe(h.redos) : "Nothing to redo";
      slots.forEach((b) => {
        const on = b.textContent === h.compare.active;
        b.disabled = false;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
        b.title = on ? "Editing " + b.textContent : "Switch to " + b.textContent +
          (h.compare.slots[b.textContent] ? "" : " (starts as a copy)");
      });
    });
    document.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey) || typing(e)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); h.undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); h.redo(); }
    });
  }));
  return wrap;
}

/** The standalone web build (web/app.js) plays from its own keyboard below. */
function hostHasKeys() {
  try { return window.parent !== window && !!window.parent.aminoBridge; } catch (e) { return false; }
}

/** On-screen keyboard (keyboard.js) that plays the synth through "audition". */
function keysButton(store) {
  const b = el("button", "icon-btn", "♪");
  b.setAttribute("aria-label", "Keyboard");
  b.setAttribute("aria-expanded", "false");
  b.title = "Play from the browser";
  b.onclick = () => import("./keyboard.js").then((m) => m.toggleKeyboard(store, b));
  return b;
}

function helpButton(store) {
  const b = el("button", "icon-btn help-btn", "?");
  b.setAttribute("aria-label", "Help");
  b.setAttribute("aria-expanded", "false");
  b.title = "Help (?)";
  const open = () => import("./help.js").then((m) => m.toggleHelp(store, b));
  b.onclick = open;
  document.addEventListener("keydown", (e) => {
    if (e.key === "?" && !typing(e) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); open(); }
  });
  return b;
}

/* ------------------------------------------------------------ shell */

/** Width of a card on the wide grid: the whole row or half of it (style.css). */
function span(card, width) {
  card.classList.add("span-" + width);
  return card;
}

export function buildShell(store, root) {
  root.textContent = "";
  new ModModel(store); // before any knob, so knobs can register for rings
  whenIdle(() => import("./modanim.js").then((m) => m.startModAnimation(store)));
  root.appendChild(header(store));
  const main = el("main", "flow");
  main.append(
    oscCard(store, 1),
    oscCard(store, 2),
    filterCard(store),
    voiceCard(store),
    span(lazyCard("env", "Envelopes", () => envelopes(store)), "all"),
    span(lazyCard("lfo", "LFOs", () => lfos(store)), "half"),
    span(fxCard(store), "half"),
  );
  root.append(main, dock(store));
}
