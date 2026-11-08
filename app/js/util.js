// Small helpers shared by the whole app.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

let idCounter = 0;
export function uid(prefix = "") {
  idCounter = (idCounter + 1) % 1679616;
  return prefix + Date.now().toString(36) + idCounter.toString(36).padStart(4, "0") + Math.random().toString(36).slice(2, 6);
}

/** h("div", {class: "x", onclick: fn, style: {...}}, children...): a DOM element */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") {
        for (const s in v) if (s.startsWith("--")) el.style.setProperty(s, v[s]); else el.style[s] = v[s];
      }
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev).add(fn);
    return () => this.handlers.get(ev).delete(fn);
  }
  emit(ev, ...args) {
    const set = this.handlers.get(ev);
    if (set) for (const fn of [...set]) { try { fn(...args); } catch (e) { console.error(e); } }
  }
}

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (n) => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 2);
export const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12);

// Volume faders: position 0..1, gain = 2 p^2 (p = 0.7071 is 0 dB, 1 is +6 dB)
export const faderGain = (p) => 2 * p * p;
export const faderDb = (p) => (p <= 0 ? -Infinity : 20 * Math.log10(faderGain(p)));
export const UNITY = Math.SQRT1_2;
export const fmtDb = (p) => { const d = faderDb(p); return d === -Infinity ? "-∞" : (d > 0 ? "+" : "") + d.toFixed(1); };

export const TRACK_COLORS = ["#ff6b5b", "#ffa23a", "#f7d046", "#9be35a", "#3fd6a0", "#3cc7e6", "#5a8cff", "#9c6bff", "#e46be0", "#ff7aa8", "#b9b0a0", "#7fd1c7"];

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const deepCopy = (o) => (typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/** Points [{t, v}] sorted by t: the linear value at t (holds the ends) */
export function envAt(points, t) {
  if (!points || !points.length) return null;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].t <= t) lo = m; else hi = m; }
  const a = points[lo], b = points[hi];
  if (b.t === a.t) return b.v;
  return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
}

export function fmtTime(beats, bpm) {
  const s = Math.max(0, beats * 60 / bpm);
  const m = Math.floor(s / 60);
  return m + ":" + (s - m * 60).toFixed(1).padStart(4, "0");
}
export function fmtBars(beats, beatsPerBar = 4) {
  const b = Math.max(0, beats);
  const bar = Math.floor(b / beatsPerBar) + 1;
  const beat = Math.floor(b % beatsPerBar) + 1;
  const six = Math.floor((b % 1) * 4) + 1;
  return `${bar}.${beat}.${six}`;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Save a file: the share sheet where there is one for files (iPad: Save to Files, AirDrop), else a download */
export async function saveFile(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && "ontouchend" in document) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  downloadBlob(blob, name);
}

export function pickFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple, style: { display: "none" } });
    input.addEventListener("change", () => { resolve([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export const isTouch = () => matchMedia("(pointer: coarse)").matches;
