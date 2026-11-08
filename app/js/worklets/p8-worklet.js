/* PRO-8000 V in minidaw: its own engine (p8v.wasm through its p8-core.js, unchanged), with minidaw's timed events.
 * The same messages as PRO-8000 V's web/worklet.js (send, bank, capture, load, fx..., eeprom, timing), and:
 *   {t:"ev", list:[{time, m:[bytes]}]}   MIDI or SysEx, queued; applied at the start of the block they fall in (the
 *                                        firmware takes its input once per block)
 *   {t:"stop"}  drop the queue, release held notes          {t:"flush", id} -> {t:"flushed", id}
 * The firmware's own output (its SysEx replies to the editor) comes back as {t:"midi", list}.
 */
import { instantiateEngine, midiSplitter } from "../../instruments/pro8000v/p8-core.js";
import { EventQueue } from "./queue.js";

const compiled = { bytes: null };

class P8Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.ok = false;
    this.q = new EventQueue();
    this.held = new Set();
    this.split = midiSplitter();
    this.blocks = 0;
    this.slot = -1;
    try {
      // p8-core compiles from bytes; keep one copy for every instance in this context
      if (o.wasm) compiled.bytes = o.wasm;
      if (!compiled.bytes) throw new Error("pro8000v: no wasm bytes");
      this.e = instantiateEngine(compiled.bytes);
      const image = new Uint8Array(128 * 1024);
      if (o.bank) image.set(new Uint8Array(o.bank).subarray(0, 98304));
      this.ok = this.e.init(sampleRate, image, false, false);
      if (!this.ok) this.error = "the firmware didn't start";
    } catch (err) {
      this.error = String((err && err.message) || err);
    }
    this.port.onmessage = (ev) => this.onMessage(ev.data);
    this.port.postMessage({ t: "ready", ok: this.ok, error: this.error, sampleRate, version: this.ok ? this.e.version() : "" });
  }

  onMessage(d) {
    if (!this.ok) { if (d.id) this.port.postMessage({ t: d.t === "flush" ? "flushed" : "failed", id: d.id }); return; }
    try { this.handle(d); } catch (err) {
      if (d.id) this.port.postMessage({ t: "failed", id: d.id, error: String((err && err.message) || err) });
    }
  }

  send(m) {
    const s = m[0] & 0xf0, key = ((m[0] & 15) << 8) | (m[1] | 0);
    if (s === 0x90 && m[2] > 0) this.held.add(key);
    else if (s === 0x80 || s === 0x90) this.held.delete(key);
    this.e.send(m);
  }

  handle(d) {
    const e = this.e, x = e.x;
    switch (d.t) {
      case "ev": for (const ev of d.list) this.q.push(ev); break;
      case "stop":
        this.q.clear();
        for (const k of this.held) e.send([0x80 | (k >> 8), k & 127, 0]);
        this.held.clear();
        e.send([0xb0, 64, 0]);
        e.send([0xb0, 123, 0]);
        e.send([0xfc]); // MIDI clock: Stop
        break;
      case "flush": this.port.postMessage({ t: "flushed", id: d.id }); break;
      case "send": this.send(d.m); break;
      case "bank": e.showBank(new Uint8Array(d.area), d.slot); break;
      case "capture": this.port.postMessage({ t: "captured", id: d.id, record: e.capture(d.name || "") }); break;
      case "load": e.loadRecord(new Uint8Array(d.record), d.slot | 0); if (d.id) this.port.postMessage({ t: "loaded", id: d.id }); break;
      case "fx": x.wa_fx_set(d.i, d.v); break;
      case "fxSet": d.values.forEach((v, i) => x.wa_fx_set(i, v)); break;
      case "fxPreset": x.wa_fx_preset(d.k); break;
      case "fxDefaults": x.wa_fx_defaults(); break;
      case "fxInfo": this.port.postMessage({ t: "fxInfo", id: d.id, info: e.fxInfo() }); break;
      case "fxValues": this.port.postMessage({ t: "fxValues", id: d.id, values: e.fxValues(), active: !!x.wa_fx_active() }); break;
      case "timing": x.wa_set_timing(d.ideal ? 1 : 0); break;
      case "eeprom": this.port.postMessage({ t: "eeprom", id: d.id, image: e.eeprom() }); break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.ok || !out || !out.length) return true;
    const n = out[0].length;
    const end = currentTime + n / sampleRate;
    const q = this.q.list;
    while (q.length && q[0].time < end) this.send(q.shift().m);
    let l, r;
    try {
      [l, r] = this.e.render(n);
    } catch (err) {
      this.ok = false;
      this.port.postMessage({ t: "stopped", error: String((err && err.message) || err) });
      return true;
    }
    out[0].set(l);
    if (out[1]) out[1].set(r);
    const bytes = this.e.output();
    if (bytes) {
      const list = [];
      this.split(bytes, list);
      if (list.length) this.port.postMessage({ t: "midi", list });
    }
    if (++this.blocks % 16 === 0) {
      const saved = this.e.dirty();
      if (saved) this.port.postMessage({ t: "saved", ...saved });
      const s = this.e.slot();
      if (s !== this.slot) { this.slot = s; this.port.postMessage({ t: "slot", slot: s }); }
    }
    return true;
  }
}
registerProcessor("pro8000v", P8Processor);
