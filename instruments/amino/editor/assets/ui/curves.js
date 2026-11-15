/* Curves the Remote UI draws, modelled on src/dsp/voice.c.  Pure functions,
 * no DOM, so tests/host/test_web_ui.mjs can check them under node.
 *
 * The filter plot is the small-signal response of the voice filter (the
 * ladder's tanh stage taken as linear), so it shows the shape and the
 * resonance peak rather than the drive-dependent saturation.
 */
import { envSeconds, noteHz } from "./format.js";

export const FILTER_TYPES = ["LP24", "LP12", "Ladder 24dB", "HP24", "HP12", "BP12", "Off"];
export const CUTOFF_RANGE = 72;   // AMINO_CUTOFF_RANGE: Env/AT amount 1.0 = 72 st
export const WAVE_RANGE = 63;     // AMINO_WAVE_RANGE
const MAG_FLOOR_DB = -96;

/** Cutoff note as the voice clamps it, in Hz. */
export const cutoffHz = (note) => Math.min(18000, Math.max(20, noteHz(note)));

/**
 * Magnitude in dB at `hz` for filter type index `type` (FILTER_TYPES order),
 * cutoff note and resonance 0..1, from the analog prototypes of voice.c:
 * a 4-pole ladder with feedback k = 3.9 * res and input gain (1 + k/2) for the
 * 24 dB types, and a state-variable filter with damping R = 1 - 0.97 * res for
 * the 12 dB types (BP output scaled by 2R).  Ladder 24dB (2) is the same ladder with
 * k = 4.5 * res and a partial make-up gain of 1 + 0.3k, so the passband sags.
 */
export function filterDb(type, note, res, hz) {
  if (type === 6) return 0;
  const w = hz / cutoffHz(note);           // s = j*w
  const r = Math.min(1, Math.max(0, res));
  const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const cdiv = (a, b) => {
    const d = b[0] * b[0] + b[1] * b[1];
    return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
  };
  const mag = (c) => Math.hypot(c[0], c[1]);
  let h;
  if (type === 0 || type === 2 || type === 3) {
    const moog = type === 2;
    const k = (moog ? 4.5 : 3.9) * r;
    const h1 = cdiv([1, 0], [1, w]);              // one pole: 1 / (1 + s)
    const h4 = cmul(cmul(h1, h1), cmul(h1, h1));
    const den = [1 + k * h4[0], k * h4[1]];
    let num = h4;
    if (type === 3) {
      const hp1 = [1 - h1[0], -h1[1]];              // 1 - H1 = s / (1 + s)
      num = cmul(cmul(hp1, hp1), cmul(hp1, hp1));
    }
    const gain = moog ? 1 + 0.3 * k : 1 + 0.5 * k;
    h = cdiv([num[0] * gain, num[1] * gain], den);
  } else {
    const R = 1 - 0.97 * r;
    const den = [1 - w * w, 2 * R * w];             // 1 + 2R s + s^2
    const num = type === 1 ? [1, 0] : type === 4 ? [-w * w, 0] : [0, 2 * R * w];
    h = cdiv(num, den);
  }
  const m = mag(h);
  return m > 0 ? Math.max(MAG_FLOOR_DB, 20 * Math.log10(m)) : MAG_FLOOR_DB;
}

/**
 * Envelope stage shapes from env_step: attack chases 1.3 and stops at 1.0,
 * which it reaches exactly at am_env_time(a); decay and release are
 * exponentials whose time constant is a fifth-ish (1/4.6) of the stage time.
 * Returns the level at fraction u (0..1) of the drawn stage.
 */
export function attackLevel(u) {
  return Math.min(1, 1.3 * (1 - Math.exp(-1.466 * u)));
}
export const decayLevel = (u, s) => s + (1 - s) * Math.exp(-4.6 * u);
export const releaseLevel = (u, from) => from * Math.exp(-4.6 * u);

/** Stage durations in seconds for knob values a, d, r. */
export const stageSeconds = (a, d, r) => [envSeconds(a), envSeconds(d), envSeconds(r)];

/**
 * The wave steps one modulation amount sweeps, as [lo, hi] offsets from the
 * stored position (voice.c scales every wave source by AMINO_WAVE_RANGE).  A
 * bipolar source (-1..1) swings both ways; a unipolar one (0..1) pushes one.
 */
export function waveSpan(amount, bipolar) {
  const d = amount * WAVE_RANGE;
  return bipolar ? [-Math.abs(d), Math.abs(d)] : [Math.min(0, d), Math.max(0, d)];
}

