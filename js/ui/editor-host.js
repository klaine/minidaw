// The instruments' own editors, full screen over the DAW: Crest's, Amino's and Bizar's Remote UI (their
// schwungRemote answered by instruments/shared/schwung-remote.js) and PRO-8000 V's firmware editor (its p8_send /
// p8_call answered by instruments/shared/p8-daw.js). Each edits its track's engine through a bridge made here.
import { h } from "../util.js";
import { instrumentUrl, metaSync } from "../audio/instruments.js";
import { toast } from "./controls.js";

const META_KEYS = new Set(["fmt", "v", "rev", "name", "version"]);
const EXTRA_KEYS = ["preset", "preset_name", "preset_count", "edit_layer"];

class SchwungBridge {
  constructor(app, trackId, inst) {
    this.app = app;
    this.trackId = trackId;
    this.inst = inst;
    this.values = {};
    this.listeners = new Set();
    this.written = new Set();
    this.extraKeys = [];
    this.alive = true;
    this.midiFns = [];
    this.first = this.refresh();
  }
  async snapshot() {
    const inst = this.inst;
    const out = {};
    try {
      const st = JSON.parse((await inst.get("state")) || "{}");
      for (const k in st) if (!META_KEYS.has(k)) out[k] = typeof st[k] === "string" ? st[k] : String(st[k]);
    } catch (_) { /* no state */ }
    for (const k of EXTRA_KEYS) { const v = await inst.get(k); if (v !== null && v !== undefined) out[k] = v; }
    // Amino reports the focused layer's bare aliases as well
    if (out.edit_layer) { const pre = "l" + out.edit_layer + "_"; for (const k of Object.keys(out)) if (k.startsWith(pre)) out[k.slice(pre.length)] = out[k]; }
    return out;
  }
  refresh() {
    if (this.refreshing) { this.dirty = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.dirty = false;
        const now = await this.snapshot();
        const changed = {};
        for (const k in now) if (this.values[k] !== now[k] && !this.written.has(k)) changed[k] = now[k];
        this.values = now;
        this.written.clear();
        if (Object.keys(changed).length) this.emit(changed);
      } while (this.dirty);
      this.refreshing = null;
    })();
    return this.refreshing;
  }
  emit(changed) { for (const cb of [...this.listeners]) { try { cb(changed); } catch (e) { console.error(e); } } }
  subscribe(cb) {
    this.listeners.add(cb);
    this.first.then(() => cb(Object.assign({}, this.values)));
    if (!this.pumping) this.pump();
    return () => this.listeners.delete(cb);
  }
  async pump() {
    this.pumping = true;
    while (this.alive) {
      await new Promise((r) => setTimeout(r, this.touched ? 150 : 500));
      this.touched = false;
      if (!this.alive || document.hidden || !this.extraKeys.length) continue;
      const changed = {};
      for (const k of this.extraKeys) { const v = await this.inst.get(k); if (v !== null && this.values[k] !== v) { this.values[k] = v; changed[k] = v; } }
      if (Object.keys(changed).length) this.emit(changed);
    }
  }
  set(key, val) {
    this.inst.set(key, val);
    this.touched = true;
    if (key !== "preset" && key !== "state") this.written.add(key); else this.written.clear();
    this.values[key] = String(val);
    this.app.store.ui.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), key === "preset" || key === "state" ? 30 : 200);
    if (key === "preset") this.presetChanged = true;
  }
  get(key) { return this.inst.get(key); }
  async hierarchy() {
    const v = await this.inst.get("ui_hierarchy");
    if (v) { try { return JSON.parse(v); } catch (_) { /* not JSON */ } }
    const r = await fetch(instrumentUrl(this.inst.kind, "editor/ui_pages.json")).catch(() => null);
    return r && r.ok ? r.json() : null;
  }
  async chainParams() {
    const v = (await this.inst.get("chain_params_full")) || (await this.inst.get("chain_params"));
    let list = null;
    try { list = JSON.parse(v); } catch (_) { return null; }
    for (const p of list || []) for (const k of (p.viz && p.viz.extra_keys) || []) if (!this.extraKeys.includes(k)) this.extraKeys.push(k);
    return list;
  }
  noteOn(n, v) { const t = this.app.store.track(this.trackId); if (t) this.app.liveNote(true, n, v, [t]); }
  noteOff(n) { const t = this.app.store.track(this.trackId); if (t) this.app.liveNote(false, n, 0, [t]); }
  panic() { this.inst.midi([0xb0, 123, 0]); this.inst.midi([0xb0, 120, 0]); }
  onMidi(fn) { this.midiFns.push(fn); }
  dispose() { this.alive = false; this.listeners.clear(); }
}

