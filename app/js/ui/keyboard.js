// Keys: what you play a track with by touch. A synth has three surfaces: Piano (a multi-touch keyboard, the song's
// scale marked on it), Pads (a grid that only holds the scale's notes: no wrong ones, and a chord has the same shape
// everywhere; rows a fourth apart, as a Push or a Launchpad in key) and Chords (a pad a chord of the key: triads below,
// sevenths above). A Drum Rack has its 16 pads. Where you touch a key or pad sets how hard it's played (lower: louder),
// and sliding along keys or pads glides. It plays the armed tracks, or the selected one, and records when Record is on.
// The key and scale are the song's (project.key, project.scale: js/scales.js).
import { h, isBlack, noteName } from "../util.js";
import { segmented, select } from "./controls.js";
import { DRUM_BASE_NOTE } from "../model.js";
import { SCALES, NOTE_LETTERS, keyOf, inScale, isRoot, padGrid, chords, noteLabel } from "../scales.js";

const LAYOUTS = [{ value: "piano", label: "Piano" }, { value: "pads", label: "Pads" }, { value: "chords", label: "Chords" }];
const stored = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };

export class KeysView {
  constructor(app, track) {
    this.app = app;
    this.trackId = track.id;
    this.octave = Number(stored("minidaw.octave", 3));
    this.span = Number(stored("minidaw.span", 2));
    this.layout = LAYOUTS.some((l) => l.value === stored("minidaw.keysLayout", "piano")) ? stored("minidaw.keysLayout", "piano") : "piano";
    this.rows = 4;
    this.el = h("div", { class: "keys" });
    this.down = new Map(); // pointerId -> { el, notes }
    this.render();
    // the pads' rows follow the panel's height
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver(() => {
        const rows = this.rowsFor();
        if (rows !== this.rows && this.layout === "pads" && !this.drums && !this.down.size) { this.rows = rows; this.render(); }
      });
      this.ro.observe(this.el);
    }
  }
  get t() { return this.app.store.track(this.trackId); }
  get drums() { const t = this.t; return t && t.type === "midi" && t.instrument.kind === "drumrack"; }
  rowsFor() { const hgt = this.el.clientHeight - 50; return hgt > 0 ? Math.max(2, Math.min(6, Math.floor(hgt / 60))) : 4; }

  render() {
    this.releaseAll();
    this.el.textContent = "";
    const t = this.t;
    if (!t) return;
    if (t.type === "audio") { this.el.append(h("p", { class: "panel-empty" }, "An audio track has no keys: select a MIDI track to play it.")); return; }
    const app = this.app;
    const targets = app.liveTargets();
    const info = h("span", { class: "keys-info" }, targets.length ? "Playing: " + targets.map((x) => x.name).join(", ") : "");
    if (this.drums) {
      const grid = h("div", { class: "keys-pads" });
      const pads = t.instrument.state.pads;
      for (let row = 3; row >= 0; row--) for (let col = 0; col < 4; col++) {
        const i = row * 4 + col;
        const el = h("div", { class: "pad big", style: { "--tc": t.color } }, h("span", { class: "pad-name" }, pads[i].name), h("span", { class: "pad-note" }, String(i + 1)));
        el.dataset.note = DRUM_BASE_NOTE + i;
        el.dataset.pad = i; // an audio file dropped here loads onto the pad
        el.dataset.track = t.id;
        grid.append(el);
      }
      this.wire(grid, ".pad", { slide: false, loudAt: "top" });
      this.el.append(h("div", { class: "keys-bar" }, info, h("span", { class: "dim" }, "Pads 1-16 are C1 to D#2, as an Ableton Drum Rack.")), grid);
      return;
    }
    const key = keyOf(app.store.project);
    const btn = (label, fn, title) => h("button", { type: "button", class: "btn small", title, onclick: fn }, label);
    const layout = segmented(LAYOUTS, this.layout, (v) => { this.layout = v; store("minidaw.keysLayout", v); this.render(); }, "keys-layout");
    const setKey = (patch) => { app.store.update((p) => Object.assign(p, patch), "key"); this.render(); };
    const keySel = select(NOTE_LETTERS.map((n, i) => ({ value: i, label: n })), key.root, (v) => setKey({ key: +v }), "keys-key");
    keySel.setAttribute("aria-label", "Key");
    const scaleSel = select(SCALES.map((s) => ({ value: s.id, label: s.name })), key.scale.id, (v) => setKey({ scale: v }), "keys-scale");
    scaleSel.setAttribute("aria-label", "Scale");
    // the piano's octave is its lowest C; the pads and chords start an octave below it, where a left hand sits
    const low = this.layout === "piano" ? 12 * (this.octave + 2) : 12 * (this.octave + 1);
    const bar = h("div", { class: "keys-bar" }, layout,
      h("span", { class: "keys-group" }, h("span", { class: "dim" }, "Key"), keySel, scaleSel),
      h("span", { class: "keys-group" }, btn("Oct −", () => this.setOct(this.octave - 1), "An octave lower"), h("span", { class: "keys-oct" }, noteLabel(low)), btn("Oct +", () => this.setOct(this.octave + 1), "An octave higher")),
      this.layout === "piano" ? btn(this.span === 2 ? "3 octaves" : this.span === 3 ? "1 octave" : "2 octaves", () => { this.span = this.span === 2 ? 3 : this.span === 3 ? 1 : 2; store("minidaw.span", this.span); this.render(); }, "How many octaves the keyboard shows") : null,
      btn("All off", () => this.allOff(), "All notes off"),
      info);
    let surface;
    if (this.layout === "pads") {
      this.rows = this.rowsFor();
      const grid = padGrid({ root: key.root, steps: key.scale.steps, low, cols: 8, rows: this.rows });
      surface = h("div", { class: "npads", style: { "--tc": t.color, gridTemplateRows: `repeat(${this.rows}, 1fr)` } });
      for (let r = grid.length - 1; r >= 0; r--) for (const p of grid[r]) {
        const el = h("div", { class: "npad" + (p.root ? " root" : "") }, noteLabel(p.note));
        el.dataset.note = p.note;
        surface.append(el);
      }
      this.wire(surface, ".npad", { slide: true });
    } else if (this.layout === "chords") {
      surface = h("div", { class: "chords", style: { "--tc": t.color } });
      for (const seventh of [true, false]) for (const c of chords(key.root, key.scale, { seventh, base: low })) {
        const el = h("div", { class: "chord" + (seventh ? " seventh" : "") + (c.degree === 0 ? " root" : "") }, h("b", {}, c.name), h("span", {}, c.notes.map((n) => NOTE_LETTERS[n % 12]).join(" ")));
        el.dataset.notes = c.notes.join(",");
        el.setAttribute("aria-label", "Chord " + c.name);
        surface.append(el);
      }
      this.wire(surface, ".chord", { slide: false });
    } else {
      const lo = low, hi = lo + 12 * this.span + 1;
      surface = h("div", { class: "piano" });
      const marked = key.scale.steps.length < 12;
      const whites = [];
      for (let n = lo; n < hi; n++) if (!isBlack(n)) whites.push(n);
      const ww = 100 / whites.length;
      let wi = 0;
      for (let n = lo; n < hi; n++) {
        const mark = marked && inScale(n, key.root, key.scale.steps) ? h("i", { class: "kb-dot" + (isRoot(n, key.root) ? " root" : "") }) : null;
        if (isBlack(n)) {
          const el = h("div", { class: "kb-key black", style: { left: `calc(${wi * ww}% - ${ww * 0.3}%)`, width: ww * 0.6 + "%" } }, mark);
          el.dataset.note = n;
          surface.append(el);
        } else {
          const el = h("div", { class: "kb-key white", style: { left: wi * ww + "%", width: ww + "%" } }, mark, n % 12 === 0 ? h("span", {}, noteName(n)) : null);
          el.dataset.note = n;
          surface.append(el);
          wi++;
        }
      }
      this.wire(surface, ".kb-key", { slide: true });
    }
    this.el.append(bar, surface);
  }

  setOct(o) { this.octave = Math.max(-1, Math.min(7, o)); store("minidaw.octave", this.octave); this.render(); }

  allOff() {
    this.releaseAll();
    for (const tr of this.app.liveTargets()) { const i = this.app.engine.instrument(tr.id); if (i) i.midi([0xb0, 123, 0]); }
  }
  releaseAll() {
    for (const d of this.down.values()) for (const n of d.notes) this.app.liveNote(false, n, 0);
    this.down.clear();
  }

  /** Touches on a surface: each pointer holds the key, pad or chord under it; slide: moving onto another one plays that */
  wire(root, sel, { slide = true, loudAt = "bottom" } = {}) {
    const app = this.app;
    const at = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const k = el && el.closest(sel);
      if (!k || !root.contains(k)) return null;
      const r = k.getBoundingClientRect();
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const vel = loudAt === "top" ? Math.round(60 + 67 * (1 - y)) : Math.round(40 + 87 * y);
      return { el: k, notes: (k.dataset.notes || k.dataset.note).split(",").map(Number), vel };
    };
    const held = (el) => [...this.down.values()].some((d) => d.el === el);
    const press = (id, n) => {
      this.down.set(id, { el: n.el, notes: n.notes });
      for (const note of n.notes) app.liveNote(true, note, n.vel);
      n.el.classList.add("on");
    };
    const release = (id) => {
      const d = this.down.get(id);
      if (!d) return;
      this.down.delete(id);
      // a note another finger still holds (the same pad, or a chord sharing it) keeps sounding
      const still = new Set([...this.down.values()].flatMap((x) => x.notes));
      for (const note of d.notes) if (!still.has(note)) app.liveNote(false, note, 0);
      if (!held(d.el)) d.el.classList.remove("on");
    };
    root.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { root.setPointerCapture(e.pointerId); } catch (_) { /* a pointer that's already gone */ }
      const n = at(e);
      if (n) press(e.pointerId, n);
    });
    root.addEventListener("pointermove", (e) => {
      const cur = this.down.get(e.pointerId);
      if (!cur || !slide) return;
      const n = at(e);
      if (!n || n.el === cur.el) return;
      release(e.pointerId);
      press(e.pointerId, n);
    });
    const up = (e) => release(e.pointerId);
    root.addEventListener("pointerup", up);
    root.addEventListener("pointercancel", up);
    root.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Light a key played from elsewhere (MIDI, the computer keyboard) */
  lit(note, on) {
    for (const k of this.el.querySelectorAll(`[data-note="${note}"]`)) k.classList.toggle("on", on);
  }

  update(c) { if (c && (c.reason === "tracks" || c.reason === "mixer" || c.reason === "pad" || c.reason === "key" || c.reason === "undo" || c.reason === "redo" || c.reason === "project")) this.render(); }
  dispose() { this.releaseAll(); if (this.ro) this.ro.disconnect(); }
}