/**
 * Wave positions a voice can reach: the stored position plus the spans of
 * the Wave env and velocity (0..1 amounts) and of any other source that moves
 * the wave (`mods`, each a waveSpan).  The spans add up, and the result is
 * clamped to the morphing slots 0..60.  Positions 61-63 are fixed classic waves.
 */
export function waveReach(base, wenv, vel, mods = []) {
  const b = Math.round(base);
  if (b >= 61) return { lo: b, hi: b, fixed: true };
  const spans = [waveSpan(wenv, false), waveSpan(vel, false), ...mods];
  const clamp = (x) => Math.min(60, Math.max(0, x));
  const lo = spans.reduce((sum, s) => sum + s[0], b);
  const hi = spans.reduce((sum, s) => sum + s[1], b);
  return { lo: clamp(lo), hi: clamp(hi), fixed: false };
}

/**
 * The span a modulation slot sweeps on its target knob, as [lo, hi] in the
 * knob's units: `scale` is ui_meta modTargetScale for the target (units per
 * amount 1.0, or "mul" for vol/send which voice.c multiplies by 1 + m).
 * Unipolar sources (0..1) push one way; bipolar ones (-1..1) swing both.
 */
export function ringSpan(value, amount, scale, bipolar, min, max) {
  const delta = scale === "mul" ? value * amount : amount * scale;
  let lo = bipolar ? value - Math.abs(delta) : Math.min(value, value + delta);
  let hi = bipolar ? value + Math.abs(delta) : Math.max(value, value + delta);
  lo = Math.min(max, Math.max(min, lo));
  hi = Math.min(max, Math.max(min, hi));
  return [lo, hi];
}

/**
 * LFO output at phase p (0..1) for shape index (Sine, Tri, Pulse, SawDn,
 * SawUp, Rand, S&H), as lfo_shape in voice.c.  Rand glides from the previous
 * random value to the next across a cycle, S&H holds it; `prev`/`cur` stand in
 * for those values.
 */
export function lfoShape(shape, p, prev = 0, cur = 0) {
  switch (shape) {
    case 0: return Math.sin(2 * Math.PI * p);
    case 1: return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 2: return p < 0.5 ? 1 : -1;
    case 3: return 1 - 2 * p;
    case 4: return 2 * p - 1;
    case 5: return prev + (cur - prev) * p;
    default: return cur;
  }
}

/** Beats per cycle for LFO division index (LFO_DIVS order). */
export const LFO_DIV_BEATS = [1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2, 4, 8, 16, 32, 64];

/**
 * Advance one envelope by dt seconds the way env_step in voice.c does
 * (without matrix time modulation), so the UI can move an envelope smoothly
 * between telemetry updates.  `stage` is AminoEnvStage (0 off, 1 attack,
 * 2 decay/sustain, 3 release); a, d, s, r are the knob values.  Returns
 * { stage, level }.
 */
export function envStep(stage, level, a, d, s, r, dt) {
  if (dt <= 0) return { stage, level };
  if (stage === 1) {
    const t = envSeconds(a) / 1.466;
    level += (1.3 - level) * (1 - Math.exp(-dt / t));
    if (level >= 1) return { stage: 2, level: 1 };
  } else if (stage === 2) {
    level += (s - level) * (1 - Math.exp(-dt / (envSeconds(d) / 4.6)));
  } else if (stage === 3) {
    level -= level * (1 - Math.exp(-dt / (envSeconds(r) / 4.6)));
    if (level < 1e-4) return { stage: 0, level: 0 };
  }
  return { stage, level };
}

/** LFO rate in Hz from its knobs (voice.c: am_lfo_hz, or tempo / division). */
export function lfoRateHz(rate, synced, divIndex, bpm) {
  if (!synced) return 0.01 * Math.pow(5000, Math.min(1.2, Math.max(0, rate)));
  const beats = LFO_DIV_BEATS[Math.min(LFO_DIV_BEATS.length - 1, Math.max(0, divIndex))];
  return bpm > 0 ? bpm / 60 / beats : 0;
}

/**
 * Where modulation puts a knob right now: its value plus each ring's swing
 * (as ringSpan) times that source's current signal (0..1, or -1..1 for
 * bipolar sources).  Rings whose signal is unknown (null) are skipped.
 * Returns { each: [position or null per ring], total } clamped to min..max.
 */
export function modulatedPositions(value, rings, signals, min, max) {
  const clamp = (x) => Math.min(max, Math.max(min, x));
  let total = value;
  let any = false;
  const each = rings.map((r, i) => {
    const s = signals[i];
    if (s === null || s === undefined) return null;
    const delta = (r.scale === "mul" ? value * r.amount : r.amount * r.scale) * s;
    total += delta;
    any = true;
    return clamp(value + delta);
  });
  return { each, total: any ? clamp(total) : null };
}
