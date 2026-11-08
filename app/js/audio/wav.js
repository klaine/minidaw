// WAV files: 16- or 24-bit PCM, or 32-bit float.

export function encodeWav(channels, sampleRate, bits = 16) {
  const n = channels[0].length, nc = channels.length;
  const float = bits === 32;
  const bps = bits / 8;
  const dataLen = n * nc * bps;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nc * bps, true); v.setUint16(32, nc * bps, true);
  v.setUint16(34, bits, true);
  str(36, "data"); v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      let x = channels[c][i];
      if (x !== x) x = 0; // NaN
      if (float) { v.setFloat32(o, x, true); o += 4; continue; }
      x = x < -1 ? -1 : x > 1 ? 1 : x;
      if (bits === 16) { v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2; }
      else {
        const s = Math.round(x < 0 ? x * 8388608 : x * 8388607);
        v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
      }
    }
  }
  return buf;
}

export function bufferChannels(audioBuffer) {
  const out = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) out.push(audioBuffer.getChannelData(c));
  return out;
}

/** Peak level of some channels (0..1+) */
export function peakOf(channels) {
  let m = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > m) m = a; }
  return m;
}
