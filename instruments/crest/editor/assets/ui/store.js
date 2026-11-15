/* Parameter store: one cache of every value, bindings that repaint on change, throttled writes,
 * and undo. A "link" carries values to and from the synth: the Move through schwungRemote, or the
 * browser engine (see link.js). Values are kept as numbers; enums as option indices. */
import { wire, setValueSource } from "./format.js";

export const WRITE_MS = 33;      // at most ~30 writes per second per key
export const ECHO_HOLD_MS = 300; // ignore the device's echoes this long after our own write
const HISTORY_MAX = 200;

export class Store {
  constructor(meta) {
    this.meta = meta;
    this.params = meta.params;
    this.byKey = Object.create(null);
    this.values = Object.create(null);
    for (const p of this.params) {
      this.byKey[p.k] = p;
      this.values[p.k] = p.d;
    }
    this.extra = Object.create(null); // non-parameter keys the device reports (preset, preset_name ...)
    this.bindings = new Map();
    this.anyListeners = new Set();
    this.pending = new Set();
    this.frameQueued = false;
    this.timers = Object.create(null);
    this.lastSent = Object.create(null);
    this.holdUntil = Object.create(null);
    this.patchHoldUntil = 0;
    this.link = null;
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null; // values before the current drag, so one drag is one undo step
    this.touched = null; // the key edited last (the screen shows it)
    setValueSource((k) => this.values[k]);
  }

  p(key) { return this.byKey[key]; }
  get(key) { return this.values[key]; }

  connect(link) {
    this.link = link;
    link.onValues((vals, full) => this.ingest(vals, full));
  }

  /** Values from the synth: { key: string|number }. full = a whole-patch snapshot. */
  ingest(vals, full = false, own = false) {
    const now = performance.now();
    // Right after a patch load the host may still report the previous patch (a cached "state", "preset"
    // or parameter echo); the load is already painted, so those reports are dropped.
    if (!own && now < this.patchHoldUntil) return;
    for (const key in vals) {
      const p = this.byKey[key];
      if (!p) {
        if (this.extra[key] !== vals[key]) {
          this.extra[key] = vals[key];
          this.pending.add(key);
        }
        continue;
      }
      if (!full && (this.timers[key] !== undefined || now < (this.holdUntil[key] ?? -Infinity))) continue;
      const v = parseFloat(vals[key]);
      if (!Number.isFinite(v) || v === this.values[key]) continue;
      this.values[key] = v;
      this.pending.add(key);
    }
    this.queueFrame();
  }

  queueFrame() {
    if (this.frameQueued || !this.pending.size) return;
    this.frameQueued = true;
    // paint on the next frame; a hidden page (or a folded Remote UI section) gets no frames, so a
    // timer stands in for it
    const id = requestAnimationFrame(() => { clearTimeout(t); this.flush(); });
    const t = setTimeout(() => { cancelAnimationFrame(id); this.flush(); }, 120);
  }

  flush() {
    if (!this.frameQueued) return;
    this.frameQueued = false;
    const keys = [...this.pending];
    this.pending.clear();
    for (const k of keys) this.notify(k);
    for (const fn of this.anyListeners) fn(keys);
  }

  notify(key, source = null) {
    const set = this.bindings.get(key);
    if (set) for (const b of set) if (b !== source) b(this.values[key] ?? this.extra[key], key);
  }

  /** A user edit. Within a gesture (beginGesture/endGesture) the undo step is recorded once. */
  set(key, v, source = null) {
    const p = this.byKey[key];
    if (!p) return;
    if (p.t !== "float") v = Math.round(v);
    v = Math.min(p.t === "enum" ? p.o.length - 1 : p.mx, Math.max(p.t === "enum" ? 0 : p.mn, v));
    const before = this.values[key];
    if (before === v) return;
    if (!p.vol) {
      if (this.gesture) { if (!(key in this.gesture)) this.gesture[key] = before; }
      else this.record({ [key]: before }, { [key]: v });
    }
    this.values[key] = v;
    this.touched = key;
    if (source !== null) this.notify(key, source);
    else this.notify(key);
    for (const fn of this.anyListeners) fn([key]);
    this.throttledSend(key);
  }

  beginGesture() { this.gesture = {}; }
  endGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const after = {};
    let changed = false;
    for (const k in g) { after[k] = this.values[k]; if (after[k] !== g[k]) changed = true; }
    if (changed) this.record(g, after);
  }

  record(before, after) {
    this.undoStack.push({ before, after });
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack.length = 0;
    for (const fn of this.anyListeners) fn([]);
  }

  undo() { const s = this.undoStack.pop(); if (s) { this.redoStack.push(s); this.apply(s.before); } }
  redo() { const s = this.redoStack.pop(); if (s) { this.undoStack.push(s); this.apply(s.after); } }

  /** Write many values at once, unthrottled and unrecorded (undo, preset, import). */
  apply(vals, { send = true } = {}) {
    const keys = [];
    const now = performance.now();
    for (const k in vals) {
      const p = this.byKey[k];
      if (!p) continue;
      const v = Number(vals[k]);
      if (this.values[k] === v) continue;
      this.values[k] = v;
      keys.push(k);
      if (send) {
        this.holdUntil[k] = now + ECHO_HOLD_MS;
        this.link?.send(k, wire(p, v));
      }
    }
    for (const k of keys) this.notify(k);
    for (const fn of this.anyListeners) fn(keys);
  }

  /** Ignore the synth's reports for ms (a patch load was just sent; see ingest). */
  holdPatch(ms) { this.patchHoldUntil = performance.now() + ms; }

  /** Send a non-parameter key (preset, state) straight to the synth. */
  command(key, value) { this.link?.send(key, String(value)); }

  throttledSend(key) {
    const p = this.byKey[key];
    const flush = () => {
      delete this.timers[key];
      const now = performance.now();
      this.lastSent[key] = now;
      this.holdUntil[key] = now + ECHO_HOLD_MS;
      this.link?.send(key, wire(p, this.values[key]));
    };
    if (this.timers[key] !== undefined) return;
    const wait = WRITE_MS - (performance.now() - (this.lastSent[key] ?? -Infinity));
    if (wait <= 0) flush();
    else this.timers[key] = setTimeout(flush, wait);
  }

  /** fn(value, key) now and on every change of key. Returns an unbind function. */
  bind(key, fn) {
    if (!this.bindings.has(key)) this.bindings.set(key, new Set());
    this.bindings.get(key).add(fn);
    fn(this.values[key] ?? this.extra[key], key);
    return () => this.bindings.get(key)?.delete(fn);
  }

  /** fn(keys) after every change of any value. */
  onAny(fn) { this.anyListeners.add(fn); return () => this.anyListeners.delete(fn); }

  /** The patch as saved state (only saved params), as the DSP's state blob. */
  stateBlob(name) {
    const o = { fmt: "crest", v: "1", name: name || this.extra.preset_name || "Crest" };
    for (const p of this.params) if (!p.vol) o[p.k] = wire(p, this.values[p.k]);
    return JSON.stringify(o);
  }
}
