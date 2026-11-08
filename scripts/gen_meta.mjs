// node scripts/gen_meta.mjs [crest amino bizar pro8000v]: app/instruments/<id>/meta.json, read from the built engines.
//   { id, name, wasm, editor, presets: [{ name, cat }], params: [{ key, name, type, min, max, step?, options? }],
//     knobs: [key x 8] }
// The Schwung synths (Crest, Amino, Bizar) answer their own chain_params, preset_count / preset_name and ui_hierarchy;
// PRO-8000 V's presets come from its bank's metadata and its parameters from the plugin's names (engine/engine.cpp).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "app", "instruments");
const enc = new TextEncoder(), dec = new TextDecoder();

// Crest and Amino: web/wasm_host.c (wa_*), one instance per module instance
function waHost(path) {
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), {}).exports;
  x._initialize();
  if (x.wa_init(44100) !== 1) throw new Error(path + ": wa_init failed");
  const m = () => new Uint8Array(x.memory.buffer);
  const w = (p, s) => { const b = enc.encode(s); m().set(b, p); m()[p + b.length] = 0; };
  return {
    get(k) { w(x.wa_key(), k); const n = x.wa_get(); return n < 0 ? null : dec.decode(m().slice(x.wa_out(), x.wa_out() + n)); },
    set(k, v) { w(x.wa_key(), k); w(x.wa_val(), String(v)); x.wa_set(); },
  };
}

// Bizar: web/glue.c, the plugin's own function table
function bizarHost(path) {
  const ex = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), {}).exports;
  ex._initialize();
  const api = ex.sf_web_api(), T = ex.__indirect_function_table;
  const fn = (i) => T.get(new DataView(ex.memory.buffer).getUint32(api + 4 + 4 * i, true));
  const f = { create: fn(0), set: fn(3), get: fn(4) };
  const inst = f.create(0, 0), cap = 1 << 20, buf = ex.malloc(cap);
  const put = (s) => { const b = enc.encode(s), p = ex.malloc(b.length + 1), m = new Uint8Array(ex.memory.buffer); m.set(b, p); m[p + b.length] = 0; return p; };
  return {
    get(k) {
      const p = put(k), r = f.get(inst, p, buf, cap);
      ex.free(p);
      if (r < 0) return null;
      const m = new Uint8Array(ex.memory.buffer);
      let e = buf; while (m[e]) e++;
      return dec.decode(m.slice(buf, e));
    },
    set(k, v) { const a = put(k), b = put(String(v)); f.set(inst, a, b); ex.free(a); ex.free(b); },
  };
}

const PREFIX_CATS = {
  IN: "Init", BS: "Bass", BA: "Bass", SB: "Bass", LD: "Lead", LE: "Lead", PD: "Pad", PA: "Pad", PL: "Pluck", PK: "Pluck",
  KY: "Keys", KE: "Keys", KB: "Keys", EP: "Keys", OR: "Organ", BR: "Brass", ST: "Strings", SQ: "Sequence", SE: "Sequence",
  AR: "Arp", FX: "FX", SF: "FX", DR: "Drums", PC: "Perc", PE: "Perc", DT: "Texture", TX: "Texture", AT: "Atmos",
  AM: "Atmos", CH: "Chord", CD: "Chord", BL: "Bell", BE: "Bell", VX: "Vox", VO: "Vox", SY: "Synth", PO: "Poly", MO: "Mono",
  PY: "Poly", ML: "Multi-layer", TG: "Trance Gate", TR: "Trance", GT: "Gate", RV: "Rave", AC: "Acid", WB: "Wobble", DN: "Drone", HV: "Hoover",
};
const titleCase = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
function catFromName(name) {
  const m = /^([A-Z]{2})\s+\S/.exec(name);
  if (!m) return "Other";
  return PREFIX_CATS[m[1]] || m[1];
}

function paramsFrom(list) {
  const skip = new Set(["preset", "preset_count", "preset_name", "state", "name"]);
  const out = [];
  for (const p of list) {
    if (!p || !p.key || skip.has(p.key)) continue;
    if (p.access === "write" || p.access === "read" || p.readonly) continue;
    if (!["float", "int", "enum"].includes(p.type)) continue;
    const q = { key: p.key, name: p.name || p.key, type: p.type };
    if (p.type === "enum") {
      if (!Array.isArray(p.options) || p.options.length < 2) continue;
      q.options = p.options;
      q.min = 0; q.max = p.options.length - 1;
    } else {
      if (typeof p.min !== "number" || typeof p.max !== "number" || p.max <= p.min) continue;
      q.min = p.min; q.max = p.max;
      if (p.step) q.step = p.step;
    }
    if (p.unit) q.unit = p.unit;
    if (p.default !== undefined) q.default = p.default;
    out.push(q);
  }
  return out;
}

