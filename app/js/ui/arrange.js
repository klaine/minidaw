// The arrangement: track headers on the left, the timeline on a canvas (clips, automation lanes, the loop, the
// playhead), the ruler above it. Touch: tap selects, double tap creates or opens, drag moves or resizes (a clip's right
// edge resizes, its left edge trims), long press opens the menu, one finger on empty space pans, pinch zooms.
import { h, clamp, uid, envAt, faderDb } from "../util.js";
import { gestures, Surface } from "./gestures.js";
import { menu, prompt, toast, drawMeter } from "./controls.js";
import { newMidiClip, newAudioClip, laneChoices, kindName, INSTRUMENT_KINDS, guessBpm } from "../model.js";
import { metaSync, loadMeta } from "../audio/instruments.js";
import { placeClip } from "../recording.js";
import { pickSample } from "./browser.js";
import { TRACK_COLORS } from "../util.js";
import { importMidiToTrack, importMidiAsTracks, exportClipMidi } from "./import.js";

const TRACK_H = 64, LANE_H = 46, HEAD_W = 196;

export class ArrangeView {
  constructor(app) {
    this.app = app;
    this.ppb = 22;   // pixels per beat
    this.x0 = 0;     // beat at the left edge
    this.follow = true;
    this.selPl = null;
    this.ruler = h("canvas", { class: "arr-ruler" });
    this.lanes = h("canvas", { class: "arr-canvas" });
    this.headers = h("div", { class: "arr-headers" });
    this.spacer = h("div", { class: "arr-spacer" });
    this.scroll = h("div", { class: "arr-scroll" }, h("div", { class: "arr-rows" }, this.headers, h("div", { class: "arr-lanes" }, this.lanes, this.spacer)));
    const zoomOut = h("button", { type: "button", class: "icon-btn", title: "Zoom out", onclick: () => this.zoom(0.7, 0) }, "−");
    const zoomIn = h("button", { type: "button", class: "icon-btn", title: "Zoom in", onclick: () => this.zoom(1.4, 0) }, "+");
    this.followBtn = h("button", { type: "button", class: "tog small on", title: "Follow the playhead", onclick: () => { this.follow = !this.follow; this.followBtn.classList.toggle("on", this.follow); } }, "Follow");
    const corner = h("div", { class: "arr-corner" }, zoomOut, zoomIn, this.followBtn);
    this.el = h("section", { class: "view arrange" }, h("div", { class: "arr-top" }, corner, this.ruler), this.scroll);
    this.rulerSurf = new Surface(this.ruler, (c, w, hh) => this.drawRuler(c, w, hh));
    this.surf = new Surface(this.lanes, (c, w, hh) => this.drawLanes(c, w, hh));
    this.scroll.addEventListener("scroll", () => { this.surf.draw(); });
    new ResizeObserver(() => this.layout()).observe(this.scroll);
    this.setupRuler();
    this.setupLanes();
  }

  get p() { return this.app.store.project; }
  bx(b) { return (b - this.x0) * this.ppb; }       // beat -> x
  xb(x) { return this.x0 + x / this.ppb; }         // x -> beat
  get snap() { const p = this.ppb; return p >= 90 ? 0.25 : p >= 45 ? 0.5 : p >= 18 ? 1 : 4; }
  snapB(b, s = this.snap) { return Math.round(b / s) * s; }

  rows() {
    const out = [];
    let y = 0;
    for (const t of this.p.tracks) {
      out.push({ track: t, y, h: TRACK_H, lane: null });
      y += TRACK_H;
      for (const key of t.lanes) { out.push({ track: t, y, h: LANE_H, lane: key }); y += LANE_H; }
    }
    this.contentH = y;
    return out;
  }

  layout() {
    const vh = this.scroll.clientHeight;
    this.rows();
    this.lanes.style.height = vh + "px";
    this.spacer.style.height = Math.max(0, this.contentH + 80 - vh) + "px";
    this.surf.resize();
    this.rulerSurf.resize();
  }

  update(c = {}) {
    if (this.el.hidden) return;
    if (c.live && c.reason !== "tracks") { this.surf.draw(); this.rulerSurf.draw(); this.updateHeaderValues(); return; }
    this.renderHeaders();
    this.layout();
  }

