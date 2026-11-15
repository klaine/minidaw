// The step sequencer for a Drum Rack clip: a row per pad, a page of 16 steps per bar (at 1/16). Tap a step to set it
// or clear it, drag across steps to paint (or erase) a run, long press a step for its velocity or a ratchet. Accent
// sets loud steps, Swing delays the off-beat 16ths. The notes are the clip's own: the piano roll shows the same ones.
import { h, clamp } from "../util.js";
import { menu, segmented, select, knob, toggle } from "./controls.js";
import { DRUM_BASE_NOTE } from "../model.js";
import { loopButton } from "./audition.js";
import { clipPlayhead } from "./pianoroll.js";

const STEPS = 16;
const RES = [[0.5, "1/8"], [0.25, "1/16"], [0.125, "1/32"], [1 / 6, "1/16T"]];
const VEL = { normal: 100, accent: 127, soft: 64 };
const EPS = 1e-6;
const r4 = (x) => Math.round(x * 10000) / 10000;

export class StepSequencer {
  constructor(app, track, clip) {
    this.app = app;
    this.trackId = track.id;
    this.clipId = clip.id;
    this.res = app.store.ui.stepRes || 0.25;
    this.page = 0;
    this.accent = false;
    this.follow = true;
    this.toolbar = h("div", { class: "pr-toolbar st-toolbar" });
    this.grid = h("div", { class: "st-grid", role: "grid", "aria-label": "Steps" });
    this.el = h("div", { class: "st" }, this.toolbar, h("div", { class: "st-scroll" }, this.grid));
    this.renderToolbar();
    this.render();
    this.setupPaint();
  }
  get store() { return this.app.store; }
  get clip() { return this.store.project.clips[this.clipId]; }
  get t() { return this.store.track(this.trackId); }
  get pageLen() { return STEPS * this.res; }
  get pages() { return Math.max(1, Math.ceil(this.clip.length / this.pageLen - EPS)); }
  stepTime(i) { return r4(this.page * this.pageLen + i * this.res); }

  renderToolbar() {
    const store = this.store, clip = this.clip, app = this.app;
    this.toolbar.textContent = "";
    const btn = (label, fn, title, cls = "") => h("button", { type: "button", class: "btn small " + cls, title, onclick: fn }, label);
    const view = segmented([{ value: "steps", label: "Steps" }, { value: "roll", label: "Piano roll" }], "steps", (v) => store.select({ drumView: v }), "pr-tool");
    const res = select(RES.map(([v, l]) => ({ value: v, label: l })), this.res, (v) => { this.res = +v; store.ui.stepRes = this.res; this.page = 0; this.renderToolbar(); this.render(); }, "pr-grid");
    res.title = "Step length";
    const pages = h("span", { class: "pr-group st-pages" });
    for (let i = 0; i < this.pages; i++) {
      pages.append(h("button", { type: "button", class: "btn small st-page" + (i === this.page ? " on" : ""), "aria-label": "Page " + (i + 1),
        onclick: () => { this.page = i; this.follow = false; this.renderToolbar(); this.render(); } }, String(i + 1)));
    }
    const setLen = (L) => { store.update(() => { this.clip.length = Math.max(this.pageLen, L); }, "notes"); this.page = Math.min(this.page, this.pages - 1); this.renderToolbar(); this.render(); };
    const bars = (b) => b / 4 + (b === 4 ? " bar" : " bars");
    const swing = knob({ label: "Swing", value: clip.swing || 0, def: 0, small: true, size: 30, format: (v) => Math.round(v * 100) + "%",
      onInput: (v) => store.live(() => { this.clip.swing = Math.round(v * 100) / 100; }, "notes"),
      onChange: (v) => store.update(() => { this.clip.swing = Math.round(v * 100) / 100; }, "notes") });
    this.loopBtn = loopButton(this.app, this.trackId, () => this.clip);
    this.toolbar.append(this.loopBtn, view, res,
      h("span", { class: "pr-group" }, h("span", { class: "dim" }, "Length"), btn("−", () => setLen(this.clip.length - 4), "A bar shorter"),
        h("span", { class: "pr-len" }, bars(clip.length)), btn("+", () => setLen(this.clip.length + 4), "A bar longer")),
      btn("×2", () => this.double(), "Double the clip, its steps repeated"),
      pages,
      toggle("Follow", this.follow, () => { this.follow = !this.follow; this.renderToolbar(); }, "small"),
      toggle("Accent", this.accent, () => { this.accent = !this.accent; this.renderToolbar(); }, "small st-accent"),
      swing,
      btn("Clear", () => store.update(() => { this.clip.notes = []; }, "notes"), "Clear every step"),
      btn("Pad sounds ▸", () => store.select({ panel: "device" }), "The pads' samples: choose, trim, tune", "primary"));
  }

