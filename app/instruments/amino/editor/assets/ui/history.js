/* Undo/redo and A/B compare.  Loaded after first paint (app.js).
 *
 * Every edit made in this browser reaches History through Store.recorder; a
 * run of edits to one key (a knob drag) becomes one step.  Actions that change
 * many values on the device side (loading a preset or a layer, Init,
 * Randomise, A/B switch, layer copy) call `bulk()` first, which stores a full
 * snapshot; undoing one takes a fresh snapshot for redo and writes back only
 * the values that differ.  Edits made on Move itself are not recorded.
 */

const MERGE_MS = 1200;
const LIMIT = 100;

/** Every sound value, globals first so layer_count lands before lN_on. */
export function snapshot(store) {
  const out = {};
  const params = store.meta.params;
  for (const key in params) if (params[key].scope === "global" && key !== "edit_layer") out[key] = store.get(key);
  for (let n = 1; n <= 4; n++) {
    for (const key of store.meta.layerKeys) out["l" + n + "_" + key] = store.get("l" + n + "_" + key);
  }
  out.preset_name = store.get("preset_name");
  return out;
}

export class History {
  constructor(store) {
    this.store = store;
    this.undos = [];
    this.redos = [];
    this.listeners = new Set();
    this.compare = { slots: { A: null, B: null }, active: "A" };
    store.recorder = (key, before, after) => this.record(key, before, after);
  }

  record(key, before, after) {
    const top = this.undos[this.undos.length - 1];
    const now = Date.now();
    if (top && top.key === key && now - top.t < MERGE_MS) {
      top.after = after;
      top.t = now;
    } else {
      this.push({ key, before, after, t: now });
    }
    this.redos = [];
    this.emit();
  }

  /** Call before an action that rewrites many values. */
  bulk(label) {
    this.push({ label, before: snapshot(this.store), after: null, t: Date.now() });
    this.redos = [];
    this.emit();
  }

  push(entry) {
    this.undos.push(entry);
    if (this.undos.length > LIMIT) this.undos.shift();
  }

  undo() { this.step(this.undos, this.redos, "before"); }
  redo() { this.step(this.redos, this.undos, "after"); }

  step(from, to, side) {
    const e = from.pop();
    if (!e) return;
    if (e.key) {
      this.store.apply({ [e.key]: e[side] });
    } else {
      // Remember where we are so the step can be reversed.
      const here = snapshot(this.store);
      if (side === "before") e.after = here; else e.before = here;
      this.store.apply(e[side]);
    }
    e.t = 0; // never merge into a step that was undone
    to.push(e);
    this.emit();
  }

  get canUndo() { return this.undos.length > 0; }
  get canRedo() { return this.redos.length > 0; }
  describe(list) {
    const e = list[list.length - 1];
    if (!e) return "";
    if (e.label) return e.label;
    const meta = this.store.metaFor(e.key);
    const m = /^l([1-4])_/.exec(e.key);
    return (meta ? meta.name : e.key) + (m ? " (L" + m[1] + ")" : "");
  }

  /**
   * Switch the sound to slot `target` ("A" or "B").  The current sound is
   * kept in the active slot first; an empty target starts as a copy of it.
   */
  switchTo(target) {
    const c = this.compare;
    if (target === c.active) return;
    const here = snapshot(this.store);
    c.slots[c.active] = here;
    if (!c.slots[target]) c.slots[target] = here;
    this.bulk("Switch to " + target);
    this.store.apply(c.slots[target]);
    c.active = target;
    this.emit();
  }

  /** Make both slots the current sound (after loading a new preset, say). */
  resetCompare() {
    this.compare = { slots: { A: null, B: null }, active: "A" };
    this.emit();
  }

  onChange(fn) {
    this.listeners.add(fn);
    fn(this);
    return () => this.listeners.delete(fn);
  }

  emit() { for (const fn of this.listeners) fn(this); }
}
