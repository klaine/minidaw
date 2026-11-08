// The Device panel for the selected track: its instrument (presets, quick knobs, the full editor), its Drum Rack (pads
// and the selected pad's sample and settings) or its audio clips, and its channel (volume, pan, sends, EQ).
import { h, fmtDb, UNITY, uid, pickFiles } from "../util.js";
import { knob, toggle, menu, toast, select, prompt } from "./controls.js";
import { gestures, Surface } from "./gestures.js";
import { INSTRUMENT_KINDS, newAudioClip, guessBpm, defaultDrumState, DRUM_BASE_NOTE } from "../model.js";
import { metaSync, loadMeta } from "../audio/instruments.js";
import { presetBrowser, pickSample } from "./browser.js";
import { placeClip } from "../recording.js";
import { importMidiToTrack } from "./import.js";

/** Import a MIDI file onto a track: the selected session slot in the session, else the arrangement at the playhead */
function importHere(app, t) {
  const ss = app.store.ui.selSlot;
  if (app.store.ui.view === "session") return importMidiToTrack(app, t.id, { scene: ss && ss.trackId === t.id ? ss.scene : 0 });
  return importMidiToTrack(app, t.id, {});
}

export class DeviceView {
  constructor(app, track) {
    this.app = app;
    this.trackId = track.id;
    this.el = h("div", { class: "device" });
    this.render();
  }
  get t() { return this.app.store.track(this.trackId); }

  update(c = {}) {
    const t = this.t;
    if (!t) return;
    const inst = this.app.engine.instrument(t.id);
    if (t.type === "audio" && c.reason === "mixer" && !c.live) { this.render(); return; }
    if (inst !== this.inst || (c.reason && ["tracks", "undo", "project"].includes(c.reason))) { this.render(); return; }
    if (this.drum && !c.live) this.drum.refresh();
  }

  render() {
    const app = this.app, t = this.t;
    if (this.drum) this.drum.dispose();
    this.drum = null;
    this.el.textContent = "";
    if (!t) return;
    this.inst = app.engine.instrument(t.id);
    const main = h("div", { class: "dev-main" });
    if (t.type === "audio") main.append(this.audioDevice(t));
    else if (t.instrument.kind === "drumrack") { this.drum = new DrumDevice(app, t, this.inst); main.append(this.drum.el); }
    else main.append(this.synthDevice(t));
    this.el.append(main, channelBox(app, t));
  }

