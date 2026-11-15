/* The Crest panel: every section of the synth laid out like a hardware front panel (after the
 * Novation Peak's sections), built once and kept live by store bindings. */
import { h, knob, fader, segmented, select, led, depth } from "./controls.js";
import { vizCanvas, drawOsc, drawFilter, drawEnv, drawLfo, drawRhythm, drawRoute, drawFm } from "./viz.js";

/* Wave glyphs, 24 x 14 */
const ICON = {
  sine: "M1 7 C4 -2 8 -2 12 7 S20 16 23 7",
  tri: "M1 11 L7 3 L17 11 L23 3",
  saw: "M1 11 L12 3 L12 11 L23 3 L23 11",
  pulse: "M1 11 L1 3 L8 3 L8 11 L16 11 L16 3 L23 3",
  wt: "M1 9 L4 4 L6 10 L9 2 L12 8 L15 5 L18 11 L20 6 L23 8",
  sawdn: "M1 3 L12 11 L12 3 L23 11 L23 3",
  square: "M1 11 L1 3 L12 3 L12 11 L23 11 L23 3",
  sh: "M1 9 L6 9 L6 3 L12 3 L12 11 L17 11 L17 6 L23 6",
  rnd: "M1 9 C4 2 7 2 9 6 S14 12 17 8 S21 3 23 5",
  exp: "M1 3 C3 10 6 11 12 11 L12 3 C14 10 17 11 23 11",
};
const OSC_ICONS = [ICON.sine, ICON.tri, ICON.saw, ICON.pulse, ICON.wt];
const LFO_ICONS = [ICON.sine, ICON.tri, ICON.saw, ICON.sawdn, ICON.square, ICON.sh, ICON.rnd, ICON.exp];

function section(id, title, ...body) {
  return h("section", { class: `sec sec-${id}`, "aria-labelledby": `h-${id}` },
    h("h2", { id: `h-${id}` }, title), ...body);
}

const row = (...kids) => h("div", { class: "row" }, ...kids);

/** Tabs that show one of several bodies (envelopes, LFOs); the tab state is local to the page. */
function tabs(label, names, build, onChange) {
  let cur = 0;
  const bodies = names.map((_, i) => build(i));
  const btns = names.map((n, i) => h("button", {
    type: "button", role: "tab", class: "tab", "aria-selected": String(i === 0),
    onclick: () => show(i),
  }, n));
  const show = (i) => {
    cur = i;
    btns.forEach((b, j) => b.setAttribute("aria-selected", String(j === i)));
    bodies.forEach((b, j) => { b.hidden = j !== i; });
    onChange?.(i);
  };
  bodies.forEach((b, j) => { b.hidden = j !== 0; b.setAttribute("role", "tabpanel"); });
  return { bar: h("div", { class: "tabs", role: "tablist", "aria-label": label }, btns), bodies, show, get cur() { return cur; } };
}

/* ------------------------------------------------------------------ sections */

function oscillators(ui) {
  const col = (n) => {
    const k = (f) => `o${n}_${f}`;
    const table = select(ui, k("table"), { label: "Table" });
    ui.store.bind(k("wave"), (v) => { table.classList.toggle("off", Math.round(v) !== 4); });
    return h("div", { class: "osc" },
      h("div", { class: "osc-head" }, h("h3", {}, `OSC ${n}`), segmented(ui, k("wave"), { icons: OSC_ICONS })),
      vizCanvas(ui, ["wave", "shape", "table", "vsync", "dens", "ddet"].map(k).concat(`mx_o${n}`), drawOsc(ui, n)),
      table,
      row(knob(ui, k("coarse"), { label: "Coarse" }), knob(ui, k("fine"), { label: "Fine" }),
        knob(ui, k("shape"), { label: "Shape", accent: true }), knob(ui, k("vsync"), { label: "V-Sync" })),
      row(knob(ui, k("dens"), { label: "Density" }), knob(ui, k("ddet"), { label: "Dens Det" }),
        knob(ui, k("penv"), { label: "Env 2" }), knob(ui, k("plfo"), { label: "LFO 2" })),
      row(select(ui, k("shsrc"), { label: "Shape Src" }), knob(ui, k("shamt"), { label: "Shape Mod", size: "s" }),
        knob(ui, k("fixed"), { label: "Fixed", size: "s" })));
  };
  return section("osc", "Oscillators", h("div", { class: "oscs" }, col(1), col(2), col(3)));
}

