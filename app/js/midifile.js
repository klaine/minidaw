// Standard MIDI Files: read (format 0, 1 and 2) into parts of notes in beats, and write a clip as format 0.
//
// parseMidi(bytes) -> { format, ppq, bpm, sig, parts: [{ name, channel, track, notes: [{p, t, d, v}], end }] }
// A part is the notes of one channel in one track (a format 0 file's channels become parts of their own). Times are
// in beats (quarter notes): tempo changes don't move notes in beats, so the file's first tempo is only reported.

export function parseMidi(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pos = 0;
  const str = (n) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(b[pos + i]); return s; };
  const u32 = () => { const v = (b[pos] << 24 | b[pos + 1] << 16 | b[pos + 2] << 8 | b[pos + 3]) >>> 0; pos += 4; return v; };
  const u16 = () => { const v = b[pos] << 8 | b[pos + 1]; pos += 2; return v; };
  // a RIFF-wrapped file (.rmi): its data chunk is the MIDI file
  if (str(4) === "RIFF") {
    const at = indexOf(b, [0x4d, 0x54, 0x68, 0x64]);
    if (at < 0) throw new Error("no MIDI data in this RIFF file");
    pos = at;
  }
  if (str(4) !== "MThd") throw new Error("not a MIDI file");
  pos += 4;
  const hlen = u32();
  const format = u16(), ntracks = u16(), division = u16();
  pos += hlen - 6;
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI files aren't supported");
  const ppq = division || 96;
  let bpm = null, sig = null;
  const parts = new Map(); // "track:channel" -> part
  const names = [];
  for (let tr = 0; tr < ntracks && pos + 8 <= b.length; tr++) {
    const id = str(4); pos += 4;
    const len = u32();
    const end = Math.min(b.length, pos + len);
    if (id !== "MTrk") { pos = end; continue; }
    let tick = 0, status = 0, name = "";
    const open = new Map(); // ch<<8|note -> [{tick, vel}]
    const partOf = (ch) => {
      const key = (format === 0 ? 0 : tr) + ":" + ch;
      if (!parts.has(key)) parts.set(key, { name: "", channel: ch, track: tr, notes: [], end: 0 });
      return parts.get(key);
    };
    const close = (ch, note, at) => {
      const k = ch << 8 | note, list = open.get(k);
      if (!list || !list.length) return;
      const on = list.shift(); // first in, first out: overlapping notes of a pitch end in order
      const part = partOf(ch);
      part.notes.push({ p: note, t: on.tick / ppq, d: Math.max(1, at - on.tick) / ppq, v: on.vel });
    };
    while (pos < end) {
      tick += vlq();
      let s = b[pos];
      if (s & 0x80) { pos++; if (s < 0xf0) status = s; }
      else s = status; // running status
      if (s === 0xff) {
        const type = b[pos++], n = vlq(), at = pos;
        if (type === 0x03 && !name) name = text(b, at, n);
        else if (type === 0x51 && bpm === null && n >= 3) bpm = 60000000 / (b[at] << 16 | b[at + 1] << 8 | b[at + 2]);
        else if (type === 0x58 && sig === null && n >= 2) sig = [b[at], 1 << b[at + 1]];
        pos = at + n;
      } else if (s === 0xf0 || s === 0xf7) {
        const n = vlq(); pos += n;
      } else {
        const type = s & 0xf0, ch = s & 15;
        const d1 = b[pos++], d2 = type === 0xc0 || type === 0xd0 ? 0 : b[pos++];
        if (type === 0x90 && d2 > 0) {
          const k = ch << 8 | d1;
          if (!open.has(k)) open.set(k, []);
          open.get(k).push({ tick, vel: d2 });
          partOf(ch);
        } else if (type === 0x80 || type === 0x90) close(ch, d1, tick);
      }
    }
    // notes never released end with the track
    for (const [k, list] of open) while (list.length) close(k >> 8, k & 255, tick);
    for (const part of parts.values()) if (part.track === (format === 0 ? 0 : tr)) part.end = Math.max(part.end, tick / ppq);
    names[tr] = name;
    pos = end;
  }
  const out = [];
  for (const part of parts.values()) {
    if (!part.notes.length) continue;
    part.notes.sort((x, y) => x.t - y.t || x.p - y.p);
    part.name = names[part.track] || (part.channel === 9 ? "Drums" : "Channel " + (part.channel + 1));
    out.push(part);
  }
  // several channels in one track get their channel in the name
  for (const p of out) if (out.some((q) => q !== p && q.track === p.track)) p.name += ` (ch ${p.channel + 1})`;
  return { format, ppq, bpm: bpm ? Math.round(bpm * 100) / 100 : null, sig, parts: out };

  function vlq() {
    let v = 0, c;
    do { c = b[pos++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80 && pos < b.length);
    return v;
  }
}

