// Keys: a multi-touch keyboard (velocity from how low on the key you touch, slide across keys to glide between them)
// or, for a Drum Rack, 16 big pads. It plays the armed tracks, or the selected one, and records when Record is on.
import { h, isBlack, noteName } from "../util.js";
import { DRUM_BASE_NOTE } from "../model.js";

export class KeysView {
  constructor(app, track) {
    this.app = app;
    this.trackId = track.id;
    this.octave = Number(localStorage.getItem("minidaw.octave") || 3);
    this.span = Number(localStorage.getItem("minidaw.span") || 2);
    this.el = h("div", { class: "keys" });
    this.lights = new Set();
    this.render();
  }
  get t() { return this.app.store.track(this.trackId); }
  get drums() { const t = this.t; return t && t.type === "midi" && t.instrument.kind === "drumrack"; }

  render() {
    this.el.textContent = "";
    const t = this.t;
    if (!t) return;
    if (t.type === "audio") { this.el.append(h("p", { class: "panel-empty" }, "An audio track has no keys: select a MIDI track to play it.")); return; }
    const targets = this.app.liveTargets();
    const info = h("span", { class: "keys-info" }, targets.length ? "Playing: " + targets.map((x) => x.name).join(", ") : "");
    if (this.drums) {
      const grid = h("div", { class: "keys-pads" });
      const pads = t.instrument.state.pads;
      for (let row = 3; row >= 0; row--) for (let col = 0; col < 4; col++) {
        const i = row * 4 + col;
        const el = h("div", { class: "pad big", style: { "--tc": t.color } }, h("span", { class: "pad-name" }, pads[i].name), h("span", { class: "pad-note" }, String(i + 1)));
        el.dataset.note = DRUM_BASE_NOTE + i;
        grid.append(el);
      }
      this.wire(grid, ".pad");
      this.el.append(h("div", { class: "keys-bar" }, info, h("span", { class: "dim" }, "Pads 1-16 are C1 to D#2, as an Ableton Drum Rack.")), grid);
      return;
    }
    const lo = 12 * (this.octave + 2), hi = lo + 12 * this.span + 1;
    const kb = h("div", { class: "kb" });
    const whites = [];
    for (let n = lo; n < hi; n++) if (!isBlack(n)) whites.push(n);
    const ww = 100 / whites.length;
    let wi = 0;
    for (let n = lo; n < hi; n++) {
      if (isBlack(n)) {
        const el = h("div", { class: "kb-key black", style: { left: `calc(${wi * ww}% - ${ww * 0.3}%)`, width: ww * 0.6 + "%" } });
        el.dataset.note = n;
        kb.append(el);
      } else {
        const el = h("div", { class: "kb-key white", style: { left: wi * ww + "%", width: ww + "%" } }, n % 12 === 0 ? h("span", {}, noteName(n)) : null);
        el.dataset.note = n;
        kb.append(el);
        wi++;
      }
    }
    this.wire(kb, ".kb-key");
    const btn = (label, fn, title) => h("button", { type: "button", class: "btn small", title, onclick: fn }, label);
    this.el.append(h("div", { class: "keys-bar" },
      btn("Oct −", () => this.setOct(this.octave - 1)), h("span", { class: "keys-oct" }, "C" + this.octave), btn("Oct +", () => this.setOct(this.octave + 1)),
      btn(this.span === 2 ? "3 octaves" : this.span === 3 ? "1 octave" : "2 octaves", () => { this.span = this.span === 2 ? 3 : this.span === 3 ? 1 : 2; localStorage.setItem("minidaw.span", this.span); this.render(); }),
      btn("All off", () => { for (const n of this.down.values()) this.app.liveNote(false, n, 0); this.down.clear(); for (const tr of this.app.liveTargets()) { const i = this.app.engine.instrument(tr.id); if (i) i.midi([0xb0, 123, 0]); } }, "All notes off"),
      info), kb);
  }

  setOct(o) { this.octave = Math.max(-1, Math.min(7, o)); localStorage.setItem("minidaw.octave", this.octave); this.render(); }

  down = new Map(); // pointerId -> note

  wire(root, sel) {
    const app = this.app;
    const noteAt = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const k = el && el.closest(sel);
      if (!k || !root.contains(k)) return null;
      const r = k.getBoundingClientRect();
      const vel = Math.round(40 + 87 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
      return { note: Number(k.dataset.note), vel: this.drums ? Math.round(60 + 67 * (1 - (e.clientY - r.top) / r.height)) : vel, el: k };
    };
    root.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      root.setPointerCapture(e.pointerId);
      const n = noteAt(e);
      if (!n) return;
      this.down.set(e.pointerId, n.note);
      app.liveNote(true, n.note, n.vel);
      n.el.classList.add("on");
    });
    root.addEventListener("pointermove", (e) => {
      if (!this.down.has(e.pointerId) || this.drums) return;
      const n = noteAt(e);
      const cur = this.down.get(e.pointerId);
      if (!n || n.note === cur) return;
      app.liveNote(false, cur, 0);
      root.querySelector(`[data-note="${cur}"]`)?.classList.remove("on");
      this.down.set(e.pointerId, n.note);
      app.liveNote(true, n.note, n.vel);
      n.el.classList.add("on");
    });
    const up = (e) => {
      const cur = this.down.get(e.pointerId);
      if (cur === undefined) return;
      this.down.delete(e.pointerId);
      app.liveNote(false, cur, 0);
      if (![...this.down.values()].includes(cur)) root.querySelector(`[data-note="${cur}"]`)?.classList.remove("on");
    };
    root.addEventListener("pointerup", up);
    root.addEventListener("pointercancel", up);
    root.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Light a key played from elsewhere (MIDI, the computer keyboard) */
  lit(note, on) {
    const k = this.el.querySelector(`[data-note="${note}"]`);
    if (k) k.classList.toggle("on", on);
  }

  update(c) { if (c && (c.reason === "tracks" || c.reason === "mixer" || c.reason === "pad")) this.render(); }
  dispose() { for (const n of this.down.values()) this.app.liveNote(false, n, 0); this.down.clear(); }
}
