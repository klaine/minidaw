// The piano roll for a MIDI clip, with a lane under it for velocity or the clip's envelopes (automation that plays
// with the clip). Draw tool: tap adds a note (drag to set its length), tap a note removes it, drag a note moves it, its
// right edge resizes it. Select tool: drag a box, then move or resize the selection. Two fingers pan, pinch zooms.
import { h, clamp, isBlack, noteName, envAt } from "../util.js";
import { gestures, Surface } from "./gestures.js";
import { menu, segmented, select, toast } from "./controls.js";
import { laneChoices, DRUM_BASE_NOTE } from "../model.js";
import { metaSync } from "../audio/instruments.js";
import { roundRect, shade } from "./arrange.js";

const KEYS_W = 48, RULER_H = 22, GAP = 6;
const GRIDS = [[1, "1/4"], [0.5, "1/8"], [0.25, "1/16"], [0.125, "1/32"], [1 / 3, "1/4T"], [1 / 6, "1/8T"], [1 / 12, "1/16T"]];

export class PianoRoll {
  constructor(app, track, clip) {
    this.app = app;
    this.trackId = track.id;
    this.clipId = clip.id;
    this.sel = new Set();
    this.drums = track.instrument && track.instrument.kind === "drumrack";
    this.ppb = 64;
    this.x0 = 0;
    this.rowH = this.drums ? 22 : 14;
    this.laneKey = app.store.ui.envKey || "vel";
    app.store.ui.envKey = null;
    this.newLen = null;
    this.newVel = 100;
    const ps = clip.notes.map((n) => n.p);
    this.top = this.drums ? DRUM_BASE_NOTE + 15 : ps.length ? Math.min(127, Math.max(...ps) + 6) : 79;
    this.canvas = h("canvas", { class: "pr-canvas" });
    this.toolbar = h("div", { class: "pr-toolbar" });
    this.el = h("div", { class: "pr" }, this.toolbar, h("div", { class: "pr-body" }, this.canvas));
    this.surf = new Surface(this.canvas, (c, w, hh) => this.draw(c, w, hh));
    this.renderToolbar();
    this.setupGestures();
    requestAnimationFrame(() => this.fit());
  }

  get store() { return this.app.store; }
  get clip() { return this.store.project.clips[this.clipId]; }
  get t() { return this.store.track(this.trackId); }
  get grid() { return this.store.ui.grid || 0.25; }
  get gridTop() { return RULER_H; }
  get laneH() { return Math.round(Math.max(44, Math.min(84, (this.surf.h || 300) * 0.24))); }
  get gridBottom() { return this.surf.h - this.laneH - GAP; }
  bx(b) { return KEYS_W + (b - this.x0) * this.ppb; }
  xb(x) { return this.x0 + (x - KEYS_W) / this.ppb; }
  py(p) { return this.gridTop + (this.top - p) * this.rowH; }
  yp(y) { return Math.floor(this.top - (y - this.gridTop) / this.rowH) + 1; }
  snapT(b) { const g = this.grid; return Math.round(b / g) * g; }
  floorT(b) { const g = this.grid; return Math.floor(b / g + 1e-6) * g; }
  rowsVisible() { return Math.max(1, (this.gridBottom - this.gridTop) / this.rowH); }

  fit() {
    const clip = this.clip;
    if (!clip || !this.surf.w) { if (clip) setTimeout(() => this.fit(), 50); return; }
    this.ppb = clamp((this.surf.w - KEYS_W - 16) / Math.max(1, clip.length), 8, 400);
    this.x0 = 0;
    if (this.drums) {
      this.rowH = Math.max(14, Math.min(30, (this.gridBottom - this.gridTop) / 16));
      // the pads in use in view, from the lowest
      const used = clip.notes.map((n) => n.p).filter((p) => p >= DRUM_BASE_NOTE && p < DRUM_BASE_NOTE + 16);
      const rows = Math.floor(this.rowsVisible());
      const lo = used.length ? Math.min(...used) : DRUM_BASE_NOTE, hi = used.length ? Math.max(...used) : DRUM_BASE_NOTE + 15;
      this.top = Math.min(DRUM_BASE_NOTE + 15, hi - lo + 1 <= rows ? Math.max(hi, lo + rows - 1) : lo + rows - 1);
    } else if (clip.notes.length) {
      const ps = clip.notes.map((n) => n.p);
      const mid = (Math.max(...ps) + Math.min(...ps)) / 2;
      this.top = Math.min(127, Math.round(mid + this.rowsVisible() / 2));
    }
    this.surf.draw();
  }

