/* Filter response editor for the Filter card.
 *
 * Plots curves.filterDb on a log axis from 20 Hz to 20 kHz.  Drag sideways
 * to set the cutoff and vertically to set resonance; arrow keys do the same
 * (Left/Right one semitone, Up/Down 2 % resonance, Shift for finer steps).
 * The band shows where the filter envelope can sweep the cutoff (Env amount
 * x 72 semitones), the range the knob row's Env control sets.
 */
import { formatHz, formatValue } from "./format.js";
import { CUTOFF_RANGE, cutoffHz, filterDb } from "./curves.js";
import { cssVar, sizeCanvas } from "./wavetable.js";

const F_LO = 20, F_HI = 20000;
const DB_TOP = 24, DB_BOTTOM = -48;
const POINTS = 160;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const xOfHz = (hz, w) => w * Math.log(hz / F_LO) / Math.log(F_HI / F_LO);
const hzOfX = (x, w) => F_LO * Math.pow(F_HI / F_LO, x / w);
const noteOfHz = (hz) => 69 + 12 * Math.log2(hz / 440);

export function filterView(store) {
  const wrap = el("div", "filter-view");
  const canvas = el("canvas", "filter-canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "slider");
  canvas.setAttribute("aria-label", "Filter cutoff and resonance");
  const caption = el("div", "wave-caption");
  const readout = el("span", "wave-pos");
  const hint = el("span", "wave-reach", "drag ↔ cutoff · ↕ resonance");
  caption.append(readout, hint);
  wrap.append(canvas, caption);

  // Bindings call back immediately, so the scheduler must exist first.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  };

  const cutoff = store.bind("cutoff", () => schedule());
  const res = store.bind("res", () => schedule());
  for (const k of ["ftype", "fenv", "edit_layer"]) store.bind(k, () => schedule());

  const draw = () => {
    const type = Math.round(store.value("ftype"));
    const note = store.value("cutoff");
    const r = store.value("res");
    const fenv = store.value("fenv");
    const { ctx, w, h, dpr } = sizeCanvas(canvas);
    const pad = 4 * dpr;
    const yOf = (db) => pad + (h - 2 * pad) * (DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM);
    const color = cssVar("--l" + store.layer);
    ctx.clearRect(0, 0, w, h);

    // Grid: decades and 0 / -24 dB.
    ctx.strokeStyle = cssVar("--line");
    ctx.fillStyle = cssVar("--faint");
    ctx.lineWidth = dpr;
    ctx.font = `${9 * dpr}px ui-monospace, monospace`;
    for (const f of [100, 1000, 10000]) {
      const x = Math.round(xOfHz(f, w)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x + 3 * dpr, h - 4 * dpr);
    }
    for (const db of [0, -24]) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.setLineDash(db === 0 ? [] : [3 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Envelope sweep band.
    const fc = cutoffHz(note);
    const xc = xOfHz(fc, w);
    if (Math.abs(fenv) > 0.005 && type !== 5) {
      const xe = xOfHz(cutoffHz(note + fenv * CUTOFF_RANGE), w);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(Math.min(xc, xe), 0, Math.abs(xe - xc), h);
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([2 * dpr, 3 * dpr]);
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(xe, 0); ctx.lineTo(xe, h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Response.
    ctx.beginPath();
    for (let i = 0; i <= POINTS; i++) {
      const x = (i / POINTS) * w;
      const y = yOf(filterDb(type, note, r, hzOfX(x, w)));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Handle at the cutoff, on the curve.
    if (type !== 5) {
      const yc = yOf(filterDb(type, note, r, fc));
      ctx.beginPath();
      ctx.arc(xc, yc, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = cssVar("--bg");
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }

    const text = type === 5 ? "Filter off"
      : formatHz(fc) + " · Res " + formatValue(store.metaFor("res"), r);
    readout.textContent = text;
    canvas.setAttribute("aria-valuetext", text);
  };

  /* Pointer: absolute cutoff from x, relative resonance from y. */
  let drag = null;
  // A binding is not called back for its own writes, so redraw here.
  const setCutoff = (note) => {
    cutoff.set(Math.min(127, Math.max(0, note)).toFixed(4));
    schedule();
  };
  const setRes = (v) => {
    res.set(Math.min(1, Math.max(0, v)).toFixed(4));
    schedule();
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, res: store.value("res") };
    wrap.classList.add("active");
    move(e);
  });
  const move = (e) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
    setCutoff(noteOfHz(hzOfX(x, rect.width)));
    const scale = e.shiftKey ? 600 : 150;
    setRes(drag.res + (drag.y - e.clientY) / scale);
  };
  canvas.addEventListener("pointermove", move);
  const end = () => { drag = null; wrap.classList.remove("active"); };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("keydown", (e) => {
    const fine = e.shiftKey ? 0.1 : 1;
    if (e.key === "ArrowLeft") setCutoff(store.value("cutoff") - fine);
    else if (e.key === "ArrowRight") setCutoff(store.value("cutoff") + fine);
    else if (e.key === "ArrowUp") setRes(store.value("res") + 0.02 * fine);
    else if (e.key === "ArrowDown") setRes(store.value("res") - 0.02 * fine);
    else return;
    e.preventDefault();
  });
  new ResizeObserver(schedule).observe(canvas);
  return wrap;
}
