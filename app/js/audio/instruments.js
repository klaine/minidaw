// The instruments a MIDI track can host, behind one interface:
//   noteOn(note, vel, time) noteOff(note, time) midi(bytes, time) setNorm(key, v01, time) loadPreset(i)
//   getState() -> state (JSON-able) setState(state) stop() tempo(bpm, run) flushEvents() flush() connect(node)
// Crest, Amino and Bizar run in the "schwung" processor (worklets/daw-worklet.js), PRO-8000 V in "pro8000v"
// (worklets/p8-worklet.js), the Drum Rack on the main thread with sample players (drumrack.js).
import { DrumRack } from "./drumrack.js";

const BASE = new URL("../../instruments/", import.meta.url);
const metas = new Map();
const wasms = new Map();
let p8bank = null;

export const instrumentUrl = (kind, rel) => new URL(kind + "/" + rel, BASE).href;

export async function loadMeta(kind) {
  if (kind === "drumrack") return { id: "drumrack", name: "Drum Rack", kind: "drumrack", presets: [], params: [], knobs: [] };
  if (!metas.has(kind)) {
    metas.set(kind, fetch(instrumentUrl(kind, "meta.json")).then((r) => {
      if (!r.ok) throw new Error(kind + " meta.json: HTTP " + r.status);
      return r.json();
    }));
  }
  return metas.get(kind);
}
export const metaSync = (kind) => {
  const m = metas.get(kind);
  return m && m.resolved ? m.value : null;
};

async function wasmBytes(kind) {
  if (!wasms.has(kind)) {
    wasms.set(kind, (async () => {
      const meta = await loadMeta(kind);
      const r = await fetch(instrumentUrl(kind, meta.wasm));
      if (!r.ok) throw new Error(kind + " wasm: HTTP " + r.status);
      return r.arrayBuffer();
    })());
  }
  return wasms.get(kind);
}

async function p8Bank() {
  if (!p8bank) p8bank = fetch(instrumentUrl("pro8000v", "presets.p8bank")).then((r) => r.arrayBuffer());
  return p8bank;
}

/** Worklet modules, once per context */
const contextsReady = new WeakMap();
export function prepareContext(ctx) {
  if (!contextsReady.has(ctx)) {
    contextsReady.set(ctx, Promise.all([
      ctx.audioWorklet.addModule(new URL("../worklets/daw-worklet.js", import.meta.url).href),
      ctx.audioWorklet.addModule(new URL("../worklets/p8-worklet.js", import.meta.url).href),
    ]));
  }
  return contextsReady.get(ctx);
}

// the kinds whose wasm a context has already compiled (its processors keep the module)
const compiledIn = new WeakMap();

/** A new instrument of `kind` in `ctx`, its state restored when given */
export async function createInstrument(ctx, kind, { state, preset, samples, track } = {}) {
  await prepareContext(ctx);
  const meta = await loadMeta(kind);
  metas.get(kind).resolved = true; metas.get(kind).value = meta;
  if (kind === "drumrack") return new DrumRack(ctx, track, samples);
  let set = compiledIn.get(ctx);
  if (!set) compiledIn.set(ctx, (set = new Set()));
  const bytes = await wasmBytes(kind);
  const first = !set.has(kind);
  let node;
  if (meta.kind === "p8") {
    node = new AudioWorkletNode(ctx, "pro8000v", {
      numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { wasm: first ? bytes.slice(0) : null, bank: await p8Bank() },
    });
  } else {
    node = new AudioWorkletNode(ctx, "schwung", {
      numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { kind, api: meta.api, wasm: first ? bytes.slice(0) : null },
    });
  }
  const inst = meta.kind === "p8" ? new P8Instrument(ctx, meta, node) : new SchwungInstrument(ctx, meta, node);
  const ready = await inst.ready;
  if (!ready.ok) throw new Error(meta.name + " didn't start: " + (ready.error || "unknown error"));
  set.add(kind);
  if (state) await inst.setState(state);
  else await inst.loadPreset(preset ?? meta.defaultPreset ?? 0);
  return inst;
}