  // ---- headers ----
  renderHeaders() {
    const app = this.app, store = app.store;
    this.headers.textContent = "";
    this.meters = new Map();
    for (const t of this.p.tracks) {
      const sel = store.ui.selTrack === t.id;
      const meter = h("canvas", { class: "th-meter", width: 5, height: 40 });
      this.meters.set(t.id, meter);
      const kind = t.type === "audio" ? "AUDIO" : (INSTRUMENT_KINDS.find((k) => k.kind === t.instrument.kind) || {}).short;
      const name = h("div", { class: "th-name" }, t.name);
      const btn = (label, on, cls, fn, title) => h("button", { type: "button", class: "th-btn " + cls + (on ? " on" : ""), title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
      const row = h("div", { class: "th" + (sel ? " sel" : ""), dataset: { track: t.id }, style: { height: TRACK_H + "px", "--tc": t.color } },
        h("div", { class: "th-color" }),
        h("div", { class: "th-main" },
          h("div", { class: "th-top" }, name, h("span", { class: "th-kind" }, kind)),
          h("div", { class: "th-btns" },
            btn("M", t.mixer.mute, "mute", () => store.update((p) => { tr(p, t).mixer.mute = !tr(p, t).mixer.mute; }, "mixer"), "Mute"),
            btn("S", t.mixer.solo, "solo", () => store.update((p) => { tr(p, t).mixer.solo = !tr(p, t).mixer.solo; }, "mixer"), "Solo"),
            btn("●", t.mixer.arm, "arm", () => store.update((p) => { tr(p, t).mixer.arm = !tr(p, t).mixer.arm; }, "mixer"), "Arm for recording"),
            btn("A", t.lanes.length > 0, "auto", () => this.addLane(t), "Show an automation lane"))),
        meter);
      gestures(row, {
        tap: () => store.select({ selTrack: t.id, panel: store.ui.panel === "clip" && store.ui.selClip ? "clip" : "device" }) || this.renderHeaders() || this.surf.draw(),
        doubleTap: async () => { const n = await prompt("Track name", t.name); if (n) store.update((p) => { tr(p, t).name = n; }, "tracks"); },
        longPress: (pos, e) => this.trackMenu(t, { x: e.clientX, y: e.clientY }),
      });
      this.headers.append(row);
      for (const key of t.lanes) {
        const choices = laneChoices(t, t.type === "midi" ? metaSync(t.instrument.kind) : null);
        const sel2 = h("select", { class: "sel lh-sel", onchange: () => store.update((p) => { const x = tr(p, t); x.lanes[x.lanes.indexOf(key)] = sel2.value; }, "tracks") },
          choices.map((ch) => h("option", { value: ch.key, selected: ch.key === key }, ch.name + (t.automation[ch.key] && t.automation[ch.key].length ? " •" : ""))));
        const lane = h("div", { class: "lh", style: { height: LANE_H + "px", "--tc": t.color } },
          sel2,
          h("button", { type: "button", class: "icon-btn small", title: "Clear this lane's points", onclick: () => store.update((p) => { delete tr(p, t).automation[key]; }, "automation") }, "⌫"),
          h("button", { type: "button", class: "icon-btn small", title: "Hide the lane", onclick: () => store.update((p) => { const x = tr(p, t); x.lanes = x.lanes.filter((k) => k !== key); }, "tracks") }, "✕"));
        this.headers.append(lane);
      }
    }
    const add = h("button", { type: "button", class: "arr-add", onclick: (e) => this.app.topbar.addMenu(e.currentTarget) }, "+ Add track");
    const imp = h("button", { type: "button", class: "arr-add", onclick: () => importMidiAsTracks(this.app) }, "Import a MIDI file…");
    this.headers.append(add, imp);
  }

  updateHeaderValues() { /* names and toggles change through renderHeaders */ }

  addLane(t) {
    const app = this.app;
    const meta = t.type === "midi" ? metaSync(t.instrument.kind) : null;
    const choices = laneChoices(t, meta);
    const used = new Set(t.lanes);
    const items = choices.filter((c) => !used.has(c.key)).slice(0, 400).map((c) => ({
      label: c.name + (t.automation[c.key] && t.automation[c.key].length ? " •" : ""),
      onClick: () => app.store.update((p) => { tr(p, t).lanes.push(c.key); }, "tracks"),
    }));
    if (t.lanes.length) items.unshift({ label: "Hide all lanes", onClick: () => app.store.update((p) => { tr(p, t).lanes = []; }, "tracks") }, "-");
    menu(this.headers.querySelector(".th.sel") || this.headers, items, { title: "Automation lane", width: 260 });
  }

  trackMenu(t, at) {
    const app = this.app, store = app.store;
    const items = [
      { label: "Rename…", onClick: async () => { const n = await prompt("Track name", t.name); if (n) store.update((p) => { tr(p, t).name = n; }, "tracks"); } },
      { label: "Color", onClick: () => menu(at, TRACK_COLORS.map((c) => ({ label: c, color: c, checked: c === t.color, onClick: () => store.update((p) => { tr(p, t).color = c; }, "tracks") }))) },
      { label: "Duplicate track", onClick: () => app.duplicateTrack(t.id) },
      { label: "Move up", disabled: this.p.tracks.indexOf(t) === 0, onClick: () => store.update((p) => { const i = p.tracks.findIndex((x) => x.id === t.id); p.tracks.splice(i - 1, 0, p.tracks.splice(i, 1)[0]); }, "tracks") },
      { label: "Move down", disabled: this.p.tracks.indexOf(t) === this.p.tracks.length - 1, onClick: () => store.update((p) => { const i = p.tracks.findIndex((x) => x.id === t.id); p.tracks.splice(i + 1, 0, p.tracks.splice(i, 1)[0]); }, "tracks") },
    ];
    if (t.type === "midi") {
      items.push("-");
      for (const k of INSTRUMENT_KINDS) items.push({ label: "Instrument: " + k.name, checked: t.instrument.kind === k.kind, onClick: () => app.changeInstrument(t.id, k.kind) });
    }
    items.push("-", { label: "Delete track", danger: true, onClick: () => app.deleteTrack(t.id) });
    menu(at, items, { title: t.name });
  }

  // ---- hit testing ----
  rowAt(y) {
    const yy = y + this.scroll.scrollTop;
    for (const r of this.rows()) if (yy >= r.y && yy < r.y + r.h) return r;
    return null;
  }
  placementAt(r, x) {
    if (!r || r.lane) return null;
    const b = this.xb(x);
    for (let i = r.track.arrangement.length - 1; i >= 0; i--) {
      const pl = r.track.arrangement[i];
      if (b >= pl.start && b < pl.start + pl.length) return pl;
    }
    return null;
  }

  // ---- the lanes canvas ----
  setupLanes() {
    const app = this.app, store = app.store;
    let drag = null;
    gestures(this.lanes, {
      tap: (pos) => {
        const r = this.rowAt(pos.y);
        if (!r) { store.select({ selClip: null }); this.selPl = null; this.surf.draw(); return; }
        if (r.lane) { this.laneTap(r, pos); return; }
        const pl = this.placementAt(r, pos.x);
        this.selPl = pl ? pl.id : null;
        store.select({ selTrack: r.track.id, selClip: pl ? pl.clipId : null, panel: pl ? store.ui.panel === "keys" ? "keys" : "clip" : "device" });
        this.renderHeaders();
        this.surf.draw();
      },
      doubleTap: (pos) => {
        const r = this.rowAt(pos.y);
        if (!r) return;
        if (r.lane) { this.laneDouble(r, pos); return; }
        const pl = this.placementAt(r, pos.x);
        if (pl) { store.select({ selTrack: r.track.id, selClip: pl.clipId, panel: "clip" }); return; }
        const start = Math.floor(this.xb(pos.x) / 4) * 4;
        if (r.track.type === "midi") this.newClipAt(r.track, start);
        else this.importAt(r.track, start);
      },
      longPress: (pos, e) => {
        const r = this.rowAt(pos.y);
        if (!r) return;
        const at = { x: e.clientX, y: e.clientY };
        if (r.lane) { this.laneDouble(r, pos); return; }
        const pl = this.placementAt(r, pos.x);
        if (pl) this.clipMenu(r.track, pl, at, this.xb(pos.x));
        else {
          const start = Math.floor(this.xb(pos.x) / 4) * 4;
          menu(at, [
            r.track.type === "midi" ? { label: "New MIDI clip here", onClick: () => this.newClipAt(r.track, start) } : { label: "Import a sample here…", onClick: () => this.importAt(r.track, start) },
            r.track.type === "midi" ? { label: "Import a MIDI file here…", onClick: () => importMidiToTrack(app, r.track.id, { start }) } : null,
            this.clipboard ? { label: "Paste clip here", onClick: () => this.paste(r.track, start) } : null,
            { label: "Set the loop to this bar", onClick: () => store.update((p) => { p.loop = { on: true, start, end: start + 4 }; }, "loop") },
          ], { title: r.track.name });
        }
      },
      dragStart: (pos) => {
        const r = this.rowAt(pos.y);
        drag = null;
        if (r && r.lane) {
          const pt = this.pointAt(r, pos);
          if (pt) { store.begin(); drag = { kind: "point", r, pt }; return true; }
        }
        const pl = r && this.placementAt(r, pos.x);
        if (pl) {
          const x0 = this.bx(pl.start), x1 = this.bx(pl.start + pl.length);
          const mode = x1 - pos.x < Math.min(22, (x1 - x0) / 3) ? "end" : pos.x - x0 < Math.min(14, (x1 - x0) / 4) ? "start" : "move";
          store.begin();
          this.selPl = pl.id;
          store.select({ selTrack: r.track.id, selClip: pl.clipId });
          drag = { kind: mode, track: r.track.id, pl: { ...pl }, id: pl.id, b0: this.xb(pos.x) };
          return true;
        }
        drag = { kind: "pan", x0: this.x0, top: this.scroll.scrollTop };
        return true;
      },
      dragMove: (pos, d) => {
        if (!drag) return;
        if (drag.kind === "pan") {
          this.x0 = Math.max(0, drag.x0 - d.x / this.ppb);
          this.scroll.scrollTop = drag.top - d.y;
          this.follow = false; this.followBtn.classList.remove("on");
          this.surf.draw(); this.rulerSurf.draw();
          return;
        }
        if (drag.kind === "point") { this.dragPoint(drag, pos); return; }
        const db = this.xb(pos.x) - drag.b0;
        store.live((p) => {
          let t = p.tracks.find((x) => x.id === drag.track);
          const pl = t.arrangement.find((x) => x.id === drag.id);
          if (!pl) return;
          const o = drag.pl;
          if (drag.kind === "move") {
            pl.start = Math.max(0, this.snapB(o.start + db));
            const r = this.rowAt(pos.y);
            if (r && !r.lane && r.track.id !== t.id && r.track.type === t.type) {
              const to = p.tracks.find((x) => x.id === r.track.id);
              t.arrangement = t.arrangement.filter((x) => x !== pl);
              to.arrangement.push(pl);
              drag.track = to.id;
            }
          } else if (drag.kind === "end") {
            pl.length = Math.max(this.snap / 2, this.snapB(o.start + o.length + db) - o.start);
          } else {
            const ns = clamp(this.snapB(o.start + db), Math.max(0, o.start - (o.offset || 0)), o.start + o.length - this.snap / 2);
            pl.offset = Math.max(0, (o.offset || 0) + (ns - o.start));
            pl.length = o.length - (ns - o.start);
            pl.start = ns;
          }
        }, "arrange");
      },
      dragEnd: () => {
        if (!drag) return;
        if (drag.kind === "pan") { drag = null; return; }
        if (drag.kind !== "point") {
          // a moved clip cuts what it lands on
          store.live((p) => {
            const t = p.tracks.find((x) => x.id === drag.track);
            const pl = t.arrangement.find((x) => x.id === drag.id);
            if (pl) { t.arrangement = t.arrangement.filter((x) => x !== pl); placeClip(t, pl); }
          });
        }
        store.commit("arrange");
        drag = null;
      },
      pinch: (g) => {
        this.zoom(g.scale, g.cx, true);
        this.x0 = Math.max(0, this.x0 - g.dx / this.ppb);
        this.scroll.scrollTop -= g.dy;
        this.follow = false; this.followBtn.classList.remove("on");
      },
      wheel: (e, pos) => {
        if (e.ctrlKey || e.metaKey) { this.zoom(Math.exp(-e.deltaY * 0.01), pos.x); return; }
        const dx = e.shiftKey ? e.deltaY : e.deltaX;
        this.x0 = Math.max(0, this.x0 + dx / this.ppb);
        if (!e.shiftKey) this.scroll.scrollTop += e.deltaY;
        this.surf.draw(); this.rulerSurf.draw();
      },
    });
  }

  zoom(f, cx, noRedrawHeaders) {
    const b = this.xb(cx);
    this.ppb = clamp(this.ppb * f, 2, 400);
    this.x0 = Math.max(0, b - cx / this.ppb);
    this.surf.draw(); this.rulerSurf.draw();
  }

  newClipAt(track, start) {
    const store = this.app.store;
    store.update((p) => {
      const t = tr(p, track);
      const c = newMidiClip(p, t, 4);
      const pl = { id: uid("a"), clipId: c.id, start, length: 4, offset: 0 };
      placeClip(t, pl);
      this.selPl = pl.id;
      store.ui.selClip = c.id;
      store.ui.selTrack = t.id;
      store.ui.panel = "clip";
    }, "clips");
  }

  async importAt(track, start) {
    const app = this.app;
    const s = await pickSample(app, { title: "Sample for " + track.name });
    if (!s) return;
    const bpm = s.bpm || guessBpm(s.duration);
    app.store.update((p) => {
      const t = tr(p, track);
      const c = newAudioClip(p, t, s, bpm);
      placeClip(t, { id: uid("a"), clipId: c.id, start, length: c.length, offset: 0 });
      app.store.ui.selClip = c.id;
      app.store.ui.selTrack = t.id;
    }, "clips");
  }

  clipMenu(track, pl, at, beat) {
    const app = this.app, store = app.store;
    const clip = this.p.clips[pl.clipId];
    const uses = this.p.tracks.reduce((n, t) => n + t.arrangement.filter((x) => x.clipId === pl.clipId).length + t.slots.filter((x) => x === pl.clipId).length, 0);
    const split = app.transport.position > pl.start && app.transport.position < pl.start + pl.length ? app.transport.position : this.snapB(beat);
    menu(at, [
      { label: "Open in editor", onClick: () => store.select({ selTrack: track.id, selClip: pl.clipId, panel: "clip" }) },
      { label: "Duplicate after", onClick: () => store.update((p) => { const t = tr(p, track); placeClip(t, { ...pl, id: uid("a"), start: pl.start + pl.length }); }, "arrange") },
      { label: "Loop it twice as long", onClick: () => store.update((p) => { const x = tr(p, track).arrangement.find((q) => q.id === pl.id); x.length *= 2; placeClip(tr(p, track), x); }, "arrange") },
      { label: "Split at " + (split / 4 + 1).toFixed(2).replace(/\.00$/, "") + "", disabled: !(split > pl.start && split < pl.start + pl.length), onClick: () => store.update((p) => {
        const t = tr(p, track), x = t.arrangement.find((q) => q.id === pl.id);
        const right = { ...x, id: uid("a"), start: split, length: x.start + x.length - split, offset: (x.offset || 0) + (split - x.start) };
        x.length = split - x.start;
        t.arrangement.push(right);
        t.arrangement.sort((a, b) => a.start - b.start);
      }, "arrange") },
      { label: "Copy", onClick: () => { this.clipboard = { clipId: pl.clipId, length: pl.length, offset: pl.offset }; toast("Copied: long press an empty place to paste"); } },
      { label: uses > 1 ? `Make unique (used ${uses}×)` : "Make unique", disabled: uses < 2, onClick: () => store.update((p) => {
        const c = JSON.parse(JSON.stringify(p.clips[pl.clipId]));
        c.id = uid("c");
        p.clips[c.id] = c;
        tr(p, track).arrangement.find((q) => q.id === pl.id).clipId = c.id;
        store.ui.selClip = c.id;
      }, "clips") },
      { label: "Rename clip…", onClick: async () => { const n = await prompt("Clip name", clip.name); if (n) store.update((p) => { p.clips[pl.clipId].name = n; }, "clips"); } },
      clip && clip.type === "midi" ? { label: "Save as a MIDI file…", onClick: () => exportClipMidi(app, clip, track) } : null,
      { label: "Put in the session", onClick: () => store.update((p) => { const t = tr(p, track); const i = t.slots.indexOf(null); if (i >= 0) t.slots[i] = pl.clipId; else t.slots.push(pl.clipId); }, "session") },
      "-",
      { label: "Delete", danger: true, onClick: () => this.deletePlacement(track.id, pl.id) },
    ], { title: clip ? clip.name : "Clip" });
  }

  paste(track, start) {
    const cb = this.clipboard;
    const clip = this.p.clips[cb.clipId];
    if (!clip) return;
    const t0 = this.p.tracks.find((x) => x.id === track.id);
    if ((clip.type === "audio") !== (t0.type === "audio")) { toast("That clip goes on a " + (clip.type === "audio" ? "audio" : "MIDI") + " track"); return; }
    this.app.store.update((p) => placeClip(tr(p, track), { id: uid("a"), clipId: cb.clipId, start, length: cb.length, offset: cb.offset || 0 }), "arrange");
  }

  deletePlacement(trackId, plId) {
    this.app.store.update((p) => { const t = p.tracks.find((x) => x.id === trackId); t.arrangement = t.arrangement.filter((x) => x.id !== plId); }, "arrange");
    this.selPl = null;
  }

  deleteSelection() {
    if (!this.selPl) return;
    for (const t of this.p.tracks) if (t.arrangement.some((x) => x.id === this.selPl)) { this.deletePlacement(t.id, this.selPl); return; }
  }

  /** A file dropped at page point (x, y): {track, start} on a track's lane, or null below the tracks */
  dropTarget(x, y) {
    const r0 = this.lanes.getBoundingClientRect();
    const r = this.rowAt(y - r0.top);
    if (!r) return null;
    const sig = this.p.sig || 4;
    return { track: r.track, start: Math.max(0, Math.floor(this.xb(x - r0.left) / sig) * sig) };
  }

  // ---- automation lanes ----
  laneY(r, v) { return r.y - this.scroll.scrollTop + 5 + (1 - v) * (r.h - 10); }
  laneV(r, y) { return clamp(1 - (y + this.scroll.scrollTop - r.y - 5) / (r.h - 10), 0, 1); }
  pointAt(r, pos) {
    const pts = r.track.automation[r.lane] || [];
    let best = null, bd = 22;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(this.bx(pts[i].t) - pos.x, this.laneY(r, pts[i].v) - pos.y);
      if (d < bd) { bd = d; best = i; }
    }
    return best === null ? null : { i: best };
  }
  laneTap(r, pos) {
    const key = r.lane;
    const fine = this.snap / 4;
    const t = Math.max(0, Math.round(this.xb(pos.x) / fine) * fine);
    const v = this.laneV(r, pos.y);
    if (this.pointAt(r, pos)) return;
    this.app.store.update((p) => {
      const x = tr(p, r.track);
      const pts = (x.automation[key] = x.automation[key] || []);
      if (!pts.length) {
        // a first point: the current value from the start, so the lane begins where the knob is
        const cur = key === "vol" ? x.mixer.vol : key === "pan" ? (x.mixer.pan + 1) / 2 : key === "sendA" ? x.mixer.sendA : key === "sendB" ? x.mixer.sendB : v;
        if (t > 0) pts.push({ t: 0, v: cur });
      }
      pts.push({ t, v });
      pts.sort((a, b) => a.t - b.t);
    }, "automation");
  }
  laneDouble(r, pos) {
    const pt = this.pointAt(r, pos);
    if (!pt) return;
    this.app.store.update((p) => { tr(p, r.track).automation[r.lane].splice(pt.i, 1); }, "automation");
  }
  dragPoint(drag, pos) {
    const fine = this.snap / 4;
    this.app.store.live((p) => {
      const pts = tr(p, drag.r.track).automation[drag.r.lane];
      const pt = pts[drag.pt.i];
      if (!pt) return;
      const lo = drag.pt.i > 0 ? pts[drag.pt.i - 1].t : 0;
      const hi = drag.pt.i < pts.length - 1 ? pts[drag.pt.i + 1].t : Infinity;
      pt.t = clamp(Math.round(this.xb(pos.x) / fine) * fine, lo, hi);
      pt.v = this.laneV(drag.r, pos.y);
    }, "automation");
  }

  // ---- the ruler ----
  setupRuler() {
    const app = this.app, store = app.store;
    let drag = null;
    const inLoop = (y) => y < 15;
    gestures(this.ruler, {
      tap: (pos) => {
        if (inLoop(pos.y)) {
          const l = this.p.loop, b = this.xb(pos.x);
          if (b >= l.start && b <= l.end) store.update((p) => { p.loop.on = !p.loop.on; }, "loop");
          else { const s = Math.floor(b / 4) * 4; store.update((p) => { p.loop = { on: true, start: s, end: s + 4 }; }, "loop"); }
          return;
        }
        app.transport.seek(Math.max(0, this.snapB(this.xb(pos.x), Math.min(this.snap, 1))));
        this.rulerSurf.draw(); this.surf.draw();
      },
      dragStart: (pos) => {
        if (inLoop(pos.y)) {
          const l = this.p.loop, x0 = this.bx(l.start), x1 = this.bx(l.end);
          store.begin();
          if (Math.abs(pos.x - x1) < 16) drag = { kind: "lend" };
          else if (Math.abs(pos.x - x0) < 16) drag = { kind: "lstart" };
          else if (pos.x > x0 && pos.x < x1) drag = { kind: "lmove", s: l.start, e: l.end, b0: this.xb(pos.x) };
          else drag = { kind: "lnew", b0: this.snapB(this.xb(pos.x)) };
          return true;
        }
        drag = { kind: "scrub" };
        return true;
      },
      dragMove: (pos) => {
        const b = Math.max(0, this.snapB(this.xb(pos.x)));
        if (drag.kind === "scrub") { app.transport.position = app.transport.playing ? app.transport.position : b; if (!app.transport.playing) { this.rulerSurf.draw(); this.surf.draw(); } drag.b = b; return; }
        store.live((p) => {
          const l = p.loop;
          if (drag.kind === "lend") l.end = Math.max(l.start + this.snap, b);
          else if (drag.kind === "lstart") l.start = Math.min(l.end - this.snap, b);
          else if (drag.kind === "lmove") { const d = this.snapB(this.xb(pos.x) - drag.b0); const len = drag.e - drag.s; l.start = Math.max(0, drag.s + d); l.end = l.start + len; }
          else { l.start = Math.min(drag.b0, b); l.end = Math.max(drag.b0 + this.snap, b); l.on = true; }
        }, "loop");
      },
      dragEnd: () => {
        if (drag.kind === "scrub") { if (drag.b !== undefined) app.transport.seek(drag.b); }
        else store.commit("loop");
        drag = null;
      },
      pinch: (g) => { this.zoom(g.scale, g.cx); this.x0 = Math.max(0, this.x0 - g.dx / this.ppb); },
      wheel: (e, pos) => {
        if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) this.zoom(Math.exp(-e.deltaY * 0.01), pos.x);
        else { this.x0 = Math.max(0, this.x0 + e.deltaX / this.ppb); this.surf.draw(); this.rulerSurf.draw(); }
      },
    });
  }

