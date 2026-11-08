// minidaw: the app. Boots the audio on the first tap (a browser starts audio only from a gesture), keeps the project
// in IndexedDB, and wires the store, the engine, the transport and the views together.
import { Store } from "./store.js";
import { db, persistStorage } from "./db.js";
import { newProject, newTrack, migrate, INSTRUMENT_KINDS, kindName } from "./model.js";
import { SampleBank } from "./audio/samples.js";
import { AudioEngine } from "./audio/engine.js";
import { Transport } from "./audio/transport.js";
import { prepareContext, loadMeta } from "./audio/instruments.js";
import { h, debounce, deepCopy } from "./util.js";
import { toast } from "./ui/controls.js";
import { Topbar } from "./ui/topbar.js";
import { ArrangeView } from "./ui/arrange.js";
import { SessionView } from "./ui/session.js";
import { MixerView } from "./ui/mixer.js";
import { Panel } from "./ui/panel.js";
import { EditorHost } from "./ui/editor-host.js";
import { Recording } from "./recording.js";
import { demoProject } from "./demo.js";
import { MidiInput } from "./midi.js";
import { setupDrop } from "./ui/import.js";

class App {
  constructor() {
    this.samples = new SampleBank();
    this.store = new Store(newProject());
    this.ctx = null;
    this.views = {};
  }

