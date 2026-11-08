/* Animated modulation cues.  Loaded after first paint (layout.js).
 *
 * One animation loop works out every source's current output and hands it to
 * the knobs whose rings it drives (dot on each ring, ghost tick on the track)
 * and to the header chips (the dot pulses):
 *   - LFOs run on from the phase the telemetry last reported, at their rate
 *     (free Hz, or tempo / division when synced);
 *   - envelopes run on from the last reported stage and level through
 *     curves.envStep, the same maths as voice.c, so they glide between the
 *     ~2 Hz telemetry updates instead of stepping;
 *   - every other source has no telemetry, so it gets null and its ring shows
 *     a flowing dash rather than a made-up position.
 * Telemetry follows the focused layer's newest voice.  With no voice playing,
 * envelopes sit at zero and LFOs keep running as a dimmed preview.  The loop
 * does no drawing while the page is hidden, and with reduced motion it only
 * updates when telemetry arrives.
 */
import { envStep, lfoRateHz, lfoShape } from "./curves.js";
import { onLive } from "./live.js";

const ENV_SOURCES = ["Wave Env", "Filter Env", "Amp Env", "Aux Env"];
const ENV_KEYS = ["e1", "e2", "e3", "e4"];
const LFO_SOURCES = [["LFO1", "LFO1xMW"], ["LFO2", "LFO2xMW"]];

export function startModAnimation(store) {
  const model = store.mod;
  if (!model) return;
  const names = store.meta.params.m1_src.options;
  const envIndex = new Map(ENV_SOURCES.map((n, k) => [names.indexOf(n), k]).filter(([i]) => i > 0));
  const lfoIndex = new Map();
  LFO_SOURCES.forEach((group, k) => group.forEach((n) => { if (names.indexOf(n) > 0) lfoIndex.set(names.indexOf(n), k); }));

  const env = ENV_KEYS.map(() => ({ stage: 0, level: 0 }));
  const lfo = [{ phase: 0, cur: 0 }, { phase: 0, cur: 0 }];
  let bpm = 120;
  let voices = 0;
  let heard = false;   // telemetry seen at least once

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  onLive(store, (s) => {
    heard = true;
    voices = s.layerVoices[store.layer - 1] || 0;
    bpm = s.bpm;
    (s.env || []).forEach((e, k) => { if (env[k]) { env[k].stage = e.stage; env[k].level = e.level; } });
    if (!s.env) env.forEach((e) => { e.stage = 0; e.level = 0; });
    if (s.lfo) s.lfo.forEach((l, k) => { lfo[k].phase = l.phase; lfo[k].cur = l.cur; });
    if (reduced) frame(performance.now(), true);
  });

  /* Advance the predicted sources by dt seconds. */
  const advance = (dt) => {
    env.forEach((e, k) => {
      const p = ENV_KEYS[k];
      if (!e.stage) return;
      const next = envStep(e.stage, e.level, store.value(p + "_a"), store.value(p + "_d"),
        store.value(p + "_s"), store.value(p + "_r"), dt);
      e.stage = next.stage;
      e.level = next.level;
    });
    lfo.forEach((l, k) => {
      const p = "lfo" + (k + 1) + "_";
      const hz = lfoRateHz(store.value(p + "rate"), store.value(p + "sync") >= 0.5,
        Math.round(store.value(p + "div")), bpm);
      const before = l.phase;
      l.phase = (l.phase + hz * dt) % 1;
      if (l.phase < before) l.cur = Math.random() * 2 - 1;   // Rand/S&H pick a new value per cycle
    });
  };

  /** Current output of source `src`, or null without telemetry for it. */
  const signal = (src) => {
    if (!heard) return null;
    if (envIndex.has(src)) return env[envIndex.get(src)].level;
    if (lfoIndex.has(src)) {
      const k = lfoIndex.get(src);
      const l = lfo[k];
      return lfoShape(Math.round(store.value("lfo" + (k + 1) + "_shape")), l.phase, l.cur, l.cur);
    }
    return null;
  };

  const chips = () => document.querySelectorAll(".mod-chip[data-src]");
  let last = 0;
  const frame = (now, once) => {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (!document.hidden) {
      if (!reduced) advance(dt);
      const idle = voices === 0;
      for (const [, set] of model.knobs) {
        for (const knob of set) {
          const rings = knob.getRings();
          if (!rings.length || !knob.isConnected) continue;
          knob.animateRings(rings.map((r) => signal(r.src)), idle);
        }
      }
      for (const chip of chips()) {
        const s = signal(Number(chip.dataset.src));
        chip.style.setProperty("--sig", s === null ? "0" : Math.min(1, Math.abs(s)).toFixed(3));
        chip.classList.toggle("live", s !== null && !idle);
      }
    }
    if (!once && !reduced) requestAnimationFrame(frame);
  };
  if (!reduced) requestAnimationFrame(frame);
  else frame(performance.now(), true);
}