  synthDevice(t) {
    const app = this.app, store = app.store;
    const kind = t.instrument.kind;
    const meta = metaSync(kind);
    const inst = this.inst;
    const ch = app.engine.channel(t.id);
    const kindSel = select(INSTRUMENT_KINDS.map((k) => ({ value: k.kind, label: k.name })), kind, (v) => app.changeInstrument(t.id, v), "dev-kind");
    if (!inst || !meta) {
      if (!meta) loadMeta(kind).then(() => this.render());
      return h("div", { class: "dev-synth" }, h("div", { class: "dev-row" }, kindSel), h("p", { class: "dim dev-loading" }, ch && ch.error ? "This instrument didn't load: " + ch.error : "Loading " + (meta ? meta.name : kind) + "…"));
    }
    const presetName = h("span", { class: "dev-preset-name" }, t.instrument.presetName || "…");
    if (!t.instrument.presetName) inst.presetName().then((n) => { presetName.textContent = n || "Init"; });
    const pick = async (i) => {
      await inst.loadPreset(i);
      const name = meta.presets[i] ? meta.presets[i].name : "";
      store.update((p) => { const x = p.tracks.find((q) => q.id === t.id); x.instrument.preset = i; x.instrument.presetName = name; x.instrument.state = null; }, "preset");
      presetName.textContent = name;
      this.refreshKnobs();
    };
    const cur = () => (typeof t.instrument.preset === "number" ? t.instrument.preset : inst.presetIndex ?? 0);
    const step = (d) => { const n = meta.presets.length; pick((((cur() + d) % n) + n) % n); };
    const presetBar = h("div", { class: "dev-preset" },
      h("button", { type: "button", class: "icon-btn", title: "Previous preset", onclick: () => step(-1) }, "◀"),
      h("button", { type: "button", class: "dev-preset-btn", onclick: () => presetBrowser(app, meta, cur(), pick) }, presetName),
      h("button", { type: "button", class: "icon-btn", title: "Next preset", onclick: () => step(1) }, "▶"));
    const edit = h("button", { type: "button", class: "btn primary dev-edit", onclick: () => app.editorHost.open(t.id) }, "Edit " + meta.name);
    const imp = h("button", { type: "button", class: "btn", title: "Import a MIDI file onto this track (or drop one on it)", onclick: () => importHere(app, this.t) }, "Import MIDI…");
    this.knobs = [];
    const knobRow = h("div", { class: "dev-knobs" });
    for (const key of meta.knobs) {
      const p = meta.params.find((x) => x.key === key);
      if (!p) continue;
      const laneKey = "p:" + key;
      const automated = () => { const tr = this.t; return !!(tr && tr.automation[laneKey] && tr.automation[laneKey].length); };
      const k = knob({
        label: shortName(p.name), value: 0, title: p.name + " (long press: automation)",
        format: (v) => fmtParam(p, v),
        onInput: (v) => { inst.setNorm(key, v); store.ui.dirty = true; },
        onChange: (v) => { inst.setNorm(key, v); store.ui.dirty = true; app.topbar.update(); },
      });
      if (automated()) k.classList.add("automated");
      gestures(k, { longPress: (pos, e) => menu({ x: e.clientX, y: e.clientY }, [
        { label: "Show its automation lane", onClick: () => { store.update((p) => { const x = p.tracks.find((q) => q.id === t.id); if (!x.lanes.includes(laneKey)) x.lanes.push(laneKey); }, "tracks"); app.setView("arrange"); } },
        { label: "Write it into the selected clip's envelope", disabled: !store.selectedClip, onClick: () => store.select({ panel: "clip", envKey: laneKey }) },
      ], { title: p.name }) });
      this.knobs.push({ key, el: k });
      knobRow.append(k);
    }
    this.refreshKnobs();
    const more = h("button", { type: "button", class: "btn small", onclick: (e) => menu(e.currentTarget, [
      { label: "Automate a parameter…", onClick: () => app.views.arrange.addLane(this.t) || app.setView("arrange") },
      { label: "Reload the preset", onClick: () => pick(cur()) },
    ]) }, "⋯");
    return h("div", { class: "dev-synth" },
      h("div", { class: "dev-row" }, kindSel, presetBar, edit, imp, more),
      knobRow);
  }

  async refreshKnobs() {
    const inst = this.inst;
    if (!inst || !this.knobs) return;
    for (const k of this.knobs) {
      const v = await inst.getNorm(k.key);
      if (v !== null && isFinite(v)) k.el.set(v);
    }
  }

