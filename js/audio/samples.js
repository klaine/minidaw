// Samples: the built-in kit and loops (synthesized here, so nothing third-party ships), and the user's own files (kept
// as their bytes in IndexedDB, decoded once). AudioBuffers aren't tied to a context: the offline export uses them too.
import { db } from "../db.js";
import { uid } from "../util.js";

export const SR = 44100;

// ---- a little DSP for the kit ----
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; }; }
const expEnv = (t, tau) => Math.exp(-t / tau);
function onePoleLP(x, fc) { const a = 1 - Math.exp(-2 * Math.PI * fc / SR); let y = 0; for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; } return x; }
function onePoleHP(x, fc) { const a = Math.exp(-2 * Math.PI * fc / SR); let px = 0, py = 0; for (let i = 0; i < x.length; i++) { const y = a * (py + x[i] - px); px = x[i]; py = y; x[i] = y; } return x; }
function bandpass(x, f, q) {
  const w = 2 * Math.PI * f / SR, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y; }
  return x;
}
function normalize(x, peak = 0.9) { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m; return x; }
const buf = (sec) => new Float32Array(Math.ceil(sec * SR));
function metal(n, freqs, seedOffset = 0) {
  const x = new Float32Array(n), ph = freqs.map((_, i) => i * 0.13 + seedOffset);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < freqs.length; k++) { ph[k] += freqs[k] / SR; s += (ph[k] % 1) < 0.5 ? 1 : -1; } x[i] = s / freqs.length; }
  return x;
}
const HAT_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.7);

const KIT = {
  kick() { const x = buf(0.6); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR; const f = 45 + 110 * expEnv(t, 0.035); ph += f / SR; x[i] = Math.sin(2 * Math.PI * ph) * expEnv(t, 0.22) + (t < 0.004 ? 0.4 * (1 - t / 0.004) : 0); x[i] = Math.tanh(x[i] * 1.6); } return normalize(x); },
  snare() { const x = buf(0.35), r = rng(7), n = new Float32Array(x.length); for (let i = 0; i < n.length; i++) n[i] = r(); onePoleHP(n, 1500); for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = (Math.sin(2 * Math.PI * 185 * t) * 0.6 + Math.sin(2 * Math.PI * 330 * t) * 0.3) * expEnv(t, 0.05) + n[i] * expEnv(t, 0.09) * 0.9; } return normalize(x); },
  hat() { const x = buf(0.12), m = metal(x.length, HAT_FREQS), r = rng(3); for (let i = 0; i < x.length; i++) x[i] = (m[i] * 0.6 + r() * 0.4); onePoleHP(x, 7000); for (let i = 0; i < x.length; i++) x[i] *= expEnv(i / SR, 0.025); return normalize(x, 0.7); },
  openhat() { const x = buf(0.7), m = metal(x.length, HAT_FREQS), r = rng(4); for (let i = 0; i < x.length; i++) x[i] = (m[i] * 0.6 + r() * 0.4); onePoleHP(x, 6500); for (let i = 0; i < x.length; i++) x[i] *= expEnv(i / SR, 0.18); return normalize(x, 0.7); },
  clap() { const x = buf(0.4), r = rng(11); for (let i = 0; i < x.length; i++) { const t = i / SR; let e = 0; for (const o of [0, 0.011, 0.022]) if (t >= o) e = Math.max(e, expEnv(t - o, 0.006)); if (t >= 0.03) e = Math.max(e, 0.7 * expEnv(t - 0.03, 0.09)); x[i] = r() * e; } bandpass(x, 1200, 1.2); return normalize(x); },
  tomlo() { return tom(95); }, tommid() { return tom(135); }, tomhi() { return tom(190); },
  rim() { const x = buf(0.08), r = rng(5); for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = (Math.sin(2 * Math.PI * 1700 * t) * 0.6 + Math.sin(2 * Math.PI * 520 * t) * 0.5 + r() * 0.3) * expEnv(t, 0.012); } return normalize(x, 0.8); },
  cowbell() { const x = buf(0.5), m = metal(x.length, [540, 800]); for (let i = 0; i < x.length; i++) x[i] = m[i] * (0.6 * expEnv(i / SR, 0.03) + 0.4 * expEnv(i / SR, 0.18)); bandpass(x, 900, 1.5); return normalize(x, 0.8); },
  crash() { const x = buf(2.0), m = metal(x.length, HAT_FREQS.map((f) => f * 0.8), 0.3), r = rng(9); for (let i = 0; i < x.length; i++) x[i] = m[i] * 0.4 + r() * 0.6; onePoleHP(x, 4000); for (let i = 0; i < x.length; i++) x[i] *= expEnv(i / SR, 0.55) * Math.min(1, i / (SR * 0.002)); return normalize(x, 0.7); },
  ride() { const x = buf(1.6), m = metal(x.length, [310, 457, 523, 694, 915, 1123].map((f) => f * 2.1)), r = rng(10); for (let i = 0; i < x.length; i++) x[i] = m[i] * 0.7 + r() * 0.15; onePoleHP(x, 3000); for (let i = 0; i < x.length; i++) x[i] *= 0.5 * expEnv(i / SR, 0.03) + 0.5 * expEnv(i / SR, 0.5); return normalize(x, 0.6); },
  shaker() { const x = buf(0.15), r = rng(12); for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = r() * Math.min(1, t / 0.012) * expEnv(Math.max(0, t - 0.012), 0.035); } onePoleHP(x, 5000); return normalize(x, 0.6); },
  clave() { const x = buf(0.1); for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = Math.sin(2 * Math.PI * 2500 * t) * expEnv(t, 0.018); } return normalize(x, 0.8); },
  sub() { const x = buf(1.6); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR; ph += (50 + 25 * expEnv(t, 0.04)) / SR; x[i] = Math.tanh(1.8 * Math.sin(2 * Math.PI * ph)) * expEnv(t, 0.55); } return normalize(x); },
  zap() { const x = buf(0.25); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR; ph += (80 + 2400 * expEnv(t, 0.025)) / SR; x[i] = Math.sin(2 * Math.PI * ph) * expEnv(t, 0.07); } return normalize(x, 0.8); },
};
function tom(f0) { const x = buf(0.6), r = rng(f0); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / SR; ph += f0 * (1 + 0.6 * expEnv(t, 0.04)) / SR; x[i] = Math.sin(2 * Math.PI * ph) * expEnv(t, 0.2) + r() * 0.15 * expEnv(t, 0.01); } return normalize(x); }

