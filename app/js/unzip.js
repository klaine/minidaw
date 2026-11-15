// Reading zip files in the browser (a sample folder zipped in the iPad's Files app keeps its folders): the central
// directory, then each entry stored or deflated (DecompressionStream "deflate-raw"). No Zip64, no encryption.

/** -> [{ path, bytes: Uint8Array }] for every file (folders, macOS resource forks and dotfiles left out) */
export async function unzip(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // the end of central directory record: the last PK\5\6 within the trailing 64 kB comment window
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  if (at === 0xffffffff || count === 0xffff) throw new Error("Zip64 files aren't supported");
  const out = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(at, true) !== 0x02014b50) throw new Error("a damaged zip (central directory)");
    const flags = dv.getUint16(at + 8, true), method = dv.getUint16(at + 10, true);
    const csize = dv.getUint32(at + 20, true), usize = dv.getUint32(at + 24, true);
    const nlen = dv.getUint16(at + 28, true), xlen = dv.getUint16(at + 30, true), clen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const nameBytes = b.subarray(at + 46, at + 46 + nlen);
    const path = (flags & 0x800) ? dec.decode(nameBytes) : latin(nameBytes);
    at += 46 + nlen + xlen + clen;
    if (path.endsWith("/") || skip(path)) continue;
    if (flags & 1) throw new Error(path + " is encrypted");
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error("a damaged zip (" + path + ")");
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = b.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = raw.slice();
    else if (method === 8) bytes = await inflate(raw);
    else throw new Error(path + ": compression method " + method + " isn't supported");
    if (bytes.length !== usize) throw new Error(path + ": unpacked to the wrong size");
    out.push({ path, bytes });
  }
  return out;
}

const skip = (p) => p.startsWith("__MACOSX/") || p.split("/").some((part) => part.startsWith("."));
const latin = (u8) => { let s = ""; for (const c of u8) s += String.fromCharCode(c); return s; };

async function inflate(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
