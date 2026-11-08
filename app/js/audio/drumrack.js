// The Drum Rack: 16 pads (notes 36-51, C1 up, as Ableton's), each a sample with level, pan, pitch, start, decay,
// reverse and a choke group. Hits are sample players scheduled at their time, so it plays the same live and offline.
import { DRUM_BASE_NOTE } from "../model.js";

const reversed = new WeakMap();
function reverseOf(b) {
  if (!reversed.has(b)) {
    const r = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
    for (let c = 0; c < b.numberOfChannels; c++) r.copyToChannel(b.getChannelData(c).slice().reverse(), c);
    reversed.set(b, r);
  }
  return reversed.get(b);
}

export class DrumRack {
  constructor(ctx, track, samples) {
    this.ctx = ctx;
    this.kind = "drumrack";
    this.meta = { id: "drumrack", name: "Drum Rack", presets: [], params: [], knobs: [] };
    this.getTrack = typeof track === "function" ? track : () => track;
    this.samples = samples;
    this.output = ctx.createGain();
    this.voices = new Set();
    this.ready = Promise.resolve({ ok: true });
    this.onHit = null; // (pad) for the pads' lights
  }
  get pads() { const t = this.getTrack(); return (t && t.instrument && t.instrument.state && t.instrument.state.pads) || []; }
  connect(dest) { this.output.connect(dest); }
  disconnect() { try { this.output.disconnect(); } catch (_) { /* not connected */ } }
  dispose() { this.stop(); this.disconnect(); }

  noteOn(note, vel, time = 0) {
    const i = note - DRUM_BASE_NOTE;
    const pad = this.pads[i];
    if (!pad || pad.mute) return;
    const buffer0 = this.samples.buffer(pad.sample);
    if (!buffer0) { this.samples.load(pad.sample, this.ctx); return; }
    const buffer = pad.reverse ? reverseOf(buffer0) : buffer0;
    const ctx = this.ctx;
    const t = Math.max(time || 0, ctx.currentTime);
    // choke: the group's other voices fade out at this hit
    if (pad.choke) for (const v of this.voices) if (v.choke === pad.choke && v.start <= t) this.release(v, t);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, (pad.pitch || 0) / 12);
    const g = ctx.createGain();
    const level = (pad.gain ?? 0.8) * Math.pow(Math.max(1, vel) / 127, 1.4) * 1.25;
    g.gain.setValueAtTime(level, t);
    const pan = ctx.createStereoPanner();
    pan.pan.value = pad.pan || 0;
    src.connect(g).connect(pan).connect(this.output);
    const offset = Math.min(buffer.duration * 0.95, (pad.start || 0) * buffer.duration);
    const rate = src.playbackRate.value;
    const full = (buffer.duration - offset) / rate;
    const decay = pad.decay ?? 1;
    const v = { src, g, pan, choke: pad.choke || 0, start: t, end: t + full };
    if (decay < 0.999) {
      const hold = Math.max(0.01, full * decay * decay);
      g.gain.setValueAtTime(level, t + hold);
      g.gain.linearRampToValueAtTime(0, t + hold + 0.04);
      v.end = Math.min(v.end, t + hold + 0.05);
    }
    src.start(t, offset);
    src.stop(v.end + 0.01);
    this.voices.add(v);
    src.onended = () => { this.voices.delete(v); try { pan.disconnect(); } catch (_) { /* gone */ } };
    if (this.onHit && !(ctx instanceof OfflineAudioContext)) {
      const delay = Math.max(0, (t - ctx.currentTime) * 1000);
      setTimeout(() => this.onHit && this.onHit(i, vel), delay);
    }
  }

  release(v, t) {
    try {
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setTargetAtTime(0, t, 0.006);
      v.src.stop(t + 0.05);
    } catch (_) { /* already stopped */ }
  }

  noteOff() { /* one-shots */ }
  midi(m, time) { if ((m[0] & 0xf0) === 0x90 && m[2] > 0) this.noteOn(m[1], m[2], time); }
  stop() {
    const t = this.ctx.currentTime;
    for (const v of this.voices) if (v.start > t) { try { v.src.stop(); } catch (_) { /* not started */ } } else this.release(v, t);
  }
  setNorm() {}
  tempo() {}
  flushEvents() {}
  flush() { return Promise.resolve(); }
  loadPreset() { return Promise.resolve(); }
  getState() { return Promise.resolve(null); } // the pads live in the project
  setState() { return Promise.resolve(); }
  listen() { return () => {}; }
}
