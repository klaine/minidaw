/* Value <-> text for Remote UI controls.
 *
 * A control works in the parameter's own value space (what set_param takes).
 * `display` kinds from ui_meta.json name the curve src/dsp applies to that
 * value, so the text shows what is heard: Hz for cutoff, seconds for envelope
 * stages, and the FX slot ranges from docs/11.  Pure functions, no DOM, so
 * tests/host/test_web_ui.mjs can run them under node.
 */

export const WAVE_CLASSICS = { 61: "Tri", 62: "Square", 63: "Saw" };
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const noteHz = (note) => 440 * Math.pow(2, (note - 69) / 12);
export const envSeconds = (x) => Math.max(0.0005, 20 * Math.pow(Math.max(0, x), 3));
export const lfoHz = (x) => 0.01 * Math.pow(5000, Math.min(1.2, Math.max(0, x)));
export const glideSeconds = (x) => 5 * x * x;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const linMap = (x, lo, hi) => lo + (hi - lo) * clamp01(x);
export const expMap = (x, lo, hi) => lo * Math.pow(hi / lo, clamp01(x));

export function noteName(n) {
  const i = Math.round(n);
  return NOTE_NAMES[((i % 12) + 12) % 12] + (Math.floor(i / 12) - 1);
}

function trim(n, digits) {
  return n.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, "$1");
}

export function formatHz(hz) {
  if (hz >= 1000) return trim(hz / 1000, hz >= 10000 ? 1 : 2) + " kHz";
  return trim(hz, hz >= 100 ? 0 : hz >= 10 ? 1 : 2) + " Hz";
}

export function formatSeconds(s) {
  if (s < 1) return trim(s * 1000, s < 0.01 ? 1 : 0) + " ms";
  return trim(s, s >= 10 ? 1 : 2) + " s";
}

function formatUnit(v, unit) {
  if (unit === "Hz") return formatHz(v);
  if (unit === "s") return formatSeconds(v);
  if (unit === "ms") return v >= 1000 ? formatSeconds(v / 1000) : trim(v, v >= 100 ? 0 : 1) + " ms";
  if (unit === ":1") return trim(v, v >= 10 ? 0 : 1) + ":1";
  if (unit === "°") return Math.round(v) + "°";
  if (unit === "dB") return (v > 0.05 ? "+" : "") + trim(v, 1) + " dB";
  if (unit === "%") return Math.round(v) + "%";
  const text = trim(v, Math.abs(v) >= 100 ? 0 : 2);
  return unit ? text + " " + unit : text;
}

/** Text for a value of the parameter described by `meta`. */
export function formatValue(meta, value) {
  const v = Number(value);
  if (meta.options) {
    const i = optionIndex(meta, v);
    return meta.options[i] !== undefined ? meta.options[i] : String(value);
  }
  if (!Number.isFinite(v)) return "";
  const d = meta.display;
  if (d) {
    switch (d.kind) {
      case "note_hz": return formatHz(noteHz(v));
      case "note_name": return noteName(v);
      case "wave_pos": return WAVE_CLASSICS[Math.round(v)] || String(Math.round(v));
      case "env_time": return formatSeconds(envSeconds(v));
      case "fade_time": return v <= 0 ? "Off" : formatSeconds(envSeconds(v));
      case "lfo_hz": return formatHz(lfoHz(v));
      case "glide_time": return v <= 0 ? "Off" : formatSeconds(glideSeconds(v));
      case "percent": return Math.round(v * 100) + "%";
      case "lin": return formatUnit(linMap(v, d.lo, d.hi), d.unit);
      case "exp": return formatUnit(expMap(v, d.lo, d.hi), d.unit);
    }
  }
  switch (meta.unit) {
    case "%": {
      const pct = (meta.max !== undefined && meta.max <= 2.001) ? v * 100 : v;
      const text = Math.round(pct) + "%";
      return meta.min < 0 && pct > 0.5 ? "+" + text : text;
    }
    case "st": return (v > 0 ? "+" : "") + Math.round(v) + " st";
    case "cents": return (v > 0 ? "+" : "") + Math.round(v) + " ct";
    case "dB": case "Hz": case "ms": case "s": return formatUnit(v, meta.unit);
  }
  if (meta.type === "int") return (meta.min < 0 && v > 0 ? "+" : "") + Math.round(v);
  return trim(v, Math.abs(v) >= 10 ? 1 : 2);
}