class WorkletInstrument {
  constructor(ctx, meta, node) {
    this.ctx = ctx;
    this.meta = meta;
    this.kind = meta.id;
    this.node = node;
    this.output = node;
    this.pending = new Map();
    this.nextId = 1;
    this.queue = [];
    this.listeners = new Set();
    this.params = new Map(meta.params.map((p) => [p.key, p]));
    this.ready = new Promise((resolve) => { this.readyResolve = resolve; });
    node.port.onmessage = (e) => this.onMessage(e.data);
  }
  onMessage(d) {
    if (d.t === "ready") { this.readyResolve(d); return; }
    if (d.id && this.pending.has(d.id)) {
      const fn = this.pending.get(d.id);
      this.pending.delete(d.id);
      fn(d);
      return;
    }
    for (const fn of this.listeners) fn(d);
  }
  /** Messages the engine sends unasked (the editors listen) */
  listen(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  post(msg) { this.node.port.postMessage(msg); }
  request(msg) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.node.port.postMessage({ ...msg, id });
    });
  }
  connect(dest) { this.node.connect(dest); }
  disconnect() { try { this.node.disconnect(); } catch (_) { /* not connected */ } }
  dispose() { this.stop(); this.disconnect(); this.node.port.onmessage = null; }
  midi(m, time = 0) { this.queue.push({ time, m }); if (!time) this.flushEvents(); }
  noteOn(note, vel, time = 0) { this.midi([0x90, note & 127, Math.max(1, Math.min(127, vel | 0))], time); }
  noteOff(note, time = 0) { this.midi([0x80, note & 127, 0], time); }
  flushEvents() {
    if (!this.queue.length) return;
    this.post({ t: "ev", list: this.queue });
    this.queue = [];
  }
  flush() { this.flushEvents(); return this.request({ t: "flush" }); }
  stop() { this.queue = []; this.post({ t: "stop" }); }
  /** v01 -> the parameter's range: the value a set_param (or the editor's knob) takes */
  denorm(key, v) {
    const p = this.params.get(key);
    if (!p) return null;
    let x = p.min + (p.max - p.min) * v;
    if (p.type === "int" || p.type === "enum") x = Math.round(x);
    return x;
  }
}

class SchwungInstrument extends WorkletInstrument {
  setNorm(key, v, time = 0) {
    const x = this.denorm(key, v);
    if (x === null) return;
    this.queue.push({ time, key, val: String(x) });
    if (!time) this.flushEvents();
  }
  set(key, val) { this.post({ t: "set", key, val: String(val) }); }
  get(key) { return this.request({ t: "get", key }).then((d) => d.val); }
  async getNorm(key) {
    const p = this.params.get(key), v = Number(await this.get(key));
    if (!p || !isFinite(v)) return null;
    return (v - p.min) / (p.max - p.min);
  }
  tempo(bpm, run) { this.post({ t: "tempo", bpm, run: !!run }); }
  async loadPreset(i) { this.set("preset", i); await this.get("preset"); }
  async getState() { return { state: await this.get("state") }; }
  async setState(s) { if (s && s.state) { this.set("state", s.state); await this.get("preset"); } }
  async presetName() { return (await this.get("preset_name")) || ""; }
}

const P8_HDR = [0xf0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x24, 0x00];
const b64 = {
  enc(u8) { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); },
  dec(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; },
};

class P8Instrument extends WorkletInstrument {
  setNorm(key, v, time = 0) {
    const p = this.params.get(key);
    if (!p) return;
    const q = Math.round(Math.max(0, Math.min(1, v)) * 16383);
    this.queue.push({ time, m: [...P8_HDR, 0x52, 0, p.index, q >> 7, q & 0x7f, 0xf7] });
    if (!time) this.flushEvents();
  }
  async getNorm(key) {
    const p = this.params.get(key);
    if (!p) return null;
    // the firmware's parameter dump (0x53): two 7-bit bytes per parameter (as PRO-8000 V's own test reads them)
    return new Promise((resolve) => {
      const off = this.listen((d) => {
        if (d.t !== "midi") return;
        const r = d.list.find((m) => m[8] === 0x53);
        if (!r) return;
        off();
        resolve((r[11 + 2 * p.index] << 7 | r[12 + 2 * p.index]) / 16383);
      });
      this.post({ t: "send", m: [...P8_HDR, 0x53, 0, 0xf7] });
      setTimeout(() => { off(); resolve(null); }, 500);
    });
  }
  tempo() { /* the firmware keeps its own tempo; MIDI clock could drive it */ }
  async loadPreset(i) {
    const pr = this.meta.presets[i];
    const slot = pr ? pr.slot : i;
    this.post({ t: "send", m: [0xc0, slot & 127] });
    this.post({ t: "fxDefaults" });
    this.slot = slot;
    this.name = pr ? pr.name : "";
    await this.flush();
  }
  async getState() {
    // the record keeps the name it's given (an empty one is blank): the patch's own
    const cap = await this.request({ t: "capture", name: this.name || "" });
    const fx = await this.request({ t: "fxValues" });
    return { record: cap.record ? b64.enc(cap.record) : null, fx: fx.values, slot: this.slot | 0, name: this.name || "" };
  }
  async setState(s) {
    if (!s) return;
    if (s.record) await this.request({ t: "load", record: b64.dec(s.record).buffer, slot: s.slot | 0 });
    if (s.fx) this.post({ t: "fxSet", values: s.fx });
    this.slot = s.slot | 0;
    this.name = s.name || "";
    await this.flush();
  }
  async presetName() { return this.name || ""; }
}
