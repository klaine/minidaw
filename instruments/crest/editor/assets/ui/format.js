/* Readings in real units. The display curves come from tools/gen/params.py (DISP, emitted into
 * ui_meta.json as `f`) and mirror the DSP; src/cards.js prints the same readings on the Move. */

const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(n) { return NOTE[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }

function trim(x, d) {
  let s = x.toFixed(d);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

const signed = (x, d) => (x > 0 ? "+" : x < 0 ? "−" : "") + trim(Math.abs(x), d);

export function unitText(v, u) {
  const a = Math.abs(v);
  switch (u) {
    case "s": return a < 1 ? trim(v * 1000, a < 0.01 ? 1 : 0) + " ms" : trim(v, a < 10 ? 2 : 1) + " s";
    case "ms": return a >= 1000 ? trim(v / 1000, 2) + " s" : trim(v, a < 10 ? 1 : 0) + " ms";
    case "Hz": return a >= 1000 ? trim(v / 1000, a >= 10000 ? 1 : 2) + " kHz" : trim(v, a < 1 ? 3 : a < 10 ? 2 : a < 100 ? 1 : 0) + " Hz";
    case "x": return "×" + trim(v, 2);
    case "deg": return Math.round(v) + "°";
    default: return trim(v, a < 10 ? 1 : 0) + " " + u;
  }
}

export const cutoffHz = (x) => 440 * Math.pow(2, (20 + 115 * x - 69) / 12);
export const envSeconds = (x, tmax = 20, bend = 1) => 0.0005 * Math.pow(tmax / 0.0005, Math.pow(x, bend));
/** Free LFO rate: Low 0.02..200 Hz, High 8x that (lfo.c; the engine caps it at 1240 Hz). */
export const lfoHz = (x, high = false) => (high ? 0.16 : 0.02) * Math.pow(10000, x);

/* Some readings depend on another parameter (an LFO's rate on its Range): the store says where to
 * look them up. */
let valueOf = () => undefined;
export function setValueSource(fn) { valueOf = fn; }

/** Reading of stored value x for param meta p. */
export function reading(p, x) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  if (p.t === "enum") return p.o[Math.round(x)] ?? String(x);
  const f = p.f;
  if (!f) {
    if (p.t === "int") {
      if (p.u === "st" || p.u === "ct") return signed(x, 0) + " " + p.u;
      return String(Math.round(x));
    }
    return trim(x, 2);
  }
  switch (f[0]) {
    case "env": return unitText(envSeconds(x, f[1], f[2] || 1), "s");
    case "edly": return x <= 0 ? "Off" : unitText(0.001 * Math.pow(10000, x), "s");
    case "lfo": return unitText(lfoHz(x, Math.round(valueOf(f[1]) ?? 0) === 1), "Hz");
    case "ldly": return x <= 0 ? "Off" : unitText(0.005 * Math.pow(2000, x), "s");
    case "lfade": return x > 0.001 ? unitText(x * 10, "s") : "Off";
    case "rep": { const r = Math.round(x); return r <= 0 ? "Off" : f[1] && r >= f[1] ? "Loop" : "×" + r; }
    case "cut": return unitText(cutoffHz(x), "Hz");
    case "glide": return 5.6 * Math.pow(x, 5) <= 0.0005 ? "Off" : unitText(5.6 * Math.pow(x, 5), "s");
    case "udet": return signed(50 * x * x * x, 1) + " ct";
    case "fm": return x <= 0 ? "Off" : "index " + trim(1.5 * x * x * 2 * Math.PI, 2);
    case "cube": { const c = f[1] * x * x * x; return (c > 0 ? "+" : c < 0 ? "−" : "") + unitText(Math.abs(c), f[2]); }
    case "exp": return unitText(f[1] * Math.pow(f[2] / f[1], x), f[3]);
    case "lin": return unitText(f[1] + (f[2] - f[1]) * x, f[3]);
    case "note": return x <= 0 ? "Off" : noteName(Math.round(x));
    case "bip": return signed(x * 100, 0) + "%";
    case "pct": return Math.round(x * 100) + "%";
  }
  return trim(x, 2);
}

/** The value the knob's arc shows, 0..1 (bipolar params centre at 0.5). */
export function norm(p, x) {
  if (p.t === "enum") return p.o.length > 1 ? x / (p.o.length - 1) : 0;
  return (x - p.mn) / (p.mx - p.mn || 1);
}

export function denorm(p, u) {
  if (p.t === "enum") return Math.round(u * (p.o.length - 1));
  const v = p.mn + u * (p.mx - p.mn);
  return p.t === "int" ? Math.round(v) : v;
}

export function wire(p, x) {
  if (p.t === "float") return x.toFixed(4);
  return String(Math.round(x));
}
