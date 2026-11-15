/* Parameter store and binding engine for the Remote UI.
 *
 * One cache of every value the device has reported, keyed by bare parameter
 * key (`cutoff`, `l2_cutoff`, `fx1_mix`).  Controls bind to a *bare* key; a
 * layer-scoped key resolves to `l<edit_layer>_<key>`, and when the edit layer
 * changes the bindings are re-pointed and repainted instead of rebuilding any
 * DOM.  Incoming updates are coalesced into one paint per animation frame and
 * reach only the bindings of keys that changed.  Writes update the cache at
 * once (optimistic), then go to the device at most every WRITE_MS per key with
 * the final value always sent.
 */
import { wireValue } from "./format.js";

/** Restore option lists ui_meta.json stores once (`optionsRef`). In place. */
export function expandMeta(meta) {
  for (const key in meta.params) {
    const p = meta.params[key];
    if (p.optionsRef !== undefined && !p.options) p.options = meta.optionLists[p.optionsRef];
  }
  return meta;
}

export const WRITE_MS = 34; // <= 30 writes per second per key (docs/05 9.2)
export const ECHO_HOLD_MS = 300; // ignore device echoes this long after our last write
const LAYER_RE = /^l([1-4])_(.+)$/;

export class Store {
  /**
   * @param {object} meta   parsed ui_meta.json
   * @param {object} remote schwungRemote-like bridge (component, setParam, onParamChange)
   * @param {object} [env]  { now, schedule, frame } overrides for tests
   */
  constructor(meta, remote, env = {}) {
    this.meta = meta;
    this.remote = remote;
    this.prefix = ((remote && remote.component) || "synth") + ":";
    this.values = Object.create(null);
    this.layerKeys = new Set(meta.layerKeys || []);
    this.bindings = new Map();      // resolved key -> Set<binding>
    this.layerBindings = new Set(); // bindings whose key follows edit_layer
    this.globalListeners = new Set();
    this.pending = new Set();
    this.lastSent = Object.create(null);
    this.timers = Object.create(null);
    this.holdUntil = Object.create(null);
    this.now = env.now || (() => performance.now());
    this.schedule = env.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.frame = env.frame || ((fn) => requestAnimationFrame(fn));
    this.frameQueued = false;
    this.recorder = null;   // history.js: (key, before, after) for every user edit
    for (const key in meta.params) {
      const p = meta.params[key];
      if (p.default === undefined) continue;
      if (p.scope === "layer") for (let n = 1; n <= 4; n++) this.values["l" + n + "_" + key] = String(p.default);
      else this.values[key] = String(p.default);
    }
  }

  get layer() {
    const n = Math.round(Number(this.values.edit_layer) || 1);
    return Math.min(4, Math.max(1, n));
  }

  /** The concrete key a bare key addresses for the focused layer. */
  resolve(bare, layer = this.layer) {
    return this.layerKeys.has(bare) ? "l" + layer + "_" + bare : bare;
  }

  /** Metadata for a bare or concrete key. */
  metaFor(key) {
    const m = LAYER_RE.exec(key);
    const bare = m && this.layerKeys.has(m[2]) ? m[2] : key;
    return this.meta.params[bare] || null;
  }

  get(key) { return this.values[key]; }
  num(key, fallback = 0) {
    const v = parseFloat(this.values[key]);
    return Number.isFinite(v) ? v : fallback;
  }
  /** Value of a bare key on the focused layer. */
  value(bare) { return this.num(this.resolve(bare)); }

  /* ------------------------------------------------------------ device in */

  connect() {
    if (!this.remote) return;
    this.remote.onParamChange((params) => this.ingest(params));
  }

  /** Accept a { "synth:key": "value" } batch from the device. */
  ingest(params) {
    const layerBefore = this.layer;
    const aliasLayer = this.layerFrom(params, layerBefore);
    const now = this.now();
    for (const full in params) {
      if (!full.startsWith(this.prefix) && full.includes(":")) continue;
      const key = full.startsWith(this.prefix) ? full.slice(this.prefix.length) : full;
      const value = String(params[full]);
      // A bare layer key is the device's alias for the focused layer.
      const target = this.layerKeys.has(key) ? this.resolve(key, aliasLayer) : key;
      // Our own write is pending or settling: its echoes may be older values.
      if (this.timers[target] !== undefined || now < (this.holdUntil[target] ?? -Infinity)) continue;
      if (this.values[target] === value) continue;
      this.values[target] = value;
      this.pending.add(target);
    }
    if (this.layer !== layerBefore) this.retargetLayer();
    this.queueFrame();
  }