  audioDevice(t) {
    const app = this.app, store = app.store;
    const clips = new Set([...t.slots.filter(Boolean), ...t.arrangement.map((pl) => pl.clipId)]);
    const add = async (where) => {
      const s = await pickSample(app, { title: "Sample for " + t.name });
      if (!s) return;
      store.update((p) => {
        const x = p.tracks.find((q) => q.id === t.id);
        const c = newAudioClip(p, x, s, s.bpm || guessBpm(s.duration));
        if (where === "arrange") placeClip(x, { id: uid("a"), clipId: c.id, start: Math.floor(app.transport.position / 4) * 4, length: c.length, offset: 0 });
        else { let i = x.slots.indexOf(null); if (i < 0) { i = x.slots.length; for (const y of p.tracks) y.slots.push(null); p.scenes.push({ name: "" }); } x.slots[i] = c.id; }
        store.ui.selClip = c.id;
        store.ui.panel = "clip";
      }, "clips");
    };
    const set = (k) => store.update((p) => { const x = p.tracks.find((q) => q.id === t.id); x.mixer[k] = !x.mixer[k]; }, "mixer");
    this.inputMeter = h("canvas", { class: "dev-input-meter", width: 120, height: 10 });
    const inputRow = h("div", { class: "dev-row dev-input" },
      toggle("● Arm", t.mixer.arm, () => set("arm"), "arm"),
      toggle("Monitor", t.mixer.monitor, () => set("monitor"), "small"),
      h("span", { class: "dim" }, "Input"), this.inputMeter,
      h("span", { class: "dim" }, t.mixer.arm ? (app.recording.input ? (t.mixer.monitor ? "you hear the input through this track: use headphones" : "armed: press Record, or tap an empty slot in the session") : "opening the input…") : "arm to record the microphone or an audio input"));
    return h("div", { class: "dev-audio" },
      inputRow,
      h("div", { class: "dev-row" },
        h("button", { type: "button", class: "btn primary", onclick: () => add("arrange") }, "Add a sample at the playhead"),
        h("button", { type: "button", class: "btn", onclick: () => add("session") }, "Add a sample to the session")),
      h("p", { class: "dim" }, `${clips.size} clip${clips.size === 1 ? "" : "s"} on this track. Built-in drum loops, your own files, or a recording: arm the track (●) and press Record to record the microphone or audio input.`),
      h("p", { class: "dim" }, "Audio clips follow the tempo when Warp is on (they're resampled, so the pitch follows too). Edit a clip's tempo, start and length in the Clip tab."));
  }

  frame() {
    if (this.drum) this.drum.frame();
    if (this.inputMeter && this.inputMeter.isConnected) {
      const c = this.inputMeter.getContext("2d"), pk = this.app.recording.inputPeak();
      const db = pk > 0 ? 20 * Math.log10(pk) : -100, f = Math.max(0, Math.min(1, (db + 54) / 54));
      c.fillStyle = "#2a2c31"; c.fillRect(0, 0, 120, 10);
      c.fillStyle = db > -1 ? "#ff4d3d" : db > -9 ? "#ffb03a" : "#3fd67a"; c.fillRect(0, 0, 120 * f, 10);
    }
  }
  dispose() { if (this.drum) this.drum.dispose(); }
}

function shortName(n) {
  return n.replace(/^(Osc|Oscillator) /, "O").replace("Filter ", "Flt ").replace("Envelope", "Env").replace("Resonance", "Reso").replace("Amount", "Amt").replace("Attack", "Att").replace("Release", "Rel").replace("Decay", "Dec").replace("Sustain", "Sus").slice(0, 12);
}
function fmtParam(p, v) {
  const x = p.min + (p.max - p.min) * v;
  if (p.type === "enum") return String(p.options[Math.round(x)] ?? "").slice(0, 8);
  if (p.type === "int") return String(Math.round(x));
  if (p.max - p.min <= 1.0001 && p.min >= 0) return Math.round(x * 100) + "%";
  return (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) + (p.unit ? " " + p.unit : "");
}

/** Volume, pan, sends, EQ and compressor of a track, compact */
export function channelBox(app, t) {
  const store = app.store;
  const set = (k, v, live) => (live ? store.live : store.update).call(store, (p) => { p.tracks.find((x) => x.id === t.id).mixer[k] = v; }, live ? "live-mixer" : "mixer");
  const setEq = (band, v, live) => (live ? store.live : store.update).call(store, (p) => { p.tracks.find((x) => x.id === t.id).mixer.eq[band] = Math.round((v * 30 - 15) * 10) / 10; }, live ? "live-mixer" : "mixer");
  const m = t.mixer;
  const k = (label, value, def, fn, o = {}) => knob({ label, value, def, small: true, size: 38, onInput: (v) => fn(v, true), onChange: (v) => fn(v, false), ...o });
  return h("div", { class: "dev-channel" },
    h("div", { class: "dev-ch-title" }, "Channel"),
    h("div", { class: "dev-ch-knobs" },
      k("Volume", m.vol, UNITY, (v, l) => set("vol", v, l), { format: fmtDb }),
      k("Pan", (m.pan + 1) / 2, 0.5, (v, l) => set("pan", Math.round((v * 2 - 1) * 100) / 100, l), { bipolar: true, format: (v) => { const x = Math.round((v * 2 - 1) * 50); return x === 0 ? "C" : x < 0 ? -x + "L" : x + "R"; } }),
      k("Send A", m.sendA, 0, (v, l) => set("sendA", v, l), { color: "#5ac8fa", format: (v) => Math.round(v * 100) + "%" }),
      k("Send B", m.sendB, 0, (v, l) => set("sendB", v, l), { color: "#bf8cff", format: (v) => Math.round(v * 100) + "%" }),
      k("Low", (m.eq.low + 15) / 30, 0.5, (v, l) => setEq("low", v, l), { bipolar: true, format: (v) => (v * 30 - 15).toFixed(1) }),
      k("Mid", (m.eq.mid + 15) / 30, 0.5, (v, l) => setEq("mid", v, l), { bipolar: true, format: (v) => (v * 30 - 15).toFixed(1) }),
      k("High", (m.eq.high + 15) / 30, 0.5, (v, l) => setEq("high", v, l), { bipolar: true, format: (v) => (v * 30 - 15).toFixed(1) }),
      toggle("Comp", m.comp, () => set("comp", !m.comp), "small")));
}