  drawRuler(c, w, hh) {
    const p = this.p, sig = p.sig || 4;
    c.fillStyle = "#1b1c20";
    c.fillRect(0, 0, w, hh);
    // the loop brace
    const l = p.loop;
    const lx0 = this.bx(l.start), lx1 = this.bx(l.end);
    c.fillStyle = l.on ? "rgba(255,170,60,0.85)" : "rgba(150,150,160,0.45)";
    roundRect(c, lx0, 2, Math.max(4, lx1 - lx0), 11, 3);
    c.fill();
    // bars
    const barPx = this.ppb * sig;
    const every = barPx < 26 ? (barPx < 8 ? 16 : barPx < 14 ? 8 : 4) : 1;
    const first = Math.floor(this.x0 / sig);
    c.font = "11px -apple-system, system-ui, sans-serif";
    c.textBaseline = "middle";
    for (let bar = first; ; bar++) {
      const x = this.bx(bar * sig);
      if (x > w) break;
      if (bar % every === 0) {
        c.fillStyle = "#5b5e66";
        c.fillRect(Math.round(x), 16, 1, hh - 16);
        c.fillStyle = "#b9bcc4";
        c.fillText(String(bar + 1), x + 4, 25);
      } else if (barPx > 6) { c.fillStyle = "#3a3c42"; c.fillRect(Math.round(x), hh - 6, 1, 6); }
      if (barPx > 60) for (let b = 1; b < sig; b++) { c.fillStyle = "#3a3c42"; c.fillRect(Math.round(x + b * this.ppb), hh - 5, 1, 5); }
    }
    // the playhead
    const tr0 = this.app.transport;
    const pos = tr0.playing ? tr0.songBeat() : tr0.position;
    const px = this.bx(pos);
    c.fillStyle = "#ffd84a";
    c.beginPath(); c.moveTo(px - 6, hh - 10); c.lineTo(px + 6, hh - 10); c.lineTo(px, hh); c.fill();
  }