  renderToolbar() {
    const store = this.store, clip = this.clip;
    this.toolbar.textContent = "";
    const tool = segmented([{ value: "draw", label: "✎ Draw" }, { value: "select", label: "⬚ Select" }], store.ui.tool, (v) => { store.ui.tool = v; }, "pr-tool");
    const grid = select(GRIDS.map(([v, l]) => ({ value: v, label: l })), this.grid, (v) => { store.ui.grid = +v; this.surf.draw(); }, "pr-grid");
    const len = h("span", { class: "pr-len" }, fmtLen(clip.length));
    const setLen = (L) => { this.store.update(() => { this.clip.length = Math.max(0.25, L); }, "notes"); len.textContent = fmtLen(this.clip.length); this.surf.draw(); };
    const btn = (label, fn, title, cls = "") => h("button", { type: "button", class: "btn small " + cls, title, onclick: fn }, label);
    const meta = this.t && this.t.type === "midi" ? metaSync(this.t.instrument.kind) : null;
    const choices = [{ key: "vel", name: "Velocity" }, ...laneChoices(this.t, meta)];
    const lane = select(choices.map((c) => ({ value: c.key, label: c.name + (clip.env && clip.env[c.key] && clip.env[c.key].length ? " •" : "") })), this.laneKey, (v) => { this.laneKey = v; this.surf.draw(); }, "pr-lane");
    this.toolbar.append(tool, grid,
      h("span", { class: "pr-group" }, h("span", { class: "dim" }, "Length"), btn("−", () => setLen(this.clip.length - (this.clip.length > 4 ? 4 : 1)), "Shorter"), len, btn("+", () => setLen(this.clip.length + (this.clip.length >= 4 ? 4 : 1)), "Longer")),
      btn("×2", () => this.duplicateLoop(), "Double the clip, its notes repeated"),
      btn("Quantize", () => this.quantize(), "Snap the selected notes (or all) to the grid"),
      btn("−12", () => this.transpose(-12), "Octave down"), btn("−1", () => this.transpose(-1)), btn("+1", () => this.transpose(1)), btn("+12", () => this.transpose(12), "Octave up"),
      btn("⌫", () => this.deleteSel(), "Delete the selected notes"),
      btn("Fit", () => this.fit(), "Show the whole clip"),
      h("span", { class: "pr-group" }, h("span", { class: "dim" }, "Lane"), lane,
        btn("Clear", () => { if (this.laneKey === "vel") return; this.store.update(() => { delete this.clip.env[this.laneKey]; }, "notes"); this.surf.draw(); }, "Remove this envelope")),
    );
  }

  update(c = {}) {
    if (!this.clip) return;
    if (c.reason === "undo" || c.reason === "project") { this.sel.clear(); this.renderToolbar(); }
    this.surf.draw();
  }