// Built-in loops: the kit played from patterns (k kick, s snare, h hat, o open hat, c clap, r rim, t shaker)
const LOOPS = {
  "loop-house": { name: "House Beat 124", bpm: 124, bars: 2, steps: 16, rows: {
    kick: "x...x...x...x...x...x...x...x...", openhat: "..x...x...x...x...x...x...x...x.",
    clap: "....x.......x.......x.......x...", hat: "x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.xx", shaker: ".x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x" } },
  "loop-break": { name: "Breakbeat 96", bpm: 96, bars: 2, steps: 16, rows: {
    kick: "x.x.......x.....x.x.....x..x....", snare: "....x..x.x..x.......x..x....x..x",
    hat: "x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.", openhat: "..............x...............x." } },
  "loop-hiphop": { name: "Boom Bap 88", bpm: 88, bars: 2, steps: 16, rows: {
    kick: "x......x..x.....x.....x...x.....", snare: "....x.......x.......x.......x...",
    hat: "x.x.x.x.x.x.xxx.x.x.x.x.x.x.x.xx", rim: "..........x...............x....." } },
  "loop-tops": { name: "Percussion Tops 120", bpm: 120, bars: 1, steps: 16, rows: {
    shaker: "xxxxxxxxxxxxxxxx", cowbell: "..x.....x.x.....", clave: "x..x..x...x..x..", tommid: ".......x.......x" } },
};

export const BUILTIN_SAMPLES = [
  ...Object.keys(KIT).map((k) => ({ id: "builtin:" + k, name: k[0].toUpperCase() + k.slice(1), kind: "oneshot" })),
  ...Object.entries(LOOPS).map(([k, l]) => ({ id: "builtin:" + k, name: l.name, kind: "loop", bpm: l.bpm })),
];

function makeBuffer(channels) {
  const b = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate: SR });
  channels.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}