  drawLanes(c, w, hh) {
    const p = this.p, app = this.app, store = app.store, sig = p.sig || 4;
    const top = this.scroll.scrollTop;
    c.fillStyle = "#202125";
    c.fillRect(0, 0, w, hh);
    const rows = this.rows();
    // rows
    for (const r of rows) {
      const y = r.y - top;
      if (y > hh || y + r.h < 0) continue;
      const sel = store.ui.selTrack === r.track.id;
      c.fillStyle = r.lane ? "#1c1d21" : sel ? "#2b2d33" : "#25262b";
      c.fillRect(0, y, w, r.h);
      c.fillStyle = "#17181b";
      c.fillRect(0, y + r.h - 1, w, 1);
    }
    // grid
    const barPx = this.ppb * sig;
    const first = Math.floor(this.x0 / sig);
    for (let bar = first; ; bar++) {
      const x = this.bx(bar * sig);
      if (x > w) break;
      const every = barPx < 26 ? (barPx < 8 ? 16 : barPx < 14 ? 8 : 4) : 1;
      if (bar % every === 0) { c.fillStyle = "rgba(255,255,255,0.075)"; c.fillRect(Math.round(x), 0, 1, hh); }
      if (barPx > 60) for (let b = 1; b < sig; b++) { c.fillStyle = "rgba(255,255,255,0.03)"; c.fillRect(Math.round(x + b * this.ppb), 0, 1, hh); }
    }
    // the loop region
    if (p.loop.on) {
      c.fillStyle = "rgba(255,170,60,0.05)";
      c.fillRect(this.bx(p.loop.start), 0, (p.loop.end - p.loop.start) * this.ppb, hh);
    }
    // clips
    const sess = app.transport.session;
    for (const r of rows) {
      const y = r.y - top;
      if (y > hh || y + r.h < 0) continue;
      const s = sess.get(r.track.id);
      const off = s && !s.follow;
      if (r.lane) { this.drawLane(c, r, y, w); continue; }
      for (const pl of r.track.arrangement) {
        const clip = p.clips[pl.clipId];
        if (!clip) continue;
        const x0 = this.bx(pl.start), x1 = this.bx(pl.start + pl.length);
        if (x1 < 0 || x0 > w) continue;
        this.drawClip(c, clip, pl, x0, y + 2, x1 - x0, r.h - 5, r.track, this.selPl === pl.id || (store.ui.selClip === clip.id && !this.selPl), off);
      }
      if (off) {
        c.fillStyle = "rgba(20,20,24,0.45)";
        c.fillRect(0, y, w, r.h - 1);
      }
      const ar = app.recording.audioRegion(r.track.id);
      if (ar && ar.end > ar.start) { // audio being recorded
        const ax = this.bx(ar.start), aw = (ar.end - ar.start) * this.ppb;
        c.fillStyle = "rgba(255,77,77,0.35)";
        roundRect(c, ax, y + 2, Math.max(2, aw), r.h - 5, 4);
        c.fill();
        c.fillStyle = "#ff4d4d";
        c.fillRect(ax, y + 2, Math.max(2, aw), 15);
        c.fillStyle = "#111";
        c.font = "600 11px -apple-system, system-ui, sans-serif";
        if (aw > 40) c.fillText("● Recording", ax + 5, y + 10);
      }
    }
    // the playhead
    const tr0 = app.transport;
    const pos = tr0.playing ? tr0.songBeat() : tr0.position;
    const px = Math.round(this.bx(pos));
    c.fillStyle = "#ffd84a";
    c.fillRect(px, 0, 1.5, hh);
  }