  // ---- edits ----
  audition(p, v = 100) {
    const inst = this.app.engine.instrument(this.trackId);
    if (!inst || this.app.transport.playing) return;
    inst.noteOn(p, v, 0);
    const ctx = this.app.ctx;
    inst.noteOff(p, ctx.currentTime + 0.22);
    inst.flushEvents();
  }
  noteAt(x, y) {
    const clip = this.clip;
    const b = this.xb(x), p = this.yp(y);
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      if (n.p === p && b >= n.t && b < n.t + Math.max(n.d, 6 / this.ppb)) return n;
    }
    return null;
  }
  deleteSel() {
    if (!this.sel.size) return;
    this.store.update(() => { this.clip.notes = this.clip.notes.filter((n) => !this.sel.has(n)); }, "notes");
    this.sel.clear();
    this.surf.draw();
  }
  transpose(d) {
    const targets = this.sel.size ? [...this.sel] : this.clip.notes;
    this.store.update(() => { for (const n of targets) n.p = clamp(n.p + d, 0, 127); }, "notes");
    this.surf.draw();
  }
  quantize() {
    const targets = this.sel.size ? [...this.sel] : this.clip.notes;
    this.store.update(() => { for (const n of targets) n.t = Math.max(0, this.snapT(n.t)); }, "notes");
    this.surf.draw();
  }
  duplicateLoop() {
    this.store.update(() => {
      const c = this.clip, L = c.length;
      const copies = c.notes.filter((n) => n.t < L).map((n) => ({ ...n, t: n.t + L }));
      c.notes.push(...copies);
      for (const k in c.env) c.env[k] = [...c.env[k], ...c.env[k].map((pt) => ({ t: pt.t + L, v: pt.v }))];
      c.length = L * 2;
    }, "notes");
    this.renderToolbar();
    this.fit();
  }
  onKey(e) {
    if (e.key === "Delete" || e.key === "Backspace") { if (this.sel.size) { this.deleteSel(); return true; } return false; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); this.clip.notes.forEach((n) => this.sel.add(n)); this.surf.draw(); return true; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && this.sel.size) {
      e.preventDefault();
      const sel = [...this.sel];
      const span = Math.max(...sel.map((n) => n.t + n.d)) - Math.min(...sel.map((n) => n.t));
      const step = Math.ceil(span / this.grid - 1e-6) * this.grid;
      this.store.update(() => { const copies = sel.map((n) => ({ ...n, t: n.t + step })); this.clip.notes.push(...copies); this.sel = new Set(copies); }, "notes");
      this.surf.draw();
      return true;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { if (!this.sel.size) return false; e.preventDefault(); this.transpose((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1)); return true; }
    return false;
  }

  // ---- gestures ----
  region(pos) {
    if (pos.y >= this.surf.h - this.laneH) return "lane";
    if (pos.y < RULER_H) return "ruler";
    if (pos.x < KEYS_W) return "keys";
    if (pos.y > this.gridBottom) return "gap";
    return "grid";
  }

  setupGestures() {
    let drag = null;
    const store = this.store;
    gestures(this.canvas, {
      press: (pos) => {
        if (this.region(pos) === "keys") { const p = this.yp(pos.y); this.audition(p, 100); }
      },
      tap: (pos) => {
        const r = this.region(pos);
        if (r === "lane") { this.laneTap(pos); return; }
        if (r !== "grid") return;
        const n = this.noteAt(pos.x, pos.y);
        if (store.ui.tool === "draw") {
          if (n) { store.update(() => { this.clip.notes = this.clip.notes.filter((x) => x !== n); }, "notes"); this.sel.delete(n); }
          else this.addNote(pos);
        } else {
          if (n) { if (!pos.shift && !pos.meta) this.sel.clear(); if (this.sel.has(n) && (pos.shift || pos.meta)) this.sel.delete(n); else this.sel.add(n); this.audition(n.p, n.v); }
          else this.sel.clear();
        }
        this.surf.draw();
      },
      doubleTap: (pos) => {
        const r = this.region(pos);
        if (r === "lane") { this.laneDouble(pos); return; }
        if (r === "ruler") { this.fit(); return; }
        if (r !== "grid" || store.ui.tool === "draw") return;
        const n = this.noteAt(pos.x, pos.y);
        if (n) { store.update(() => { this.clip.notes = this.clip.notes.filter((x) => x !== n); }, "notes"); this.sel.delete(n); }
        else this.addNote(pos);
        this.surf.draw();
      },
      longPress: (pos, e) => {
        const r = this.region(pos);
        if (r !== "grid") return;
        const n = this.noteAt(pos.x, pos.y);
        if (n && !this.sel.has(n)) { this.sel.clear(); this.sel.add(n); }
        this.surf.draw();
        menu({ x: e.clientX, y: e.clientY }, [
          { label: "Select all", onClick: () => { this.clip.notes.forEach((x) => this.sel.add(x)); this.surf.draw(); } },
          { label: "Duplicate selection", disabled: !this.sel.size, onClick: () => this.onKey({ key: "d", metaKey: true, preventDefault() {} }) },
          { label: "Velocity: soft (64)", disabled: !this.sel.size, onClick: () => this.setVel(64) },
          { label: "Velocity: medium (100)", disabled: !this.sel.size, onClick: () => this.setVel(100) },
          { label: "Velocity: hard (127)", disabled: !this.sel.size, onClick: () => this.setVel(127) },
          { label: "Quantize", onClick: () => this.quantize() },
          "-",
          { label: "Delete", danger: true, disabled: !this.sel.size, onClick: () => this.deleteSel() },
        ], { title: n ? noteName(n.p) : "Notes" });
      },
      dragStart: (pos) => {
        const r = this.region(pos);
        drag = null;
        if (r === "ruler") {
          const lx = this.bx(this.clip.length);
          if (Math.abs(pos.x - lx) < 20) { store.begin(); drag = { kind: "length" }; return true; }
          drag = { kind: "pan", x0: this.x0, top: this.top };
          return true;
        }
        if (r === "keys") { drag = { kind: "pan", x0: this.x0, top: this.top, keys: true }; return true; }
        if (r === "lane") {
          store.begin();
          if (this.laneKey === "vel") { drag = { kind: "vel" }; this.velAt(pos); return true; }
          const i = this.envPointAt(pos);
          drag = i !== null ? { kind: "env", i } : { kind: "envdraw" };
          if (i === null) this.laneTap(pos, true);
          return true;
        }
        if (r !== "grid") return false;
        const n = this.noteAt(pos.x, pos.y);
        const draw = store.ui.tool === "draw";
        if (n) {
          if (!this.sel.has(n)) { this.sel.clear(); this.sel.add(n); }
          const x1 = this.bx(n.t + n.d);
          const resize = x1 - pos.x < Math.max(8, Math.min(16, n.d * this.ppb * 0.33));
          store.begin();
          drag = { kind: resize ? "resize" : "move", b0: this.xb(pos.x), p0: this.yp(pos.y), orig: [...this.sel].map((x) => ({ n: x, t: x.t, p: x.p, d: x.d })), lastP: n.p };
          return true;
        }
        if (draw) {
          store.begin();
          const nn = this.addNote(pos, true);
          drag = { kind: "draw", n: nn };
          return true;
        }
        drag = { kind: "box", a: pos, b: pos };
        return true;
      },
      dragMove: (pos, d) => {
        if (!drag) return;
        const clip = this.clip;
        if (drag.kind === "pan") {
          this.x0 = Math.max(0, drag.x0 - d.x / this.ppb);
          this.top = clamp(Math.round(drag.top + d.y / this.rowH), 10, 127);
          if (drag.keys) this.x0 = drag.x0;
          this.surf.draw();
          return;
        }
        if (drag.kind === "length") { store.live(() => { clip.length = Math.max(this.grid, this.snapT(this.xb(pos.x))); }, "notes"); this.surf.draw(); return; }
        if (drag.kind === "vel") { this.velAt(pos); return; }
        if (drag.kind === "env") { this.envDrag(drag.i, pos); return; }
        if (drag.kind === "envdraw") { this.laneTap(pos, true); return; }
        if (drag.kind === "box") { drag.b = pos; this.box = drag; this.surf.draw(); return; }
        if (drag.kind === "draw") {
          store.live(() => { drag.n.d = Math.max(this.grid, this.snapT(this.xb(pos.x)) - drag.n.t); this.newLen = drag.n.d; }, "notes");
          this.surf.draw();
          return;
        }
        const db = this.xb(pos.x) - drag.b0;
        if (drag.kind === "move") {
          const dp = this.yp(pos.y) - drag.p0;
          const first = drag.orig.reduce((m, o) => Math.min(m, o.t), Infinity);
          let dt = this.snapT(first + db) - first;
          if (first + dt < 0) dt = -first;
          store.live(() => { for (const o of drag.orig) { o.n.t = Math.max(0, o.t + dt); o.n.p = clamp(o.p + dp, 0, 127); } }, "notes");
          const lead = drag.orig[0].n;
          if (lead.p !== drag.lastP) { drag.lastP = lead.p; this.audition(lead.p, lead.v); }
        } else {
          store.live(() => { for (const o of drag.orig) { o.n.d = Math.max(this.grid / 2, this.snapT(o.t + o.d + db) - o.t); this.newLen = o.n.d; } }, "notes");
        }
        this.surf.draw();
      },
      dragEnd: () => {
        if (!drag) return;
        if (drag.kind === "box") {
          const a = drag.a, b = drag.b;
          const t0 = this.xb(Math.min(a.x, b.x)), t1 = this.xb(Math.max(a.x, b.x));
          const p0 = this.yp(Math.max(a.y, b.y)), p1 = this.yp(Math.min(a.y, b.y));
          if (!a.shift) this.sel.clear();
          for (const n of this.clip.notes) if (n.t + n.d > t0 && n.t < t1 && n.p >= p0 && n.p <= p1) this.sel.add(n);
          this.box = null;
        } else if (drag.kind !== "pan") store.commit("notes");
        drag = null;
        this.surf.draw();
      },
      pinch: (g) => {
        const b = this.xb(g.cx);
        if (g.sx > 0 && isFinite(g.sx)) this.ppb = clamp(this.ppb * (g.scale > 0 ? Math.pow(g.scale, Math.abs(g.sx - 1) >= Math.abs(g.sy - 1) ? 1 : 0.3) : 1), 6, 600);
        if (!this.drums && Math.abs(g.sy - 1) > Math.abs(g.sx - 1)) this.rowH = clamp(this.rowH * Math.pow(g.scale, 1), 7, 40);
        this.x0 = Math.max(0, b - (g.cx - KEYS_W) / this.ppb - g.dx / this.ppb);
        this.top = clamp(Math.round(this.top + g.dy / this.rowH), 10, 127);
        this.surf.draw();
      },
      wheel: (e, pos) => {
        if (e.ctrlKey || e.metaKey) {
          const b = this.xb(pos.x);
          this.ppb = clamp(this.ppb * Math.exp(-e.deltaY * 0.01), 6, 600);
          this.x0 = Math.max(0, b - (pos.x - KEYS_W) / this.ppb);
        } else {
          this.x0 = Math.max(0, this.x0 + (e.shiftKey ? e.deltaY : e.deltaX) / this.ppb);
          if (!e.shiftKey) this.top = clamp(this.top - Math.round(e.deltaY / this.rowH), 10, 127);
        }
        this.surf.draw();
      },
    });
  }

  addNote(pos, live = false) {
    const clip = this.clip;
    const t = Math.max(0, this.floorT(this.xb(pos.x)));
    const p = clamp(this.yp(pos.y), 0, 127);
    if (t >= clip.length) return null;
    const n = { p, t, d: this.drums ? this.grid : this.newLen || this.grid, v: this.newVel };
    (live ? this.store.live : this.store.update).call(this.store, () => { clip.notes.push(n); }, "notes");
    this.sel.clear();
    this.sel.add(n);
    this.audition(p, n.v);
    return n;
  }
  setVel(v) { this.store.update(() => { for (const n of this.sel) n.v = v; }, "notes"); this.newVel = v; this.surf.draw(); }

  // ---- the lane ----
  laneTop() { return this.surf.h - this.laneH + 6; }
  laneBottom() { return this.surf.h - 6; }
  laneV(y) { return clamp(1 - (y - this.laneTop()) / (this.laneBottom() - this.laneTop()), 0, 1); }
  laneY(v) { return this.laneTop() + (1 - v) * (this.laneBottom() - this.laneTop()); }
  velAt(pos) {
    const b = this.xb(pos.x), tol = 8 / this.ppb;
    const v = Math.max(1, Math.round(this.laneV(pos.y) * 127));
    const pool = this.sel.size ? [...this.sel] : this.clip.notes;
    let hit = false;
    this.store.live(() => { for (const n of pool) if (Math.abs(n.t - b) <= tol) { n.v = v; hit = true; } }, "notes");
    if (hit) { this.newVel = v; this.surf.draw(); }
  }
  envPts(create) {
    const c = this.clip;
    if (!c.env) c.env = {};
    if (!c.env[this.laneKey] && create) c.env[this.laneKey] = [];
    return c.env[this.laneKey] || [];
  }
  envPointAt(pos) {
    const pts = this.envPts(false);
    let best = null, bd = 20;
    pts.forEach((pt, i) => { const d = Math.hypot(this.bx(pt.t) - pos.x, this.laneY(pt.v) - pos.y); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  laneTap(pos, live = false) {
    if (this.laneKey === "vel") { if (!live) { this.store.begin(); this.velAt(pos); this.store.commit("notes"); } return; }
    const g = this.grid / 2;
    const t = clamp(Math.round(this.xb(pos.x) / g) * g, 0, this.clip.length);
    const v = this.laneV(pos.y);
    (live ? this.store.live : this.store.update).call(this.store, () => {
      const pts = this.envPts(true);
      const same = pts.findIndex((pt) => Math.abs(pt.t - t) < 1e-6);
      if (same >= 0) pts[same].v = v; else pts.push({ t, v });
      pts.sort((a, b) => a.t - b.t);
    }, "notes");
    if (!live) this.renderToolbar();
    this.surf.draw();
  }
  laneDouble(pos) {
    if (this.laneKey === "vel") return;
    const i = this.envPointAt(pos);
    if (i === null) return;
    this.store.update(() => { this.envPts(false).splice(i, 1); }, "notes");
    this.surf.draw();
  }
  envDrag(i, pos) {
    const g = this.grid / 2;
    this.store.live(() => {
      const pts = this.envPts(false), pt = pts[i];
      if (!pt) return;
      const lo = i > 0 ? pts[i - 1].t : 0, hi = i < pts.length - 1 ? pts[i + 1].t : this.clip.length;
      pt.t = clamp(Math.round(this.xb(pos.x) / g) * g, lo, hi);
      pt.v = this.laneV(pos.y);
    }, "notes");
    this.surf.draw();
  }

  // ---- drawing ----
  playheadLocal() {
    const tr = this.app.transport;
    if (!tr.playing) return null;
    const clip = this.clip, b = tr.now();
    const s = tr.session.get(this.trackId);
    if (s && s.playing && s.playing.clipId === clip.id) return (((b.g - s.playing.gStart) % clip.length) + clip.length) % clip.length;
    if (s && !s.follow) return null;
    const t = this.t;
    for (const pl of t.arrangement) if (pl.clipId === clip.id && b.s >= pl.start && b.s < pl.start + pl.length) return (((b.s - pl.start + (pl.offset || 0)) % clip.length) + clip.length) % clip.length;
    return null;
  }

  draw(c, w, hh) {
    const clip = this.clip, t = this.t;
    if (!clip || !t) return;
    const col = clip.color || t.color;
    const gt = this.gridTop, gb = this.gridBottom;
    c.fillStyle = "#1d1e22";
    c.fillRect(0, 0, w, hh);
    // rows
    c.save();
    c.beginPath(); c.rect(0, gt, w, gb - gt); c.clip();
    const pads = this.drums ? t.instrument.state.pads : null;
    for (let p = this.top; this.py(p) < gb; p--) {
      if (p < 0) break;
      const y = this.py(p);
      if (this.drums && (p < DRUM_BASE_NOTE || p > DRUM_BASE_NOTE + 15)) { c.fillStyle = "#18191c"; c.fillRect(KEYS_W, y, w, this.rowH); continue; }
      c.fillStyle = !this.drums && isBlack(p) ? "#222328" : "#2a2b31";
      c.fillRect(KEYS_W, y, w - KEYS_W, this.rowH);
      c.fillStyle = p % 12 === 0 && !this.drums ? "#3c3e45" : "#1c1d21";
      c.fillRect(KEYS_W, y + this.rowH - 1, w - KEYS_W, 1);
    }
    // grid lines
    const g = this.grid;
    const lineEvery = g * this.ppb < 6 ? Math.ceil(6 / (g * this.ppb)) : 1;
    const first = Math.floor(this.x0 / g);
    for (let i = first; ; i++) {
      const b = i * g;
      const x = this.bx(b);
      if (x > w) break;
      if (x < KEYS_W) continue;
      const bar = Math.abs(b / 4 - Math.round(b / 4)) < 1e-6, beat = Math.abs(b - Math.round(b)) < 1e-6;
      if (!bar && !beat && i % lineEvery) continue;
      c.fillStyle = bar ? "rgba(255,255,255,0.16)" : beat ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.035)";
      c.fillRect(Math.round(x), gt, 1, gb - gt);
    }
    // beyond the clip
    const ex = this.bx(clip.length);
    if (ex < w) { c.fillStyle = "rgba(0,0,0,0.38)"; c.fillRect(Math.max(KEYS_W, ex), gt, w - ex, gb - gt); }
    // notes
    for (const n of clip.notes) {
      const x = this.bx(n.t), y = this.py(n.p);
      const nw = Math.max(3, n.d * this.ppb - 1);
      if (x > w || x + nw < KEYS_W || y > gb || y + this.rowH < gt) continue;
      const sel = this.sel.has(n);
      c.fillStyle = shade(col, -0.35 + (n.v / 127) * 0.6);
      roundRect(c, x + 0.5, y + 1, nw, this.rowH - 2, 3);
      c.fill();
      if (sel) { c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.stroke(); c.lineWidth = 1; }
      if (nw > 26 && this.rowH >= 12) {
        c.fillStyle = "rgba(0,0,0,0.6)";
        c.font = "10px -apple-system, system-ui, sans-serif";
        c.fillText(this.drums ? "" : noteName(n.p), x + 4, y + this.rowH / 2 + 3.5);
      }
    }
    // the selection box
    if (this.box) {
      const a = this.box.a, b = this.box.b;
      c.fillStyle = "rgba(255,255,255,0.08)"; c.strokeStyle = "rgba(255,255,255,0.6)";
      c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      c.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    }
    c.restore();
    // keys
    c.save();
    c.beginPath(); c.rect(0, gt, KEYS_W, gb - gt); c.clip();
    for (let p = this.top; this.py(p) < gb && p >= 0; p--) {
      const y = this.py(p);
      if (pads) {
        const i = p - DRUM_BASE_NOTE;
        c.fillStyle = i >= 0 && i < 16 ? "#33353b" : "#18191c";
        c.fillRect(0, y, KEYS_W - 1, this.rowH - 1);
        if (i >= 0 && i < 16) { c.fillStyle = "#c9ccd3"; c.font = "10px -apple-system, system-ui, sans-serif"; c.fillText(pads[i].name.slice(0, 7), 4, y + this.rowH / 2 + 3.5); }
        continue;
      }
      c.fillStyle = isBlack(p) ? "#2b2c31" : "#d9dbe0";
      c.fillRect(0, y, KEYS_W - 1, this.rowH - 1);
      if (p % 12 === 0 && this.rowH >= 9) { c.fillStyle = "#3a3c42"; c.font = "9px -apple-system, system-ui, sans-serif"; c.fillText(noteName(p), 4, y + this.rowH - 3); }
    }
    c.restore();
    // ruler
    c.fillStyle = "#18191c";
    c.fillRect(0, 0, w, RULER_H);
    c.font = "10px -apple-system, system-ui, sans-serif";
    for (let b = Math.floor(this.x0); ; b++) {
      const x = this.bx(b);
      if (x > w) break;
      if (x < KEYS_W) continue;
      const bar = b % 4 === 0;
      if (!bar && this.ppb < 18) continue;
      c.fillStyle = bar ? "#9fa3ab" : "#5c5f66";
      c.fillRect(Math.round(x), bar ? 6 : 13, 1, RULER_H - (bar ? 6 : 13));
      if (bar || this.ppb > 40) c.fillText(bar ? String(b / 4 + 1) : `${b / 4 + 1 | 0}.${(b % 4) + 1}`, x + 3, 13);
    }
    // the clip's end handle
    c.fillStyle = col;
    c.fillRect(ex - 2, 0, 4, RULER_H);
    c.beginPath(); c.moveTo(ex - 8, 0); c.lineTo(ex + 8, 0); c.lineTo(ex, 9); c.fill();
    // the playhead
    const ph = this.playheadLocal();
    if (ph !== null) { c.fillStyle = "#ffd84a"; c.fillRect(Math.round(this.bx(ph)), 0, 1.5, gb); }
    // the lane
    const lt = this.surf.h - this.laneH;
    c.fillStyle = "#18191c";
    c.fillRect(0, lt - GAP, w, this.laneH + GAP);
    c.fillStyle = "#222328";
    c.fillRect(KEYS_W, lt, w - KEYS_W, this.laneH);
    c.fillStyle = "#8b8f98";
    c.font = "10px -apple-system, system-ui, sans-serif";
    const laneName = this.laneKey === "vel" ? "Vel" : "Env";
    c.fillText(laneName, 6, lt + 14);
    c.save();
    c.beginPath(); c.rect(KEYS_W, lt, w - KEYS_W, this.laneH); c.clip();
    if (this.laneKey === "vel") {
      for (const n of clip.notes) {
        const x = this.bx(n.t);
        if (x < KEYS_W - 4 || x > w) continue;
        const y = this.laneY(n.v / 127);
        c.fillStyle = this.sel.has(n) ? "#fff" : col;
        c.fillRect(x, y, 2, this.laneBottom() - y);
        c.fillRect(x - 2, y - 1, 6, 3);
      }
    } else {
      const pts = this.envPts(false);
      if (!pts.length) { c.fillStyle = "#5f626a"; c.fillText("Tap or drag to draw this envelope; it plays with the clip", KEYS_W + 8, lt + this.laneH / 2 + 4); }
      else {
        c.strokeStyle = col; c.lineWidth = 2;
        c.beginPath();
        c.moveTo(KEYS_W, this.laneY(envAt(pts, this.xb(KEYS_W))));
        for (const pt of pts) c.lineTo(this.bx(pt.t), this.laneY(pt.v));
        c.lineTo(w, this.laneY(envAt(pts, this.xb(w))));
        c.stroke();
        c.fillStyle = col;
        for (const pt of pts) { c.beginPath(); c.arc(this.bx(pt.t), this.laneY(pt.v), 4.5, 0, Math.PI * 2); c.fill(); }
        c.lineWidth = 1;
      }
    }
    if (ex < w) { c.fillStyle = "rgba(0,0,0,0.38)"; c.fillRect(ex, lt, w - ex, this.laneH); }
    c.restore();
  }

  frame() { if (this.app.transport.playing) this.surf.draw(); }
  dispose() { this.surf.dispose(); }
}

function fmtLen(beats) {
  if (beats % 4 === 0) return beats / 4 + (beats === 4 ? " bar" : " bars");
  return beats + " beats";
}
