// node tests/midifile.test.mjs: reading and writing Standard MIDI Files.
import { parseMidi, writeMidi, toDrumRack } from "../app/js/midifile.js";

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log("  FAIL " + what); } else console.log("  ok   " + what); };

console.log("round trip");
{
  const clip = { length: 8, notes: [{ p: 60, t: 0, d: 1, v: 100 }, { p: 64, t: 0.5, d: 0.25, v: 80 }, { p: 60, t: 1, d: 0.5, v: 90 }, { p: 67, t: 7.5, d: 0.5, v: 127 }] };
  const f = parseMidi(writeMidi(clip, { bpm: 97, name: "Lead" }));
  const n = f.parts[0].notes.map((x) => [x.p, x.t, x.d, x.v]);
  check(f.parts.length === 1 && f.parts[0].name === "Lead", "one part, named");
  check(JSON.stringify(n) === JSON.stringify([[60, 0, 1, 100], [64, 0.5, 0.25, 80], [60, 1, 0.5, 90], [67, 7.5, 0.5, 127]]), "the notes come back: " + JSON.stringify(n));
  check(f.bpm === 97, "the tempo comes back (" + f.bpm + ")");
  check(f.parts[0].end === 8, "the length comes back (" + f.parts[0].end + ")");
}

console.log("a format 1 file by hand");
{
  const vlq = (v) => { const o = [v & 0x7f]; while ((v >>= 7)) o.unshift((v & 0x7f) | 0x80); return o; };
  const trk = (bytes) => [0x4d, 0x54, 0x72, 0x6b, 0, 0, bytes.length >> 8, bytes.length & 255, ...bytes];
  const ppq = 96;
  const conductor = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, /* 120 BPM */ 0, 0xff, 0x2f, 0];
  // running status, note-on velocity 0 as note-off, a program change, a SysEx, a track name
  const bass = [0, 0xff, 0x03, 4, 66, 97, 115, 115, 0, 0xc1, 33, 0, 0xf0, 2, 0x7e, 0xf7,
    0, 0x91, 40, 100, ...vlq(96), 40, 0, 0, 43, 90, ...vlq(48), 43, 0, ...vlq(48), 0xff, 0x2f, 0];
  const drums = [0, 0x99, 36, 120, ...vlq(24), 0x89, 36, 0, ...vlq(72), 0x99, 38, 110, ...vlq(24), 38, 0, 0, 0xff, 0x2f, 0];
  const file = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, 0, ppq, ...trk(conductor), ...trk(bass), ...trk(drums)];
  const f = parseMidi(new Uint8Array(file));
  check(f.format === 1 && f.bpm === 120, "format 1 at 120 BPM");
  check(f.parts.length === 2, "two parts with notes (the conductor track has none): " + f.parts.map((p) => p.name).join(", "));
  const bassPart = f.parts.find((p) => p.name === "Bass");
  check(bassPart && JSON.stringify(bassPart.notes.map((n) => [n.p, n.t, n.d])) === JSON.stringify([[40, 0, 1], [43, 1, 0.5]]), "running status and velocity-0 note-offs");
  const dr = f.parts.find((p) => p.channel === 9);
  check(dr && dr.notes.length === 2, "the drum part on channel 10");
  const mapped = toDrumRack(dr.notes, 9);
  check(mapped[0].p === 36 && mapped[1].p === 37, "General MIDI kick and snare land on pads 1 and 2: " + mapped.map((n) => n.p));
}

console.log("not MIDI");
{
  let threw = false;
  try { parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); } catch (_) { threw = true; }
  check(threw, "a file that isn't MIDI is refused");
}

console.log("damaged files");
{
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 12];
  // a meta event whose length runs to five bytes (it overflowed to a negative number: the reader went backwards, for ever)
  const t0 = Date.now();
  const a = parseMidi(new Uint8Array([...head, 0, 0xff, 0x03, 0xff, 0xff, 0xff, 0xff, 0x78, 0x41, 0, 0xff, 0x2f, 0]));
  check(a && Array.isArray(a.parts) && Date.now() - t0 < 500, "a meta length that overflows: read to the end, at once");
  // a track name said to be 200 MB long in a 31-byte file
  const t1 = Date.now();
  const b = parseMidi(new Uint8Array([...head, 0, 0xff, 0x03, 0xdf, 0xad, 0xe2, 0x00, 0x41, 0x42, 0, 0xff, 0x2f, 0]));
  check(b && Date.now() - t1 < 500, "a length far past the file's end: the file's end");
  let threw = 0, hung = 0, seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 3000; i++) {
    const n = 4 + Math.floor(rnd() * 24), body = Array.from({ length: n }, () => Math.floor(rnd() * 256));
    const start = Date.now();
    try { parseMidi(new Uint8Array([...head.slice(0, 21), n, ...body])); } catch (_) { threw++; }
    if (Date.now() - start > 200) hung++;
  }
  check(hung === 0, "3000 random tracks: none hangs (" + threw + " refused with an error)");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
