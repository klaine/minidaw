// minidaw: the app. Boots the audio on the first tap (a browser starts audio only from a gesture), keeps the project
// in IndexedDB, and wires the store, the engine, the transport and the views together.
import { Store } from "./store.js";
import { db, persistStorage } from "./db.js";
import { newProject, newTrack, migrate, INSTRUMENT_KINDS, kindName } from "./model.js";
import { SampleBank } from "./audio/samples.js";
import { AudioEngine } from "./audio/engine.js";
import { Transport } from "./audio/transport.js";
import { prepareContext, loadMeta } from "./audio/instruments.js";
import { h, debounce, deepCopy, uid } from "./util.js";
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
import { Library } from "./library.js";
import { setupDrop } from "./ui/import.js";

class App {
  constructor() {
    this.samples = new SampleBank();
    this.store = new Store(newProject());
    this.ctx = null;
    this.views = {};
    this.loadedAt = new Map(); // project id -> the updatedAt of the copy this window last loaded or saved
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
      // from the beginning next time: "Try again" did nothing while the half-started audio was kept
      try { if (this.ctx) this.ctx.close(); } catch (_) { /* already closed */ }
      this.ctx = null;
      btn.disabled = false;
      btn.textContent = "Try again";
      msg.textContent = "It didn't start: " + (e.message || e);
    }), { once: false });
    if ("serviceWorker" in navigator && location.protocol !== "file:" && !/[?&]nosw/.test(location.search)) {
      // A new version installs beside the running one and waits (sw.js). Here on the boot screen, before Start,
      // it's told to take over and the page reloads into it, whole. Once the song is open it's only said: a running
      // session keeps the files it started with.
      const sw = navigator.serviceWorker, had = !!sw.controller;
      let reloading = false;
      sw.addEventListener("controllerchange", () => { if (had && !this.ctx && !reloading) { reloading = true; location.reload(); } });
      sw.register("sw.js").then((reg) => {
        const ready = () => {
          if (!had || !reg.waiting) return;
          if (!this.ctx) reg.waiting.postMessage({ t: "skipWaiting" });
          else toast("A new version of minidaw is ready: it starts the next time you open it", 8000);
        };
        ready();
        reg.addEventListener("updatefound", () => { const w = reg.installing; if (w) w.addEventListener("statechange", () => { if (w.state === "installed") ready(); }); });
      }).catch((e) => console.warn("service worker", e));
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
    this.library = new Library(this.samples);
    await this.library.load();
    this.samples.onAdd = (rec) => this.library.remember(rec);
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
    setInterval(() => this.midi.launchpad.refresh(), 500); // frames stop in a background window; a Launchpad's lights shouldn't
    setupDrop(this);
    this.loop();
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.saveLeaving(); else this.keepAwake(); });
    window.addEventListener("pagehide", () => this.saveLeaving());
    setInterval(() => { if (this.store.ui.dirty) this.save(); }, 15000);
    // iOS stops the audio when the app is left, a call comes in or Siri speaks ("interrupted"), and may need one more
    // touch at the start: any touch, and coming back to the app, starts it again
    const wake = () => { if (ctx.state !== "running") { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } };
    document.addEventListener("pointerdown", wake, true);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
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
    this.splitterEl = el;
    let start = null;
    const saved = parseFloat(localStorage.getItem("minidaw.panelH") || "0");
    if (saved) document.documentElement.style.setProperty("--panel-h", saved + "px");
    el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); start = { y: e.clientY, h: this.views.panel.el.getBoundingClientRect().height }; });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      const hgt = Math.max(120, Math.min(this.maxPanel(), start.h + (start.y - e.clientY)));
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
      this.setPanelHeight(cur > 200 ? 120 : Math.round(innerHeight * 0.42));
    });
    // the iPad turned, or a height remembered from the other orientation: the panel never takes more than there is
    const fit = () => {
      if (this.views.panel.el.getBoundingClientRect().height > this.maxPanel() + 1) document.documentElement.style.setProperty("--panel-h", Math.round(this.maxPanel()) + "px");
      this.views.panel.update();
    };
    window.addEventListener("resize", fit);
    requestAnimationFrame(fit);
  }
  setPanelHeight(px) {
    document.documentElement.style.setProperty("--panel-h", Math.round(px) + "px");
    try { localStorage.setItem("minidaw.panelH", String(Math.round(px))); } catch (_) { /* private mode */ }
  }
  /** The tallest the panel can be: the top bar (two rows in portrait), the ruler and a track stay in sight */
  maxPanel() {
    const app = document.getElementById("app").getBoundingClientRect(), cs = getComputedStyle(document.getElementById("app"));
    const inner = app.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom); // less the safe areas (the home indicator)
    return Math.max(160, inner - this.topbar.el.getBoundingClientRect().height - this.splitterEl.getBoundingClientRect().height - 124);
  }
  /** Is the bottom panel tall (most of the screen: room to play or edit)? */
  get panelTall() { return this.views.panel.el.getBoundingClientRect().height > Math.min(innerHeight * 0.55, this.maxPanel() - 40); }
  /** The panel tall, or back to what it was */
  togglePanelTall() {
    const cur = this.views.panel.el.getBoundingClientRect().height;
    if (this.panelTall) this.setPanelHeight(this.panelWas && this.panelWas < innerHeight * 0.55 ? this.panelWas : innerHeight * 0.42);
    else { this.panelWas = cur; this.setPanelHeight(this.maxPanel()); }
    this.views.panel.update();
  }

  setView(v) {
    this.store.ui.view = v;
    for (const k of ["arrange", "session", "mixer"]) this.views[k].el.hidden = k !== v;
    this.views[v].update({ reason: "view" });
    this.topbar.update();
    if (this.views.panel) this.views.panel.update({ reason: "view" });
  }

  /** A new empty MIDI clip on a track, where the view is: the session's next empty slot, or the arrangement's bar at
   *  the playhead (the next free bar if a clip is there). It opens in the Clip tab. */
  newClipHere(track) {
    const store = this.store, t = store.track(track.id);
    if (!t || t.type !== "midi") return;
    if (store.ui.view === "session") {
      const s = t.slots.findIndex((x) => !x);
      if (s < 0) { toast("No empty slot on " + t.name + ": long press a scene to insert one"); return; }
      this.views.session.create(t, s);
      return;
    }
    const sig = store.project.sig || 4;
    let start = Math.floor((this.transport.position || 0) / sig + 1e-6) * sig;
    const taken = (b) => t.arrangement.some((pl) => pl.start < b + sig - 1e-6 && pl.start + pl.length > b + 1e-6);
    while (taken(start)) start += sig;
    this.views.arrange.newClipAt(t, start);
  }

  // ---- changes ----
  onChange(c) {
    const p = this.store.project;
    this.engine.sync(p);
    if (c.reason !== "live-mixer") this.transport.refreshAutomated();
    if (!c.live) this.transport.syncSession();
    for (const k of ["arrange", "session", "mixer"]) if (k === this.store.ui.view) this.views[k].update(c);
    if (!c.live || c.reason === "notes") this.views.panel.update(c);
    this.topbar.update();
    if (!c.live) this.saveSoon();
    if (!c.live && this.recording) this.recording.syncInputs();
  }

  onTransport(what) {
    this.keepAwake();
    if (this.midi) this.midi.launchpad.refresh(true); // a hardware grid's lights follow even with the window out of sight
    this.topbar.update();
    if (this.store.ui.view === "session") this.views.session.update({ reason: "transport" });
    if (what === "stop" || what === "seek") this.views.arrange.update({ reason: "transport" });
  }

  /** While it plays or records the screen stays on (an iPad would dim and lock in the middle of a take) */
  async keepAwake() {
    const want = (this.transport.playing || this.recording.active) && document.visibilityState === "visible";
    try {
      if (want && !this.wakeLock && navigator.wakeLock) {
        const lock = this.wakeLock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => { if (this.wakeLock === lock) this.wakeLock = null; });
      } else if (!want && this.wakeLock) { const lock = this.wakeLock; this.wakeLock = null; await lock.release(); }
    } catch (_) { this.wakeLock = null; /* not allowed (low power mode), or no API */ }
  }

  /** The frame loop: playhead, meters, session clip progress */
  loop() {
    const frame = () => {
      try {
        const v = this.store.ui.view;
        this.views[v].frame && this.views[v].frame();
        this.views.panel.frame();
        this.topbar.frame();
        this.recording.frame();
        if (this.midi) this.midi.launchpad.refresh();
      } catch (e) { console.error(e); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ---- projects ----
  async openProject(p, { quiet } = {}) {
    if (this.transport && this.transport.playing) this.transport.stop();
    if (this.transport) this.transport.session.clear();
    // what this window knows of the stored copy: a save refuses to write over a newer one (another tab's)
    const stored = await db.loadProject(p.id).catch(() => null);
    if (stored) this.loadedAt.set(p.id, stored.updatedAt); else this.loadedAt.delete(p.id);
    this.store.setProject(p);
    // samples first (the drum rack and audio clips need their buffers), then the instruments with their states
    const ids = [];
    for (const c of Object.values(p.clips)) if (c.type === "audio") ids.push(c.sampleId);
    for (const t of p.tracks) if (t.instrument && t.instrument.kind === "drumrack") for (const pad of t.instrument.state.pads) ids.push(pad.sample);
    await this.samples.loadAll(ids, this.ctx);
    const silent = [...new Set(ids)].filter((id) => this.samples.failed.has(id));
    if (silent.length) toast(`${silent.length} sample${silent.length === 1 ? "" : "s"} can't be played in this browser (${silent.slice(0, 3).map((id) => this.samples.name(id)).join(", ")}${silent.length > 3 ? "…" : ""}): silent here, kept in the project`, 8000);
    this.engine.dispose();
    await this.engine.sync(p);
    this.transport.position = 0;
    this.transport.applyStatic();
    this.store.ui.dirty = false;
    await db.set("lastProject", p.id).catch(() => {});
    if (!quiet) toast("Opened " + p.name);
  }

  saveSoon = debounce(() => this.save(), 2500);

  /**
   * The project with every instrument's current sound, into IndexedDB. -> true if it's saved. A save asked for while
   * one runs is done right after it. A failure is said (and said again when saving works once more): edits that
   * aren't being saved must not look saved.
   */
  async save() {
    if (!this.engine) return false;
    if (this.saving) { this.saveAgain = true; return this.saving; }
    const job = this.saving = (async () => {
      try {
        const states = await this.engine.collectStates();
        const p = this.store.project;
        for (const t of p.tracks) if (states.has(t.id) && t.instrument) t.instrument.state = states.get(t.id);
        this.pruneClips(p);
        const copy = deepCopy(p);
        await db.saveProject(copy, { since: this.loadedAt.get(p.id) });
        this.loadedAt.set(p.id, copy.updatedAt);
        await db.set("lastProject", p.id);
        if (this.store.project === p && p.updatedAt === copy.updatedAt) this.store.ui.dirty = false;
        if (this.saveFailed) { this.saveFailed = null; toast("Saving works again: the project is saved"); }
        this.topbar.update();
        return true;
      } catch (e) {
        console.error("save", e);
        const stale = e && e.name === "StaleProject";
        const why = stale ? "this project was saved from another tab or window since this one opened it" : (e && e.name === "QuotaExceededError" ? "the browser's storage is full" : (e && e.message) || String(e));
        // said at the first failure, and again every minute while it lasts
        if (!this.saveFailed || performance.now() - this.saveFailed > 60000) {
          this.saveFailed = performance.now();
          toast(stale ? "Not saved: " + why + ". Reload to see that version, or use Projects → Save current as file to keep this one."
            : "Not saved: " + why + ". Your changes are only in this window: use Projects → Save current as file to keep them.", 12000);
        }
        return false;
      }
    })();
    const ok = await job;
    this.saving = null;
    if (this.saveAgain) { this.saveAgain = false; return this.save(); }
    return ok;
  }
  /**
   * Clips no slot or placement shows any more (deleted ones) leave the project when it's saved: they stayed in it, in
   * every save and exported file, for good. Undo still has them: its steps keep their own clips.
   */
  pruneClips(p) {
    if (this.store.locked || this.store.pending) return; // a recording or a drag is in the middle of something
    const used = new Set();
    for (const t of p.tracks) { for (const id of t.slots) if (id) used.add(id); for (const pl of t.arrangement) used.add(pl.clipId); }
    const copied = this.views.arrange && this.views.arrange.clipboard, copiedSlot = this.views.session && this.views.session.clipboard;
    if (copied && copied.clipId) used.add(copied.clipId); // a copied clip can still be pasted
    if (copiedSlot) used.add(copiedSlot);
    if (this.store.ui.selClip) used.add(this.store.ui.selClip);
    for (const id of Object.keys(p.clips)) if (!used.has(id)) delete p.clips[id];
  }

  /** The page is going away or out of sight: the project as it is, written at once (the full save, which asks the
   *  instruments for their sound first, may not get the time), then the full save */
  saveLeaving() {
    if (!this.engine || !this.store.ui.dirty) return; // untouched: nothing to write (an idle tab must not write over newer work)
    const copy = deepCopy(this.store.project);
    if (db.saveProjectNow(copy)) this.loadedAt.set(copy.id, copy.updatedAt);
    this.save();
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
      // the selection moves to a neighbour before the views hear of the change (the panel would show no track)
      if (this.store.ui.selTrack === id) { const n = p.tracks[Math.min(i, p.tracks.length - 1)]; this.store.ui.selTrack = n ? n.id : null; this.store.ui.selClip = null; }
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
    this.store.update((p) => {
      // its own clips (copies) and placements: editing the copy must not rewrite the original
      const own = new Map();
      const clipFor = (id) => {
        if (!id || !p.clips[id]) return id;
        if (!own.has(id)) { const c = deepCopy(p.clips[id]); c.id = uid("c"); p.clips[c.id] = c; own.set(id, c.id); }
        return own.get(id);
      };
      copy.slots = copy.slots.map(clipFor);
      copy.arrangement = copy.arrangement.map((pl) => ({ ...pl, id: uid("a"), clipId: clipFor(pl.clipId) }));
      p.tracks.splice(p.tracks.indexOf(p.tracks.find((t) => t.id === src.id)) + 1, 0, copy);
    }, "tracks");
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
    // a note is let go on the tracks it was played on, whatever is armed or selected by then (no hung notes)
    const held = this.liveHeld || (this.liveHeld = new Map());
    if (!targets) {
      if (on) { targets = this.liveTargets(); held.set(note, targets.map((t) => t.id)); }
      else { const ids = held.get(note); held.delete(note); targets = ids ? ids.map((id) => this.store.track(id)).filter(Boolean) : this.liveTargets(); }
    }
    for (const t of targets) {
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

  /** Play the clip being edited round and round (the editors' Loop clip button), or stop */
  auditionClip(trackId, clip) {
    const store = this.store, t = store.track(trackId), tr = this.transport;
    if (!t || !clip) return;
    if (this.ctx.state !== "running") this.ctx.resume();
    if (tr.playing) { this.stop(); return; }
    const scene = t.slots.indexOf(clip.id);
    const places = t.arrangement.filter((pl) => pl.clipId === clip.id);
    const pl = places.find((x) => x.id === this.views.arrange.selPl) || places[0];
    if (scene >= 0 && (store.ui.view === "session" || !pl)) { tr.toggleClip(t.id, scene); return; }
    if (!pl) return;
    const l = store.project.loop;
    if (!l.on || l.start !== pl.start || l.end !== pl.start + pl.length) store.update((p) => { p.loop = { on: true, start: pl.start, end: pl.start + pl.length }; }, "loop");
    tr.play(pl.start);
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
    if (document.querySelector(".sheet, .menu-veil")) return; // a dialog or a menu is open: keys aren't for what's behind it
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) this.store.redo(); else this.store.undo(); return; }
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "s") { e.preventDefault(); this.save().then((ok) => { if (ok) toast("Saved"); }); return; }
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