function mixer(ui) {
  return section("mix", "Mixer",
    h("div", { class: "faders" },
      fader(ui, "mx_o1", { label: "Osc 1" }), fader(ui, "mx_o2", { label: "Osc 2" }), fader(ui, "mx_o3", { label: "Osc 3" }),
      fader(ui, "mx_ring", { label: "Ring" }), fader(ui, "mx_noise", { label: "Noise" })),
    row(knob(ui, "noise_col", { label: "Noise Col", size: "s" }), knob(ui, "pre_od", { label: "Overdrive", size: "s" }),
      knob(ui, "post_dist", { label: "Post Dist", size: "s" }), knob(ui, "vca_gain", { label: "VCA", size: "s" })));
}

function filter(ui) {
  return section("flt", "Filter",
    h("div", { class: "flt-top" }, segmented(ui, "flt_type")),
    vizCanvas(ui, ["flt_type", "flt_cut", "flt_res", "flt_env"], drawFilter(ui), "viz wide"),
    h("div", { class: "flt-main" },
      knob(ui, "flt_cut", { label: "Frequency", size: "l", accent: true }),
      h("div", { class: "grid4" },
        knob(ui, "flt_res", { label: "Resonance" }), knob(ui, "flt_drive", { label: "Drive" }),
        knob(ui, "flt_env", { label: "Env 1" }), knob(ui, "flt_ae", { label: "Amp Env" }),
        knob(ui, "flt_lfo", { label: "LFO 1" }), knob(ui, "flt_key", { label: "Key Trk" }),
        knob(ui, "flt_vel", { label: "Velocity" }), knob(ui, "flt_div", { label: "Diverge" }))),
    row(knob(ui, "flt_o3", { label: "Osc 3 FM", size: "s" }), knob(ui, "flt_ns", { label: "Noise FM", size: "s" })));
}

function envelopes(ui) {
  const pres = ["ae", "m1", "m2"];
  let pre = "ae";
  const keys = pres.flatMap((p) => ["a", "d", "s", "r", "dly", "hold", "rep"].map((s) => `${p}_${s}`));
  const viz = vizCanvas(ui, keys, drawEnv(ui, () => pre), "viz wide");
  const t = tabs("Envelope", ["Amp", "Mod 1", "Mod 2"], (i) => {
    const p = pres[i];
    return h("div", { class: "env" },
      h("div", { class: "faders" }, fader(ui, `${p}_a`, { label: "Attack" }), fader(ui, `${p}_d`, { label: "Decay" }),
        fader(ui, `${p}_s`, { label: "Sustain" }), fader(ui, `${p}_r`, { label: "Release" })),
      h("div", { class: "env-side" },
        knob(ui, `${p}_hold`, { label: "Hold", size: "s" }), knob(ui, `${p}_dly`, { label: "Delay", size: "s" }),
        knob(ui, `${p}_vel`, { label: "Velocity", size: "s" }), knob(ui, `${p}_rep`, { label: "Repeats", size: "s" }),
        select(ui, `${p}_trig`, { label: "Trigger" })));
  }, (i) => { pre = pres[i]; viz.redraw(); });
  return section("env", "Envelopes", t.bar, viz, ...t.bodies);
}

function lfos(ui) {
  let n = 1;
  const keys = [1, 2, 3, 4].flatMap((i) => ["wave", "phase", "fade", "dly", "slew", "fmode", "rep"].map((s) => `l${i}_${s}`));
  const viz = vizCanvas(ui, keys, drawLfo(ui, () => n), "viz wide");
  const t = tabs("LFO", ["1", "2", "3 · global", "4 · global"], (i) => {
    const k = (f) => `l${i + 1}_${f}`;
    const voice = i < 2; // LFO 1/2 are per voice; 3/4 are global with one wide rate range
    const rate = knob(ui, k("rate"), { label: "Rate", accent: true });
    ui.store.bind(k("sync"), (v) => rate.classList.toggle("off", Math.round(v) > 0));
    if (voice) ui.store.bind(k("range"), () => ui.store.notify(k("rate"))); // the reading depends on the range
    return h("div", { class: "lfo" },
      h("div", { class: "lfo-top" }, segmented(ui, k("wave"), { icons: LFO_ICONS }), voice ? segmented(ui, k("range")) : null),
      row(rate, select(ui, k("sync"), { label: "Sync" }), knob(ui, k("phase"), { label: "Phase" }), select(ui, k("trig"), { label: "Mode" })),
      row(knob(ui, k("fade"), { label: "Fade", size: "s" }), select(ui, k("fmode"), { label: "Fade Mode" }),
        knob(ui, k("dly"), { label: "Delay", size: "s" }), knob(ui, k("slew"), { label: "Slew", size: "s" }),
        knob(ui, k("rep"), { label: "Repeats", size: "s" })),
      voice ? row(segmented(ui, k("mtrig"), { label: "MonoTrig" }), segmented(ui, k("fsync"), { label: "FadeSync" })) : null);
  }, (i) => { n = i + 1; viz.redraw(); });
  return section("lfo", "LFOs", t.bar, viz, ...t.bodies);
}

