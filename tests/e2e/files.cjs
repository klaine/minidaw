// Files for the user flows, made here (not by the app): a WAV, a MIDI file, and a WAV reader for exports.

/** A 16-bit mono WAV: a decaying sine */
function makeWav({ freq = 440, seconds = 0.3, rate = 44100 } = {}) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * Math.exp(-i / (rate * seconds * 0.4)) * 26000), 44 + i * 2);
  return b;
}

/** A format 1 MIDI file: a "Keys" part (channel 1) and a "Beat" part on channel 10 (General MIDI kick, snare, hat) */
function makeMidi() {
  const vlq = (v) => { const o = [v & 0x7f]; while ((v >>= 7)) o.unshift((v & 0x7f) | 0x80); return o; };
  const name = (s) => [0, 0xff, 0x03, s.length, ...Buffer.from(s)];
  const trk = (bytes) => { const len = bytes.length; return [0x4d, 0x54, 0x72, 0x6b, len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...bytes]; };
  const ppq = 96;
  const keys = [...name("Keys")];
  [60, 64, 67, 72].forEach((n, i) => keys.push(...vlq(i ? 0 : 0), 0x90, n, 100, ...vlq(ppq), 0x80, n, 0));
  keys.push(0, 0xff, 0x2f, 0);
  const beat = [...name("Beat")];
  const hits = [[36, 0], [42, 48], [38, 96], [42, 144], [36, 192], [42, 240], [38, 288], [42, 336]];
  let last = 0;
  for (const [n, t] of hits) { beat.push(...vlq(t - last), 0x99, n, 110, ...vlq(24), 0x89, n, 0); last = t + 24; }
  beat.push(0, 0xff, 0x2f, 0);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0, ppq];
  return Buffer.from([...head, ...trk(keys), ...trk(beat)]);
}

/** A PCM / float WAV: { rate, channels, frames, sample(ch, i), rms(t0, t1), peak() } */
function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4), len = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === "data") data = { at: pos + 8, len };
    pos += 8 + len + (len & 1);
  }
  const bps = fmt.bits / 8, frames = Math.floor(data.len / (bps * fmt.channels));
  const sample = (ch, i) => {
    const o = data.at + (i * fmt.channels + ch) * bps;
    if (fmt.format === 3) return buf.readFloatLE(o);
    if (fmt.bits === 16) return buf.readInt16LE(o) / 32768;
    if (fmt.bits === 24) return buf.readIntLE(o, 3) / 8388608;
    throw new Error("bits " + fmt.bits);
  };
  return {
    rate: fmt.rate, channels: fmt.channels, frames, sample,
    rms(t0, t1) {
      let s = 0, n = 0;
      for (let i = Math.floor(t0 * fmt.rate); i < Math.min(frames, Math.floor(t1 * fmt.rate)); i++) for (let c = 0; c < fmt.channels; c++) { const v = sample(c, i); s += v * v; n++; }
      return Math.sqrt(s / Math.max(1, n));
    },
    peak() { let m = 0; for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) m = Math.max(m, Math.abs(sample(c, i))); return m; },
  };
}

/** A zip of files ([{ path, bytes }]), deflated: written here, not by the app */
function makeZip(files) {
  const zlib = require("zlib");
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (u) => { let c = 0xffffffff; for (const x of u) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunks = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8"), data = zlib.deflateRawSync(f.bytes);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc(f.bytes), 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(f.bytes.length, 22); loc.writeUInt16LE(name.length, 26);
    chunks.push(loc, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc(f.bytes), 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(f.bytes.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(off, 42);
    central.push(cen, name);
    off += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

/** A sample folder as a producer's might be: subfolders by drum, plus a file that isn't audio */
const KIT_FILES = [
  ["Kicks/Kick 01.wav", 55], ["Kicks/Kick 02.wav", 48], ["Snares/Snare Tight.wav", 190], ["Hats/Closed Hat.wav", 6000],
  ["Hats/Open Hat.wav", 5200], ["Claps/Clap 02.wav", 1100], ["Perc/Conga.wav", 300], ["Perc/Shaker Loop.wav", 7000],
];
function kitFiles() {
  return [...KIT_FILES.map(([path, freq]) => ({ path, bytes: makeWav({ freq, seconds: 0.25 }) })), { path: "readme.txt", bytes: Buffer.from("not a sample") }];
}
/** The kit folder on disk at dir/<name> (for a folder picker) */
function writeKitFolder(dir, name) {
  const fs = require("fs"), path = require("path");
  const root = path.join(dir, name);
  fs.rmSync(root, { recursive: true, force: true });
  for (const f of kitFiles()) { const p = path.join(root, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.bytes); }
  return root;
}

module.exports = { makeWav, makeMidi, readWav, makeZip, kitFiles, writeKitFolder };