// ---- the Drum Rack ----
// The pads on the left (tap to play and select, long press for the pad's menu, drop an audio file on one to load it),
// the selected pad on the right: its sample (choose one, import a file), a waveform to trim it (drag the start and
// end markers; tap it to hear the pad), and its level, pan, pitch, start, end and decay.
class DrumDevice {
  constructor(app, track, inst) {
    this.app = app;
    this.trackId = track.id;
    this.inst = inst;
    this.sel = clampPad(app.store.ui.drumPad);
    this.flash = new Float32Array(16);
    this.pads = h("div", { class: "drum-pads" });
    this.editor = h("div", { class: "drum-edit" });
    this.el = h("div", { class: "drum" },
      h("div", { class: "drum-left" }, this.pads, h("div", { class: "dim drum-hint" }, "Tap a pad to play and edit it · long press for more · drop an audio file on a pad")),
      this.editor);
    if (inst) inst.onHit = (i) => { this.flash[i] = 1; };
    this.refresh();
  }
  get t() { return this.app.store.track(this.trackId); }
  get state() { return this.t.instrument.state; }
  get pad() { return this.state.pads[this.sel]; }

  select(i) {
    if (this.sel === i) return;
    this.sel = i;
    this.app.store.ui.drumPad = i;
    this.padEls.forEach((p, k) => p.classList.toggle("sel", k === i));
    this.refreshEditor();
  }

