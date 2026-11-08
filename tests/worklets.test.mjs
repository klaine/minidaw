// node tests/worklets.test.mjs: the DAW's processors with the real instruments, in a stand-in AudioWorkletGlobalScope.
// Checks that each engine starts, answers gets, sounds when a note is queued, starts that note at its sample, and
// goes quiet after a stop.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INST = join(ROOT, "app/instruments");
const registry = {};
globalThis.sampleRate = 44100;
globalThis.currentTime = 0;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    const self = this;
    this.sent = [];
    this.port = { onmessage: null, postMessage(m) { self.sent.push(m); } };
  }
};
globalThis.registerProcessor = (name, cls) => { registry[name] = cls; };
await import("../app/js/worklets/daw-worklet.js");
await import("../app/js/worklets/p8-worklet.js");

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log("  FAIL " + what); } else console.log("  ok   " + what); };
const msg = (p, d) => p.port.onmessage({ data: d });

function render(p, blocks) {
  const L = [], R = [];
  for (let b = 0; b < blocks; b++) {
    const l = new Float32Array(128), r = new Float32Array(128);
    p.process([], [[l, r]]);
    L.push(...l); R.push(...r);
    globalThis.currentFrame += 128;
    globalThis.currentTime = globalThis.currentFrame / sampleRate;
  }
  return [L, R];
}
const firstAbove = (x, th) => x.findIndex((v) => Math.abs(v) > th);
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

function testSchwung(kind, api, wasmRel) {
  console.log(kind);
  globalThis.currentFrame = 0; globalThis.currentTime = 0;
  const wasm = readFileSync(join(INST, kind, wasmRel));
  const p = new registry.schwung({ processorOptions: { kind, api, wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length) } });
  const ready = p.sent.find((m) => m.t === "ready");
  check(ready && ready.ok, "starts" + (ready && ready.error ? ": " + ready.error : ""));
  msg(p, { t: "set", key: "preset", val: "1" });
  msg(p, { t: "get", id: 7, key: "preset_name" });
  const got = p.sent.find((m) => m.t === "got" && m.id === 7);
  check(got && got.val, "answers preset_name: " + (got && got.val));
  render(p, 20);
  const at = 0.1; // seconds: frame 4410
  msg(p, { t: "ev", list: [{ time: at, m: [0x90, 60, 110] }, { time: at + 0.4, m: [0x80, 60, 0] }] });
  const [L] = render(p, 60);
  const offset = 20 * 128;
  const first = firstAbove(L, 1e-4);
  const want = Math.round(at * sampleRate) - offset;
  check(first >= want && first < want + 64, `the note starts at its sample (frame ${first + offset}, scheduled ${want + offset})`);
  check(rms(L) > 1e-3, `sounds (rms ${rms(L).toFixed(4)})`);
  msg(p, { t: "ev", list: [{ time: currentTime, m: [0x90, 64, 100] }] });
  render(p, 10);
  msg(p, { t: "stop" });
  render(p, 1400); // effect tails (Amino's Init Modern has a reverb)
  const [Q] = render(p, 20);
  check(rms(Q) < 1e-3, `quiet after stop (rms ${rms(Q).toFixed(5)})`);
  msg(p, { t: "flush", id: 9 });
  check(p.sent.some((m) => m.t === "flushed" && m.id === 9), "flush answers");
  // a second instance shares the compiled module (no bytes)
  const p2 = new registry.schwung({ processorOptions: { kind, api, wasm: null } });
  check(p2.sent.find((m) => m.t === "ready").ok, "a second instance starts from the shared module");
}

testSchwung("crest", "wa", "editor/assets/engine/crest.wasm");
testSchwung("amino", "wa", "amino.wasm");
testSchwung("bizar", "bizar", "bizar.wasm");

console.log("pro8000v");
{
  globalThis.currentFrame = 0; globalThis.currentTime = 0;
  const w = readFileSync(join(INST, "pro8000v/pro8000v.wasm"));
  const bank = readFileSync(join(INST, "pro8000v/presets.p8bank"));
  const p = new registry.pro8000v({ processorOptions: { wasm: w.buffer.slice(w.byteOffset, w.byteOffset + w.length), bank: bank.buffer.slice(bank.byteOffset, bank.byteOffset + bank.length) } });
  const ready = p.sent.find((m) => m.t === "ready");
  check(ready && ready.ok, "starts, firmware " + (ready && ready.version));
  render(p, 40);
  msg(p, { t: "ev", list: [{ time: currentTime + 0.05, m: [0x90, 45, 110] }] });
  const [L] = render(p, 200);
  check(rms(L) > 1e-3, `sounds (rms ${rms(L).toFixed(4)})`);
  msg(p, { t: "capture", id: 3, name: "Deep Sub" });
  const cap = p.sent.find((m) => m.t === "captured" && m.id === 3);
  const name = cap && cap.record ? String.fromCharCode(...cap.record.slice(4, 20)).replace(/\0.*$/, "").trim() : "";
  check(cap && cap.record && cap.record[0] === 0x50 && name === "Deep Sub", "captures the sound as a record (" + name + ")");
  msg(p, { t: "stop" });
  render(p, 800);
  const [Q] = render(p, 20);
  check(rms(Q) < 2e-3, `quiet after stop (rms ${rms(Q).toFixed(5)})`);
  msg(p, { t: "send", m: [0xc0, 9] });
  render(p, 40);
  const slot = p.sent.filter((m) => m.t === "slot").pop();
  check(slot && slot.slot === 9, "a program change selects another slot (" + (slot && slot.slot) + ")");
  msg(p, { t: "load", id: 5, record: cap.record.buffer, slot: 0 });
  check(p.sent.some((m) => m.t === "loaded" && m.id === 5), "loads a record back");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
