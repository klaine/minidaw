// The top bar: project, undo/redo, transport (play, stop, record, loop, metronome), tempo, position, the views, add
// track, export and recording the output.
import { h, fmtBars, fmtTime } from "../util.js";
import { menu, numberDrag, toast, segmented, drawMeter } from "./controls.js";
import { INSTRUMENT_KINDS } from "../model.js";
import { openProjects, exportDialog, recordOutput, settingsSheet } from "./projects.js";
import { importMidiAsTracks } from "./import.js";
import { recordSettings } from "./recsettings.js";
import { gestures } from "./gestures.js";

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/></svg>',
  metro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 3h6l4 18H5z"/><path d="M12 15l6-9"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  capture: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3 4v4.5h4.5"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16"/><path d="M14 6l6 6-6 6"/></svg>',
};
const icon = (name, label, onclick, cls = "") => h("button", { type: "button", class: "tb-btn " + cls, title: label, "aria-label": label, onclick, html: ICON[name] });

export class Topbar {
  constructor(app) {
    this.app = app;
    const store = app.store;
    this.name = h("button", { type: "button", class: "tb-project", onclick: () => openProjects(app) }, "");
    this.undoBtn = icon("undo", "Undo", () => store.undo());
    this.redoBtn = icon("redo", "Redo", () => store.redo());
    this.playBtn = icon("play", "Play (space)", () => app.togglePlay(), "play");
    this.stopBtn = icon("stop", "Stop (twice: to the start)", () => app.stop(), "stop");
    this.recBtn = icon("rec", "Record on the armed tracks (long press: count-in and settings)", null, "rec");
    this.recBadge = h("span", { class: "tb-badge" });
    this.recBtn.append(this.recBadge);
    gestures(this.recBtn, { tap: () => this.toggleRecord(), longPress: () => recordSettings(app) });
    this.captureBtn = icon("capture", "Capture: what you just played, as a clip (even when nothing was recording)", () => app.recording.capture(), "capture");
    this.loopBtn = icon("loop", "Loop", () => store.update((p) => { p.loop.on = !p.loop.on; }, "loop"), "loop");
    this.metroBtn = icon("metro", "Metronome", () => store.update((p) => { p.metronome = !p.metronome; }, "transport"), "metro");
    this.backBtn = h("button", { type: "button", class: "tb-back", title: "Back to Arrangement: the tracks play the arrangement again", onclick: () => app.transport.backToArrangement(), html: ICON.back + "<span>Arrangement</span>" });
    this.bpm = numberDrag({
      value: store.project.bpm, min: 40, max: 240, step: 0.5, cls: "tb-bpm", title: "Tempo (BPM)", pxPerStep: 3,
      format: (v) => (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)),
      onInput: (v) => store.live((p) => { p.bpm = v; }, "tempo"),
      onChange: (v) => store.update((p) => { p.bpm = v; }, "tempo"),
    });
    this.tapTimes = [];
    const tap = h("button", { type: "button", class: "tb-tap", title: "Tap tempo", onclick: () => this.tapTempo() }, "TAP");
    this.pos = h("div", { class: "tb-pos" }, h("div", { class: "tb-bars" }), h("div", { class: "tb-time" }));
    this.views = segmented([
      { value: "arrange", label: "Arrange" }, { value: "session", label: "Session" }, { value: "mixer", label: "Mixer" },
    ], store.ui.view, (v) => app.setView(v), "tb-views");
    const add = icon("plus", "Add a track", (e) => this.addMenu(e.currentTarget), "add");
    const exp = icon("share", "Export, record the output", (e) => this.exportMenu(e.currentTarget));
    const more = icon("menu", "Projects and settings", (e) => this.moreMenu(e.currentTarget));
    this.meter = h("canvas", { class: "tb-meter", width: 6, height: 30, title: "Master level" });
    this.cpu = h("span", { class: "tb-cpu" });
    this.el = h("header", { class: "topbar" },
      h("div", { class: "tb-group left" }, h("span", { class: "logo-mark", "aria-hidden": "true" }), this.name, this.undoBtn, this.redoBtn),
      h("div", { class: "tb-group transport" }, this.playBtn, this.stopBtn, this.recBtn, this.captureBtn, this.loopBtn, this.metroBtn,
        h("div", { class: "tb-tempo" }, this.bpm, h("span", { class: "tb-unit" }, "BPM"), tap), this.pos, this.backBtn),
      h("div", { class: "tb-group right" }, this.views, add, exp, more, this.meter));
    this.update();
  }

  async toggleRecord() {
    const app = this.app;
    if (app.recording.active) { await app.recording.stop(); return; }
    await app.recording.start();
  }

  tapTempo() {
    const now = performance.now();
    this.tapTimes = this.tapTimes.filter((t) => now - t < 2500);
    this.tapTimes.push(now);
    if (this.tapTimes.length >= 3) {
      const d = (this.tapTimes[this.tapTimes.length - 1] - this.tapTimes[0]) / (this.tapTimes.length - 1);
      const bpm = Math.round(600000 / d) / 10;
      if (bpm >= 40 && bpm <= 240) this.app.store.update((p) => { p.bpm = Math.round(bpm * 2) / 2; }, "tempo");
    }
  }

  addMenu(anchor) {
    const app = this.app;
    menu(anchor, [
      ...INSTRUMENT_KINDS.map((k) => ({ label: k.kind === "drumrack" ? "Drum Rack track" : k.name + " track", hint: k.kind === "drumrack" ? "MIDI" : "synth", onClick: () => app.addTrack("midi", k.kind) })),
      "-",
      { label: "Audio track", hint: "samples, loops, input", onClick: () => app.addTrack("audio") },
      "-",
      { label: "Tracks from a MIDI file…", hint: ".mid", onClick: () => importMidiAsTracks(app) },
    ], { title: "Add track" });
  }

  exportMenu(anchor) {
    const app = this.app;
    menu(anchor, [
      { label: "Export mix (WAV)…", onClick: () => exportDialog(app, { stems: false }) },
      { label: "Export stems (zip of WAVs)…", onClick: () => exportDialog(app, { stems: true }) },
      "-",
      { label: app.outputRec ? "Stop recording the output" : "Record the output (live)", checked: !!app.outputRec, onClick: () => recordOutput(app) },
    ], { title: "Export" });
  }

  moreMenu(anchor) {
    const app = this.app, store = app.store;
    menu(anchor, [
      { label: "Projects…", onClick: () => openProjects(app) },
      { label: "Save now", hint: "⌘S", onClick: () => app.save().then(() => toast("Saved")) },
      { label: "New project", onClick: () => app.newProject() },
      "-",
      { label: "Recording settings…", hint: "count-in", onClick: () => recordSettings(app) },
      { label: "Launch quantization", hint: store.project.launchQuant ? store.project.launchQuant / 4 + " bar" : "none", onClick: () => {
        const next = { 0: 1, 1: 4, 4: 8, 8: 16, 16: 0 }[store.project.launchQuant] ?? 4;
        store.update((p) => { p.launchQuant = next; }, "transport");
        toast("Launch quantization: " + (next ? (next < 4 ? next + " beat" : next / 4 + " bar" + (next > 4 ? "s" : "")) : "none"));
      } },
      { label: "Settings and help…", onClick: () => settingsSheet(app) },
    ]);
  }

  update() {
    const app = this.app, store = app.store, p = store.project, tr = app.transport;
    this.name.textContent = p.name + (store.ui.dirty ? " •" : "");
    this.undoBtn.disabled = !store.undoStack.length;
    this.redoBtn.disabled = !store.redoStack.length;
    this.playBtn.classList.toggle("on", tr.playing);
    const rec = app.recording;
    this.recBtn.classList.toggle("on", rec.state === "rec");
    this.recBtn.classList.toggle("armed", rec.state === "countin");
    this.recBadge.textContent = rec.prefs.countIn ? String(rec.prefs.countIn) : "";
    this.recBadge.title = rec.prefs.countIn ? `Count-in: ${rec.prefs.countIn} bar${rec.prefs.countIn > 1 ? "s" : ""}` : "";
    this.loopBtn.classList.toggle("on", p.loop.on);
    this.metroBtn.classList.toggle("on", p.metronome);
    this.bpm.set(p.bpm);
    this.views.set(store.ui.view);
    this.backBtn.hidden = !tr.overridden;
  }

  frame() {
    const app = this.app, tr = app.transport, p = app.store.project;
    const b = tr.playing ? tr.songBeat() : tr.position;
    const bars = fmtBars(b, p.sig || 4);
    if (bars !== this.lastBars) { this.pos.firstChild.textContent = bars; this.pos.lastChild.textContent = fmtTime(b, p.bpm); this.lastBars = bars; }
    drawMeter(this.meter, app.engine.masterPeak());
    const rec = app.recording;
    if (rec.state === "countin") this.recBtn.classList.toggle("blink", Math.floor(performance.now() / 180) % 2 === 0);
    else if (app.outputRec && rec.state !== "rec") this.recBtn.classList.toggle("blink", Math.floor(performance.now() / 400) % 2 === 0);
    else this.recBtn.classList.remove("blink");
    if ((this.frames = (this.frames || 0) + 1) % 15 === 0) this.captureBtn.disabled = !rec.canCapture;
  }
}