  async boot() {
    const btn = document.getElementById("boot-start");
    const msg = document.getElementById("boot-msg");
    if (!window.AudioWorkletNode || !window.WebAssembly) {
      btn.textContent = "Not supported";
      msg.textContent = "This browser has no AudioWorklet or WebAssembly. Use a current Safari, Chrome, Edge or Firefox.";
      return;
    }
    if (!window.isSecureContext) msg.textContent = "Audio needs https:// or localhost; this page is " + location.origin;
    // fetch the instruments' metadata while waiting for the tap
    Promise.all(INSTRUMENT_KINDS.map((k) => loadMeta(k.kind).catch((e) => { console.warn(e); return null; })));
    btn.disabled = false;
    btn.textContent = "Start";
    btn.addEventListener("click", () => this.start().catch((e) => {
      console.error(e);
      btn.disabled = false;
      btn.textContent = "Try again";
      msg.textContent = "It didn't start: " + (e.message || e);
    }), { once: false });
    if ("serviceWorker" in navigator && location.protocol !== "file:" && !/[?&]nosw/.test(location.search)) {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("service worker", e));
    }
  }

  async start() {
    if (this.ctx) return;
    const btn = document.getElementById("boot-start");
    btn.disabled = true;
    btn.textContent = "Starting…";
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (_) { /* Safari 16.4+ only */ }
    const ctx = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
    this.ctx = ctx;
    // iOS: resume inside the gesture
    ctx.resume();
    await prepareContext(ctx);
    this.engine = new AudioEngine(ctx, this.samples);
    this.engine.trackLookup = (id) => this.store.track(id);
    this.transport = new Transport(this.engine, () => this.store.project);
    this.recording = new Recording(this);
    persistStorage();

    let project = null;
    const last = await db.get("lastProject").catch(() => null);
    if (last) project = await db.loadProject(last).catch(() => null);
    if (!project) project = demoProject();
    await this.openProject(migrate(project), { quiet: true });

    this.buildUI();
    document.getElementById("boot").remove();
    this.store.on("change", (c) => this.onChange(c));
    this.store.on("select", () => this.views.panel.update());
    this.transport.on((what) => this.onTransport(what));
    this.engine.onInstrument((id, inst, err) => {
      if (err) toast(`${kindName(this.store.track(id)?.instrument?.kind)} didn't load: ${err}`, 5000);
      this.views.panel.update();
    });
    this.midi = new MidiInput(this);
    setupDrop(this);
    this.loop();
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.save(); });
    window.addEventListener("pagehide", () => this.save());
    setInterval(() => { if (this.store.ui.dirty) this.save(); }, 15000);
    if (ctx.state !== "running") {
      // iOS may need one more touch
      const resume = () => { ctx.resume(); if (ctx.state === "running") document.removeEventListener("pointerdown", resume); };
      document.addEventListener("pointerdown", resume);
    }
  }

  buildUI() {
    const root = document.getElementById("app");
    root.textContent = "";
    this.topbar = new Topbar(this);
    const views = h("main", { class: "views" });
    this.views.arrange = new ArrangeView(this);
    this.views.session = new SessionView(this);
    this.views.mixer = new MixerView(this);
    views.append(this.views.arrange.el, this.views.session.el, this.views.mixer.el);
    this.viewsEl = views;
    const splitter = h("div", { class: "splitter", title: "Drag to resize" }, h("span"));
    this.views.panel = new Panel(this);
    this.editorHost = new EditorHost(this);
    root.append(this.topbar.el, views, splitter, this.views.panel.el);
    this.setupSplitter(splitter);
    this.setView(this.store.ui.view);
    this.views.panel.update();
  }

  setupSplitter(el) {
    let start = null;
    const saved = parseFloat(localStorage.getItem("minidaw.panelH") || "0");
    if (saved) document.documentElement.style.setProperty("--panel-h", saved + "px");
    el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); start = { y: e.clientY, h: this.views.panel.el.getBoundingClientRect().height }; });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      const hgt = Math.max(120, Math.min(innerHeight - 160, start.h + (start.y - e.clientY)));
      document.documentElement.style.setProperty("--panel-h", hgt + "px");
    });
    const end = () => {
      if (!start) return;
      start = null;
      try { localStorage.setItem("minidaw.panelH", String(this.views.panel.el.getBoundingClientRect().height)); } catch (_) { /* private mode */ }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", () => {
      const cur = this.views.panel.el.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--panel-h", (cur > 200 ? 120 : Math.round(innerHeight * 0.42)) + "px");
    });
  }

  setView(v) {
    this.store.ui.view = v;
    for (const k of ["arrange", "session", "mixer"]) this.views[k].el.hidden = k !== v;
    this.views[v].update({ reason: "view" });
    this.topbar.update();
  }

  // ---- changes ----
  onChange(c) {
    const p = this.store.project;
    this.engine.sync(p);
    if (c.reason !== "live-mixer") this.transport.refreshAutomated();
    for (const k of ["arrange", "session", "mixer"]) if (k === this.store.ui.view) this.views[k].update(c);
    if (!c.live || c.reason === "notes") this.views.panel.update(c);
    this.topbar.update();
    if (!c.live) this.saveSoon();
  }

  onTransport(what) {
    this.topbar.update();
    if (this.store.ui.view === "session") this.views.session.update({ reason: "transport" });
    if (what === "stop" || what === "seek") this.views.arrange.update({ reason: "transport" });
  }

  /** The frame loop: playhead, meters, session clip progress */
  loop() {
    const frame = () => {
      try {
        const v = this.store.ui.view;
        this.views[v].frame && this.views[v].frame();
        this.views.panel.frame();
        this.topbar.frame();
      } catch (e) { console.error(e); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ---- projects ----
  async openProject(p, { quiet } = {}) {
    if (this.transport && this.transport.playing) this.transport.stop();
    if (this.transport) this.transport.session.clear();
    this.store.setProject(p);
    // samples first (the drum rack and audio clips need their buffers), then the instruments with their states
    const ids = [];
    for (const c of Object.values(p.clips)) if (c.type === "audio") ids.push(c.sampleId);
    for (const t of p.tracks) if (t.instrument && t.instrument.kind === "drumrack") for (const pad of t.instrument.state.pads) ids.push(pad.sample);
    await this.samples.loadAll(ids, this.ctx);
    this.engine.dispose();
    await this.engine.sync(p);
    this.transport.position = 0;
    this.transport.applyStatic();
    this.store.ui.dirty = false;
    await db.set("lastProject", p.id).catch(() => {});
    if (!quiet) toast("Opened " + p.name);
  }

  saveSoon = debounce(() => this.save(), 2500);

  /** The project with every instrument's current sound, into IndexedDB */
  async save() {
    if (!this.engine || this.saving) return;
    this.saving = true;
    try {
      const states = await this.engine.collectStates();
      const p = this.store.project;
      for (const t of p.tracks) if (states.has(t.id) && t.instrument) t.instrument.state = states.get(t.id);
      await db.saveProject(deepCopy(p));
      await db.set("lastProject", p.id);
      this.store.ui.dirty = false;
      this.topbar.update();
    } catch (e) {
      console.error("save", e);
    } finally {
      this.saving = false;
    }
  }

  async newProject() {
    await this.save();
    const p = newProject("Untitled " + new Date().toLocaleDateString());
    const drums = newTrack(p, "midi", "drumrack");
    p.tracks.push(drums);
    const synth = newTrack(p, "midi", "crest");
    p.tracks.push(synth);
    p.tracks.push(newTrack(p, "audio"));
    await this.openProject(p);
    this.save();
  }

  // ---- tracks ----
  async addTrack(type, kind) {
    const p = this.store.project;
    const t = newTrack(p, type, kind);
    const sel = this.store.selectedTrack;
    const at = sel ? p.tracks.indexOf(sel) + 1 : p.tracks.length;
    this.store.update((p) => p.tracks.splice(at, 0, t), "tracks");
    this.store.select({ selTrack: t.id, panel: "device" });
    if (kind === "drumrack") await this.samples.loadAll(t.instrument.state.pads.map((x) => x.sample), this.ctx);
    return t;
  }

  async deleteTrack(id) {
    const states = await this.engine.collectStates();
    this.store.update((p) => {
      for (const t of p.tracks) if (states.has(t.id) && t.instrument) t.instrument.state = states.get(t.id);
      const i = p.tracks.findIndex((t) => t.id === id);
      if (i >= 0) p.tracks.splice(i, 1);
    }, "tracks");
    this.store.fixSelection();
  }

  async duplicateTrack(id) {
    const states = await this.engine.collectStates();
    const p = this.store.project;
    const src = p.tracks.find((t) => t.id === id);
    if (!src) return;
    const copy = deepCopy(src);
    const t0 = newTrack(p, src.type, src.instrument && src.instrument.kind);
    copy.id = t0.id;
    copy.name = src.name + " 2";
    if (states.has(src.id)) copy.instrument.state = states.get(src.id);
    this.store.update((p) => p.tracks.splice(p.tracks.indexOf(src) + 1, 0, copy), "tracks");
  }

  async changeInstrument(id, kind) {
    this.store.update((p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (!t || t.type !== "midi") return;
      const oldName = t.instrument ? (t.instrument.kind === "drumrack" ? "Drums" : kindName(t.instrument.kind)) : "";
      t.instrument = { kind, preset: null, state: kind === "drumrack" ? newTrack(p, "midi", "drumrack").instrument.state : null };
      t.automation = Object.fromEntries(Object.entries(t.automation).filter(([k]) => !k.startsWith("p:")));
      t.lanes = t.lanes.filter((k) => !k.startsWith("p:"));
      if (t.name === oldName) t.name = kind === "drumrack" ? "Drums" : kindName(kind);
    }, "tracks");
  }

  // ---- playing live ----
  /** The track the keys play: the armed ones, else the selected one */
  liveTargets() {
    const p = this.store.project;
    const armed = p.tracks.filter((t) => t.mixer.arm && t.type === "midi");
    if (armed.length) return armed;
    const sel = this.store.selectedTrack;
    return sel && sel.type === "midi" ? [sel] : [];
  }
  liveNote(on, note, vel = 100, targets = null) {
    for (const t of targets || this.liveTargets()) {
      const inst = this.engine.instrument(t.id);
      if (!inst) continue;
      if (on) inst.noteOn(note, vel, 0); else inst.noteOff(note, 0);
      this.recording.note(t, on, note, vel);
    }
    this.views.panel.keysLit && this.views.panel.keysLit(note, on);
  }
  liveMidi(bytes) {
    const s = bytes[0] & 0xf0;
    if (s === 0x90 && bytes[2] > 0) return this.liveNote(true, bytes[1], bytes[2]);
    if (s === 0x80 || s === 0x90) return this.liveNote(false, bytes[1], 0);
    for (const t of this.liveTargets()) { const inst = this.engine.instrument(t.id); if (inst) inst.midi(Array.from(bytes), 0); }
  }

  // ---- the transport ----
  togglePlay() {
    if (this.ctx.state !== "running") this.ctx.resume();
    if (this.transport.playing) this.stop();
    else this.transport.play();
  }
  stop() {
    if (this.recording.active) this.recording.stop();
    this.transport.stop();
  }

  // ---- keys ----
  onKey(e) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) this.store.redo(); else this.store.undo(); return; }
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "s") { e.preventDefault(); this.save().then(() => toast("Saved")); return; }
    if (k === " ") { e.preventDefault(); this.togglePlay(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (k === "Tab") { e.preventDefault(); this.setView(this.store.ui.view === "arrange" ? "session" : "arrange"); return; }
    if (this.views.panel.onKey(e)) return;
    const n = computerKeys(k);
    if (n !== null && !e.repeat) { this.liveNote(true, n + this.keyOctave(), 100); this.heldKeys.set(k, n + this.keyOctave()); return; }
    if (k === "z") this.octave = Math.max(-2, (this.octave || 0) - 1);
    if (k === "x") this.octave = Math.min(4, (this.octave || 0) + 1);
    if (k === "Delete" || k === "Backspace") {
      const v = this.views[this.store.ui.view];
      if (v.deleteSelection) v.deleteSelection();
    }
  }
  onKeyUp(e) {
    const n = this.heldKeys.get(e.key);
    if (n !== undefined) { this.heldKeys.delete(e.key); this.liveNote(false, n, 0); }
  }
  heldKeys = new Map();
  keyOctave() { return 60 + 12 * (this.octave || 0); }
}

// computer keyboard: A W S E D F T G Y H U J K O L P as C..D#
function computerKeys(k) {
  const map = "awsedftgyhujkolp;";
  const i = map.indexOf(k.toLowerCase());
  return i >= 0 && k.length === 1 ? i : null;
}

// Safari ignores user-scalable=no: its page pinch would fight the editors' own pinch zoom
for (const ev of ["gesturestart", "gesturechange"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

const app = new App();
window.minidaw = app;
// the instruments' editors (iframes) find their engine through this
app.editorBridge = (trackId) => app.editorHost && app.editorHost.bridge(trackId);
app.boot();