  layerFrom(params, fallback) {
    const v = params[this.prefix + "edit_layer"];
    const n = v !== undefined ? Math.round(Number(v)) : fallback;
    return Math.min(4, Math.max(1, n || 1));
  }

  queueFrame() {
    if (this.frameQueued || !this.pending.size) return;
    this.frameQueued = true;
    this.frame(() => this.flush());
  }

  /** Paint every binding whose key changed since the last frame. */
  flush() {
    this.frameQueued = false;
    const keys = [...this.pending];
    this.pending.clear();
    for (const key of keys) {
      const set = this.bindings.get(key);
      if (set) for (const b of set) b.update(this.values[key], key);
    }
    if (keys.length) for (const fn of this.globalListeners) fn(keys);
  }

  /* ------------------------------------------------------------ device out */

  /** Write a concrete key.  `source` is the binding that made the edit. */
  set(key, value, source = null) {
    const text = String(value);
    if (key === "edit_layer") {
      this.values[key] = text;
      this.send(key, text);
      this.retargetLayer();
      this.pending.add(key);
      this.queueFrame();
      return;
    }
    const before = this.values[key];
    this.values[key] = text;
    if (this.recorder && before !== text) this.recorder(key, before, text);
    this.repaint(key, source);
    this.throttledSend(key, value);
  }

  /** Repaint a key's bindings (except `source`) after a local change. */
  repaint(key, source = null) {
    const set = this.bindings.get(key);
    if (set) for (const b of set) if (b !== source) b.update(this.values[key], key);
    for (const fn of this.globalListeners) fn([key]);
  }

  /** Write many concrete keys at once, unthrottled and unrecorded (A/B, undo, copy). */
  apply(values) {
    for (const key in values) {
      const text = String(values[key]);
      if (this.values[key] === text) continue;
      this.values[key] = text;
      this.holdUntil[key] = this.now() + ECHO_HOLD_MS;
      this.send(key, wireValue(this.metaFor(key) || {}, text));
      this.repaint(key);
    }
  }

  /** Write a bare key on the focused layer. */
  setBare(bare, value, source = null) { this.set(this.resolve(bare), value, source); }

  /** Fire-and-forget actions (preset, init_layer...) bypass throttling. */
  send(key, value) {
    if (this.remote) this.remote.setParam(this.prefix + key, String(value));
  }

  throttledSend(key, value) {
    const meta = this.metaFor(key) || {};
    const flush = () => {
      delete this.timers[key];
      const now = this.now();
      this.lastSent[key] = now;
      this.holdUntil[key] = now + ECHO_HOLD_MS;
      this.send(key, wireValue(meta, this.values[key] !== undefined ? this.values[key] : value));
    };
    if (this.timers[key] !== undefined) return; // the trailing write sends the latest value
    const wait = WRITE_MS - (this.now() - (this.lastSent[key] ?? -Infinity));
    if (wait <= 0) flush();
    else this.timers[key] = this.schedule(flush, wait);
  }

  /* ------------------------------------------------------------ bindings */

  /**
   * Bind `update(value, key)` to a bare key.  Layer-scoped keys follow the
   * edit layer; pass `{ layer: n }` to pin one.  Returns the binding, whose
   * `.key` is the current concrete key and `.set(v)` writes it.
   */
  bind(bare, update, opts = {}) {
    const follows = this.layerKeys.has(bare) && !opts.layer;
    const b = {
      bare,
      key: opts.layer ? this.resolve(bare, opts.layer) : this.resolve(bare),
      update,
      set: (v) => this.set(b.key, v, b),
      unbind: () => {
        this.bindings.get(b.key)?.delete(b);
        this.layerBindings.delete(b);
      },
    };
    this.attach(b);
    if (follows) this.layerBindings.add(b);
    update(this.values[b.key], b.key);
    return b;
  }

  attach(b) {
    if (!this.bindings.has(b.key)) this.bindings.set(b.key, new Set());
    this.bindings.get(b.key).add(b);
  }

  retargetLayer() {
    for (const b of this.layerBindings) {
      this.bindings.get(b.key)?.delete(b);
      b.key = this.resolve(b.bare);
      this.attach(b);
      b.update(this.values[b.key], b.key);
    }
  }

  /** Called with the list of changed keys after every paint or local edit. */
  onChange(fn) {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }
}