class P8Bridge {
  constructor(app, trackId, inst) {
    this.app = app;
    this.trackId = trackId;
    this.inst = inst;
    this.offs = [];
  }
  bank() { return fetch(instrumentUrl("pro8000v", "presets.p8bank")).then((r) => r.arrayBuffer()); }
  presets() { return this.inst.meta.presets; }
  slot() { return this.inst.slot | 0; }
  version() { return "PRO-8000"; }
  post(msg) { this.inst.post(msg); }
  ask(msg) { return this.inst.request(msg); }
  listen(fn) { this.offs.push(this.inst.listen(fn)); }
  changed() { this.app.store.ui.dirty = true; this.edited = true; }
  dispose() { this.offs.forEach((f) => f()); this.offs = []; }
}

export class EditorHost {
  constructor(app) {
    this.app = app;
    this.bridges = new Map();
    this.el = null;
  }

  /** The bridge an editor's page asks for (window.parent.minidaw.editorBridge) */
  bridge(trackId) {
    if (this.bridges.has(trackId)) return this.bridges.get(trackId);
    const inst = this.app.engine.instrument(trackId);
    if (!inst || inst.kind === "drumrack") return null;
    const b = inst.meta.kind === "p8" ? new P8Bridge(this.app, trackId, inst) : new SchwungBridge(this.app, trackId, inst);
    this.bridges.set(trackId, b);
    return b;
  }

  open(trackId) {
    const app = this.app;
    const t = app.store.track(trackId);
    const inst = app.engine.instrument(trackId);
    if (!t || !inst || t.type !== "midi" || t.instrument.kind === "drumrack") { toast("This track's instrument hasn't loaded yet"); return; }
    this.close();
    const meta = metaSync(t.instrument.kind);
    const src = instrumentUrl(t.instrument.kind, meta.editor) + "?track=" + encodeURIComponent(trackId);
    const frame = h("iframe", { class: "editor-frame", src, title: meta.name + " editor", allow: "midi" });
    const kbdBtn = h("button", { type: "button", class: "btn small", onclick: () => this.toggleKeys() }, "Keys");
    this.keysBox = h("div", { class: "editor-keys", hidden: true });
    this.el = h("div", { class: "editor-veil" },
      h("div", { class: "editor-box", style: { "--tc": t.color } },
        h("div", { class: "editor-head" },
          h("span", { class: "editor-dot" }),
          h("span", { class: "editor-title" }, meta.name + " · " + t.name),
          h("span", { class: "dim editor-hint" }, "The instrument's own editor, on this track's engine"),
          kbdBtn,
          h("button", { type: "button", class: "btn primary small", onclick: () => this.close() }, "Done")),
        frame, this.keysBox));
    document.body.append(this.el);
    this.trackId = trackId;
  }

  async toggleKeys() {
    if (!this.keysBox) return;
    this.keysBox.hidden = !this.keysBox.hidden;
    if (!this.keysBox.hidden && !this.keysBox.firstChild) {
      const { KeysView } = await import("./keyboard.js");
      const t = this.app.store.track(this.trackId);
      this.keys = new KeysView(this.app, t);
      this.keysBox.append(this.keys.el);
    }
  }

  async close() {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    if (this.keys) { this.keys.dispose(); this.keys = null; }
    const id = this.trackId;
    const b = this.bridges.get(id);
    this.bridges.delete(id);
    if (b) b.dispose();
    const inst = this.app.engine.instrument(id);
    if (inst && b && (b.presetChanged || b.edited || b instanceof SchwungBridge)) {
      const name = await inst.presetName();
      this.app.store.update((p) => {
        const t = p.tracks.find((x) => x.id === id);
        if (t && t.instrument) { t.instrument.presetName = name || t.instrument.presetName; }
      }, "preset");
      this.app.save();
    }
    this.app.views.panel.key = "";
    this.app.views.panel.update();
  }
}