/** Enum index for a stored value; FX enums are stored normalised 0..1. */
export function optionIndex(meta, value) {
  const n = meta.options.length;
  const v = Number(value);
  if (meta.normalized) return Math.min(n - 1, Math.max(0, Math.round(clamp01(v) * (n - 1))));
  return Math.min(n - 1, Math.max(0, Math.round(v)));
}

export function optionValue(meta, index) {
  return meta.normalized ? index / Math.max(1, meta.options.length - 1) : index;
}

/** Parse typed text back to a value, or null.  Accepts the units shown. */
export function parseValue(meta, text) {
  const s = String(text).trim();
  if (meta.display && meta.display.kind === "note_name") {
    const m = /^([a-g])(#|b)?(-?\d)$/i.exec(s);
    if (m) {
      const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
      const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
      return clampTo(meta, 12 * (Number(m[3]) + 1) + base + acc);
    }
  }
  if (meta.display && meta.display.kind === "wave_pos") {
    for (const k in WAVE_CLASSICS) if (WAVE_CLASSICS[k].toLowerCase() === s.toLowerCase()) return Number(k);
  }
  if (meta.options) {
    const i = meta.options.findIndex((o) => o.toLowerCase() === s.toLowerCase());
    if (i >= 0) return optionValue(meta, i);
    const n = parseInt(s, 10);
    return Number.isInteger(n) && n >= 0 && n < meta.options.length ? optionValue(meta, n) : null;
  }
  if (/^off$/i.test(s) && meta.display && /^(fade|glide)_time$/.test(meta.display.kind)) return 0;
  const m = /^([-+]?\d*\.?\d+)\s*(k?hz|ms|s|%|st|ct|cents|db|°)?$/i.exec(s);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  const d = meta.display;
  const invertLog = (x, base, scale) => Math.log(x / scale) / Math.log(base);
  if (d) {
    switch (d.kind) {
      case "note_hz": {
        const hz = unit === "khz" ? n * 1000 : n;
        if (!unit && n <= 127) return clampTo(meta, n);
        return clampTo(meta, 69 + 12 * Math.log2(hz / 440));
      }
      case "env_time": case "fade_time": case "glide_time": {
        const sec = unit === "ms" ? n / 1000 : n;
        if (sec <= 0) return 0;
        return clampTo(meta, d.kind === "glide_time" ? Math.sqrt(sec / 5) : Math.cbrt(sec / 20));
      }
      case "lfo_hz": return clampTo(meta, invertLog(unit === "khz" ? n * 1000 : n, 5000, 0.01));
      case "percent": return clampTo(meta, n / 100);
      case "lin": return clampTo(meta, (n - d.lo) / (d.hi - d.lo));
      case "exp": {
        const v = (unit === "khz" ? n * 1000 : unit === "s" && d.unit === "ms" ? n * 1000 : n);
        return v > 0 ? clampTo(meta, Math.log(v / d.lo) / Math.log(d.hi / d.lo)) : null;
      }
    }
  }
  if (meta.unit === "%" && meta.max <= 2.001) n /= 100;
  return clampTo(meta, n);
}

export function clampTo(meta, v) {
  const lo = meta.min !== undefined ? meta.min : 0;
  const hi = meta.max !== undefined ? meta.max : 1;
  let x = Math.min(hi, Math.max(lo, v));
  if (meta.type === "int") x = Math.round(x);
  return x;
}

/** Wire string for set_param: enum index, int, or float with 3 decimals. */
export function wireValue(meta, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (meta.options && !meta.normalized) return String(Math.round(n));
  if (meta.type === "int") return String(Math.round(n));
  return n.toFixed(3);
}
