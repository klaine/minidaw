/* minidaw's AudioWorklet processors (one module, loaded once per AudioContext or OfflineAudioContext):
 *
 *   "schwung"   Crest, Amino (web/wasm_host.c: wa_*) and Bizar (web/glue.c: the plugin's function table), unchanged
 *   "recorder"  hands its input to the page in chunks (output recording, microphone recording)
 *
 * The instruments run their own wasm; this file only hosts them. Events carry an AudioContext time and are applied at
 * their sample: the block is rendered in pieces between them, so a sequenced note lands where it was scheduled. That
 * is also what makes an offline render (export) sound the same as playback: the whole song is queued up front.
 *
 * Messages from the page:
 *   {t:"ev", list:[{time, m:[status,d1,d2]} | {time, key, val}]}   queued, applied at `time` (0 or past: at once)
 *   {t:"set", key, val}                 set_param now           {t:"get", id, key}  -> {t:"got", id, val}
 *   {t:"tempo", bpm, run}               the host clock          {t:"stop"}  drop the queue, release held notes
 *   {t:"flush", id} -> {t:"flushed", id} (everything before it has been handled: an offline render may start)
 */

import { EventQueue } from "./queue.js";

const compiled = Object.create(null); // kind -> WebAssembly.Module, shared by every node in this context

function moduleFor(kind, bytes) {
  if (!compiled[kind]) {
    if (!bytes) throw new Error(kind + ": no wasm bytes for the first instance");
    compiled[kind] = new WebAssembly.Module(bytes);
  }
  return compiled[kind];
}

// UTF-8 by hand: TextEncoder isn't guaranteed in an AudioWorkletGlobalScope (Crest's and Amino's worklets found the same)
function utf8Write(mem, ptr, cap, s) {
  let p = ptr;
  const end = ptr + cap - 1;
  for (let i = 0; i < s.length && p < end; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    if (c < 0x80) mem[p++] = c;
    else if (c < 0x800) { if (p + 1 >= end) break; mem[p++] = 0xc0 | (c >> 6); mem[p++] = 0x80 | (c & 63); }
    else if (c < 0x10000) { if (p + 2 >= end) break; mem[p++] = 0xe0 | (c >> 12); mem[p++] = 0x80 | ((c >> 6) & 63); mem[p++] = 0x80 | (c & 63); }
    else { if (p + 3 >= end) break; mem[p++] = 0xf0 | (c >> 18); mem[p++] = 0x80 | ((c >> 12) & 63); mem[p++] = 0x80 | ((c >> 6) & 63); mem[p++] = 0x80 | (c & 63); }
  }
  mem[p] = 0;
  return p - ptr;
}

function utf8Read(mem, ptr, len) {
  let out = "";
  for (let i = ptr, end = ptr + len; i < end;) {
    const b = mem[i++];
    let c = b;
    if (b >= 0xf0) c = ((b & 7) << 18) | ((mem[i++] & 63) << 12) | ((mem[i++] & 63) << 6) | (mem[i++] & 63);
    else if (b >= 0xe0) c = ((b & 15) << 12) | ((mem[i++] & 63) << 6) | (mem[i++] & 63);
    else if (b >= 0xc0) c = ((b & 31) << 6) | (mem[i++] & 63);
    if (c >= 0x10000) { c -= 0x10000; out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); }
    else out += String.fromCharCode(c);
  }
  return out;
}

/* Crest / Amino: web/wasm_host.c, one engine per module instance, fixed buffers (no malloc from JS) */
function waAdapter(bytes, kind) {
  const x = new WebAssembly.Instance(moduleFor(kind, bytes), {}).exports;
  x._initialize();
  if (x.wa_init(sampleRate) !== 1) throw new Error(kind + ": wa_init failed");
  const mem = () => new Uint8Array(x.memory.buffer);
  return {
    midi(s, d1, d2) { x.wa_midi(s, d1, d2); },
    set(k, v) { utf8Write(mem(), x.wa_key(), x.wa_key_cap(), k); utf8Write(mem(), x.wa_val(), x.wa_val_cap(), v); x.wa_set(); },
    get(k) {
      utf8Write(mem(), x.wa_key(), x.wa_key_cap(), k);
      const n = x.wa_get();
      return n < 0 ? null : utf8Read(mem(), x.wa_out(), n);
    },
    tempo(bpm, run) { x.wa_set_tempo(bpm, run ? 1 : 0); },
    render(n) { x.wa_render(n); return new Int16Array(x.memory.buffer, x.wa_pcm(), n * 2); },
  };
}

/* Bizar: web/glue.c exports the plugin's api table (create, destroy, midi, set_param, get_param, ..., render) */
function bizarAdapter(bytes, kind) {
  const ex = new WebAssembly.Instance(moduleFor(kind, bytes), {}).exports;
  ex._initialize();
  const api = ex.sf_web_api();
  const T = ex.__indirect_function_table;
  const fn = (i) => T.get(new DataView(ex.memory.buffer).getUint32(api + 4 + 4 * i, true));
  const f = { create: fn(0), midi: fn(2), set: fn(3), get: fn(4), render: fn(6) };
  const inst = f.create(0, 0);
  if (!inst) throw new Error("bizar: no free instance");
  const cap = 1 << 20;
  const buf = ex.malloc(cap), out = ex.malloc(128 * 4), midiBuf = ex.malloc(4);
  const put = (s) => {
    const n = s.length * 3 + 1, p = ex.malloc(n);
    utf8Write(new Uint8Array(ex.memory.buffer), p, n, s);
    return p;
  };
  return {
    midi(s, d1, d2) {
      new Uint8Array(ex.memory.buffer, midiBuf, 3).set([s, d1, d2]);
      f.midi(inst, midiBuf, (s & 0xf0) === 0xc0 || (s & 0xf0) === 0xd0 ? 2 : 3, 0);
    },
    set(k, v) { const a = put(k), b = put(v); f.set(inst, a, b); ex.free(a); ex.free(b); },
    get(k) {
      const p = put(k), r = f.get(inst, p, buf, cap);
      ex.free(p);
      if (r < 0) return null;
      const m = new Uint8Array(ex.memory.buffer);
      let e = buf;
      while (m[e] && e < buf + cap) e++;
      return utf8Read(m, buf, e - buf);
    },
    tempo(bpm) { ex.sf_web_set_tempo(bpm); },
    render(n) { f.render(inst, out, n); return new Int16Array(ex.memory.buffer, out, n * 2); },
  };
}

