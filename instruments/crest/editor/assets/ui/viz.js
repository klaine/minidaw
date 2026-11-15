/* Canvas pictures of the patch: oscillator waves, the filter response, envelopes, LFOs, the arp
 * rhythm, the effect chain, the FM routing and an output scope. Each redraws on the next animation
 * frame after one of its keys changes. Shapes mirror the DSP (src/dsp/osc.c, lfo.c, voice.c). */
import { cutoffHz } from "./format.js";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A canvas that redraws draw(ctx, w, h) whenever one of keys changes or it resizes. */
export function vizCanvas(ui, keys, draw, cls = "viz") {
  const c = document.createElement("canvas");
  c.className = cls;
  c.setAttribute("aria-hidden", "true");
  let queued = false;
  const paint = () => {
    queued = false;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  for (const k of keys) ui.store.bind(k, queue);
  new ResizeObserver(queue).observe(c);
  c.redraw = queue;
  return c;
}

function grid(ctx, w, h, nx = 4, ny = 2) {
  ctx.strokeStyle = css("--grid");
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < nx; i++) { const x = Math.round(w * i / nx) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let j = 1; j < ny; j++) { const y = Math.round(h * j / ny) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
}

/** Stroke f(u) for u in 0..1, value -1..1 mapped into the box with padding; fill under it. */
function trace(ctx, w, h, f, { pad = 4, fill = true, color = css("--trace"), bipolar = true, lw = 1.6 } = {}) {
  const n = Math.max(32, Math.round(w));
  const ys = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) ys[i] = f(i / n);
  const Y = (v) => bipolar ? h / 2 - v * (h / 2 - pad) : h - pad - v * (h - 2 * pad);
  ctx.beginPath();
  for (let i = 0; i <= n; i++) { const x = i / n * w, y = Y(ys[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  if (fill) {
    ctx.save();
    ctx.lineTo(w, Y(0)); ctx.lineTo(0, Y(0)); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, css("--trace-fill"));
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const x = i / n * w, y = Y(ys[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  ctx.stroke();
}

/* ------------------------------------------------------------------ oscillators */

export function oscSample(wave, shape, t) {
  switch (wave) {
    case 0: return Math.sin(2 * Math.PI * t + 2.2 * shape * shape * Math.sin(2 * Math.PI * t));
    case 1: { const w = 0.5 - 0.49 * shape; return t < w ? -1 + 2 * t / w : 1 - 2 * (t - w) / (1 - w); }
    case 2: {
      const a = 2 * t - 1;
      if (shape <= 0.0005) return a;
      let t2 = t + 0.5 * shape; if (t2 >= 1) t2 -= 1;
      return 0.5 * (a + 2 * t2 - 1);
    }
    case 3: { const pw = 0.5 - 0.47 * shape; return t < pw ? 1 : -pw / (1 - pw); }
  }
  return 0;
}

function wtSample(meta, table, shape, t) {
  const frames = meta.wt[table];
  if (!frames) return 0;
  const fp = shape * (frames.length - 1), f0 = Math.min(frames.length - 2, Math.floor(fp)), mix = fp - f0;
  const a = frames[f0], b = frames[f0 + 1], n = a.length;
  const pos = t * n, i = Math.floor(pos) % n, j = (i + 1) % n, fr = pos - Math.floor(pos);
  const va = a[i] + (a[j] - a[i]) * fr, vb = b[i] + (b[j] - b[i]) * fr;
  return (va + (vb - va) * mix) / 127;
}

export function drawOsc(ui, n) {
  const s = ui.store, m = ui.meta, k = (f) => `o${n}_${f}`;
  return (ctx, w, h) => {
    grid(ctx, w, h, 4, 2);
    const wave = Math.round(s.get(k("wave"))), shape = s.get(k("shape")), table = Math.round(s.get(k("table")));
    const r = Math.pow(2, 4 * s.get(k("vsync"))), dens = s.get(k("dens"));
    const level = s.get(`mx_o${n}`);
    const one = (t) => {
      const ts = r > 1.001 ? (t * r) % 1 : t; // virtual sync: the slave restarts with the master
      return wave === 4 ? wtSample(m, table, shape, ts) : oscSample(wave, shape, ts);
    };
    if (dens > 0.01) { // density: the detuned copies drawn as a faint shadow, drifting apart
      for (let c = 1; c <= 3; c++) {
        const lv = Math.min(1, Math.max(0, dens * 3 - (c - 1)));
        if (lv <= 0) continue;
        trace(ctx, w, h, (u) => 0.9 * one(((u * 2) + c * 0.07 * s.get(k("ddet"))) % 1), { fill: false, color: css("--trace-dim"), lw: 1 });
      }
    }
    trace(ctx, w, h, (u) => 0.9 * one((u * 2) % 1), { color: level > 0.001 ? css("--trace") : css("--trace-dim") });
  };
}

/* ------------------------------------------------------------------ filter */

const FT = ["LP24", "LP12", "BP12", "BP6", "HP24", "HP12"];

/** Magnitude (dB) of the filter type at f for cutoff fc and resonance res (an analog-ish sketch). */
export function filterDb(type, fc, res, f) {
  const r = f / fc, q = 0.5 + res * res * 9;
  const two = 1 / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2);
  const plain = 1 / Math.sqrt(1 + r ** 4); // the non-resonant first stage of the 24 dB modes
  let m;
  switch (FT[type]) {
    case "LP24": m = two * plain; break;
    case "LP12": m = two; break;
    case "BP12": m = two * r / q; break;
    case "BP6": m = (r / Math.max(1, q)) / Math.sqrt((1 - r * r) ** 2 + (r / Math.max(1, q)) ** 2); break;
    case "HP24": m = two * r * r * (r * r * plain); break;
    default: m = two * r * r;
  }
  return 20 * Math.log10(Math.max(1e-5, m));
}

export function drawFilter(ui) {
  const s = ui.store;
  return (ctx, w, h) => {
    grid(ctx, w, h, 6, 3);
    const type = Math.round(s.get("flt_type")), fc = cutoffHz(s.get("flt_cut")), res = s.get("flt_res");
    const X = (f) => Math.log(f / 20) / Math.log(1000) * w;
    // env sweep: where Mod Env 1 at full takes the cutoff
    const env = s.get("flt_env"), st = 96 * env ** 3;
    if (Math.abs(st) > 0.5) {
      const f2 = Math.min(20000, Math.max(20, fc * Math.pow(2, st / 12)));
      ctx.fillStyle = css("--sweep");
      ctx.fillRect(Math.min(X(fc), X(f2)), 0, Math.abs(X(f2) - X(fc)), h);
    }
    trace(ctx, w, h, (u) => {
      const f = 20 * Math.pow(1000, u);
      return Math.max(-1, Math.min(1, (filterDb(type, fc, res, f) + 42) / 60));
    }, { bipolar: false, pad: 3 });
    ctx.strokeStyle = css("--accent");
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(X(fc) + 0.5, 0); ctx.lineTo(X(fc) + 0.5, h); ctx.stroke();
    ctx.setLineDash([]);
  };
}

/* ------------------------------------------------------------------ envelopes */

export function drawEnv(ui, getPre) {
  const s = ui.store;
  return (ctx, w, h) => {
    grid(ctx, w, h, 8, 2);
    const pre = getPre();
    const v = (k) => s.get(`${pre}_${k}`);
    // segment widths grow with the (log) time each knob gives, so long stages look long
    const t = (x) => 0.08 + 0.92 * x;
    const dl = v("dly") > 0 ? t(v("dly")) * 0.6 : 0, a = t(v("a")), d = t(v("d")), sus = v("s"), r = t(v("r"));
    const pk = 0.5 * v("hold"), hold = 0.7, tot = dl + a + pk + d + hold + r;
    const X = (x) => 6 + x / tot * (w - 12), Y = (y) => h - 5 - y * (h - 12);
    const pts = [[0, 0], [dl, 0], [dl + a, 1], [dl + a + pk, 1], [dl + a + pk + d, sus], [dl + a + pk + d + hold, sus], [tot, 0]];
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, css("--trace-fill"));
    g.addColorStop(1, "transparent");
    ctx.save(); ctx.lineTo(X(tot), Y(0)); ctx.closePath(); ctx.fillStyle = g; ctx.fill(); ctx.restore();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.strokeStyle = css("--trace");
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = css("--accent");
    for (const [x, y] of pts.slice(2, 6)) { ctx.beginPath(); ctx.arc(X(x), Y(y), 2.6, 0, 7); ctx.fill(); }
    const rep = Math.round(v("rep"));
    if (rep > 0) {
      ctx.fillStyle = css("--dim");
      ctx.font = "10px " + MONO;
      ctx.fillText(rep >= 127 ? "loop ∞" : `repeat ×${rep}`, 8, 12);
    }
  };
}

/* ------------------------------------------------------------------ LFOs */

export function lfoSample(wave, ph, n) {
  switch (wave) {
    case 0: return Math.sin(2 * Math.PI * ph);
    case 1: return ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
    case 2: return 2 * ph - 1;
    case 3: return 1 - 2 * ph;
    case 4: return ph < 0.5 ? 1 : -1;
    case 5: { const r = Math.sin((n + 1) * 12.9898) * 43758.5453; return 2 * (r - Math.floor(r)) - 1; }
    case 6: {
      const a = Math.sin((n + 1) * 12.9898) * 43758.5453, b = Math.sin((n + 2) * 12.9898) * 43758.5453;
      const va = 2 * (a - Math.floor(a)) - 1, vb = 2 * (b - Math.floor(b)) - 1, x = 0.5 - 0.5 * Math.cos(Math.PI * ph);
      return va + (vb - va) * x;
    }
    default: { const u = 1 - ph; return 2 * u * u * u - 1; }
  }
}

export function drawLfo(ui, getN) {
  const s = ui.store;
  return (ctx, w, h) => {
    grid(ctx, w, h, 6, 2);
    const n = getN(), v = (k) => s.get(`l${n}_${k}`);
    const wave = Math.round(v("wave")), phase = v("phase"), fade = v("fade"), dly = v("dly"), slew = v("slew");
    const fmode = Math.round(v("fmode") ?? 0), rep = Math.round(v("rep") ?? 0);
    const cycles = 3;
    const d0 = dly > 0 ? 0.08 + dly * 0.25 : 0;
    let y = 0;
    const smooth = slew > 0.001 ? 1 - Math.exp(-2 * Math.PI * 200 * Math.pow(0.0025, slew) / 400) : 1;
    trace(ctx, w, h, (u) => {
      if (u < d0) { y = 0; return 0; }
      const run = (u - d0) / (1 - d0) * cycles, t = (rep > 0 ? Math.min(run, rep - 1e-6) : run) + phase;
      const raw = lfoSample(wave, t % 1, Math.floor(t));
      y += (raw - y) * smooth;
      let g = 1;
      if (fade > 0.001) { /* the four fade modes, over a span that grows with Fade Time */
        const e = (u - d0) / (fade * 0.9 + 0.05);
        g = fmode === 1 ? Math.max(0, 1 - e) : fmode === 2 ? (e < 1 ? 0 : 1) : fmode === 3 ? (e < 1 ? 1 : 0) : Math.min(1, e);
      }
      return 0.85 * y * g;
    });
  };
}

/* ------------------------------------------------------------------ arp, FX, FM */

export function drawRhythm(ui) {
  const s = ui.store, rh = ui.meta.rhythms;
  return (ctx, w, h) => {
    const r = rh[Math.round(s.get("arp_rhy"))] || [0xffff, 16];
    const cw = w / 16;
    for (let i = 0; i < 16; i++) {
      const x = i * cw + 2, on = i < r[1] && (r[0] >> i) & 1;
      ctx.fillStyle = i >= r[1] ? css("--grid") : on ? css("--accent") : css("--well");
      ctx.fillRect(x, i >= r[1] ? h - 4 : 3, cw - 4, i >= r[1] ? 2 : h - 6);
      if (i % 4 === 0) { ctx.fillStyle = css("--dim"); ctx.fillRect(x, h - 1, cw - 4, 1); }
    }
  };
}

export function drawRoute(ui) {
  const s = ui.store;
  return (ctx, fullW, h) => {
    const w = Math.min(fullW, 520); // a compact diagram, centred
    ctx.translate(Math.round((fullW - w) / 2), 0);
    const route = ui.meta.params.find((p) => p.k === "fx_route").o[Math.round(s.get("fx_route"))];
    const lvl = { CHO: s.get("cho_lvl"), DLY: s.get("dly_lvl"), REV: s.get("rev_lvl"), DST: s.get("dst_lvl") };
    const box = (x, y, label) => {
      const on = lvl[label] > 0.0005;
      ctx.fillStyle = on ? css("--accent") : css("--well");
      ctx.strokeStyle = on ? css("--accent") : css("--grid");
      ctx.beginPath(); ctx.roundRect(x - 18, y - 9, 36, 18, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = on ? css("--on-accent") : css("--dim");
      ctx.font = "600 10px " + MONO; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, x, y + 0.5);
    };
    const arrow = (x0, y0, x1, y1) => {
      ctx.strokeStyle = css("--dim"); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    };
    const cy = h / 2;
    if (route === "Parallel") {
      const xs = [24, w * 0.5, w - 22];
      box(xs[0], cy, "DST");
      ["CHO", "DLY", "REV"].forEach((l, i) => {
        const y = cy + (i - 1) * Math.min(22, h / 3.2);
        arrow(xs[0] + 18, cy, xs[1] - 18, y); arrow(xs[1] + 18, y, xs[2] - 14, cy);
        box(xs[1], y, l);
      });
      ctx.fillStyle = css("--dim"); ctx.fillText("OUT", xs[2], cy);
      return;
    }
    const order = ["DST", ...route.split(">").map((x) => x.toUpperCase())];
    const step = (w - 40) / (order.length - 1);
    order.forEach((l, i) => {
      const x = 20 + i * step;
      if (i) arrow(x - step + 18, cy, x - 18, cy);
      box(x, cy, l);
    });
  };
}

export function drawFm(ui) {
  const s = ui.store;
  return (ctx, w, h) => {
    const pos = { O1: [w * 0.18, h * 0.32], O2: [w * 0.5, h * 0.32], O3: [w * 0.82, h * 0.32], NS: [w * 0.18, h * 0.82] };
    const links = [["O1", "O2", "fm_12"], ["O2", "O3", "fm_23"], ["O3", "O1", "fm_31"], ["NS", "O1", "fm_n1"]];
    for (const [a, b, k] of links) {
      const v = s.get(k);
      if (v <= 0.001) continue;
      const [x0, y0] = pos[a], [x1, y1] = pos[b];
      ctx.strokeStyle = css("--accent");
      ctx.globalAlpha = 0.35 + 0.65 * v;
      ctx.lineWidth = 1 + v * 4;
      ctx.beginPath();
      if (k === "fm_31") { ctx.moveTo(x0, y0 + 10); ctx.quadraticCurveTo((x0 + x1) / 2, h * 0.75, x1, y1 + 10); }
      else { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const id in pos) {
      const [x, y] = pos[id];
      ctx.fillStyle = css("--well"); ctx.strokeStyle = css("--grid");
      ctx.beginPath(); ctx.arc(x, y, 11, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = css("--text"); ctx.font = "600 9px " + MONO; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(id, x, y + 0.5);
    }
  };
}

/** Live output scope (browser engine only). */
export function scope(analyser) {
  const c = document.createElement("canvas");
  c.className = "scope";
  c.setAttribute("aria-hidden", "true");
  const buf = new Float32Array(analyser.fftSize);
  const tick = () => {
    requestAnimationFrame(tick);
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h || document.hidden) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    analyser.getFloatTimeDomainData(buf);
    let start = 0; // trigger on a rising zero crossing so the picture stands still
    for (let i = 1; i < buf.length / 2; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break; }
    const n = Math.min(buf.length - start, 900);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * w, y = h / 2 - buf[start + i] * (h / 2 - 2);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = css("--screen-fg");
    ctx.lineWidth = 1.2;
    ctx.stroke();
  };
  requestAnimationFrame(tick);
  return c;
}