function fm(ui) {
  return section("fm", "FM",
    vizCanvas(ui, ["fm_12", "fm_23", "fm_31", "fm_n1"], drawFm(ui), "viz fmv"),
    row(knob(ui, "fm_12", { label: "1 → 2" }), knob(ui, "fm_23", { label: "2 → 3" }),
      knob(ui, "fm_31", { label: "3 → 1" }), knob(ui, "fm_n1", { label: "Noise → 1" })));
}

function voice(ui) {
  return section("voice", "Voice",
    segmented(ui, "v_mode"),
    row(knob(ui, "v_unison", { label: "Unison" }), knob(ui, "v_udet", { label: "Detune" }),
      knob(ui, "v_spread", { label: "Spread" }), knob(ui, "v_glide", { label: "Glide" })),
    row(segmented(ui, "v_gmode", { label: "Glide" }), knob(ui, "v_bend", { label: "Bend", size: "s" }),
      knob(ui, "v_oct", { label: "Octave", size: "s" })),
    row(knob(ui, "v_div", { label: "Diverge", size: "s" }), knob(ui, "v_drift", { label: "Drift", size: "s" }),
      segmented(ui, "osc_reset", { label: "Osc Phase" })));
}

function arp(ui) {
  return section("arp", "Arpeggiator",
    h("div", { class: "arp-top" }, led(ui, "arp_on", { label: "On", class: "big" }), led(ui, "arp_latch", { label: "Latch" }),
      led(ui, "arp_ksync", { label: "Key Sync" })),
    row(select(ui, "arp_mode", { label: "Type" }), select(ui, "arp_rate", { label: "Rate" }),
      select(ui, "arp_scale", { label: "Scale" })),
    vizCanvas(ui, ["arp_rhy"], drawRhythm(ui), "viz rhythm"),
    row(knob(ui, "arp_rhy", { label: "Rhythm" }), knob(ui, "arp_oct", { label: "Octaves" }),
      knob(ui, "arp_gate", { label: "Gate" }), knob(ui, "arp_swing", { label: "Swing" })));
}

function effects(ui) {
  const block = (title, ...kids) => h("div", { class: "fxb" }, h("h3", {}, title), ...kids);
  return section("fx", "Effects",
    h("div", { class: "fx-route" },
      vizCanvas(ui, ["fx_route", "dst_lvl", "cho_lvl", "dly_lvl", "rev_lvl"], drawRoute(ui), "viz routev"),
      h("div", { class: "fx-route-ctl" }, select(ui, "fx_route", { label: "Routing" }),
        row(knob(ui, "fx_dry", { label: "Dry", size: "s" }), knob(ui, "fx_wet", { label: "Wet", size: "s" })))),
    h("div", { class: "fxs" },
      block("Distortion", segmented(ui, "dst_type"), row(knob(ui, "dst_lvl", { label: "Drive", accent: true }),
        knob(ui, "dst_tone", { label: "Tone" }), knob(ui, "dst_mix", { label: "Mix" }))),
      block("Chorus", segmented(ui, "cho_type", { labels: ["1", "2", "Ens"] }),
        row(knob(ui, "cho_lvl", { label: "Level", accent: true }), knob(ui, "cho_rate", { label: "Rate" }), knob(ui, "cho_depth", { label: "Depth" })),
        row(knob(ui, "cho_dly", { label: "Delay", size: "s" }), knob(ui, "cho_fb", { label: "Feedback", size: "s" }),
          knob(ui, "cho_lp", { label: "LoPass", size: "s" }), knob(ui, "cho_hp", { label: "HiPass", size: "s" }))),
      block("Delay", segmented(ui, "dly_mode"),
        row(knob(ui, "dly_lvl", { label: "Level", accent: true }), knob(ui, "dly_time", { label: "Time" }), select(ui, "dly_sync", { label: "Sync" })),
        row(knob(ui, "dly_fb", { label: "Feedback", size: "s" }), knob(ui, "dly_lp", { label: "Low-pass", size: "s" }), knob(ui, "dly_hp", { label: "High-pass", size: "s" })),
        row(select(ui, "dly_ratio", { label: "L/R Ratio" }), knob(ui, "dly_width", { label: "Width", size: "s" }), knob(ui, "dly_slew", { label: "Slew", size: "s" }))),
      block("Reverb", segmented(ui, "rev_type"),
        row(knob(ui, "rev_lvl", { label: "Level", accent: true }), knob(ui, "rev_decay", { label: "Decay" }), knob(ui, "rev_size", { label: "Size" })),
        row(knob(ui, "rev_damp", { label: "Damping", size: "s" }), knob(ui, "rev_hp", { label: "Low Cut", size: "s" }), knob(ui, "rev_pre", { label: "Pre-dly", size: "s" })),
        row(knob(ui, "rev_lpf", { label: "LoPass", size: "s" }), knob(ui, "rev_hpf", { label: "HiPass", size: "s" }),
          knob(ui, "rev_mdep", { label: "Mod Dep", size: "s" }), knob(ui, "rev_mrate", { label: "Mod Rate", size: "s" })))));
}

