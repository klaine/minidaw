// The Device panel for the selected track: its instrument (presets, quick knobs, the full editor), its Drum Rack (pads
// and the selected pad's sample and settings) or its audio clips, and its channel (volume, pan, sends, EQ).
import { h, fmtDb, UNITY, uid } from "../util.js";
import { knob, toggle, menu, toast, select } from "./controls.js";
import { gestures } from "./gestures.js";
import { INSTRUMENT_KINDS, newAudioClip, guessBpm, defaultDrumState, DRUM_BASE_NOTE } from "../model.js";
import { metaSync, loadMeta } from "../audio/instruments.js";
import { presetBrowser, pickSample } from "./browser.js";
import { placeClip } from "../recording.js";

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
      h("div", { class: "dev-row" }, kindSel, presetBar, edit, more),
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
    return h("div", { class: "dev-audio" },
      h("div", { class: "dev-row" },
        h("button", { type: "button", class: "btn primary", onclick: () => add("arrange") }, "Add a sample at the playhead"),
        h("button", { type: "button", class: "btn", onclick: () => add("session") }, "Add a sample to the session")),
      h("p", { class: "dim" }, `${clips.size} clip${clips.size === 1 ? "" : "s"} on this track. Built-in drum loops, your own files, or a recording: arm the track (●) and press Record to record the microphone or audio input.`),
      h("p", { class: "dim" }, "Audio clips follow the tempo when Warp is on (they're resampled, so the pitch follows too). Edit a clip's tempo, start and length in the Clip tab."));
  }

  frame() { if (this.drum) this.drum.frame(); }
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
class DrumDevice {
  constructor(app, track, inst) {
    this.app = app;
    this.trackId = track.id;
    this.inst = inst;
    this.sel = 0;
    this.flash = new Float32Array(16);
    this.pads = h("div", { class: "drum-pads" });
    this.editor = h("div", { class: "drum-edit" });
    this.el = h("div", { class: "drum" }, this.pads, this.editor);
    if (inst) inst.onHit = (i) => { this.flash[i] = 1; };
    this.refresh();
  }
  get t() { return this.app.store.track(this.trackId); }
  get state() { return this.t.instrument.state; }

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
        const el = h("div", { class: "pad" + (i === this.sel ? " sel" : "") + (pad.mute ? " muted" : ""), style: { "--tc": t.color } },
          h("span", { class: "pad-name" }, pad.name), h("span", { class: "pad-note" }, String(i + 1)));
        el.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          const r = el.getBoundingClientRect();
          const vel = Math.round(60 + 67 * Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)));
          this.app.liveNote(true, DRUM_BASE_NOTE + i, vel, [this.t]);
          if (this.sel !== i) { this.sel = i; this.refreshEditor(); this.padEls.forEach((p, k) => p.classList.toggle("sel", k === i)); }
        });
        el.addEventListener("pointerup", () => this.app.liveNote(false, DRUM_BASE_NOTE + i, 0, [this.t]));
        el.addEventListener("contextmenu", (e) => e.preventDefault());
        this.padEls[i] = el;
        this.pads.append(el);
      }
    }
    this.refreshEditor();
  }

  setPad(fn, live) {
    const store = this.app.store;
    (live ? store.live : store.update).call(store, (p) => fn(p.tracks.find((x) => x.id === this.trackId).instrument.state.pads[this.sel]), live ? "live-pad" : "pad");
  }

  refreshEditor() {
    const app = this.app;
    const pad = this.state.pads[this.sel];
    this.editor.textContent = "";
    const k = (label, value, def, fn, fmt, o = {}) => knob({ label, value, def, size: 42, format: fmt, onInput: (v) => this.setPad((pd) => fn(pd, v), true), onChange: (v) => this.setPad((pd) => fn(pd, v)), ...o });
    const sampleBtn = h("button", { type: "button", class: "btn drum-sample", onclick: async () => {
      const s = await pickSample(app, { title: "Sample for pad " + (this.sel + 1), kinds: ["oneshot", "loop"] });
      if (!s) return;
      this.setPad((pd) => { pd.sample = s.id; pd.name = s.name.slice(0, 14); pd.start = 0; });
      this.refresh();
    } }, app.samples.name(pad.sample));
    const choke = select([{ value: 0, label: "No choke" }, { value: 1, label: "Choke 1" }, { value: 2, label: "Choke 2" }, { value: 3, label: "Choke 3" }, { value: 4, label: "Choke 4" }], pad.choke || 0, (v) => this.setPad((pd) => { pd.choke = +v; }));
    this.editor.append(
      h("div", { class: "dev-row" }, h("span", { class: "drum-pad-title" }, "Pad " + (this.sel + 1)), sampleBtn,
        toggle("Rev", pad.reverse, () => { this.setPad((pd) => { pd.reverse = !pd.reverse; }); this.refreshEditor(); }, "small"),
        toggle("Mute", pad.mute, () => { this.setPad((pd) => { pd.mute = !pd.mute; }); this.refresh(); }, "small"),
        choke,
        h("button", { type: "button", class: "btn small", onclick: (e) => menu(e.currentTarget, [
          { label: "Rename pad…", onClick: async () => { const { prompt } = await import("./controls.js"); const n = await prompt("Pad name", pad.name); if (n) { this.setPad((pd) => { pd.name = n.slice(0, 14); }); this.refresh(); } } },
          { label: "Reset this pad", onClick: () => { const d = defaultDrumState().pads[this.sel]; this.setPad((pd) => Object.assign(pd, d)); this.refresh(); } },
          { label: "Reset the whole kit", danger: true, onClick: () => { app.store.update((p) => { p.tracks.find((x) => x.id === this.trackId).instrument.state = defaultDrumState(); }, "pad"); this.refresh(); } },
        ]) }, "⋯")),
      h("div", { class: "dev-knobs" },
        k("Level", (pad.gain ?? 0.8) / 1.25, 0.64, (pd, v) => { pd.gain = v * 1.25; }, (v) => (v <= 0 ? "-∞" : (20 * Math.log10(v * 1.25)).toFixed(1) + " dB")),
        k("Pan", ((pad.pan || 0) + 1) / 2, 0.5, (pd, v) => { pd.pan = Math.round((v * 2 - 1) * 100) / 100; }, (v) => { const x = Math.round((v * 2 - 1) * 50); return x === 0 ? "C" : x < 0 ? -x + "L" : x + "R"; }, { bipolar: true }),
        k("Pitch", ((pad.pitch || 0) + 24) / 48, 0.5, (pd, v) => { pd.pitch = Math.round(v * 48 - 24); }, (v) => { const x = Math.round(v * 48 - 24); return (x > 0 ? "+" : "") + x + " st"; }, { bipolar: true }),
        k("Start", (pad.start || 0) / 0.9, 0, (pd, v) => { pd.start = v * 0.9; }, (v) => Math.round(v * 90) + "%"),
        k("Decay", pad.decay ?? 1, 1, (pd, v) => { pd.decay = v; }, (v) => (v >= 0.999 ? "Full" : Math.round(v * 100) + "%"))));
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
  dispose() { if (this.inst) this.inst.onHit = null; }
}