function text(b, at, n) { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i]); return s.replace(/\0/g, "").trim(); }
function indexOf(b, pat) {
  outer: for (let i = 0; i + pat.length <= b.length; i++) { for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer; return i; }
  return -1;
}

// General MIDI drum notes -> the Drum Rack's default kit (pads 1-16 on notes 36-51; js/model.js BUILTIN_KIT)
const GM_TO_PAD = {
  35: 0, 36: 0, 38: 1, 40: 1, 37: 8, 39: 4, 42: 2, 44: 2, 46: 3, 41: 5, 43: 5, 45: 6, 47: 6, 48: 7, 50: 7,
  49: 10, 52: 10, 55: 10, 57: 10, 51: 11, 53: 11, 59: 11, 56: 9, 54: 12, 69: 12, 70: 12, 82: 12, 75: 13, 76: 13, 77: 13,
  60: 7, 61: 6, 62: 15, 63: 15, 64: 5, 65: 15, 66: 15, 67: 9, 68: 9, 71: 15, 72: 15, 73: 13, 74: 13, 78: 15, 79: 15,
  80: 13, 81: 13, 58: 15,
};

/** Notes for a Drum Rack: General MIDI drums (channel 10, or notes outside the pads) mapped onto the default kit */
export function toDrumRack(notes, channel, base = 36) {
  const inPads = notes.every((n) => n.p >= base && n.p < base + 16);
  if (channel !== 9 && inPads) return notes;
  return notes.map((n) => ({ ...n, p: base + (GM_TO_PAD[n.p] ?? (((n.p - base) % 16) + 16) % 16) }));
}

/** A clip's notes as a format 0 file (one track; channel 10 for a Drum Rack's) */
export function writeMidi(clip, { bpm = 120, name = "", ppq = 480, channel = 0, sig = 4 } = {}) {
  const ev = [];
  for (const n of clip.notes) {
    if (n.mute) continue;
    const on = Math.round(n.t * ppq), off = Math.max(on + 1, Math.round((n.t + n.d) * ppq));
    ev.push([on, 1, [0x90 | channel, n.p & 127, Math.max(1, Math.min(127, n.v | 0))]]);
    ev.push([off, 0, [0x80 | channel, n.p & 127, 0]]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // offs before ons at the same tick
  const data = [];
  const vlq = (v) => { const out = [v & 0x7f]; while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80); data.push(...out); };
  const meta = (type, bytes) => { vlq(0); data.push(0xff, type); vlq(bytes.length); data.push(...bytes); };
  if (name) meta(0x03, [...name].map((c) => c.charCodeAt(0) & 0x7f));
  const us = Math.round(60000000 / bpm);
  meta(0x51, [us >> 16 & 255, us >> 8 & 255, us & 255]);
  meta(0x58, [sig, 2, 24, 8]);
  let last = 0;
  for (const [tick, , bytes] of ev) { vlq(tick - last); data.push(...bytes); last = tick; }
  const endTick = Math.max(last, Math.round(clip.length * ppq));
  vlq(endTick - last); data.push(0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 255];
  const len = data.length;
  return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, len >>> 24 & 255, len >> 16 & 255, len >> 8 & 255, len & 255, ...data]);
}

export const isMidiFile = (f) => /\.(mid|midi|smf|kar|rmi)$/i.test(f.name || "") || /midi/.test(f.type || "");
export const isAudioFile = (f) => /^audio\//.test(f.type || "") && !isMidiFile(f) || /\.(wav|aiff?|mp3|m4a|aac|flac|ogg|caf|opus)$/i.test(f.name || "");