  drawClip(c, clip, pl, x, y, w, hh, track, sel, off) {
    const col = clip.rec ? "#ff4d4d" : clip.color || track.color; // a take being recorded is red
    c.save();
    roundRect(c, x + 0.5, y, Math.max(3, w - 1), hh, 4);
    c.fillStyle = shade(col, -0.55);
    c.fill();
    c.clip();
    c.fillStyle = col;
    c.fillRect(x, y, w, 15);
    c.fillStyle = "#111";
    c.font = "600 11px -apple-system, system-ui, sans-serif";
    c.textBaseline = "middle";
    if (w > 24) c.fillText(clip.name, x + 5, y + 8, w - 10);
    const by = y + 17, bh = hh - 19;
    const L = clip.length;
    // loop repeats
    c.fillStyle = "rgba(0,0,0,0.35)";
    for (let k = L - (pl.offset || 0) % L; k < pl.length; k += L) c.fillRect(x + k * this.ppb, y, 1, hh);
    if (clip.type === "midi") {
      const notes = clip.notes;
      if (notes.length) {
        let lo = 127, hi = 0;
        for (const n of notes) { if (n.p < lo) lo = n.p; if (n.p > hi) hi = n.p; }
        const span = Math.max(8, hi - lo + 1);
        const nh = Math.max(1.5, Math.min(5, bh / span));
        c.fillStyle = shade(col, 0.35);
        for (let k = -(pl.offset || 0); k < pl.length; k += L) {
          for (const n of notes) {
            const nb = k + n.t;
            if (nb + n.d < 0 || nb >= pl.length) continue;
            const nx = x + Math.max(0, nb) * this.ppb;
            const nw = Math.max(1, Math.min(n.d, pl.length - nb) * this.ppb - 1);
            const ny = by + bh - ((n.p - lo + 0.5) / span) * bh - nh / 2;
            c.fillRect(nx, ny, nw, nh);
          }
        }
      }
    } else {
      const peaks = this.app.samples.peaks(clip.sampleId, 1024);
      const buf = this.app.samples.buffer(clip.sampleId);
      if (peaks && buf) {
        const secPerBeat = clip.warp ? 60 / clip.bpm : 60 / this.p.bpm;
        const mid = by + bh / 2;
        c.fillStyle = shade(col, 0.3);
        const step = Math.max(1, Math.floor(w / 400));
        for (let px = 0; px < w; px += step) {
          const beatIn = px / this.ppb + (pl.offset || 0);
          const local = ((beatIn % L) + L) % L;
          const sec = (clip.offset || 0) + local * secPerBeat;
          const i = Math.floor((sec / buf.duration) * 1024);
          if (i < 0 || i >= 1024) continue;
          const a = peaks[2 * i] * (bh / 2) * (clip.gain ?? 1), b = peaks[2 * i + 1] * (bh / 2) * (clip.gain ?? 1);
          c.fillRect(x + px, mid - b, step, Math.max(1, b - a));
        }
      }
    }
    c.restore();
    if (sel) { c.strokeStyle = "#fff"; c.lineWidth = 1.5; roundRect(c, x + 0.5, y, Math.max(3, w - 1), hh, 4); c.stroke(); }
    if (w > 30) { c.fillStyle = "rgba(255,255,255,0.25)"; c.fillRect(x + w - 5, y + hh / 2 - 7, 2, 14); }
  }