  refresh() {
    const t = this.t;
    if (!t) return;
    this.pads.textContent = "";
    this.padEls = [];
    const pads = this.state.pads;
    for (let row = 3; row >= 0; row--) {
      for (let col = 0; col < 4; col++) {
        const i = row * 4 + col;
        const pad = pads[i];
        const el = h("div", { class: "pad" + (i === this.sel ? " sel" : "") + (pad.mute ? " muted" : ""), style: { "--tc": t.color },
          dataset: { pad: i, track: t.id }, role: "button", "aria-label": `Pad ${i + 1}: ${pad.name}` },
          h("span", { class: "pad-name" }, pad.name), h("span", { class: "pad-note" }, String(i + 1)));
        let hold = 0, down = null;
        el.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          if (e.button === 2) return;
          const r = el.getBoundingClientRect();
          const vel = Math.round(60 + 67 * Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)));
          this.app.liveNote(true, DRUM_BASE_NOTE + i, vel, [this.t]);
          this.select(i);
          down = { x: e.clientX, y: e.clientY };
          clearTimeout(hold);
          hold = setTimeout(() => { down = null; this.padMenu(i, el); }, 520);
        });
        el.addEventListener("pointermove", (e) => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) { clearTimeout(hold); down = null; } });
        const up = () => { clearTimeout(hold); down = null; this.app.liveNote(false, DRUM_BASE_NOTE + i, 0, [this.t]); };
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        el.addEventListener("contextmenu", (e) => { e.preventDefault(); clearTimeout(hold); this.select(i); this.padMenu(i, el); });
        this.padEls[i] = el;
        this.pads.append(el);
      }
    }
    this.refreshEditor();
  }

  setPad(fn, live, i = this.sel) {
    const store = this.app.store;
    (live ? store.live : store.update).call(store, (p) => fn(p.tracks.find((x) => x.id === this.trackId).instrument.state.pads[i]), live ? "live-pad" : "pad");
  }

  /** A sample onto pad i (its trim back to the whole sample) */
  async loadSample(i, s) {
    await this.app.samples.load(s.id, this.app.ctx);
    this.setPad((pd) => { pd.sample = s.id; pd.name = s.name.slice(0, 14); pd.start = 0; pd.end = 1; pd.reverse = false; }, false, i);
    this.refresh();
  }
  async chooseSample(i) {
    const s = await pickSample(this.app, { title: "Sample for pad " + (i + 1), kinds: ["oneshot", "loop"] });
    if (s) await this.loadSample(i, s);
  }
  async importFile(i) {
    const files = await pickFiles("audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.caf");
    if (!files.length) return;
    try { await this.loadSample(i, await this.app.samples.importFile(files[0], this.app.ctx)); }
    catch (e) { toast("That file couldn't be decoded: " + (e.message || e), 4000); }
  }

  padMenu(i, anchor) {
    const app = this.app, pad = this.state.pads[i];
    menu(anchor, [
      { label: "Choose a sample…", onClick: () => this.chooseSample(i) },
      { label: "Import an audio file…", onClick: () => this.importFile(i) },
      { label: "Rename…", onClick: async () => { const n = await prompt("Pad name", pad.name); if (n) { this.setPad((pd) => { pd.name = n.slice(0, 14); }, false, i); this.refresh(); } } },
      { label: "Copy pad", onClick: () => { app.padClipboard = JSON.parse(JSON.stringify(pad)); toast("Copied: long press another pad to paste"); } },
      { label: "Paste pad", disabled: !app.padClipboard, onClick: () => { this.setPad((pd) => Object.assign(pd, JSON.parse(JSON.stringify(app.padClipboard))), false, i); this.refresh(); } },
      { label: pad.mute ? "Unmute" : "Mute", onClick: () => { this.setPad((pd) => { pd.mute = !pd.mute; }, false, i); this.refresh(); } },
      "-",
      { label: "Reset pad", onClick: () => { const d = defaultDrumState().pads[i]; this.setPad((pd) => Object.assign(pd, d), false, i); this.refresh(); } },
      { label: "Reset the whole kit", danger: true, onClick: () => { app.store.update((p) => { p.tracks.find((x) => x.id === this.trackId).instrument.state = defaultDrumState(); }, "pad"); this.refresh(); } },
    ], { title: `Pad ${i + 1} · ${pad.name}` });
  }

  refreshEditor() {
    const app = this.app;
    const pad = this.pad;
    if (this.wave) this.wave.dispose();
    this.editor.textContent = "";
    const kn = (label, value, def, fn, fmt, o = {}) => knob({ label, value, def, size: 40, format: fmt,
      onInput: (v) => { this.setPad((pd) => fn(pd, v), true); this.wave && this.wave.draw(); },
      onChange: (v) => { this.setPad((pd) => fn(pd, v)); this.wave && this.wave.draw(); }, ...o });
    const choke = select([{ value: 0, label: "No choke" }, { value: 1, label: "Choke 1" }, { value: 2, label: "Choke 2" }, { value: 3, label: "Choke 3" }, { value: 4, label: "Choke 4" }],
      pad.choke || 0, (v) => this.setPad((pd) => { pd.choke = +v; }));
    choke.title = "Pads in the same choke group cut each other off (an open hat closed by the closed hat)";
    const title = h("button", { type: "button", class: "drum-pad-title", title: "Rename the pad", onclick: async () => {
      const n = await prompt("Pad name", this.pad.name);
      if (n) { this.setPad((pd) => { pd.name = n.slice(0, 14); }); this.refresh(); }
    } }, `Pad ${this.sel + 1} · ${pad.name}`);
    const canvas = h("canvas", { class: "drum-wave", "aria-label": "Waveform: drag the start and end markers to trim" });
    this.knobs = {};
    const range = () => { const s = this.pad.start || 0, e = this.pad.end ?? 1; return { s, e }; };
    this.knobs.start = kn("Start", range().s, 0, (pd, v) => { pd.start = Math.min(v, (pd.end ?? 1) - 0.005); }, (v) => (v * 100).toFixed(1) + "%");
    this.knobs.end = kn("End", range().e, 1, (pd, v) => { pd.end = Math.max(v, (pd.start || 0) + 0.005); }, (v) => (v * 100).toFixed(1) + "%");
    this.editor.append(
      h("div", { class: "dev-row drum-row" }, title,
        h("button", { type: "button", class: "btn small drum-sample", title: "Choose a built-in sample, or import a file", onclick: () => this.chooseSample(this.sel) }, "Sample: " + app.samples.name(pad.sample) + " ▾"),
        h("button", { type: "button", class: "btn small", onclick: () => this.importFile(this.sel) }, "Import file…"),
        toggle("Reverse", pad.reverse, () => { this.setPad((pd) => { pd.reverse = !pd.reverse; }); this.refreshEditor(); }, "small"),
        toggle("Mute", pad.mute, () => { this.setPad((pd) => { pd.mute = !pd.mute; }); this.refresh(); }, "small"),
        choke,
        h("button", { type: "button", class: "btn small", "aria-label": "More for this pad", onclick: (e) => this.padMenu(this.sel, e.currentTarget) }, "⋯")),
      h("div", { class: "drum-wave-box" }, canvas),
      h("div", { class: "dev-knobs drum-knobs" },
        kn("Level", (pad.gain ?? 0.8) / 1.25, 0.64, (pd, v) => { pd.gain = v * 1.25; }, (v) => (v <= 0 ? "-∞" : (20 * Math.log10(v * 1.25)).toFixed(1) + " dB")),
        kn("Pan", ((pad.pan || 0) + 1) / 2, 0.5, (pd, v) => { pd.pan = Math.round((v * 2 - 1) * 100) / 100; }, (v) => { const x = Math.round((v * 2 - 1) * 50); return x === 0 ? "C" : x < 0 ? -x + "L" : x + "R"; }, { bipolar: true }),
        kn("Pitch", ((pad.pitch || 0) + 24) / 48, 0.5, (pd, v) => { pd.pitch = Math.round(v * 48 - 24); }, (v) => { const x = Math.round(v * 48 - 24); return (x > 0 ? "+" : "") + x + " st"; }, { bipolar: true, step: 1 / 48 }),
        this.knobs.start, this.knobs.end,
        kn("Decay", pad.decay ?? 1, 1, (pd, v) => { pd.decay = v; }, (v) => (v >= 0.999 ? "Full" : Math.round(v * 100) + "%"))));
    this.wave = new PadWave(this, canvas);
  }

  frame() {
    if (!this.padEls) return;
    for (let i = 0; i < 16; i++) {
      if (this.flash[i] > 0) {
        this.flash[i] = Math.max(0, this.flash[i] - 0.08);
        this.padEls[i].style.setProperty("--hit", this.flash[i].toFixed(2));
      }
    }
  }
  dispose() { if (this.inst) this.inst.onHit = null; if (this.wave) this.wave.dispose(); }
}

