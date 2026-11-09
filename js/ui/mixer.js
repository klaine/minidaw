// The mixer: a strip per track (EQ, compressor, sends A and B, pan, fader with meter, mute / solo / arm), the two
// returns (reverb, delay) and the master.
import { h, fmtDb, UNITY } from "../util.js";
import { knob, fader, drawMeter, toggle, menu } from "./controls.js";
import { INSTRUMENT_KINDS } from "../model.js";

const DELAY_TIMES = [[0.25, "1/16"], [0.5, "1/8"], [0.75, "3/16"], [1, "1/4"], [1.5, "3/8"], [2, "1/2"], [3, "3/4"], [4, "1 bar"]];

export class MixerView {
  constructor(app) {
    this.app = app;
    this.strips = h("div", { class: "mix-strips" });
    this.el = h("section", { class: "view mixer" }, this.strips);
    this.meters = [];
  }
  get p() { return this.app.store.project; }

  update(c = {}) {
    if (this.el.hidden) return;
    if (c.live) return;
    this.render();
  }

  render() {
    const app = this.app, store = app.store, p = this.p;
    this.strips.textContent = "";
    this.meters = [];
    const setMixer = (t, k, v, live) => (live ? store.live : store.update).call(store, (p) => { p.tracks.find((x) => x.id === t.id).mixer[k] = v; }, live ? "live-mixer" : "mixer");
    for (const t of p.tracks) {
      const m = t.mixer;
      const auto = app.engine.automated.get(t.id);
      const kind = t.type === "audio" ? "Audio" : (INSTRUMENT_KINDS.find((k) => k.kind === t.instrument.kind) || {}).name;
      const eq = (band, label) => knob({ label, value: (m.eq[band] + 15) / 30, def: 0.5, bipolar: true, small: true, size: 28,
        format: (v) => (v * 30 - 15 > 0 ? "+" : "") + (v * 30 - 15).toFixed(1),
        onInput: (v) => store.live((p) => { p.tracks.find((x) => x.id === t.id).mixer.eq[band] = Math.round((v * 30 - 15) * 10) / 10; }, "live-mixer"),
        onChange: (v) => store.update((p) => { p.tracks.find((x) => x.id === t.id).mixer.eq[band] = Math.round((v * 30 - 15) * 10) / 10; }, "mixer") });
      const send = (k, label) => knob({ label, value: m[k], def: 0, small: true, size: 28, color: k === "sendA" ? "#5ac8fa" : "#bf8cff",
        format: (v) => (v <= 0 ? "-∞" : (20 * Math.log10(v * v)).toFixed(0)),
        onInput: (v) => setMixer(t, k, v, true), onChange: (v) => setMixer(t, k, v) });
      const pan = knob({ label: "Pan", value: (m.pan + 1) / 2, def: 0.5, bipolar: true, small: true, size: 28,
        format: (v) => { const x = Math.round((v * 2 - 1) * 50); return x === 0 ? "C" : x < 0 ? -x + "L" : x + "R"; },
        onInput: (v) => setMixer(t, "pan", Math.round((v * 2 - 1) * 100) / 100, true), onChange: (v) => setMixer(t, "pan", Math.round((v * 2 - 1) * 100) / 100) });
      const fd = fader({ value: m.vol, def: UNITY, format: fmtDb, onInput: (v) => setMixer(t, "vol", v, true), onChange: (v) => setMixer(t, "vol", v) });
      if (auto && auto.has("vol")) fd.classList.add("automated");
      this.meters.push([fd.meter, () => app.engine.trackPeak(t.id)]);
      const sel = store.ui.selTrack === t.id;
      const strip = h("div", { class: "strip" + (sel ? " sel" : ""), style: { "--tc": t.color } },
        h("button", { type: "button", class: "strip-name", onclick: () => { store.select({ selTrack: t.id, panel: "device" }); this.render(); } }, t.name),
        h("div", { class: "strip-kind" }, kind),
        h("div", { class: "strip-row" }, eq("low", "Lo"), eq("mid", "Mid"), eq("high", "Hi")),
        toggle("Comp", m.comp, () => setMixer(t, "comp", !m.comp), "small strip-comp"),
        h("div", { class: "strip-row" }, send("sendA", "A"), send("sendB", "B"), pan),
        fd,
        h("div", { class: "strip-btns" },
          toggle("M", m.mute, () => setMixer(t, "mute", !m.mute), "mute"),
          toggle("S", m.solo, () => setMixer(t, "solo", !m.solo), "solo"),
          toggle("●", m.arm, () => setMixer(t, "arm", !m.arm), "arm")));
      this.strips.append(strip);
    }
    this.strips.append(h("div", { class: "strip-gap" }));
    p.returns.forEach((r, i) => this.strips.append(this.returnStrip(r, i)));
    // master
    const mf = fader({ value: p.master.vol, def: UNITY, format: fmtDb,
      onInput: (v) => store.live((p) => { p.master.vol = v; }, "live-mixer"), onChange: (v) => store.update((p) => { p.master.vol = v; }, "mixer") });
    this.meters.push([mf.meter, () => app.engine.masterPeak()]);
    this.strips.append(h("div", { class: "strip master" }, h("div", { class: "strip-name" }, "Master"), h("div", { class: "strip-kind" }, "limiter"), h("div", { class: "strip-flex" }), mf));
  }

