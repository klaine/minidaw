// The audio graph for a project, in any BaseAudioContext (the live AudioContext, or an OfflineAudioContext for export):
//   track: instrument / clip players -> EQ (3 bands) -> [compressor] -> fader -> pan -> mute/solo -> master + sends
//   returns A (reverb) and B (delay) -> master;  master: fader -> limiter -> analyser -> out
import { createInstrument } from "./instruments.js";
import { faderGain } from "../util.js";

export class AudioEngine {
  constructor(ctx, samples, { offline = false } = {}) {
    this.ctx = ctx;
    this.samples = samples;
    this.offline = offline;
    this.channels = new Map(); // trackId -> Channel
    this.listeners = new Set();
    this.automated = new Map(); // trackId -> Set(lane keys with points): the scheduler drives those params
    this.bpm = 120;
    this.buildMaster();
  }

  onInstrument(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  buildMaster() {
    const c = this.ctx;
    this.master = {
      input: c.createGain(),
      fader: c.createGain(),
      limiter: c.createDynamicsCompressor(),
      analyser: c.createAnalyser(),
      out: c.createGain(),
    };
    const m = this.master;
    m.limiter.threshold.value = -2;
    m.limiter.knee.value = 0;
    m.limiter.ratio.value = 20;
    m.limiter.attack.value = 0.002;
    m.limiter.release.value = 0.12;
    m.analyser.fftSize = 1024;
    m.input.connect(m.fader).connect(m.limiter).connect(m.out);
    m.out.connect(m.analyser);
    m.out.connect(c.destination);
    this.returns = [new ReturnStrip(this, "reverb"), new ReturnStrip(this, "delay")];
    if (!this.offline) {
      this.clickOut = c.createGain();
      this.clickOut.gain.value = 0.5;
      this.clickOut.connect(c.destination);
    }
  }

  channel(id) { return this.channels.get(id) || null; }
  instrument(id) { const ch = this.channels.get(id); return ch ? ch.instrument : null; }

  /** Bring the graph in line with the project (new or removed tracks, mixer values, instruments) */
  sync(project, { states } = {}) {
    this.bpm = project.bpm;
    const seen = new Set();
    const anySolo = project.tracks.some((t) => t.mixer.solo);
    for (const t of project.tracks) {
      seen.add(t.id);
      let ch = this.channels.get(t.id);
      if (!ch) { ch = new Channel(this, t.id); this.channels.set(t.id, ch); }
      ch.apply(t, anySolo, this.automated.get(t.id));
      const kind = t.type === "midi" && t.instrument ? t.instrument.kind : null;
      if (ch.kind !== kind) ch.setInstrument(kind, t, states && states.get(t.id));
    }
    for (const [id, ch] of this.channels) if (!seen.has(id)) { ch.dispose(); this.channels.delete(id); }
    project.returns.forEach((r, i) => this.returns[i] && this.returns[i].apply(r, project.bpm));
    this.master.fader.gain.value = faderGain(project.master.vol);
    return this.whenInstrumentsReady();
  }

  whenInstrumentsReady() {
    return Promise.all([...this.channels.values()].map((ch) => ch.instPromise || null));
  }

  setTempo(bpm, running) {
    this.bpm = bpm;
    for (const ch of this.channels.values()) if (ch.instrument) ch.instrument.tempo(bpm, running);
  }

  stopAll() {
    for (const ch of this.channels.values()) {
      if (ch.instrument) ch.instrument.stop();
      ch.stopSources(this.ctx.currentTime);
    }
  }

  flushAll() {
    return Promise.all([...this.channels.values()].map((ch) => ch.instrument ? ch.instrument.flush() : null));
  }

  /** Every instrument's state (for saving the project, or for an offline render) */
  async collectStates() {
    const out = new Map();
    for (const [id, ch] of this.channels) {
      if (ch.instrument && ch.kind !== "drumrack") {
        try { out.set(id, await ch.instrument.getState()); } catch (e) { console.warn("state", id, e); }
      }
    }
    return out;
  }

  peak(analyser) {
    const a = analyser;
    if (!this._buf || this._buf.length !== a.fftSize) this._buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this._buf);
    let m = 0;
    for (const v of this._buf) { const x = v < 0 ? -v : v; if (x > m) m = x; }
    return m;
  }
  trackPeak(id) { const ch = this.channels.get(id); return ch ? this.peak(ch.analyser) : 0; }
  masterPeak() { return this.peak(this.master.analyser); }
  returnPeak(i) { return this.returns[i] ? this.peak(this.returns[i].analyser) : 0; }