  drawLane(c, r, y, w) {
    const pts = r.track.automation[r.lane] || [];
    const col = r.track.color;
    c.strokeStyle = "rgba(255,255,255,0.08)";
    c.beginPath(); c.moveTo(0, y + r.h / 2); c.lineTo(w, y + r.h / 2); c.stroke();
    if (!pts.length) {
      c.fillStyle = "#6a6d75";
      c.font = "11px -apple-system, system-ui, sans-serif";
      c.fillText("Tap to add points · drag to move · double tap removes", 10, y + r.h / 2 + 4);
      return;
    }
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, this.laneY(r, envAt(pts, this.x0)));
    for (const pt of pts) c.lineTo(this.bx(pt.t), this.laneY(r, pt.v));
    c.lineTo(w, this.laneY(r, envAt(pts, this.xb(w))));
    c.stroke();
    c.fillStyle = col;
    for (const pt of pts) {
      const px = this.bx(pt.t);
      if (px < -10 || px > w + 10) continue;
      c.beginPath(); c.arc(px, this.laneY(r, pt.v), 5, 0, Math.PI * 2); c.fill();
    }
    c.lineWidth = 1;
  }

  frame() {
    const tr0 = this.app.transport;
    if (this.meters) {
      const rec = this.app.recording;
      for (const [id, m] of this.meters) {
        const t = this.app.store.track(id);
        const input = t && t.type === "audio" && t.mixer.arm ? rec.inputPeak() : 0; // an armed audio track shows its input
        drawMeter(m, Math.max(this.app.engine.trackPeak(id), input));
      }
    }
    if (!tr0.playing) return;
    const pos = tr0.songBeat();
    if (this.follow) {
      const w = this.surf.w;
      const px = this.bx(pos);
      if (px > w * 0.85 || px < 0) this.x0 = Math.max(0, pos - (w * 0.15) / this.ppb);
    }
    this.surf.draw();
    this.rulerSurf.draw();
  }
}

const tr = (p, t) => p.tracks.find((x) => x.id === t.id);

export function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** A color lighter (amt > 0) or darker (amt < 0) */
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  if (amt < 0) { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