const MIN_SPLIT = 8; // frames: events closer than this to the last split share it

class SchwungProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.ok = false;
    this.q = new EventQueue();
    this.held = new Set();
    try {
      this.e = o.api === "bizar" ? bizarAdapter(o.wasm, o.kind) : waAdapter(o.wasm, o.kind);
      this.ok = true;
    } catch (err) {
      this.error = String((err && err.message) || err);
    }
    this.port.onmessage = (ev) => this.onMessage(ev.data);
    this.port.postMessage({ t: "ready", ok: this.ok, error: this.error, sampleRate });
  }

  onMessage(d) {
    if (!this.ok) {
      if (d.id) this.port.postMessage({ t: d.t === "flush" ? "flushed" : "got", id: d.id, val: null });
      return;
    }
    try {
      switch (d.t) {
        case "ev": for (const e of d.list) this.q.push(e); break;
        case "set": this.e.set(d.key, String(d.val)); break;
        case "get": this.port.postMessage({ t: "got", id: d.id, val: this.e.get(d.key) }); break;
        case "tempo": this.e.tempo(d.bpm, d.run); break;
        case "stop": this.stopAll(); break;
        case "flush": this.port.postMessage({ t: "flushed", id: d.id }); break;
      }
    } catch (err) {
      if (d.id) this.port.postMessage({ t: "got", id: d.id, val: null, error: String(err) });
    }
  }

  stopAll() {
    this.q.clear();
    for (const k of this.held) this.e.midi(0x80 | (k >> 8), k & 127, 0);
    this.held.clear();
    this.e.midi(0xb0, 64, 0);   // sustain up
    this.e.midi(0xb0, 123, 0);  // all notes off
  }

  apply(ev) {
    if (ev.m) {
      const [s, d1 = 0, d2 = 0] = ev.m;
      const type = s & 0xf0, key = ((s & 15) << 8) | d1;
      if (type === 0x90 && d2 > 0) this.held.add(key);
      else if (type === 0x80 || type === 0x90) this.held.delete(key);
      this.e.midi(s, d1, d2);
    } else if (ev.key !== undefined) {
      this.e.set(ev.key, String(ev.val));
    }
  }

  renderInto(l, r, from, to) {
    const n = to - from;
    if (n <= 0) return;
    const pcm = this.e.render(n);
    for (let i = 0; i < n; i++) { l[from + i] = pcm[2 * i] / 32768; r[from + i] = pcm[2 * i + 1] / 32768; }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.ok || !out || !out.length) return true;
    const l = out[0], r = out[1] || out[0];
    const frames = l.length;
    const t0 = currentTime, end = t0 + frames / sampleRate;
    const q = this.q.list;
    let pos = 0;
    while (q.length && q[0].time < end) {
      const ev = q.shift();
      let at = Math.round((ev.time - t0) * sampleRate);
      if (at < pos) at = pos;
      if (at >= frames) at = frames - 1;
      if (at - pos >= MIN_SPLIT) { this.renderInto(l, r, pos, at); pos = at; }
      this.apply(ev);
    }
    this.renderInto(l, r, pos, frames);
    return true;
  }
}
registerProcessor("schwung", SchwungProcessor);

/* Copies its input to the page in chunks of about 4096 frames, as long as it's connected (recording) */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = (options.processorOptions && options.processorOptions.channels) || 2;
    this.on = false;
    this.chunk = [];
    this.frames = 0;
    this.port.onmessage = (e) => {
      if (e.data.t === "start") { this.on = true; this.startFrame = currentFrame; this.port.postMessage({ t: "started", time: currentTime }); }
      else if (e.data.t === "stop") { this.flush(); this.on = false; this.port.postMessage({ t: "stopped", time: currentTime }); }
    };
  }
  flush() {
    if (!this.frames) return;
    const out = [];
    for (let c = 0; c < this.channels; c++) {
      const a = new Float32Array(this.frames);
      let at = 0;
      for (const block of this.chunk) { a.set(block[c], at); at += block[c].length; }
      out.push(a);
    }
    this.port.postMessage({ t: "data", channels: out }, out.map((a) => a.buffer));
    this.chunk = [];
    this.frames = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    if (outputs[0]) for (const ch of outputs[0]) ch.fill(0);
    if (!this.on || !input || !input.length) return true;
    const block = [];
    for (let c = 0; c < this.channels; c++) block.push(new Float32Array(input[Math.min(c, input.length - 1)]));
    this.chunk.push(block);
    this.frames += block[0].length;
    if (this.frames >= 4096) this.flush();
    return true;
  }
}
registerProcessor("recorder", RecorderProcessor);
