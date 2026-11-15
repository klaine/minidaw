// What a drum sample sounds like, for the automatic kit builder when its name says nothing ("Sample 041.wav"): how
// much of it is low end, how much is bright, how noisy it is, how long it rings, where it starts and how loud it peaks.
// A sound's role (js/kitmap.js ROLES) follows from those in a few plain rules: a heuristic, as a producer sorting by ear
// would start, not a trained classifier. Pure functions on Float32Arrays, so they run in node's tests as in the page.

const DB30 = Math.pow(10, -30 / 20);

/** Two one-pole low-passes in a row at fc: a gentle 12 dB / octave */
function lowpass(x, rate, fc) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / rate);
  const y = new Float32Array(x.length);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { s1 += a * (x[i] - s1); s2 += a * (s1 - s2); y[i] = s2; }
  return y;
}
const energy = (x) => { let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return e; };

/**
 * channels: [Float32Array], rate -> { length, peak, lead, dur, attack, low, high, zcr, tonal, f0 } (seconds, ratios of
 * energy, crossings per second, 0..1, Hz), or null for silence. lead: where the sound starts (its first sample above -30 dB of its peak, less 1 ms).
 * dur: how long it rings above -30 dB of its loudest 5 ms. The spectrum is measured over its first 250 ms.
 */
export function soundFeatures(channels, rate) {
  const n = channels[0].length;
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < n; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
  if (peak < 1e-4) return null;
  let on = 0;
  while (on < n && Math.abs(mono[on]) < peak * DB30) on++;
  const lead = Math.max(0, on - Math.round(rate * 0.001)) / rate;
  const win = Math.max(1, Math.round(rate * 0.005));
  let top = 0, last = on, at = 0;
  const rms = [];
  for (let i = on; i < n; i += win) {
    let e = 0;
    const end = Math.min(n, i + win);
    for (let j = i; j < end; j++) e += mono[j] * mono[j];
    const r = Math.sqrt(e / (end - i));
    rms.push(r);
    if (r > top) { top = r; at = rms.length - 1; }
  }
  rms.forEach((r, k) => { if (r > top * DB30) last = on + (k + 1) * win; });
  const dur = Math.min(n, last) / rate - on / rate;
  const seg = mono.subarray(on, Math.min(n, on + Math.round(rate * Math.min(0.25, Math.max(0.02, dur)))));
  const total = energy(seg) || 1e-12;
  const low = energy(lowpass(seg, rate, 100)) / total;
  const lp = lowpass(seg, rate, 5000);
  const hp = new Float32Array(seg.length);
  for (let i = 0; i < seg.length; i++) hp[i] = seg[i] - lp[i];
  const high = energy(hp) / total;
  let zc = 0;
  for (let i = 1; i < seg.length; i++) if ((seg[i - 1] < 0) !== (seg[i] < 0)) zc++;
  const zcr = zc / (seg.length / rate);
  return { length: n / rate, peak, lead, dur, attack: (at * win) / rate, low, high, zcr, tonal: periodicity(seg, rate), f0: zcr / 2, bursts: bursts(mono, on, rate) };
}

/**
 * How periodic a sound's start is: 0 for noise to 1 for a pure tone (the best normalized autocorrelation over its first
 * 1024 samples after 2 ms, past the lag where it first turns negative, up to a 40 Hz period).
 */
function periodicity(seg, rate) {
  const a0 = Math.min(seg.length - 1, Math.round(rate * 0.002));
  const x = seg.subarray(a0, Math.min(seg.length, a0 + 2048));
  const N = Math.min(1024, x.length >> 1);
  if (N < 32) return 0;
  let e0 = 0;
  for (let i = 0; i < N; i++) e0 += x[i] * x[i];
  const hi = Math.min(x.length - N, Math.ceil(rate / 40));
  let best = 0, crossed = false;
  for (let L = 1; L <= hi; L++) {
    let c = 0, e1 = 0;
    for (let i = 0; i < N; i++) { c += x[i] * x[i + L]; e1 += x[i + L] * x[i + L]; }
    const r = c / Math.sqrt(e0 * e1 || 1e-12);
    if (!crossed) { if (r < 0) crossed = true; continue; }
    if (r > best) best = r;
  }
  return best;
}

/** How many times its loudness falls by half and comes back in its first 60 ms (a clap's hands: 3 or 4; a snare: 1) */
function bursts(x, on, rate) {
  const w = Math.max(1, Math.round(rate * 0.001));
  let count = 1, hi = 0, lo = Infinity, falling = false;
  for (let i = on; i < Math.min(x.length, on + rate * 0.06); i += w) {
    let e = 0;
    for (let j = i; j < i + w && j < x.length; j++) e += x[j] * x[j];
    const r = Math.sqrt(e / w);
    if (!falling) { if (r > hi) hi = r; else if (r < hi * 0.5) { falling = true; lo = r; } }
    else if (r < lo) lo = r;
    else if (r > lo * 2 && r > hi * 0.4) { count++; falling = false; hi = r; }
  }
  return count;
}

/** The role a sound's features point to (one of ROLES), or null */
export function roleOfSound(f) {
  if (!f || f.dur < 0.005) return null;
  if (f.low > 0.4 || (f.low > 0.2 && f.f0 < 75)) return f.dur > 0.6 ? "sub" : "kick";
  const noisy = f.tonal < 0.6 || f.zcr > 8000;
  if (noisy && f.attack > 0.06) return "shaker"; // a noise that swells
  if (noisy && (f.high > 0.5 || (f.high > 0.35 && f.dur > 0.9))) return f.dur < 0.2 ? "hat" : f.dur < 0.9 ? "openhat" : f.high > 0.6 ? "crash" : "ride";
  if (noisy && f.zcr > 2500) return f.bursts >= 3 ? "clap" : f.dur < 0.5 ? "snare" : "shaker";
  if (noisy) return "perc";
  // tonal: by its pitch (half its zero crossings: near enough for a drum's tone)
  if (f.f0 < 300) return f.f0 < 110 ? "tomlo" : f.f0 < 170 ? "tommid" : "tomhi";
  if (f.dur < 0.08) return f.tonal > 0.97 ? "clave" : "rim";
  if (f.f0 < 1200) return "cowbell";
  return "perc";
}

/** An AudioBuffer's features (the same, from its channels) */
export function bufferFeatures(b) {
  const chans = [];
  for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c));
  return soundFeatures(chans, b.sampleRate);
}

const QUIETER = new Set(["hat", "openhat", "ride", "crash", "shaker"]);
/**
 * A pad tidied from its sound's features: the silence before it trimmed off (start), and its level evened out with the
 * other pads' (gain: every pad peaks at -1 dB at full velocity, the cymbals and shakers 4 dB lower).
 */
export function tidyPad(f, role) {
  const length = f && f.length;
  if (!f || !f.peak) return {};
  const target = Math.pow(10, (-1 - (QUIETER.has(role) ? 4 : 0)) / 20);
  const gain = Math.min(1.25, Math.max(0.05, target / (f.peak * 1.25)));
  const start = length > 0 && f.lead > 0.002 ? Math.min(0.9, f.lead / length) : 0;
  return { gain: Math.round(gain * 1000) / 1000, start: Math.round(start * 10000) / 10000 };
}