function schwung(id, name, wasmRel, host, { presetCat, knobsFallback }) {
  const dir = join(OUT, id);
  const wasm = join(dir, wasmRel);
  if (!existsSync(wasm)) { console.log(`   ${id}: not built, skipped`); return; }
  const e = host(wasm);
  const chain = JSON.parse(e.get("chain_params") || "[]");
  const params = paramsFrom(chain);
  const count = Number(e.get("preset_count") || 0);
  const list = JSON.parse(e.get("preset_list") || "null");
  const presets = [];
  for (let i = 0; i < count; i++) {
    let n = list && list[i];
    if (!n) { e.set("preset", i); n = e.get("preset_name") || `Preset ${i + 1}`; }
    presets.push({ name: n, cat: presetCat(i, n) });
  }
  let knobs = [];
  try { knobs = JSON.parse(e.get("ui_hierarchy") || "null")?.levels?.root?.knobs || []; } catch (_) { /* none */ }
  if (!knobs.length) knobs = knobsFallback();
  const keys = new Set(params.map((p) => p.key));
  knobs = knobs.filter((k) => keys.has(k));
  for (const p of params) { if (knobs.length >= 8) break; if (p.type === "float" && !knobs.includes(p.key)) knobs.push(p.key); }
  const meta = { id, name, kind: "schwung", api: host === bizarHost ? "bizar" : "wa", wasm: wasmRel, editor: "editor/web_ui.html",
                 presets, params, knobs: knobs.slice(0, 8), defaultPreset: id === "crest" ? 1 : 0 };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  console.log(`   ${id}: ${presets.length} presets, ${params.length} parameters, knobs ${meta.knobs.join(" ")}`);
}

function crest() {
  const ui = JSON.parse(readFileSync(join(OUT, "crest/editor/assets/ui/ui_meta.json"), "utf8"));
  const labels = ui.library.categoryLabels || {};
  schwung("crest", "Crest", "editor/assets/engine/crest.wasm", waHost, {
    presetCat: (i) => { const c = ui.library.presets[i]?.cat || "other"; return labels[c] || titleCase(c); },
    knobsFallback: () => [],
  });
}

function amino() {
  schwung("amino", "Amino", "amino.wasm", waHost, {
    presetCat: (_i, n) => catFromName(n),
    knobsFallback: () => {
      try { return JSON.parse(readFileSync(join(OUT, "amino/editor/ui_pages.json"), "utf8")).levels.root.knobs || []; } catch (_) { return []; }
    },
  });
}

function bizar() {
  schwung("bizar", "Bizar", "bizar.wasm", bizarHost, { presetCat: (_i, n) => catFromName(n), knobsFallback: () => [] });
}

function pro8000v() {
  const dir = join(OUT, "pro8000v");
  if (!existsSync(join(dir, "pro8000v.wasm"))) { console.log("   pro8000v: not built, skipped"); return; }
  const src = readFileSync(join(ROOT, "vendor/pro-8000-vst/engine/engine.cpp"), "utf8");
  const block = /kParamNames\[[^\]]*\]\s*=\s*\{([\s\S]*?)\};/.exec(src);
  if (!block) throw new Error("engine.cpp: kParamNames not found");
  const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const params = names.map((n, i) => ({ key: "p" + i, name: n, type: "float", min: 0, max: 1, index: i }));
  const pm = JSON.parse(readFileSync(join(dir, "presets-meta.json"), "utf8"));
  const presets = [];
  for (const s of Object.keys(pm.slots).map(Number).sort((a, b) => a - b))
    presets.push({ name: pm.slots[s].name, cat: titleCase(pm.slots[s].group || "other"), slot: s - 1 });
  const byName = (n) => "p" + names.indexOf(n);
  const knobs = ["Cutoff", "Resonance", "Filter Env Amount", "Filter Decay", "Amp Attack", "Amp Release", "LFO Amount", "Noise"].map(byName);
  const meta = { id: "pro8000v", name: "PRO-8000 V", kind: "p8", wasm: "pro8000v.wasm", editor: "editor/index.html",
                 presets, params, knobs, defaultPreset: 0 };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  console.log(`   pro8000v: ${presets.length} presets, ${params.length} parameters`);
}

const which = process.argv.slice(2);
const all = { crest, amino, bizar, pro8000v };
for (const w of which.length ? which : Object.keys(all)) {
  const k = w === "p8" || w === "pro-8000-v" ? "pro8000v" : w;
  if (!all[k]) { console.error("unknown instrument " + w); process.exit(2); }
  all[k]();
}
// the list the DAW reads first
const index = Object.keys(all).filter((k) => existsSync(join(OUT, k, "meta.json")))
  .map((k) => { const m = JSON.parse(readFileSync(join(OUT, k, "meta.json"), "utf8")); return { id: m.id, name: m.name }; });
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1));