function matrix(ui) {
  const n = ui.meta.mmSlots;
  let showAll = false, ready = false;
  const rows = [];
  const toggle = h("button", { type: "button", class: "chip", onclick: () => { showAll = !showAll; refresh(); } });
  const count = h("span", { class: "dim" });
  for (let i = 1; i <= n; i++) {
    const k = (f) => `mm${String(i).padStart(2, "0")}_${f}`;
    const r = h("div", { class: "mm-row", role: "row" },
      h("span", { class: "mm-n", role: "cell" }, String(i)),
      h("span", { role: "cell" }, select(ui, k("s1"), { label: false })),
      h("span", { class: "mm-x", role: "cell", "aria-hidden": "true" }, "×"),
      h("span", { role: "cell" }, select(ui, k("s2"), { label: false })),
      h("span", { class: "mm-x", role: "cell", "aria-hidden": "true" }, "→"),
      h("span", { role: "cell" }, select(ui, k("dst"), { label: false })),
      h("span", { role: "cell" }, depth(ui, k("dep"))),
      h("button", {
        type: "button", class: "mm-clear", title: `Clear slot ${i}`, "aria-label": `Clear slot ${i}`,
        onclick: () => { ui.store.beginGesture(); for (const f of ["s1", "s2", "dst", "dep"]) ui.store.set(k(f), 0); ui.store.endGesture(); },
      }, "✕"));
    const used = () => ui.store.get(k("s1")) > 0 && ui.store.get(k("dst")) > 0;
    r.used = used;
    rows.push(r);
    for (const f of ["s1", "dst", "dep"]) ui.store.bind(k(f), () => refresh());
  }
  function refresh() {
    if (!ready) return;
    let used = 0, firstFree = -1;
    rows.forEach((r, i) => {
      const u = r.used();
      used += u;
      if (!u && firstFree < 0) firstFree = i;
      r.classList.toggle("used", u);
      r.hidden = !showAll && !u && i !== firstFree;
    });
    count.textContent = `${used} of ${n} slots in use`;
    toggle.textContent = showAll ? "Show used" : "Show all";
  }
  ready = true;
  refresh();
  return section("mm", "Mod Matrix",
    h("div", { class: "mm-head" }, count, toggle),
    h("div", { class: "mm", role: "table", "aria-label": "Modulation matrix" },
      h("div", { class: "mm-row mm-th", role: "row" }, ...["#", "Source 1", "", "Source 2", "", "Destination", "Depth", ""].map((t) => h("span", { role: "columnheader" }, t))),
      rows));
}

function macros(ui) {
  const cards = [];
  for (let m = 1; m <= 8; m++) {
    const assigns = [];
    for (let a = 1; a <= 4; a++) {
      assigns.push(h("div", { class: "mac-as" }, select(ui, `mac${m}_d${a}`, { label: false }), depth(ui, `mac${m}_a${a}`)));
    }
    const det = h("details", { class: "mac-det" }, h("summary", {}, "Targets"), ...assigns);
    cards.push(h("div", { class: "mac" }, knob(ui, `mac${m}`, { label: `Macro ${m}` }), det));
  }
  return section("mac", "Macros & Animate",
    h("div", { class: "anim" },
      h("div", { class: "anim-1" }, led(ui, "anim1", { label: "Animate 1", class: "big" }), segmented(ui, "anim1_mode")),
      h("div", { class: "anim-1" }, led(ui, "anim2", { label: "Animate 2", class: "big" }), segmented(ui, "anim2_mode"))),
    h("div", { class: "macs" }, cards));
}

export function buildPanel(ui) {
  return h("main", { class: "panel", id: "panel" },
    oscillators(ui), mixer(ui), filter(ui), envelopes(ui), lfos(ui),
    fm(ui), voice(ui), arp(ui), effects(ui), matrix(ui), macros(ui));
}
