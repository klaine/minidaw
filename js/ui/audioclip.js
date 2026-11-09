// An audio clip: its sample's waveform with the part the clip plays, Warp (follow the song's tempo, by resampling),
// the sample's own tempo, the clip's start in the sample (drag the start marker), length and gain.
import { h, clamp } from "../util.js";
import { gestures, Surface } from "./gestures.js";
import { knob, numberDrag, toggle } from "./controls.js";
import { guessBpm } from "../model.js";
import { shade } from "./arrange.js";

export class AudioClipEditor {
  constructor(app, track, clip) {
    this.app = app;
    this.trackId = track.id;
    this.clipId = clip.id;
    this.canvas = h("canvas", { class: "ac-canvas" });
    this.toolbar = h("div", { class: "pr-toolbar" });
    this.el = h("div", { class: "ac" }, this.toolbar, h("div", { class: "pr-body" }, this.canvas));
    this.surf = new Surface(this.canvas, (c, w, hh) => this.draw(c, w, hh));
    this.renderToolbar();
    this.setupGestures();
    app.samples.load(clip.sampleId, app.ctx).then(() => this.surf.draw());
  }
  get store() { return this.app.store; }
  get clip() { return this.store.project.clips[this.clipId]; }
  get buffer() { return this.app.samples.buffer(this.clip.sampleId); }
  secPerBeat(c = this.clip) { return c.warp ? 60 / c.bpm : 60 / this.store.project.bpm; }

  renderToolbar() {
    const store = this.store, c = this.clip;
    this.toolbar.textContent = "";
    const set = (fn, live) => (live ? store.live : store.update).call(store, () => fn(this.clip), "clips");
    const len = h("span", { class: "pr-len" }, fmt(c.length));
    const setLen = (L) => { set((x) => { x.length = Math.max(0.25, L); }); len.textContent = fmt(this.clip.length); this.surf.draw(); };
    const bpm = numberDrag({ value: c.bpm, min: 30, max: 300, step: 0.5, title: "The sample's tempo", format: (v) => v.toFixed(1) + " BPM",
      onInput: (v) => { set((x) => { x.bpm = v; }, true); this.surf.draw(); }, onChange: (v) => { set((x) => { x.bpm = v; }); this.surf.draw(); } });
    const btn = (label, fn, title) => h("button", { type: "button", class: "btn small", title, onclick: fn }, label);
    const gain = knob({ label: "Gain", value: (c.gain ?? 1) / 2, def: 0.5, small: true, size: 34, format: (v) => (v <= 0 ? "-∞" : (20 * Math.log10(v * 2)).toFixed(1) + " dB"),
      onInput: (v) => set((x) => { x.gain = v * 2; }, true), onChange: (v) => set((x) => { x.gain = v * 2; }) });
    this.toolbar.append(
      toggle("Warp", c.warp, () => { set((x) => { x.warp = !x.warp; }); this.renderToolbar(); this.surf.draw(); }, "small"),
      bpm,
      btn("÷2", () => { set((x) => { x.bpm = Math.max(30, x.bpm / 2); }); this.renderToolbar(); this.surf.draw(); }, "Half the sample's tempo"),
      btn("×2", () => { set((x) => { x.bpm = Math.min(300, x.bpm * 2); }); this.renderToolbar(); this.surf.draw(); }, "Double the sample's tempo"),
      btn("Guess", () => { const b = this.buffer; const g = b && guessBpm(b.duration - (this.clip.offset || 0)); if (g) { set((x) => { x.bpm = g; x.warp = true; }); this.renderToolbar(); this.surf.draw(); } }, "Guess the tempo from its length (whole bars)"),
      h("span", { class: "pr-group" }, h("span", { class: "dim" }, "Length"), btn("−", () => setLen(this.clip.length - (this.clip.length > 4 ? 4 : 1))), len, btn("+", () => setLen(this.clip.length + (this.clip.length >= 4 ? 4 : 1)))),
      btn("Fit", () => { const b = this.buffer; if (!b) return; setLen(Math.max(0.25, Math.round(((b.duration - (this.clip.offset || 0)) / this.secPerBeat()) * 4) / 4)); }, "Length to the end of the sample"),
      btn("Start ⟲", () => { set((x) => { x.offset = 0; }); this.surf.draw(); }, "Start at the beginning of the sample"),
      gain,
      h("span", { class: "dim ac-info" }, this.app.samples.name(c.sampleId)));
  }

