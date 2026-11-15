/* LFO shape preview for the LFOs tab.
 *
 * Draws two cycles of the selected shape (curves.lfoShape, as voice.c), with
 * the Fade In ramp when its time is shorter than the window, and lists what
 * the LFO drives on this layer.  While the tab is visible a dot runs at the
 * LFO's rate; live telemetry (live.js) re-anchors it to the newest voice's
 * real phase and supplies the tempo synced LFOs follow.
 */
import { envSeconds, formatHz, formatSeconds, lfoHz } from "./format.js";
import { LFO_DIV_BEATS, lfoShape } from "./curves.js";
import { onLive } from "./live.js";
import { cssVar, sizeCanvas } from "./wavetable.js";
import { sourceColor } from "./mod.js";

const CYCLES = 2;
// Fixed stand-ins for the random values Rand / S&H pick each cycle.
const RANDOM = [0.35, -0.7, 0.85, -0.2, 0.6];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function lfoView(store, n) {
  const p = "lfo" + n + "_";
  const wrap = el("div", "lfo-view");
  const canvas = el("canvas", "lfo-canvas");
  canvas.setAttribute("role", "img");
  const caption = el("div", "wave-caption");
  const rate = el("span", "wave-pos");
  const drives = el("span", "wave-reach");
  caption.append(rate, drives);
  wrap.append(canvas, caption);

  const srcIndex = store.meta.params.m1_src.options.indexOf("LFO" + n);
  const color = () => sourceColor(store.meta, srcIndex);

  const state = () => {
    const synced = store.value(p + "sync") >= 0.5;
    const hz = lfoHz(store.value(p + "rate"));
    return {
      shape: Math.round(store.value(p + "shape")),
      synced, hz,
      div: store.metaFor(p + "div").options[Math.round(store.value(p + "div"))],
      fade: store.value(p + "fade") > 0 ? envSeconds(store.value(p + "fade")) : 0,
      phaseMode: store.metaFor(p + "phase").options[Math.round(store.value(p + "phase"))],
      mw: store.value(p + "mw") >= 0.5,
    };
  };

  let phase = 0;
  let bpm = 0;          // from telemetry; 0 until the first update
  onLive(store, (s) => {
    bpm = s.bpm;
    // Re-anchor to the newest voice; the window shows two cycles.
    if (s.lfo) phase = Math.floor(phase) + s.lfo[n - 1].phase;
  });
  const rateHz = (s) => s.synced
    ? (bpm ? bpm / 60 / LFO_DIV_BEATS[store.metaFor(p + "div").options.indexOf(s.div)] : 0)
    : s.hz;
  const draw = () => {
    const s = state();
    const { ctx, w, h, dpr } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2, amp = h / 2 - 6 * dpr;
    ctx.strokeStyle = cssVar("--line");
    ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    for (let c = 1; c < CYCLES; c++) {
      const x = (c / CYCLES) * w;
      ctx.setLineDash([2 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.setLineDash([]);
    // Window length in seconds (free rate only) for the fade ramp.
    const windowSec = s.synced ? null : CYCLES / s.hz;
    const gain = (t) => {
      if (!s.fade || windowSec === null) return 1;
      return Math.min(1, (t * windowSec) / s.fade);
    };
    const at = (t) => {
      const cyc = t * CYCLES;
      const k = Math.min(CYCLES - 1, Math.floor(cyc));
      const ph = cyc - k;
      return lfoShape(s.shape, ph, RANDOM[k], RANDOM[k + 1]) * gain(t);
    };
    const steps = Math.max(64, Math.round(w / (2 * dpr)));
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = mid - at(Math.min(t, 0.99999)) * amp;
      if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(t * w, y);
    }
    ctx.strokeStyle = color();
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = "round";
    ctx.stroke();
    if (s.fade && windowSec !== null && s.fade < windowSec) {
      ctx.fillStyle = cssVar("--faint");
      ctx.font = `${9 * dpr}px ui-monospace, monospace`;
      ctx.fillText("fade", (s.fade / windowSec) * w + 3 * dpr, 10 * dpr);
    }
    if (rateHz(s) > 0) {
      const t = (phase % CYCLES) / CYCLES;
      ctx.beginPath();
      ctx.arc(t * w, mid - at(t) * amp, 3.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = color();
      ctx.fill();
    }
    rate.textContent = (s.synced ? s.div + " synced" : formatHz(s.hz) + " · " + formatSeconds(1 / s.hz)) +
      " · " + s.phaseMode + (s.mw ? " · ×MW" : "");
    canvas.setAttribute("aria-label", "LFO " + n + " shape preview, " + rate.textContent);
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  };
  for (const k of ["shape", "rate", "sync", "div", "fade", "phase", "mw"]) store.bind(p + k, schedule);
  store.bind("edit_layer", schedule);
  new ResizeObserver(schedule).observe(canvas);

  /* Animate only while visible; capped to the display rate. */
  let last = 0;
  const tick = (now) => {
    const visible = canvas.offsetParent !== null;
    const s = visible ? state() : null;
    const hz = visible ? rateHz(s) : 0;
    if (hz > 0) {
      phase += (last ? (now - last) / 1000 : 0) * Math.min(hz, 30);
      draw();
    }
    last = now;
    requestAnimationFrame(tick);
  };
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) requestAnimationFrame(tick);

  /* What this LFO drives on the focused layer. */
  if (store.mod) {
    store.mod.onSlots((slots) => {
      const names = store.meta.params.m1_dst.options;
      const list = slots.filter((sl) => (sl.src === srcIndex || sl.src === srcIndex + 2) && sl.dst > 0)
        .map((sl) => names[sl.dst] + " " + (sl.amt > 0 ? "+" : "") + Math.round(sl.amt * 100) + "%");
      drives.textContent = list.length ? "→ " + list.join(", ") : "not routed";
    });
  }
  return wrap;
}