  returnStrip(r, i) {
    const app = this.app, store = app.store;
    const set = (fn, live) => (live ? store.live : store.update).call(store, (p) => fn(p.returns[i]), live ? "live-mixer" : "mixer");
    const params = [];
    if (r.type === "reverb") {
      params.push(knob({ label: "Size", value: r.params.size, def: 0.55, small: true, size: 28, onInput: (v) => set((x) => { x.params.size = v; }, true), onChange: (v) => set((x) => { x.params.size = v; }) }));
    } else {
      const label = (DELAY_TIMES.find((d) => d[0] === r.params.time) || [0, r.params.time + " beats"])[1];
      params.push(h("button", { type: "button", class: "btn small strip-time", onclick: (e) => menu(e.currentTarget, DELAY_TIMES.map(([v, l]) => ({ label: l, checked: v === r.params.time, onClick: () => set((x) => { x.params.time = v; }) }))) }, label));
      params.push(knob({ label: "Fdbk", value: r.params.feedback / 0.92, def: 0.4, small: true, size: 28, format: (v) => Math.round(v * 92) + "%", onInput: (v) => set((x) => { x.params.feedback = v * 0.92; }, true), onChange: (v) => set((x) => { x.params.feedback = v * 0.92; }) }));
    }
    params.push(knob({ label: "Tone", value: r.params.tone, def: 0.6, small: true, size: 28, onInput: (v) => set((x) => { x.params.tone = v; }, true), onChange: (v) => set((x) => { x.params.tone = v; }) }));
    const pan = knob({ label: "Pan", value: ((r.pan || 0) + 1) / 2, def: 0.5, bipolar: true, small: true, size: 28,
      format: (v) => { const x = Math.round((v * 2 - 1) * 50); return x === 0 ? "C" : x < 0 ? -x + "L" : x + "R"; },
      onInput: (v) => set((x) => { x.pan = v * 2 - 1; }, true), onChange: (v) => set((x) => { x.pan = v * 2 - 1; }) });
    const fd = fader({ value: r.vol, def: UNITY, format: fmtDb, onInput: (v) => set((x) => { x.vol = v; }, true), onChange: (v) => set((x) => { x.vol = v; }) });
    this.meters.push([fd.meter, () => app.engine.returnPeak(i)]);
    return h("div", { class: "strip return", style: { "--tc": i === 0 ? "#5ac8fa" : "#bf8cff" } },
      h("div", { class: "strip-name" }, (i === 0 ? "A " : "B ") + r.name), h("div", { class: "strip-kind" }, "return"),
      h("div", { class: "strip-row" }, ...params), h("div", { class: "strip-row" }, pan), fd,
      h("div", { class: "strip-btns" }, toggle("M", r.mute, () => set((x) => { x.mute = !x.mute; }), "mute")));
  }

  frame() {
    for (const [canvas, fn] of this.meters) drawMeter(canvas, fn());
  }
}
