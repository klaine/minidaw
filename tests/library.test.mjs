// node tests/library.test.mjs: zip reading (stored and deflated entries, folders kept), naming drums from their file
// names and folders, and kits built from sample sets.
import { deflateRawSync } from "node:zlib";
import { unzip } from "../app/js/unzip.js";
import { classify, buildKit, ROLES } from "../app/js/kitmap.js";

let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log("  FAIL " + what); } else console.log("  ok   " + what); };

/** A zip written here, independently of the reader: [{path, bytes, deflate}] */
function makeZip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (u) => { let c = 0xffffffff; for (const x of u) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunks = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const data = f.deflate ? deflateRawSync(f.bytes) : Buffer.from(f.bytes);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x800, 6); loc.writeUInt16LE(f.deflate ? 8 : 0, 8);
    loc.writeUInt32LE(crc(f.bytes), 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(f.bytes.length, 22); loc.writeUInt16LE(name.length, 26);
    chunks.push(loc, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(f.deflate ? 8 : 0, 10);
    cen.writeUInt32LE(crc(f.bytes), 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(f.bytes.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(off, 42);
    central.push(cen, name);
    off += 30 + name.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

console.log("zip");
{
  const big = new Uint8Array(5000).map((_, i) => (i * 7) % 13);
  const zip = makeZip([
    { path: "Kit/", bytes: new Uint8Array(0) },
    { path: "Kit/Kicks/BD 01.wav", bytes: new Uint8Array([1, 2, 3, 4]) },
    { path: "Kit/Hats/Open Hat.wav", bytes: big, deflate: true },
    { path: "__MACOSX/Kit/._BD 01.wav", bytes: new Uint8Array([9]) },
    { path: "Kit/.DS_Store", bytes: new Uint8Array([9]) },
  ]);
  const files = await unzip(zip);
  check(JSON.stringify(files.map((f) => f.path)) === JSON.stringify(["Kit/Kicks/BD 01.wav", "Kit/Hats/Open Hat.wav"]), "the files with their folders, no folder entries or macOS litter: " + files.map((f) => f.path));
  check(files[0].bytes.join() === "1,2,3,4", "a stored file");
  check(files[1].bytes.length === 5000 && files[1].bytes.every((v, i) => v === (i * 7) % 13), "a deflated file");
  let threw = false;
  try { await unzip(new Uint8Array(100)); } catch (_) { threw = true; }
  check(threw, "not a zip: refused");
}

console.log("naming drums");
{
  const cases = {
    "Kicks/BD_Punchy.wav": "kick", "808 Long.wav": "sub", "SD 03.wav": "snare", "Snare Rim.wav": "rim", "OHH 2.wav": "openhat",
    "Hats/Closed 01.wav": "hat", "Hats/Open 01.wav": "openhat", "HiHat Closed.aif": "hat", "Clap Big.wav": "clap",
    "Toms/Tom Low.wav": "tomlo", "Tom Hi.wav": "tomhi", "Tom 2.wav": "tommid", "Crash 18.wav": "crash", "Ride Bell.wav": "ride",
    "Shaker.wav": "shaker", "Tambourine.wav": "shaker", "Cowbell.wav": "cowbell", "Clave.wav": "clave", "Perc/Conga.wav": "perc",
    "Woodblock.wav": "clave", "Vocal Hey.wav": null,
  };
  const wrong = Object.entries(cases).filter(([p, r]) => classify(p) !== r).map(([p, r]) => `${p}: ${classify(p)} (want ${r})`);
  check(!wrong.length, "file names and folders name the drums" + (wrong.length ? ": " + wrong.join("; ") : ""));
}

console.log("building a kit");
{
  const names = ["Kicks/Kick 10.wav", "Kicks/Kick 2.wav", "Snares/Snare A.wav", "Hats/CH.wav", "Hats/OH.wav", "Claps/Clap.wav",
    "Toms/Tom 1.wav", "Toms/Tom 3.wav", "Perc/Shaker.wav", "FX/Riser.wav", "FX/Laser.wav", "Cymbals/Crash.wav"];
  const samples = names.map((p, i) => ({ id: "s" + i, name: p.split("/").pop().replace(".wav", ""), path: p }));
  const kit = buildKit(samples);
  const at = (role) => kit[ROLES.indexOf(role)] && kit[ROLES.indexOf(role)].name;
  check(at("kick") === "Kick 2", "pad 1: the first kick in natural order (Kick 2 before Kick 10): " + at("kick"));
  check(at("snare") === "Snare A" && at("hat") === "CH" && at("openhat") === "OH" && at("clap") === "Clap", "snare, hats, clap on their pads");
  check(at("tomlo") === "Tom 1" && at("tomhi") === "Tom 3", "toms by height: " + at("tomlo") + ", " + at("tomhi"));
  check(at("crash") === "Crash" && at("shaker") === "Shaker", "crash and shaker");
  check(at("sub") === "Kick 10", "the 808 pad gets the second kick");
  const placed = kit.filter(Boolean).map((p) => p.id);
  check(placed.length === 12 && new Set(placed).size === 12, "every sample on one pad (" + placed.length + ")");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