  /** The notes of pad row p in step i of this page */
  notesAt(p, i) {
    const t0 = this.stepTime(i), t1 = t0 + this.res;
    return this.clip.notes.filter((n) => n.p === p && n.t >= t0 - EPS && n.t < t1 - EPS);
  }

  render() {
    const t = this.t, clip = this.clip;
    if (!t || !clip) return;
    this.el.style.setProperty("--tc", t.color);
    this.grid.textContent = "";
    this.cells = [];
    const pads = t.instrument.state.pads;
    const per = Math.round(1 / this.res); // steps per beat
    this.grid.style.gridTemplateColumns = `118px repeat(${STEPS}, minmax(30px, 1fr))`;
    for (let r = 0; r < 16; r++) {
      const p = DRUM_BASE_NOTE + r, pad = pads[r];
      const used = clip.notes.some((n) => n.p === p);
      const name = h("button", { type: "button", class: "st-name" + (used ? " used" : "") + (pad.mute ? " muted" : ""), title: "Hear the pad (and pick it for Pad sounds)",
        onclick: () => {
          this.store.ui.drumPad = r;
          const inst = this.app.engine.instrument(this.trackId);
          if (inst) inst.noteOn(p, 110, 0);
        } }, h("span", { class: "st-num" }, String(r + 1)), pad.name);
      const mute = h("button", { type: "button", class: "st-mute" + (pad.mute ? " on" : ""), title: "Mute the pad", "aria-label": "Mute " + pad.name,
        onclick: () => this.store.update((pp) => { const x = pp.tracks.find((q) => q.id === this.trackId).instrument.state.pads[r]; x.mute = !x.mute; }, "pad") }, "M");
      this.grid.append(h("div", { class: "st-row-head" }, name, mute));
      const row = [];
      for (let i = 0; i < STEPS; i++) {
        const t0 = this.stepTime(i);
        const inClip = t0 < clip.length - EPS;
        const cell = h("button", { type: "button", class: "st-cell" + (i % per === 0 ? " beat" : "") + (Math.floor(i / per) % 2 ? " odd" : "") + (inClip ? "" : " out"),
          dataset: { r, i }, "aria-label": `${pad.name} step ${this.page * STEPS + i + 1}`, disabled: !inClip });
        row.push(cell);
        this.grid.append(cell);
      }
      this.cells.push(row);
    }
    this.paintCells();
  }

  paintCells() {
    if (!this.cells) return;
    for (let r = 0; r < 16; r++) {
      for (let i = 0; i < STEPS; i++) {
        const ns = this.notesAt(DRUM_BASE_NOTE + r, i);
        const cell = this.cells[r][i];
        const on = ns.length > 0;
        const v = on ? Math.max(...ns.map((n) => n.v)) : 0;
        cell.classList.toggle("on", on);
        cell.classList.toggle("accent", on && v >= 120);
        cell.classList.toggle("soft", on && v < 80);
        cell.classList.toggle("ratchet", ns.length > 1);
        cell.classList.toggle("offgrid", on && ns.every((n) => Math.abs(n.t - this.stepTime(i)) > EPS));
        cell.setAttribute("aria-pressed", String(on));
        cell.style.setProperty("--v", on ? (0.45 + 0.55 * (v / 127)).toFixed(2) : "0");
      }
    }
  }

  /** Set step i of row r (or clear it) */
  setStep(r, i, on, live) {
    const p = DRUM_BASE_NOTE + r, t0 = this.stepTime(i);
    if (t0 >= this.clip.length - EPS) return;
    const apply = () => {
      const c = this.clip;
      c.notes = c.notes.filter((n) => !(n.p === p && n.t >= t0 - EPS && n.t < t0 + this.res - EPS));
      if (on) c.notes.push({ p, t: t0, d: r4(this.res), v: this.accent ? VEL.accent : VEL.normal });
    };
    (live ? this.store.live : this.store.update).call(this.store, apply, "notes");
    if (on) { const inst = this.app.engine.instrument(this.trackId); if (inst && !this.app.transport.playing) inst.noteOn(p, this.accent ? 127 : 100, 0); }
    this.paintCells();
  }