  update() { this.surf.draw(); }

  setupGestures() {
    let drag = null;
    gestures(this.canvas, {
      dragStart: (pos) => {
        const b = this.buffer;
        if (!b) return false;
        const x0 = this.secX(this.clip.offset || 0), x1 = this.secX((this.clip.offset || 0) + this.clip.length * this.secPerBeat());
        this.store.begin();
        drag = Math.abs(pos.x - x1) < 24 ? "end" : "start";
        void x0;
        return true;
      },
      dragMove: (pos) => {
        const b = this.buffer;
        const sec = clamp(this.xSec(pos.x), 0, b.duration);
        this.store.live(() => {
          const c = this.clip;
          if (drag === "start") c.offset = Math.min(sec, b.duration - 0.05);
          else c.length = Math.max(0.25, Math.round(((sec - (c.offset || 0)) / this.secPerBeat(c)) * 16) / 16);
        }, "clips");
        this.surf.draw();
      },
      dragEnd: () => { this.store.commit("clips"); this.renderToolbar(); drag = null; },
      tap: (pos) => {
        // audition from here
        const b = this.buffer;
        if (!b) return;
        const ctx = this.app.ctx;
        if (this.preview) try { this.preview.stop(); } catch (_) { /* ended */ }
        const src = ctx.createBufferSource();
        src.buffer = b;
        src.connect(this.app.engine.master.input);
        src.start(0, clamp(this.xSec(pos.x), 0, b.duration));
        src.stop(ctx.currentTime + 2);
        this.preview = src;
      },
    });
  }
  secX(s) { const b = this.buffer; return 10 + (s / b.duration) * (this.surf.w - 20); }
  xSec(x) { const b = this.buffer; return ((x - 10) / (this.surf.w - 20)) * b.duration; }

  draw(c, w, hh) {
    const clip = this.clip;
    c.fillStyle = "#1d1e22";
    c.fillRect(0, 0, w, hh);
    const b = this.buffer;
    if (!clip || !b) { c.fillStyle = "#777"; c.fillText("Loading the sample…", 12, 20); return; }
    const col = clip.color || "#5a8cff";
    const peaks = this.app.samples.peaks(clip.sampleId, 2048);
    const mid = hh / 2, amp = hh / 2 - 12;
    const s0 = clip.offset || 0, s1 = s0 + clip.length * this.secPerBeat();
    const x0 = this.secX(s0), x1 = this.secX(Math.min(b.duration, s1));
    c.fillStyle = "rgba(255,255,255,0.04)";
    c.fillRect(x0, 0, x1 - x0, hh);
    for (let px = 10; px < w - 10; px++) {
      const i = Math.floor(((px - 10) / (w - 20)) * 2048);
      const lo = peaks[2 * i] * amp * (clip.gain ?? 1), hi = peaks[2 * i + 1] * amp * (clip.gain ?? 1);
      c.fillStyle = px >= x0 && px <= x1 ? col : shade(col, -0.6);
      c.fillRect(px, mid - hi, 1, Math.max(1, hi - lo));
    }
    // beat lines inside the clip
    const spb = this.secPerBeat();
    for (let k = 0; s0 + k * spb < Math.min(s1, b.duration); k++) {
      const x = this.secX(s0 + k * spb);
      c.fillStyle = k % 4 === 0 ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.08)";
      c.fillRect(Math.round(x), 0, 1, hh);
      if (k % 4 === 0) { c.fillStyle = "#9fa3ab"; c.font = "10px -apple-system, system-ui, sans-serif"; c.fillText(String(k / 4 + 1), x + 3, 12); }
    }
    // markers
    c.fillStyle = "#ffd84a";
    c.fillRect(x0 - 1, 0, 3, hh);
    c.beginPath(); c.moveTo(x0, 0); c.lineTo(x0 + 12, 0); c.lineTo(x0, 12); c.fill();
    c.fillStyle = "#fff";
    c.fillRect(x1 - 1, 0, 2, hh);
    if (s1 > b.duration) { c.fillStyle = "#ff8a6a"; c.font = "11px -apple-system, system-ui, sans-serif"; c.fillText("the clip is longer than the sample: silence after its end", 14, hh - 10); }
  }

  dispose() { this.surf.dispose(); if (this.preview) try { this.preview.stop(); } catch (_) { /* ended */ } }
}
const fmt = (beats) => (beats % 4 === 0 ? beats / 4 + (beats === 4 ? " bar" : " bars") : beats + " beats");