function renderLoop(def, kit) {
  const stepSec = 60 / def.bpm / 4;
  const steps = def.bars * def.steps;
  const len = Math.round(steps * stepSec * SR);
  const L = new Float32Array(len), R = new Float32Array(len);
  const pans = { kick: 0, snare: 0, clap: 0.1, hat: -0.3, openhat: 0.3, shaker: 0.35, rim: -0.2, cowbell: -0.4, clave: 0.4, tommid: -0.2 };
  for (const [inst, row] of Object.entries(def.rows)) {
    const s = kit(inst), pan = pans[inst] || 0, gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < steps; i++) {
      const ch = row[i % row.length];
      if (ch === ".") continue;
      const at = Math.round(i * stepSec * SR) + (i % 2 ? Math.round(0.012 * SR * (def.bpm < 100 ? 1 : 0)) : 0); // a little swing on slow loops
      const g = ch === "X" ? 1 : 0.7 + 0.25 * ((i % 4) === 0);
      for (let j = 0; j < s.length; j++) { const k = (at + j) % len; L[k] += s[j] * g * gl * 0.5; R[k] += s[j] * g * gr * 0.5; }
    }
  }
  normalize(L, 0.85); normalize(R, 0.85);
  return [L, R];
}

export class SampleBank {
  constructor() {
    this.buffers = new Map(); // id -> AudioBuffer
    this.info = new Map();    // id -> {name, bpm?}
    this.loading = new Map();
    this.peaksCache = new Map();
    for (const s of BUILTIN_SAMPLES) this.info.set(s.id, s);
  }

  has(id) { return this.buffers.has(id); }
  buffer(id) { return this.buffers.get(id) || null; }
  name(id) { return (this.info.get(id) || {}).name || "Sample"; }

  /** The decoded buffer, loading it first if needed (null if it can't be had) */
  async load(id, ctx) {
    if (!id) return null;
    if (this.buffers.has(id)) return this.buffers.get(id);
    if (this.loading.has(id)) return this.loading.get(id);
    const p = (async () => {
      let b = null;
      if (id.startsWith("builtin:")) {
        const k = id.slice(8);
        if (KIT[k]) b = makeBuffer([KIT[k]()]);
        else if (LOOPS[k]) b = makeBuffer(renderLoop(LOOPS[k], (n) => KIT[n]()));
      } else {
        const rec = await db.loadSample(id).catch(() => null);
        if (rec) {
          b = await decode(ctx, rec.bytes);
          this.info.set(id, { id, name: rec.name, bpm: rec.bpm });
        }
      }
      if (b) this.buffers.set(id, b);
      this.loading.delete(id);
      return b;
    })();
    this.loading.set(id, p);
    return p;
  }

  async loadAll(ids, ctx) { await Promise.all([...new Set(ids)].map((id) => this.load(id, ctx))); }

  /** A user's file: kept in IndexedDB as its bytes, decoded now */
  async importFile(file, ctx) {
    const bytes = await file.arrayBuffer();
    const buffer = await decode(ctx, bytes);
    const id = uid("s");
    const name = file.name.replace(/\.[^.]+$/, "");
    await db.saveSample({ id, name, bytes, type: file.type || "audio/wav", createdAt: Date.now() });
    this.buffers.set(id, buffer);
    this.info.set(id, { id, name });
    return { id, name, buffer, duration: buffer.duration };
  }

  /** A buffer made here (a recording): kept as WAV bytes */
  async addBuffer(buffer, name, wavBytes) {
    const id = uid("s");
    await db.saveSample({ id, name, bytes: wavBytes, type: "audio/wav", createdAt: Date.now() });
    this.buffers.set(id, buffer);
    this.info.set(id, { id, name });
    return id;
  }

  /** Min/max pairs over n columns of a sample (for drawing), cached */
  peaks(id, n = 512) {
    const key = id + ":" + n;
    if (this.peaksCache.has(key)) return this.peaksCache.get(key);
    const b = this.buffers.get(id);
    if (!b) return null;
    const out = new Float32Array(n * 2);
    const chans = [];
    for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c));
    const per = b.length / n;
    for (let i = 0; i < n; i++) {
      let lo = 0, hi = 0;
      const a = Math.floor(i * per), e = Math.min(b.length, Math.floor((i + 1) * per));
      for (const ch of chans) for (let j = a; j < e; j += 4) { const v = ch[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[2 * i] = lo; out[2 * i + 1] = hi;
    }
    this.peaksCache.set(key, out);
    return out;
  }
}

function decode(ctx, bytes) {
  return new Promise((resolve, reject) => {
    const copy = bytes.slice(0);
    const p = ctx.decodeAudioData(copy, resolve, reject); // the callback form for older Safari
    if (p && p.then) p.then(resolve, reject);
  });
}