  /** Tap a step to toggle it; drag across steps to paint or erase (one undo step); hold for its menu */
  setupPaint() {
    let paint = null, hold = 0;
    const cellAt = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const c = el && el.closest(".st-cell");
      return c && this.grid.contains(c) && !c.disabled ? { r: +c.dataset.r, i: +c.dataset.i, el: c } : null;
    };
    this.grid.addEventListener("pointerdown", (e) => {
      const c = cellAt(e);
      if (!c) return;
      e.preventDefault();
      this.grid.setPointerCapture(e.pointerId);
      const on = this.notesAt(DRUM_BASE_NOTE + c.r, c.i).length === 0;
      paint = { on, r: c.r, done: new Set([c.r + ":" + c.i]), moved: false, x: e.clientX, y: e.clientY, start: c };
      this.store.begin();
      this.setStep(c.r, c.i, on, true);
      clearTimeout(hold);
      hold = setTimeout(() => {
        if (!paint || paint.moved) return;
        // a hold: back to how it was, and the step's menu
        this.store.cancel();
        const start = paint.start;
        paint = null;
        this.paintCells();
        this.stepMenu(start.r, start.i, start.el);
      }, 520);
    });
    this.grid.addEventListener("pointermove", (e) => {
      if (!paint) return;
      if (Math.hypot(e.clientX - paint.x, e.clientY - paint.y) > 8) paint.moved = true;
      const c = cellAt(e);
      if (!c || c.r !== paint.r) return; // paints along its own row
      const key = c.r + ":" + c.i;
      if (paint.done.has(key)) return;
      paint.done.add(key);
      this.setStep(c.r, c.i, paint.on, true);
    });
    const end = () => {
      clearTimeout(hold);
      if (!paint) return;
      paint = null;
      this.store.commit("notes");
    };
    this.grid.addEventListener("pointerup", end);
    this.grid.addEventListener("pointercancel", end);
    this.grid.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  stepMenu(r, i, anchor) {
    const p = DRUM_BASE_NOTE + r, t0 = this.stepTime(i);
    const ratchet = (n) => this.store.update(() => {
      const c = this.clip;
      c.notes = c.notes.filter((x) => !(x.p === p && x.t >= t0 - EPS && x.t < t0 + this.res - EPS));
      for (let k = 0; k < n; k++) c.notes.push({ p, t: r4(t0 + (k * this.res) / n), d: r4(this.res / n), v: k === 0 ? VEL.normal : 84 });
    }, "notes");
    const vel = (v) => this.store.update(() => {
      const ns = this.notesAt(p, i);
      if (!ns.length) this.clip.notes.push({ p, t: t0, d: r4(this.res), v });
      else for (const n of ns) n.v = v;
    }, "notes");
    menu(anchor, [
      { label: "Accent (127)", onClick: () => vel(VEL.accent) },
      { label: "Normal (100)", onClick: () => vel(VEL.normal) },
      { label: "Soft (64)", onClick: () => vel(VEL.soft) },
      "-",
      { label: "Ratchet ×2", onClick: () => ratchet(2) },
      { label: "Ratchet ×3", onClick: () => ratchet(3) },
      { label: "Ratchet ×4", onClick: () => ratchet(4) },
      "-",
      { label: "Clear this row", danger: true, onClick: () => this.store.update(() => { this.clip.notes = this.clip.notes.filter((n) => n.p !== p); }, "notes") },
    ], { title: `${this.t.instrument.state.pads[r].name} · step ${this.page * STEPS + i + 1}` });
  }

  double() {
    this.store.update(() => {
      const c = this.clip, L = c.length;
      c.notes.push(...c.notes.filter((n) => n.t < L).map((n) => ({ ...n, t: n.t + L })));
      c.length = L * 2;
    }, "notes");
    this.renderToolbar();
    this.render();
  }

  update(c = {}) {
    if (!this.clip || !this.t) return;
    if (c.reason === "undo" || c.reason === "project" || c.reason === "pad") { this.page = Math.min(this.page, this.pages - 1); this.renderToolbar(); this.render(); return; }
    this.paintCells();
  }

  frame() {
    if (this.loopBtn) this.loopBtn.sync();
    const ph = clipPlayhead(this.app, this.trackId, this.clip);
    let step = -1;
    if (ph !== null) {
      const page = Math.floor(ph / this.pageLen + EPS);
      if (this.follow && page !== this.page && page < this.pages) { this.page = page; this.renderToolbar(); this.render(); }
      if (page === this.page) step = clamp(Math.floor((ph - page * this.pageLen) / this.res + EPS), 0, STEPS - 1);
    }
    if (step === this.lastStep) return;
    this.lastStep = step;
    if (!this.cells) return;
    for (const row of this.cells) row.forEach((cell, i) => cell.classList.toggle("now", i === step));
  }

  onKey(e) {
    if (e.key === "ArrowLeft" && this.page > 0) { this.page--; this.follow = false; this.renderToolbar(); this.render(); return true; }
    if (e.key === "ArrowRight" && this.page < this.pages - 1) { this.page++; this.follow = false; this.renderToolbar(); this.render(); return true; }
    return false;
  }
}