  /** A click for the metronome at `time` */
  click(time, accent) {
    if (!this.clickOut) return;
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(accent ? 0.9 : 0.55, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    o.connect(g).connect(this.clickOut);
    o.start(time);
    o.stop(time + 0.06);
  }

  dispose() {
    for (const ch of this.channels.values()) ch.dispose();
    this.channels.clear();
  }
}

class Channel {
  constructor(engine, id) {
    const c = engine.ctx;
    this.engine = engine;
    this.id = id;
    this.kind = undefined;
    this.instrument = null;
    this.instPromise = null;
    this.sources = new Set(); // clip players
    this.input = c.createGain();
    this.low = c.createBiquadFilter(); this.low.type = "lowshelf"; this.low.frequency.value = 220;
    this.mid = c.createBiquadFilter(); this.mid.type = "peaking"; this.mid.frequency.value = 1100; this.mid.Q.value = 0.7;
    this.high = c.createBiquadFilter(); this.high.type = "highshelf"; this.high.frequency.value = 4500;
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -22; this.comp.ratio.value = 4; this.comp.attack.value = 0.008; this.comp.release.value = 0.18; this.comp.knee.value = 8;
    this.compMakeup = c.createGain(); this.compMakeup.gain.value = 1.6;
    this.fader = c.createGain();
    this.panner = c.createStereoPanner();
    this.mute = c.createGain();
    this.sendA = c.createGain(); this.sendA.gain.value = 0;
    this.sendB = c.createGain(); this.sendB.gain.value = 0;
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 512;
    this.input.connect(this.low).connect(this.mid).connect(this.high);
    this.compOn = null;
    this.setComp(false);
    this.fader.connect(this.panner).connect(this.mute);
    this.mute.connect(engine.master.input);
    this.mute.connect(this.sendA).connect(engine.returns[0].input);
    this.mute.connect(this.sendB).connect(engine.returns[1].input);
    this.mute.connect(this.analyser);
    this.params = { vol: this.fader.gain, pan: this.panner.pan, sendA: this.sendA.gain, sendB: this.sendB.gain };
  }

  setComp(on) {
    if (this.compOn === on) return;
    this.compOn = on;
    try { this.high.disconnect(); } catch (_) { /* first time */ }
    try { this.compMakeup.disconnect(); } catch (_) { /* first time */ }
    if (on) { this.high.connect(this.comp).connect(this.compMakeup).connect(this.fader); }
    else this.high.connect(this.fader);
  }

  apply(t, anySolo, automated) {
    const m = t.mixer;
    const auto = (k) => automated && automated.has(k);
    if (!auto("vol")) this.fader.gain.value = faderGain(m.vol);
    if (!auto("pan")) this.panner.pan.value = m.pan;
    if (!auto("sendA")) this.sendA.gain.value = m.sendA * m.sendA;
    if (!auto("sendB")) this.sendB.gain.value = m.sendB * m.sendB;
    this.low.gain.value = m.eq.low;
    this.mid.gain.value = m.eq.mid;
    this.high.gain.value = m.eq.high;
    this.setComp(!!m.comp);
    const audible = !m.mute && (!anySolo || m.solo);
    this.mute.gain.setTargetAtTime(audible ? 1 : 0, this.engine.ctx.currentTime, 0.01);
  }

  /** The automated value for a lane key (0..1 in the lane's terms) as the param's own value */
  static laneValue(key, v) {
    if (key === "vol") return faderGain(v);
    if (key === "pan") return v * 2 - 1;
    return v * v; // sends
  }

  setInstrument(kind, track, state) {
    const old = this.instrument;
    this.kind = kind;
    this.instrument = null;
    if (old) old.dispose();
    if (!kind) { this.instPromise = null; return; }
    const engine = this.engine;
    const id = this.id;
    const saved = state || (track.instrument && track.instrument.kind === kind && track.instrument.state && kind !== "drumrack" ? track.instrument.state : null);
    const getTrack = () => engine.trackLookup ? engine.trackLookup(id) : track;
    this.instPromise = createInstrument(engine.ctx, kind, {
      state: saved, preset: track.instrument ? track.instrument.preset : null, samples: engine.samples, track: getTrack,
    }).then((inst) => {
      if (this.kind !== kind || this.disposed) { inst.dispose(); return null; }
      this.instrument = inst;
      inst.connect(this.input);
      inst.tempo(engine.bpm, false);
      for (const fn of engine.listeners) fn(id, inst);
      return inst;
    }).catch((err) => {
      console.error(err);
      this.error = String(err.message || err);
      for (const fn of engine.listeners) fn(id, null, this.error);
      return null;
    });
  }