const clampPad = (i) => (Number.isInteger(i) && i >= 0 && i < 16 ? i : 0);

/** The selected pad's sample, trimmed: drag the start (yellow) or end (white) marker; tap to hear the pad */
class PadWave {
  constructor(dev, canvas) {
    this.dev = dev;
    this.surf = new Surface(canvas, (c, w, hh) => this.paint(c, w, hh));
    const app = dev.app;
    let drag = null;
    gestures(canvas, {
      tap: () => { const i = dev.sel; app.liveNote(true, DRUM_BASE_NOTE + i, 110, [dev.t]); setTimeout(() => app.liveNote(false, DRUM_BASE_NOTE + i, 0, [dev.t]), 150); },
      dragStart: (pos) => {
        const { s, e } = this.range();
        const xs = this.fx(s), xe = this.fx(e);
        const ds = Math.abs(pos.x - xs), de = Math.abs(pos.x - xe);
        if (Math.min(ds, de) > 36) return false;
        app.store.begin();
        drag = ds <= de ? "start" : "end";
        return true;
      },
      dragMove: (pos) => {
        const v = this.xf(pos.x);
        dev.setPad((pd) => {
          if (drag === "start") pd.start = Math.max(0, Math.min(v, (pd.end ?? 1) - 0.005));
          else pd.end = Math.min(1, Math.max(v, (pd.start || 0) + 0.005));
        }, true);
        const { s, e } = this.range();
        dev.knobs.start.set(s); dev.knobs.end.set(e);
        this.draw();
      },
      dragEnd: () => { app.store.commit("pad"); drag = null; },
    });
    app.samples.load(dev.pad.sample, app.ctx).then(() => this.draw());
  }
  range() { const p = this.dev.pad; return { s: p.start || 0, e: p.end ?? 1 }; }
  fx(f) { return 8 + f * (this.surf.w - 16); }
  xf(x) { return Math.max(0, Math.min(1, (x - 8) / Math.max(1, this.surf.w - 16))); }
  draw() { this.surf.draw(); }
  paint(c, w, hh) {
    const dev = this.dev, pad = dev.pad, app = dev.app;
    const col = dev.t ? dev.t.color : "#ff6b5b";
    c.fillStyle = "#18191c";
    c.fillRect(0, 0, w, hh);
    const peaks = app.samples.peaks(pad.sample, 1024);
    const buf = app.samples.buffer(pad.sample);
    if (!peaks || !buf) { c.fillStyle = "#777"; c.font = "11px -apple-system, system-ui, sans-serif"; c.fillText("Loading…", 10, hh / 2); return; }
    const { s, e } = this.range();
    const mid = hh / 2, amp = hh / 2 - 6;
    for (let x = 8; x < w - 8; x++) {
      const f = this.xf(x);
      let i = Math.floor(f * 1023);
      if (pad.reverse) i = 1023 - i;
      const lo = peaks[2 * i] * amp, hi = peaks[2 * i + 1] * amp;
      c.fillStyle = f >= s && f <= e ? col : "#3a3c42";
      c.fillRect(x, mid - hi, 1, Math.max(1, hi - lo));
    }
    // the decay: the level holds, then falls (as the Drum Rack plays it)
    const decay = pad.decay ?? 1;
    if (decay < 0.999) {
      const xs = this.fx(s), xe = this.fx(e);
      const xh = xs + (xe - xs) * decay * decay;
      c.strokeStyle = "rgba(255,255,255,0.7)";
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(xs, 6); c.lineTo(xh, 6); c.lineTo(Math.min(xe, xh + Math.max(3, (0.04 / (buf.duration * (e - s))) * (xe - xs))), hh - 4); c.stroke();
    }
    c.fillStyle = "rgba(0,0,0,0.45)";
    c.fillRect(0, 0, this.fx(s), hh);
    c.fillRect(this.fx(e), 0, w - this.fx(e), hh);
    const marker = (x, color, left) => {
      c.fillStyle = color;
      c.fillRect(x - 1, 0, 2.5, hh);
      c.beginPath();
      if (left) { c.moveTo(x, 0); c.lineTo(x + 12, 0); c.lineTo(x, 14); }
      else { c.moveTo(x, 0); c.lineTo(x - 12, 0); c.lineTo(x, 14); }
      c.fill();
    };
    marker(this.fx(s), "#ffd84a", true);
    marker(this.fx(e), "#ffffff", false);
    c.fillStyle = "#9a9ea8";
    c.font = "10px -apple-system, system-ui, sans-serif";
    const len = (e - s) * buf.duration / Math.pow(2, (pad.pitch || 0) / 12);
    c.fillText(`${app.samples.name(pad.sample)} · ${(len * 1000).toFixed(0)} ms${pad.reverse ? " · reversed" : ""} · drag the markers to trim, tap to hear`, 12, hh - 6);
  }
  dispose() { this.surf.dispose(); }
}