  addSource(node, stopAt) {
    const s = { node, stopAt };
    this.sources.add(s);
    node.onended = () => this.sources.delete(s);
    return s;
  }
  stopSources(t) {
    for (const s of this.sources) {
      try {
        if (s.gain) { s.gain.gain.cancelScheduledValues(t); s.gain.gain.setTargetAtTime(0, t, 0.004); }
        s.node.stop(t + 0.03);
      } catch (_) { /* done */ }
    }
    this.sources.clear();
  }

  dispose() {
    this.disposed = true;
    if (this.instrument) this.instrument.dispose();
    this.stopSources(this.engine.ctx.currentTime);
    for (const n of [this.input, this.low, this.mid, this.high, this.comp, this.compMakeup, this.fader, this.panner, this.mute, this.sendA, this.sendB]) {
      try { n.disconnect(); } catch (_) { /* gone */ }
    }
  }
}
export { Channel };

class ReturnStrip {
  constructor(engine, type) {
    const c = engine.ctx;
    this.engine = engine;
    this.type = type;
    this.input = c.createGain();
    this.fader = c.createGain();
    this.panner = c.createStereoPanner();
    this.mute = c.createGain();
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 512;
    this.tone = c.createBiquadFilter(); this.tone.type = "lowpass";
    if (type === "reverb") {
      this.pre = c.createBiquadFilter(); this.pre.type = "highpass"; this.pre.frequency.value = 180;
      this.conv = c.createConvolver();
      this.input.connect(this.pre).connect(this.conv).connect(this.tone).connect(this.fader);
      this.size = -1;
    } else {
      this.dl = c.createDelay(4); this.dr = c.createDelay(4);
      this.fbl = c.createGain(); this.fbr = c.createGain();
      this.merge = c.createChannelMerger(2);
      this.mono = c.createGain();
      this.mono.channelCount = 1; this.mono.channelCountMode = "explicit";
      this.input.connect(this.mono).connect(this.dl);
      this.dl.connect(this.tone);
      this.tone.connect(this.fbl).connect(this.dr);
      this.dr.connect(this.fbr).connect(this.dl);
      this.tone.connect(this.merge, 0, 0);
      this.dr.connect(this.merge, 0, 1);
      this.merge.connect(this.fader);
    }
    this.fader.connect(this.panner).connect(this.mute).connect(engine.master.input);
    this.mute.connect(this.analyser);
  }

  apply(r, bpm) {
    const t = this.engine.ctx.currentTime;
    this.fader.gain.value = faderGain(r.vol);
    this.panner.pan.value = r.pan || 0;
    this.mute.gain.setTargetAtTime(r.mute ? 0 : 1, t, 0.01);
    const p = r.params || {};
    this.tone.frequency.value = 600 + 14000 * Math.pow(p.tone ?? 0.6, 2);
    if (this.type === "reverb") {
      const size = Math.round((p.size ?? 0.55) * 20) / 20;
      if (size !== this.size) { this.size = size; this.conv.buffer = impulse(this.engine.ctx.sampleRate, 0.6 + size * 4.5); }
    } else {
      const sec = Math.min(3.9, (p.time ?? 0.75) * 60 / bpm);
      this.dl.delayTime.setTargetAtTime(sec, t, 0.05);
      this.dr.delayTime.setTargetAtTime(sec, t, 0.05);
      const fb = Math.min(0.92, p.feedback ?? 0.38);
      this.fbl.gain.value = fb;
      this.fbr.gain.value = fb;
    }
  }
}

function impulse(rate, seconds) {
  const n = Math.floor(rate * seconds);
  const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: rate });
  let s = 12345;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const env = Math.pow(1 - i / n, 2.2) * (t < 0.012 ? t / 0.012 : 1);
      d[i] = rnd() * env * 0.6;
    }
  }
  return b;
}
